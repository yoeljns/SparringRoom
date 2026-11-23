"""End-to-end tests against a real Postgres with the migrations and the seed (marker ``db``).

Skipped unless DATABASE_URL is set. The tests run in file order on ONE database that must be
freshly reset and seeded before the session:

    (cd .. && DB_NAME=dayson_worker bash scripts/dev-db.sh reset)
    DATABASE_URL=postgresql://postgres@127.0.0.1:54329/dayson_worker uv run pytest -m db

With WORKER_TEST_RESET=1 the session resets that local database itself (dev-db.sh, local cluster only).
"""
import os
import subprocess
import time
import types
from pathlib import Path
from urllib.parse import urlparse

import pytest

import mechanics
from dayson_worker import cli, db
from dayson_worker.jobs import (build_demand_history, campaign_review, dealer_estimate, measure_lead_times,
                                vmi_proposals)

URL = os.environ.get("DATABASE_URL")
pytestmark = [pytest.mark.db, pytest.mark.skipif(not URL, reason="DATABASE_URL is not set")]
ROOT = Path(__file__).resolve().parents[2]
STATE: dict = {}


@pytest.fixture(scope="module")
def conn():
    if os.environ.get("WORKER_TEST_RESET") == "1":
        env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
        env["DB_NAME"] = urlparse(URL).path.lstrip("/")
        subprocess.run(["bash", str(ROOT / "scripts" / "dev-db.sh"), "reset"], check=True, env=env, cwd=ROOT)
    c = db.connect(URL)
    yield c
    c.rollback()
    c.close()


def count(conn, table, where="true", params=None):
    return db.scalar(conn, f"select count(*) from {table} where {where}", params)


def sku(conn, code):
    return db.scalar(conn, "select id from item where sku = %s", [code])


# ----------------------------------------------------------------- 1. nightly
def test_nightly_runs_every_job_ok_on_the_seed(conn, capsys):
    assert count(conn, "job_run") == 0, "these tests need a freshly reset and seeded database"
    cli.startup(conn)
    t0 = time.perf_counter()
    res = cli.run_nightly(conn)
    seconds = time.perf_counter() - t0
    STATE["nightly"] = res
    assert [n for n, r in res.items() if r["status"] != "ok"] == [], res
    assert list(res) == [n for n, _ in cli.NIGHTLY]
    runs = db.query(conn, "select job, status, stats, finished_at from job_run")
    assert len(runs) == len(cli.NIGHTLY) and all(r["status"] == "ok" and r["finished_at"] for r in runs)
    assert count(conn, "alert", "rule = 'nightly_job_failed'") == 0

    sellable = count(conn, "item", "sellable and active")
    tables = ["classification_run", "item_class", "lead_time_stat", "forecast_run", "forecast", "forecast_accuracy",
              "item_policy", "stock_projection", "replenishment_suggestion", "dealer_stock_estimate", "ddmrp_buffer",
              "slow_stock", "task", "job_run"]
    counts = {t: count(conn, t) for t in tables}
    with capsys.disabled():
        print(f"\n[nightly] wall time {seconds:.1f}s on the seed; rows: {counts}")

    # classification: one current run, every active item classified
    assert count(conn, "classification_run", "is_current") == 1
    assert count(conn, "v_item_class") == count(conn, "item", "active")
    assert count(conn, "v_item_class", "service_level is null or abc is null or xyz is null") == 0
    # lead times: one statistic per active lane, quoted on the seed (no receipts yet)
    assert count(conn, "lead_time_stat") == count(conn, "supplier_lane", "active")
    assert count(conn, "lead_time_stat", "source <> 'quoted' or sd_days <= 0") == 0
    # forecast: one current run; 26 weekly buckets per sellable SKU; 18 monthly per family; levels add up
    assert count(conn, "forecast_run", "is_current") == 1
    run_id = db.scalar(conn, "select id from forecast_run where is_current")
    per_sku = db.query(conn, """
        select i.sku, count(f.id) as n from item i
          left join forecast f on f.item_id = i.id and f.run_id = %s and f.level = 'sku' and f.bucket = 'week'
         where i.sellable and i.active group by i.sku""", [run_id])
    assert len(per_sku) == sellable and all(r["n"] == 26 for r in per_sku), per_sku
    monthly = db.query(conn, """select node, count(*) as n from forecast
                                 where run_id = %s and level = 'family' and bucket = 'month' group by node""", [run_id])
    assert monthly and all(r["n"] == 18 for r in monthly)
    assert db.scalar(conn, """
        select max(abs(t.final - s.final)) from
          (select period, final from forecast where run_id = %(r)s and level = 'total' and bucket = 'week') t
          join (select period, sum(final) as final from forecast where run_id = %(r)s and level = 'sku'
                 and bucket = 'week' group by period) s using (period)""", {"r": run_id}) < 0.05
    assert count(conn, "forecast", "run_id = %s and (final < 0 or abs(final - base - campaign_delta - override_delta) > 0.01)",
                 [run_id]) == 0
    assert count(conn, "forecast_accuracy", "run_id = %s and item_id is null and wape is not null and wape_naive is not null",
                 [run_id]) >= 3
    # an item without history gets a zero forecast, not an invented one
    assert db.scalar(conn, """select sum(f.final) from forecast f join item i on i.id = f.item_id
                               where f.run_id = %s and i.sku = 'SET-USTA-01'""", [run_id]) == 0
    # policy: one row per forecast item for the published plan
    plan = db.scalar(conn, "select app.current_plan_version()")
    assert count(conn, "item_policy", "plan_version_id = %s", [plan]) == db.scalar(
        conn, "select count(distinct item_id) from forecast where run_id = %s and level = 'sku'", [run_id])
    assert count(conn, "item_policy", """plan_version_id = %s and policy <> 'to_order'
                                         and (safety_stock is null or coalesce(rop, order_up_to) is null
                                              or order_qty is null or order_qty <= 0)""", [plan]) == 0
    assert count(conn, "stock_projection", "plan_version_id = %s", [plan]) == 26 * count(
        conn, "item_policy", "plan_version_id = %s", [plan])
    assert counts["replenishment_suggestion"] > 0 and counts["dealer_stock_estimate"] > 0
    # DDMRP shadow buffers for the sealant family only
    assert count(conn, "ddmrp_buffer") == count(conn, "item i join item_family f on f.id = i.family_id",
                                                "f.code = 'SEAL' and i.active")
    # slow stock: the seed's amber lots are listed as at risk
    assert count(conn, "slow_stock", "category = 'at_risk' and lot_id is not null") == count(
        conn, "(select distinct lot_id from v_central_stock where band = 'amber') x")
    assert res["rebuild_check"]["stats"]["differences"] == 0


