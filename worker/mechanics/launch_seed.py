"""launch_seed — parameters: item, seed_qty by segment.

The spec's explode result is "suggested order lines per dealer". Those are
PAID suggestions made before any order exists, so they are not extra lines
on an order: ``explode`` returns nothing and ``suggest_lines`` produces the
per-dealer suggestions.
"""
from ._base import schema_errors

CODE = "launch_seed"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "item": {"type": "string", "minLength": 1},
        "seed_qty": {
            "type": "object",
            "description": "segment -> seed quantity per dealer",
            "minProperties": 1,
            "additionalProperties": {"type": "number", "exclusiveMinimum": 0},
        },
    },
    "required": ["item", "seed_qty"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    return schema_errors(PARAM_SCHEMA, params)


def prior_band(params: dict) -> str:
    return "seed"


def explode(order_line: dict, params: dict) -> list[dict]:
    return []


def suggest_lines(dealers: list[dict], params: dict) -> list[dict]:
    """One suggested paid order line per dealer whose segment has a seed quantity."""
    out = []
    for d in dealers:
        q = params["seed_qty"].get(d.get("segment"))
        if q:
            out.append({"party_id": d["party_id"], "item_id": params["item"], "qty": q,
                        "line_type": "paid", "parent_line_id": None})
    return out


def demand_effect(baseline, scope, params, library) -> list[dict]:
    """Seed demand = dealers per segment x seed qty, spread evenly over the order window.

    scope['dealers_by_segment'] = {segment: dealer count}. A launch item has no
    baseline, so nothing is borrowed or cannibalised here.
    """
    weeks = sorted(scope.get("weeks") or [])
    if not weeks:
        return []
    total = sum(params["seed_qty"].get(seg, 0) * n
                for seg, n in (scope.get("dealers_by_segment") or {}).items())
    return [{"item_id": params["item"], "week": w, "uplift": total / len(weeks),
             "pull_forward": 0.0, "cannibalised": 0.0, "prior_id": None} for w in weeks]


def settle(campaign: dict) -> list[dict]:
    return []
