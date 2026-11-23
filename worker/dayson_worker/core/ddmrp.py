"""DDMRP-style shadow buffers (spec §8.9, phase 5; sealant family, shadow only).

Zones from average daily usage (ADU) and decoupled lead time (DLT):
    yellow       = ADU x DLT
    red base     = ADU x DLT x lead-time factor
    red safety   = red base x variability factor
    red          = red base + red safety
    green        = max(ADU x DLT x lead-time factor, MOQ, ADU x order cycle days)
Campaign deltas are applied as planned adjustment factors on ADU:
    PAF = (base forecast + campaign delta) / base forecast.
Factors are DDMRP factors in planning_param.
"""
from __future__ import annotations


def planned_adjustment_factor(base_forecast: float, campaign_delta: float) -> float:
    if base_forecast <= 0:
        return 1.0
    return max(0.0, (base_forecast + campaign_delta) / base_forecast)


def buffer_zones(adu: float, dlt_days: float, lead_time_factor: float = 0.5,
                 variability_factor: float = 0.5, moq: float = 0.0, order_cycle_days: float = 0.0,
                 paf: float = 1.0) -> dict:
    adu_adj = adu * paf
    yellow = adu_adj * dlt_days
    red_base = yellow * lead_time_factor
    red_safety = red_base * variability_factor
    red = red_base + red_safety
    green = max(yellow * lead_time_factor, moq, adu_adj * order_cycle_days)
    return {"adu": adu, "paf": paf, "adu_adjusted": adu_adj, "dlt_days": dlt_days,
            "red_base": red_base, "red_safety": red_safety, "red": red, "yellow": yellow, "green": green,
            "top_of_red": red, "top_of_yellow": red + yellow, "top_of_green": red + yellow + green}


def net_flow(on_hand: float, on_order: float, qualified_demand: float) -> float:
    """Net flow position = on hand + on order - qualified sales-order demand."""
    return on_hand + on_order - qualified_demand


def order_recommendation(zones: dict, on_hand: float, on_order: float, qualified_demand: float) -> dict:
    """Order up to top of green when the net flow position is at or below top of yellow."""
    nfp = net_flow(on_hand, on_order, qualified_demand)
    qty = zones["top_of_green"] - nfp if nfp <= zones["top_of_yellow"] else 0.0
    zone = "red" if nfp <= zones["top_of_red"] else ("yellow" if nfp <= zones["top_of_yellow"] else "green")
    return {"net_flow_position": nfp, "zone": zone, "order_qty": max(0.0, qty)}


def fill_rate_per_euro(fill_rate: float, avg_stock_value_eur: float) -> float:
    """Comparison metric for keeping DDMRP or the classic method: fill rate per euro of stock."""
    return fill_rate / avg_stock_value_eur if avg_stock_value_eur > 0 else float("inf")


def compare_methods(classic: dict, ddmrp: dict) -> dict:
    """classic/ddmrp: {"fill_rate", "avg_stock_value_eur"}; keep the better fill rate per euro."""
    a = fill_rate_per_euro(classic["fill_rate"], classic["avg_stock_value_eur"])
    b = fill_rate_per_euro(ddmrp["fill_rate"], ddmrp["avg_stock_value_eur"])
    return {"classic": a, "ddmrp": b, "keep": "ddmrp" if b > a else "classic"}
