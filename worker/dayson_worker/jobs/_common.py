"""Helpers shared by the job modules (thin DB glue; no business logic here)."""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from .. import db


def business_date(conn, as_of: date | None = None) -> date:
    """as_of, else the database's business date (Europe/Istanbul)."""
    return as_of or db.today(conn)


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def load_items(conn) -> pd.DataFrame:
    """Item master with the columns the planning jobs need, indexed by item id (str).

    family_code is the family kind; group_id is the value of the attribute named by
    item_family.group_attribute (colour, size, grit, ...), 'na' when the family names none.
    """
    df = db.query_df(conn, """
        select i.id as item_id, i.sku, i.family_id, f.code as family_code, f.default_policy,
               coalesce(i.attributes->>f.group_attribute, 'na') as group_id, i.attributes,
               i.lifecycle, i.sellable, i.lot_expiry_controlled, i.export_contract,
               coalesce(i.shelf_life_days, f.shelf_life_days) as shelf_life_days,
               i.analog_item_id, i.production_line,
               app.item_cost(i.id) as cost_eur, app.units_per_pallet(i.id) as units_per_pallet,
               (app.pallet_kg(i.id)->>'kg')::numeric as pallet_kg,
               exists (select 1 from bundle b where b.item_id = i.id and b.kind = 'phantom' and b.active) as is_phantom
          from item i join item_family f on f.id = i.family_id
         where i.active""")
    return df.set_index("item_id")


def load_weekly_history(conn, before_week: date, since: date | None = None) -> pd.DataFrame:
    """Long weekly demand (item_id, week, qty_paid, qty_free, qty) for weeks before ``before_week``."""
    df = db.query_df(conn, """
        select item_id, week, sum(qty_paid) as qty_paid, sum(qty_free) as qty_free
          from demand_history where week < %s and week >= %s group by 1, 2""",
                     [before_week, since or date(1900, 1, 1)])
    df["qty"] = df["qty_paid"] + df["qty_free"] if len(df) else []
    return df


def load_lanes(conn) -> dict:
    """The supply lane of every item with its latest lead-time statistic: {item_id: {...}}.

    An item-specific lane wins over the family lane; items made in house use the lane of
    their production line.
    """
    rows = db.query(conn, """
        select i.id as item_id, l.id as lane_id, l.supplier_id, l.production_line, l.mode, l.quoted_lt_days,
               l.moq, l.order_multiple, l.price_breaks, l.review_days, p.name as supplier_name,
               s.id as stat_id, s.n as stat_n, s.mean_days, s.sd_days, s.p90_days, s.source as stat_source,
               s.as_of as stat_as_of
          from item i
          join lateral (
            select sl.* from supplier_lane sl
             where sl.active and (sl.item_id = i.id or (sl.item_id is null and sl.item_family_id = i.family_id))
               and (sl.production_line is null or sl.production_line = i.production_line)
             order by (sl.item_id is not null) desc, (sl.production_line is not null) desc, sl.created_at
             limit 1) l on true
          left join party p on p.id = l.supplier_id
          left join lateral (select * from lead_time_stat x where x.supplier_lane_id = l.id
                              order by x.as_of desc, x.created_at desc limit 1) s on true
         where i.active""")
    return {r["item_id"]: r for r in rows}


def load_stock(conn) -> pd.DataFrame:
    """Central position per item: on hand (available), reservations, open supply, amber stock."""
    df = db.query_df(conn, """
        select a.item_id, a.on_hand_available as on_hand,
               a.hard_reserved + a.soft_reserved as reserved,
               coalesce((select sum(e.qty_base) from v_expected_receipt e where e.item_id = a.item_id), 0) as on_order,
               coalesce((select sum(c.qty_base) from v_central_stock c where c.item_id = a.item_id and c.band = 'amber'), 0) as amber_qty
          from v_available a""")
    return df.set_index("item_id")


def load_receipts(conn, week_starts: list[date]) -> dict:
    """Expected receipts per item and forecast week: {item_id: [qty per week]}; late ones land in week 0."""
    rows = db.query(conn, "select item_id, expected_date, sum(qty_base) as qty from v_expected_receipt group by 1, 2")
    out: dict = {}
    n = len(week_starts)
    for r in rows:
        idx = (monday(r["expected_date"]) - week_starts[0]).days // 7
        if idx >= n:
            continue
        out.setdefault(r["item_id"], [0.0] * n)[max(idx, 0)] += r["qty"]
    return out


def load_forecast(conn, run_id, column: str = "final") -> pd.DataFrame:
    """SKU-level weekly forecast of one run as an items x weeks matrix."""
    df = db.query_df(conn, f"""
        select item_id, period, {column} as qty from forecast
         where run_id = %s and level = 'sku' and bucket = 'week'""", [run_id])
    if df.empty:
        return pd.DataFrame()
    return df.pivot(index="item_id", columns="period", values="qty").sort_index(axis=1).fillna(0.0)


def policy_dict(row: dict) -> dict:
    """item_policy row -> the dict shape of core.policy (weeks, as stored in inputs)."""
    inp = row.get("inputs") or {}
    return {"policy": row["policy"], "safety_stock": row.get("safety_stock") or 0.0, "rop": row.get("rop"),
            "order_up_to": row.get("order_up_to"), "d": row.get("d_mean"), "sd_d": row.get("sd_d"),
            "L": inp.get("lead_time_weeks"), "sd_L": inp.get("lead_time_sd_weeks"),
            "R": inp.get("review_weeks"), "z": row.get("z"), "service_level": row.get("service_level")}