def test_suggestions_carry_every_input_and_follow_the_policy(conn):
    plan = db.scalar(conn, "select app.current_plan_version()")
    rows = db.query(conn, """
        select s.*, i.sku, p.policy, p.rop, p.order_up_to, p.order_qty, sl.mode, sl.moq, sl.order_multiple
          from replenishment_suggestion s join item i on i.id = s.item_id
          join item_policy p on p.item_id = s.item_id and p.plan_version_id = s.plan_version_id
          join supplier_lane sl on sl.id = s.supplier_lane_id
         where s.plan_version_id = %s and s.state = 'proposed'""", [plan])
    assert rows
    need = {"forecast_run_id", "lead_time_stat_id", "service_level", "param_version", "on_hand", "on_order",
            "reservations", "projected_available", "safety_stock", "d", "sd_d", "L", "sd_L", "z", "policy", "trigger",
            "order_qty", "moq", "order_multiple", "lead_time_weeks", "target_level", "group", "classification_run_id"}
    frun = db.scalar(conn, "select id from forecast_run where is_current")
    for r in rows:
        assert need <= set(r["inputs"]), need - set(r["inputs"])
        assert r["inputs"]["forecast_run_id"] == frun and r["inputs"]["lead_time_stat_id"]
        assert r["qty"] > 0 and r["release_date"] <= r["need_date"] and r["group_key"]
        assert r["type"] == ("production" if r["mode"] == "production" else "purchase")
        assert (r["supplier_id"] is None) == (r["type"] == "production")
        if r["policy"] == "continuous":
            assert r["reason"] == "rop" and r["inputs"]["projected_available"] < r["rop"]
            assert r["qty"] % r["order_qty"] == pytest.approx(0, abs=1e-6)
        else:
            assert r["reason"] == "review" and r["qty"] >= (r["moq"] or 0)
            if r["order_multiple"]:
                assert r["qty"] % r["order_multiple"] == pytest.approx(0, abs=1e-6)
    # the planner can accept one: it becomes a draft production / purchase order
    s = next(r for r in rows if r["type"] == "purchase")
    out = db.scalar(conn, "select rpc_suggestion_decide(%s, 'accept')", [s["id"]])
    assert out["state"] == "accepted" and count(conn, "po_line", "suggestion_id = %s", [s["id"]]) == 1
    conn.rollback()


