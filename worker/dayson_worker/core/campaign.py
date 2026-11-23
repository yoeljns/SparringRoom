"""Campaign analytics (spec §9.4–9.6): intensity, uplift model, review, uplift library."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

K_BY_METHOD = {"eligibility": 1.0, "participation": 0.5, "no_control": 0.25}
PRE_WEEKS = 4
POST_WEEKS = 8


# ------------------------------------------------------------ §9.4 intensity
def intensity_measures(lines: pd.DataFrame, active: pd.DataFrame | None = None) -> pd.DataFrame:
    """Per item and week: the four intensity measures.

    lines : (item_id, week, qty_paid, qty_free, list_eur, net_eur, campaign_id nullable) —
            campaign_id set only for volume under a NON-standard mechanic
            (standard_terms volume is the baseline and carries no campaign).
    active: (campaign_id, item_id, week) calendar of live campaigns.
    Returns (item_id, week, discount_depth, free_ratio, campaign_share, n_campaigns).
    """
    l = lines.copy()
    l["camp_qty"] = np.where(l["campaign_id"].notna(), l["qty_paid"] + l["qty_free"], 0.0)
    g = l.groupby(["item_id", "week"], as_index=False).agg(
        qty_paid=("qty_paid", "sum"), qty_free=("qty_free", "sum"), list_eur=("list_eur", "sum"),
        net_eur=("net_eur", "sum"), camp_qty=("camp_qty", "sum"))
    tot = g["qty_paid"] + g["qty_free"]
    g["discount_depth"] = np.where(g["list_eur"] > 0, 1.0 - g["net_eur"] / g["list_eur"].where(g["list_eur"] > 0, 1), 0.0)
    g["free_ratio"] = np.where(tot > 0, g["qty_free"] / tot.where(tot > 0, 1), 0.0)
    g["campaign_share"] = np.where(tot > 0, g["camp_qty"] / tot.where(tot > 0, 1), 0.0)
    if active is not None and len(active):
        n = active.groupby(["item_id", "week"])["campaign_id"].nunique().rename("n_campaigns").reset_index()
        g = g.merge(n, on=["item_id", "week"], how="outer")
    else:
        g["n_campaigns"] = l.groupby(["item_id", "week"])["campaign_id"].nunique().values
    g = g.fillna({"discount_depth": 0.0, "free_ratio": 0.0, "campaign_share": 0.0, "n_campaigns": 0})
    g["n_campaigns"] = g["n_campaigns"].astype(int)
    return g[["item_id", "week", "discount_depth", "free_ratio", "campaign_share", "n_campaigns"]]


def combined_intensity(m: pd.DataFrame) -> pd.Series:
    """Single intensity used by the uplift model: effective depth incl. free goods, x share under campaign."""
    eff = 1.0 - (1.0 - m["discount_depth"]) * (1.0 - m["free_ratio"])
    return eff * m["campaign_share"].where(m["campaign_share"] > 0, 0.0)


# ---------------------------------------------------------- §9.4 uplift model
@dataclass
class UpliftModel:
    """weekly demand = baseline x exp(sku effect + b x intensity + lag terms + c x sister intensity)."""
    b: float
    lags: list[float]              # coefficient of intensity k weeks earlier; negative = pull-forward
    cross: float                   # coefficient of sister-SKU intensity; negative = cannibalisation
    sku_effects: dict = field(default_factory=dict)
    n_obs: int = 0
    ridge: float = 0.0

    def multiplier(self, intensity: float, lag_intensity=(), sister_intensity: float = 0.0, item_id=None) -> float:
        x = self.b * intensity + self.cross * sister_intensity + self.sku_effects.get(item_id, 0.0)
        for c, v in zip(self.lags, lag_intensity):
            x += c * v
        return float(np.exp(x))

    def predict(self, baseline: float, intensity: float, lag_intensity=(), sister_intensity: float = 0.0,
                item_id=None) -> float:
        return baseline * self.multiplier(intensity, lag_intensity, sister_intensity, item_id)


def fit_uplift_model(df: pd.DataFrame, n_lags: int = 4, ridge_sku: float = 10.0, ridge: float = 1e-6,
                     offset: float = 0.5) -> UpliftModel:
    """Fit one family's uplift model by ridge regression on log demand.

    df: (item_id, week, demand, baseline, intensity[, group_id]) — complete weekly rows per item.
    log((demand+offset)/(baseline+offset)) = sku_i + b x intensity_t + sum_k lag_k x intensity_{t-k}
                                             + c x mean intensity of sister SKUs in the group
    SKU effects are partially pooled (shrunk to zero by ridge_sku). Negative lag
    terms measure pull-forward; a negative cross term measures cannibalisation.
    """
    d = df.sort_values(["item_id", "week"]).reset_index(drop=True).copy()
    g = d.groupby("item_id")["intensity"]
    lag_cols = []
    for k in range(1, n_lags + 1):
        d[f"lag{k}"] = g.shift(k).fillna(0.0)
        lag_cols.append(f"lag{k}")
    if "group_id" in d.columns:
        grp = d.groupby(["group_id", "week"])["intensity"]
        s, n = grp.transform("sum"), grp.transform("count")
        d["sister"] = np.where(n > 1, (s - d["intensity"]) / (n - 1).where(n > 1, 1), 0.0)
    else:
        d["sister"] = 0.0
    y = np.log((d["demand"].to_numpy(float) + offset) / (d["baseline"].to_numpy(float) + offset))
    items = pd.Index(d["item_id"].unique())
    codes = items.get_indexer(d["item_id"])
    Xf = d[["intensity"] + lag_cols + ["sister"]].to_numpy(float)
    p, m = Xf.shape[1], len(items)
    X = np.zeros((len(d), p + m))
    X[:, :p] = Xf
    X[np.arange(len(d)), p + codes] = 1.0
    pen = np.concatenate([np.full(p, ridge), np.full(m, ridge_sku)])
    beta = np.linalg.solve(X.T @ X + np.diag(pen), X.T @ y)
    return UpliftModel(b=float(beta[0]), lags=[float(v) for v in beta[1:1 + n_lags]], cross=float(beta[p - 1]),
                       sku_effects={it: float(v) for it, v in zip(items, beta[p:])}, n_obs=len(d), ridge=ridge_sku)


def eligibility_uplift(elig_before: float, elig_during: float, inelig_before: float, inelig_during: float) -> float:
    """§9.4.4: eligible vs ineligible dealers of the same segment, before and during (ratio of ratios - 1)."""
    if elig_before <= 0 or inelig_before <= 0 or inelig_during <= 0:
        return float("nan")
    return (elig_during / elig_before) / (inelig_during / inelig_before) - 1.0


def estimate_method(scope_limits_eligibility: bool, has_matched_non_participants: bool) -> dict:
    """Which control is available -> estimate method, shrinkage weight k and confidence."""
    if scope_limits_eligibility:
        return {"method": "eligibility", "k": 1.0, "confidence": "normal"}
    if has_matched_non_participants:
        return {"method": "participation", "k": 0.5, "confidence": "low"}
    return {"method": "no_control", "k": 0.25, "confidence": "low"}


def is_forward_buying(sell_in_growth: float, sell_through_growth: float, tolerance: float = 0.05) -> bool:
    """§9.4.5: sell-in growth without sell-through growth is classed as forward buying."""
    return sell_in_growth > tolerance and sell_through_growth <= tolerance


# ------------------------------------------------------------ §9.5 review
def campaign_review(actual, baseline, window: tuple[int, int], sisters: list[tuple] | None = None,
                    pre_weeks: int = PRE_WEEKS, post_weeks: int = POST_WEEKS) -> dict:
    """Post-campaign review of one item.

    actual, baseline : weekly arrays on the same axis
    window           : (first index, last index) of the order window, inclusive
    sisters          : [(actual, baseline)] of sister SKUs on the same axis
    gross        = sum(actual - baseline) inside the order window
    borrowed     = sum(baseline - actual) in the 4 weeks before and 8 weeks after (not below 0)
    cannibalised = shortfall against baseline in sister SKUs during the window (per sister, not below 0)
    net          = gross - borrowed - cannibalised
    """
    a, b = np.asarray(actual, float), np.asarray(baseline, float)
    s, e = window
    gross = float((a[s:e + 1] - b[s:e + 1]).sum())
    pre = slice(max(0, s - pre_weeks), s)
    post = slice(e + 1, min(len(a), e + 1 + post_weeks))
    borrowed = max(0.0, float((b[pre] - a[pre]).sum() + (b[post] - a[post]).sum()))
    cann = 0.0
    for sa, sb in sisters or []:
        sa, sb = np.asarray(sa, float), np.asarray(sb, float)
        cann += max(0.0, float((sb[s:e + 1] - sa[s:e + 1]).sum()))
    net = gross - borrowed - cann
    return {"gross": gross, "borrowed": borrowed, "cannibalised": cann, "net": net,
            "borrow_rate": borrowed / gross if gross > 0 else None,
            "weeks_after_available": post.stop - post.start}


def review_from_totals(gross: float, borrowed: float, cannibalised: float = 0.0) -> dict:
    net = gross - borrowed - cannibalised
    return {"gross": gross, "borrowed": borrowed, "cannibalised": cannibalised, "net": net,
            "borrow_rate": borrowed / gross if gross > 0 else None}


def observed_uplift(net: float, baseline_in_window: float) -> float:
    """Observed uplift as a fraction of baseline, the unit stored in uplift_library.prior_uplift."""
    return net / baseline_in_window if baseline_in_window > 0 else float("nan")


# -------------------------------------------------------- §9.6 uplift library
def shrink_prior(prior: float, n_obs: float, observed: float, method: str | None = None,
                 k: float | None = None) -> float:
    """new_prior = (n x prior + k x observed) / (n + k).

    k = 1.0 eligibility-based, 0.5 participation-based, 0.25 without a usable control.
    """
    if k is None:
        k = K_BY_METHOD[method]
    return (n_obs * prior + k * observed) / (n_obs + k)


def update_library_row(row: dict, observed: float, method: str, campaign_id=None, as_of=None) -> dict:
    """Apply one review to an uplift_library row; keeps the last 5 observations in last_obs."""
    k = K_BY_METHOD[method]
    new = dict(row)
    new["prior_uplift"] = shrink_prior(float(row.get("prior_uplift") or 0.0), float(row.get("n_obs") or 0), observed, k=k)
    new["n_obs"] = (row.get("n_obs") or 0) + 1
    hist = list(row.get("last_obs") or [])
    hist.append({"campaign_id": campaign_id, "observed": observed, "method": method, "k": k,
                 "as_of": str(as_of) if as_of is not None else None})
    new["last_obs"] = hist[-5:]
    return new


def prior_range(row: dict) -> tuple[float, float] | None:
    """Range of the last observations (shown with the prior on the campaign draft screen)."""
    obs = [o["observed"] for o in row.get("last_obs") or []]
    return (min(obs), max(obs)) if obs else None
