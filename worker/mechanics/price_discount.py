"""price_discount — parameters: discount_pct. explode: no extra lines."""
from ._base import schema_errors, standard_demand_effect, depth_band, discount_settlement

CODE = "price_discount"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "discount_pct": {"type": "number", "exclusiveMinimum": 0, "maximum": 100},
    },
    "required": ["discount_pct"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    return schema_errors(PARAM_SCHEMA, params)


def prior_band(params: dict) -> str:
    return depth_band(params["discount_pct"])


def explode(order_line: dict, params: dict) -> list[dict]:
    return []


def demand_effect(baseline, scope, params, library) -> list[dict]:
    return standard_demand_effect(CODE, baseline, scope, library, depth_band(params["discount_pct"]))


def settle(campaign: dict) -> list[dict]:
    pct = campaign["params"]["discount_pct"]
    return discount_settlement(campaign, CODE, lambda ln: pct)