def test_mechanic_registry_is_in_the_database_with_the_same_schemas(conn):
    rows = {r["code"]: r for r in db.query(conn, "select * from mechanic_type")}
    assert set(rows) == set(mechanics.REGISTRY)
    valid = {
        "price_discount": {"discount_pct": 10},
        "volume_tier": {"tiers": [{"min_qty": 10, "discount_pct": 3}]},
        "buy_x_get_y": {"buy_item_rule": {"family": "SEAL"}, "buy_qty": 10, "free_item": "same", "free_qty": 1,
                        "max_per_order": None},
        "mixed_set": {"bundle_id": "B1", "price": 99.0},
        "gift_item": {"threshold_eur": 500, "threshold_qty": None, "gift_item": "PROMO-TSHIRT", "qty": 1},
        "target_rebate": {"period": {"from": "2026-01-01", "to": "2026-03-31"}, "targets": {"A": 50000}, "rebate_pct": 2},
        "launch_seed": {"item": "NEW-1", "seed_qty": {"A": 48}},
        "export_push": {"market": "DE", "items": ["A"], "terms": {"discount_pct": 5}},
    }
    invalid = {"price_discount": {"discount_pct": 0}, "volume_tier": {"tiers": []},
               "buy_x_get_y": {"buy_item_rule": {"family": "SEAL"}, "buy_qty": 0, "free_item": "same", "free_qty": 1},
               "mixed_set": {"bundle_id": "B1", "price": -1}, "gift_item": {"gift_item": "G", "qty": 0, "threshold_eur": 5},
               "target_rebate": {"period": {"from": "2026-01-01"}, "targets": {"A": 1}, "rebate_pct": 2},
               "launch_seed": {"item": "N"}, "export_push": {"market": "DE", "items": []}}
    for code, mod in mechanics.REGISTRY.items():
        assert rows[code]["param_schema"] == db.jsonable(mod.PARAM_SCHEMA) and rows[code]["module"] == mod.__name__
        assert mod.validate(valid[code]) == []
        assert db.scalar(conn, "select app.validate_json(%s, %s)", [db.as_json(mod.PARAM_SCHEMA), db.as_json(valid[code])]) == []
        assert mod.validate(invalid[code]) != []
        assert db.scalar(conn, "select app.validate_json(%s, %s)", [db.as_json(mod.PARAM_SCHEMA), db.as_json(invalid[code])]) != []


def test_second_nightly_supersedes_and_keeps_one_current_run(conn):
    before = {t: count(conn, t) for t in ("item_policy", "dealer_stock_estimate", "lead_time_stat", "ddmrp_buffer",
                                          "slow_stock", "task", "demand_history")}
    proposed = count(conn, "replenishment_suggestion", "state = 'proposed'")
    res = cli.run_nightly(conn)
    assert all(r["status"] == "ok" for r in res.values()), res
    assert "skipped" in res["classify"]["stats"] and "skipped" in res["slow_stock"]["stats"]
    assert count(conn, "classification_run") == 1 and count(conn, "forecast_run") == 2
    assert count(conn, "forecast_run", "is_current") == 1
    assert {t: count(conn, t) for t in before} == before            # upserts and same-day replacements, no duplicates
    assert count(conn, "replenishment_suggestion", "state = 'proposed'") == proposed
    assert count(conn, "replenishment_suggestion", "state = 'superseded'") == proposed


