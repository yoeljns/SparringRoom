"""Truck load planner (spec §7.5) — integer program solved with OR-Tools CP-SAT.

Variables   : pallets of item i on truck t; whether item i is on truck t;
              whether truck t repeats a pattern already used.
Hard        : each truck's kg inside the window; whole pallets; all ordered
              pallets shipped, or the remainder reported; items per truck within
              the limit; positions within trailer capacity.
Objective   : lexicographic, in configurable order (default: fewest item-truck
              pairings, most trucks sharing an identical pattern, highest average kg).
              Shipping as many of the ordered pallets as possible always comes first;
              "known" (trucks matching an approved load_pattern) is placed right
              after "identical" when known patterns are supplied.
Schedule    : each month's item mix within a tolerance of the order's overall mix.

Weights are integers in kg when every weight is a whole kg, otherwise grams.
"""
from __future__ import annotations

import math
from collections import OrderedDict

from ortools.sat.python import cp_model

DEFAULT_MIN_KG = 24_900
DEFAULT_MAX_KG = 25_075
DEFAULT_MAX_ITEMS = 5
DEFAULT_ORDER = ("pairings", "identical", "avg_kg")


def single_item_feasibility(kg_per_pallet: float, min_kg: float = DEFAULT_MIN_KG,
                            max_kg: float = DEFAULT_MAX_KG) -> dict:
    """Can one item fill a truck alone? (the table in §7.5)

    Returns feasible, pallets and kg when a whole number of pallets lands in the
    window; otherwise the largest count under and the smallest count over.
    """
    lo = math.ceil(min_kg / kg_per_pallet - 1e-9)
    hi = math.floor(max_kg / kg_per_pallet + 1e-9)
    if lo <= hi:
        return {"feasible": True, "pallets": hi, "kg": hi * kg_per_pallet,
                "pallet_options": list(range(lo, hi + 1))}
    return {"feasible": False, "pallets": None, "kg": None,
            "under": {"pallets": lo - 1, "kg": (lo - 1) * kg_per_pallet},
            "over": {"pallets": lo, "kg": lo * kg_per_pallet}}


def signature(lines: dict) -> str:
    """Canonical pattern signature, e.g. 'Gri:20|Siyah:22'."""
    return "|".join(f"{k}:{int(v)}" for k, v in sorted(lines.items(), key=lambda kv: str(kv[0])) if v)


def _scale(values) -> int:
    return 1 if all(abs(float(v) - round(float(v))) < 1e-9 for v in values) else 1000


def _normalise_known(known_patterns, items) -> list[dict]:
    out = []
    for n, p in enumerate(known_patterns or []):
        if "lines" in p and isinstance(p["lines"], (dict, list)):
            lines = p["lines"]
            if isinstance(lines, list):
                lines = {l.get("item", l.get("item_id")): l["pallets"] for l in lines}
            pid = p.get("id") or p.get("pattern_id") or f"K{n + 1}"
        else:
            lines, pid = p, f"K{n + 1}"
        lines = {k: int(v) for k, v in lines.items() if v}
        if lines and all(k in items for k in lines):
            out.append({"id": pid, "lines": lines, "signature": signature(lines)})
    return out


class _Stage:
    def __init__(self, time_limit_s, workers, seed):
        self.time_limit_s, self.workers, self.seed = time_limit_s, workers, seed
        self.status = OrderedDict()

    def solve(self, model, name, expr=None, sense=None):
        if expr is not None:
            (model.Minimize if sense == "min" else model.Maximize)(expr)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.time_limit_s
        solver.parameters.num_workers = self.workers
        solver.parameters.random_seed = self.seed
        st = solver.Solve(model)
        self.status[name] = solver.StatusName(st)
        return solver, st in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def _build(items, order_expr, ub, w, n_trucks, min_w, max_w, max_items, max_positions, positions,
           month_of=None, pairs=True):
    """Core model. order_expr[i] is an int (ship at most that many) — equality is added by the caller."""
    m = cp_model.CpModel()
    T = range(n_trucks)
    x = {(i, t): m.NewIntVar(0, ub[i], f"x_{i}_{t}") for i in items for t in T}
    y = {(i, t): m.NewBoolVar(f"y_{i}_{t}") for i in items for t in T}
    used = [m.NewBoolVar(f"used_{t}") for t in T]
    kg = [m.NewIntVar(0, max_w, f"kg_{t}") for t in T]
    for t in T:
        for i in items:
            m.Add(x[i, t] <= ub[i] * y[i, t])
            m.Add(x[i, t] >= y[i, t])
            m.Add(y[i, t] <= used[t])
        m.Add(kg[t] == sum(w[i] * x[i, t] for i in items))
        m.Add(kg[t] >= min_w * used[t])
        m.Add(kg[t] <= max_w * used[t])
        m.Add(sum(y[i, t] for i in items) <= max_items)
        if max_positions is not None:
            m.Add(sum(positions[i] * x[i, t] for i in items) <= max_positions)
    # symmetry: heavier trucks first (within a month when a schedule fixes the months)
    for t in range(n_trucks - 1):
        if month_of is None or month_of[t] == month_of[t + 1]:
            m.Add(kg[t] >= kg[t + 1])
    same, rep = {}, []
    if pairs:
        for b in T:
            r = m.NewBoolVar(f"rep_{b}")
            prior = []
            for a in range(b):
                s = m.NewBoolVar(f"same_{a}_{b}")
                for i in items:
                    m.Add(x[i, a] == x[i, b]).OnlyEnforceIf(s)
                m.Add(s <= used[a])
                m.Add(s <= used[b])
                same[a, b] = s
                prior.append(s)
            m.Add(r <= sum(prior)) if prior else m.Add(r == 0)
            rep.append(r)
    return m, x, y, used, kg, rep


