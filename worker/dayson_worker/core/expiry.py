"""Shelf life (spec §7.2, §3.8, §9.3): MRSL check, ageing bands, kit expiry, lookup chains."""
from __future__ import annotations

from datetime import date

GREEN_MARGIN_DAYS = 90     # defaults; a family, item or single lot can override (§3.8)
BLOCK_DAYS = 60
BANDS = ("green", "amber", "red", "blocked")


def resolve_chain(levels: list[tuple[str, object]]):
    """First level that holds a value wins. levels: [(level name, value or None), ...]
    most specific first. Returns (value, level name) — the level is stored with the calculation."""
    for name, value in levels:
        if value is not None:
            return value, name
    return None, None


def mrsl_ok(expiry_date: date, ship_date: date, mrsl_days: int) -> bool:
    """A lot may be allocated only if expiry_date - ship_date >= mrsl_days."""
    return (expiry_date - ship_date).days >= mrsl_days


def ageing_band(remaining_days: float, domestic_mrsl_days: float, min_profile_mrsl_days: float | None = None,
                green_margin_days: float = GREEN_MARGIN_DAYS, block_days: float = BLOCK_DAYS,
                band_override: str | None = None) -> str:
    """Ageing band of a lot.

    green   : remaining life above domestic MRSL + green margin (90)
    amber   : between (the lowest MRSL of any profile) and domestic MRSL + margin
    red     : below MRSL for every profile
    blocked : under block_days (60)
    ``band_override`` (lot.band_override) wins when set.
    """
    if band_override:
        if band_override not in BANDS:
            raise ValueError(f"unknown band {band_override!r}")
        return band_override
    lowest = domestic_mrsl_days if min_profile_mrsl_days is None else min(domestic_mrsl_days, min_profile_mrsl_days)
    if remaining_days < block_days:
        return "blocked"
    if remaining_days < lowest:
        return "red"
    if remaining_days > domestic_mrsl_days + green_margin_days:
        return "green"
    return "amber"


def lot_band(expiry_date: date | None, as_of: date, domestic_mrsl_days: float, **kw) -> str | None:
    """Band for a lot on a date; None for lots without expiry control."""
    if expiry_date is None:
        return kw.get("band_override")
    return ageing_band((expiry_date - as_of).days, domestic_mrsl_days, **kw)


def kit_lot_expiry(component_expiries) -> date | None:
    """A kit lot takes the earliest component expiry (components without expiry are ignored)."""
    dates = [d for d in component_expiries if d is not None]
    return min(dates) if dates else None


def expiry_from_shelf_life(prod_date: date, shelf_life_days: int) -> date:
    from datetime import timedelta
    return prod_date + timedelta(days=int(shelf_life_days))
