"""Dealer-owned stock estimate (spec §10.2) and how estimates are used (§10.3)."""
from __future__ import annotations

import math
from datetime import date

SOURCE_WEIGHT = {"observed_count": 1.0, "rep_visual": 0.7, "self_report": 0.6,
                 "inferred": 0.4, "unknown": 0.0}
# dealer_stock_observation.source -> estimate method
SOURCE_TO_METHOD = {"count": "observed_count", "rep_visual": "rep_visual", "self_report": "self_report"}
HALF_LIFE_DAYS = 45.0      # starting value in planning_param
USABLE = 0.5
MIN_SELL_IN_WEEKS = 8
CHANNEL_LOADING_COVER_WEEKS = 12


def confidence(method: str, age_days: float, half_life_days: float = HALF_LIFE_DAYS,
               weights: dict | None = None) -> float:
    """Confidence = source weight x 0.5 ^ (age in days / 45)."""
    w = (weights or SOURCE_WEIGHT)[method]
    return w * 0.5 ** (max(age_days, 0.0) / half_life_days)


def usable_days(method: str, half_life_days: float = HALF_LIFE_DAYS, threshold: float = USABLE,
                weights: dict | None = None) -> float:
    """Days an observation stays at or above the threshold; -inf if it never reaches it."""
    w = (weights or SOURCE_WEIGHT)[method]
    if w < threshold or w <= 0:
        return float("-inf")
    return half_life_days * math.log2(w / threshold)


def estimate_dealer_stock(observations: list[dict], as_of: date, sell_in_since: float = 0.0,
                          weekly_sell_through: float | None = None, sell_in_weeks: float = 0.0,
                          half_life_days: float = HALF_LIFE_DAYS, weights: dict | None = None,
                          threshold: float = USABLE) -> dict:
    """One dealer_stock_estimate row, choosing the best available method.

    observations : [{"qty", "source" in (count, rep_visual, self_report), "observed_at": date}]
    sell_in_since: units shipped to the dealer since the observation chosen as the base
                   (the caller sums sell-in after ``base_observed_at``; pass 0 and use
                   ``base_observation`` first if needed)
    weekly_sell_through : modelled dealer sell-through per week; sell_in_weeks : weeks of sell-in history

    Rule: the direct observation with the highest current confidence is used
    while that confidence is still usable (>= 0.5). Otherwise the estimate is
    inferred — last observation + sell-in since - modelled sell-through —
    with the fixed source weight 0.4 (it is rebuilt nightly, so it does not
    age; it never reaches the threshold alone). With no observation and under
    8 weeks of sell-in the method is "unknown" with confidence 0.
    """
    best = None
    for o in observations:
        m = SOURCE_TO_METHOD[o["source"]]
        age = (as_of - o["observed_at"]).days
        if age < 0:
            continue
        c = confidence(m, age, half_life_days, weights)
        if best is None or c > best[0] + 1e-12 or (abs(c - best[0]) <= 1e-12 and o["observed_at"] > best[2]["observed_at"]):
            best = (c, m, o, age)
    if best and best[0] >= threshold:
        c, m, o, age = best
        return {"qty_est": float(o["qty"]), "method": m, "confidence": c, "as_of": as_of,
                "base_observed_at": o["observed_at"], "age_days": age}
    latest = max(observations, key=lambda o: o["observed_at"]) if observations else None
    if latest is None and sell_in_weeks < MIN_SELL_IN_WEEKS:
        return {"qty_est": None, "method": "unknown", "confidence": 0.0, "as_of": as_of,
                "base_observed_at": None, "age_days": None}
    if weekly_sell_through is None:
        if best:        # stale observation and no sell-through model: keep it, with its decayed confidence
            c, m, o, age = best
            return {"qty_est": float(o["qty"]), "method": m, "confidence": c, "as_of": as_of,
                    "base_observed_at": o["observed_at"], "age_days": age}
        return {"qty_est": None, "method": "unknown", "confidence": 0.0, "as_of": as_of,
                "base_observed_at": None, "age_days": None}
    if latest is not None:
        age = (as_of - latest["observed_at"]).days
        base_qty = float(latest["qty"])
        weeks = age / 7.0
    else:
        age, base_qty, weeks = None, 0.0, sell_in_weeks
    qty = max(0.0, base_qty + sell_in_since - weekly_sell_through * weeks)
    return {"qty_est": qty, "method": "inferred", "confidence": confidence("inferred", 0, half_life_days, weights),
            "as_of": as_of, "base_observed_at": latest["observed_at"] if latest else None, "age_days": age}


def base_observation(observations: list[dict], as_of: date):
    """The latest observation not after as_of (base for the inferred method), or None."""
    past = [o for o in observations if o["observed_at"] <= as_of]
    return max(past, key=lambda o: o["observed_at"]) if past else None


# ------------------------------------------------------------- §10.3 usage
def is_usable(estimate: dict, threshold: float = USABLE) -> bool:
    return estimate.get("qty_est") is not None and estimate.get("confidence", 0.0) >= threshold


def channel_loading_flags(estimates: list[dict], weekly_sell_through: dict,
                          max_cover_weeks: float = CHANNEL_LOADING_COVER_WEEKS) -> list[dict]:
    """Dealers whose estimated cover exceeds 12 weeks after a campaign (confidence >= 0.5 only).

    estimates: rows with party_id, item_id, qty_est, confidence; weekly_sell_through: {(party, item): units/week}.
    """
    out = []
    for e in estimates:
        if not is_usable(e):
            continue
        rate = weekly_sell_through.get((e["party_id"], e["item_id"]), 0.0)
        cover = e["qty_est"] / rate if rate > 0 else float("inf")
        if cover > max_cover_weeks:
            out.append({"party_id": e["party_id"], "item_id": e["item_id"], "cover_weeks": cover,
                        "confidence": e["confidence"]})
    return out


def review_confidence(estimates: list[dict]) -> str:
    """Campaign review: forward buying can be separated from sell-through only with usable estimates."""
    return "normal" if estimates and all(is_usable(e) for e in estimates) else "low"


def near_expiry_targets(dealers: list[dict], estimates: dict, weekly_sell_through: dict, item_id,
                        low_cover_weeks: float = 4.0, segments: tuple = ("A", "B")) -> list[dict]:
    """Who gets the amber-lot offer: dealers with low cover where the estimate is usable, else by segment.

    dealers: [{"party_id","segment"}]; estimates: {(party,item): estimate row}.
    """
    out = []
    for d in dealers:
        e = estimates.get((d["party_id"], item_id))
        if e and is_usable(e):
            rate = weekly_sell_through.get((d["party_id"], item_id), 0.0)
            cover = e["qty_est"] / rate if rate > 0 else float("inf")
            if cover < low_cover_weeks:
                out.append({"party_id": d["party_id"], "basis": "low_cover", "cover_weeks": cover})
        elif d.get("segment") in segments:
            out.append({"party_id": d["party_id"], "basis": "segment", "cover_weeks": None})
    return out


def count_requests(dealers: list[dict], estimates: dict) -> list[dict]:
    """Rep visit list: low confidence on an A dealer raises a count request for the next visit.

    estimates: {party_id: [estimate rows]}.
    """
    out = []
    for d in dealers:
        if d.get("segment") != "A":
            continue
        low = [e["item_id"] for e in estimates.get(d["party_id"], []) if not is_usable(e)]
        if low or not estimates.get(d["party_id"]):
            out.append({"party_id": d["party_id"], "item_ids": low})
    return out
