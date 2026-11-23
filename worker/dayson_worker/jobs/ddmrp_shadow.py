"""ddmrp_shadow (§8.9, phase 5): demand-driven buffers in shadow for the families named in
planning_param ddmrp_families (the sealant family). Nothing is ordered from these rows; they
are stored next to the classic policy so the two can be compared.
"""
from __future__ import annotations

import pandas as pd

from .. import db
from ..core.ddmrp import buffer_zones, order_recommendation, planned_adjustment_factor
from ._common import business_date, load_items, load_lanes, load_stock, load_forecast

ADU_WEEKS = 13


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    families = db.param(conn, "ddmrp_families", default=[])
    if isinstance(families, str):
        families = [families]
    if not families:
        return {"skipped": "planning_param ddmrp_families is empty"}
    frun = db.current_run(conn, "forecast_run")
    if not frun:
        raise RuntimeError("no current forecast run")
    plan = db.current_plan(conn)
    base = load_forecast(conn, frun["id"], "base")
    camp = load_forecast(conn, frun["id"], "campaign_delta")
    items, lanes, stock = load_items(conn), load_lanes(conn), load_stock(conn)
    policies = {r["item_id"]: r for r in db.query(conn, "select * from item_policy where plan_version_id = %s",
                                                  [plan["id"]])}
    ltf = db.item_params(conn, "ddmrp_lead_time_factor")
    vf = db.item_params(conn, "ddmrp_variability_factor")
    rows = []
    for item_id in base.index:
        it = items.loc[item_id]
        lane = lanes.get(item_id)
        if it["family_code"] not in families or not lane or it["is_phantom"]:
            continue
        b = float(base.loc[item_id].iloc[:ADU_WEEKS].sum())
        c = float(camp.loc[item_id].iloc[:ADU_WEEKS].sum()) if item_id in camp.index else 0.0
        adu = b / (ADU_WEEKS * 7.0)
        dlt = float(lane["mean_days"] if lane["mean_days"] is not None else lane["quoted_lt_days"])
        f_lt = float((ltf.get(item_id) or {}).get("value") or 0.5)
        f_var = float((vf.get(item_id) or {}).get("value") or 0.5)
        cycle = float(lane["review_days"] or 7)
        zones = buffer_zones(adu, dlt, f_lt, f_var, moq=float(lane["moq"] or 0.0), order_cycle_days=cycle,
                             paf=planned_adjustment_factor(b, c))
        st = stock.loc[item_id]
        rec = order_recommendation(zones, float(st["on_hand"]), float(st["on_order"]), float(st["reserved"]))
        pol = policies.get(item_id) or {}
        cost = float(it["cost_eur"]) if pd.notna(it["cost_eur"]) else 0.0
        classic_avg = float(pol.get("safety_stock") or 0.0) + float(pol.get("order_qty") or 0.0) / 2.0
        ddmrp_avg = zones["red"] + zones["green"] / 2.0
        rows.append({"as_of": as_of, "item_id": item_id, "adu": round(adu, 3), "dlt_days": round(dlt, 2),
                     "red": round(zones["red"], 3), "yellow": round(zones["yellow"], 3),
                     "green": round(zones["green"], 3), "on_hand": float(st["on_hand"]),
                     "net_flow": round(rec["net_flow_position"], 3), "zone": rec["zone"],
                     "suggested_qty": round(rec["order_qty"], 3),
                     "metrics": {"paf": zones["paf"], "lead_time_factor": f_lt, "variability_factor": f_var,
                                 "order_cycle_days": cycle, "moq": lane["moq"], "on_order": float(st["on_order"]),
                                 "qualified_demand": float(st["reserved"]), "top_of_green": zones["top_of_green"],
                                 "classic": {"policy": pol.get("policy"), "safety_stock": pol.get("safety_stock"),
                                             "order_qty": pol.get("order_qty"), "avg_stock": classic_avg,
                                             "avg_stock_value_eur": round(classic_avg * cost, 2)},
                                 "ddmrp": {"avg_stock": ddmrp_avg, "avg_stock_value_eur": round(ddmrp_avg * cost, 2)},
                                 "fill_rate": None, "forecast_run_id": frun["id"]}})
    for r in rows:
        keys = list(r)
        db.execute(conn, f"""insert into ddmrp_buffer ({', '.join(keys)}) values ({', '.join(['%s'] * len(keys))})
                             on conflict (as_of, item_id) do update set
                             {', '.join(f'{k} = excluded.{k}' for k in keys if k not in ('as_of', 'item_id'))}""",
                   [r[k] for k in keys])
    zones_n: dict = {}
    for r in rows:
        zones_n[r["zone"]] = zones_n.get(r["zone"], 0) + 1
    return {"families": families, "buffers": len(rows), "zones": zones_n}
