"""Scenario sandbox (§9.7): on-demand jobs simulate_campaign and simulate_scenario.

simulate_campaign  payload {"campaign_id"}: campaign_forecast rows from every mechanic's
    demand_effect and the uplift library, a scenario plan_version on top of the published
    plan, the sandbox for the affected items, then rpc_campaign_simulation_done.
simulate_scenario  payload {"lead_time_change": {"supplier_lane_id", "days" | "delta_days"[, "sd_days"]}}
    or {"demand_change": {"item_ids" | "family", "pct"[, "weeks"]}}: a scenario plan_version;
    the result is returned (and stored in job_queue.result).
"""
from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

import mechanics
from mechanics._base import match_item_rule

from .. import db
from ..core.simulate import simulate
from . import campaign_common as cc
from . import compute_policy
from ._common import (business_date, load_items, load_lanes, load_stock, load_receipts, load_forecast, policy_dict)


# ------------------------------------------------------------------ sandbox
def sandbox_items(conn, item_ids, exclude_campaign=None) -> tuple[dict, list]:
    """Baseline data of the published plan for the affected items (core.simulate.simulate_item)."""
    plan = db.current_plan(conn)
    frun = db.current_run(conn, "forecast_run")
    fc = load_forecast(conn, frun["id"])
    weeks = list(fc.columns)
    items, lanes, stock = load_items(conn), load_lanes(conn), load_stock(conn)
    receipts = load_receipts(conn, weeks)
    policies = {r["item_id"]: r for r in db.query(conn, "select * from item_policy where plan_version_id = %s",
                                                  [plan["id"]])}
    fences: dict = {}
    for r in db.query(conn, """
        select campaign_id, item_id, need_date, sum(qty_base) as qty from reservation
         where campaign_id is not null and demand_line_id is null and state = 'active' and type = 'soft'
           and campaign_id is distinct from %s group by 1, 2, 3""", [exclude_campaign]):
        idx = max(0, min(len(weeks) - 1, ((r["need_date"] or weeks[0]) - weeks[0]).days // 7))
        fences.setdefault(r["item_id"], []).append({"campaign_id": r["campaign_id"], "week_idx": idx, "qty": r["qty"]})
    out = {}
    for i in item_ids:
        if i not in fc.index or i not in policies:
            continue
        p, lane, it = policies[i], lanes.get(i) or {}, items.loc[i]
        pol = policy_dict(p)
        st = stock.loc[i]
        out[i] = {
            "on_hand": float(st["on_hand"]), "on_order": float(st["on_order"]),
            "receipts": receipts.get(i, [0.0] * len(weeks)), "forecast": fc.loc[i].to_numpy(float),
            "week_starts": weeks, "policy": pol, "lead_time_weeks": float(pol["L"] or 0.0),
            "order_qty": float(p["order_qty"] or 0.0), "review_weeks": max(float(pol["R"] or 0.0), 1.0),
            "order_multiple": float(lane.get("order_multiple") or 0.0),
            "units_per_pallet": float(it["units_per_pallet"]) if pd.notna(it["units_per_pallet"]) else 1.0,
            "kg_per_pallet": float(it["pallet_kg"]) if pd.notna(it["pallet_kg"]) else None,
            "amber_qty": float(st["amber_qty"]), "ring_fences": fences.get(i, []),
            "supply_type": "production" if lane.get("mode") == "production" else "purchase",
            "sku": it["sku"]}
    return out, weeks


def truck_window(conn) -> dict:
    vt = db.one(conn, "select min_kg, max_kg, max_items from vehicle_type where is_default limit 1") or {}
    return {"min_kg": vt.get("min_kg") or db.param_num(conn, "truck_min_kg"),
            "max_kg": vt.get("max_kg") or db.param_num(conn, "truck_max_kg"),
            "max_items": int(vt.get("max_items") or db.param_num(conn, "truck_max_items", default=5))}


def compact(result: dict, base: dict) -> dict:
    """Sandbox output as stored: per item the numbers of §9.7, suggestions without their input dump."""
    items = []
    for r in result["items"]:
        r = dict(r)
        r["sku"] = base[r["item_id"]]["sku"]
        r["suggestions"] = [{"release_date": s["release_date"], "need_date": s["need_date"], "qty": s["qty"],
                             "type": s["type"]} for s in r["suggestions"]]
        items.append(r)
    return {"summary": result["summary"], "items": items}


def create_scenario(conn, name: str, context: dict) -> tuple:
    plan = db.current_plan(conn)
    sid = db.insert_one(conn, "plan_version", {
        "name": name, "base_version_id": plan["id"], "kind": "scenario", "state": "draft",
        "param_version": db.param_version(conn), "context": context})
    return sid, plan


def write_projection(conn, scenario_id, result: dict, weeks: list) -> int:
    rows = []
    for r in result["items"]:
        for w, q in zip(weeks, r["projected"]):
            rows.append({"plan_version_id": scenario_id, "item_id": r["item_id"], "week": w,
                         "projected_qty": round(float(q), 3), "safety_stock": round(float(r["safety_stock"]), 3),
                         "below_safety": bool(q < r["safety_stock"])})
    db.insert_rows(conn, "stock_projection", rows)
    return len(rows)


# ----------------------------------------------------------------- campaign
def campaign_effect(conn, campaign: dict, base: pd.DataFrame, items: pd.DataFrame) -> dict:
    """Run every mechanic's demand_effect. Returns {"cells": {(item, week): {...}}, "window", "notes"}."""
    weeks = list(base.columns)
    d_from = campaign["deliver_from"] or campaign["order_from"]
    d_to = campaign["deliver_to"] or campaign["order_to"]
    window = [w for w in weeks if w + timedelta(days=6) >= d_from and w <= d_to]
    notes = []
    if not window:
        notes.append("the campaign window is outside the 26-week forecast horizon; no demand effect was computed")
    in_scope = [i for i in cc.scope_items(conn, campaign["id"]) if i in base.index]
    parties = cc.scope_parties(conn, campaign["id"])
    facts = cc.item_facts(items)
    lib = cc.library(conn)
    sis = cc.sisters(items.loc[base.index])
    baseline = [{"item_id": i, "week": w, "qty": float(base.at[i, w])} for i in base.index for w in weeks]

    # share of the scoped items' demand that comes from eligible parties (last 52 weeks)
    share = 1.0
    if cc.limits_eligibility(campaign) and in_scope:
        r = db.one(conn, """
            select coalesce(sum(qty_paid + qty_free) filter (where party_id = any(%s::uuid[])), 0) as elig,
                   coalesce(sum(qty_paid + qty_free), 0) as total
              from demand_history where item_id = any(%s::uuid[]) and week >= %s""",
                   [[p["id"] for p in parties], in_scope, weeks[0] - timedelta(weeks=52)])
        share = r["elig"] / r["total"] if r["total"] > 0 else 0.0
    orders_per_week = db.scalar(conn, """
        select count(*)::numeric / 26 from (
          select distinct party_id, week from demand_history
           where party_id = any(%s::uuid[]) and item_id = any(%s::uuid[]) and week >= %s and qty_paid > 0) x""",
                                [[p["id"] for p in parties], in_scope, weeks[0] - timedelta(weeks=26)]) or 0.0
    dealers_by_segment: dict = {}
    for p in parties:
        if p["type"] == "dealer":
            dealers_by_segment[p["segment"]] = dealers_by_segment.get(p["segment"], 0) + 1

    cells: dict = {}
    used = []
    for m in campaign["mechanics"]:
        code = m["mechanic_type"]
        mod = mechanics.get(code)
        errs = mod.validate(m["params"])
        if errs:
            raise ValueError(f"{code}: {'; '.join(errs)}")
        params = cc.prepare_params(conn, code, m["params"], items)
        ids = in_scope
        if code == "buy_x_get_y":
            ids = [i for i in in_scope if match_item_rule(params["buy_item_rule"], facts[i])]
        elif code == "mixed_set":
            ids = [r["component_item_id"] for r in db.query(
                conn, "select component_item_id from bundle_line where bundle_id = %s", [params["bundle_id"]])]
        elif code == "export_push":
            ids = params["items"]
        fams = {items.at[i, "family_id"] for i in ids if i in items.index}
        scope = {"item_ids": ids or ["-"], "weeks": window, "family_id": next(iter(fams)) if len(fams) == 1 else None,
                 "segment": cc.single_segment(campaign), "sisters": sis, "post_weeks": cc.POST_WEEKS,
                 "eligible_share": share, "dealers_by_segment": dealers_by_segment,
                 "expected_orders": {w: float(orders_per_week) for w in window}}
        rows = mod.demand_effect(baseline, scope, params, lib)
        used.append({"mechanic_type": code, "band": mod.prior_band(params), "items": len(ids),
                     "prior_ids": sorted({r["prior_id"] for r in rows if r.get("prior_id")})})
        for r in rows:
            if r["week"] not in weeks:
                continue
            c = cells.setdefault((r["item_id"], r["week"]), {"uplift": 0.0, "pull_forward": 0.0, "cannibalised": 0.0,
                                                             "free_qty": 0.0, "prior_id": None})
            free = float(r.get("free_qty") or 0.0)
            c["uplift"] += float(r["uplift"]) - free
            c["free_qty"] += free
            c["pull_forward"] += float(r["pull_forward"])
            c["cannibalised"] += float(r["cannibalised"])
            c["prior_id"] = c["prior_id"] or r.get("prior_id")
    if not any(u["prior_ids"] for u in used) and window:
        notes.append("no uplift_library prior matched; paid uplift is zero")
    return {"cells": cells, "window": window, "notes": notes, "in_scope": in_scope, "eligible_share": share,
            "mechanics": used, "weeks": weeks}


def write_campaign_forecast(conn, campaign: dict, eff: dict, base: pd.DataFrame) -> list[dict]:
    """Replace the campaign's forecast rows; a planner's override on a week is kept."""
    weeks, window = eff["weeks"], eff["window"]
    keep = {(r["item_id"], r["week"]): r["override"] for r in db.query(
        conn, "select item_id, week, override from campaign_forecast where campaign_id = %s and override is not null",
        [campaign["id"]])}
    span = set()
    if window:
        lo, hi = weeks.index(window[0]), weeks.index(window[-1])
        span = set(weeks[max(0, lo - cc.PRE_WEEKS): hi + 1 + cc.POST_WEEKS])
    keys = set(eff["cells"]) | {(i, w) for i in eff["in_scope"] for w in span}
    rows = []
    for item_id, week in sorted(keys, key=lambda k: (k[0], k[1])):
        c = eff["cells"].get((item_id, week), {})
        rows.append({"campaign_id": campaign["id"], "item_id": item_id, "week": week,
                     "baseline": round(float(base.at[item_id, week]), 3) if item_id in base.index else 0.0,
                     "uplift": round(c.get("uplift", 0.0), 3), "pull_forward": round(c.get("pull_forward", 0.0), 3),
                     "cannibalised": round(c.get("cannibalised", 0.0), 3), "free_qty": round(c.get("free_qty", 0.0), 3),
                     "prior_id": c.get("prior_id"), "override": keep.get((item_id, week))})
    db.execute(conn, "delete from campaign_forecast where campaign_id = %s", [campaign["id"]])
    db.insert_rows(conn, "campaign_forecast", rows)
    return rows


def simulate_campaign(conn, payload: dict) -> dict:
    campaign = cc.load_campaign(conn, payload["campaign_id"])
    if campaign["state"] not in ("draft", "simulated"):
        raise ValueError(f"campaign {campaign['code']} is {campaign['state']}; only draft campaigns are simulated")
    frun = db.current_run(conn, "forecast_run")
    if not frun:
        raise RuntimeError("no current forecast run; run the nightly jobs first")
    items = load_items(conn)
    base = load_forecast(conn, frun["id"], "base")
    eff = campaign_effect(conn, campaign, base, items)
    rows = write_campaign_forecast(conn, campaign, eff, base)

    weeks = eff["weeks"]
    idx = {w: k for k, w in enumerate(weeks)}
    delta, free = {}, {}
    for r in rows:
        d = (r["override"] if r["override"] is not None else r["uplift"]) + r["free_qty"] - r["pull_forward"] - r["cannibalised"]
        if abs(d) > 1e-9:
            delta.setdefault(r["item_id"], np.zeros(len(weeks)))[idx[r["week"]]] += d
        if r["free_qty"]:
            free[r["item_id"]] = free.get(r["item_id"], 0.0) + r["free_qty"]
    sbase, _ = sandbox_items(conn, list(delta), exclude_campaign=campaign["id"])
    result = compact(simulate(sbase, {i: delta[i] for i in sbase}, free, truck=truck_window(conn)), sbase)

    db.execute(conn, "delete from plan_version where kind = 'scenario' and context->>'campaign_id' = %s",
               [campaign["id"]])
    scenario_id, plan = create_scenario(conn, f"Kampanya {campaign['code']} senaryosu",
                                        {"type": "campaign", "campaign_id": campaign["id"], "code": campaign["code"],
                                         "forecast_run_id": frun["id"]})
    write_projection(conn, scenario_id, result, weeks)

    cost = items["cost_eur"].astype(float).fillna(0.0)
    tot = {k: round(sum(r[k] for r in rows), 3) for k in ("uplift", "pull_forward", "cannibalised", "free_qty")}
    tot["baseline_in_window"] = round(sum(r["baseline"] for r in rows if r["week"] in eff["window"]
                                          and r["item_id"] in eff["in_scope"]), 3)
    tot["net"] = round(tot["uplift"] + tot["free_qty"] - tot["pull_forward"] - tot["cannibalised"], 3)
    free_cost = round(sum(r["free_qty"] * cost.get(r["item_id"], 0.0) for r in rows), 2)
    result["campaign"] = {
        "code": campaign["code"], "window": [eff["window"][0], eff["window"][-1]] if eff["window"] else None,
        "items_in_scope": len(eff["in_scope"]), "eligible_share": eff["eligible_share"], "totals": tot,
        "free_goods_cost_eur": free_cost, "budget_eur": campaign["budget_eur"],
        "over_budget": bool(campaign["budget_eur"] is not None and free_cost > campaign["budget_eur"]),
        "mechanics": eff["mechanics"], "notes": eff["notes"], "forecast_rows": len(rows)}
    result["base_plan_version_id"] = plan["id"]
    result["forecast_run_id"] = frun["id"]
    sim_id = db.scalar(conn, "select rpc_campaign_simulation_done(%s, %s, %s)",
                       [campaign["id"], scenario_id, db.as_json(result)])
    return {"campaign_id": campaign["id"], "simulation_id": sim_id, "plan_version_id": scenario_id,
            "summary": result["summary"], "campaign": result["campaign"]}


# ----------------------------------------------------------------- scenario
def simulate_scenario(conn, payload: dict) -> dict:
    as_of = business_date(conn)
    if "lead_time_change" in payload:
        ch = payload["lead_time_change"]
        lane_id = ch["supplier_lane_id"]
        lanes = load_lanes(conn)
        affected = [i for i, l in lanes.items() if l["lane_id"] == lane_id]
        if not affected:
            raise ValueError(f"no item is supplied through lane {lane_id}")
        old = lanes[affected[0]]
        old_days = float(old["mean_days"] if old["mean_days"] is not None else old["quoted_lt_days"])
        new_days = float(ch["days"]) if ch.get("days") is not None else old_days + float(ch["delta_days"])
        new_sd = float(ch["sd_days"]) if ch.get("sd_days") is not None else None
        sbase, weeks = sandbox_items(conn, affected)
        sd_ratio = new_days / old_days if old_days else 1.0
        res = simulate(sbase, lead_time_weeks={i: new_days / 7.0 for i in sbase},
                       lead_time_sd_weeks={i: (new_sd / 7.0 if new_sd is not None
                                               else (sbase[i]["policy"]["sd_L"] or 0.0) * sd_ratio) for i in sbase},
                       truck=truck_window(conn))
        result = compact(res, sbase)
        scenario_id, plan = create_scenario(conn, f"Tedarik süresi senaryosu {old_days:g} -> {new_days:g} gün",
                                            {"type": "lead_time_change", **payload})
        frame, ctx = compute_policy.build(conn, as_of, lead_time_override={lane_id: (new_days, new_sd)})
        rows = [r for r in compute_policy.policy_rows(frame, ctx, scenario_id) if r["item_id"] in sbase]
        if rows:
            compute_policy.write(conn, rows)
        result["lead_time"] = {"supplier_lane_id": lane_id, "old_days": old_days, "new_days": new_days,
                               "sd_days": new_sd, "items": len(sbase)}
        result["policy_changes"] = [
            {"item_id": r["item_id"], "sku": sbase[r["item_id"]]["sku"], "safety_stock": r["safety_stock"],
             "safety_stock_before": sbase[r["item_id"]]["policy"]["safety_stock"], "rop": r["rop"],
             "rop_before": sbase[r["item_id"]]["policy"]["rop"], "order_up_to": r["order_up_to"],
             "order_up_to_before": sbase[r["item_id"]]["policy"]["order_up_to"]} for r in rows]
    elif "demand_change" in payload:
        ch = payload["demand_change"]
        items = load_items(conn)
        if ch.get("item_ids"):
            affected = [i for i in ch["item_ids"] if i in items.index]
        else:
            affected = list(items.index[items["family_code"] == ch.get("family")])
        sbase, weeks = sandbox_items(conn, affected)
        n = int(ch.get("weeks") or len(weeks))
        delta = {}
        for i, b in sbase.items():
            d = np.zeros(len(weeks))
            d[:n] = b["forecast"][:n] * float(ch["pct"]) / 100.0
            delta[i] = d
        result = compact(simulate(sbase, delta, truck=truck_window(conn)), sbase)
        scenario_id, plan = create_scenario(conn, f"Talep senaryosu {float(ch['pct']):+g}%",
                                            {"type": "demand_change", **payload})
    else:
        raise ValueError("simulate_scenario needs lead_time_change or demand_change")
    result["projection_rows"] = write_projection(conn, scenario_id, result, weeks)
    result["plan_version_id"] = scenario_id
    result["base_plan_version_id"] = plan["id"]
    return db.jsonable(result)


def run(conn, as_of=None, **payload) -> dict:
    """Not a nightly job: use the on-demand kinds simulate_campaign / simulate_scenario."""
    if "campaign_id" in payload:
        return simulate_campaign(conn, payload)
    return simulate_scenario(conn, payload)
