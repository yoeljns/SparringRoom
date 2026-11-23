"""mixed_set — parameters: bundle_id, price. explode: component lines from bundle_line.

The caller passes the bundle's rows on the order line as
``order_line["bundle_lines"] = [{"component_item_id", "qty"}]`` (phantom
bundles, §9.3). The line applies when ``order_line["bundle_id"]`` equals
``params["bundle_id"]``.
"""
from ._base import schema_errors, extra_line, standard_demand_effect, settlement_row

CODE = "mixed_set"
PARAM_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": CODE,
    "type": "object",
    "properties": {
        "bundle_id": {"type": "string", "minLength": 1},
        "price": {"type": "number", "minimum": 0},
    },
    "required": ["bundle_id", "price"],
    "additionalProperties": False,
}


def validate(params) -> list[str]:
    return schema_errors(PARAM_SCHEMA, params)


def prior_band(params: dict) -> str:
    return "set"


def explode(order_line: dict, params: dict) -> list[dict]:
    if order_line.get("bundle_id") != params["bundle_id"]:
        return []
    out = []
    for bl in order_line.get("bundle_lines") or []:
        out.append(extra_line(bl["component_item_id"], bl["qty"] * order_line["qty"],
                              "bundle_component", order_line.get("id")))
    return out


def demand_effect(baseline, scope, params, library) -> list[dict]:
    """scope['item_ids'] are the component items; the prior is keyed on band 'set'."""
    return standard_demand_effect(CODE, baseline, scope, library, "set")


def settle(campaign: dict) -> list[dict]:
    """Set discount = component list value minus the set price, per party."""
    price = campaign["params"]["price"]
    agg = {}
    for ln in campaign.get("lines", []):
        if ln.get("bundle_id") != campaign["params"]["bundle_id"] or ln.get("line_type", "paid") != "paid":
            continue
        a = agg.setdefault(ln.get("party_id"), [0.0, 0.0])
        a[0] += float(ln.get("qty", 0))
        a[1] += float(ln.get("list_eur", 0)) - price * float(ln.get("qty", 0))
    return [settlement_row(campaign, CODE, p, campaign["params"]["bundle_id"], "set_discount", q, v)
            for p, (q, v) in sorted(agg.items(), key=lambda kv: str(kv[0]))]
