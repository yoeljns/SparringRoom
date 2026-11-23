"""target_rebate — parameters: period, targets by segment, rebate_pct.

explode: no lines. settle computes the rebate: every party whose net sales in
the period reach its segment's target earns rebate_pct of those sales.
"""
from collections import defaultdict

from ._base import schema_errors, standard_demand_effect, depth_band, settlement_row

CODE = "target_rebate"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "period": {
            "type": "object",
            "properties": {"from": {"type": "string", "format": "date"},
                           "to": {"type": "string", "format": "date"}},
            "required": ["from", "to"],
            "additionalProperties": False,
        },
        "targets": {
            "type": "object",
            "description": "segment -> net sales target in EUR",
            "minProperties": 1,
            "additionalProperties": {"type": "number", "exclusiveMinimum": 0},
        },
        "rebate_pct": {"type": "number", "exclusiveMinimum": 0, "maximum": 100},
    },
    "required": ["period", "targets", "rebate_pct"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    errs = schema_errors(PARAM_SCHEMA, params)
    if not errs and params["period"]["to"] < params["period"]["from"]:
        errs.append("period: 'to' is before 'from'")
    return errs


def prior_band(params: dict) -> str:
    return depth_band(params["rebate_pct"])


def explode(order_line: dict, params: dict) -> list[dict]:
    return []


def demand_effect(baseline, scope, params, library) -> list[dict]:
    return standard_demand_effect(CODE, baseline, scope, library, depth_band(params["rebate_pct"]))


def settle(campaign: dict) -> list[dict]:
    """campaign['lines']: paid lines in the period with party_id, segment, net_eur."""
    params = campaign["params"]
    sales = defaultdict(float)
    seg = {}
    for ln in campaign.get("lines", []):
        if ln.get("line_type", "paid") != "paid":
            continue
        sales[ln["party_id"]] += float(ln.get("net_eur", 0))
        seg[ln["party_id"]] = ln.get("segment")
    out = []
    for party in sorted(sales, key=str):
        target = params["targets"].get(seg[party])
        if target is not None and sales[party] >= target:
            out.append(settlement_row(campaign, CODE, party, None, "rebate", 0,
                                      sales[party] * params["rebate_pct"] / 100.0))
    return out
