from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from dayson_worker.core import policy as P
from dayson_worker.core.suggest import suggest_for_item, group_by_supplier, stock_health, price_for_qty
from dayson_worker.core.simulate import simulate, projected_stock
from dayson_worker.core.demand_history import build_demand_history, weekly_matrix, balance_differences

WEEKS = [date(2026, 11, 23) + timedelta(weeks=k) for k in range(26)]
POL = {**P.continuous_policy(10, 4, 3, 1, 1.96), "service_level": 0.975}      # SS 24, ROP 54


def test_continuous_suggestion_when_projected_available_falls_below_rop():
    s = suggest_for_item(item_id="A", policy=POL, forecast=[10] * 26, week_starts=WEEKS, on_hand=60, on_order=20,
                         reservations=6, order_qty=40, lead_time_weeks=3,
                         refs={"forecast_run_id": "fr1", "lead_time_stat_id": "lt1", "param_version": 7})
    # position 74; after 2 weeks of forecast 54 (not below); after 3 weeks 44 < 54 -> week index 3
    first = s[0]
    assert first["release_date"] == WEEKS[3] and first["need_date"] == WEEKS[3] + timedelta(days=21)
    assert first["qty"] == 40 and first["type"] == "purchase"
    i = first["inputs"]
    assert i["on_hand"] == 60 and i["on_order"] == 20 and i["reservations"] == 6
    assert i["forecast_before_release"] == 30 and i["projected_available"] == 44 and i["rop"] == 54
    assert i["safety_stock"] == 24 and i["z"] == 1.96 and i["service_level"] == 0.975
    assert (i["d"], i["sd_d"], i["L"], i["sd_L"]) == (10, 4, 3, 1)
    assert (i["forecast_run_id"], i["lead_time_stat_id"], i["param_version"]) == ("fr1", "lt1", 7)
    # the planned order counts as on order afterwards: next one 4 weeks later (40 units / 10 per week)
    assert s[1]["release_date"] == WEEKS[7]
    # already below ROP today -> released now, enough lots to get back to ROP
    now = suggest_for_item(item_id="A", policy=POL, forecast=[10] * 26, week_starts=WEEKS, on_hand=5,
                           order_qty=20, lead_time_weeks=3)
    assert now[0]["release_date"] == WEEKS[0] and now[0]["qty"] == 60


def test_periodic_suggestion_at_each_review_date_up_to_s():
    pol = {**P.periodic_policy(10, 4, 3, 1, 4, 1.96), "service_level": 0.975}
    S = pol["order_up_to"]
    s = suggest_for_item(item_id="B", policy=pol, forecast=[10] * 26, week_starts=WEEKS, on_hand=50,
                         lead_time_weeks=3, review_weeks=4, first_review_idx=1, order_multiple=5)
    assert [x["release_date"] for x in s[:3]] == [WEEKS[1], WEEKS[5], WEEKS[9]]
    assert s[0]["qty"] == np.ceil((S - 40) / 5) * 5 and s[0]["inputs"]["trigger"] == "review"
    assert s[1]["qty"] == 40                                   # one review period of demand
    assert s[0]["inputs"]["order_up_to"] == S and s[0]["inputs"]["R"] == 4
    assert suggest_for_item(item_id="C", policy=P.to_order_policy(), forecast=[10] * 26, week_starts=WEEKS, on_hand=0) == []


def test_abrasives_grouped_per_supplier_per_review_with_moq_and_price_breaks():
    mk = lambda item, qty, w: {"item_id": item, "qty": qty, "release_date": WEEKS[w], "need_date": WEEKS[w + 6]}
    sug = [mk("P80", 300, 0), mk("P120", 250, 0), mk("P240", 100, 4), mk("X", 10, 0)]
    lanes = {"SIA": {"moq": 600, "price_breaks": [{"min_qty": 500, "price": 0.95}, {"min_qty": 1000, "price": 0.90}]}}
    g = group_by_supplier(sug, {"P80": "SIA", "P120": "SIA", "P240": "SIA"}, lanes)
    assert len(g) == 2                                                   # one order per supplier per review
    assert g[0]["total_qty"] == 550 and not g[0]["moq_met"] and g[0]["moq_shortfall"] == 50
    assert g[0]["price_break"]["price"] == 0.95 and g[0]["qty_to_next_break"] == 450
    assert g[1]["total_qty"] == 100 and g[1]["price_break"] is None and len(g[1]["lines"]) == 1
    assert price_for_qty(lanes["SIA"]["price_breaks"], 1000)["price"] == 0.90


