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
    ("expiry_bands", []),                     # select rpc_update_expiry_bands()
    ("slow_stock", []),                       # monthly list; uses the bands
    ("campaign_tick", []),                    # select rpc_campaign_tick()
    ("dealer_estimate", []),
    ("campaign_review", []),
    ("uplift_model", []),
    ("ddmrp_shadow", ["forecast", "compute_policy"]),
    ("vmi_proposals", []),
    ("load_planner", []),
    ("count_tasks", []),                      # select rpc_generate_count_tasks()
    ("reconciliation", []),                   # select rpc_run_reconciliation(), only with a Logo snapshot
    ("rebuild_check", []),                    # select rpc_rebuild_check()
    ("nightly_checks", []),                   # select rpc_nightly_checks()
]
ON_DEMAND = ("plan_trucks", "simulate_campaign", "simulate_scenario", "run_job")


def load_job(name: str):
    return importlib.import_module(f"dayson_worker.jobs.{name}")


def startup(conn, db=None) -> None:
    """Keep mechanic_type in step with the module registry (§9.2) before any job runs."""
    if db is None:
        from . import db
    n = db.upsert_mechanic_types(conn)
    conn.commit()
    if n:
        log.info("mechanic_type: %d rows synchronised with the module registry", n)


def run_nightly(conn, jobs=None, as_of: date | None = None, db=None, loader=load_job, job_kwargs=None) -> dict:
    """Run the nightly jobs in order. A failing job is rolled back, logged, recorded in job_run and
    reported through rpc_job_failed (real-time alert); jobs that depend on it are skipped;
    everything else continues. Returns {job: outcome}."""
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
            _record(conn, db, name, None, "failed", results[name], f"skipped: requires {', '.join(blocked)}", alert=False)
            continue
        run_id = _start(conn, db, name)
        t0 = time.time()
        try:
            stats = loader(name).run(conn, as_of=as_of, **((job_kwargs or {}).get(name) or {}))
            conn.commit()
            results[name] = {"status": "ok", "seconds": round(time.time() - t0, 2), "stats": stats}
            log.info("job %s ok in %.1fs: %s", name, time.time() - t0, stats)
            _record(conn, db, name, run_id, "ok", results[name], None)
        except Exception as exc:                                  # noqa: BLE001 — every job failure is isolated
            conn.rollback()
            failed.add(name)
            err = f"{type(exc).__name__}: {exc}"
            results[name] = {"status": "failed", "seconds": round(time.time() - t0, 2), "error": err}
            log.error("job %s failed: %s\n%s", name, err, traceback.format_exc())
            _record(conn, db, name, run_id, "failed", results[name], err)
    return results


def _start(conn, db, name: str):
    try:
        run_id = db.start_job_run(conn, name)
        conn.commit()
        return run_id
    except Exception:                                             # noqa: BLE001
        conn.rollback()
        log.error("could not open job_run for %s:\n%s", name, traceback.format_exc())
        return None


def _record(conn, db, name: str, run_id, status: str, result: dict, error: str | None, alert: bool = True) -> None:
    """Record the outcome (job_run) and report a failure, in their own transaction."""
    try:
        if run_id is None:
            run_id = db.start_job_run(conn, name)
        db.finish_job_run(conn, run_id, status, result, error)
        if status == "failed" and alert:
            db.job_failed(conn, name, error)
        conn.commit()
    except Exception:                                             # noqa: BLE001
        conn.rollback()
        log.error("could not record outcome of %s:\n%s", name, traceback.format_exc())


def handle(conn, kind: str, payload: dict, db=None) -> dict:
    if kind == "plan_trucks":
        return load_job("load_planner").plan_request(conn, payload)
    if kind == "simulate_campaign":
        return load_job("simulate").simulate_campaign(conn, payload)
    if kind == "simulate_scenario":
        return load_job("simulate").simulate_scenario(conn, payload)
    if kind == "run_job":
        # {"job": name} or {"jobs": [names]} (e.g. after a campaign approval); optional "force", "date"
        names = payload.get("jobs") or ([payload["job"]] if payload.get("job") else [])
        known = {j[0] for j in NIGHTLY}
        bad = [n for n in names if n not in known]
        if bad or not names:
            raise ValueError(f"unknown job {bad or names!r}")
        kw = {n: {"force": True} for n in names if n in ("classify", "slow_stock") and payload.get("force")}
        res = run_nightly(conn, jobs=names, db=db, job_kwargs=kw,
                          as_of=date.fromisoformat(payload["date"]) if payload.get("date") else None)
        bad = {n: r.get("error") or r.get("reason") for n, r in res.items() if r["status"] != "ok"}
        if bad:
            raise RuntimeError(f"jobs failed: {bad}")
        return res
    raise ValueError(f"unknown job kind {kind!r}")


def serve(conn, poll_seconds: float = 5.0, once: bool = False, db=None) -> int:
    """Poll job_queue for on-demand work. With once=True the queue is drained, then the call returns."""
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
        t0 = time.time()
        try:
            result = handle(conn, job["kind"], job["payload"] or {})
            conn.commit()
            db.finish_job(conn, job["id"], result=result)
            log.info("on-demand job %s (%s) done in %.1fs", job["id"], job["kind"], time.time() - t0)
        except Exception as exc:                                  # noqa: BLE001
            conn.rollback()
            err = f"{type(exc).__name__}: {exc}"
            log.error("on-demand job %s (%s) failed:\n%s", job["id"], job["kind"], traceback.format_exc())
            db.finish_job(conn, job["id"], error=err)
            try:
                db.job_failed(conn, f"{job['kind']}:{job['id']}", err)
                conn.commit()
            except Exception:                                     # noqa: BLE001
                conn.rollback()
        done += 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="dayson-worker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("nightly", help="run the nightly planning jobs")
    n.add_argument("--only", help="comma-separated job names")
    n.add_argument("--date", help="as-of date (YYYY-MM-DD), default today in Europe/Istanbul")
    s = sub.add_parser("serve", help="poll job_queue for on-demand jobs")
    s.add_argument("--poll", type=float, default=5.0)
    s.add_argument("--once", action="store_true", help="process the queue, then exit")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    from . import db
    conn = db.connect()
    try:
        startup(conn)
        if args.cmd == "nightly":
            t0 = time.time()
            res = run_nightly(conn, jobs=args.only.split(",") if args.only else None,
                              as_of=date.fromisoformat(args.date) if args.date else None)
            for name, r in res.items():
                print(f"{name:22s} {r['status']:8s} {r.get('seconds', 0):7.2f}s  "
                      f"{r.get('error') or r.get('reason') or ''}")
            print(f"nightly finished in {time.time() - t0:.1f}s")
            return 1 if any(r["status"] != "ok" for r in res.values()) else 0
        n = serve(conn, args.poll, args.once)
        if args.once:
            print(f"serve --once: {n} job(s) processed")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
