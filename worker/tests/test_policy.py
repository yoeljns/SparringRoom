import math

import numpy as np
import pandas as pd
import pytest

from dayson_worker.core import policy as P


def test_spec_worked_example_safety_stock_24_rop_54():
    # §8.5: d=10 pallets/wk, sd 4, L=3 wk, sd_L 1, service level 97.5% (z = 1.96)
    z = P.z_for_service_level(0.975)
    assert z == 1.96
    r = P.continuous_policy(d=10, sd_d=4, L=3, sd_L=1, z=z)
    assert r["safety_stock_raw"] == pytest.approx(1.96 * math.sqrt(3 * 16 + 100 * 1))
    assert r["safety_stock_raw"] == pytest.approx(1.96 * 12.17, abs=0.01)
    assert r["safety_stock"] == 24
    assert r["rop"] == 54


def test_constant_lead_time_safety_stock_14():
    r = P.continuous_policy(d=10, sd_d=4, L=3, sd_L=0, z=1.96)
    assert r["safety_stock_raw"] == pytest.approx(1.96 * 4 * math.sqrt(3))
    assert r["safety_stock"] == 14
    assert P.continuous_policy(10, 4, 3, 1, 1.96)["safety_stock"] - r["safety_stock"] == 10


def test_periodic_order_up_to():
    r = P.periodic_policy(d=10, sd_d=4, L=3, sd_L=1, R=1, z=1.96)
    assert r["safety_stock_raw"] == pytest.approx(1.96 * math.sqrt(4 * 16 + 100))
    assert r["order_up_to"] == 10 * 4 + math.ceil(1.96 * math.sqrt(164))


def test_z_from_service_matrix_levels():
    assert P.z_for_service_level(0.95) == 1.64 or P.z_for_service_level(0.95) == 1.65
    assert P.z_for_service_level(0.98) == 2.05
    with pytest.raises(ValueError):
        P.z_for_service_level(1.0)


def test_empirical_order_up_to_is_quantile_of_bootstrap():
    hist = [0, 0, 5, 0, 0, 0, 12, 0, 0, 3, 0, 0, 0] * 8
    lo = P.empirical_order_up_to(hist, L=3, R=1, service_level=0.50, seed=1)
    hi = P.empirical_order_up_to(hist, L=3, R=1, service_level=0.95, seed=1)
    assert hi["order_up_to"] > lo["order_up_to"] >= 0
    assert hi["order_up_to"] <= 4 * 12                      # cannot exceed 4 periods of the largest demand
    assert hi == P.empirical_order_up_to(hist, L=3, R=1, service_level=0.95, seed=1)   # deterministic
    const = P.empirical_order_up_to([5] * 30, L=2, R=1, service_level=0.9)
    assert const["order_up_to"] == 15 and const["safety_stock"] == 0


def test_to_order_has_no_safety_stock():
    assert P.compute_item_policy(d=5, sd_d=3, L=2, sd_L=1, service_level=0.95, policy="to_order")["safety_stock"] == 0


def test_select_policy_table():
    assert P.select_policy("sealant", "A", "X", "smooth")["policy"] == "continuous"
    assert P.select_policy("sealant", "B", "Y", "erratic")["policy"] == "continuous"
    assert P.select_policy("tape", "A", "X", "smooth")["policy"] == "continuous"
    t = P.select_policy("tape", "B", "X", "smooth")
    assert t["policy"] == "periodic" and t["review_weeks"] == 1
    a = P.select_policy("abrasive", "B", "X", "smooth")
    assert a["policy"] == "periodic" and a["group_by_supplier"] and a["review_weeks"] == pytest.approx(52 / 12)
    assert P.select_policy("sealant", "A", "Z", "lumpy")["policy"] == "empirical"
    assert P.select_policy("tape", "C", "Y", "intermittent")["policy"] == "empirical"
    assert P.select_policy("sealant", "A", "X", "smooth", export_contract=True)["policy"] == "to_order"
    assert P.select_policy("tape", "C", "Z", "lumpy", dealer_agreement_to_order=True)["policy"] == "to_order"


def test_order_quantity_max_eoq_moq_rounded_to_pallets_and_multiple():
    q = P.order_quantity(weekly_demand=100, economic_qty=730, moq=500, pallet_qty=48, order_multiple=0)
    assert q["max_eoq_moq"] == 730 and q["qty"] == 768          # 16 pallets
    q = P.order_quantity(weekly_demand=100, economic_qty=100, moq=500, pallet_qty=48, order_multiple=96)
    assert q["qty"] == 576 and q["qty"] % 96 == 0 and q["qty"] % 48 == 0


def test_order_quantity_raised_to_full_truck_only_when_freight_saving_wins():
    kw = dict(weekly_demand=480, economic_qty=1500, pallet_qty=48, truck_qty=48 * 42, unit_cost=2.0, holding_rate=0.2)
    cheap = P.order_quantity(freight_saved_per_truck=1.0, **kw)
    assert cheap["qty"] == 1536 and not cheap["truck_raised"]
    worth = P.order_quantity(freight_saved_per_truck=400.0, **kw)
    assert worth["qty"] == 2016 and worth["truck_raised"]
    assert worth["truck_added_holding_cost"] < 400.0


def test_order_quantity_capped_for_expiry_controlled_items():
    # shelf life 365, MRSL 180 -> cover from one order must stay below (365-180)/2 days = 13.2 weeks
    q = P.order_quantity(weekly_demand=10, economic_qty=400, pallet_qty=10, expiry_controlled=True,
                         shelf_life_days=365, mrsl_days=180)
    assert q["expiry_capped"] and q["qty"] == 130
    assert q["weeks_of_cover"] < 0.5 * (365 - 180) / 7
    free = P.order_quantity(weekly_demand=10, economic_qty=400, pallet_qty=10, expiry_controlled=False,
                            shelf_life_days=365, mrsl_days=180)
    assert free["qty"] == 400


def test_vectorised_policies_match_scalar():
    f = pd.DataFrame({"d": [10.0, 10.0, 2.0, 5.0], "sd_d": [4.0, 4.0, 3.0, 1.0], "L": [3.0, 3.0, 2.0, 1.0],
                      "sd_L": [1.0, 1.0, 0.5, 0.0], "R": [0.0, 1.0, 1.0, 0.0],
                      "service_level": [0.975, 0.975, 0.95, 0.9],
                      "policy": ["continuous", "periodic", "empirical", "to_order"]})
    hist = np.tile([0, 0, 6, 0], (4, 26))
    out = P.compute_policies(f, hist)
    assert out.loc[0, "safety_stock"] == 24 and out.loc[0, "rop"] == 54
    assert out.loc[1, "order_up_to"] == P.periodic_policy(10, 4, 3, 1, 1, 1.96)["order_up_to"]
    assert out.loc[2, "order_up_to"] > 0 and np.isnan(out.loc[2, "rop"])
    assert out.loc[3, "safety_stock"] == 0 and out.loc[3, "rop"] == 0