# ------------------------------------------------------------------ 2. serve
def test_plan_trucks_job_splits_a_scheduled_order_into_identical_trucks(conn):
    dealer = db.scalar(conn, "select id from party where type = 'dealer' and segment = 'A' order by name limit 1")
    start = db.scalar(conn, "select app.today() + 14")
    order = db.scalar(conn, "select rpc_save_order(%s)", [{
        "party_id": dealer, "requested_date": start,
        "schedule": {"trucks_per_month": 3, "months": 1, "start": start},
        "lines": [{"item_id": sku(conn, "DYS-PU-BEYAZ-KRT"), "qty": 126, "uom": "pallet"}]}])["order_id"]
    db.scalar(conn, "select rpc_confirm_order(%s)", [order])
    conn.commit()
    assert count(conn, "job_queue", "kind = 'plan_trucks' and state = 'queued' and payload->>'order_id' = %s", [order]) == 1
    assert cli.serve(conn, once=True) == 1
    job = db.one(conn, "select * from job_queue where kind = 'plan_trucks'")
    assert job["state"] == "done" and job["error"] is None and job["finished_at"]
    assert job["result"]["trucks"] == 3 and job["result"]["patterns"] == 1 and job["result"]["remainder"] == []
    ships = db.query(conn, """
        select s.id, s.planned_date, s.state, tl.planned_kg, lp.signature,
               (select sum(sl.qty_base) from shipment_line sl where sl.shipment_id = s.id) as qty,
               (select sum(tll.pallets) from truck_load_line tll where tll.truck_load_id = tl.id) as pallets
          from shipment s join truck_load tl on tl.shipment_id = s.id join load_pattern lp on lp.id = tl.pattern_id
         where exists (select 1 from shipment_line sl join so_line l on l.id = sl.so_line_id
                        where sl.shipment_id = s.id and l.order_id = %s) order by s.planned_date""", [order])
    assert len(ships) == 3
    assert {s["signature"] for s in ships} == {"DYS-PU-BEYAZ-KRT:42"} and all(s["pallets"] == 42 for s in ships)
    assert all(24900 <= s["planned_kg"] <= 25075 and s["state"] == "planned" for s in ships)
    assert sum(s["qty"] for s in ships) == 126 * 1200
    dates = [s["planned_date"] for s in ships]
    assert dates == sorted(set(dates)) and dates[0] >= start and (dates[-1] - dates[0]).days < 31
    # each truck carries its share of the order's soft reservation
    assert db.scalar(conn, """select count(distinct shipment_id) from reservation r join so_line l on l.id = r.demand_line_id
                               where l.order_id = %s and r.state = 'active' and r.type = 'soft'""", [order]) == 3


def test_simulate_campaign_job_writes_forecast_scenario_and_marks_simulated(conn):
    c = db.scalar(conn, "select rpc_campaign_save(%s)", [{
        "code": "TEST-BXGY", "name": "10 al 1 bedava", "order_from": db.scalar(conn, "select app.today() + 14"),
        "order_to": db.scalar(conn, "select app.today() + 41"),
        "scopes": [{"item_rule": {"family": "SEAL"}, "party_rule": {"type": "dealer"}}],
        "mechanics": [{"mechanic_type": "buy_x_get_y",
                       "params": {"buy_item_rule": {"family": "SEAL"}, "buy_qty": 10, "free_item": "same", "free_qty": 1}}]}])
    cid = STATE["campaign"] = c["campaign_id"]
    db.scalar(conn, "select rpc_campaign_simulate(%s)", [cid])
    conn.commit()
    assert cli.serve(conn, once=True) == 1
    job = db.one(conn, "select * from job_queue where kind = 'simulate_campaign'")
    assert job["state"] == "done", job["error"]
    assert db.scalar(conn, "select state from campaign where id = %s", [cid]) == "simulated"
    sim = db.one(conn, "select * from campaign_simulation where campaign_id = %s", [cid])
    plan = db.scalar(conn, "select app.current_plan_version()")
    assert sim["base_plan_version_id"] == plan and db.scalar(conn, "select app.campaign_simulation_current(%s)", [cid])
    scen = db.one(conn, "select * from plan_version where id = %s", [sim["plan_version_id"]])
    assert scen["kind"] == "scenario" and scen["base_version_id"] == plan and scen["context"]["campaign_id"] == cid
    fc = db.one(conn, """select count(*) as n, count(distinct item_id) as items, sum(uplift) as uplift,
                                sum(free_qty) as free, sum(baseline) as baseline, count(prior_id) as priors
                           from campaign_forecast where campaign_id = %s""", [cid])
    seal = count(conn, "item i join item_family f on f.id = i.family_id", "f.code = 'SEAL'")
    assert fc["items"] == seal and fc["uplift"] > 0 and fc["free"] > 0 and fc["baseline"] > 0 and fc["priors"] > 0
    res = sim["result"]
    assert res["summary"]["items_affected"] == seal and len(res["items"]) == seal
    assert res["campaign"]["totals"]["net"] == pytest.approx(fc["uplift"] + fc["free"], rel=1e-6)
    item = res["items"][0]
    assert {"weeks_below_safety", "prebuild_pallets", "prebuild_by", "amber_consumed", "added_trucks",
            "ring_fence_conflicts", "projected", "sku"} <= set(item) and len(item["projected"]) == 26
    assert count(conn, "stock_projection", "plan_version_id = %s", [scen["id"]]) == 26 * seal
    # buy 10 get 1: free units are a tenth of the eligible paid volume
    eligible_paid = res["campaign"]["totals"]["baseline_in_window"] * res["campaign"]["eligible_share"] + fc["uplift"]
    assert fc["free"] == pytest.approx(eligible_paid / 10, rel=1e-3)


