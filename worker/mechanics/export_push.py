"""export_push — parameters: market, items, terms. explode: no extra lines."""
from ._base import schema_errors, standard_demand_effect, depth_band, discount_settlement

CODE = "export_push"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "market": {"type": "string", "minLength": 1},
        "items": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1},
                  "uniqueItems": True},
        "terms": {
            # no "type": order entry may send free text; an object is checked against the properties below
            "description": "commercial terms (object or free text); discount_pct is used for the depth band and settlement",
            "properties": {
                "discount_pct": {"type": "number", "minimum": 0, "maximum": 100},
                "payment_days": {"type": "integer", "minimum": 0},
                "incoterm": {"type": "string"},
            },
            "additionalProperties": True,
        },
    },
    "required": ["market", "items", "terms"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    errs = schema_errors(PARAM_SCHEMA, params)
    if isinstance(params, dict) and "terms" in params:
        t = params["terms"]
        if not isinstance(t, dict) and not (isinstance(t, str) and t.strip()):
            errs.append("terms: expected an object or a non-empty text")
    return errs


def _terms(params: dict) -> dict:
    return params["terms"] if isinstance(params.get("terms"), dict) else {}


def prior_band(params: dict) -> str:
    t = _terms(params)
    return depth_band(t["discount_pct"]) if "discount_pct" in t else "push"


def explode(order_line: dict, params: dict) -> list[dict]:
    return []


def demand_effect(baseline, scope, params, library) -> list[dict]:
    return standard_demand_effect(CODE, baseline, scope, library, prior_band(params), item_ids=params["items"])


def settle(campaign: dict) -> list[dict]:
    params = campaign["params"]
    pct = _terms(params).get("discount_pct", 0)
    items = set(params["items"])
    return discount_settlement(campaign, CODE, lambda ln: pct if ln.get("item_id") in items else 0)