def test_slow_obsolete_and_at_risk_stock():
    assert stock_health(on_hand=100, weekly_forecast=10, weeks_since_last_demand=1) is None       # 10 weeks cover
    slow = stock_health(on_hand=300, weekly_forecast=10, weeks_since_last_demand=1, unit_cost=2)   # 30 weeks > 26
    assert slow["flags"] == ["slow"] and slow["value"] == 600
    assert stock_health(on_hand=5, weekly_forecast=1, weeks_since_last_demand=52)["flags"] == ["obsolete"]
    assert stock_health(on_hand=5, weekly_forecast=1, weeks_since_last_demand=3, tsb_forecast=0.01)["flags"] == ["obsolete"]
    risk = stock_health(on_hand=100, weekly_forecast=10, weeks_since_last_demand=1, amber_qty=40, unit_cost=2)
    assert risk["flags"] == ["at_risk"] and risk["amber_value"] == 80 and risk["proposed_action"] == "bundle_as_free_goods"


def _base(**kw):
    receipts = np.zeros(26)
    receipts[[3, 7, 11, 15, 19, 23]] = 40
    b = {"on_hand": 70.0, "receipts": receipts, "forecast": np.full(26, 10.0), "week_starts": WEEKS, "policy": POL,
         "lead_time_weeks": 3, "order_qty": 40, "units_per_pallet": 1, "kg_per_pallet": 598, "amber_qty": 15.0,
         "ring_fences": [{"campaign_id": "OTHER", "week_idx": 6, "qty": 30}]}
    b.update(kw)
    return b


def test_campaign_scenario_reports_the_five_outcomes_per_item():
    delta = np.zeros(26)
    delta[2:6] = 15                      # +60 over a 4-week window
    delta[6:10] = -4                     # 16 borrowed back afterwards
    res = simulate({"A": _base(), "B": _base()}, campaign_delta={"A": delta})
    assert [r["item_id"] for r in res["items"]] == ["A"]                 # affected items only
    r = res["items"][0]
    base_proj = projected_stock(70, _base()["receipts"], np.full(26, 10.0))
    scen_proj = projected_stock(70, _base()["receipts"], 10 + delta)
    assert r["projected"] == pytest.approx(scen_proj.tolist())
    assert r["weeks_below_safety_baseline"] == int((base_proj < 24).sum()) == 0
    assert r["weeks_below_safety"] == int((scen_proj < 24).sum()) > 0
    worst = float(np.clip(24 - scen_proj, 0, None).max())
    assert r["prebuild_units"] == worst and r["prebuild_pallets"] == int(np.ceil(worst))
    first_short = int(np.argmax(scen_proj < 24))
    assert r["prebuild_by"] == WEEKS[first_short]
    assert r["prebuild_release_by"] == WEEKS[first_short] - timedelta(days=21)
    assert r["amber_consumed"] == 15.0                                   # 60 extra units absorb all amber stock
    assert r["added_trucks"] == pytest.approx(60 * 598 / 24987.5, abs=0.01)
    assert res["summary"]["added_trucks"] == 2
    c = r["ring_fence_conflicts"]
    assert len(c) == 1 and c[0]["campaign_id"] == "OTHER" and c[0]["week"] == WEEKS[6]
    assert c[0]["short_qty"] == pytest.approx(30 - max(scen_proj[6], 0)) and c[0]["short_before"] == 0
    assert r["suggested_qty"] > r["suggested_qty_baseline"]
    assert all("inputs" in s for s in r["suggestions"])