def test_simulate_scenario_job_stores_the_result_of_a_lead_time_change(conn):
    lane = db.scalar(conn, "select id from supplier_lane where production_line = 'MASTIK-1'")
    job_id = db.scalar(conn, "select rpc_enqueue_job('simulate_scenario', %s)",
                       [{"lead_time_change": {"supplier_lane_id": lane, "days": 35}}])
    conn.commit()
    assert cli.serve(conn, once=True) == 1
    job = db.one(conn, "select * from job_queue where id = %s", [job_id])
    assert job["state"] == "done", job["error"]
    res = job["result"]
    assert res["lead_time"]["old_days"] == 21 and res["lead_time"]["new_days"] == 35
    scen = db.one(conn, "select * from plan_version where id = %s", [res["plan_version_id"]])
    assert scen["kind"] == "scenario" and scen["context"]["type"] == "lead_time_change"
    seal = count(conn, "item i join item_family f on f.id = i.family_id", "f.code = 'SEAL'")
    assert res["summary"]["items_affected"] == seal == len(res["policy_changes"])
    assert all(p["safety_stock"] >= p["safety_stock_before"] and p["rop"] > p["rop_before"] for p in res["policy_changes"])
    assert count(conn, "item_policy", "plan_version_id = %s", [scen["id"]]) == seal
    assert count(conn, "stock_projection", "plan_version_id = %s", [scen["id"]]) == 26 * seal
    # the published plan is untouched
    plan = db.scalar(conn, "select app.current_plan_version()")
    assert db.scalar(conn, "select max(lt_mean_days) from item_policy where plan_version_id = %s and policy = 'continuous'",
                     [plan]) == 21


def test_failed_on_demand_job_is_marked_failed_with_an_alert(conn):
    job_id = db.scalar(conn, "select rpc_enqueue_job('plan_trucks', %s)",
                       [{"order_id": "00000000-0000-0000-0000-000000000001"}])
    conn.commit()
    assert cli.serve(conn, once=True) == 1
    job = db.one(conn, "select * from job_queue where id = %s", [job_id])
    assert job["state"] == "failed" and "not found" in job["error"]
    assert count(conn, "alert", "rule = 'nightly_job_failed' and payload->>'job' like 'plan_trucks:%%'") == 1


def test_approved_campaign_enters_the_forecast_through_run_job(conn):
    cid = STATE["campaign"]
    db.execute(conn, "select app.campaign_approve(%s, null)", [cid])
    conn.commit()
    assert db.scalar(conn, "select state from campaign where id = %s", [cid]) == "approved"
    assert count(conn, "reservation", "campaign_id = %s and demand_line_id is null and state = 'active'", [cid]) > 0
    assert cli.serve(conn, once=True) == 1                       # run_job {jobs: [forecast, compute_policy, suggest]}
    job = db.one(conn, "select * from job_queue where kind = 'run_job'")
    assert job["state"] == "done", job["error"]
    run_id = db.scalar(conn, "select id from forecast_run where is_current")
    delta = db.scalar(conn, "select sum(campaign_delta) from forecast where run_id = %s and level = 'sku'", [run_id])
    expect = db.scalar(conn, "select sum(uplift + free_qty - pull_forward - cannibalised) from campaign_forecast where campaign_id = %s", [cid])
    assert delta == pytest.approx(expect, rel=1e-4) and delta > 0
    assert db.scalar(conn, "select sum(campaign_delta) from forecast where run_id = %s and level = 'total' and bucket = 'week'",
                     [run_id]) == pytest.approx(expect, rel=1e-4)
    assert count(conn, "replenishment_suggestion", "state = 'proposed' and reason = 'campaign_prebuild'") > 0
    assert count(conn, "ddmrp_buffer", "(metrics->>'paf')::numeric > 1") == 0      # buffers are from the earlier run
    res = cli.run_nightly(conn, jobs=["ddmrp_shadow"])
    assert res["ddmrp_shadow"]["status"] == "ok"
    assert count(conn, "ddmrp_buffer", "(metrics->>'paf')::numeric > 1") > 0       # planned adjustment factor


