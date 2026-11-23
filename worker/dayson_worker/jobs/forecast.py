"""forecast (§8.3): 26 weekly buckets per SKU and every hierarchy node, 18 monthly per family.

final = base + campaign_delta + override_delta. Campaign deltas come from campaign_forecast
of approved and live campaigns; overrides from active forecast_override rows. Accuracy rows
(WAPE, bias, MASE, forecast value added) are measured at lag = lead time: from a hold-out
backtest of the statistical forecast and, once earlier runs exist, from the stored final
forecasts of those runs.
"""
from __future__ import annotations

import math
import os
from datetime import timedelta

import numpy as np
import pandas as pd

from .. import db
from ..core import accuracy as acc
from ..core.forecast import run_forecast, family_monthly_forecast, naive_forecast, H_WEEKS, H_MONTHS
from ._common import business_date, monday, load_items, load_weekly_history, load_lanes

LEVELS = {"item": "sku", "group": "group", "family": "family", "total": "total", "market": "market"}
HOLDOUT_WEEKS = 13


def n_jobs() -> int:
    return int(os.environ.get("WORKER_N_JOBS", "-1"))


def forecast_items(items: pd.DataFrame, hist: pd.DataFrame) -> pd.DataFrame:
    """Sellable items plus anything with demand history; family_id is the family code (node name)."""
    keep = items["sellable"].astype(bool) | items.index.isin(hist["item_id"].unique())
    f = items[keep].copy()
    f["family_uuid"] = f["family_id"]
    f["family_id"] = f["family_code"]
    return f


def with_zero_rows(hist: pd.DataFrame, items: pd.DataFrame, week0) -> pd.DataFrame:
    """Items without history still get a (zero) series so every SKU has its 26 buckets."""
    h = hist[hist["item_id"].isin(items.index)][["item_id", "week", "qty"]]
    missing = items.index.difference(h["item_id"].unique())
    first = h["week"].min() if len(h) else week0 - timedelta(weeks=1)
    if len(missing):
        h = pd.concat([h, pd.DataFrame({"item_id": missing, "week": first, "qty": 0.0})], ignore_index=True)
    return h


def node_name(node: str, level: str, items: pd.DataFrame) -> str:
    parts = node.split("/")
    if level == "item":
        return items.at[parts[-1], "sku"]
    if level == "group":
        return f"{parts[1]}:{parts[2]}"
    if level == "family":
        return parts[1]
    return "TOTAL"


def campaign_deltas(conn, week0) -> pd.DataFrame:
    return db.query_df(conn, """
        select f.item_id, f.week,
               sum(coalesce(f.override, f.uplift) + f.free_qty - f.pull_forward - f.cannibalised) as delta
          from campaign_forecast f join campaign c on c.id = f.campaign_id
         where c.state in ('approved', 'live') and f.week >= %s group by 1, 2""", [week0])


def contract_schedules(conn, week0) -> dict:
    """Export contracts: the open contract lines are the demand, by promised week."""
    rows = db.query(conn, """
        select l.item_id, app.week_start(coalesce(l.promised_date, o.requested_date)) as week,
               sum(l.qty - l.shipped_qty) as qty
          from so_line l join sales_order o on o.id = l.order_id join item i on i.id = l.item_id
         where i.export_contract and o.order_type = 'export_contract'
           and o.state in ('confirmed', 'allocated', 'picking') and not l.is_phantom and l.qty > l.shipped_qty
         group by 1, 2""")
    out: dict = {}
    for r in rows:
        out.setdefault(r["item_id"], {})[max(r["week"], week0)] = r["qty"]
    return out


