"""vmi_proposals (§10.4, phase 5): min and max per dealer and item of the pilot, and an order
proposal from each rep count. The dealer approves with one tap (rpc_vmi_decide); nothing is
ordered automatically.
"""
from __future__ import annotations

from datetime import timedelta

import numpy as np

from .. import db
from ..core.vmi import min_max, proposal_from_count
from ._common import business_date, monday

WEEKS = 26


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    week0 = monday(as_of)
    pilot = db.query(conn, """
        select v.id, v.party_id, v.item_id, v.min_qty, v.max_qty, coalesce(m.transit_days, 2) as transit_days,
               coalesce((select qty_base from uom_pack u where u.item_id = v.item_id and u.level = 'carton'), 1) as pack,
               (resolve_param('service_level', jsonb_build_object('party_id', v.party_id, 'item_id', v.item_id))->>'value')::numeric as service_level,
               (resolve_param('review_period_days', jsonb_build_object('party_id', v.party_id, 'item_id', v.item_id))->>'value')::numeric as review_days
          from vmi_param v join party p on p.id = v.party_id left join market m on m.id = p.market_id
         where v.active""")
    if not pilot:
        return {"pilot_rows": 0, "proposals": 0}
    sell = db.query(conn, """
        select party_id, item_id, week, sum(qty_paid + qty_free) as qty from demand_history
         where week >= %s and week < %s and party_id = any(%s::uuid[]) group by 1, 2, 3""",
                    [week0 - timedelta(weeks=WEEKS), week0, list({r["party_id"] for r in pilot})])
    series: dict = {}
    for r in sell:
        series.setdefault((r["party_id"], r["item_id"]), {})[r["week"]] = r["qty"]
    weeks = [week0 - timedelta(weeks=k) for k in range(WEEKS, 0, -1)]

    mm_by_key, updated = {}, 0
    for r in pilot:
        key = (r["party_id"], r["item_id"])
        y = np.array([series.get(key, {}).get(w, 0.0) for w in weeks])
        if y.sum() <= 0:
            mm_by_key[key] = {"min": r["min_qty"], "max": r["max_qty"], "basis": "kept: no sell-in history"}
            continue
        mm = min_max(float(y.mean()), float(y.std(ddof=1)), r["transit_days"] / 7.0, 0.0,
                     float(r["review_days"] or 7) / 7.0, float(r["service_level"] or 0.95), float(r["pack"] or 1))
        mm_by_key[key] = mm
        updated += db.execute(conn, """update vmi_param set min_qty = %s, max_qty = %s
                                        where id = %s and (min_qty, max_qty) is distinct from (%s, %s)""",
                              [round(mm["min"], 3), round(mm["max"], 3), r["id"], round(mm["min"], 3), round(mm["max"], 3)])

    # a proposal per dealer from counts newer than that dealer's last proposal
    counts = db.query(conn, """
        select distinct on (o.party_id, o.item_id) o.party_id, o.item_id, o.qty, o.observed_at
          from dealer_stock_observation o
         where o.source = 'count'
           and o.observed_at > coalesce((select max(created_at) from vmi_proposal v where v.party_id = o.party_id),
                                        now() - interval '7 days')
         order by o.party_id, o.item_id, o.observed_at desc""")
    transit = {(r["party_id"], r["item_id"]): r["qty"] for r in db.query(conn, """
        select o.party_id, l.item_id, sum(l.qty - l.shipped_qty) as qty
          from so_line l join sales_order o on o.id = l.order_id
         where o.state in ('confirmed', 'allocated', 'picking') and not l.is_phantom and l.qty > l.shipped_qty
         group by 1, 2""")}
    packs = {(r["party_id"], r["item_id"]): float(r["pack"] or 1) for r in pilot}
    lines: dict = {}
    for c in counts:
        key = (c["party_id"], c["item_id"])
        mm = mm_by_key.get(key)
        if not mm or mm.get("max") is None:
            continue
        p = proposal_from_count(float(c["qty"]), float(transit.get(key, 0.0)), mm, packs[key])
        if p:
            lines.setdefault(c["party_id"], []).append(
                {"item_id": c["item_id"], "qty": p["qty"], "below_min": p["below_min"], "counted_qty": c["qty"],
                 "counted_at": c["observed_at"], "in_transit": transit.get(key, 0.0), "min": mm["min"],
                 "max": mm["max"], "inputs": p["inputs"]})
    for party_id, ls in lines.items():
        db.execute(conn, "update vmi_proposal set state = 'superseded' where party_id = %s and state = 'proposed'",
                   [party_id])
        db.insert_rows(conn, "vmi_proposal", [{"party_id": party_id, "lines": db.as_json(ls), "state": "proposed"}])
    return {"pilot_rows": len(pilot), "min_max_updated": updated, "proposals": len(lines),
            "lines": sum(len(v) for v in lines.values())}