def test_lead_time_scenario_6_to_10_weeks():
    pol = {**P.continuous_policy(10, 4, 6, 1, 1.96), "service_level": 0.975}
    receipts = np.zeros(26)
    receipts[[2, 6, 10, 14, 18, 22]] = 40
    base = _base(policy=pol, lead_time_weeks=6, receipts=receipts, on_hand=50.0, ring_fences=[])
    res = simulate({"A": base}, lead_time_weeks={"A": 10})
    r = res["items"][0]
    assert r["safety_stock"] > r["safety_stock_baseline"]                # longer lead time, more buffer
    assert r["weeks_below_safety"] > r["weeks_below_safety_baseline"]    # open receipts arrive 4 weeks later
    # baseline never drops below its safety stock of 28; delayed, stock is 30 < 32 in week 1 and -10 in week 5
    assert (r["safety_stock_baseline"], r["safety_stock"]) == (28, 32)
    assert r["first_stockout_week"] == WEEKS[5] and r["prebuild_pallets"] == 42 and r["prebuild_by"] == WEEKS[1]
    assert r["added_trucks"] == 0.0 and res["summary"]["items_affected"] == 1
    assert r["suggested_qty"] >= r["suggested_qty_baseline"]


def test_scenario_with_exact_truck_count_from_the_planner():
    delta = np.zeros(26)
    delta[2:6] = 10.5                                                    # 42 extra pallets of a 595 kg item
    res = simulate({"A": _base(kg_per_pallet=595)}, campaign_delta={"A": delta}, use_planner=True)
    assert res["summary"]["added_trucks_exact"] == 1 and res["summary"]["added_truck_remainder"] == {}


def test_demand_history_keeps_paid_and_free_apart_and_tags_bundles():
    lines = pd.DataFrame([
        {"item_id": "A", "party_id": "d1", "market_id": "TR", "ship_date": "2026-11-24", "qty": 100, "line_type": "paid", "bundle_id": None, "campaign_id": "C1"},
        {"item_id": "A", "party_id": "d1", "market_id": "TR", "ship_date": "2026-11-27", "qty": 10, "line_type": "free", "bundle_id": None, "campaign_id": "C1"},
        {"item_id": "A", "party_id": "d1", "market_id": "TR", "ship_date": "2026-11-29", "qty": 6, "line_type": "bundle_component", "bundle_id": "B7", "campaign_id": None},
        {"item_id": "A", "party_id": "d1", "market_id": "TR", "ship_date": "2026-11-30", "qty": 50, "line_type": "paid", "bundle_id": None, "campaign_id": None},
    ])
    h = build_demand_history(lines)
    wk = pd.Timestamp("2026-11-23")
    c1 = h[(h["week"] == wk) & (h["campaign_id"] == "C1")].iloc[0]
    assert (c1["qty_paid"], c1["qty_free"], c1["source"]) == (100, 10, "order")
    b = h[h["source"] == "bundle:B7"].iloc[0]
    assert (b["qty_paid"], b["qty_free"], b["week"]) == (6, 0, wk)        # Sunday belongs to the week of Monday 23rd
    assert h[h["week"] == pd.Timestamp("2026-11-30")]["qty_paid"].sum() == 50
    m = weekly_matrix(h, "total")
    assert m.loc["A"].tolist() == [116.0, 50.0] and weekly_matrix(h, "free").loc["A"].tolist() == [10.0, 0.0]


def test_rebuilt_balances_equal_stock_balance():
    moves = pd.DataFrame([
        {"item_id": "A", "lot_id": "L1", "location_id": "TZ-B03-L12", "owner_id": "DAYSON", "stock_status": "available", "qty_base": 100.0},
        {"item_id": "A", "lot_id": "L1", "location_id": "TZ-B03-L12", "owner_id": "DAYSON", "stock_status": "available", "qty_base": -30.0},
        {"item_id": "A", "lot_id": "L1", "location_id": "DOCK", "owner_id": "DAYSON", "stock_status": "available", "qty_base": 30.0},
    ])
    bal = pd.DataFrame([
        {"item_id": "A", "lot_id": "L1", "location_id": "TZ-B03-L12", "owner_id": "DAYSON", "stock_status": "available", "qty_base": 70.0},
        {"item_id": "A", "lot_id": "L1", "location_id": "DOCK", "owner_id": "DAYSON", "stock_status": "available", "qty_base": 30.0},
    ])
    assert balance_differences(moves, bal).empty
    bal.loc[1, "qty_base"] = 29.0
    d = balance_differences(moves, bal)
    assert len(d) == 1 and d.iloc[0]["location_id"] == "DOCK" and d.iloc[0]["diff"] == 1.0
