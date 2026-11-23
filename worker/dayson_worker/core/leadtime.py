"""Lead-time statistics (spec §8.4). Lead time = QC release date - order date."""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

LATEST_N = 20
MIN_RECEIPTS = 5
DEFAULT_SD_SHARE = 0.25
CHANGE_ALERT = 0.15


@dataclass
class LeadTimeStat:
    n: int
    mean_days: float
    sd_days: float
    p90_days: float
    source: str            # "measured" | "quoted"

    def as_dict(self) -> dict:
        return asdict(self)


def lead_time_stat(lead_days, quoted_days: float | None, latest_n: int = LATEST_N,
                   min_receipts: int = MIN_RECEIPTS, default_sd_share: float = DEFAULT_SD_SHARE) -> LeadTimeStat:
    """Stats from the latest ``latest_n`` receipts of one lane.

    lead_days must be ordered oldest -> newest. Below ``min_receipts`` receipts
    the quoted lead time is used with sd = 25% of the mean; p90 is then the
    normal 90th percentile of that (mean + 1.2816 sd).
    """
    x = np.asarray([d for d in lead_days if d is not None], dtype=float)[-latest_n:]
    n = int(x.size)
    if n < min_receipts:
        if quoted_days is None:
            raise ValueError("fewer than %d receipts and no quoted lead time" % min_receipts)
        mean = float(quoted_days)
        sd = default_sd_share * mean
        return LeadTimeStat(n, mean, sd, mean + 1.2815515655446004 * sd, "quoted")
    return LeadTimeStat(n, float(x.mean()), float(x.std(ddof=1)), float(np.percentile(x, 90)), "measured")


def lead_time_change(prev: LeadTimeStat | dict | None, new: LeadTimeStat | dict,
                     threshold: float = CHANGE_ALERT) -> dict | None:
    """Alert payload when mean or p90 moved by more than 15%, else None."""
    if prev is None:
        return None
    p = prev.as_dict() if isinstance(prev, LeadTimeStat) else prev
    n = new.as_dict() if isinstance(new, LeadTimeStat) else new
    out = {}
    for k in ("mean_days", "p90_days"):
        if p.get(k):
            ch = (n[k] - p[k]) / p[k]
            if abs(ch) > threshold:
                out[k] = {"old": p[k], "new": n[k], "change": ch}
    return out or None


def stock_impact_of_change(d_week: float, sd_d_week: float, z: float, old: dict, new: dict) -> dict:
    """Change in safety stock and reorder point caused by a lead-time change (shown with the alert)."""
    from .policy import safety_stock
    o_l, o_sd = old["mean_days"] / 7.0, old["sd_days"] / 7.0
    n_l, n_sd = new["mean_days"] / 7.0, new["sd_days"] / 7.0
    ss_o = safety_stock(d_week, sd_d_week, o_l, o_sd, z)
    ss_n = safety_stock(d_week, sd_d_week, n_l, n_sd, z)
    return {"ss_old": ss_o, "ss_new": ss_n, "ss_delta": ss_n - ss_o,
            "rop_delta": d_week * (n_l - o_l) + ss_n - ss_o}