# ------------------------------------------------- other jobs with real data
def test_demand_history_takes_logo_invoices_without_a_shipment_and_keeps_other_rows(conn):
    item, dealer = sku(conn, "DYS-PU-GRI-KRT"), db.scalar(conn, "select id from party where type = 'dealer' order by name limit 1")
    week = db.scalar(conn, "select app.week_start(app.today() - 21)")
    seed_week = db.scalar(conn, "select coalesce(sum(qty_paid), 0) from demand_history where week = %s and source = 'logo'", [week])
    other = count(conn, "demand_history", "week <> %s", [week])
    assert seed_week > 0
    for doc, qty, free in (("F-1", 2400, False), ("F-1", 240, True)):
        db.insert_rows(conn, "logo_sales_doc", [{"doc_type": "invoice", "doc_no": doc, "doc_date": week, "party_id": dealer,
                                                 "item_id": item, "qty": qty, "qty_base": qty, "is_free": free}])
    res = build_demand_history.run(conn)
    assert res["logo_lines"] == 2
    rows = db.query(conn, "select * from demand_history where week = %s", [week])
    # that week now comes from logo_sales_doc; every other week of the seed's history is untouched
    assert len(rows) == 1 and rows[0]["source"] == "logo" and rows[0]["item_id"] == item and rows[0]["party_id"] == dealer
    assert (rows[0]["qty_paid"], rows[0]["qty_free"]) == (2400, 240) and rows[0]["market_id"]
    assert count(conn, "demand_history", "week <> %s", [week]) == other
    conn.rollback()


def test_lead_times_are_measured_from_qc_release_and_a_change_raises_an_alert(conn):
    lane = db.one(conn, """select sl.id, sl.supplier_id, sl.quoted_lt_days from supplier_lane sl
                             join item_family f on f.id = sl.item_family_id where f.code = 'TAPE'""")
    item = sku(conn, "DYS-MB-SARI-24MM")
    for k, days in enumerate([20, 22, 19, 21, 23, 21]):
        po = db.insert_one(conn, "purchase_order", {"po_no": f"T-LT-{k}", "supplier_id": lane["supplier_id"],
                                                    "supplier_lane_id": lane["id"], "state": "received"})
        db.execute(conn, "update purchase_order set ordered_at = now() - make_interval(days => %s) where id = %s", [days + k, po])
        db.execute(conn, """insert into po_line (po_id, line_no, item_id, qty, received_qty, state, qc_released_at)
                            values (%s, 1, %s, 1728, 1728, 'received', now() - make_interval(days => %s))""", [po, item, k])
    res = measure_lead_times.run(conn, as_of=db.scalar(conn, "select app.today() + 1"))
    assert res["measured"] == 1 and res["alerts"] == 1
    stat = db.one(conn, "select * from lead_time_stat where supplier_lane_id = %s order by as_of desc limit 1", [lane["id"]])
    assert stat["source"] == "measured" and stat["n"] == 6 and stat["mean_days"] == 21 and stat["p90_days"] == 22.5
    assert stat["sd_days"] == pytest.approx(1.41, abs=0.01)
    alert = db.one(conn, "select * from alert where rule = 'lead_time_change'")
    assert alert["entity_id"] == lane["id"] and alert["payload"]["change"]["mean_days"]["old"] == lane["quoted_lt_days"] == 14
    conn.rollback()


