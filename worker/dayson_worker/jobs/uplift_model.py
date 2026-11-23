"""Nightly: campaign intensity measures and the per-family uplift model (§9.4)."""
from __future__ import annotations

from datetime import timedelta

from .. import db
from ..core.campaign import intensity_measures, combined_intensity, fit_uplift_model
from ._common import today, monday

HISTORY_WEEKS = 104


def run(conn, as_of=None) -> dict:
    as_of = as_of or today()
    since = monday(as_of) - timedelta(weeks=HISTORY_WEEKS)
    # SCHEMA: so_line(list_eur*, net_eur*) — line values against list and net of all terms
    lines = db.query_df(conn, """
        select l.item_id, date_trunc('week', l.shipped_at)::date as week,
               case when l.line_type = 'free' then 0 else l.shipped_qty end as qty_paid,
               case when l.line_type = 'free' then l.shipped_qty else 0 end as qty_free,
               coalesce(l.list_eur, 0) as list_eur, coalesce(l.net_eur, 0) as net_eur, o.campaign_id
          from so_line l join sales_order o on o.id = l.sales_order_id
         where l.shipped_qty > 0 and l.shipped_at >= %s""", [since])
    if lines.empty:
        return {"skipped": "no shipped lines"}
    active = db.query_df(conn, "select distinct campaign_id, item_id, week from campaign_forecast where week >= %s",
                         [since])
    m = intensity_measures(lines, active)
    m["intensity"] = combined_intensity(m)
    # SCHEMA: campaign_intensity(item_id, week, discount_depth, free_ratio, campaign_share, n_campaigns)*  (not in §3)
    db.execute(conn, "delete from campaign_intensity where week >= %s", [since])
    db.insert_rows(conn, "campaign_intensity",
                   m[["item_id", "week", "discount_depth", "free_ratio", "campaign_share", "n_campaigns"]].to_dict("records"))
    demand = lines.assign(demand=lines["qty_paid"] + lines["qty_free"]).groupby(["item_id", "week"], as_index=False)["demand"].sum()
    # baseline = stored forecast base for the same weeks (demand under standard terms)
    base = db.query_df(conn, """
        select distinct on (f.item_id, f.week) f.item_id, f.week, f.base as baseline
          from forecast f join forecast_run r on r.id = f.run_id
         where f.level = 'item' and f.bucket = 'week' and f.week >= %s and f.week < %s
         order by f.item_id, f.week, r.created_at""", [since, monday(as_of)])
    items = db.query_df(conn, "select id as item_id, family_id, coalesce(attributes->>'colour', attributes->>'size') "
                              "as group_id from item")
    d = demand.merge(base, on=["item_id", "week"]).merge(m[["item_id", "week", "intensity"]], on=["item_id", "week"],
                                                         how="left").merge(items, on="item_id")
    d["intensity"] = d["intensity"].fillna(0.0)
    fitted = {}
    for fam, g in d.groupby("family_id"):
        if len(g) < 60 or g["intensity"].gt(0).sum() < 8:
            continue
        model = fit_uplift_model(g)
        fitted[str(fam)] = {"b": model.b, "lags": model.lags, "cross": model.cross, "n_obs": model.n_obs}
    if fitted:
        # SCHEMA: uplift_model_fit(family_id, as_of, coefficients jsonb)*  (not in §3)
        db.insert_rows(conn, "uplift_model_fit", [{"family_id": f, "as_of": as_of, "coefficients": c}
                                                  for f, c in fitted.items()])
    return {"intensity_rows": int(len(m)), "families_fitted": len(fitted)}
