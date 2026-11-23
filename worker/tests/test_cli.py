import importlib
import types

import pytest

from dayson_worker import cli

SPEC_ORDER = ["build_demand_history", "measure_lead_times", "classify", "forecast", "compute_policy", "suggest"]
ALL_JOBS = SPEC_ORDER + ["expiry_bands", "dealer_estimate", "campaign_review", "uplift_model", "ddmrp_shadow",
                         "vmi_proposals", "load_planner", "simulate", "rebuild_check"]


class FakeConn:
    def __init__(self):
        self.commits = self.rollbacks = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class FakeDb:
    def __init__(self):
        self.runs, self.alerts = [], []

    def start_job_run(self, conn, job):
        self.runs.append([job, None])
        return len(self.runs) - 1

    def finish_job_run(self, conn, run_id, status, stats=None, error=None):
        self.runs[run_id][1] = status

    def raise_alert(self, conn, rule, severity, entity, payload):
        self.alerts.append((rule, severity, entity, payload))


def test_every_job_module_exists_with_a_run_function():
    for name in ALL_JOBS:
        m = importlib.import_module(f"dayson_worker.jobs.{name}")
        assert callable(m.run)
    sim = importlib.import_module("dayson_worker.jobs.simulate")
    assert callable(sim.simulate_campaign) and callable(sim.simulate_scenario)
    assert callable(importlib.import_module("dayson_worker.jobs.load_planner").plan_request)


def test_nightly_order_follows_section_8_1():
    names = [n for n, _ in cli.NIGHTLY]
    assert names[:6] == SPEC_ORDER
    assert set(names) == set(ALL_JOBS) - {"simulate"}            # simulate is on demand only
    assert cli.ON_DEMAND == ("plan_trucks", "simulate_campaign", "simulate_scenario", "run_job")


def test_failed_job_is_caught_recorded_alerted_and_later_jobs_continue():
    called = []

    def loader(name):
        def run(conn, as_of=None):
            called.append(name)
            if name == "forecast":
                raise RuntimeError("boom")
            return {"n": 1}
        return types.SimpleNamespace(run=run)

    conn, db = FakeConn(), FakeDb()
    res = cli.run_nightly(conn, db=db, loader=loader)
    assert res["forecast"]["status"] == "failed" and "boom" in res["forecast"]["error"]
    assert res["compute_policy"]["status"] == "skipped" and res["suggest"]["status"] == "skipped"
    assert res["ddmrp_shadow"]["status"] == "skipped"
    for ok in ("build_demand_history", "measure_lead_times", "classify", "expiry_bands", "dealer_estimate",
               "campaign_review", "uplift_model", "vmi_proposals", "load_planner", "rebuild_check"):
        assert res[ok]["status"] == "ok"
    assert "compute_policy" not in called and called.index("expiry_bands") > called.index("forecast")
    assert conn.rollbacks == 1
    assert [a[0] for a in db.alerts] == ["worker_job_failed"] and db.alerts[0][2] == "job:forecast"
    assert dict(map(tuple, db.runs))["forecast"] == "failed" and len(db.runs) == len(cli.NIGHTLY)


def test_only_filter_and_unknown_on_demand_kind():
    called = []
    loader = lambda name: types.SimpleNamespace(run=lambda conn, as_of=None: called.append(name) or {})
    cli.run_nightly(FakeConn(), jobs=["classify", "rebuild_check"], db=FakeDb(), loader=loader)
    assert called == ["classify", "rebuild_check"]
    with pytest.raises(ValueError):
        cli.handle(FakeConn(), "drop_everything", {})
    with pytest.raises(ValueError):
        cli.handle(FakeConn(), "run_job", {"job": "os.system"})
