"""compute_policy (§8.5): safety stock, reorder point or order-up-to level and order quantity
per item, stored in item_policy for the published plan version (upsert).

Every number used is kept in item_policy.inputs.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import db
from ..core.demand_history import weekly_matrix
from ..core.policy import compute_policies, order_quantity, select_policy, _lcm_float
from ._common import business_date, monday, load_items, load_weekly_history, load_lanes, load_forecast

SD_WEEKS = 52          # weekly demand variability is measured on the last 52 weeks
HIST_WEEKS = 104       # history used by the empirical (bootstrap) policy


def build(conn, as_of, lead_time_override: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """Policy frame for every forecast item. lead_time_override: {lane_id: (mean_days, sd_days|None)}
    (scenario runs). Returns (frame indexed by item_id, context)."""
    week0 = monday(as_of)
    plan = db.current_plan(conn)
    frun = db.current_run(conn, "forecast_run")
    if not frun:
        raise RuntimeError("no current forecast run")
    crun = db.current_run(conn, "classification_run")
    fc = load_forecast(conn, frun["id"])
    items = load_items(conn).reindex(fc.index)
    lanes = load_lanes(conn)
    cls = {r["item_id"]: r for r in db.query(conn, "select * from v_item_class")}
    hist = load_weekly_history(conn, week0)
    wide = weekly_matrix(hist, "total", week0).reindex(fc.index, fill_value=0.0) if len(hist) else \
        pd.DataFrame(0.0, index=fc.index, columns=[pd.Timestamp(week0) - pd.Timedelta(weeks=1)])
    review_default = db.item_params(conn, "review_period_days")
    mrsl = db.item_params(conn, "mrsl_days")
    holding = db.resolve_param(conn, "holding_cost_pct_year")
    freight = db.resolve_param(conn, "freight_eur_per_truck")
    truck_max = db.resolve_param(conn, "truck_max_kg")
    sl_default = db.resolve_param(conn, "service_level")

    rows = []
    for item_id in fc.index:
        it, lane, c = items.loc[item_id], lanes.get(item_id), cls.get(item_id) or {}
        abc, xyz, pattern = c.get("abc", "C"), c.get("xyz", "Z"), c.get("pattern") or "none"
        service_class = c.get("service_class") or (abc + xyz)
        sl = db.resolve_param(conn, "service_level", {"item_id": item_id, "class": service_class})
        if sl["value"] is None:
            sl = sl_default
        sel = select_policy(it["family_code"], abc, xyz, pattern, export_contract=bool(it["export_contract"]),
                            default_policy=it["default_policy"])
        policy = sel["policy"] if lane and not it["is_phantom"] else "to_order"
        if lane:
            mean_days = lane["mean_days"] if lane["mean_days"] is not None else lane["quoted_lt_days"]
            sd_days = lane["sd_days"] if lane["sd_days"] is not None else 0.25 * mean_days
            if lead_time_override and lane["lane_id"] in lead_time_override:
                new_mean, new_sd = lead_time_override[lane["lane_id"]]
                sd_days = new_sd if new_sd is not None else sd_days * (new_mean / mean_days if mean_days else 1.0)
                mean_days = new_mean
            rv = review_default.get(item_id) or {}
            review_days = lane["review_days"] if lane["review_days"] is not None else float(rv.get("value") or 7)
        else:
            mean_days = sd_days = review_days = 0.0
        L, sd_L = mean_days / 7.0, sd_days / 7.0
        R = 0.0 if policy in ("continuous", "to_order") else max(review_days / 7.0, 1.0)
        f = fc.loc[item_id].to_numpy(float)
        n_d = int(min(len(f), max(13, math.ceil(L + R))))
        d = float(f[:n_d].mean()) if n_d else 0.0
        y = wide.loc[item_id].to_numpy(float)[-SD_WEEKS:]
        sd_d = float(np.std(y, ddof=1)) if y.size > 1 else 0.0
        upp = float(it["units_per_pallet"]) if pd.notna(it["units_per_pallet"]) else 1.0
        rows.append({"item_id": item_id, "policy": policy, "d": d, "sd_d": sd_d, "L": L, "sd_L": sd_L, "R": R,
                     "service_level": float(sl["value"]), "unit": upp, "review_days": review_days,
                     "lt_mean_days": mean_days, "lt_sd_days": sd_days, "abc": abc, "xyz": xyz, "pattern": pattern,
                     "service_class": service_class, "service_level_level": sl["level"],
                     "service_level_source_id": sl["source_id"], "demand_weeks": n_d,
                     "review_days_level": "supplier_lane" if lane and lane["review_days"] is not None
                     else (review_default.get(item_id) or {}).get("level")})
    frame = pd.DataFrame(rows).set_index("item_id")
    hist_mat = wide.reindex(frame.index).to_numpy(float)[:, -HIST_WEEKS:]
    frame = compute_policies(frame, hist_mat)

    # order quantity: max(economic quantity, MOQ) -> pallets / order multiple -> full truck -> expiry cap
    holding_rate = float(holding["value"] or 0) / 100.0
    freight_eur = float(freight["value"] or 0)
    max_kg = float(truck_max["value"] or 0)
    extra = {}
    for item_id, r in frame.iterrows():
        it, lane = items.loc[item_id], lanes.get(item_id)
        if r["policy"] == "to_order" or not lane:
            extra[item_id] = {"order_qty": None, "steps": {}}
            continue
        upp = float(r["unit"])
        cost = float(it["cost_eur"]) if pd.notna(it["cost_eur"]) else 0.0
        economic = r["d"] * max(r["R"], 1.0)            # demand of one review cycle (one week when continuous)
        kg = float(it["pallet_kg"]) if pd.notna(it["pallet_kg"]) else None
        truck_qty = None
        if lane["mode"] != "production" and kg and max_kg:
            truck_qty = math.floor(max_kg / kg + 1e-9) * upp
        moq = float(lane["moq"] or 0.0)
        mult = float(lane["order_multiple"] or 0.0)
        # whole pallets and the order multiple together only when a common multiple of at most
        # 5 pallets exists; otherwise the supplier's order multiple decides
        pallet_unit = upp
        if mult > 0 and _lcm_float(upp, mult) > 5 * max(upp, mult) + 1e-9:
            pallet_unit = 0.0
        common = dict(weekly_demand=float(r["d"]), economic_qty=float(economic), moq=moq, pallet_qty=pallet_unit,
                      order_multiple=mult, unit_cost=cost, holding_rate=holding_rate,
                      expiry_controlled=bool(it["lot_expiry_controlled"]),
                      shelf_life_days=float(it["shelf_life_days"]) if pd.notna(it["shelf_life_days"]) else None,
                      mrsl_days=float((mrsl.get(item_id) or {}).get("value") or 0))
        freight_saved = 0.0
        if truck_qty:                                    # freight paid for the empty part of the last truck
            part = order_quantity(**common)["rounded"] % truck_qty
            freight_saved = freight_eur * ((truck_qty - part) / truck_qty if part > 1e-9 else 0.0)
        oq = order_quantity(**common, truck_qty=truck_qty, freight_saved_per_truck=freight_saved)
        qty = oq.pop("qty")
        extra[item_id] = {"order_qty": qty, "steps": {
            **oq, "economic_qty": economic, "economic_qty_basis": "forecast demand of one review cycle",
            "moq": moq, "order_multiple": mult, "units_per_pallet": upp, "truck_qty": truck_qty,
            "rounding": "pallets and order multiple" if pallet_unit and mult else ("order multiple" if mult else "pallets"),
            "pallet_kg": kg, "truck_max_kg": max_kg, "unit_cost_eur": cost, "holding_cost_pct_year": holding["value"],
            "freight_eur_per_truck": freight["value"], "shelf_life_days": it["shelf_life_days"],
            "mrsl_days": (mrsl.get(item_id) or {}).get("value"), "mrsl_level": (mrsl.get(item_id) or {}).get("level")}}
    ctx = {"plan": plan, "forecast_run": frun, "classification_run": crun, "lanes": lanes, "items": items,
           "extra": extra, "param_version": db.param_version(conn), "week0": week0, "forecast": fc}
    return frame, ctx


def policy_rows(frame: pd.DataFrame, ctx: dict, plan_version_id) -> list[dict]:
    def num(v, nd=3):
        return None if v is None or (isinstance(v, float) and not np.isfinite(v)) else round(float(v), nd)

    rows = []
    for item_id, r in frame.iterrows():
        lane = ctx["lanes"].get(item_id) or {}
        ex = ctx["extra"][item_id]
        to_order = r["policy"] == "to_order"
        inputs = {
            "policy": r["policy"], "abc": r["abc"], "xyz": r["xyz"], "pattern": r["pattern"],
            "service_class": r["service_class"], "service_level": r["service_level"],
            "service_level_level": r["service_level_level"], "service_level_source_id": r["service_level_source_id"],
            "z": None if to_order else r["z"], "d_week": r["d"], "demand_weeks_averaged": r["demand_weeks"],
            "sd_d_week": r["sd_d"], "sd_d_basis": f"weekly demand, last {SD_WEEKS} weeks",
            "lead_time_weeks": r["L"], "lead_time_sd_weeks": r["sd_L"], "lead_time_days": r["lt_mean_days"],
            "lead_time_sd_days": r["lt_sd_days"], "lead_time_source": lane.get("stat_source"),
            "lead_time_stat_id": lane.get("stat_id"), "supplier_lane_id": lane.get("lane_id"),
            "supplier_id": lane.get("supplier_id"), "production_line": lane.get("production_line"),
            "review_weeks": r["R"], "review_days": r["review_days"], "review_days_level": r["review_days_level"],
            "safety_stock_unit": r["unit"], "safety_stock": r["safety_stock"], "rop": r["rop"],
            "order_up_to": r["order_up_to"], "order_qty": ex["order_qty"], "order_qty_steps": ex["steps"],
            "forecast_run_id": ctx["forecast_run"]["id"],
            "classification_run_id": (ctx["classification_run"] or {}).get("id"),
            "param_version": ctx["param_version"],
        }
        rows.append({
            "plan_version_id": plan_version_id, "item_id": item_id, "policy": r["policy"],
            "service_level": num(r["service_level"], 4), "z": None if to_order else num(r["z"], 4),
            "d_mean": num(r["d"]), "sd_d": num(r["sd_d"]), "lt_mean_days": num(r["lt_mean_days"], 2),
            "lt_sd_days": num(r["lt_sd_days"], 2), "review_days": int(round(r["review_days"])) if r["R"] else None,
            "safety_stock": num(r["safety_stock"]), "rop": num(r["rop"]), "order_up_to": num(r["order_up_to"]),
            "order_qty": num(ex["order_qty"]), "inputs": inputs})
    return rows


def write(conn, rows: list[dict]) -> None:
    cols = [c for c in rows[0] if c not in ("plan_version_id", "item_id")]
    sets = ", ".join(f"{c} = excluded.{c}" for c in cols)
    for r in rows:
        keys = list(r)
        db.execute(conn, f"""insert into item_policy ({', '.join(keys)}) values ({', '.join(['%s'] * len(keys))})
                             on conflict (plan_version_id, item_id) do update set {sets}, created_at = now()""",
                   [r[k] for k in keys])


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    frame, ctx = build(conn, as_of)
    rows = policy_rows(frame, ctx, ctx["plan"]["id"])
    write(conn, rows)
    return {"plan_version_id": ctx["plan"]["id"], "items": len(rows),
            "policies": frame["policy"].value_counts().to_dict(),
            "forecast_run_id": ctx["forecast_run"]["id"]}
