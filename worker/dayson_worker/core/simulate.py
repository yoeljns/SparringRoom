"""Scenario sandbox (spec §9.7): re-run the plan for affected items only.

Given baseline plan data and a campaign forecast (or a lead-time change),
recompute projected stock, suggestions and truck count and report per item:
weeks below safety stock, extra pallets to pre-build and by when, amber stock
consumed, added trucks, and other campaigns whose ring-fence would be short.
"""
from __future__ import annotations

import math
from datetime import timedelta

import numpy as np

from .policy import continuous_policy, periodic_policy
from .suggest import suggest_for_item
from .loadplan import plan_trucks, DEFAULT_MIN_KG, DEFAULT_MAX_KG


def projected_stock(on_hand: float, receipts, demand, reservations=None) -> np.ndarray:
    """End-of-week projected stock = on hand + receipts to date - demand to date - reservations due."""
    r = np.cumsum(np.asarray(receipts, float))
    d = np.cumsum(np.asarray(demand, float))
    res = np.cumsum(np.asarray(reservations, float)) if reservations is not None else 0.0
    return on_hand + r - d - res


def _shift(receipts, weeks: int, frozen: int = 0) -> np.ndarray:
    """Delay (weeks > 0) or advance receipts; receipts in the first ``frozen`` weeks stay."""
    r = np.asarray(receipts, float)
    out = np.zeros_like(r)
    out[:frozen] = r[:frozen]
    for i in range(frozen, len(r)):
        j = i + weeks
        if r[i] and frozen <= j < len(r):
            out[j] += r[i]
        elif r[i] and j < frozen:
            out[frozen] += r[i]
    return out


def _policy_for_lead_time(policy: dict, new_L: float, new_sd_L: float | None, unit: float) -> dict:
    need = ("d", "sd_d", "sd_L", "z")
    if policy.get("policy") not in ("continuous", "periodic") or any(policy.get(k) is None for k in need):
        return dict(policy, L=new_L)
    sd_L = policy["sd_L"] if new_sd_L is None else new_sd_L
    if policy["policy"] == "continuous":
        p = continuous_policy(policy["d"], policy["sd_d"], new_L, sd_L, policy["z"], unit)
    else:
        p = periodic_policy(policy["d"], policy["sd_d"], new_L, sd_L, policy.get("R", 1.0), policy["z"], unit)
    p["service_level"] = policy.get("service_level")
    return p


def simulate_item(item_id, base: dict, delta=None, free_qty: float | None = None,
                  new_lead_time_weeks: float | None = None, new_lead_time_sd_weeks: float | None = None,
                  truck_kg: float = (DEFAULT_MIN_KG + DEFAULT_MAX_KG) / 2) -> dict:
    """One item under the scenario.

    base keys: on_hand, receipts[w], forecast[w], week_starts[w], policy (core.policy output),
      lead_time_weeks, and optional reservations[w], order_qty, review_weeks, order_multiple,
      units_per_pallet (1), kg_per_pallet, amber_qty (0), amber_weeks_left, frozen_weeks (0),
      on_order (default sum of receipts), ring_fences [{campaign_id, week_idx, qty}].
    delta : per-week change in demand (uplift - pull_forward - cannibalised)
    """
    fc = np.asarray(base["forecast"], float)
    h = len(fc)
    weeks = base["week_starts"]
    upp = float(base.get("units_per_pallet") or 1.0)
    policy = base["policy"]
    ss_b = float(policy.get("safety_stock") or 0.0)
    L_b = float(base.get("lead_time_weeks") or 0.0)
    d_arr = np.zeros(h) if delta is None else np.asarray(delta, float)
    demand_s = np.clip(fc + d_arr, 0.0, None)
    receipts_b = np.asarray(base["receipts"], float)
    receipts_s, policy_s, L_s = receipts_b, policy, L_b
    if new_lead_time_weeks is not None and new_lead_time_weeks != L_b:
        L_s = float(new_lead_time_weeks)
        receipts_s = _shift(receipts_b, int(round(L_s - L_b)), int(base.get("frozen_weeks") or 0))
        policy_s = _policy_for_lead_time(policy, L_s, new_lead_time_sd_weeks, upp)
    ss_s = float(policy_s.get("safety_stock") or 0.0)
    res = base.get("reservations")
    proj_b = projected_stock(base["on_hand"], receipts_b, fc, res)
    proj_s = projected_stock(base["on_hand"], receipts_s, demand_s, res)
    below_b = proj_b < ss_b
    below_s = proj_s < ss_s

    # pre-build: the worst extra shortfall against safety stock that the scenario adds
    short_b = np.clip(ss_b - proj_b, 0.0, None)
    short_s = np.clip(ss_s - proj_s, 0.0, None)
    extra = np.clip(short_s - short_b, 0.0, None)
    prebuild_units = float(extra.max()) if h else 0.0
    prebuild_pallets = math.ceil(prebuild_units / upp - 1e-9)
    first = int(np.argmax(extra > 1e-9)) if prebuild_units > 1e-9 else None
    by = weeks[first] if first is not None else None

    # amber stock: extra demand (free and bundle lines first) can absorb amber-band lots
    amber = float(base.get("amber_qty") or 0.0)
    left = int(base.get("amber_weeks_left") or h)
    extra_demand = float(np.clip(d_arr[:left], 0.0, None).sum())
    amber_used = min(amber, free_qty if free_qty is not None else extra_demand)

    # suggestions for this item, before and after
    common = dict(item_id=item_id, week_starts=weeks, on_hand=base["on_hand"],
                  on_order=float(base.get("on_order", receipts_b.sum())),
                  reservations=float(np.sum(res)) if res is not None else 0.0,
                  order_qty=float(base.get("order_qty") or 0.0), review_weeks=float(base.get("review_weeks") or 1.0),
                  order_multiple=float(base.get("order_multiple") or 0.0), supply_type=base.get("supply_type", "purchase"))
    try:
        sug_b = suggest_for_item(policy=policy, forecast=fc, lead_time_weeks=L_b, **common)
        sug_s = suggest_for_item(policy=policy_s, forecast=demand_s, lead_time_weeks=L_s, **common)
    except (KeyError, ValueError):
        sug_b, sug_s = [], []

    # trucks: outbound volume added by the scenario
    extra_out = float(np.clip(d_arr, 0.0, None).sum())
    extra_pallets = extra_out / upp
    kgpp = base.get("kg_per_pallet")
    added_trucks = extra_pallets * kgpp / truck_kg if kgpp else None

    conflicts = []
    for rf in base.get("ring_fences") or []:
        w = min(int(rf["week_idx"]), h - 1)
        sh_b = max(0.0, rf["qty"] - max(float(proj_b[w]), 0.0))
        sh_s = max(0.0, rf["qty"] - max(float(proj_s[w]), 0.0))
        if sh_s > sh_b + 1e-9:
            conflicts.append({"campaign_id": rf["campaign_id"], "week": weeks[w], "ring_fence_qty": rf["qty"],
                              "short_qty": sh_s, "short_before": sh_b})
    return {
        "item_id": item_id,
        "weeks_below_safety": int(below_s.sum()), "weeks_below_safety_baseline": int(below_b.sum()),
        "weeks_below_safety_list": [weeks[i] for i in np.flatnonzero(below_s)],
        "first_stockout_week": next((weeks[i] for i in np.flatnonzero(proj_s < 0)), None),
        "prebuild_pallets": prebuild_pallets, "prebuild_units": prebuild_units, "prebuild_by": by,
        "prebuild_release_by": (by - timedelta(days=int(round(L_s * 7)))) if by is not None else None,
        "amber_consumed": amber_used,
        "extra_pallets_out": extra_pallets, "added_trucks": round(added_trucks, 2) if added_trucks is not None else None,
        "ring_fence_conflicts": conflicts,
        "safety_stock": ss_s, "safety_stock_baseline": ss_b,
        "suggestions": sug_s, "suggested_qty": sum(s["qty"] for s in sug_s),
        "suggested_qty_baseline": sum(s["qty"] for s in sug_b),
        "projected": proj_s.tolist(), "projected_baseline": proj_b.tolist(),
    }


