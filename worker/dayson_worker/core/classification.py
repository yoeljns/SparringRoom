"""Classification (spec §8.2): ABC, XYZ, demand pattern, criticality, service level."""
from __future__ import annotations

import numpy as np
import pandas as pd

ABC_CUTS = (0.80, 0.95)          # A to 80% of value, B next 15%, C last 5%
XYZ_CUTS = (0.5, 1.0)            # X below 0.5, Y 0.5 to 1.0, Z above 1.0
ADI_CUT = 1.32
CV2_CUT = 0.49
SERVICE_MATRIX = {                # stored in planning_param and editable
    ("A", "X"): 0.98, ("A", "Y"): 0.975, ("A", "Z"): 0.95,
    ("B", "X"): 0.97, ("B", "Y"): 0.95, ("B", "Z"): 0.93,
    ("C", "X"): 0.95, ("C", "Y"): 0.92, ("C", "Z"): 0.90,
}
_STEP_UP = {"C": "B", "B": "A", "A": "A"}


def abc_classes(value: pd.Series, cuts=ABC_CUTS) -> pd.Series:
    """ABC by share of trailing-12-month consumption value.

    Items are ranked by value; an item is A while the cumulative share BEFORE
    it is below 80%, B while below 95%, else C (so the item that crosses the
    80% line is still A). Items with no value are C.
    """
    v = value.fillna(0.0).clip(lower=0.0).astype(float)
    order = v.sort_values(ascending=False, kind="mergesort")
    total = order.sum()
    if total <= 0:
        return pd.Series("C", index=value.index)
    before = (order.cumsum() - order) / total
    cls = np.where(before < cuts[0] - 1e-12, "A", np.where(before < cuts[1] - 1e-12, "B", "C"))
    cls = np.where(order.values <= 0, "C", cls)
    return pd.Series(cls, index=order.index).reindex(value.index)


def xyz_class(cv: float, cuts=XYZ_CUTS) -> str:
    if not np.isfinite(cv):
        return "Z"
    return "X" if cv < cuts[0] else ("Y" if cv <= cuts[1] else "Z")


def adi_cv2(series) -> tuple[float, float]:
    """ADI and CV² of one weekly series.

    ADI = periods (counted from the first demand) / periods with demand;
    CV² = (sd / mean)² of the non-zero demand sizes (population sd).
    """
    y = np.asarray(series, dtype=float)
    nz = np.flatnonzero(y > 0)
    if nz.size == 0:
        return float("inf"), 0.0
    y = y[nz[0]:]
    sizes = y[y > 0]
    adi = y.size / sizes.size
    cv2 = float((sizes.std() / sizes.mean()) ** 2) if sizes.size > 1 else 0.0
    return float(adi), cv2


def pattern(adi: float, cv2: float) -> str:
    if adi < ADI_CUT:
        return "smooth" if cv2 < CV2_CUT else "erratic"
    return "intermittent" if cv2 < CV2_CUT else "lumpy"


def service_level(abc: str, xyz: str, critical: bool = False, matrix=None) -> float:
    """Service level from the class matrix; criticality raises the ABC class one step."""
    matrix = matrix or SERVICE_MATRIX
    if critical:
        abc = _STEP_UP[abc]
    return float(matrix[(abc, xyz)])


def monthly_from_weekly(weekly: pd.DataFrame) -> pd.DataFrame:
    """Sum weekly columns (week-start dates) into calendar months."""
    months = pd.PeriodIndex(pd.to_datetime(weekly.columns), freq="M")
    return weekly.T.groupby(months).sum().T


def classify(weekly: pd.DataFrame, unit_price: pd.Series | float = 1.0,
             weekly_free: pd.DataFrame | None = None, unit_cost: pd.Series | float | None = None,
             critical: pd.Series | None = None, matrix=None,
             pattern_weeks: int | None = None, abc_cuts=ABC_CUTS, xyz_cuts=XYZ_CUTS,
             adi_cut: float = ADI_CUT, cv2_cut: float = CV2_CUT) -> pd.DataFrame:
    """Classify every item.

    weekly      : items x weeks (week-start dates ascending) of PAID quantity
    weekly_free : same shape, free-goods quantity (valued at cost for ABC)
    critical    : bool per item (export contract item, launch item, bought by most A dealers)
    Returns one row per item: abc, xyz, pattern, adi, cv2, cv_monthly, value_12m,
    criticality, service_level, weeks_history, weeks_since_last_demand, mean_interval.
    """
    weekly = weekly.sort_index(axis=1).fillna(0.0)
    free = (weekly_free.reindex_like(weekly).fillna(0.0) if weekly_free is not None
            else pd.DataFrame(0.0, index=weekly.index, columns=weekly.columns))
    total = weekly + free
    idx = weekly.index

    def as_series(x, default):
        if x is None:
            x = default
        if np.isscalar(x):
            return pd.Series(float(x), index=idx)
        return x.reindex(idx).astype(float)

    price = as_series(unit_price, 1.0)
    cost = as_series(unit_cost, price).fillna(price)

    # ABC: trailing 12 months = last 52 weekly buckets; free goods at cost
    last52 = slice(-52, None)
    value = weekly.iloc[:, last52].sum(axis=1) * price.fillna(0) + free.iloc[:, last52].sum(axis=1) * cost.fillna(0)
    abc = abc_classes(value, abc_cuts)

    # XYZ: CV of monthly demand over the last 12 complete calendar months
    monthly = monthly_from_weekly(total)
    last_week = pd.Timestamp(total.columns[-1])
    if (last_week + pd.Timedelta(days=7)).to_period("M") == last_week.to_period("M"):
        monthly = monthly.iloc[:, :-1]            # drop the incomplete current month
    monthly = monthly.iloc[:, -12:]
    m_mean = monthly.mean(axis=1)
    cv_m = (monthly.std(axis=1, ddof=0) / m_mean).where(m_mean > 0, np.inf)
    xyz = cv_m.map(lambda v: xyz_class(v, xyz_cuts))

    # pattern: weekly ADI and CV² (vectorised adi_cv2)
    y = total.iloc[:, -pattern_weeks:] if pattern_weeks else total
    a = y.to_numpy(dtype=float)
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
        var_sz = np.where(n_pos > 0, (np.where(pos, (a - mean_sz[:, None]) ** 2, 0.0)).sum(axis=1)
                          / np.maximum(n_pos, 1), 0.0)
        cv2 = np.where(mean_sz > 0, var_sz / np.maximum(mean_sz, 1e-12) ** 2, 0.0)
    pat = np.where(adi < adi_cut, np.where(cv2 < cv2_cut, "smooth", "erratic"),
                   np.where(cv2 < cv2_cut, "intermittent", "lumpy"))
    crit = (critical.reindex(idx).fillna(False).astype(bool) if critical is not None
            else pd.Series(False, index=idx))
    out = pd.DataFrame({
        "abc": abc, "xyz": xyz, "pattern": pat, "adi": adi, "cv2": cv2, "cv_monthly": cv_m,
        "value_12m": value, "criticality": crit,
        "weeks_history": n_hist, "weeks_since_last_demand": np.where(any_pos, n_w - 1 - last, n_w),
        "mean_interval": adi,
    }, index=idx)
    out["service_level"] = [service_level(a_, x_, c_, matrix)
                            for a_, x_, c_ in zip(out["abc"], out["xyz"], out["criticality"])]
    return out
