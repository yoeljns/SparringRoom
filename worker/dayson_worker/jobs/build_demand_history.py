"""build_demand_history (§8.1 step 1): weekly demand per item, party and market.

Sources
  * our dispatched shipments (shipment_line -> so_line): free lines go to qty_free,
    bundle components carry source 'bundle:<bundle_id>';
  * Logo invoices (logo_sales_doc, doc_type 'invoice') for documents with no matching
    dispatched shipment, i.e. history before go-live — never both for the same goods.
Rows this job cannot rebuild are kept: only source order / bundle:* rows are replaced, and
'logo' rows only for the weeks that exist in logo_sales_doc.
"""
from __future__ import annotations

import pandas as pd

from .. import db
from ..core.demand_history import build_demand_history

COLS = ["item_id", "party_id", "market_id", "week", "qty_paid", "qty_free", "source", "campaign_id"]


def _records(df: pd.DataFrame) -> list[dict]:
    df = df[(df["qty_paid"] != 0) | (df["qty_free"] != 0)]
    recs = df.astype(object).where(df.notna(), None).to_dict("records")
    for r in recs:
        r["week"] = pd.Timestamp(r["week"]).date()
    return recs


def run(conn, as_of=None) -> dict:
    shipped = db.query_df(conn, """
        select l.item_id, o.party_id, coalesce(o.market_id, p.market_id) as market_id,
               (s.dispatched_at at time zone 'Europe/Istanbul')::date as ship_date,
               case when sl.shipped_qty > 0 then sl.shipped_qty else sl.qty_base end as qty,
               l.line_type, coalesce(l.bundle_id, parent.bundle_id) as bundle_id, o.campaign_id
          from shipment_line sl
          join shipment s on s.id = sl.shipment_id
          join so_line l on l.id = sl.so_line_id
          join sales_order o on o.id = l.order_id
          join party p on p.id = o.party_id
          left join so_line parent on parent.id = l.parent_line_id
         where s.state = 'dispatched' and s.dispatched_at is not null and not l.is_phantom""")
    logo = db.query_df(conn, """
        select d.item_id, d.party_id, p.market_id, d.doc_date as ship_date,
               coalesce(d.qty_base, d.qty) as qty,
               case when d.is_free then 'free' else 'paid' end as line_type
          from logo_sales_doc d left join party p on p.id = d.party_id
         where d.doc_type = 'invoice' and d.item_id is not null
           and not exists (select 1 from shipment s
                            where s.state = 'dispatched'
                              and (s.shipment_no = d.ref_shipment_id or s.id::text = d.ref_shipment_id
                                   or (d.e_irsaliye_no is not null and s.e_irsaliye_no = d.e_irsaliye_no)))""")

    deleted = db.execute(conn, "delete from demand_history where source = 'order' or source like 'bundle:%'")
    deleted += db.execute(conn, """
        delete from demand_history h where h.source = 'logo'
           and h.week in (select distinct app.week_start(d.doc_date) from logo_sales_doc d where d.doc_type = 'invoice')""")
    rows = []
    if len(shipped):
        rows += _records(build_demand_history(shipped)[COLS])
    if len(logo):
        logo["bundle_id"] = None
        h = build_demand_history(logo)
        h["source"] = "logo"
        rows += _records(h[COLS])
    db.insert_rows(conn, "demand_history", rows)
    return {"shipped_lines": len(shipped), "logo_lines": len(logo), "rows_deleted": deleted, "rows_written": len(rows),
            "rows_total": db.scalar(conn, "select count(*) from demand_history")}