def simulate(items: dict, campaign_delta: dict | None = None, free_qty: dict | None = None,
             lead_time_weeks: dict | None = None, lead_time_sd_weeks: dict | None = None,
             truck: dict | None = None, use_planner: bool = False) -> dict:
    """Run the scenario for the affected items only.

    items            : {item_id: baseline dict (see simulate_item)} — the published plan's data
    campaign_delta   : {item_id: per-week demand delta} (campaign forecast)
    lead_time_weeks  : {item_id: new mean lead time in weeks} (non-campaign question)
    truck            : {"min_kg","max_kg","max_items"}; use_planner=True runs the load planner on the
                       added pallets (whole pallets, rounded up) for an exact truck count
    Returns {"items": [per-item result], "summary": {...}}.
    """
    campaign_delta = campaign_delta or {}
    lead_time_weeks = lead_time_weeks or {}
    truck = truck or {}
    min_kg, max_kg = truck.get("min_kg", DEFAULT_MIN_KG), truck.get("max_kg", DEFAULT_MAX_KG)
    affected = [i for i in items if i in campaign_delta or i in lead_time_weeks]
    results = [simulate_item(i, items[i], campaign_delta.get(i), (free_qty or {}).get(i),
                             lead_time_weeks.get(i), (lead_time_sd_weeks or {}).get(i),
                             truck_kg=(min_kg + max_kg) / 2) for i in affected]
    share = sum(r["added_trucks"] or 0.0 for r in results)
    summary = {"items_affected": len(affected),
               "items_below_safety": sum(1 for r in results if r["weeks_below_safety"] > r["weeks_below_safety_baseline"]),
               "prebuild_pallets": sum(r["prebuild_pallets"] for r in results),
               "amber_consumed": sum(r["amber_consumed"] for r in results),
               "added_trucks": math.ceil(share - 1e-9), "added_trucks_exact": None,
               "ring_fence_conflicts": sum(len(r["ring_fence_conflicts"]) for r in results)}
    if use_planner:
        order = {r["item_id"]: math.ceil(r["extra_pallets_out"] - 1e-9) for r in results
                 if r["extra_pallets_out"] > 0 and items[r["item_id"]].get("kg_per_pallet")}
        if order:
            plan = plan_trucks(order, {i: items[i]["kg_per_pallet"] for i in order}, min_kg, max_kg,
                               truck.get("max_items", 5), time_limit_s=truck.get("time_limit_s", 5.0))
            summary["added_trucks_exact"] = plan["n_trucks"]
            summary["added_truck_remainder"] = plan["remainder"]
    return {"items": results, "summary": summary}
