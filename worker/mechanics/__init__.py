"""Campaign mechanic plugin registry (spec §9.2). One module per mechanic type."""
from __future__ import annotations

from types import ModuleType

from . import (price_discount, volume_tier, buy_x_get_y, mixed_set, gift_item,
               target_rebate, launch_seed, export_push)
from ._base import SETTLEMENT_COLUMNS

VERSION = 1
_MODULES = [price_discount, volume_tier, buy_x_get_y, mixed_set, gift_item,
            target_rebate, launch_seed, export_push]
REGISTRY: dict[str, ModuleType] = {m.CODE: m for m in _MODULES}
REQUIRED = ("CODE", "PARAM_SCHEMA", "validate", "explode", "demand_effect", "settle", "prior_band")
for _m in _MODULES:
    for _name in REQUIRED:
        assert hasattr(_m, _name), f"{_m.__name__} lacks {_name}"


def get(code: str) -> ModuleType:
    try:
        return REGISTRY[code]
    except KeyError:
        raise KeyError(f"unknown mechanic type {code!r}; known: {sorted(REGISTRY)}") from None


def schemas() -> dict[str, dict]:
    """code -> JSON Schema; the content of schemas.json and of mechanic_type.param_schema."""
    return {code: m.PARAM_SCHEMA for code, m in REGISTRY.items()}


def mechanic_type_rows() -> list[dict]:
    """Seed rows for the mechanic_type table (code, param_schema, module, version, active)."""
    return [{"code": c, "param_schema": m.PARAM_SCHEMA, "module": m.__name__,
             "version": VERSION, "active": True} for c, m in REGISTRY.items()]


def explode_order_line(order_line: dict, campaign_mechanics: list[dict]) -> list[dict]:
    """Apply every mechanic of a campaign to one order line; returns the extra lines."""
    out = []
    for cm in campaign_mechanics:
        out.extend(get(cm["mechanic_type"]).explode(order_line, cm["params"]))
    return out


__all__ = ["REGISTRY", "get", "schemas", "mechanic_type_rows", "explode_order_line",
           "SETTLEMENT_COLUMNS", "VERSION"]