def plan_trucks(order: dict, kg_per_pallet: dict, min_kg: float = DEFAULT_MIN_KG,
                max_kg: float = DEFAULT_MAX_KG, max_items: int = DEFAULT_MAX_ITEMS,
                max_positions: int | None = None, positions_per_pallet: dict | None = None,
                known_patterns: list | None = None, schedule: dict | None = None,
                objective_order: tuple = DEFAULT_ORDER, topup_items: dict | None = None,
                time_limit_s: float = 10.0, workers: int = 4, seed: int = 1) -> dict:
    """Split an order into trucks.

    order            : {item: pallets ordered}
    kg_per_pallet    : {item: kg per pallet} (lot actual when allocated, else pack gross_kg)
    max_positions    : trailer pallet positions (optional); positions_per_pallet {item: positions}, default 1
    known_patterns   : approved load_pattern rows ({"id","lines": {item: pallets}}) to prefer
    schedule         : {"trucks_per_month": [n1, n2, ...], "mix_tolerance": 0.10, "months": [labels]}
                       — tolerance is in absolute share points of pallets
    topup_items      : {item: kg per pallet} that may be added to make a remainder loadable
                       (default: the items of the order)
    time_limit_s     : per solve stage; a stage that hits the limit is reported as FEASIBLE
    Returns trucks (pattern id, signature, lines, kg), distinct pattern count,
    remainder, and the smallest top-up that would make the remainder a valid load.
    """
    order = {k: int(v) for k, v in order.items() if int(v) > 0}
    if any(float(v) != int(v) for v in order.values()):
        raise ValueError("order quantities must be whole pallets")
    items = sorted(order, key=str)
    missing = [i for i in items if i not in kg_per_pallet]
    if missing:
        raise ValueError(f"no pallet weight for {missing}")
    sc = _scale([kg_per_pallet[i] for i in items] + [min_kg, max_kg] + list((topup_items or {}).values()))
    w = {i: int(round(float(kg_per_pallet[i]) * sc)) for i in items}
    min_w, max_w = int(round(min_kg * sc)), int(round(max_kg * sc))
    pos = {i: int((positions_per_pallet or {}).get(i, 1)) for i in items}
    month_of, months = None, None
    total_kg = sum(w[i] * order[i] for i in items)
    if schedule:
        per_month = [int(n) for n in schedule["trucks_per_month"]]
        months = schedule.get("months") or list(range(1, len(per_month) + 1))
        month_of = [mi for mi, n in enumerate(per_month) for _ in range(n)]
        n_trucks = len(month_of)
    else:
        n_trucks = min(total_kg // min_w if min_w > 0 else sum(order.values()), sum(order.values()))
    known = _normalise_known(known_patterns, set(items))
    stage = _Stage(time_limit_s, workers, seed)
    result = {"trucks": [], "n_trucks": 0, "n_patterns": 0, "patterns": [], "remainder": {},
              "top_up": None, "pairings": 0, "avg_kg": None, "status": stage.status,
              "inputs": {"order": dict(order), "kg_per_pallet": {i: kg_per_pallet[i] for i in items},
                         "min_kg": min_kg, "max_kg": max_kg, "max_items": max_items,
                         "max_positions": max_positions, "schedule": schedule,
                         "objective_order": list(objective_order), "known_patterns": [k["id"] for k in known]}}
    sol = {i: [] for i in items}
    if n_trucks > 0 and items:
        ub = {i: min(order[i], max_w // w[i]) for i in items}
        m, x, y, used, kg, rep = _build(items, order, ub, w, n_trucks, min_w, max_w, max_items,
                                        max_positions, pos, month_of)
        T = range(n_trucks)
        for i in items:
            m.Add(sum(x[i, t] for t in T) <= order[i])
        if schedule:
            tol = int(round(float(schedule.get("mix_tolerance", 1.0)) * 1000))
            tot = sum(order.values())
            for mi in range(len(months)):
                ts = [t for t in T if month_of[t] == mi]
                if not ts or tol >= 1000:
                    continue
                p_m = sum(x[i, t] for i in items for t in ts)
                for i in items:
                    x_im = sum(x[i, t] for t in ts)
                    m.Add(1000 * tot * x_im - 1000 * order[i] * p_m <= tol * tot * p_m)
                    m.Add(1000 * order[i] * p_m - 1000 * tot * x_im <= tol * tot * p_m)
        match = {}
        for t in T:
            row = []
            for k, p in enumerate(known):
                b = m.NewBoolVar(f"match_{t}_{k}")
                for i in items:
                    m.Add(x[i, t] == p["lines"].get(i, 0)).OnlyEnforceIf(b)
                match[t, k] = b
                row.append(b)
            if row:
                m.Add(sum(row) <= 1)

        shipped = sum(x.values())
        n_used = sum(used)
        tot_kg = sum(kg)
        exprs = {"pairings": (sum(y.values()), "min"), "identical": (sum(rep), "max"),
                 "known": (sum(match.values()), "max")}
        order_list = [o for o in objective_order if o in ("pairings", "identical", "avg_kg")]
        if known and "known" not in order_list:
            at = order_list.index("identical") + 1 if "identical" in order_list else len(order_list)
            order_list.insert(at, "known")

        def hint(solver):
            m.ClearHints()
            for v in list(x.values()) + list(y.values()) + used:
                m.AddHint(v, solver.Value(v))

        solver, ok = stage.solve(m, "shipped", shipped, "max")
        if ok:
            m.Add(shipped == int(round(solver.ObjectiveValue())))
            hint(solver)
            for name in order_list:
                if name == "avg_kg":
                    # average kg = total kg / trucks used: find the truck-count range, then the best ratio
                    s_lo, ok_lo = stage.solve(m, "avg_kg:min_trucks", n_used, "min")
                    n_lo = int(round(s_lo.ObjectiveValue()))
                    s_hi, _ = stage.solve(m, "avg_kg:max_trucks", n_used, "max")
                    n_hi = int(round(s_hi.ObjectiveValue()))
                    if n_lo == n_hi:
                        m.Add(n_used == n_lo)
                        solver, ok = stage.solve(m, "avg_kg", tot_kg, "max")
                    else:
                        best = None
                        for n in range(max(n_lo, 1), n_hi + 1):
                            mc = m.Clone()
                            mc.Add(sum(used[t] for t in T) == n)
                            s_n, ok_n = stage.solve(mc, f"avg_kg:n={n}", tot_kg, "max")
                            if ok_n and (best is None or s_n.ObjectiveValue() / n > best[1] / best[0] + 1e-12):
                                best = (n, s_n.ObjectiveValue())
                        m.Add(n_used == best[0])
                        m.Add(tot_kg >= int(round(best[1])))
                        solver, ok = stage.solve(m, "avg_kg", tot_kg, "max")
                    if ok:
                        m.Add(tot_kg >= int(round(solver.ObjectiveValue())))
                else:
                    expr, sense = exprs[name]
                    solver, ok = stage.solve(m, name, expr, sense)
                    if ok:
                        val = int(round(solver.ObjectiveValue()))
                        m.Add(expr <= val) if sense == "min" else m.Add(expr >= val)
                if not ok:
                    break
                hint(solver)
            if not ok:       # should not happen: the previous stage's solution stays feasible
                raise RuntimeError(f"load planner stage failed: {dict(stage.status)}")
            for t in T:
                if solver.Value(used[t]):
                    for i in items:
                        sol[i].append(solver.Value(x[i, t]))
                    result["trucks"].append({"_t": t})

    # ---- assemble trucks and patterns
    known_by_sig = {k["signature"]: k["id"] for k in known}
    pattern_ids, patterns = {}, OrderedDict()
    trucks = []
    for n, tr in enumerate(result["trucks"]):
        lines = {i: sol[i][n] for i in items if sol[i][n] > 0}
        sig = signature(lines)
        if sig not in pattern_ids:
            pattern_ids[sig] = known_by_sig.get(sig) or f"P{len([p for p in pattern_ids.values() if str(p).startswith('P')]) + 1}"
        kg_t = sum(w[i] * q for i, q in lines.items()) / sc
        pid = pattern_ids[sig]
        trucks.append({"truck_no": n + 1, "month": months[month_of[tr["_t"]]] if month_of else None,
                       "pattern_id": pid, "signature": sig,
                       "lines": [{"item": i, "pallets": q, "kg": w[i] * q / sc} for i, q in lines.items()],
                       "pallets": sum(lines.values()), "kg": kg_t,
                       "window_ok": min_kg - 1e-9 <= kg_t <= max_kg + 1e-9})
        p = patterns.setdefault(pid, {"pattern_id": pid, "signature": sig, "lines": lines, "total_kg": kg_t,
                                      "trucks": 0, "known": sig in known_by_sig})
        p["trucks"] += 1
    result["trucks"] = trucks
    result["n_trucks"] = len(trucks)
    result["patterns"] = list(patterns.values())
    result["n_patterns"] = len(patterns)
    result["pairings"] = sum(len(t["lines"]) for t in trucks)
    result["avg_kg"] = sum(t["kg"] for t in trucks) / len(trucks) if trucks else None
    shipped_i = {i: sum(sol[i]) for i in items}
    result["remainder"] = {i: order[i] - shipped_i[i] for i in items if order[i] - shipped_i[i] > 0}
    if result["remainder"]:
        cat = dict(topup_items) if topup_items else {i: kg_per_pallet[i] for i in items}
        for i in result["remainder"]:
            cat.setdefault(i, kg_per_pallet[i])
        result["top_up"] = smallest_top_up(result["remainder"], cat, min_kg, max_kg, max_items, max_positions,
                                           positions_per_pallet, time_limit_s, workers, seed)
    return result


def smallest_top_up(remainder: dict, kg_per_pallet: dict, min_kg: float = DEFAULT_MIN_KG,
                    max_kg: float = DEFAULT_MAX_KG, max_items: int = DEFAULT_MAX_ITEMS,
                    max_positions: int | None = None, positions_per_pallet: dict | None = None,
                    time_limit_s: float = 10.0, workers: int = 4, seed: int = 1) -> dict | None:
    """Fewest extra pallets (then least extra kg) that turn a remainder into valid truck(s).

    kg_per_pallet lists every item that may be added (and must include the
    remainder's items). Returns {"add": {item: pallets}, "added_pallets",
    "added_kg", "trucks": [{item: pallets}], "kg": [...]}, or None when no
    top-up from those items works.
    """
    rem = {k: int(v) for k, v in remainder.items() if v > 0}
    if not rem:
        return None
    items = sorted(kg_per_pallet, key=str)
    sc = _scale([kg_per_pallet[i] for i in items] + [min_kg, max_kg])
    w = {i: int(round(float(kg_per_pallet[i]) * sc)) for i in items}
    min_w, max_w = int(round(min_kg * sc)), int(round(max_kg * sc))
    pos = {i: int((positions_per_pallet or {}).get(i, 1)) for i in items}
    rem_w = sum(w[i] * q for i, q in rem.items())
    base = max(1, math.ceil(rem_w / max_w))
    ub = {i: max_w // w[i] for i in items}
    stage = _Stage(time_limit_s, workers, seed)
    # every extra truck needs at least min_kg more, so the first truck count that works is taken
    for n_trucks in range(base, base + 3):
        m, x, y, used, kg, _ = _build(items, None, ub, w, n_trucks, min_w, max_w, max_items, max_positions,
                                      pos, pairs=False)
        add = {i: m.NewIntVar(0, ub[i] * n_trucks, f"add_{i}") for i in items}
        for i in items:
            m.Add(sum(x[i, t] for t in range(n_trucks)) == rem.get(i, 0) + add[i])
        for t in range(n_trucks):
            m.Add(used[t] == 1)
        big = max_w * n_trucks + 1
        solver, ok = stage.solve(m, "top_up", sum(add[i] * (big + w[i]) for i in items), "min")
        if ok:
            break
    else:
        return None
    added = {i: solver.Value(add[i]) for i in items if solver.Value(add[i]) > 0}
    trucks = [{i: solver.Value(x[i, t]) for i in items if solver.Value(x[i, t]) > 0}
              for t in range(n_trucks) if solver.Value(used[t])]
    return {"add": added, "added_pallets": sum(added.values()),
            "added_kg": sum(w[i] * q for i, q in added.items()) / sc,
            "trucks": trucks, "kg": [sum(w[i] * q for i, q in t.items()) / sc for t in trucks],
            "status": stage.status["top_up"]}
