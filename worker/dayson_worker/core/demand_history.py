"""build_demand_history core (spec §8.1 step 1, §9.3).

Weekly demand per item, party and market from shipped lines and imported Logo
invoices; paid and free quantities kept apart; bundle components recorded
with source = bundle:<id>.
"""
from __future__ import annotations

import pandas as pd


def week_start(dates) -> pd.Series:
    """Monday of the week (weeks are identified by their Monday, Europe/Istanbul dates)."""
    d = pd.to_datetime(dates)
    if isinstance(d, pd.Series):
        return (d - pd.to_timedelta(d.dt.day_of_week, unit="D")).dt.normalize()
    return (d - pd.to_timedelta(d.day_of_week, unit="D")).normalize()


def build_demand_history(lines: pd.DataFrame) -> pd.DataFrame:
    """lines: (item_id, party_id, market_id, ship_date, qty, line_type in paid|free|bundle_component,
    bundle_id nullable, campaign_id nullable, bundle_line_free bool optional).

    Phantom-bundle parent lines must not be passed (their components are).
    bundle_component lines count as paid demand of the component unless flagged free.
    Returns (item_id, party_id, market_id, week, qty_paid, qty_free, source, campaign_id).
    """
    l = lines.copy()
    l["week"] = week_start(l["ship_date"])
    is_free = l["line_type"].eq("free")
    l["qty_paid"] = l["qty"].where(~is_free, 0.0)
    l["qty_free"] = l["qty"].where(is_free, 0.0)
    has_bundle = l["bundle_id"].notna() if "bundle_id" in l.columns else pd.Series(False, index=l.index)
    l["source"] = "order"
    if has_bundle.any():
        l.loc[has_bundle, "source"] = "bundle:" + l.loc[has_bundle, "bundle_id"].astype(str)
    if "campaign_id" not in l.columns:
        l["campaign_id"] = None
    keys = ["item_id", "party_id", "market_id", "week", "source", "campaign_id"]
    out = l.groupby(keys, dropna=False, as_index=False)[["qty_paid", "qty_free"]].sum()
    return out[["item_id", "party_id", "market_id", "week", "qty_paid", "qty_free", "source", "campaign_id"]]


def weekly_matrix(history: pd.DataFrame, value: str = "total", as_of_week=None) -> pd.DataFrame:
    """items x weeks matrix (dense, zero-filled). value: 'paid', 'free' or 'total'."""
    h = history.copy()
    h["week"] = pd.to_datetime(h["week"])
    h["v"] = {"paid": h["qty_paid"], "free": h["qty_free"], "total": h["qty_paid"] + h["qty_free"]}[value]
    wide = h.groupby(["item_id", "week"])["v"].sum().unstack(fill_value=0.0)
    end = (pd.Timestamp(as_of_week) - pd.Timedelta(days=7)) if as_of_week is not None else wide.columns.max()
    return wide.reindex(columns=pd.date_range(wide.columns.min(), end, freq="W-MON"), fill_value=0.0)


def balance_differences(moves: pd.DataFrame, balances: pd.DataFrame) -> pd.DataFrame:
    """rebuild_check core: balances rebuilt from stock_move versus stock_balance.

    Both frames carry item_id, lot_id, location_id, owner_id, stock_status, qty_base.
    Returns the rows where they differ (empty = ledger and balances agree).
    """
    keys = ["item_id", "lot_id", "location_id", "owner_id", "stock_status"]
    a = moves.groupby(keys, dropna=False)["qty_base"].sum().rename("rebuilt")
    b = balances.groupby(keys, dropna=False)["qty_base"].sum().rename("balance")
    m = pd.concat([a, b], axis=1).fillna(0.0)
    m["diff"] = m["rebuilt"] - m["balance"]
    return m[m["diff"].abs() > 1e-6].reset_index()
