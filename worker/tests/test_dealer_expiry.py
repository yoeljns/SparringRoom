from datetime import date, timedelta

import pytest

from dayson_worker.core import dealer as D
from dayson_worker.core import expiry as E
from dayson_worker.core import ddmrp, vmi
from dayson_worker.core.policy import periodic_policy


def test_confidence_formula():
    assert D.confidence("observed_count", 0) == 1.0
    assert D.confidence("observed_count", 45) == pytest.approx(0.5)
    assert D.confidence("rep_visual", 45) == pytest.approx(0.35)
    assert D.confidence("self_report", 90) == pytest.approx(0.15)
    assert D.confidence("unknown", 0) == 0.0
    assert D.confidence("observed_count", 30, half_life_days=30) == pytest.approx(0.5)


def test_usable_days_45_22_12_and_inferred_never():
    assert D.usable_days("observed_count") == pytest.approx(45.0)
    assert D.usable_days("rep_visual") == pytest.approx(21.8, abs=0.1)        # "about 22"
    assert D.usable_days("self_report") == pytest.approx(11.8, abs=0.1)       # "about 12"
    assert D.usable_days("inferred") == float("-inf")
    # day-by-day against the 0.5 threshold
    assert D.confidence("observed_count", 45) >= 0.5 > D.confidence("observed_count", 46)
    assert D.confidence("rep_visual", 21) >= 0.5 > D.confidence("rep_visual", 22)
    assert D.confidence("self_report", 11) >= 0.5 > D.confidence("self_report", 12)
    assert all(D.confidence("inferred", d) < 0.5 for d in range(0, 400))


def test_estimate_picks_the_best_available_method():
    today = date(2026, 11, 23)
    obs = [{"qty": 120, "source": "count", "observed_at": today - timedelta(days=10)},
           {"qty": 90, "source": "self_report", "observed_at": today - timedelta(days=2)}]
    e = D.estimate_dealer_stock(obs, today)
    assert e["method"] == "observed_count" and e["qty_est"] == 120 and e["confidence"] == pytest.approx(0.5 ** (10 / 45))
    # a fresh self-report beats a stale count
    obs[0]["observed_at"] = today - timedelta(days=80)
    e = D.estimate_dealer_stock(obs, today)
    assert e["method"] == "self_report" and e["qty_est"] == 90
    # nothing usable -> inferred: last observation + sell-in since - modelled sell-through
    old = [{"qty": 100, "source": "rep_visual", "observed_at": today - timedelta(days=70)}]
    e = D.estimate_dealer_stock(old, today, sell_in_since=240, weekly_sell_through=20, sell_in_weeks=40)
    assert e["method"] == "inferred" and e["qty_est"] == pytest.approx(100 + 240 - 20 * 10)
    assert e["confidence"] == 0.4 and not D.is_usable(e)
    # no observation and under 8 weeks of sell-in -> unknown, confidence 0
    e = D.estimate_dealer_stock([], today, sell_in_since=50, weekly_sell_through=5, sell_in_weeks=6)
    assert (e["method"], e["confidence"], e["qty_est"]) == ("unknown", 0.0, None)
    e = D.estimate_dealer_stock([], today, sell_in_since=200, weekly_sell_through=15, sell_in_weeks=10)
    assert e["method"] == "inferred" and e["qty_est"] == 50


def test_usage_rules():
    usable = {"party_id": "d1", "item_id": "A", "qty_est": 300, "confidence": 0.8}
    weak = {"party_id": "d2", "item_id": "A", "qty_est": 900, "confidence": 0.4}
    rate = {("d1", "A"): 20.0, ("d2", "A"): 20.0}
    flags = D.channel_loading_flags([usable, weak], rate)                 # cover 15 weeks > 12; weak one ignored
    assert [f["party_id"] for f in flags] == ["d1"] and flags[0]["cover_weeks"] == 15
    assert D.review_confidence([usable]) == "normal" and D.review_confidence([usable, weak]) == "low"
    dealers = [{"party_id": "d1", "segment": "A"}, {"party_id": "d2", "segment": "A"}, {"party_id": "d3", "segment": "C"}]
    low_cover = {**usable, "qty_est": 40}
    t = D.near_expiry_targets(dealers, {("d1", "A"): low_cover, ("d2", "A"): weak}, rate, "A")
    assert t == [{"party_id": "d1", "basis": "low_cover", "cover_weeks": 2.0},
                 {"party_id": "d2", "basis": "segment", "cover_weeks": None}]
    reqs = D.count_requests(dealers, {"d1": [usable], "d2": [weak]})
    assert reqs == [{"party_id": "d2", "item_ids": ["A"]}]