def backtest(hist: pd.DataFrame, items: pd.DataFrame, week0, lag_by_family: dict, jobs: int) -> dict | None:
    """Hold out the last 13 weeks, forecast them from the history before, compare at lag = lead time."""
    weeks_hist = (pd.Timestamp(week0) - pd.Timestamp(hist["week"].min())).days // 7 if len(hist) else 0
    if weeks_hist < 3 * HOLDOUT_WEEKS:
        return None
    cutoff = week0 - timedelta(weeks=HOLDOUT_WEEKS)
    train = hist[hist["week"] < cutoff]
    train = with_zero_rows(train, items, cutoff)
    res = run_forecast(train, items, cutoff, h=HOLDOUT_WEEKS, n_jobs=jobs)
    f = res["forecast"]
    sku = f[f["level"] == "item"].pivot(index="item_id", columns="week", values="base")
    wide = res["wide_history"]
    item_nodes = res["nodes"][res["nodes"]["level"] == "item"]
    wide_items = wide.loc[item_nodes.index].set_axis(item_nodes["item_id"].to_numpy())
    naive = naive_forecast(wide_items, h=HOLDOUT_WEEKS).reindex(sku.index)
    actual = hist[hist["week"] >= cutoff].assign(week=lambda d: pd.to_datetime(d["week"])) \
        .pivot_table(index="item_id", columns="week", values="qty", aggfunc="sum") \
        .reindex(index=sku.index, columns=sku.columns).fillna(0.0)
    steps = np.arange(1, HOLDOUT_WEEKS + 1)
    fam_rows, item_rows = [], []
    for fam, ids in items.groupby("family_id").groups.items():
        ids = [i for i in ids if i in sku.index]
        if not ids:
            continue
        lag = int(min(max(1, lag_by_family.get(fam, 1)), HOLDOUT_WEEKS - 3))
        cols = sku.columns[steps >= lag]
        a, s, n = actual.loc[ids, cols].to_numpy(), sku.loc[ids, cols].to_numpy(), naive.loc[ids, cols].to_numpy()
        if not np.abs(a).sum() > 0:                      # nothing sold in the hold-out: no error measure
            continue
        fva = acc.forecast_value_added(a, n, s, s)
        fam_rows.append({"family": fam, "lag_weeks": lag, "n": int(a.size), "wape": acc.wape(a, s),
                         "bias": acc.bias(a, s), "wape_naive": fva["wape_naive"], "wape_stat": fva["wape_statistical"],
                         "fva_stat": fva["fva_statistical"]})
        for i in ids:
            if item_nodes.loc[item_nodes["item_id"] == i, "pattern"].iloc[0] in ("intermittent", "lumpy"):
                m = acc.mase(actual.loc[i, cols], sku.loc[i, cols], wide_items.loc[i].to_numpy())
                if not np.isfinite(m):
                    continue
                item_rows.append({"family": fam, "item_id": i, "lag_weeks": lag, "n": len(cols), "mase": m})
    return {"family": fam_rows, "items": item_rows, "cutoff": cutoff}


def snapshot_accuracy(conn, week0, hist: pd.DataFrame, items: pd.DataFrame, lag_by_family: dict) -> dict:
    """WAPE of the stored final forecasts of earlier runs at lag = lead time: {family: (wape, n)}."""
    snaps = db.query_df(conn, """
        select f.item_id, app.week_start((r.run_at at time zone 'Europe/Istanbul')::date) as made_week,
               f.period as week, f.final, f.base
          from forecast f join forecast_run r on r.id = f.run_id
         where f.level = 'sku' and f.bucket = 'week' and f.period < %s and f.period >= %s""",
                        [week0, week0 - timedelta(weeks=HOLDOUT_WEEKS)])
    if snaps.empty:
        return {}
    lag_item = items["family_id"].map(lag_by_family).fillna(1.0)
    s = acc.at_lag(snaps, lag_item)
    if s.empty:
        return {}
    a = hist.assign(week=pd.to_datetime(hist["week"]))[["item_id", "week", "qty"]]
    m = s.merge(a, on=["item_id", "week"], how="left").fillna({"qty": 0.0})
    m["family"] = m["item_id"].map(items["family_id"])
    return {fam: (acc.wape(g["qty"], g["final"]), acc.wape(g["qty"], g["base"]), len(g))
            for fam, g in m.groupby("family")}


