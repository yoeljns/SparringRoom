import numpy as np
import pandas as pd
import pytest

from dayson_worker.core import forecast as F
from dayson_worker.core import accuracy as A

WEEKS = pd.date_range("2024-01-01", periods=130, freq="W-MON")
AS_OF = WEEKS[-1] + pd.Timedelta(days=7)


def test_routing_table():
    r = F.route_method
    assert r("smooth", 60) == "ses_holt"                                   # smooth, under 2 years
    assert r("smooth", 104) == "holt_winters"                              # smooth, 2+ years
    assert r("erratic", 120) == "holt_winters"
    assert r("intermittent", 150, weeks_since_last_demand=3, mean_interval=3.25) == "sba"
    assert r("lumpy", 150, weeks_since_last_demand=6, mean_interval=3.25) == "sba"
    assert r("lumpy", 150, weeks_since_last_demand=6.5, mean_interval=3.25) == "tsb"   # twice the usual interval
    assert r("smooth", 10, lifecycle="launch") == "launch_analog"
    assert r("smooth", 26, lifecycle="launch") == "ses_holt"               # statistical after 26 weeks
    assert r("intermittent", 30, lifecycle="launch", weeks_since_last_demand=1, mean_interval=2) == "sba"
    assert r("smooth", 150, export_contract=True) == "contract_schedule"   # the schedule is the demand


