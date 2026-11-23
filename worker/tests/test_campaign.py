from datetime import date

import numpy as np
import pandas as pd
import pytest

from dayson_worker.core import campaign as K
from dayson_worker.core.expiry import kit_lot_expiry


def test_review_reproduces_3520_net_from_4800_gross_and_1280_borrowed():
    baseline = np.full(20, 1000.0)
    actual = baseline.copy()
    actual[4:8] += 1200                 # 4-week order window: 4,800 gross
    actual[8:16] -= 160                 # dip over the 8 weeks after: 1,280 borrowed
    r = K.campaign_review(actual, baseline, window=(4, 7))
    assert r["gross"] == 4800 and r["borrowed"] == 1280 and r["cannibalised"] == 0
    assert r["net"] == 3520
    assert round(r["borrow_rate"] * 100) == 27
    t = K.review_from_totals(4800, 1280)
    assert t["net"] == 3520 and t["borrow_rate"] == pytest.approx(0.2667, abs=1e-4)


def test_review_counts_4_weeks_before_8_after_and_sister_shortfall():
    baseline = np.full(24, 100.0)
    actual = baseline.copy()
    actual[8:12] += 50                  # gross 200
    actual[4:8] -= 5                    # 4 weeks before: 20
    actual[3] -= 99                     # outside the 4 weeks before: ignored
    actual[12:20] -= 5                  # 8 weeks after: 40
    actual[20] -= 99                    # outside the 8 weeks after: ignored
    sister_a = np.full(24, 50.0)
    sister_a[8:12] -= 10                # shortfall 40 during the window
    sister_b = np.full(24, 50.0)
    sister_b[8:12] += 30                # a sister doing better does not offset
    r = K.campaign_review(actual, baseline, (8, 11), sisters=[(sister_a, np.full(24, 50.0)), (sister_b, np.full(24, 50.0))])
    assert (r["gross"], r["borrowed"], r["cannibalised"], r["net"]) == (200, 60, 40, 100)


def test_uplift_library_shrinkage_k_values():
    assert K.shrink_prior(0.20, 4, 0.40, "eligibility") == pytest.approx((4 * 0.20 + 1.0 * 0.40) / 5.0)
    assert K.shrink_prior(0.20, 4, 0.40, "participation") == pytest.approx((4 * 0.20 + 0.5 * 0.40) / 4.5)
    assert K.shrink_prior(0.20, 4, 0.40, "no_control") == pytest.approx((4 * 0.20 + 0.25 * 0.40) / 4.25)
    assert K.shrink_prior(0.0, 0, 0.35, "eligibility") == pytest.approx(0.35)       # first observation
    row = {"prior_uplift": 0.20, "n_obs": 4, "last_obs": [{"observed": x} for x in (0.1, 0.2, 0.3, 0.15, 0.25)]}
    new = K.update_library_row(row, 0.40, "participation", campaign_id="C9")
    assert new["n_obs"] == 5 and len(new["last_obs"]) == 5 and new["last_obs"][-1]["observed"] == 0.40
    assert new["prior_uplift"] == pytest.approx(0.2222, abs=1e-4)
    assert K.prior_range(new) == (0.15, 0.40)
    assert K.estimate_method(True, True)["k"] == 1.0
    assert K.estimate_method(False, True) == {"method": "participation", "k": 0.5, "confidence": "low"}
    assert K.estimate_method(False, False)["k"] == 0.25


def test_intensity_measures():
    lines = pd.DataFrame([
        {"item_id": "A", "week": 1, "qty_paid": 80, "qty_free": 0, "list_eur": 800, "net_eur": 800, "campaign_id": None},
        {"item_id": "A", "week": 1, "qty_paid": 100, "qty_free": 20, "list_eur": 1000, "net_eur": 900, "campaign_id": "C1"},
        {"item_id": "A", "week": 2, "qty_paid": 50, "qty_free": 0, "list_eur": 500, "net_eur": 500, "campaign_id": None},
    ])
    active = pd.DataFrame([{"campaign_id": "C1", "item_id": "A", "week": 1}, {"campaign_id": "C2", "item_id": "A", "week": 1}])
    m = K.intensity_measures(lines, active).set_index(["item_id", "week"])
    w1 = m.loc[("A", 1)]
    assert w1["discount_depth"] == pytest.approx(1 - 1700 / 1800)       # effective depth against list
    assert w1["free_ratio"] == pytest.approx(20 / 200)                  # free-goods ratio
    assert w1["campaign_share"] == pytest.approx(120 / 200)             # volume under a non-standard mechanic
    assert w1["n_campaigns"] == 2                                       # count of active campaigns
    assert m.loc[("A", 2)].tolist() == [0.0, 0.0, 0.0, 0]


def test_uplift_model_recovers_uplift_pull_forward_and_cannibalisation():
    rng = np.random.default_rng(3)
    rows = []
    for g, group in enumerate(("red", "blue", "green")):
        for k in range(4):
            item = f"{group}-{k}"
            base = 200.0 + 30 * k
            inten = np.zeros(80)
            if k == 0:                                   # one SKU per group is promoted, twice
                inten[20:24] = 0.15
                inten[50:54] = 0.25
            rows.append(pd.DataFrame({"item_id": item, "group_id": group, "week": np.arange(80), "baseline": base,
                                      "intensity": inten}))
    d = pd.concat(rows, ignore_index=True)
    grp = d.groupby(["group_id", "week"])["intensity"]
    sister = (grp.transform("sum") - d["intensity"]) / 3.0
    lag1 = d.groupby("item_id")["intensity"].shift(1).fillna(0.0)
    lag2 = d.groupby("item_id")["intensity"].shift(2).fillna(0.0)
    mult = np.exp(2.0 * d["intensity"] - 0.8 * lag1 - 0.4 * lag2 - 1.5 * sister + rng.normal(0, 0.02, len(d)))
    d["demand"] = d["baseline"] * mult
    m = K.fit_uplift_model(d, n_lags=2, ridge_sku=5.0, offset=0.0)
    assert m.b == pytest.approx(2.0, abs=0.15)
    assert m.lags[0] == pytest.approx(-0.8, abs=0.15) and m.lags[1] == pytest.approx(-0.4, abs=0.15)   # pull-forward
    assert m.cross == pytest.approx(-1.5, abs=0.3) and m.cross < 0                                      # cannibalisation
    assert m.predict(100, 0.2) == pytest.approx(100 * np.exp(m.b * 0.2))
    assert max(abs(v) for v in m.sku_effects.values()) < 0.05          # pooled SKU effects stay near zero


def test_eligibility_comparison_and_forward_buying():
    # eligible dealers +50% during, ineligible +10% -> uplift of 36%
    assert K.eligibility_uplift(100, 150, 200, 220) == pytest.approx(150 / 100 / 1.1 - 1)
    assert K.is_forward_buying(sell_in_growth=0.40, sell_through_growth=0.02)
    assert not K.is_forward_buying(sell_in_growth=0.40, sell_through_growth=0.35)


def test_kit_lot_takes_the_earliest_component_expiry():
    assert kit_lot_expiry([date(2027, 6, 30), date(2027, 1, 15), date(2028, 2, 1)]) == date(2027, 1, 15)
    assert kit_lot_expiry([date(2027, 6, 30), None]) == date(2027, 6, 30)       # gift items without expiry
    assert kit_lot_expiry([None, None]) is None
