"""slow_stock (§8.8): the monthly slow, obsolete and at-risk stock list.

slow: cover above slow_cover_weeks; obsolete: no demand for obsolete_months; at risk: stock in
the amber expiry band (one row per lot). Runs once a month (force=True overrides); open rows
of the same month are replaced, decided rows are kept.
"""
from __future__ import annotations

import pandas as pd

from .. import db
from ..core.demand_history import weekly_matrix
from ..core.suggest import stock_health
from ._common import business_date, monday, load_items, load_weekly_history, load_lanes, load_stock, load_forecast

ACTION = {"obsolete": ("supplier_return", "scrap"), "at_risk": ("free_goods_bundle", "free_goods_bundle"),
          "slow": ("dealer_push", "dealer_push")}


def run(conn, as_of=None, force: bool = False) -> dict:
    as_of = business_date(conn, as_of)
    month = as_of.replace(day=1)
    if not force and db.scalar(conn, "select 1 from slow_stock where run_date >= %s limit 1", [month]):
        return {"skipped": "this month's list exists"}
    week0 = monday(as_of)
    slow_weeks = db.param_num(conn, "slow_cover_weeks", default=26)
    obsolete_weeks = db.param_num(conn, "obsolete_months", default=12) * 52.0 / 12.0
    items, lanes, stock = load_items(conn), load_lanes(conn), load_stock(conn)
    frun = db.current_run(conn, "forecast_run")
    fc = load_forecast(conn, frun["id"]) if frun else pd.DataFrame()
    hist = load_weekly_history(conn, week0)
    wide = weekly_matrix(hist, "total", week0) if len(hist) else pd.DataFrame()
    amber = db.query(conn, """
        select item_id, lot_id, sum(qty_base) as qty from v_central_stock where band = 'amber' group by 1, 2""")
    amber_by_item: dict = {}
    for a in amber:
        amber_by_item.setdefault(a["item_id"], []).append(a)

    rows = []
    for item_id, st in stock.iterrows():
        if st["on_hand"] <= 0 or item_id not in items.index:
            continue
        weekly = float(fc.loc[item_id].iloc[:13].mean()) if item_id in fc.index else 0.0
        if item_id in wide.index:
            y = wide.loc[item_id].to_numpy(float)
            nz = (y > 0).nonzero()[0]
            since = float(len(y) - 1 - nz[-1]) if nz.size else float(len(y))
        else:
            since = obsolete_weeks
        cost = float(items.at[item_id, "cost_eur"]) if pd.notna(items.at[item_id, "cost_eur"]) else 0.0
        lots = amber_by_item.get(item_id, [])
        h = stock_health(on_hand=float(st["on_hand"]), weekly_forecast=weekly, weeks_since_last_demand=since,
                         amber_qty=sum(l["qty"] for l in lots), unit_cost=cost,
                         slow_cover_weeks=slow_weeks, obsolete_weeks=obsolete_weeks)
        if not h:
            continue
        purchased = bool((lanes.get(item_id) or {}).get("supplier_id"))
        cover = None if h["cover_weeks"] == float("inf") else round(h["cover_weeks"], 2)
        for flag in h["flags"]:
            action = ACTION[flag][0 if purchased else 1]
            if flag == "at_risk":
                for l in lots:
                    rows.append({"run_date": as_of, "item_id": item_id, "lot_id": l["lot_id"], "category": flag,
                                 "qty_base": l["qty"], "cover_weeks": cover, "value_eur": round(l["qty"] * cost, 2),
                                 "proposed_action": action})
            else:
                rows.append({"run_date": as_of, "item_id": item_id, "lot_id": None, "category": flag,
                             "qty_base": float(st["on_hand"]), "cover_weeks": cover,
                             "value_eur": round(h["value"], 2), "proposed_action": action})
    db.execute(conn, "delete from slow_stock where run_date >= %s and state = 'open'", [month])
    db.insert_rows(conn, "slow_stock", rows)
    cats: dict = {}
    for r in rows:
        cats[r["category"]] = cats.get(r["category"], 0) + 1
    return {"rows": len(rows), "by_category": cats, "value_eur": round(sum(r["value_eur"] for r in rows), 2)}
