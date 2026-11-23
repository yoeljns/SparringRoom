"""measure_lead_times (§8.4): lead time = QC release - order date, per supplier lane / production line.

Statistics use the latest lt_window_receipts receipts; below lt_min_receipts the quoted lead
time is used (sd = lt_default_sd_pct of the mean; production lines use production_lt_days /
production_lt_sd_days). A new lead_time_stat row is written per lane and day; a change of mean
or p90 above lt_alert_change_pct raises an alert.
"""
from __future__ import annotations

from .. import db
from ..core.leadtime import lead_time_stat, lead_time_change
from ._common import business_date


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    window = int(db.param_num(conn, "lt_window_receipts", default=20))
    min_n = int(db.param_num(conn, "lt_min_receipts", default=5))
    sd_share = db.param_num(conn, "lt_default_sd_pct", default=25) / 100.0
    alert_pct = db.param_num(conn, "lt_alert_change_pct", default=15) / 100.0
    prod_lt = db.param_num(conn, "production_lt_days")
    prod_sd = db.param_num(conn, "production_lt_sd_days")

    lanes = db.query(conn, """
        select sl.id, sl.supplier_id, sl.item_family_id, sl.item_id, sl.production_line, sl.mode, sl.quoted_lt_days
          from supplier_lane sl where sl.active""")
    purchase = db.query(conn, """
        select po.supplier_lane_id, po.supplier_id, pl.item_id, i.family_id,
               extract(epoch from (pl.qc_released_at - po.ordered_at)) / 86400.0 as days, pl.qc_released_at
          from po_line pl join purchase_order po on po.id = pl.po_id join item i on i.id = pl.item_id
         where pl.qc_released_at is not null and po.ordered_at is not null and pl.qc_released_at >= po.ordered_at
         order by pl.qc_released_at""")
    production = db.query(conn, """
        select pr.line, pr.item_id, i.family_id,
               extract(epoch from (pr.qc_released_at - pr.ordered_at)) / 86400.0 as days, pr.qc_released_at
          from production_order pr join item i on i.id = pr.item_id
         where pr.qc_released_at is not null and pr.ordered_at is not null and pr.qc_released_at >= pr.ordered_at
         order by pr.qc_released_at""")

    written = measured = alerts = 0
    for lane in lanes:
        def fits(r):
            return (lane["item_id"] == r["item_id"]) if lane["item_id"] else (lane["item_family_id"] == r["family_id"])
        if lane["mode"] == "production" or lane["supplier_id"] is None:
            days = [r["days"] for r in production if r["line"] == lane["production_line"] and fits(r)]
            quoted = lane["quoted_lt_days"] if lane["quoted_lt_days"] is not None else prod_lt
        else:
            days = [r["days"] for r in purchase
                    if r["supplier_lane_id"] == lane["id"]
                    or (r["supplier_lane_id"] is None and r["supplier_id"] == lane["supplier_id"] and fits(r))]
            quoted = lane["quoted_lt_days"]
        stat = lead_time_stat(days, quoted, window, min_n, sd_share)
        if stat.source == "quoted" and lane["mode"] == "production" and prod_sd is not None:
            stat.sd_days = float(prod_sd)
            stat.p90_days = stat.mean_days + 1.2815515655446004 * stat.sd_days
        prev = db.one(conn, """
            select id, mean_days, sd_days, p90_days, source from lead_time_stat
             where supplier_lane_id = %s and as_of < %s order by as_of desc, created_at desc limit 1""",
                      [lane["id"], as_of])
        db.execute(conn, "delete from lead_time_stat where supplier_lane_id = %s and as_of = %s", [lane["id"], as_of])
        stat_id = db.insert_one(conn, "lead_time_stat", {
            "supplier_lane_id": lane["id"], "production_line": lane["production_line"], "n": stat.n,
            "mean_days": round(stat.mean_days, 2), "sd_days": round(stat.sd_days, 2),
            "p90_days": round(stat.p90_days, 2), "source": stat.source, "as_of": as_of})
        written += 1
        measured += stat.source == "measured"
        change = lead_time_change(prev, stat, alert_pct)
        if change:
            db.raise_alert(conn, "lead_time_change", "warning",
                           {"supplier_lane_id": lane["id"], "lead_time_stat_id": stat_id, "change": change,
                            "old": prev, "new": stat.as_dict()},
                           "supplier_lane", lane["id"], f"lead_time_change:{lane['id']}:{as_of}")
            alerts += 1
    return {"lanes": written, "measured": int(measured), "quoted": written - int(measured), "alerts": alerts,
            "as_of": as_of}
