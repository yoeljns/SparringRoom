"""gift_item — parameters: threshold_eur or threshold_qty, gift_item, qty.

explode: one free line of a non-sellable item when the order reaches the
threshold. The threshold is tested against ``order_total_eur`` /
``order_total_qty`` when the caller supplies them, else against the line
itself. To add the gift once per order, call explode on one line per order
(lines with ``order_anchor = False`` are skipped).
"""
from ._base import schema_errors, extra_line, standard_demand_effect, free_goods_settlement

CODE = "gift_item"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        # no "type": null means "not used" (order entry sends null for the unused threshold)
        "threshold_eur": {"exclusiveMinimum": 0},
        "threshold_qty": {"exclusiveMinimum": 0},
        "gift_item": {"type": "string", "minLength": 1},
        "qty": {"type": "integer", "minimum": 1},
    },
    "required": ["gift_item", "qty"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    """Schema plus the rule the database validator cannot express: exactly one threshold."""
    errs = schema_errors(PARAM_SCHEMA, params)
    if isinstance(params, dict):
        given = [k for k in ("threshold_eur", "threshold_qty") if params.get(k) is not None]
        for k in given:
            if isinstance(params[k], bool) or not isinstance(params[k], (int, float)):
                errs.append(f"{k}: expected a number")
        if len(given) != 1:
            errs.append("exactly one of threshold_eur and threshold_qty is required")
    return errs


def prior_band(params: dict) -> str:
    return "gift"


def reached(order_line: dict, params: dict) -> bool:
    if params.get("threshold_eur") is not None:
        total = order_line.get("order_total_eur")
        if total is None:
            total = float(order_line.get("qty", 0)) * float(order_line.get("unit_price", 0) or 0)
        return total >= params["threshold_eur"]
    total = order_line.get("order_total_qty", order_line.get("qty", 0))
    return total >= params["threshold_qty"]


def explode(order_line: dict, params: dict) -> list[dict]:
    if order_line.get("order_anchor", True) is False or order_line.get("line_type", "paid") != "paid":
        return []
    if not reached(order_line, params):
        return []
    return [extra_line(params["gift_item"], params["qty"], "free", order_line.get("id"))]


def demand_effect(baseline, scope, params, library) -> list[dict]:
    """Library uplift on the scoped items, plus gift consumption.

    Gift demand = scope['expected_orders'] per window week (dict week -> orders
    expected to reach the threshold) x qty, on the gift item.
    """
    rows = standard_demand_effect(CODE, baseline, scope, library, prior_band(params))
    prior_id = rows[0]["prior_id"] if rows else None
    for week, orders in sorted((scope.get("expected_orders") or {}).items(), key=lambda kv: str(kv[0])):
        rows.append({"item_id": params["gift_item"], "week": week, "uplift": orders * params["qty"],
                     "pull_forward": 0.0, "cannibalised": 0.0, "free_qty": orders * params["qty"],
                     "prior_id": prior_id})
    return rows


def settle(campaign: dict) -> list[dict]:
    return free_goods_settlement(campaign, CODE)
