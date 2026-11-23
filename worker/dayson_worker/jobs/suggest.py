"""suggest (§8.6): replenishment suggestions and the weekly stock projection for the published plan.

Projected available = on hand + on order - reservations - forecast. Continuous items are
suggested when that falls below the reorder point, periodic and empirical items at each
review date up to S. Purchase suggestions are grouped into one order per supplier and
release date and shown against the lane's MOQ and price breaks. Dealer stock estimates are
never an input (§10.3). Older still-proposed suggestions of the same plan and item are
marked superseded.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import timedelta

import numpy as np

from .. import db
from ..core.simulate import projected_stock
from ..core.suggest import suggest_for_item, group_by_supplier
from ._common import business_date, monday, load_items, load_lanes, load_stock, load_receipts, load_forecast, policy_dict


def capacity_by_week(conn, week_starts) -> dict:
    """{production line: [pallets of capacity per forecast week]}."""
    rows = db.query(conn, """
        select line, app.week_start(date) as week, sum(pallets_per_day) as pallets from capacity_calendar
         where date >= %s group by 1, 2""", [week_starts[0]])
    idx = {w: i for i, w in enumerate(week_starts)}
    out: dict = {}
    for r in rows:
        if r["week"] in idx:
            out.setdefault(r["line"], [0.0] * len(week_starts))[idx[r["week"]]] = r["pallets"]
    return out


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    week0 = monday(as_of)
    plan = db.current_plan(conn)
    frun = db.current_run(conn, "forecast_run")
    if not frun:
        raise RuntimeError("no current forecast run")
    fc = load_forecast(conn, frun["id"])
    camp = load_forecast(conn, frun["id"], "campaign_delta")
    week_starts = [w if not hasattr(w, "date") else w for w in fc.columns]
    items = load_items(conn)
    lanes = load_lanes(conn)
    stock = load_stock(conn)
    receipts = load_receipts(conn, week_starts)
    capacity = capacity_by_week(conn, week_starts)
    policies = {r["item_id"]: r for r in db.query(conn, "select * from item_policy where plan_version_id = %s",
                                                  [plan["id"]])}
    pv = db.param_version(conn)
    n = len(week_starts)

    suggestions, projection = [], []
    for item_id in fc.index:
        prow = policies.get(item_id)
        if not prow:
            continue
        pol = policy_dict(prow)
        st = stock.loc[item_id] if item_id in stock.index else {"on_hand": 0.0, "reserved": 0.0, "on_order": 0.0}
        f = fc.loc[item_id].to_numpy(float)
        rec = np.asarray(receipts.get(item_id, [0.0] * n), float)
        proj = projected_stock(float(st["on_hand"]), rec, f)
        ss = float(pol["safety_stock"] or 0.0)
        for w, q in zip(week_starts, proj):
            projection.append({"plan_version_id": plan["id"], "item_id": item_id, "week": w,
                               "projected_qty": round(float(q), 3), "safety_stock": round(ss, 3),
                               "below_safety": bool(q < ss)})
        lane = lanes.get(item_id)
        if pol["policy"] == "to_order" or not lane:
            continue
        L, R = float(pol["L"] or 0.0), float(pol["R"] or 0.0)
        inp = prow["inputs"] or {}
        supply = "production" if lane["mode"] == "production" else "purchase"
        refs = {"forecast_run_id": frun["id"], "lead_time_stat_id": lane["stat_id"],
                "lead_time_source": lane["stat_source"], "lead_time_days": prow["lt_mean_days"],
                "lead_time_sd_days": prow["lt_sd_days"], "classification_run_id": inp.get("classification_run_id"),
                "service_class": inp.get("service_class"), "service_level_level": inp.get("service_level_level"),
                "param_version": pv, "plan_version_id": plan["id"], "item_policy_id": prow["id"],
                "supplier_lane_id": lane["lane_id"], "units_per_pallet": items.at[item_id, "units_per_pallet"],
                "order_qty_steps": inp.get("order_qty_steps"), "as_of": as_of,
                "horizon_weeks": int(min(n, math.ceil(L + R) + 1))}
        sug = suggest_for_item(
            item_id=item_id, policy=pol, forecast=f, week_starts=week_starts, on_hand=float(st["on_hand"]),
            on_order=float(st["on_order"]), reservations=float(st["reserved"]),
            order_qty=float(prow["order_qty"] or 0.0), lead_time_weeks=L, review_weeks=max(R, 1.0),
            order_multiple=float(lane["order_multiple"] or 0.0), moq=float(lane["moq"] or 0.0),
            supply_type=supply, refs=refs, horizon_weeks=refs["horizon_weeks"])
        cdelta = camp.loc[item_id].to_numpy(float) if item_id in camp.index else np.zeros(n)
        for s in sug:
            w = week_starts.index(s["release_date"])
            cover_to = min(n, w + int(math.ceil(L + R)) + 1)
            campaign_qty = float(np.clip(cdelta[:cover_to], 0, None).sum())
            s["reason"] = "campaign_prebuild" if campaign_qty > 0 else ("rop" if pol["policy"] == "continuous" else "review")
            s["inputs"]["campaign_delta_in_cover"] = campaign_qty
            s["supplier_id"], s["supplier_lane_id"] = lane["supplier_id"], lane["lane_id"]
            s["group_key"] = f"{lane['supplier_id'] or lane['production_line']}:{s['release_date']}"
            if supply == "production" and lane["production_line"] in capacity:
                cap = capacity[lane["production_line"]]
                upp = float(items.at[item_id, "units_per_pallet"] or 1.0)
                s["inputs"]["capacity_pallets_until_need"] = float(sum(cap[w:cover_to]))
                s["inputs"]["pallets"] = s["qty"] / upp
        suggestions += sug

    # one order per supplier per release date, against MOQ and price breaks
    by_supplier = [s for s in suggestions if s["supplier_id"]]
    lane_by_supplier = {}
    for s in by_supplier:
        l = lanes[s["item_id"]]
        lane_by_supplier.setdefault(l["supplier_id"], {"moq": l["moq"], "price_breaks": l["price_breaks"]})
    groups = {(g["supplier_id"], g["release_date"]): g
              for g in group_by_supplier(by_supplier, {s["item_id"]: s["supplier_id"] for s in by_supplier},
                                         lane_by_supplier)}
    line_total = defaultdict(float)
    for s in suggestions:
        if not s["supplier_id"]:
            line_total[s["group_key"]] += s["qty"]
    for s in suggestions:
        g = groups.get((s["supplier_id"], s["release_date"]))
        s["inputs"]["group"] = ({k: g[k] for k in ("total_qty", "moq", "moq_met", "moq_shortfall", "price_break",
                                                   "next_price_break", "qty_to_next_break")} | {"lines": len(g["lines"])}
                                if g else {"total_qty": line_total[s["group_key"]]})

    superseded = db.execute(conn, """
        update replenishment_suggestion set state = 'superseded'
         where state = 'proposed' and plan_version_id = %s""", [plan["id"]])
    db.insert_rows(conn, "replenishment_suggestion", [{
        "plan_version_id": plan["id"], "item_id": s["item_id"], "type": s["type"], "reason": s["reason"],
        "qty": round(s["qty"], 3), "need_date": s["need_date"], "release_date": s["release_date"],
        "supplier_id": s["supplier_id"], "supplier_lane_id": s["supplier_lane_id"], "group_key": s["group_key"],
        "inputs": s["inputs"], "state": "proposed"} for s in suggestions if s["qty"] > 0])
    db.execute(conn, "delete from stock_projection where plan_version_id = %s", [plan["id"]])
    db.insert_rows(conn, "stock_projection", projection)
    return {"plan_version_id": plan["id"], "suggestions": len(suggestions), "superseded": superseded,
            "purchase": sum(s["type"] == "purchase" for s in suggestions),
            "production": sum(s["type"] == "production" for s in suggestions),
            "order_groups": len({s["group_key"] for s in suggestions}),
            "projection_rows": len(projection), "items_below_safety": len({p["item_id"] for p in projection if p["below_safety"]})}