def test_dealer_count_makes_an_observed_estimate_and_a_vmi_proposal(conn):
    dealer = db.scalar(conn, "select id from party where type = 'dealer' and segment = 'A' order by name limit 1")
    item = sku(conn, "DYS-PU-GRI-KRT")
    assert db.scalar(conn, "select method from dealer_stock_estimate where party_id = %s and item_id = %s", [dealer, item]) == "inferred"
    assert count(conn, "task", "type = 'count_request' and party_id = %s and item_id = %s and state = 'open'", [dealer, item]) == 1
    db.insert_rows(conn, "dealer_stock_observation", [{"party_id": dealer, "item_id": item, "qty": 600, "source": "count",
                                                       "observed_at": db.scalar(conn, "select now() - interval '2 days'")}])
    db.insert_rows(conn, "vmi_param", [{"party_id": dealer, "item_id": item, "min_qty": 0, "max_qty": 0}])
    dealer_estimate.run(conn)
    e = db.one(conn, "select * from dealer_stock_estimate where party_id = %s and item_id = %s", [dealer, item])
    assert e["method"] == "observed_count" and e["qty_est"] == 600 and e["confidence"] == pytest.approx(0.5 ** (2 / 45), abs=0.02)
    assert e["weekly_sell_through"] > 0 and e["cover_weeks"] == pytest.approx(600 / e["weekly_sell_through"], abs=0.01)
    res = vmi_proposals.run(conn)
    assert res["proposals"] == 1 and res["min_max_updated"] == 1
    v = db.one(conn, "select * from vmi_param where party_id = %s and item_id = %s", [dealer, item])
    assert 0 < v["min_qty"] < v["max_qty"]
    p = db.one(conn, "select * from vmi_proposal where party_id = %s", [dealer])
    assert p["state"] == "proposed" and p["lines"][0]["item_id"] == item
    assert p["lines"][0]["qty"] >= v["max_qty"] - 600 and p["lines"][0]["counted_qty"] == 600
    out = db.scalar(conn, "select rpc_vmi_decide(%s, true)", [p["id"]])            # one tap: becomes a draft order
    assert out["state"] == "approved" and count(conn, "so_line", "order_id = %s and item_id = %s", [out["order_id"], item]) == 1
    conn.rollback()


