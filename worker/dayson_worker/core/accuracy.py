"""Forecast accuracy (spec §8.3): WAPE, bias, MASE at lag = lead time; forecast value added."""
from __future__ import annotations

import numpy as np
import pandas as pd


def wape(actual, forecast) -> float:
    a, f = np.asarray(actual, float), np.asarray(forecast, float)
    den = np.abs(a).sum()
    return float(np.abs(f - a).sum() / den) if den > 0 else float("nan")


def bias(actual, forecast) -> float:
    """Sum of (forecast - actual) / sum of actual (§13.3 forecast bias; target within ±5%)."""
    a, f = np.asarray(actual, float), np.asarray(forecast, float)
    den = a.sum()
    return float((f - a).sum() / den) if den != 0 else float("nan")


def mase(actual, forecast, insample, season: int = 1) -> float:
    """Mean absolute scaled error; scale = in-sample MAE of the (seasonal) naive forecast."""
    a, f, y = np.asarray(actual, float), np.asarray(forecast, float), np.asarray(insample, float)
    if y.size <= season:
        return float("nan")
    scale = np.abs(y[season:] - y[:-season]).mean()
    return float(np.abs(f - a).mean() / scale) if scale > 0 else float("nan")


def at_lag(snapshots: pd.DataFrame, lead_time_weeks: pd.Series) -> pd.DataFrame:
    """Keep, for every (item, target week), the forecast made lead-time weeks earlier.

    snapshots: (item_id, made_week, week, ...) from past forecast runs.
    The run chosen is the latest one made at least ``lead time`` weeks before the target week.
    """
    s = snapshots.copy()
    s["week"] = pd.to_datetime(s["week"])
    s["made_week"] = pd.to_datetime(s["made_week"])
    lag = ((s["week"] - s["made_week"]).dt.days // 7)
    lt = np.ceil(s["item_id"].map(lead_time_weeks).fillna(1.0)).astype(int).clip(lower=1)
    s = s[lag >= lt]
    return s.sort_values("made_week").groupby(["item_id", "week"], as_index=False).last()


def accuracy_by_family(snapshots: pd.DataFrame, actuals: pd.DataFrame, lead_time_weeks: pd.Series,
                       family: pd.Series, intermittent: pd.Series | None = None,
                       insample: dict | None = None, column: str = "final") -> dict:
    """WAPE and bias per family at lag = lead time; MASE per intermittent item.

    actuals: (item_id, week, qty). Returns {"family": DataFrame, "mase": Series}.
    """
    f = at_lag(snapshots, lead_time_weeks)
    a = actuals.copy()
    a["week"] = pd.to_datetime(a["week"])
    m = f.merge(a, on=["item_id", "week"], how="left").fillna({"qty": 0.0})
    m["family_id"] = m["item_id"].map(family)
    fam = m.groupby("family_id").apply(
        lambda g: pd.Series({"wape": wape(g["qty"], g[column]), "bias": bias(g["qty"], g[column]),
                             "n": len(g)}), include_groups=False)
    out_mase = {}
    if intermittent is not None and insample is not None:
        for it, g in m.groupby("item_id"):
            if bool(intermittent.get(it, False)) and it in insample:
                out_mase[it] = mase(g["qty"], g[column], insample[it])
    return {"family": fam, "mase": pd.Series(out_mase, dtype=float)}


def forecast_value_added(actual, naive, statistical, final) -> dict:
    """FVA: error removed by each step. Positive = the step helped.

    fva_statistical = WAPE(naive) - WAPE(statistical)
    fva_final       = WAPE(statistical) - WAPE(final)   (campaign deltas + planner overrides)
    """
    wn, ws, wf = wape(actual, naive), wape(actual, statistical), wape(actual, final)
    return {"wape_naive": wn, "wape_statistical": ws, "wape_final": wf,
            "fva_statistical": wn - ws, "fva_final": ws - wf}


def flag_negative_override_sources(rows: pd.DataFrame, months: int = 3) -> pd.DataFrame:
    """Override sources (users) with negative value added over the last ``months`` months.

    rows: (source, week, actual, statistical, final) for weeks that carried an override.
    """
    r = rows.copy()
    r["week"] = pd.to_datetime(r["week"])
    cutoff = r["week"].max() - pd.DateOffset(months=months)
    r = r[r["week"] > cutoff]
    out = r.groupby("source").apply(
        lambda g: pd.Series({"fva_final": wape(g["actual"], g["statistical"]) - wape(g["actual"], g["final"]),
                             "n": len(g)}), include_groups=False)
    return out[out["fva_final"] < 0]
