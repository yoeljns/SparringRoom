"""Truck load planner (§7.5). On-demand job plan_trucks, payload {"order_id"}.

Reads the order's lines (pallets per item = qty / app.units_per_pallet), the pallet weight
from app.pallet_kg, the weight window and item limit from the order's vehicle type (else the
default vehicle type, else resolve_param), the schedule from sales_order.schedule
({"trucks_per_month", "months", "start"}) and the approved load patterns to prefer; then
hands the plan to rpc_apply_truck_plan (one planned shipment per truck).
The nightly run plans confirmed scheduled orders that have no shipment yet.
"""
from __future__ import annotations

import calendar
import math
import os
from datetime import date, timedelta

from .. import db
from ..core.loadplan import plan_trucks


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y, m = d.year + y, m + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _working_day(d: date) -> date:
    return d + timedelta(days={5: 2, 6: 1}.get(d.weekday(), 0))


def normalise_schedule(schedule: dict | None, requested: date) -> tuple[dict | None, list]:
    """sales_order.schedule -> (core schedule, month start dates).

    trucks_per_month is a number (the same every month, for ``months`` months) or a list;
    start is the first shipping date (default: the order's requested date).
    """
    if not schedule or schedule.get("trucks_per_month") in (None, [], 0):
        return None, []
    tpm = schedule["trucks_per_month"]
    months = schedule.get("months")
    if isinstance(tpm, (int, float)):
        n = int(months) if isinstance(months, (int, float)) else (len(months) if months else 1)
        per_month = [int(tpm)] * n
    else:
        per_month = [int(x) for x in tpm]
    start = date.fromisoformat(str(schedule["start"])[:10]) if schedule.get("start") else requested
    starts = [_add_months(start, k) for k in range(len(per_month))]
    core = {"trucks_per_month": per_month, "months": list(range(len(per_month)))}
    if schedule.get("mix_tolerance") is not None:
        core["mix_tolerance"] = float(schedule["mix_tolerance"])
    return core, starts


def truck_dates(per_month: list[int], starts: list[date]) -> dict:
    """Spread each month's trucks evenly over the month: {month index: [dates]}."""
    out = {}
    for k, (n, s) in enumerate(zip(per_month, starts)):
        days = (_add_months(s, 1) - s).days
        out[k] = [_working_day(s + timedelta(days=int(j * days / n))) for j in range(n)] if n else []
    return out


def window(conn, order: dict) -> dict:
    vt = db.one(conn, """select id, code, min_kg, max_kg, max_items from vehicle_type
                          where id = coalesce(%s, (select id from vehicle_type where is_default limit 1))""",
                [order["vehicle_type_id"]]) or {}
    ctx = {"order_id": order["id"], "party_id": order["party_id"], "vehicle_type_id": vt.get("id")}
    out = {"vehicle_type": vt.get("code")}
    for key, col in (("truck_min_kg", "min_kg"), ("truck_max_kg", "max_kg"), ("truck_max_items", "max_items")):
        r = db.resolve_param(conn, key, ctx)
        if vt.get(col) is not None and r["level"] not in ("order_override", "shipment_override", "vehicle_type"):
            r = {"value": vt[col], "level": "vehicle_type"}
        out[col], out[col + "_level"] = float(r["value"]), r["level"]
    out["max_items"] = int(out["max_items"])
    return out


def plan_request(conn, payload: dict) -> dict:
    order = db.one(conn, "select * from sales_order where id = %s", [payload["order_id"]])
    if not order:
        raise ValueError(f"order {payload['order_id']} not found")
    lines = db.query(conn, """
        select l.item_id, i.sku, sum(l.qty) as qty, app.units_per_pallet(l.item_id) as upp, app.pallet_kg(l.item_id) as kg
          from so_line l join item i on i.id = l.item_id
         where l.order_id = %s and not l.is_phantom group by l.item_id, i.sku""", [order["id"]])
    win = window(conn, order)
    pallets, kg, kg_source, by_sku, loose = {}, {}, {}, {}, []
    for l in lines:
        by_sku[l["sku"]] = l["item_id"]
        if not l["upp"] or (l["kg"] or {}).get("kg") is None:
            loose.append({"item_id": l["item_id"], "sku": l["sku"], "qty_base": l["qty"],
                          "reason": "no pallet quantity or pallet weight in the item master"})
            continue
        whole = math.floor(l["qty"] / l["upp"] + 1e-9)
        if whole:
            pallets[l["sku"]] = whole
            kg[l["sku"]], kg_source[l["sku"]] = float(l["kg"]["kg"]), l["kg"]["level"]
        if l["qty"] - whole * l["upp"] > 1e-6:
            loose.append({"item_id": l["item_id"], "sku": l["sku"], "qty_base": l["qty"] - whole * l["upp"],
                          "reason": "less than a full pallet"})
    schedule, starts = normalise_schedule(order["schedule"], order["requested_date"])
    sku_of = {v: k for k, v in by_sku.items()}
    known = []
    for p in db.query(conn, "select id, signature, lines from load_pattern where approved"):
        pl = {sku_of.get(x.get("item_id"), x.get("item_id")): x["pallets"] for x in (p["lines"] or [])}
        known.append({"id": p["id"], "lines": pl})
    res = plan_trucks(pallets, kg, win["min_kg"], win["max_kg"], win["max_items"], known_patterns=known,
                      schedule=schedule, time_limit_s=float(os.environ.get("WORKER_PLAN_TIME_LIMIT_S", "10")))
    dates = truck_dates(schedule["trucks_per_month"], starts) if schedule else {}
    seq: dict = {}
    trucks = []
    for t in res["trucks"]:
        if schedule:
            k = seq.get(t["month"], 0)
            seq[t["month"]] = k + 1
            planned = dates[t["month"]][k]
        else:
            planned = order["requested_date"]
        trucks.append({"planned_date": planned, "signature": t["signature"], "total_kg": round(t["kg"], 3),
                       "lines": [{"item_id": by_sku[l["item"]], "pallets": l["pallets"], "kg": round(l["kg"], 3),
                                  "kg_source": kg_source[l["item"]]} for l in t["lines"]]})
    trucks.sort(key=lambda t: t["planned_date"])
    remainder = [{"item_id": by_sku[s], "sku": s, "pallets": n} for s, n in res["remainder"].items()] + loose
    plan = {"trucks": trucks, "remainder": remainder}
    applied = db.scalar(conn, "select rpc_apply_truck_plan(%s, %s)", [order["id"], db.as_json(plan)])
    return {"order_id": order["id"], "order_no": order["order_no"], "trucks": len(trucks),
            "patterns": res["n_patterns"], "signatures": sorted({t["signature"] for t in trucks}),
            "avg_kg": res["avg_kg"], "planned_dates": [t["planned_date"] for t in trucks], "remainder": remainder,
            "top_up": res["top_up"], "window": win, "solver": dict(res["status"]), "applied": applied}


def run(conn, as_of=None) -> dict:
    """Nightly safety net: plan confirmed scheduled orders that have no shipment yet."""
    orders = db.query(conn, """
        select o.id from sales_order o
         where o.state = 'confirmed' and o.schedule is not null
           and not exists (select 1 from shipment_line sl join so_line l on l.id = sl.so_line_id where l.order_id = o.id)
           and not exists (select 1 from job_queue q where q.kind = 'plan_trucks' and q.state in ('queued', 'running')
                              and q.payload->>'order_id' = o.id::text)""")
    done = [plan_request(conn, {"order_id": o["id"]}) for o in orders]
    return {"orders_planned": len(done), "trucks": sum(d["trucks"] for d in done)}