def test_campaign_review_updates_the_library_and_settlement_rows_are_exported(conn):
    dealers = db.query(conn, "select id, segment, logo_cari_code from party where type = 'dealer' and segment = 'A' order by name")
    item = sku(conn, "DYS-MB-SARI-48MM")
    today = db.scalar(conn, "select app.today()")
    o_from, o_to = db.scalar(conn, "select app.week_start(app.today() - 91)"), db.scalar(conn, "select app.week_start(app.today() - 91) + 20")
    cid = db.scalar(conn, "select rpc_campaign_save(%s)", [{
        "code": "TEST-OLD", "name": "Bant kampanyası", "order_from": o_from, "order_to": o_to,
        "scopes": [{"item_rule": {"skus": ["DYS-MB-SARI-48MM"]}, "party_rule": {"segments": ["A"]}}],
        "mechanics": [{"mechanic_type": "buy_x_get_y", "params": {"buy_item_rule": {"skus": ["DYS-MB-SARI-48MM"]},
                                                                  "buy_qty": 10, "free_item": "same", "free_qty": 1}},
                      {"mechanic_type": "target_rebate", "params": {"period": {"from": str(o_from), "to": str(o_to)},
                                                                    "targets": {"A": 100}, "rebate_pct": 2}}]}])["campaign_id"]
    db.execute(conn, "update campaign set state = 'closed', closed_at = now(), ring_fence_released_at = now() where id = %s", [cid])
    # actual demand of the eligible dealers doubled in the three window weeks (history is at ship date)
    db.execute(conn, """update demand_history set qty_paid = qty_paid * 2
                         where item_id = %s and week between %s and %s and party_id = any(%s::uuid[])""",
               [item, o_from, o_to, [d["id"] for d in dealers]])
    order = db.scalar(conn, "select rpc_save_order(%s)", [{
        "party_id": dealers[0]["id"], "requested_date": o_from, "campaign_id": cid,
        "lines": [{"item_id": item, "qty": 1000, "ref": "a"},
                  {"item_id": item, "qty": 100, "line_type": "free", "parent_ref": "a", "mechanic_code": "buy_x_get_y"}]}])["order_id"]
    db.execute(conn, "update sales_order set state = 'shipped' where id = %s", [order])
    db.execute(conn, "update so_line set shipped_qty = qty where order_id = %s", [order])
    db.insert_rows(conn, "logo_sales_doc", [{"doc_type": "invoice", "doc_no": "F-9", "doc_date": o_from, "party_id": dealers[0]["id"],
                                             "item_id": item, "qty": 1000, "qty_base": 1000, "unit_price_eur": 1.5, "is_free": False}])
    lib_before = db.one(conn, "select * from uplift_library where mechanic_type = 'buy_x_get_y' and family_id is null")

    res = campaign_review.run(conn, as_of=today)
    assert res["reviewed"] == 1 and res["settlement_rows"] == 2
    rv = res["reviews"][0]
    assert rv["method"] == "eligibility" and rv["observed_uplift"] > 0.5
    c = db.one(conn, "select state, reviewed_at from campaign where id = %s", [cid])
    assert c["state"] == "reviewed" and c["reviewed_at"]
    rows = db.query(conn, "select * from campaign_review where campaign_id = %s", [cid])
    total = next(r for r in rows if r["item_id"] is None)
    line = next(r for r in rows if r["item_id"] == item)
    assert len(rows) == 2 and line["gross"] > 0 and total["net"] == pytest.approx(line["net"])
    assert line["net"] == pytest.approx(line["gross"] - line["borrowed"] - line["cannibalised"], abs=0.01)
    assert total["confidence"] in ("high", "medium") and total["details"]["method"] == "eligibility"
    # shrinkage: a specific (mechanic, family, segment A, band) row is created; the general prior is untouched
    lib = db.query(conn, "select * from uplift_library where mechanic_type = 'buy_x_get_y' and segment = 'A'")
    assert len(lib) == 1 and lib[0]["family_id"] and lib[0]["depth_band"] == "5-10" and lib[0]["n_obs"] == 1
    assert lib[0]["prior_uplift"] == pytest.approx(rv["observed_uplift"], abs=1e-3)
    assert lib[0]["last_obs"][0]["campaign_id"] == cid and lib[0]["last_obs"][0]["k"] == 1.0
    assert db.one(conn, "select * from uplift_library where id = %s", [lib_before["id"]])["prior_uplift"] == lib_before["prior_uplift"]
    # settlement file rows: contract keys exactly; rebate = 2% of 1500 EUR, free goods total = 100
    exp = db.query(conn, "select * from export_row where type = 'campaign_settlement' and ref_id like %s", [cid + ":%"])
    assert all(set(e["payload"]) == {"campaign_code", "dealer_code", "type", "amount_eur", "qty"} for e in exp)
    by_type = {e["payload"]["type"]: e["payload"] for e in exp}
    assert set(by_type) == {"rebate", "free_goods_total"}
    assert by_type["rebate"]["amount_eur"] == 30 and by_type["rebate"]["qty"] is None
    assert by_type["free_goods_total"]["qty"] == 100 and by_type["free_goods_total"]["amount_eur"] is None
    assert all(p["campaign_code"] == "TEST-OLD" and p["dealer_code"] == dealers[0]["logo_cari_code"] for p in by_type.values())
    assert campaign_review.run(conn, as_of=today) == {"reviewed": 0, "reviews": [], "settlement_rows": 0}   # once only
    conn.rollback()


def test_a_failing_nightly_job_is_recorded_alerted_and_does_not_stop_the_rest(conn):
    def loader(name):
        if name == "forecast":
            def boom(conn, as_of=None):
                db.execute(conn, "update forecast_run set is_current = false")     # must be rolled back
                raise RuntimeError("boom")
            return types.SimpleNamespace(run=boom)
        return cli.load_job(name)

    res = cli.run_nightly(conn, jobs=["measure_lead_times", "forecast", "compute_policy", "rebuild_check"], loader=loader)
    assert {n: r["status"] for n, r in res.items()} == {"measure_lead_times": "ok", "forecast": "failed",
                                                         "compute_policy": "skipped", "rebuild_check": "ok"}
    assert count(conn, "forecast_run", "is_current") == 1
    run = db.one(conn, "select * from job_run where job = 'forecast' order by started_at desc limit 1")
    assert run["status"] == "failed" and "boom" in run["error"] and run["finished_at"]
    a = db.one(conn, "select * from alert where rule = 'nightly_job_failed' and payload->>'job' = 'forecast'")
    assert a["severity"] == "critical" and a["realtime"] and "boom" in a["payload"]["error"]
    assert count(conn, "job_run", "status = 'running'") == 0
