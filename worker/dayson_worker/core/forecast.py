"""Forecasting (spec §8.3): method routing, baseline forecasts, MinT reconciliation.

Library path: statsforecast (SimpleExponentialSmoothingOptimized, Holt,
HoltWinters season 52/12, CrostonSBA, TSB) for the statistical baselines and
hierarchicalforecast (MinTrace) for reconciliation.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .classification import ADI_CUT, CV2_CUT

H_WEEKS = 26          # weekly buckets per SKU
H_MONTHS = 18         # monthly buckets per family
SEASON_WEEKS = 52
TWO_YEARS_WEEKS = 104
LAUNCH_SWITCH_WEEKS = 26
MIN_STAT_WEEKS = 6    # below this a non-launch series gets its plain mean
WEEK_FREQ = "W-MON"   # weeks are identified by their Monday

STAT_METHODS = ("ses_holt", "holt_winters", "sba", "tsb", "mean")


# ----------------------------------------------------------------- routing
def route_method(pattern: str, weeks_history: int, lifecycle: str | None = None,
                 export_contract: bool = False, weeks_since_last_demand: float = 0,
                 mean_interval: float = 1.0) -> str:
    """Forecast method for one series (table in §8.3).

    export contract            -> "contract_schedule" (the schedule is the demand)
    launch, < 26 weeks history -> "launch_analog"
    intermittent / lumpy       -> "sba"; "tsb" when no demand for twice the usual interval
    smooth, 2+ years           -> "holt_winters"
    smooth, under 2 years      -> "ses_holt" (SES or Holt, chosen by error)
    Erratic series (not named in the table) follow the smooth rows.
    """
    if export_contract:
        return "contract_schedule"
    if lifecycle == "launch" and weeks_history < LAUNCH_SWITCH_WEEKS:
        return "launch_analog"
    if weeks_history <= 0:
        return "zero"
    if pattern in ("intermittent", "lumpy"):
        if np.isfinite(mean_interval) and weeks_since_last_demand >= 2 * mean_interval:
            return "tsb"
        return "sba"
    if weeks_history < MIN_STAT_WEEKS:
        return "mean"
    return "holt_winters" if weeks_history >= TWO_YEARS_WEEKS else "ses_holt"


def series_stats(wide: pd.DataFrame) -> pd.DataFrame:
    """Per-row ADI, CV², pattern, history length and recency for a nodes x weeks matrix."""
    a = wide.to_numpy(dtype=float)
    n_w = a.shape[1]
    pos = a > 0
    any_pos = pos.any(axis=1)
    first = np.where(any_pos, pos.argmax(axis=1), n_w)
    last = np.where(any_pos, n_w - 1 - pos[:, ::-1].argmax(axis=1), -1)
    n_hist = n_w - first
    n_pos = pos.sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        adi = np.where(n_pos > 0, n_hist / np.maximum(n_pos, 1), np.inf)
        mean_sz = np.where(n_pos > 0, a.sum(axis=1) / np.maximum(n_pos, 1), 0.0)
        var_sz = np.where(pos, (a - mean_sz[:, None]) ** 2, 0.0).sum(axis=1) / np.maximum(n_pos, 1)
        cv2 = np.where(mean_sz > 0, var_sz / np.maximum(mean_sz, 1e-12) ** 2, 0.0)
    pat = np.where(adi < ADI_CUT, np.where(cv2 < CV2_CUT, "smooth", "erratic"),
                   np.where(cv2 < CV2_CUT, "intermittent", "lumpy"))
    return pd.DataFrame({"first_idx": first, "weeks_history": n_hist, "adi": adi, "cv2": cv2,
                         "pattern": pat, "weeks_since_last_demand": np.where(any_pos, n_w - 1 - last, n_w),
                         "mean_interval": adi}, index=wide.index)


# ------------------------------------------------------ statistical baselines
def _long_from_wide(wide: pd.DataFrame, first_idx: pd.Series) -> pd.DataFrame:
    """Dense long frame (unique_id, ds, y), each series trimmed to start at its first demand."""
    a = wide.to_numpy(dtype=float)
    n, t = a.shape
    cols = pd.to_datetime(wide.columns)
    keep = np.arange(t)[None, :] >= first_idx.to_numpy()[:, None]
    r, c = np.nonzero(keep)
    return pd.DataFrame({"unique_id": wide.index.to_numpy()[r], "ds": cols.to_numpy()[c], "y": a[r, c]})


def statistical_forecast(wide: pd.DataFrame, routes: pd.Series, h: int = H_WEEKS,
                         freq: str = WEEK_FREQ, season_length: int = SEASON_WEEKS,
                         n_jobs: int = 1, tsb_alpha_d: float = 0.2, tsb_alpha_p: float = 0.1,
                         first_idx: pd.Series | None = None) -> tuple[pd.DataFrame, pd.Series]:
    """Run the statistical methods on a (series x periods) matrix.

    routes: series id -> one of STAT_METHODS. Returns (forecast matrix series x h,
    method actually used per series — "ses" or "holt" for the ses_holt route).
    """
    from statsforecast import StatsForecast
    from statsforecast.models import (SimpleExponentialSmoothingOptimized, Holt, HoltWinters,
                                      CrostonSBA, TSB)
    cols = pd.to_datetime(wide.columns)
    future = pd.date_range(cols[-1], periods=h + 1, freq=freq)[1:]
    out = pd.DataFrame(0.0, index=wide.index, columns=future)
    used = routes.reindex(wide.index).copy()
    if first_idx is None:
        first_idx = series_stats(wide)["first_idx"]
    first_idx = first_idx.reindex(wide.index)

    def run(ids, models, fitted=False):
        long = _long_from_wide(wide.loc[ids], first_idx.loc[ids])
        sf = StatsForecast(models=models, freq=freq, n_jobs=n_jobs if len(ids) > 200 else 1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fc = sf.forecast(df=long, h=h, fitted=fitted)
            fit = sf.forecast_fitted_values() if fitted else None
        return fc, fit

    def put(ids, fc, col):
        m = fc.pivot(index="unique_id", columns="ds", values=col).reindex(ids)
        out.loc[ids] = m.to_numpy()

    ids = used.index[used == "mean"]
    if len(ids):
        a = wide.loc[ids].to_numpy(float)
        fi = first_idx.loc[ids].to_numpy()
        n = np.maximum(a.shape[1] - fi, 1)
        out.loc[ids] = np.repeat((a.sum(axis=1) / n)[:, None], h, axis=1)

    ids = used.index[used == "ses_holt"]
    if len(ids):
        fc, fit = run(ids, [SimpleExponentialSmoothingOptimized(alias="ses"), Holt(alias="holt")], fitted=True)
        err = fit.assign(e_ses=(fit["y"] - fit["ses"]).abs(), e_holt=(fit["y"] - fit["holt"]).abs()) \
                 .groupby("unique_id")[["e_ses", "e_holt"]].mean().reindex(ids)
        pick_holt = (err["e_holt"] < err["e_ses"]).fillna(False)
        m_ses = fc.pivot(index="unique_id", columns="ds", values="ses").reindex(ids).to_numpy()
        m_holt = fc.pivot(index="unique_id", columns="ds", values="holt").reindex(ids).to_numpy()
        bad = ~np.isfinite(m_holt).all(axis=1)
        pick = pick_holt.to_numpy() & ~bad
        out.loc[ids] = np.where(pick[:, None], m_holt, m_ses)
        used.loc[ids] = np.where(pick, "holt", "ses")

    for route, models, col in (
        ("holt_winters", [HoltWinters(season_length=season_length, error_type="A", alias="hw")], "hw"),
        ("sba", [CrostonSBA(alias="sba")], "sba"),
        ("tsb", [TSB(alpha_d=tsb_alpha_d, alpha_p=tsb_alpha_p, alias="tsb")], "tsb"),
    ):
        ids = used.index[used == route]
        if len(ids):
            fc, _ = run(ids, models)
            put(ids, fc, col)

    arr = out.to_numpy()
    bad_rows = ~np.isfinite(arr).all(axis=1)
    if bad_rows.any():                       # numerical failure: fall back to the trailing mean
        tail = wide.iloc[:, -min(13, wide.shape[1]):].mean(axis=1).to_numpy()
        arr[bad_rows] = tail[bad_rows, None]
        used.iloc[np.flatnonzero(bad_rows)] = "mean"
    out.iloc[:, :] = np.clip(arr, 0.0, None)
    return out, used


def naive_forecast(wide: pd.DataFrame, h: int = H_WEEKS, freq: str = WEEK_FREQ) -> pd.DataFrame:
    """Naive benchmark for forecast value added: the last observed value, repeated."""
    future = pd.date_range(pd.to_datetime(wide.columns)[-1], periods=h + 1, freq=freq)[1:]
    return pd.DataFrame(np.repeat(wide.iloc[:, [-1]].to_numpy(float), h, axis=1),
                        index=wide.index, columns=future)


# ------------------------------------------------------------ special routes
def launch_analog_forecast(analog_history, weeks_since_launch: int, h: int = H_WEEKS,
                           scale: float = 1.0, manual_plan: dict | None = None) -> np.ndarray:
    """Launch curve: the analog SKU's demand at the same age, scaled, plus the manual plan.

    analog_history : the named similar SKU's weekly demand starting at ITS first demand week
    manual_plan    : {horizon step (0-based): qty} added on top (planner's launch plan)
    Beyond the analog's history the mean of its last 8 weeks is used.
    """
    a = np.asarray(analog_history if analog_history is not None else [], dtype=float)
    tail = float(a[-8:].mean()) if a.size else 0.0
    curve = np.array([a[weeks_since_launch + k] if weeks_since_launch + k < a.size else tail
                      for k in range(h)], dtype=float) * scale
    for k, q in (manual_plan or {}).items():
        if 0 <= int(k) < h:
            curve[int(k)] += float(q)
    return np.clip(curve, 0.0, None)


def contract_schedule_forecast(schedule, weeks) -> np.ndarray:
    """Export contracts: no forecast; the contract schedule ({week: qty} or rows) is the demand."""
    if isinstance(schedule, dict):
        items = schedule.items()
    else:
        items = schedule or []
    by_week: dict = {}
    for w, q in items:
        w = pd.Timestamp(w)
        by_week[w] = by_week.get(w, 0.0) + float(q)
    return np.array([by_week.get(pd.Timestamp(w), 0.0) for w in weeks], dtype=float)


# ------------------------------------------------------------ reconciliation
def reconcile_mint(y_hat: pd.DataFrame, S_df: pd.DataFrame, tags: dict,
                   method: str = "wls_struct") -> pd.DataFrame:
    """MinT reconciliation of a (nodes x periods) base-forecast matrix.

    Uses hierarchicalforecast.MinTrace. Bottom-level negatives are then clipped
    to zero and every aggregate is recomputed as S @ bottom, so the result is
    coherent (levels add up) and non-negative.
    """
    from hierarchicalforecast.core import HierarchicalReconciliation
    from hierarchicalforecast.methods import MinTrace
    ids = S_df["unique_id"].to_numpy()
    yh = y_hat.reindex(ids)
    long = pd.DataFrame({"unique_id": np.repeat(ids, yh.shape[1]),
                         "ds": np.tile(pd.to_datetime(yh.columns), len(ids)),
                         "base": yh.to_numpy(float).ravel()})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rec = HierarchicalReconciliation([MinTrace(method=method)]).reconcile(
            Y_hat_df=long, S_df=S_df, tags=tags)
    col = [c for c in rec.columns if c.startswith("base/")][0]
    r = rec.pivot(index="unique_id", columns="ds", values=col).reindex(ids)
    return make_coherent(r, S_df)


def make_coherent(matrix: pd.DataFrame, S_df: pd.DataFrame) -> pd.DataFrame:
    """Clip the bottom rows at zero and rebuild all rows as S @ bottom."""
    ids = S_df["unique_id"].to_numpy()
    bottom_ids = [c for c in S_df.columns if c != "unique_id"]
    S = S_df[bottom_ids].to_numpy(float)
    b = np.clip(matrix.reindex(bottom_ids).to_numpy(float), 0.0, None)
    return pd.DataFrame(S @ b, index=ids, columns=matrix.columns)


# ------------------------------------------------------------------ pipeline
def build_hierarchy(history: pd.DataFrame, items: pd.DataFrame, by_market: bool = False):
    """Aggregate item-level weekly history to every hierarchy node.

    history : long (item_id, week, qty[, market_id])
    items   : index item_id; columns family_id, group_id (colour or size group)
    Levels: total -> family -> group -> SKU, plus total/market and the
    SKU x market bottom level when ``by_market``.
    Returns (Y_df long, S_df, tags, node table) from hierarchicalforecast.aggregate.
    """
    from hierarchicalforecast.utils import aggregate
    df = history.rename(columns={"week": "ds", "qty": "y"}).copy()
    df["ds"] = pd.to_datetime(df["ds"])
    df["item"] = df["item_id"].astype(str)
    df["family"] = df["item_id"].map(items["family_id"]).astype(str)
    df["group"] = df["item_id"].map(items["group_id"]).astype(str)
    df["total"] = "total"
    spec = [["total"], ["total", "family"], ["total", "family", "group"],
            ["total", "family", "group", "item"]]
    if by_market:
        df["market"] = df["market_id"].astype(str)
        spec = [["total"], ["total", "market"], ["total", "family"], ["total", "family", "group"],
                ["total", "family", "group", "item"], ["total", "market", "family", "group", "item"]]
    cols = spec[-1]
    df = df.groupby(cols + ["ds"], as_index=False)["y"].sum()
    Y_df, S_df, tags = aggregate(df, spec)
    level_of = {}
    for lvl, ids in tags.items():
        for i in ids:
            level_of[i] = lvl.split("/")[-1] if "/" in lvl else lvl
    bottom_level = "/".join(spec[-1])
    nodes = pd.DataFrame({"level": pd.Series(level_of)})
    nodes["is_bottom"] = nodes.index.isin(tags[bottom_level])
    nodes["item_id"] = np.where(nodes["level"] == "item", nodes.index.str.split("/").str[-1], None)
    nodes["market_id"] = np.where(nodes.index.isin(tags.get("total/market", [])) | (nodes["is_bottom"] & by_market),
                                  nodes.index.str.split("/").str[1], None)
    nodes["family_id"] = None
    fam_ids = list(tags["total/family"]) + list(tags["total/family/group"]) + list(tags["total/family/group/item"])
    nodes.loc[fam_ids, "family_id"] = pd.Index(fam_ids).str.split("/").str[1]
    if by_market:
        b = list(tags[bottom_level])
        nodes.loc[b, "family_id"] = pd.Index(b).str.split("/").str[2]
    return Y_df, S_df, tags, nodes


def run_forecast(history: pd.DataFrame, items: pd.DataFrame, as_of_week,
                 campaign_delta: pd.DataFrame | None = None, overrides: pd.DataFrame | None = None,
                 contract_schedules: dict | None = None, manual_plans: dict | None = None,
                 h: int = H_WEEKS, by_market: bool = False, reconcile: str | None = "wls_struct",
                 n_jobs: int = 1) -> dict:
    """Baseline per SKU, campaign deltas, hierarchy reconciliation (§8.1 step 4).

    history  : long (item_id, week, qty[, market_id]); weeks are Mondays, strictly before as_of_week
    items    : index item_id (str); columns family_id, group_id and optional
               lifecycle, export_contract, analog_item_id, analog_scale
    campaign_delta / overrides : long (item_id, week, delta[, market_id]) — bottom-level deltas
    contract_schedules : {item_id: {week: qty}}; manual_plans : {item_id: {step: qty}}
    Returns {"forecast": long (node, level, item_id, market_id, family_id, week,
             base_raw, base, campaign_delta, override_delta, final, method),
             "nodes", "S_df", "tags", "wide_history"}.
    final = base + campaign_delta + override_delta at every node (floored at zero
    on the bottom level, aggregates re-summed), so all four columns add up the hierarchy.
    """
    items = items.copy()
    items.index = items.index.astype(str)
    hist = history.copy()
    hist["item_id"] = hist["item_id"].astype(str)
    hist["week"] = pd.to_datetime(hist["week"])
    as_of_week = pd.Timestamp(as_of_week)
    hist = hist[hist["week"] < as_of_week]
    Y_df, S_df, tags, nodes = build_hierarchy(hist, items, by_market)
    weeks = pd.date_range(hist["week"].min(), as_of_week - pd.Timedelta(days=7), freq=WEEK_FREQ)
    wide = Y_df.pivot(index="unique_id", columns="ds", values="y").reindex(
        index=S_df["unique_id"], columns=weeks).fillna(0.0)
    future = pd.date_range(as_of_week, periods=h, freq=WEEK_FREQ)
    stats = series_stats(wide)

    def item_attr(name, default):
        if name not in items.columns:
            return pd.Series(default, index=nodes.index)
        return nodes["item_id"].map(items[name]).where(nodes["item_id"].notna(), default).fillna(default)

    lifecycle = item_attr("lifecycle", None)
    export = item_attr("export_contract", False).astype(bool)
    is_sku = nodes["level"].eq("item").reindex(wide.index)
    routes = pd.Series([
        route_method(p, int(n), lc if sku else None, bool(ex) and sku, wsl, mi)
        for p, n, lc, ex, sku, wsl, mi in zip(stats["pattern"], stats["weeks_history"],
                                               lifecycle.reindex(wide.index), export.reindex(wide.index),
                                               is_sku, stats["weeks_since_last_demand"], stats["mean_interval"])
    ], index=wide.index)

    base = pd.DataFrame(0.0, index=wide.index, columns=future)
    method = routes.copy()
    stat_ids = routes.index[routes.isin(STAT_METHODS)]
    if len(stat_ids):
        fc, used = statistical_forecast(wide.loc[stat_ids], routes.loc[stat_ids], h=h, n_jobs=n_jobs,
                                        first_idx=stats["first_idx"].loc[stat_ids])
        base.loc[stat_ids] = fc.to_numpy()
        method.loc[stat_ids] = used
    item_wide = None
    for nid in routes.index[routes == "launch_analog"]:
        it = nodes.at[nid, "item_id"]
        analog = items.at[it, "analog_item_id"] if "analog_item_id" in items.columns else None
        scale = float(items.at[it, "analog_scale"]) if "analog_scale" in items.columns and pd.notna(items.at[it, "analog_scale"]) else 1.0
        a_hist = None
        if analog is not None and pd.notna(analog):
            if item_wide is None:
                item_wide = hist.groupby(["item_id", "week"])["qty"].sum().unstack(fill_value=0.0).reindex(columns=weeks, fill_value=0.0)
            if str(analog) in item_wide.index:
                a = item_wide.loc[str(analog)].to_numpy(float)
                nz = np.flatnonzero(a > 0)
                a_hist = a[nz[0]:] if nz.size else None
        base.loc[nid] = launch_analog_forecast(a_hist, int(stats.at[nid, "weeks_history"]), h, scale,
                                               (manual_plans or {}).get(it))
    for nid in routes.index[routes == "contract_schedule"]:
        base.loc[nid] = contract_schedule_forecast((contract_schedules or {}).get(nodes.at[nid, "item_id"]), future)

    base_raw = base.copy()
    base = reconcile_mint(base, S_df, tags, reconcile) if reconcile else make_coherent(base, S_df)  # None = bottom-up

    bottom_ids = [c for c in S_df.columns if c != "unique_id"]
    S = S_df[bottom_ids].to_numpy(float)
    b_base = base.reindex(bottom_ids)

    def bottom_delta(frame):
        m = pd.DataFrame(0.0, index=bottom_ids, columns=future)
        if frame is None or len(frame) == 0:
            return m
        f = frame.copy()
        f["item_id"] = f["item_id"].astype(str)
        f["week"] = pd.to_datetime(f["week"])
        f = f[f["week"].isin(future)]
        bn = nodes.loc[bottom_ids]
        by_item = {k: list(v) for k, v in bn.groupby("item_id").groups.items()} if not by_market else \
                  {k: list(v) for k, v in bn.groupby(bn.index.str.split("/").str[-1]).groups.items()}
        for r in f.itertuples(index=False):
            targets = by_item.get(r.item_id, [])
            mk = getattr(r, "market_id", None)
            if by_market and mk is not None and pd.notna(mk):
                targets = [t for t in targets if t.split("/")[1] == str(mk)]
            if not targets:
                continue
            w = b_base.loc[targets, r.week].to_numpy(float)
            share = w / w.sum() if w.sum() > 0 else np.full(len(targets), 1.0 / len(targets))
            m.loc[targets, r.week] += float(r.delta) * share
        return m

    b_camp = bottom_delta(campaign_delta)
    b_over = bottom_delta(overrides)
    b_final = np.clip(b_base.to_numpy(float) + b_camp.to_numpy(float) + b_over.to_numpy(float), 0.0, None)
    ids = S_df["unique_id"].to_numpy()
    mats = {"base_raw": base_raw.reindex(ids).to_numpy(float), "base": base.reindex(ids).to_numpy(float),
            "campaign_delta": S @ b_camp.to_numpy(float), "override_delta": S @ b_over.to_numpy(float),
            "final": S @ b_final}
    n, hh = len(ids), len(future)
    out = pd.DataFrame({"node": np.repeat(ids, hh), "week": np.tile(future, n)})
    for k, m in mats.items():
        out[k] = m.ravel()
    meta = nodes.reindex(ids)
    for c in ("level", "item_id", "market_id", "family_id"):
        out[c] = np.repeat(meta[c].to_numpy(), hh)
    out["is_bottom"] = np.repeat(meta["is_bottom"].to_numpy(), hh)
    out["method"] = np.repeat(method.reindex(ids).to_numpy(), hh)
    return {"forecast": out, "nodes": nodes.join(stats).assign(route=routes, method=method),
            "S_df": S_df, "tags": tags, "wide_history": wide}


def family_monthly_forecast(family_weekly: pd.DataFrame, h: int = H_MONTHS, n_jobs: int = 1) -> pd.DataFrame:
    """18 monthly buckets per family.

    family_weekly: families x weeks (Monday dates). Weeks are assigned to the
    calendar month of their Monday; an incomplete last month is dropped.
    Holt-Winters (season 12) with 24+ months, otherwise SES or Holt by error.
    Returns long (family_id, month, base, method).
    """
    cols = pd.to_datetime(family_weekly.columns)
    monthly = family_weekly.T.groupby(pd.PeriodIndex(cols, freq="M")).sum().T
    last = cols[-1]
    if (last + pd.Timedelta(days=7)).to_period("M") == last.to_period("M"):
        monthly = monthly.iloc[:, :-1]
    monthly.columns = monthly.columns.to_timestamp()
    st = series_stats(monthly)
    routes = pd.Series(np.where(st["weeks_history"] >= 24, "holt_winters",
                                np.where(st["weeks_history"] >= MIN_STAT_WEEKS, "ses_holt", "mean")),
                       index=monthly.index)
    fc, used = statistical_forecast(monthly, routes, h=h, freq="MS", season_length=12, n_jobs=n_jobs,
                                    first_idx=st["first_idx"])
    out = fc.stack().rename("base").reset_index()
    out.columns = ["family_id", "month", "base"]
    out["method"] = out["family_id"].map(used)
    return out
