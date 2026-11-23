"""campaign_review (§9.5, §9.6) and campaign settlement.

Review: campaigns in state closed whose order window ended campaign_review_weeks ago get
campaign_review rows (one per item, item_id null = total), the uplift library is updated by
shrinkage, and the campaign becomes 'reviewed'.
Settlement: once a closed campaign's ring-fence has been released (ring_fence_release_days
after the window) its rebates and free-goods totals are written to export_row
(type campaign_settlement; payload campaign_code, dealer_code, type, amount_eur, qty).
"""
from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

import mechanics

from .. import db
from ..core import campaign as core
from ..core.dealer import review_confidence
from . import campaign_common as cc
from ._common import business_date, monday, load_items

BASELINE_WEEKS = 13


def _weekly(conn, item_ids, w_from, w_to, parties=None) -> pd.DataFrame:
    df = db.query_df(conn, f"""
        select item_id, week, sum(qty_paid + qty_free) as qty from demand_history
         where item_id = any(%s::uuid[]) and week >= %s and week <= %s
           {"and party_id = any(%s::uuid[])" if parties is not None else ""} group by 1, 2""",
                     [item_ids, w_from, w_to] + ([parties] if parties is not None else []))
    return df.pivot(index="item_id", columns="week", values="qty") if len(df) else pd.DataFrame()


