"""Nightly: post-campaign review 8 weeks after close (§9.5) and uplift library update (§9.6)."""
from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

from .. import db
from ..core.campaign import campaign_review, estimate_method, observed_uplift, update_library_row
from ..core.dealer import review_confidence
from ._common import today, monday
import mechanics
from mechanics._base import depth_band

PRE, POST = 4, 8


def run(conn, as_of=None) -> dict:
    as_of = as_of or today()
    # SCHEMA: campaign(id, state, order_from, order_to); campaign_review(campaign_id, item_id*, gross, borrowed,
    #         cannibalised, net, confidence)
    due = db.query(conn, "select id, order_from, order_to from campaign where state = 'closed' "
                         "and order_to <= %s", [as_of - timedelta(weeks=POST)])
    done = 0
    for c in due:
        start, end = monday(c["order_from"]), monday(c["order_to"])
        weeks = pd.date_range(start - timedelta(weeks=PRE), end + timedelta(weeks=POST), freq="W-MON")
        window = (PRE, PRE + int((end - start).days // 7))
        cf = db.query_df(conn, "select distinct item_id from campaign_forecast where campaign_id = %s", [c["id"]])
        scope_items = list(cf["item_id"])
        if not scope_items:
            continue
        # baseline = the forecast base of the last run made before the order window opened
        # SCHEMA: forecast_run(id, created_at); forecast(run_id, item_id, week, base, level, bucket)
        base = db.query_df(conn, """
            select f.item_id, f.week, f.base from forecast f
             where f.run_id = (select id from forecast_run where created_at < %s order by created_at desc limit 1)
               and f.level = 'item' and f.bucket = 'week'""", [c["order_from"]])
        act = db.query_df(conn, "select item_id, week, sum(qty_paid + qty_free) as qty from demand_history "
                                "where week between %s and %s group by 1, 2", [weeks[0].date(), weeks[-1].date()])
        items = db.query_df(conn, "select id as item_id, family_id, coalesce(attributes->>'colour', attributes->>'size') "
                                  "as group_id from item").set_index("item_id")

        def series(frame, col, item):
            s = frame[frame["item_id"] == item].set_index(pd.to_datetime(frame[frame["item_id"] == item]["week"]))[col]
            return s.reindex(weeks).fillna(0.0).to_numpy()

        scope = db.query(conn, "select party_rule, market_ids from campaign_scope where campaign_id = %s", [c["id"]])
        limited = any(s["party_rule"] not in (None, {}, {"all": True}) for s in scope)
        est = estimate_method(limited, has_matched_non_participants=True)
        dealer_est = db.query(conn, "select qty_est, confidence from dealer_stock_estimate where item_id = any(%s)",
                              [scope_items])
        confidence = "low" if est["confidence"] == "low" or review_confidence(dealer_est) == "low" else "normal"
        mech = db.query(conn, "select mechanic_type, params from campaign_mechanic where campaign_id = %s", [c["id"]])
        rows = []
        for it in scope_items:
            grp = items.at[it, "group_id"] if it in items.index else None
            sis = [s for s in items.index[(items["group_id"] == grp) & (items["family_id"] == items.at[it, "family_id"])]
                   if s not in scope_items] if grp else []
            r = campaign_review(series(act, "qty", it), series(base, "base", it), window,
                                [(series(act, "qty", s), series(base, "base", s)) for s in sis], PRE, POST)
            rows.append({"campaign_id": c["id"], "item_id": it, "gross": r["gross"], "borrowed": r["borrowed"],
                         "cannibalised": r["cannibalised"], "net": r["net"], "confidence": confidence})
            base_win = float(series(base, "base", it)[window[0]:window[1] + 1].sum())
            obs = observed_uplift(r["net"], base_win)
            if np.isfinite(obs):
                for m in mech:
                    _update_library(conn, m, items.at[it, "family_id"], obs, est["method"], c["id"], as_of)
        db.insert_rows(conn, "campaign_review", rows)
        db.execute(conn, "update campaign set state = 'reviewed' where id = %s", [c["id"]])
        done += 1
    return {"reviewed": done}


def _update_library(conn, mech: dict, family_id, observed: float, method: str, campaign_id, as_of) -> None:
    p = mech["params"] or {}
    pct = p.get("discount_pct") or p.get("rebate_pct")
    band = depth_band(pct) if pct is not None else "na"
    assert mech["mechanic_type"] in mechanics.REGISTRY
    # SCHEMA: uplift_library(id, mechanic_type, family_id, segment, depth_band, prior_uplift, n_obs, last_obs jsonb)
    cur = db.query(conn, "select id, prior_uplift, n_obs, last_obs from uplift_library where mechanic_type = %s "
                         "and family_id = %s and segment is null and depth_band = %s",
                   [mech["mechanic_type"], family_id, band])
    row = cur[0] if cur else {"prior_uplift": 0.0, "n_obs": 0, "last_obs": []}
    new = update_library_row({**row, "prior_uplift": float(row["prior_uplift"] or 0)}, observed, method, str(campaign_id), as_of)
    if cur:
        db.execute(conn, "update uplift_library set prior_uplift = %s, n_obs = %s, last_obs = %s where id = %s",
                   [new["prior_uplift"], new["n_obs"], new["last_obs"], cur[0]["id"]])
    else:
        db.insert_rows(conn, "uplift_library", [{"mechanic_type": mech["mechanic_type"], "family_id": family_id,
                                                 "segment": None, "depth_band": band,
                                                 "prior_uplift": new["prior_uplift"], "n_obs": new["n_obs"],
                                                 "last_obs": new["last_obs"]}])
