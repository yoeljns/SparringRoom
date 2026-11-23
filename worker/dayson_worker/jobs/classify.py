"""classify (§8.2): ABC, XYZ, demand pattern, criticality and service level per item.

Monthly: skips itself while the current run is from this month (force=True overrides).
The new run becomes classification_run.is_current; earlier runs are kept.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import db
from ..core.classification import classify, _STEP_UP
from ..core.demand_history import weekly_matrix
from ._common import business_date, monday, load_items, load_weekly_history


def run(conn, as_of=None, force: bool = False) -> dict:
    as_of = business_date(conn, as_of)
    cur = db.current_run(conn, "classification_run")
    if cur and not force and (cur["run_at"].year, cur["run_at"].month) == (as_of.year, as_of.month):
        return {"skipped": "current classification is from this month", "run_id": cur["id"]}

    week0 = monday(as_of)
    items = load_items(conn)
    hist = load_weekly_history(conn, week0)
    if hist.empty:
        return {"skipped": "no demand history"}
    paid = weekly_matrix(hist, "paid", week0).reindex(items.index, fill_value=0.0)
    free = weekly_matrix(hist, "free", week0).reindex(index=items.index, columns=paid.columns, fill_value=0.0)

    p = {k: db.param_num(conn, k) for k in ("abc_a_pct", "abc_b_pct", "xyz_x_max", "xyz_y_max", "adi_cut", "cv2_cut")}
    matrix, levels = {}, {}
    for a in "ABC":
        for x in "XYZ":
            r = db.resolve_param(conn, "service_level", {"class": a + x})
            matrix[(a, x)], levels[a + x] = float(r["value"]), r["level"]

    # criticality: export contract item, launch item, or bought by most A dealers in the last 12 months
    a_dealers = db.scalar(conn, "select count(*) from party where type = 'dealer' and segment = 'A' and active") or 0
    bought = db.query(conn, """
        select h.item_id, count(distinct h.party_id) as n from demand_history h join party p on p.id = h.party_id
         where p.type = 'dealer' and p.segment = 'A' and h.week >= %s and h.qty_paid > 0 group by 1""",
                      [week0 - pd.Timedelta(weeks=52)])
    by_a = pd.Series({r["item_id"]: r["n"] for r in bought}, dtype=float).reindex(items.index).fillna(0.0)
    most_a = (by_a > a_dealers / 2.0) if a_dealers else pd.Series(False, index=items.index)
    critical = items["export_contract"].astype(bool) | items["lifecycle"].eq("launch") | most_a

    cost = items["cost_eur"].astype(float)
    cls = classify(paid, unit_price=cost.fillna(0.0), weekly_free=free, unit_cost=cost.fillna(0.0), critical=critical,
                   matrix=matrix, abc_cuts=(p["abc_a_pct"] / 100.0, p["abc_b_pct"] / 100.0),
                   xyz_cuts=(p["xyz_x_max"], p["xyz_y_max"]), adi_cut=p["adi_cut"], cv2_cut=p["cv2_cut"])

    db.execute(conn, "update classification_run set is_current = false where is_current")
    run_id = db.insert_one(conn, "classification_run", {
        "is_current": True,
        "params": {**p, "service_level_matrix": {a + x: v for (a, x), v in matrix.items()},
                   "service_level_levels": levels, "value_basis": "trailing 52 weeks at item cost (free goods at cost)",
                   "a_dealers": a_dealers, "as_of": as_of, "param_version": db.param_version(conn)}})
    rows = []
    for item_id, r in cls.iterrows():
        no_demand = not np.isfinite(r["adi"])
        rows.append({
            "run_id": run_id, "item_id": item_id, "abc": r["abc"], "xyz": r["xyz"],
            "pattern": "none" if no_demand else r["pattern"],
            "adi": None if no_demand else round(float(r["adi"]), 4), "cv2": round(float(r["cv2"]), 4),
            "cv_monthly": round(float(r["cv_monthly"]), 4) if np.isfinite(r["cv_monthly"]) else None,
            "criticality": bool(r["criticality"]),
            "service_class": (_STEP_UP[r["abc"]] if r["criticality"] else r["abc"]) + r["xyz"],
            "service_level": float(r["service_level"]), "consumption_value_eur": round(float(r["value_12m"]), 2),
            "lifecycle_flag": items.at[item_id, "lifecycle"]})
    db.insert_rows(conn, "item_class", rows)
    counts = cls.groupby(["abc", "xyz"]).size()
    return {"run_id": run_id, "items": len(rows), "critical": int(cls["criticality"].sum()),
            "classes": {a + x: int(n) for (a, x), n in counts.items()}}