def review_campaign(conn, campaign: dict, as_of, items: pd.DataFrame) -> dict:
    cid = campaign["id"]
    fc = db.query(conn, "select * from campaign_forecast where campaign_id = %s", [cid])
    scoped = sorted({r["item_id"] for r in fc} | set(cc.scope_items(conn, cid)) & set(items.index))
    scoped = [i for i in scoped if i in items.index]
    d_from = campaign["deliver_from"] or campaign["order_from"]
    d_to = campaign["deliver_to"] or campaign["order_to"]
    w_s, w_e = monday(d_from), monday(d_to)
    axis = [w_s + timedelta(weeks=k) for k in range(-cc.PRE_WEEKS, (w_e - w_s).days // 7 + cc.POST_WEEKS + 1)]
    axis = [w for w in axis if w < monday(as_of)]
    s_idx, e_idx = cc.PRE_WEEKS, min(cc.PRE_WEEKS + (w_e - w_s).days // 7, len(axis) - 1)
    sis = cc.sisters(items)
    sister_ids = sorted({j for i in scoped for j in sis.get(i, []) if j not in scoped})
    actual = _weekly(conn, scoped + sister_ids, axis[0], axis[-1]).reindex(index=scoped + sister_ids, columns=axis).fillna(0.0)
    prior = _weekly(conn, scoped + sister_ids, axis[0] - timedelta(weeks=BASELINE_WEEKS), axis[0] - timedelta(weeks=1))
    fallback = (prior.reindex(scoped + sister_ids).fillna(0.0).sum(axis=1) / BASELINE_WEEKS) if len(prior) else \
        pd.Series(0.0, index=scoped + sister_ids)
    base = pd.DataFrame({w: fallback for w in axis})
    for r in fc:                                       # the baseline the campaign was planned on, where stored
        if r["item_id"] in base.index and r["week"] in base.columns:
            base.at[r["item_id"], r["week"]] = r["baseline"]
    forecast_net = {}
    for r in fc:
        v = (r["override"] if r["override"] is not None else r["uplift"]) + r["free_qty"] - r["pull_forward"] - r["cannibalised"]
        forecast_net[r["item_id"]] = forecast_net.get(r["item_id"], 0.0) + v

    # which control is available (§9.4.4)
    parties = cc.scope_parties(conn, cid)
    elig = [p["id"] for p in parties]
    method = core.estimate_method(cc.limits_eligibility(campaign), False)
    elig_uplift = None
    if method["method"] == "eligibility" and scoped:
        others = [r["id"] for r in db.query(conn, """select id from party where type in ('dealer', 'importer')
                                                      and active and id <> all(%s::uuid[])""", [elig])]
        def tot(pids, a, b):
            m = _weekly(conn, scoped, a, b, pids)
            return float(m.to_numpy().sum()) if len(m) else 0.0
        n_w = e_idx - s_idx + 1
        before = (axis[s_idx] - timedelta(weeks=n_w + cc.PRE_WEEKS), axis[s_idx] - timedelta(weeks=cc.PRE_WEEKS + 1))
        u = core.eligibility_uplift(tot(elig, *before), tot(elig, axis[s_idx], axis[e_idx]),
                                    tot(others, *before), tot(others, axis[s_idx], axis[e_idx]))
        if np.isfinite(u):
            elig_uplift = u
        else:
            method = core.estimate_method(False, False)
    est = db.query(conn, """select party_id, item_id, qty_est, confidence from dealer_stock_estimate
                             where party_id = any(%s::uuid[]) and item_id = any(%s::uuid[])""", [elig, scoped])
    usable = review_confidence(est) == "normal"
    confidence = ("high" if usable else "medium") if method["method"] == "eligibility" else \
        ("medium" if method["method"] == "participation" and usable else "low")

    rows, per_item = [], {}
    for i in scoped:
        sisters = [(actual.loc[j].to_numpy(), base.loc[j].to_numpy()) for j in sis.get(i, []) if j in sister_ids]
        r = core.campaign_review(actual.loc[i].to_numpy(), base.loc[i].to_numpy(), (s_idx, e_idx), sisters)
        r["baseline_in_window"] = float(base.loc[i].iloc[s_idx:e_idx + 1].sum())
        per_item[i] = r
        rows.append({"campaign_id": cid, "item_id": i, "gross": round(r["gross"], 3), "borrowed": round(r["borrowed"], 3),
                     "cannibalised": round(r["cannibalised"], 3), "net": round(r["net"], 3),
                     "forecast_net": round(forecast_net.get(i, 0.0), 3), "confidence": confidence,
                     "details": {"method": method["method"], "k": method["k"], "borrow_rate": r["borrow_rate"],
                                 "baseline_in_window": r["baseline_in_window"],
                                 "weeks_after_available": r["weeks_after_available"],
                                 "observed_uplift": core.observed_uplift(r["net"], r["baseline_in_window"])}})
    g = {k: sum(r[k] for r in per_item.values()) for k in ("gross", "borrowed", "cannibalised", "net", "baseline_in_window")}
    total_uplift = elig_uplift if elig_uplift is not None else core.observed_uplift(g["net"], g["baseline_in_window"])
    rows.append({"campaign_id": cid, "item_id": None, "gross": round(g["gross"], 3), "borrowed": round(g["borrowed"], 3),
                 "cannibalised": round(g["cannibalised"], 3), "net": round(g["net"], 3),
                 "forecast_net": round(sum(forecast_net.values()), 3), "confidence": confidence,
                 "details": {"method": method["method"], "k": method["k"], "eligibility_uplift": elig_uplift,
                             "observed_uplift": total_uplift, "baseline_in_window": g["baseline_in_window"],
                             "items": len(scoped), "usable_dealer_estimates": usable,
                             "window": [axis[s_idx], axis[e_idx]], "reviewed_on": as_of}})
    db.execute(conn, "delete from campaign_review where campaign_id = %s", [cid])
    db.insert_rows(conn, "campaign_review", rows)

    # uplift library: one prior per (mechanic type, family, segment, depth band), shrinkage-updated
    updated = 0
    segment = cc.single_segment(campaign)
    for m in campaign["mechanics"]:
        mod = mechanics.get(m["mechanic_type"])
        band = mod.prior_band(m["params"])
        for fam, ids in items.loc[scoped].groupby("family_id").groups.items():
            b = sum(per_item[i]["baseline_in_window"] for i in ids)
            gross = sum(per_item[i]["gross"] for i in ids)
            obs = elig_uplift if elig_uplift is not None else core.observed_uplift(sum(per_item[i]["net"] for i in ids), b)
            if obs is None or not np.isfinite(obs):
                continue
            row = db.one(conn, """select * from uplift_library where mechanic_type = %s
                                     and family_id is not distinct from %s and segment is not distinct from %s
                                     and depth_band is not distinct from %s""", [m["mechanic_type"], fam, segment, band])
            new = core.update_library_row(row or {"prior_uplift": 0.0, "n_obs": 0, "last_obs": []},
                                          float(obs), method["method"], cid, as_of)
            new["last_obs"][-1].update({
                "borrow_rate": sum(per_item[i]["borrowed"] for i in ids) / gross if gross > 0 else None,
                "cannibal_rate": sum(per_item[i]["cannibalised"] for i in ids) / gross if gross > 0 else None})
            rng = core.prior_range(new)
            vals = [round(new["prior_uplift"], 4), rng[0] if rng else None, rng[1] if rng else None,
                    new["n_obs"], db.as_json(new["last_obs"])]
            if row:
                db.execute(conn, """update uplift_library set prior_uplift = %s, prior_low = %s, prior_high = %s,
                                    n_obs = %s, last_obs = %s where id = %s""", vals + [row["id"]])
            else:
                db.execute(conn, """insert into uplift_library (prior_uplift, prior_low, prior_high, n_obs, last_obs,
                                    mechanic_type, family_id, segment, depth_band)
                                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                           vals + [m["mechanic_type"], fam, segment, band])
            updated += 1
    db.execute(conn, "update campaign set state = 'reviewed', reviewed_at = now() where id = %s", [cid])
    return {"code": campaign["code"], "items": len(scoped), "net": g["net"], "observed_uplift": total_uplift,
            "method": method["method"], "confidence": confidence, "library_rows": updated}


def settle_campaign(conn, campaign: dict) -> int:
    """export_row lines for one campaign: rebate amounts and free-goods totals per dealer."""
    cid = campaign["id"]
    lines = db.query(conn, """
        select o.party_id, p.segment, p.logo_cari_code, l.item_id, l.line_type, l.bundle_id,
               case when l.shipped_qty > 0 then l.shipped_qty else l.qty end as qty,
               coalesce(app.item_cost(l.item_id), 0) as unit_cost
          from so_line l join sales_order o on o.id = l.order_id join party p on p.id = o.party_id
         where o.campaign_id = %s and o.state <> 'cancelled' and not l.is_phantom""", [cid])
    codes = {p["id"]: p["logo_cari_code"] for p in db.query(conn, "select id, logo_cari_code from party")}
    scoped = cc.scope_items(conn, cid)
    out: dict = {}
    for m in campaign["mechanics"]:
        mod = mechanics.get(m["mechanic_type"])
        mlines = lines
        if m["mechanic_type"] == "target_rebate":       # net sales in the period, from the Logo invoices
            per = m["params"]["period"]
            mlines = db.query(conn, """
                select d.party_id, p.segment, d.item_id, 'paid' as line_type,
                       coalesce(d.qty_base, d.qty) as qty, d.qty * coalesce(d.unit_price_eur, 0) as net_eur
                  from logo_sales_doc d join party p on p.id = d.party_id
                 where d.doc_type = 'invoice' and not d.is_free and d.doc_date between %s and %s
                   and d.item_id = any(%s::uuid[]) and app.campaign_in_scope(%s, d.party_id)""",
                              [per["from"], per["to"], scoped, cid])
        for r in mod.settle({"id": cid, "params": m["params"], "lines": mlines}):
            kind = {"rebate": "rebate", "free_goods": "free_goods_total"}.get(r["kind"])
            if kind is None:                             # price discounts are already on the invoice
                continue
            a = out.setdefault((r["party_id"], kind), {"amount_eur": 0.0, "qty": 0.0})
            a["amount_eur"] += r["amount_eur"]
            a["qty"] += r["qty"]
    rows = [{"type": "campaign_settlement", "ref_id": f"{cid}:{party}:{kind}",
             "payload": {"campaign_code": campaign["code"], "dealer_code": codes.get(party), "type": kind,
                         "amount_eur": round(a["amount_eur"], 2) if kind == "rebate" else None,
                         "qty": round(a["qty"], 3) if kind == "free_goods_total" else None}}
            for (party, kind), a in sorted(out.items())]
    db.insert_rows(conn, "export_row", rows)
    return len(rows)


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    weeks = int(db.param_num(conn, "campaign_review_weeks", default=8))
    items = load_items(conn)
    settled = 0
    for c in db.query(conn, """
        select id from campaign c
         where c.state in ('closed', 'reviewed') and c.ring_fence_released_at is not null
           and not exists (select 1 from export_row e where e.type = 'campaign_settlement'
                              and e.ref_id like c.id::text || ':%')"""):
        settled += settle_campaign(conn, cc.load_campaign(conn, c["id"]))
    reviews = []
    for c in db.query(conn, "select id from campaign where state = 'closed' and order_to + %s <= %s order by order_to",
                      [weeks * 7, as_of]):
        reviews.append(review_campaign(conn, cc.load_campaign(conn, c["id"]), as_of, items))
    return {"reviewed": len(reviews), "reviews": reviews, "settlement_rows": settled}
