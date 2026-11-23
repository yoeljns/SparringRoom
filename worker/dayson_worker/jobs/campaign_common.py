"""Campaign glue shared by simulate and campaign_review: scope, parameters, uplift library."""
from __future__ import annotations

import copy
import uuid

import pandas as pd

from .. import db

PRE_WEEKS, POST_WEEKS = 4, 8


def load_campaign(conn, campaign_id) -> dict:
    c = db.one(conn, "select * from campaign where id = %s", [campaign_id])
    if not c:
        raise ValueError(f"campaign {campaign_id} not found")
    c["scopes"] = db.query(conn, "select item_rule, party_rule, market_ids from campaign_scope where campaign_id = %s",
                           [campaign_id])
    c["mechanics"] = db.query(conn, """select mechanic_type, params from campaign_mechanic
                                        where campaign_id = %s order by created_at, id""", [campaign_id])
    return c


def scope_items(conn, campaign_id) -> list[str]:
    return [r["id"] for r in db.query(conn, """
        select i.id from item i
         where i.active and exists (select 1 from campaign_scope s
                                     where s.campaign_id = %s and app.rule_matches_item(s.item_rule, i.id))""",
                                      [campaign_id])]


def scope_parties(conn, campaign_id) -> list[dict]:
    return db.query(conn, """
        select p.id, p.segment, p.type, p.logo_cari_code from party p
         where p.active and p.type in ('dealer', 'importer') and app.campaign_in_scope(%s, p.id)""", [campaign_id])


def limits_eligibility(campaign: dict) -> bool:
    """True when the scope leaves some dealers out (an eligibility control group exists)."""
    def open_rule(s):
        r = s["party_rule"] or {}
        return (r == {} or r.get("all")) and not s["market_ids"]
    return not any(open_rule(s) for s in campaign["scopes"])


def single_segment(campaign: dict):
    segs = set()
    for s in campaign["scopes"]:
        r = s["party_rule"] or {}
        if "segments" not in r:
            return None
        segs |= set(r["segments"])
    return next(iter(segs)) if len(segs) == 1 else None


def item_facts(items: pd.DataFrame) -> dict:
    return {i: {"item_id": i, "sku": r["sku"], "family_id": r["family_id"], "family_code": r["family_code"],
                "attributes": r["attributes"] or {}} for i, r in items.iterrows()}


def _is_uuid(v) -> bool:
    try:
        uuid.UUID(str(v))
        return True
    except ValueError:
        return False


def resolve_item(ref, items: pd.DataFrame):
    """Mechanic parameters name items by id or by SKU."""
    if ref in items.index:
        return ref
    hit = items.index[items["sku"] == ref]
    if len(hit):
        return hit[0]
    if _is_uuid(ref):
        return str(ref)
    raise ValueError(f"unknown item {ref!r} in campaign parameters")


def prepare_params(conn, code: str, params: dict, items: pd.DataFrame) -> dict:
    """Copy of the parameters with item references resolved to item ids."""
    p = copy.deepcopy(params)
    if code == "buy_x_get_y" and p.get("free_item") != "same":
        p["free_item"] = resolve_item(p["free_item"], items)
    elif code == "gift_item":
        p["gift_item"] = resolve_item(p["gift_item"], items)
    elif code == "launch_seed":
        p["item"] = resolve_item(p["item"], items)
    elif code == "export_push":
        p["items"] = [resolve_item(i, items) for i in p["items"]]
    elif code == "mixed_set" and not _is_uuid(p["bundle_id"]):
        b = db.scalar(conn, """select b.id from bundle b join item i on i.id = b.item_id
                                where i.sku = %s and b.active""", [p["bundle_id"]])
        if not b:
            raise ValueError(f"unknown bundle {p['bundle_id']!r}")
        p["bundle_id"] = b
    return p


def library(conn) -> list[dict]:
    """uplift_library rows for the mechanics; borrow and cannibalisation rates are the mean of
    the stored review observations (0 until a review has measured them)."""
    rows = db.query(conn, "select * from uplift_library")
    for r in rows:
        obs = r.get("last_obs") or []
        for k in ("borrow_rate", "cannibal_rate"):
            v = [o[k] for o in obs if o.get(k) is not None]
            r[k] = sum(v) / len(v) if v else 0.0
    return rows


def sisters(items: pd.DataFrame) -> dict:
    """{item: other items of the same family and group (colour, size, ...)}."""
    out = {}
    grouped = items[items["group_id"] != "na"].groupby(["family_code", "group_id"]).groups
    for ids in grouped.values():
        for i in ids:
            out[i] = [j for j in ids if j != i]
    return out
