"""uplift_model (§9.4): intensity measures and the per-family uplift model.

Intensity per item and week comes from demand_history: free-goods ratio and the share of
volume sold under a campaign (discount depth needs invoice prices against list and is taken
as 0 until price lists are loaded). A family is fitted once it has enough campaign weeks; the
coefficients (uplift b, lag terms = pull-forward, cross term = cannibalisation) are reported in
job_run.stats. The library priors used for new campaigns are updated by campaign_review.
"""
from __future__ import annotations

from datetime import timedelta

import pandas as pd

from .. import db
from ..core.campaign import intensity_measures, combined_intensity, fit_uplift_model
from ..core.demand_history import weekly_matrix
from ._common import business_date, monday, load_items

MIN_CAMPAIGN_ROWS = 26
HISTORY_WEEKS = 156


def run(conn, as_of=None) -> dict:
    as_of = business_date(conn, as_of)
    week0 = monday(as_of)
    lines = db.query_df(conn, """
        select item_id, week, campaign_id, sum(qty_paid) as qty_paid, sum(qty_free) as qty_free
          from demand_history where week < %s and week >= %s group by 1, 2, 3""",
                        [week0, week0 - timedelta(weeks=HISTORY_WEEKS)])
    if lines.empty:
        return {"skipped": "no demand history"}
    lines["list_eur"] = 0.0
    lines["net_eur"] = 0.0
    m = intensity_measures(lines)
    m["intensity"] = combined_intensity(m)
    items = load_items(conn)
    total = lines.groupby(["item_id", "week"], as_index=False)[["qty_paid", "qty_free"]].sum()
    wide = weekly_matrix(total, "total", week0)
    baseline = wide.T.rolling(13, center=True, min_periods=4).median().T      # campaign-robust local level
    inten = m.assign(week=pd.to_datetime(m["week"])).pivot(index="item_id", columns="week", values="intensity") \
        .reindex(index=wide.index, columns=wide.columns).fillna(0.0)
    fitted, skipped = {}, {}
    for fam, ids in items.reindex(wide.index).groupby("family_code").groups.items():
        ids = list(ids)
        n = int((inten.loc[ids] > 0).to_numpy().sum())
        if n < MIN_CAMPAIGN_ROWS:
            skipped[fam] = f"{n} item-weeks with campaign intensity (needs {MIN_CAMPAIGN_ROWS})"
            continue
        df = pd.DataFrame({"demand": wide.loc[ids].stack(), "baseline": baseline.loc[ids].stack(),
                           "intensity": inten.loc[ids].stack()}).reset_index()
        df.columns = ["item_id", "week", "demand", "baseline", "intensity"]
        df["group_id"] = df["item_id"].map(items["group_id"])
        model = fit_uplift_model(df.dropna())
        fitted[fam] = {"b": model.b, "lags": model.lags, "cross": model.cross, "n_obs": model.n_obs,
                       "campaign_item_weeks": n}
    return {"families_fitted": len(fitted), "models": fitted, "skipped": skipped,
            "intensity_rows": int((m["intensity"] > 0).sum())}
