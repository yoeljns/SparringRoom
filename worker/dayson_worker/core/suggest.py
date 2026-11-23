"""Replenishment suggestions (spec §8.6).

Projected available = on hand + on order - reservations - forecast. A
suggestion is raised when it falls below ROP (continuous) or, for periodic
items, at each review date up to S. Every suggestion carries an ``inputs``
dict with every number used.

Central safety stock and reorder never use dealer stock estimates (§10.3):
nothing in this module accepts them.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import timedelta

import numpy as np


def _date(week_start, days: float):
    return week_start + timedelta(days=int(round(days)))


def suggest_for_item(*, item_id, policy: dict, forecast, week_starts, on_hand: float,
                     on_order: float = 0.0, reservations: float = 0.0, order_qty: float = 0.0,
                     lead_time_weeks: float = 0.0, review_weeks: float = 1.0, first_review_idx: int = 0,
                     order_multiple: float = 0.0, moq: float = 0.0, supply_type: str = "purchase",
                     refs: dict | None = None, horizon_weeks: int | None = None) -> list[dict]:
    """Suggestions for one item over the forecast horizon.

    policy      : output of core.policy (keys policy, rop / order_up_to, safety_stock, ...)
    forecast    : final forecast per week (same length as week_starts)
    on_order    : total open supply (purchase/production orders, inbound shipments)
    refs        : forecast_run_id, lead_time_stat_id, service_level, param_version, ... copied to inputs
    The position at the start of week w is on_hand + on_order + already
    suggested - reservations - forecast of the weeks before w.
    """
    kind = policy.get("policy")
    if kind == "to_order":
        return []
    fc = np.asarray(forecast, dtype=float)
    n = len(fc) if horizon_weeks is None else min(len(fc), horizon_weeks)
    cum_before = np.concatenate([[0.0], np.cumsum(fc)])[:n]
    start_pos = on_hand + on_order - reservations
    planned = 0.0
    out = []

    def make(w, qty, trigger, level, projected):
        release = week_starts[w]
        inputs = {
            "policy": kind, "trigger": trigger, "on_hand": on_hand, "on_order": on_order,
            "reservations": reservations, "forecast_before_release": float(cum_before[w]),
            "already_suggested": planned, "projected_available": projected,
            "rop": policy.get("rop"), "order_up_to": policy.get("order_up_to"),
            "safety_stock": policy.get("safety_stock"), "d": policy.get("d"), "sd_d": policy.get("sd_d"),
            "L": policy.get("L", lead_time_weeks), "sd_L": policy.get("sd_L"), "R": policy.get("R", review_weeks),
            "z": policy.get("z"), "service_level": policy.get("service_level"),
            "order_qty": order_qty, "order_multiple": order_multiple, "moq": moq,
            "lead_time_weeks": lead_time_weeks, "target_level": level,
        }
        inputs.update(refs or {})
        return {"item_id": item_id, "type": supply_type, "qty": qty, "release_date": release,
                "need_date": _date(release, lead_time_weeks * 7), "inputs": inputs, "state": "proposed"}

    if kind == "continuous":
        rop = float(policy["rop"])
        q = max(order_qty, moq, 0.0)
        if q <= 0:
            raise ValueError("continuous policy needs an order quantity")
        for w in range(n):
            proj = start_pos + planned - cum_before[w]
            if proj < rop:
                lots = max(1, math.ceil((rop - proj) / q - 1e-9))
                out.append(make(w, lots * q, "below_rop", rop, float(proj)))
                planned += lots * q
        return out

    # periodic and empirical: order up to S at each review date
    s_level = float(policy["order_up_to"])
    step = max(review_weeks, 1.0)
    k = 0
    while True:
        w = int(round(first_review_idx + k * step))
        if w >= n:
            break
        proj = start_pos + planned - cum_before[w]
        need = s_level - proj
        if need > 1e-9:
            qty = max(need, moq or 0.0)
            if order_multiple and order_multiple > 0:
                qty = math.ceil(qty / order_multiple - 1e-9) * order_multiple
            out.append(make(w, float(qty), "review", s_level, float(proj)))
            planned += qty
        k += 1
    return out


def price_for_qty(price_breaks, qty: float):
    """Unit price reached by a quantity. price_breaks: [{"min_qty", "price"}] (supplier_lane.price_breaks)."""
    best = None
    for b in sorted(price_breaks or [], key=lambda b: b["min_qty"]):
        if qty >= b["min_qty"]:
            best = b
    return best


def group_by_supplier(suggestions: list[dict], item_supplier: dict, lanes: dict) -> list[dict]:
    """One order per supplier per review date (abrasives), shown against MOQ and price breaks.

    item_supplier: {item_id: supplier_id}; lanes: {supplier_id: {"moq", "price_breaks"}}.
    """
    groups = defaultdict(list)
    for s in suggestions:
        sup = item_supplier.get(s["item_id"])
        if sup is not None:
            groups[(sup, s["release_date"])].append(s)
    out = []
    for (sup, release), lines in sorted(groups.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        lane = lanes.get(sup, {})
        total = sum(l["qty"] for l in lines)
        moq = float(lane.get("moq") or 0.0)
        breaks = sorted(lane.get("price_breaks") or [], key=lambda b: b["min_qty"])
        reached = price_for_qty(breaks, total)
        nxt = next((b for b in breaks if b["min_qty"] > total), None)
        out.append({
            "supplier_id": sup, "release_date": release,
            "need_date": max(l["need_date"] for l in lines),
            "lines": [{"item_id": l["item_id"], "qty": l["qty"]} for l in lines],
            "total_qty": total, "moq": moq, "moq_met": total >= moq, "moq_shortfall": max(0.0, moq - total),
            "price_break": reached, "next_price_break": nxt,
            "qty_to_next_break": (nxt["min_qty"] - total) if nxt else None,
        })
    return out


def stock_health(*, on_hand: float, weekly_forecast: float, weeks_since_last_demand: float,
                 tsb_forecast: float | None = None, amber_qty: float = 0.0, unit_cost: float = 0.0,
                 slow_cover_weeks: float = 26, obsolete_weeks: float = 52, near_zero: float = 0.05) -> dict | None:
    """Slow and expiring stock (§8.8).

    slow-moving: cover above 26 weeks; obsolete: no demand for 12 months or TSB
    forecast near zero; at risk: amber band stock. Returns None for healthy stock.
    Proposed action is a starting suggestion for the monthly list.
    """
    if on_hand <= 0:
        return None
    cover = on_hand / weekly_forecast if weekly_forecast > 0 else float("inf")
    flags = []
    if weeks_since_last_demand >= obsolete_weeks or (tsb_forecast is not None and tsb_forecast <= near_zero):
        flags.append("obsolete")
    elif cover > slow_cover_weeks:
        flags.append("slow")
    if amber_qty > 0:
        flags.append("at_risk")
    if not flags:
        return None
    if "obsolete" in flags:
        action = "supplier_return_or_scrap"
    elif "at_risk" in flags:
        action = "bundle_as_free_goods"
    else:
        action = "dealer_push"
    return {"flags": flags, "cover_weeks": cover, "value": on_hand * unit_cost,
            "amber_value": amber_qty * unit_cost, "proposed_action": action}
