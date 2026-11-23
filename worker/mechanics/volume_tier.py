"""volume_tier — parameters: tiers [{min_qty, discount_pct}]. explode: no extra lines."""
from ._base import schema_errors, standard_demand_effect, depth_band, discount_settlement

CODE = "volume_tier"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "tiers": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "min_qty": {"type": "number", "exclusiveMinimum": 0},
                    "discount_pct": {"type": "number", "exclusiveMinimum": 0, "maximum": 100},
                },
                "required": ["min_qty", "discount_pct"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["tiers"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    errs = schema_errors(PARAM_SCHEMA, params)
    if not errs:
        tiers = params["tiers"]
        for a, b in zip(tiers, tiers[1:]):
            if b["min_qty"] <= a["min_qty"]:
                errs.append("tiers: min_qty must be strictly increasing")
            if b["discount_pct"] < a["discount_pct"]:
                errs.append("tiers: discount_pct must not decrease as min_qty rises")
    return errs


def tier_discount(qty: float, params: dict) -> float:
    """Discount % earned by a quantity (0 below the first tier)."""
    pct = 0.0
    for t in params["tiers"]:
        if qty >= t["min_qty"]:
            pct = max(pct, t["discount_pct"])
    return pct


def prior_band(params: dict) -> str:
    tiers = params["tiers"]
    return depth_band(sum(t["discount_pct"] for t in tiers) / len(tiers))


def explode(order_line: dict, params: dict) -> list[dict]:
    return []


def demand_effect(baseline, scope, params, library) -> list[dict]:
    tiers = params["tiers"]
    mean_pct = sum(t["discount_pct"] for t in tiers) / len(tiers)
    return standard_demand_effect(CODE, baseline, scope, library, depth_band(mean_pct))


def settle(campaign: dict) -> list[dict]:
    params = campaign["params"]
    return discount_settlement(campaign, CODE, lambda ln: tier_discount(float(ln.get("qty", 0)), params))
