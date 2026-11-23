"""Nightly budget (§13.1): complete in under 30 minutes for 2,000 SKUs and 3 years of history.

Runs classify + forecast (statsforecast baselines, MinT reconciliation over
SKU -> group -> family -> total) + policy on synthetic data and prints the
measured time (about 17 s on a 4-core build machine, so it is not marked slow).
"""
import os
import time

import numpy as np
import pandas as pd

from dayson_worker.core.classification import classify
from dayson_worker.core.forecast import run_forecast
from dayson_worker.core.policy import compute_policies, select_policy

N_SKU, N_WEEKS, BUDGET_S = 2000, 156, 30 * 60


def synthetic(seed=7):
    rng = np.random.default_rng(seed)
    weeks = pd.date_range("2023-11-27", periods=N_WEEKS, freq="W-MON")
    t = np.arange(N_WEEKS)
    y = np.zeros((N_SKU, N_WEEKS))
    kind = rng.choice(["seasonal", "short", "intermittent", "lumpy", "dying"], N_SKU, p=[0.45, 0.15, 0.25, 0.10, 0.05])
    for i in range(N_SKU):
        level = rng.uniform(5, 200)
        if kind[i] == "seasonal":
            y[i] = np.maximum(0, level * (1 + 0.3 * np.sin(2 * np.pi * (t + rng.integers(52)) / 52)) + rng.normal(0, level * 0.15, N_WEEKS))
        elif kind[i] == "short":
            start = rng.integers(60, 130)
            y[i, start:] = np.maximum(0, level + rng.normal(0, level * 0.2, N_WEEKS - start))
        elif kind[i] == "intermittent":
            y[i] = rng.poisson(max(level / 20, 2), N_WEEKS) * (rng.random(N_WEEKS) < 0.3)
        elif kind[i] == "lumpy":
            y[i] = rng.gamma(0.5, level, N_WEEKS) * (rng.random(N_WEEKS) < 0.25)
        else:
            y[i, :90] = rng.poisson(5, 90) * (rng.random(90) < 0.4)
    wide = pd.DataFrame(np.round(y), index=[f"SKU{i:04d}" for i in range(N_SKU)], columns=weeks)
    fam = np.array(["sealant", "tape", "abrasive", "griptec"])[rng.choice(4, N_SKU, p=[0.25, 0.25, 0.4, 0.1])]
    items = pd.DataFrame({"family_id": fam, "group_id": [f"g{rng.integers(12)}" for _ in range(N_SKU)]}, index=wide.index)
    return wide, items, weeks


def test_2000_skus_3_years_classify_forecast_policy_within_nightly_budget(capsys):
    wide, items, weeks = synthetic()
    as_of = weeks[-1] + pd.Timedelta(days=7)
    rng = np.random.default_rng(1)
    t0 = time.perf_counter()
    cls = classify(wide, unit_price=pd.Series(rng.uniform(1, 50, N_SKU), index=wide.index))
    t1 = time.perf_counter()
    long = wide.stack().rename("qty").reset_index()
    long.columns = ["item_id", "week", "qty"]
    res = run_forecast(long[long["qty"] > 0], items, as_of, n_jobs=int(os.environ.get("WORKER_N_JOBS", "-1")))
    t2 = time.perf_counter()
    f = res["forecast"]
    sku = f[f["level"] == "item"]
    d = sku.groupby("item_id")["final"].mean().reindex(wide.index).fillna(0.0)
    pol = [select_policy(items.at[i, "family_id"], cls.at[i, "abc"], cls.at[i, "xyz"], cls.at[i, "pattern"]) for i in wide.index]
    frame = pd.DataFrame({"d": d, "sd_d": wide.iloc[:, -52:].std(axis=1, ddof=1), "L": 3.0, "sd_L": 1.0,
                          "R": [p["review_weeks"] for p in pol], "service_level": cls["service_level"],
                          "policy": [p["policy"] for p in pol]}, index=wide.index)
    out = compute_policies(frame, wide.to_numpy())
    t3 = time.perf_counter()
    total = t3 - t0
    with capsys.disabled():
        print(f"\n[runtime] {N_SKU} SKUs x {N_WEEKS} weeks: classify {t1 - t0:.1f}s, forecast+reconcile {t2 - t1:.1f}s, "
              f"policy {t3 - t2:.1f}s, total {total:.1f}s (budget {BUDGET_S}s); "
              f"methods {res['nodes'].loc[res['nodes']['level'] == 'item', 'method'].value_counts().to_dict()}")
    assert len(cls) == N_SKU and sku["item_id"].nunique() == N_SKU and len(sku) == N_SKU * 26
    assert np.allclose(sku.groupby("week")["final"].sum(), f[f["level"] == "total"].set_index("week")["final"], atol=1e-4)
    assert out["safety_stock"].notna().all() and (out["safety_stock"] >= 0).all()
    assert set(out["policy"]) == {"continuous", "periodic", "empirical"}
    assert total < BUDGET_S / 3, f"took {total:.0f}s; want a wide margin under the 30-minute nightly budget"
