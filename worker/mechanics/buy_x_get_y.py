"""buy_x_get_y — parameters: buy_item_rule, buy_qty, free_item, free_qty, max_per_order.

explode: one free line per multiple reached. ``free_item`` is an item id, or
"same" for the bought item. ``max_per_order`` caps the number of rewarded
multiples on one order (null/absent = no cap).
"""
import math

from ._base import (ITEM_RULE_SCHEMA, schema_errors, match_item_rule, extra_line,
                    standard_demand_effect, depth_band, free_goods_settlement, baseline_rows)

CODE = "buy_x_get_y"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "buy_item_rule": ITEM_RULE_SCHEMA,
        "buy_qty": {"type": "integer", "minimum": 1},
        "free_item": {"type": "string", "minLength": 1,
                      "description": "item id, or 'same' for the bought item"},
        "free_qty": {"type": "integer", "minimum": 1},
        # no "type": null means no cap, and the database validator (app.validate_json) has no union types
        "max_per_order": {"minimum": 1, "description": "max rewarded multiples per order; null = no cap"},
    },
    "required": ["buy_item_rule", "buy_qty", "free_item", "free_qty"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    errs = schema_errors(PARAM_SCHEMA, params)
    cap = params.get("max_per_order") if isinstance(params, dict) else None
    if cap is not None and (isinstance(cap, bool) or not isinstance(cap, (int, float)) or cap != int(cap)):
        errs.append("max_per_order: expected a whole number or null")
    return errs


def prior_band(params: dict) -> str:
    """Depth band of the library prior: free share of the delivered quantity."""
    return depth_band(100.0 * params["free_qty"] / (params["buy_qty"] + params["free_qty"]))


def free_units(qty: float, params: dict) -> int:
    multiples = math.floor(float(qty) / params["buy_qty"] + 1e-9)
    cap = params.get("max_per_order")
    if cap is not None:
        multiples = min(multiples, cap)
    return max(0, multiples) * params["free_qty"]


def explode(order_line: dict, params: dict) -> list[dict]:
    if order_line.get("line_type", "paid") != "paid":
        return []
    if not match_item_rule(params["buy_item_rule"], order_line):
        return []
    n = free_units(order_line["qty"], params)
    if n <= 0:
        return []
    item = order_line["item_id"] if params["free_item"] == "same" else params["free_item"]
    return [extra_line(item, n, "free", order_line.get("id"))]


def demand_effect(baseline, scope, params, library) -> list[dict]:
    """Paid uplift from the library prior, plus the free units as consumption.

    Free goods count as consumption for replenishment (§9.3), so the expected
    free quantity (paid demand in the window x free_qty / buy_qty) is added
    as uplift on the free item; the same quantity is reported as ``free_qty``
    (the part of uplift that is free goods).
    """
    rows = standard_demand_effect(CODE, baseline, scope, library, prior_band(params))
    base = {(r["item_id"], r["week"]): r["qty"] for r in baseline_rows(baseline)}
    ratio = params["free_qty"] / params["buy_qty"]
    idx = {(r["item_id"], r["week"]): r for r in rows}
    window = set(scope.get("weeks") or [])
    share = float(scope.get("eligible_share", 1.0))
    scoped = set(scope["item_ids"]) if scope.get("item_ids") else {k[0] for k in base}
    extra = {}
    for (item, week), q in base.items():
        if week not in window or item not in scoped:
            continue
        paid = q * share + idx.get((item, week), {}).get("uplift", 0.0)     # eligible buyers only
        free_item = item if params["free_item"] == "same" else params["free_item"]
        extra[(free_item, week)] = extra.get((free_item, week), 0.0) + paid * ratio
    for (item, week), q in extra.items():
        if (item, week) in idx:
            idx[(item, week)]["uplift"] += q
            idx[(item, week)]["free_qty"] = idx[(item, week)].get("free_qty", 0.0) + q
        else:
            idx[(item, week)] = {"item_id": item, "week": week, "uplift": q, "pull_forward": 0.0,
                                 "cannibalised": 0.0, "free_qty": q,
                                 "prior_id": rows[0]["prior_id"] if rows else None}
    return [idx[k] for k in sorted(idx, key=lambda k: (str(k[0]), str(k[1])))]


def settle(campaign: dict) -> list[dict]:
    return free_goods_settlement(campaign, CODE)
