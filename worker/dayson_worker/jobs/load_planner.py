"""Truck load planner job (§7.5): plans a shipment's trucks; also serves on-demand `plan_trucks`."""
from __future__ import annotations

from .. import db
from ..core.loadplan import plan_trucks, DEFAULT_MIN_KG, DEFAULT_MAX_KG, DEFAULT_MAX_ITEMS


def plan_request(conn, payload: dict) -> dict:
    """On-demand kind `plan_trucks`.

    payload: {"order": {item_id: pallets}} or {"sales_order_id": ...}; optional kg_per_pallet,
    vehicle_type_id, schedule {"trucks_per_month": [...], "mix_tolerance": 0.1}, time_limit_s.
    """
    order = payload.get("order")
    if order is None:
        # SCHEMA: so_line(sales_order_id, item_id, qty, shipped_qty); pack_config(item_id, units_per_pallet, is_default)
        rows = db.query(conn, """
            select l.item_id, ceil(sum(l.qty - l.shipped_qty) / max(pc.units_per_pallet))::int as pallets
              from so_line l join pack_config pc on pc.item_id = l.item_id and pc.is_default
             where l.sales_order_id = %s group by 1 having sum(l.qty - l.shipped_qty) > 0""",
                        [payload["sales_order_id"]])
        order = {str(r["item_id"]): r["pallets"] for r in rows}
    kg = dict(payload.get("kg_per_pallet") or {})
    need = [i for i in order if i not in kg]
    if need:
        # pallet weight chain (§3.8): weighed pallet / lot actual are used at loading; planning uses pack config
        rows = db.query(conn, "select item_id, gross_kg from pack_config where is_default and item_id = any(%s)", [need])
        kg.update({str(r["item_id"]): float(r["gross_kg"]) for r in rows})
    window = {"min_kg": DEFAULT_MIN_KG, "max_kg": DEFAULT_MAX_KG, "max_items": DEFAULT_MAX_ITEMS, "max_positions": None}
    if payload.get("vehicle_type_id"):
        # SCHEMA: vehicle_type(id, code, min_kg, max_kg, positions jsonb (by pallet type), max_items)
        v = db.query(conn, "select min_kg, max_kg, max_items, positions from vehicle_type where id = %s",
                     [payload["vehicle_type_id"]])
        if v:
            pos = v[0]["positions"]
            window = {"min_kg": float(v[0]["min_kg"]), "max_kg": float(v[0]["max_kg"]),
                      "max_items": int(v[0]["max_items"]),
                      "max_positions": (min(pos.values()) if isinstance(pos, dict) and pos else pos) or None}
    # SCHEMA: load_pattern(id, signature, lines jsonb {item_id: pallets}, total_kg, times_used)
    known = db.query(conn, "select id, lines from load_pattern order by times_used desc limit 50")
    return plan_trucks(order, kg, known_patterns=[{"id": str(k["id"]), "lines": k["lines"]} for k in known],
                       schedule=payload.get("schedule"), time_limit_s=float(payload.get("time_limit_s", 10)), **window)


def run(conn, as_of=None) -> dict:
    """Nightly: (re)plan confirmed orders that have no truck plan yet and store it as an alert payload.

    Writing truck_load rows is left to the back office's rpc on approval of the plan.
    """
    # SCHEMA: sales_order(id, state); shipment(sales_order_id*) — orders without a planned shipment
    todo = db.query(conn, """
        select o.id from sales_order o
         where o.state = 'confirmed' and not exists (select 1 from shipment s where s.sales_order_id = o.id)""")
    planned = 0
    for o in todo:
        plan = plan_request(conn, {"sales_order_id": o["id"]})
        if plan["remainder"]:
            db.raise_alert(conn, "truck_plan_remainder", "warning", f"sales_order:{o['id']}",
                           {"remainder": plan["remainder"], "top_up": plan["top_up"]})
        # SCHEMA: truck_plan(sales_order_id, plan jsonb, created_at)*  (not in §3; proposal before truck_load rows exist)
        db.insert_rows(conn, "truck_plan", [{"sales_order_id": o["id"], "plan": plan}])
        planned += 1
    return {"orders_planned": planned}
