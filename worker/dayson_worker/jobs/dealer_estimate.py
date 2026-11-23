"""dealer_estimate (§10.2, §10.3): one dealer_stock_estimate row per dealer and item (upsert).

Best direct observation while its confidence (source weight x 0.5^(age / half-life)) is usable;
otherwise inferred from the last observation + sell-in since - modelled sell-through. With no
observation the estimate is the last 8 weeks of sell-in minus modelled sell-through (the stock a
dealer has loaded above its usual rate). Modelled sell-through = average weekly sell-in of the
last 52 weeks. Low confidence on an A dealer opens a count_request task for the sales rep;
high estimated cover after a campaign raises a channel-loading warning. Estimates never feed
central safety stock or reorder.
"""
from __future__ import annotations

from datetime import timedelta

from .. import db
from ..core.dealer import estimate_dealer_stock, channel_loading_flags, is_usable
from ._common import business_date, monday

SELL_THROUGH_WEEKS = 52
NO_OBSERVATION_WINDOW = 8


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    week0 = monday(as_of)
    since = week0 - timedelta(weeks=SELL_THROUGH_WEEKS)
    dealers = {r["id"]: r for r in db.query(conn, """
        select p.id, p.name, p.segment,
               (resolve_param('dealer_confidence_half_life_days', jsonb_build_object('party_id', p.id))->>'value')::numeric as half_life,
               (resolve_param('dealer_confidence_threshold', jsonb_build_object('party_id', p.id))->>'value')::numeric as threshold,
               (resolve_param('channel_cover_weeks', jsonb_build_object('party_id', p.id))->>'value')::numeric as cover_weeks
          from party p where p.type = 'dealer' and p.active""")}
    sell = db.query(conn, """
        select h.party_id, h.item_id, h.week, sum(h.qty_paid + h.qty_free) as qty
          from demand_history h join party p on p.id = h.party_id
         where p.type = 'dealer' and h.week >= %s and h.week < %s group by 1, 2, 3""", [since, week0])
    first = {(r["party_id"], r["item_id"]): r["week"] for r in db.query(conn, """
        select h.party_id, h.item_id, min(h.week) as week from demand_history h join party p on p.id = h.party_id
         where p.type = 'dealer' and (h.qty_paid + h.qty_free) > 0 group by 1, 2""")}
    obs_rows = db.query(conn, """
        select party_id, item_id, qty, source, (observed_at at time zone 'Europe/Istanbul')::date as observed_at
          from dealer_stock_observation""")
    by_key: dict = {}
    for r in sell:
        by_key.setdefault((r["party_id"], r["item_id"]), []).append((r["week"], r["qty"]))
    obs: dict = {}
    for r in obs_rows:
        obs.setdefault((r["party_id"], r["item_id"]), []).append(r)

    estimates, rates = [], {}
    for key in sorted(set(by_key) | set(obs)):
        party_id, item_id = key
        d = dealers.get(party_id)
        if not d:
            continue
        weeks = by_key.get(key, [])
        hist_weeks = (week0 - first[key]).days / 7.0 if key in first else 0.0
        span = min(max(hist_weeks, 1.0), SELL_THROUGH_WEEKS)
        rate = sum(q for _, q in weeks) / span if weeks else 0.0
        o = [x for x in obs.get(key, []) if x["observed_at"] <= as_of]
        if o:
            base = max(o, key=lambda x: x["observed_at"])
            sell_in_since = sum(q for w, q in weeks if w >= monday(base["observed_at"]))
            sell_in_weeks = hist_weeks
        else:
            cut = week0 - timedelta(weeks=NO_OBSERVATION_WINDOW)
            sell_in_since = sum(q for w, q in weeks if w >= cut)
            sell_in_weeks = NO_OBSERVATION_WINDOW if hist_weeks >= NO_OBSERVATION_WINDOW else hist_weeks
        e = estimate_dealer_stock(o, as_of, sell_in_since=sell_in_since,
                                  weekly_sell_through=rate if (weeks or o) else None, sell_in_weeks=sell_in_weeks,
                                  half_life_days=float(d["half_life"] or 45), threshold=float(d["threshold"] or 0.5))
        cover = e["qty_est"] / rate if e["qty_est"] is not None and rate > 0 else None
        rates[key] = rate
        estimates.append({"party_id": party_id, "item_id": item_id, "qty_est": e["qty_est"], "method": e["method"],
                          "confidence": round(e["confidence"], 3), "weekly_sell_through": round(rate, 3),
                          "cover_weeks": round(cover, 2) if cover is not None else None, "as_of": as_of})

    for e in estimates:
        db.execute(conn, """
            insert into dealer_stock_estimate (party_id, item_id, qty_est, method, confidence, weekly_sell_through,
                                               cover_weeks, as_of)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (party_id, item_id) do update set qty_est = excluded.qty_est, method = excluded.method,
                confidence = excluded.confidence, weekly_sell_through = excluded.weekly_sell_through,
                cover_weeks = excluded.cover_weeks, as_of = excluded.as_of, created_at = now()""",
                   [e[k] for k in ("party_id", "item_id", "qty_est", "method", "confidence", "weekly_sell_through",
                                   "cover_weeks", "as_of")])

    # low confidence on an A dealer -> count request for the rep's next visit (only for items the dealer buys)
    tasks = 0
    recent = week0 - timedelta(weeks=26)
    for e in estimates:
        d = dealers[e["party_id"]]
        if d["segment"] != "A" or is_usable(e, float(d["threshold"] or 0.5)):
            continue
        if not any(w >= recent and q > 0 for w, q in by_key.get((e["party_id"], e["item_id"]), [])):
            continue
        tasks += db.execute(conn, """
            insert into task (type, party_id, item_id, assigned_role, payload)
            select 'count_request', %s, %s, 'sales_rep', %s
             where not exists (select 1 from task t where t.type = 'count_request' and t.party_id = %s
                                  and (t.item_id = %s or t.item_id is null) and t.state in ('open', 'in_progress'))""",
                            [e["party_id"], e["item_id"],
                             {"reason": "low_confidence", "confidence": e["confidence"], "method": e["method"],
                              "as_of": as_of}, e["party_id"], e["item_id"]])

    # channel loading after a campaign: usable estimates whose cover exceeds the threshold
    alerts = 0
    in_campaign = {(r["party_id"], r["item_id"]) for r in db.query(conn, """
        select e.party_id, e.item_id from dealer_stock_estimate e
         where exists (select 1 from campaign c where c.state in ('live', 'closed', 'reviewed')
                          and c.order_to >= %s and c.order_from <= %s
                          and app.campaign_in_scope(c.id, e.party_id, e.item_id))""",
                                                              [as_of - timedelta(weeks=12), as_of])}
    for party_id, d in dealers.items():
        mine = [e for e in estimates if e["party_id"] == party_id and (party_id, e["item_id"]) in in_campaign]
        for f in channel_loading_flags(mine, rates, float(d["cover_weeks"] or 12)):
            got = db.raise_alert(conn, "channel_loading", "warning",
                                 {"party": d["name"], "item_id": f["item_id"], "cover_weeks": round(f["cover_weeks"], 1),
                                  "confidence": f["confidence"], "threshold_weeks": d["cover_weeks"]},
                                 "party", party_id, f"channel_loading:{party_id}:{f['item_id']}:{week0}")
            alerts += got is not None
    methods: dict = {}
    for e in estimates:
        methods[e["method"]] = methods.get(e["method"], 0) + 1
    return {"estimates": len(estimates), "methods": methods, "count_requests": tasks, "channel_loading_alerts": alerts}