def _history(seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(130)
    rows, meta = [], {}
    for k in range(24):
        item = f"i{k:02d}"
        fam = f"fam{k % 3}"
        grp = f"col{k % 4}"
        if k % 4 == 3:                                  # intermittent
            y = rng.poisson(6, 130) * (rng.random(130) < 0.3)
        elif k % 4 == 2:                                # short history (under 2 years)
            y = rng.poisson(30, 130).astype(float)
            y[:70] = 0
        else:                                           # smooth and seasonal, 2.5 years
            y = np.maximum(0, 50 + 20 * np.sin(2 * np.pi * t / 52) + rng.normal(0, 4, 130)).round()
        meta[item] = {"family_id": fam, "group_id": grp}
        rows.append(pd.DataFrame({"item_id": item, "week": WEEKS, "qty": y}))
    h = pd.concat(rows, ignore_index=True)
    return h[h["qty"] > 0], pd.DataFrame.from_dict(meta, orient="index")


@pytest.fixture(scope="module")
def result():
    hist, items = _history()
    camp = pd.DataFrame({"item_id": ["i00", "i00"], "week": [AS_OF, AS_OF + pd.Timedelta(days=7)], "delta": [40.0, 25.0]})
    over = pd.DataFrame({"item_id": ["i01"], "week": [AS_OF], "delta": [-10.0]})
    return F.run_forecast(hist, items, AS_OF, campaign_delta=camp, overrides=over)


def test_26_weekly_buckets_per_node_and_methods(result):
    f = result["forecast"]
    assert f.groupby("node")["week"].nunique().eq(26).all()
    assert f["week"].min() == AS_OF
    nodes = result["nodes"]
    sku = nodes[nodes["level"] == "item"]
    assert set(sku.loc[sku["pattern"].isin(["intermittent", "lumpy"]), "method"]) <= {"sba", "tsb"}
    short = sku[(sku["weeks_history"] < 104) & sku["pattern"].isin(["smooth", "erratic"])]
    assert len(short) == 6 and set(short["method"]) <= {"ses", "holt"}
    long = sku[(sku["weeks_history"] >= 104) & sku["pattern"].isin(["smooth", "erratic"])]
    assert len(long) == 12 and set(long["method"]) == {"holt_winters"}
    assert (f[["base", "final"]] >= 0).all().all()


def test_reconciled_forecasts_sum_across_the_hierarchy(result):
    f = result["forecast"]
    for col in ("base", "campaign_delta", "override_delta", "final"):
        sku = f[f["level"] == "item"]
        total = f[f["level"] == "total"].set_index("week")[col]
        assert np.allclose(sku.groupby("week")[col].sum(), total, atol=1e-6)
        fam = f[f["level"] == "family"]
        assert np.allclose(fam.groupby("week")[col].sum(), total, atol=1e-6)
        by_family = sku.groupby(["family_id", "week"])[col].sum()
        assert np.allclose(by_family, fam.set_index(["family_id", "week"])[col].reindex(by_family.index), atol=1e-6)
        grp = f[f["level"] == "group"]
        assert np.allclose(grp.groupby(["family_id", "week"])[col].sum(), by_family, atol=1e-6)
    # and after rounding to the stored numeric(14,3)
    r = f.assign(base=f["base"].round(3))
    assert np.allclose(r[r["level"] == "item"].groupby("week")["base"].sum(),
                       r[r["level"] == "total"].set_index("week")["base"], atol=0.05)
    # the unreconciled base forecasts did NOT add up, so reconciliation did real work
    raw_gap = (f[f["level"] == "item"].groupby("week")["base_raw"].sum()
               - f[f["level"] == "total"].set_index("week")["base_raw"]).abs().max()
    assert raw_gap > 1.0


def test_final_is_base_plus_campaign_plus_override_all_stored(result):
    f = result["forecast"]
    assert np.allclose(f["final"], f["base"] + f["campaign_delta"] + f["override_delta"], atol=1e-6)
    i00 = f[(f["item_id"] == "i00") & (f["level"] == "item")].set_index("week")
    assert i00.loc[AS_OF, "campaign_delta"] == 40.0 and i00["campaign_delta"].sum() == 65.0
    i01 = f[(f["item_id"] == "i01") & (f["level"] == "item")].set_index("week")
    assert i01.loc[AS_OF, "override_delta"] == -10.0
    total = f[f["level"] == "total"].set_index("week")
    assert total.loc[AS_OF, "campaign_delta"] == pytest.approx(40.0) and total.loc[AS_OF, "override_delta"] == pytest.approx(-10.0)


def test_holt_winters_follows_the_season(result):
    f = result["forecast"]
    s = f[(f["item_id"] == "i00") & (f["level"] == "item")].set_index("week")["base_raw"]
    t = 130 + np.arange(26)
    truth = 50 + 20 * np.sin(2 * np.pi * t / 52)
    assert np.corrcoef(s.to_numpy(), truth)[0, 1] > 0.8
    assert A.wape(truth, s.to_numpy()) < 0.25


def test_by_market_hierarchy_adds_up():
    hist, items = _history(1)
    hist = hist[hist["item_id"].isin([f"i{k:02d}" for k in range(8)])].copy()
    hist["market_id"] = np.where(np.arange(len(hist)) % 3 == 0, "DE", "TR")
    r = F.run_forecast(hist, items, AS_OF, by_market=True)
    f = r["forecast"]
    total = f[f["level"] == "total"].set_index("week")["final"]
    assert np.allclose(f[f["level"] == "market"].groupby("week")["final"].sum(), total, atol=1e-6)
    assert np.allclose(f[f["is_bottom"]].groupby("week")["final"].sum(), total, atol=1e-6)
    assert np.allclose(f[(f["level"] == "item") & ~f["is_bottom"]].groupby("week")["final"].sum(), total, atol=1e-6)
    assert set(f.loc[f["level"] == "market", "market_id"]) == {"DE", "TR"}


def test_launch_uses_analog_curve_plus_manual_plan_and_contracts_use_the_schedule():
    hist, items = _history(2)
    hist = hist[hist["item_id"] != "i05"]
    new = pd.DataFrame({"item_id": "i05", "week": WEEKS[-10:], "qty": 5.0})          # launched 10 weeks ago
    hist = pd.concat([hist, new], ignore_index=True)
    items["lifecycle"] = "mature"
    items.loc["i05", "lifecycle"] = "launch"
    items["analog_item_id"] = None
    items.loc["i05", "analog_item_id"] = "i00"
    items["analog_scale"] = 0.5
    items["export_contract"] = False
    items.loc["i09", "export_contract"] = True
    sched = {"i09": {AS_OF: 300.0, AS_OF + pd.Timedelta(weeks=4): 300.0}}
    r = F.run_forecast(hist, items, AS_OF, contract_schedules=sched, manual_plans={"i05": {0: 100.0}}, reconcile=None)
    f = r["forecast"]
    assert r["nodes"].loc[r["nodes"]["item_id"] == "i05", "method"].iloc[0] == "launch_analog"
    lau = f[(f["item_id"] == "i05") & (f["level"] == "item")]["base"].to_numpy()
    analog = hist[hist["item_id"] == "i00"].set_index("week")["qty"].reindex(WEEKS).fillna(0).to_numpy()
    assert lau[0] == pytest.approx(0.5 * analog[10] + 100.0)          # analog at the same age, scaled, + manual plan
    assert lau[1] == pytest.approx(0.5 * analog[11])
    con = f[(f["item_id"] == "i09") & (f["level"] == "item")].set_index("week")["base"]
    assert con.sum() == 600.0 and con.loc[AS_OF] == 300.0 and con.iloc[1] == 0.0
    assert F.launch_analog_forecast([10, 20, 30], 2, h=3).tolist() == [30.0, 20.0, 20.0]


def test_sba_and_tsb_match_their_definitions():
    y = np.zeros(60)
    y[[0, 4, 9, 13, 18, 22, 27, 31, 36, 40, 45, 49, 54]] = [5, 7, 4, 6, 5, 8, 4, 6, 5, 7, 6, 5, 4]
    wide = pd.DataFrame([y, y], index=["sba", "tsb"], columns=pd.date_range("2025-01-06", periods=60, freq="W-MON"))
    fc, used = F.statistical_forecast(wide, pd.Series({"sba": "sba", "tsb": "tsb"}), h=4)
    # Croston with alpha 0.1 on sizes and intervals, times the SBA factor (1 - alpha/2)
    z, p, q, a = y[0], 1.0, 1, 0.1
    for v in y[1:]:
        if v > 0:
            z, p, q = z + a * (v - z), p + a * (q - p), 1
        else:
            q += 1
    assert fc.loc["sba"].to_numpy() == pytest.approx(np.full(4, (1 - a / 2) * z / p), rel=1e-6)
    # TSB: demand probability decays every period without demand
    assert fc.loc["tsb"].iloc[0] > 0 and np.allclose(fc.loc["tsb"], fc.loc["tsb"].iloc[0])
    dying = y.copy()
    dying[20:] = 0
    wide2 = pd.DataFrame([y, dying], index=["alive", "dying"], columns=wide.columns)
    fc2, _ = F.statistical_forecast(wide2, pd.Series({"alive": "tsb", "dying": "tsb"}), h=4)
    assert fc2.loc["dying"].iloc[0] < 0.1 * fc2.loc["alive"].iloc[0]   # TSB lets dying SKUs decay towards zero


def test_ses_or_holt_is_chosen_by_error():
    cols = pd.date_range("2025-01-06", periods=60, freq="W-MON")
    rng = np.random.default_rng(5)
    trend = 20 + 3.0 * np.arange(60) + rng.normal(0, 1, 60)
    flat = 100 + rng.normal(0, 8, 60)
    wide = pd.DataFrame([trend, flat], index=["trend", "flat"], columns=cols)
    fc, used = F.statistical_forecast(wide, pd.Series({"trend": "ses_holt", "flat": "ses_holt"}), h=6)
    assert used["trend"] == "holt" and used["flat"] in ("ses", "holt")
    assert fc.loc["trend"].iloc[-1] > trend[-1] + 10               # Holt extrapolates the trend
    assert abs(fc.loc["flat"].mean() - 100) < 10


def test_family_monthly_18_buckets():
    hist, items = _history(3)
    wide = hist.assign(family_id=hist["item_id"].map(items["family_id"])).groupby(["family_id", "week"])["qty"].sum() \
               .unstack(fill_value=0.0).reindex(columns=WEEKS, fill_value=0.0)
    m = F.family_monthly_forecast(wide)
    assert m.groupby("family_id")["month"].nunique().eq(18).all() and len(m) == 3 * 18
    assert set(m["method"]) <= {"holt_winters", "ses", "holt"} and (m["base"] >= 0).all()
    assert m["month"].min() == pd.Timestamp("2026-06-01") or m["month"].min() == pd.Timestamp("2026-07-01")


def test_accuracy_wape_bias_mase_and_value_added():
    actual = np.array([100, 120, 80, 100])
    assert A.wape(actual, [110, 110, 90, 90]) == pytest.approx(40 / 400)
    assert A.bias(actual, [110, 130, 90, 110]) == pytest.approx(0.10)            # sum(f - a) / sum(a)
    insample = np.array([0, 4, 0, 0, 6, 0, 2, 0])
    scale = np.abs(np.diff(insample)).mean()
    assert A.mase([0, 5], [1, 3], insample) == pytest.approx(1.5 / scale)
    fva = A.forecast_value_added(actual, naive=[80, 80, 120, 120], statistical=[100, 110, 90, 100], final=[100, 120, 60, 100])
    assert fva["fva_statistical"] > 0 and fva["fva_final"] == pytest.approx(0.05 - 0.05)
    worse = A.forecast_value_added(actual, [80] * 4, [100, 110, 90, 100], [150, 150, 150, 150])
    assert worse["fva_final"] < 0


def test_accuracy_is_measured_at_lag_equal_to_lead_time():
    weeks = pd.date_range("2026-01-05", periods=8, freq="W-MON")
    snaps = []
    for made in range(6):                        # a run every week; forecast = 100 + 10 x lag
        for tgt in range(made + 1, 8):
            snaps.append({"item_id": "A", "made_week": weeks[made], "week": weeks[tgt], "final": 100 + 10 * (tgt - made)})
    snaps = pd.DataFrame(snaps)
    picked = A.at_lag(snaps, pd.Series({"A": 3.0}))
    assert (picked["final"] == 130).all() and picked["week"].min() == weeks[3]     # always the lag-3 forecast
    actuals = pd.DataFrame({"item_id": "A", "week": weeks, "qty": 100.0})
    res = A.accuracy_by_family(snaps, actuals, pd.Series({"A": 3.0}), pd.Series({"A": "F1"}),
                               intermittent=pd.Series({"A": True}), insample={"A": [0, 5, 0, 0, 7, 0]})
    assert res["family"].loc["F1", "wape"] == pytest.approx(0.30) and res["family"].loc["F1", "bias"] == pytest.approx(0.30)
    assert res["mase"]["A"] > 0
    rows = pd.DataFrame({"source": ["u1"] * 4 + ["u2"] * 4, "week": list(weeks[:4]) * 2, "actual": 100.0,
                         "statistical": 95.0, "final": [140.0] * 4 + [100.0] * 4})
    flagged = A.flag_negative_override_sources(rows)
    assert list(flagged.index) == ["u1"]
