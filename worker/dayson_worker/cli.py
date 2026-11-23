"""Worker entrypoints.

    dayson-worker nightly [--only job1,job2] [--date YYYY-MM-DD]
    dayson-worker serve   [--poll 5] [--once]
"""
from __future__ import annotations

import argparse
import importlib
import logging
import sys
import time
import traceback
from datetime import date

log = logging.getLogger("dayson_worker")

# §8.1 order first, then the extra nightly jobs. requires = jobs whose failure makes this one pointless.
NIGHTLY = [
    ("build_demand_history", []),
    ("measure_lead_times", []),
    ("classify", []),                         # monthly; skips itself inside the month
    ("forecast", []),                         # a failed history build still leaves yesterday's history
    ("compute_policy", ["forecast"]),
    ("suggest", ["compute_policy"]),
    ("expiry_bands", []),
    ("dealer_estimate", []),
    ("campaign_review", []),
    ("uplift_model", []),
    ("ddmrp_shadow", ["forecast", "compute_policy"]),
    ("vmi_proposals", []),
    ("load_planner", []),
    ("rebuild_check", []),
]
ON_DEMAND = ("plan_trucks", "simulate_campaign", "simulate_scenario", "run_job")


def load_job(name: str):
    return importlib.import_module(f"dayson_worker.jobs.{name}")


def run_nightly(conn, jobs=None, as_of: date | None = None, db=None, loader=load_job) -> dict:
    """Run the nightly jobs in order. A failing job is rolled back, logged, recorded and raises an
    alert; jobs that depend on it are skipped; everything else continues. Returns {job: outcome}."""
    if db is None:
        from . import db
    names = [j for j in NIGHTLY if jobs is None or j[0] in jobs]
    results, failed = {}, set()
    for name, requires in names:
        blocked = [r for r in requires if r in failed]
        if blocked:
            results[name] = {"status": "skipped", "reason": f"requires {', '.join(blocked)}"}
            failed.add(name)
            log.warning("job %s skipped: %s failed", name, blocked)
            _record(conn, db, name, "skipped", results[name], None)
            continue
        t0 = time.time()
        try:
            stats = loader(name).run(conn, as_of=as_of)
            conn.commit()
            results[name] = {"status": "ok", "seconds": round(time.time() - t0, 2), "stats": stats}
            log.info("job %s ok in %.1fs: %s", name, time.time() - t0, stats)
            _record(conn, db, name, "ok", results[name], None)
        except Exception as exc:                                  # noqa: BLE001 — every job failure is isolated
            conn.rollback()
            failed.add(name)
            err = f"{type(exc).__name__}: {exc}"
            results[name] = {"status": "failed", "seconds": round(time.time() - t0, 2), "error": err}
            log.error("job %s failed: %s\n%s", name, err, traceback.format_exc())
            _record(conn, db, name, "failed", results[name], err)
    return results


def _record(conn, db, name: str, status: str, result: dict, error: str | None) -> None:
    """Record the outcome (job_run) and raise an alert on failure, in their own transaction."""
    try:
        run_id = db.start_job_run(conn, name)
        db.finish_job_run(conn, run_id, status, result, error)
        if status == "failed":
            db.raise_alert(conn, "worker_job_failed", "critical", f"job:{name}", {"job": name, "error": error})
        conn.commit()
    except Exception:                                             # noqa: BLE001
        conn.rollback()
        log.error("could not record outcome of %s:\n%s", name, traceback.format_exc())


def handle(conn, kind: str, payload: dict) -> dict:
    if kind == "plan_trucks":
        return load_job("load_planner").plan_request(conn, payload)
    if kind == "simulate_campaign":
        return load_job("simulate").simulate_campaign(conn, payload)
    if kind == "simulate_scenario":
        return load_job("simulate").simulate_scenario(conn, payload)
    if kind == "run_job":
        name = payload["job"]
        if name not in {j[0] for j in NIGHTLY}:
            raise ValueError(f"unknown job {name!r}")
        kw = {"force": True} if name == "classify" and payload.get("force") else {}
        return load_job(name).run(conn, **kw)
    raise ValueError(f"unknown job kind {kind!r}")


def serve(conn, poll_seconds: float = 5.0, once: bool = False, db=None) -> int:
    """Poll job_queue for on-demand work."""
    if db is None:
        from . import db
    done = 0
    while True:
        job = db.claim_job(conn, list(ON_DEMAND))
        if job is None:
            if once:
                return done
            time.sleep(poll_seconds)
            continue
        try:
            result = handle(conn, job["kind"], job["payload"] or {})
            conn.commit()
            db.finish_job(conn, job["id"], result=result)
        except Exception as exc:                                  # noqa: BLE001
            conn.rollback()
            log.error("on-demand job %s (%s) failed:\n%s", job["id"], job["kind"], traceback.format_exc())
            db.finish_job(conn, job["id"], error=f"{type(exc).__name__}: {exc}")
        done += 1
        if once:
            return done


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="dayson-worker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("nightly", help="run the nightly planning jobs")
    n.add_argument("--only", help="comma-separated job names")
    n.add_argument("--date", help="as-of date (YYYY-MM-DD), default today in Europe/Istanbul")
    s = sub.add_parser("serve", help="poll job_queue for on-demand jobs")
    s.add_argument("--poll", type=float, default=5.0)
    s.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    from . import db
    conn = db.connect()
    try:
        if args.cmd == "nightly":
            res = run_nightly(conn, jobs=args.only.split(",") if args.only else None,
                              as_of=date.fromisoformat(args.date) if args.date else None)
            return 1 if any(r["status"] == "failed" for r in res.values()) else 0
        serve(conn, args.poll, args.once)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
