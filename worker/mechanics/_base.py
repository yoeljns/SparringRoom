"""Shared helpers for campaign mechanic plugins (spec §9.2).

Every mechanic module exposes:
    CODE, PARAM_SCHEMA, validate(params), explode(order_line, params),
    demand_effect(baseline, scope, params, library), settle(campaign)

Conventions used by all mechanics
---------------------------------
order_line : dict with at least ``id``, ``item_id``, ``qty``; optional
    ``family_id``, ``attributes``, ``unit_price``, ``order_total_eur``,
    ``order_total_qty``, ``party_segment``, ``bundle_id``, ``bundle_lines``.
explode    : returns only the EXTRA lines, each
    ``{"item_id", "qty", "line_type" in {"free","bundle_component"}, "parent_line_id"}``.
baseline   : rows ``{"item_id", "week", "qty"}`` (list of dicts, list of
    3-tuples, or a pandas DataFrame with those columns).
scope      : ``{"item_ids": [...]|None, "weeks": [order-window weeks],
    "family_id", "segment", "sisters": {item_id: [sister item ids]},
    "post_weeks": 8, "eligible_share": 1.0}``.
library    : uplift_library rows (list of dicts) or a dict keyed
    ``(mechanic_type, family_id, segment, depth_band)``; values are a float
    prior uplift (fraction of baseline) or a dict with ``prior_uplift`` and
    optional ``id``, ``borrow_rate``, ``cannibal_rate``.
demand_effect rows: ``{"item_id","week","uplift","pull_forward","cannibalised","prior_id"}``
    — all three quantities are >= 0; the forecast delta is
    ``uplift - pull_forward - cannibalised``.
settle rows (campaign_settlement file): see SETTLEMENT_COLUMNS.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

from jsonschema import Draft202012Validator

SETTLEMENT_COLUMNS = [
    "campaign_id", "mechanic", "party_id", "item_id", "kind", "qty", "amount_eur",
]

ITEM_RULE_SCHEMA = {
    "type": "object",
    "description": "Attribute filter or explicit list (spec §3.6 campaign_scope rules). Accepts the "
                   "database spelling (family, attributes, skus) and the order-entry spelling "
                   "(family_code, attrs); all given conditions must hold.",
    "properties": {
        "all": {"type": "boolean"},
        "item_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "skus": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "family": {"type": "string"},
        "family_code": {"type": "string"},
        "family_id": {"type": "string"},
        "attributes": {"type": "object"},
        "attrs": {"type": "object"},
    },
    "additionalProperties": False,
    "minProperties": 1,
}


def schema_errors(schema: dict, params: Any) -> list[str]:
    v = Draft202012Validator(schema)
    out = []
    for e in sorted(v.iter_errors(params), key=lambda e: list(e.absolute_path)):
        path = "/".join(str(p) for p in e.absolute_path) or "(root)"
        out.append(f"{path}: {e.message}")
    return out


def match_item_rule(rule: dict | None, line: dict) -> bool:
    """True when the item satisfies every key of the rule.

    ``line`` carries item_id and, for the other keys, sku, family_id, family_code, attributes.
    """
    if not rule:
        return False
    if rule.get("all"):
        return True
    ok = False
    if "item_ids" in rule:
        if line.get("item_id") not in rule["item_ids"]:
            return False
        ok = True
    if "skus" in rule:
        if line.get("sku") not in rule["skus"]:
            return False
        ok = True
    if "family_id" in rule:
        if line.get("family_id") != rule["family_id"]:
            return False
        ok = True
    for key in ("family", "family_code"):
        if key in rule:
            if line.get("family_code") != rule[key]:
                return False
            ok = True
    for key in ("attributes", "attrs"):
        if key in rule:
            attrs = line.get("attributes") or {}
            for k, want in rule[key].items():
                have = attrs.get(k)
                if isinstance(want, list):
                    if have not in want:
                        return False
                elif have != want:
                    return False
            ok = True
    return ok


def extra_line(item_id, qty, line_type, parent_line_id) -> dict:
    assert line_type in ("free", "bundle_component")
    return {"item_id": item_id, "qty": qty, "line_type": line_type,
            "parent_line_id": parent_line_id}


def depth_band(pct: float | None) -> str:
    """Depth band key used by uplift_library (effective discount % against list)."""
    if pct is None:
        return "na"
    if pct < 5:
        return "0-5"
    if pct < 10:
        return "5-10"
    if pct < 20:
        return "10-20"
    return "20+"


def baseline_rows(baseline) -> list[dict]:
    if hasattr(baseline, "to_dict"):
        return baseline[["item_id", "week", "qty"]].to_dict("records")
    out = []
    for r in baseline:
        if isinstance(r, dict):
            out.append({"item_id": r["item_id"], "week": r["week"], "qty": float(r["qty"])})
        else:
            out.append({"item_id": r[0], "week": r[1], "qty": float(r[2])})
    return out


def _normalise_library(library) -> dict:
    if library is None:
        return {}
    if isinstance(library, dict):
        return library
    out = {}
    for r in library:
        out[(r.get("mechanic_type"), r.get("family_id"), r.get("segment"), r.get("depth_band"))] = r
    return out


def library_prior(library, code: str, scope: dict, band: str) -> dict:
    """Most specific prior first: (code,family,segment,band) -> ... -> (code,None,None,None)."""
    lib = _normalise_library(library)
    fam, seg = scope.get("family_id"), scope.get("segment")
    for key in ((code, fam, seg, band), (code, fam, None, band), (code, None, seg, band),
                (code, None, None, band), (code, fam, None, None), (code, None, None, None)):
        if key in lib:
            v = lib[key]
            if isinstance(v, dict):
                return {"prior_uplift": float(v.get("prior_uplift", 0.0)),
                        "borrow_rate": float(v.get("borrow_rate", 0.0) or 0.0),
                        "cannibal_rate": float(v.get("cannibal_rate", 0.0) or 0.0),
                        "prior_id": v.get("id"), "key": key}
            return {"prior_uplift": float(v), "borrow_rate": 0.0, "cannibal_rate": 0.0,
                    "prior_id": None, "key": key}
    return {"prior_uplift": 0.0, "borrow_rate": 0.0, "cannibal_rate": 0.0,
            "prior_id": None, "key": None}


def standard_demand_effect(code: str, baseline, scope: dict, library, band: str,
                           item_ids: Iterable | None = None) -> list[dict]:
    """Library-prior demand effect shared by most mechanics.

    * uplift        = baseline x prior_uplift x eligible_share, in the order window
    * pull_forward  = uplift total x borrow_rate, spread over the ``post_weeks``
                      (default 8) baseline weeks after the window, pro rata to baseline
    * cannibalised  = uplift total x cannibal_rate, spread over the sister items'
                      in-window baseline pro rata, never more than that baseline
    """
    rows = baseline_rows(baseline)
    prior = library_prior(library, code, scope, band)
    window = set(scope.get("weeks") or [])
    in_scope = set(item_ids) if item_ids is not None else (
        set(scope["item_ids"]) if scope.get("item_ids") else {r["item_id"] for r in rows})
    share = float(scope.get("eligible_share", 1.0))
    post_n = int(scope.get("post_weeks", 8))
    sisters = scope.get("sisters") or {}

    by_item = defaultdict(dict)
    for r in rows:
        by_item[r["item_id"]][r["week"]] = by_item[r["item_id"]].get(r["week"], 0.0) + r["qty"]

    out: dict[tuple, dict] = {}

    def cell(item, week):
        return out.setdefault((item, week), {"item_id": item, "week": week, "uplift": 0.0,
                                             "pull_forward": 0.0, "cannibalised": 0.0,
                                             "prior_id": prior["prior_id"]})

    for item in sorted(in_scope, key=str):
        weeks = by_item.get(item, {})
        total = 0.0
        for w in sorted(weeks):
            if w in window:
                u = weeks[w] * prior["prior_uplift"] * share
                cell(item, w)["uplift"] += u
                total += u
        if total <= 0 or not window:
            continue
        if prior["borrow_rate"] > 0:
            end = max(window)
            post = [w for w in sorted(weeks) if w > end][:post_n]
            base_post = sum(weeks[w] for w in post)
            for w in post:
                frac = weeks[w] / base_post if base_post > 0 else 1.0 / len(post)
                cell(item, w)["pull_forward"] += total * prior["borrow_rate"] * frac
        if prior["cannibal_rate"] > 0:
            sis = [s for s in sisters.get(item, []) if s not in in_scope and s in by_item]
            sis_base = {(s, w): q for s in sis for w, q in by_item[s].items() if w in window}
            tot_base = sum(sis_base.values())
            if tot_base > 0:
                want = total * prior["cannibal_rate"]
                for (s, w), q in sis_base.items():
                    c = cell(s, w)
                    c["cannibalised"] = min(q, c["cannibalised"] + want * q / tot_base)
    return [out[k] for k in sorted(out, key=lambda k: (str(k[0]), str(k[1])))]


def settlement_row(campaign: dict, code: str, party_id, item_id, kind: str,
                   qty: float, amount_eur: float) -> dict:
    return {"campaign_id": campaign.get("id"), "mechanic": code, "party_id": party_id,
            "item_id": item_id, "kind": kind, "qty": round(float(qty), 3),
            "amount_eur": round(float(amount_eur), 2)}


def free_goods_settlement(campaign: dict, code: str) -> list[dict]:
    """Free-goods totals at cost per party and item, from the campaign's shipped lines."""
    agg = defaultdict(lambda: [0.0, 0.0])
    for ln in campaign.get("lines", []):
        if ln.get("line_type") == "free":
            a = agg[(ln.get("party_id"), ln.get("item_id"))]
            a[0] += float(ln.get("qty", 0))
            a[1] += float(ln.get("qty", 0)) * float(ln.get("unit_cost", 0) or 0)
    return [settlement_row(campaign, code, p, i, "free_goods", q, v)
            for (p, i), (q, v) in sorted(agg.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1])))]


def discount_settlement(campaign: dict, code: str, pct_for_line) -> list[dict]:
    """Discount totals per party and item; ``pct_for_line(line) -> discount %``."""
    agg = defaultdict(lambda: [0.0, 0.0])
    for ln in campaign.get("lines", []):
        if ln.get("line_type", "paid") != "paid":
            continue
        pct = pct_for_line(ln)
        if not pct:
            continue
        gross = float(ln.get("list_eur", float(ln.get("qty", 0)) * float(ln.get("unit_price", 0) or 0)))
        a = agg[(ln.get("party_id"), ln.get("item_id"))]
        a[0] += float(ln.get("qty", 0))
        a[1] += gross * pct / 100.0
    return [settlement_row(campaign, code, p, i, "discount", q, v)
            for (p, i), (q, v) in sorted(agg.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1])))]
