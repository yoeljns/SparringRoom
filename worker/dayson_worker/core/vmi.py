"""Vendor-managed replenishment pilot (spec §10.4, phase 5).

Min and max per dealer and item from the dealer's sell-through, reusing the
periodic-review formula of §8.5 with dealer demand and delivery lead time;
an order proposal is generated from each rep count.
"""
from __future__ import annotations

import math

from .policy import periodic_policy, safety_stock, z_for_service_level, round_up


def min_max(d_week: float, sd_d_week: float, delivery_lt_weeks: float, sd_lt_weeks: float,
            review_weeks: float, service_level: float, unit: float = 1.0) -> dict:
    """max = S of the periodic formula; min = d x L + safety stock over the lead time."""
    z = z_for_service_level(service_level)
    p = periodic_policy(d_week, sd_d_week, delivery_lt_weeks, sd_lt_weeks, review_weeks, z, unit)
    ss_l = round_up(safety_stock(d_week, sd_d_week, delivery_lt_weeks, sd_lt_weeks, z), unit)
    return {"min": d_week * delivery_lt_weeks + ss_l, "max": p["order_up_to"], "z": z,
            "d": d_week, "sd_d": sd_d_week, "L": delivery_lt_weeks, "sd_L": sd_lt_weeks,
            "R": review_weeks, "service_level": service_level}


def proposal_from_count(counted_qty: float, in_transit: float, mm: dict, pack_multiple: float = 1.0) -> dict | None:
    """Order proposal generated from a rep count: top up to max, in whole packs.

    Nothing is proposed while counted + in transit is at or above max. The
    dealer approves with one tap; the proposal is never auto-ordered.
    """
    position = counted_qty + in_transit
    need = mm["max"] - position
    if need <= 1e-9:
        return None
    qty = math.ceil(need / pack_multiple - 1e-9) * pack_multiple if pack_multiple > 0 else need
    return {"qty": qty, "below_min": position < mm["min"],
            "inputs": {"counted_qty": counted_qty, "in_transit": in_transit, **mm,
                       "pack_multiple": pack_multiple}}