def test_ageing_bands_with_default_margins():
    # domestic MRSL 180: green above 270, amber 180..270, red below 180, blocked under 60
    band = lambda days, **kw: E.ageing_band(days, 180, **kw)
    assert [band(d) for d in (400, 271, 270, 180, 179, 60, 59, 0)] == [
        "green", "green", "amber", "amber", "red", "red", "blocked", "blocked"]
    # margins are parameters (family, item or lot override)
    assert band(250, green_margin_days=60) == "green" and band(70, block_days=90) == "blocked"
    # red only when below MRSL for EVERY profile
    assert E.ageing_band(170, 180, min_profile_mrsl_days=150) == "amber"
    assert E.ageing_band(140, 180, min_profile_mrsl_days=150) == "red"
    assert band(400, band_override="amber") == "amber"
    assert E.lot_band(date(2027, 6, 1), date(2026, 11, 23), 180) == "amber"       # 190 days left
    assert E.lot_band(None, date(2026, 11, 23), 180) is None


def test_mrsl_rule_and_lookup_chain():
    assert E.mrsl_ok(date(2027, 5, 22), date(2026, 11, 23), 180)          # exactly 180 days
    assert not E.mrsl_ok(date(2027, 5, 21), date(2026, 11, 23), 180)
    assert not E.mrsl_ok(date(2027, 5, 22), date(2026, 11, 23), 240)      # export profile
    value, level = E.resolve_chain([("shipment", None), ("party_item", None), ("party", 270), ("family", 180)])
    assert (value, level) == (270, "party")
    assert E.resolve_chain([("lot", None), ("item", None)]) == (None, None)


def test_ddmrp_zones_and_planned_adjustment():
    z = ddmrp.buffer_zones(adu=10, dlt_days=20, lead_time_factor=0.5, variability_factor=0.5, moq=50)
    assert (z["yellow"], z["red_base"], z["red_safety"], z["red"], z["green"]) == (200, 100, 50, 150, 100)
    assert (z["top_of_red"], z["top_of_yellow"], z["top_of_green"]) == (150, 350, 450)
    paf = ddmrp.planned_adjustment_factor(1000, 250)                     # campaign delta +25%
    assert paf == 1.25 and ddmrp.buffer_zones(10, 20, paf=paf)["yellow"] == 250
    rec = ddmrp.order_recommendation(z, on_hand=120, on_order=100, qualified_demand=20)
    assert rec == {"net_flow_position": 200, "zone": "yellow", "order_qty": 250}
    assert ddmrp.order_recommendation(z, 400, 0, 0)["order_qty"] == 0
    assert ddmrp.compare_methods({"fill_rate": 0.95, "avg_stock_value_eur": 100_000},
                                 {"fill_rate": 0.96, "avg_stock_value_eur": 80_000})["keep"] == "ddmrp"


def test_vmi_min_max_reuses_periodic_formula_and_proposes_from_count():
    mm = vmi.min_max(d_week=12, sd_d_week=5, delivery_lt_weeks=1, sd_lt_weeks=0.2, review_weeks=2, service_level=0.95)
    assert mm["max"] == periodic_policy(12, 5, 1, 0.2, 2, mm["z"])["order_up_to"]
    assert mm["min"] < mm["max"]
    p = vmi.proposal_from_count(counted_qty=10, in_transit=0, mm=mm, pack_multiple=12)
    assert p["qty"] % 12 == 0 and p["qty"] >= mm["max"] - 10 and p["below_min"]
    assert p["inputs"]["counted_qty"] == 10
    assert vmi.proposal_from_count(mm["max"], 0, mm) is None