def _num(v, nd=4):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    week0 = monday(as_of)
    plan = db.current_plan(conn)
    all_items = load_items(conn)
    hist = load_weekly_history(conn, week0)
    items = forecast_items(all_items, hist)
    if items.empty:
        return {"skipped": "no items to forecast"}
    h = with_zero_rows(hist, items, week0)
    jobs = n_jobs()
    overrides = db.query_df(conn, """
        select item_id, period as week, sum(delta) as delta from forecast_override
         where state = 'active' and level = 'sku' and bucket = 'week' and item_id is not null and period >= %s
         group by 1, 2""", [week0])
    camp = campaign_deltas(conn, week0)
    res = run_forecast(h, items, week0, campaign_delta=camp, overrides=overrides,
                       contract_schedules=contract_schedules(conn, week0), h=H_WEEKS, n_jobs=jobs)
    f = res["forecast"]
    nodes = res["nodes"]

    cls = db.current_run(conn, "classification_run")
    db.execute(conn, "update forecast_run set is_current = false where is_current")
    run_id = db.insert_one(conn, "forecast_run", {
        "is_current": True, "plan_version_id": plan["id"], "classification_run_id": cls["id"] if cls else None,
        "param_version": db.param_version(conn), "metrics": {}})

    names = {n: node_name(n, lvl, items) for n, lvl in nodes["level"].items()}
    rows = []
    for r in f.itertuples(index=False):
        rows.append({"run_id": run_id, "level": LEVELS[r.level], "item_id": r.item_id if r.level == "item" else None,
                     "node": names[r.node], "bucket": "week", "period": r.week.date(),
                     "base": round(r.base, 3), "campaign_delta": round(r.campaign_delta, 3),
                     "override_delta": round(r.override_delta, 3), "final": round(r.final, 3), "method": r.method})
    n_week = len(rows)

    # 18 monthly buckets per family
    fam_nodes = nodes.index[nodes["level"] == "family"]
    monthly = family_monthly_forecast(res["wide_history"].loc[fam_nodes], h=H_MONTHS, n_jobs=jobs)
    fam_delta = f[f["level"] == "family"].assign(month=lambda d: d["week"].dt.to_period("M").dt.to_timestamp()) \
        .groupby(["node", "month"])[["campaign_delta", "override_delta"]].sum()
    for r in monthly.itertuples(index=False):
        cd, od = fam_delta.loc[(r.family_id, r.month)] if (r.family_id, r.month) in fam_delta.index else (0.0, 0.0)
        rows.append({"run_id": run_id, "level": "family", "item_id": None, "node": names[r.family_id], "bucket": "month",
                     "period": r.month.date(), "base": round(r.base, 3), "campaign_delta": round(cd, 3),
                     "override_delta": round(od, 3), "final": round(max(r.base + cd + od, 0.0), 3), "method": r.method})
    db.insert_rows(conn, "forecast", rows)

    # accuracy at lag = lead time
    lanes = load_lanes(conn)
    lt = pd.Series({i: (lanes[i]["mean_days"] or lanes[i]["quoted_lt_days"] or 7.0) for i in items.index if i in lanes},
                   dtype=float)
    lag_by_family = {fam: int(math.ceil(lt.reindex(ids).dropna().mean() / 7.0)) if lt.reindex(ids).notna().any() else 1
                     for fam, ids in items.groupby("family_id").groups.items()}
    fam_uuid = items.groupby("family_id")["family_uuid"].first().to_dict()
    bt = backtest(hist, items, week0, lag_by_family, jobs)
    snap = snapshot_accuracy(conn, week0, hist, items, lag_by_family)
    acc_rows = []
    for r in (bt["family"] if bt else []):
        final = snap.get(r["family"])
        acc_rows.append({"run_id": run_id, "family_id": fam_uuid[r["family"]], "item_id": None,
                         "lag_weeks": r["lag_weeks"], "n": r["n"],
                         "wape": _num(final[0] if final else r["wape"]), "bias": _num(r["bias"]), "mase": None,
                         "wape_naive": _num(r["wape_naive"]), "wape_stat": _num(r["wape_stat"]),
                         "wape_final": _num(final[0]) if final else None, "fva_stat": _num(r["fva_stat"]),
                         "fva_final": _num(final[1] - final[0]) if final else None})
    for r in (bt["items"] if bt else []):
        acc_rows.append({"run_id": run_id, "family_id": fam_uuid[r["family"]], "item_id": r["item_id"],
                         "lag_weeks": r["lag_weeks"], "n": r["n"], "wape": None, "bias": None, "mase": _num(r["mase"]),
                         "wape_naive": None, "wape_stat": None, "wape_final": None, "fva_stat": None, "fva_final": None})
    db.insert_rows(conn, "forecast_accuracy", acc_rows)

    sku_nodes = nodes[nodes["level"] == "item"]
    metrics = {"as_of": as_of, "first_week": week0, "skus": int(len(sku_nodes)), "weekly_rows": n_week,
               "monthly_rows": len(rows) - n_week, "methods": sku_nodes["method"].value_counts().to_dict(),
               "campaign_delta_total": float(f.loc[f["level"] == "total", "campaign_delta"].sum()),
               "override_delta_total": float(f.loc[f["level"] == "total", "override_delta"].sum()),
               "accuracy_source": {"statistical": "backtest" if bt else None, "final": "past runs" if snap else None},
               "backtest_cutoff": bt["cutoff"] if bt else None, "lag_weeks_by_family": lag_by_family,
               "reconciliation": "MinT wls_struct"}
    db.execute(conn, "update forecast_run set metrics = %s where id = %s", [metrics, run_id])
    return {"run_id": run_id, **{k: metrics[k] for k in ("skus", "weekly_rows", "monthly_rows", "methods")},
            "accuracy_rows": len(acc_rows)}
