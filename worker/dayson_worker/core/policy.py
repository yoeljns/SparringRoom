"""Policy formulas (spec §8.5): safety stock, reorder point, order-up-to, order quantity."""
from __future__ import annotations

import math

import numpy as np
from scipy.stats import norm


def z_for_service_level(service_level: float) -> float:
    """Service factor from the normal inverse, rounded to 2 decimals.

    The spec's worked example uses z = 1.96 for 97.5%; the exact inverse is
    1.95996, so the factor is rounded the way printed z-tables are.
    """
    if not 0.5 <= service_level < 1.0:
        raise ValueError("service level must be in [0.5, 1)")
    return round(float(norm.ppf(service_level)), 2)


def safety_stock(d: float, sd_d: float, L: float, sd_L: float, z: float) -> float:
    """SS = z x sqrt(L x sd_d² + d² x sd_L²) (unrounded)."""
    return z * math.sqrt(max(L, 0.0) * sd_d ** 2 + d ** 2 * sd_L ** 2)


def round_up(x: float, unit: float = 1.0) -> float:
    if unit <= 0:
        return x
    return math.ceil(x / unit - 1e-9) * unit


def continuous_policy(d, sd_d, L, sd_L, z, unit: float = 1.0) -> dict:
    """(s,Q): ROP = d x L + SS. SS is rounded up to whole ``unit`` (pallets)."""
    ss_raw = safety_stock(d, sd_d, L, sd_L, z)
    ss = round_up(ss_raw, unit)
    return {"policy": "continuous", "safety_stock_raw": ss_raw, "safety_stock": ss,
            "rop": d * L + ss, "d": d, "sd_d": sd_d, "L": L, "sd_L": sd_L, "z": z}


def periodic_policy(d, sd_d, L, sd_L, R, z, unit: float = 1.0) -> dict:
    """(R,S): S = d x (L+R) + z x sqrt((L+R) x sd_d² + d² x sd_L²)."""
    ss_raw = safety_stock(d, sd_d, L + R, sd_L, z)
    ss = round_up(ss_raw, unit)
    return {"policy": "periodic", "safety_stock_raw": ss_raw, "safety_stock": ss,
            "order_up_to": d * (L + R) + ss, "d": d, "sd_d": sd_d, "L": L, "sd_L": sd_L,
            "R": R, "z": z}


def empirical_order_up_to(history, L: float, R: float, service_level: float,
                          n_boot: int = 2000, seed: int = 0, unit: float = 1.0) -> dict:
    """S = service-level quantile of bootstrapped demand over L + R periods.

    Periods are resampled with replacement from the history; a fractional
    horizon adds that fraction of one more resampled period.
    """
    y = np.asarray(history, dtype=float)
    y = y[~np.isnan(y)]
    horizon = max(L + R, 0.0)
    if y.size == 0 or horizon == 0:
        return {"policy": "empirical", "order_up_to": 0.0, "safety_stock": 0.0, "L": L, "R": R,
                "service_level": service_level, "n_boot": n_boot}
    rng = np.random.default_rng(seed)
    whole = int(math.floor(horizon))
    frac = horizon - whole
    tot = rng.choice(y, size=(n_boot, whole)).sum(axis=1) if whole else np.zeros(n_boot)
    if frac > 1e-9:
        tot = tot + frac * rng.choice(y, size=n_boot)
    s = round_up(float(np.quantile(tot, service_level)), unit)
    mean = float(y.mean()) * horizon
    return {"policy": "empirical", "order_up_to": s, "safety_stock": max(0.0, s - mean),
            "mean_demand_LR": mean, "L": L, "R": R, "service_level": service_level,
            "n_boot": n_boot, "seed": seed}


def to_order_policy() -> dict:
    """Make or buy to order: no safety stock."""
    return {"policy": "to_order", "safety_stock": 0.0, "rop": 0.0, "order_up_to": 0.0}


def select_policy(family_kind: str, abc: str, xyz: str, pattern: str,
                  export_contract: bool = False, dealer_agreement_to_order: bool = False,
                  override: str | None = None, default_policy: str | None = None) -> dict:
    """Which policy applies (table in §8.5). Returns {"policy", "review_weeks", "group_by_supplier"}.

    ``default_policy`` is item_family.default_policy: when set it replaces the
    family-name rule (to_order stays to_order; intermittent and lumpy items of a
    stocked family still use the empirical quantile).

    Order of precedence: explicit override (planning_param 'reorder policy') ->
    make/buy to order (export contracts; C-Z items by dealer agreement) ->
    empirical (intermittent and lumpy) -> family rule. Classes the table does
    not name (C sealants, C tapes, other families) fall back to weekly periodic review.
    """
    fam = (family_kind or "").lower()
    if override:
        return {"policy": override, "review_weeks": 1.0 if override == "periodic" else 0.0,
                "group_by_supplier": fam == "abrasive"}
    if export_contract or (abc == "C" and xyz == "Z" and dealer_agreement_to_order):
        return {"policy": "to_order", "review_weeks": 0.0, "group_by_supplier": False}
    if default_policy:
        if default_policy == "to_order":
            return {"policy": "to_order", "review_weeks": 0.0, "group_by_supplier": False}
        pol = "empirical" if pattern in ("intermittent", "lumpy") else default_policy
        return {"policy": pol, "review_weeks": 0.0 if pol == "continuous" else 1.0, "group_by_supplier": False}
    if fam == "abrasive":
        pol = "empirical" if pattern in ("intermittent", "lumpy") else "periodic"
        return {"policy": pol, "review_weeks": 52 / 12, "group_by_supplier": True}
    if pattern in ("intermittent", "lumpy"):
        return {"policy": "empirical", "review_weeks": 1.0, "group_by_supplier": False}
    if (fam == "sealant" and abc in ("A", "B")) or (fam == "tape" and abc == "A"):
        return {"policy": "continuous", "review_weeks": 0.0, "group_by_supplier": False}
    return {"policy": "periodic", "review_weeks": 1.0, "group_by_supplier": False}


def economic_order_quantity(annual_demand: float, order_cost: float, unit_cost: float,
                            holding_rate: float) -> float:
    """EOQ = sqrt(2 D K / (h c)); 0 when any input is missing."""
    if annual_demand <= 0 or order_cost <= 0 or unit_cost <= 0 or holding_rate <= 0:
        return 0.0
    return math.sqrt(2 * annual_demand * order_cost / (holding_rate * unit_cost))


def order_quantity(*, weekly_demand: float, economic_qty: float = 0.0, moq: float = 0.0,
                   pallet_qty: float = 1.0, order_multiple: float = 0.0,
                   truck_qty: float | None = None, unit_cost: float = 0.0,
                   holding_rate: float = 0.0, freight_saved_per_truck: float = 0.0,
                   expiry_controlled: bool = False, shelf_life_days: float | None = None,
                   mrsl_days: float | None = None) -> dict:
    """Order quantity in base units, with every step recorded.

    1. Q = max(economic quantity, MOQ)
    2. rounded up to whole pallets and to the order multiple
    3. raised to a full-truck multiple when the added holding cost
       (extra units x unit cost x holding rate x time to consume them / 2 ...
       i.e. average extra stock held over the longer cycle) is below the freight saved
    4. expiry-controlled: capped so weeks of cover from one order stay below
       half of (shelf life - MRSL); the cap is rounded DOWN to whole pallets.
    """
    steps = {}
    q = max(economic_qty, moq)
    steps["max_eoq_moq"] = q
    q = round_up(q, pallet_qty) if pallet_qty > 0 else q
    if order_multiple and order_multiple > 0:
        q = round_up(q, order_multiple)
        if pallet_qty > 0 and abs(q / pallet_qty - round(q / pallet_qty)) > 1e-9:
            lcm_unit = _lcm_float(pallet_qty, order_multiple)
            q = round_up(q, lcm_unit)
    steps["rounded"] = q
    truck_raise = False
    if truck_qty and truck_qty > 0 and q > 0 and q % truck_qty > 1e-9:
        q_truck = round_up(q, truck_qty)
        extra = q_truck - q
        # extra units sit in stock on average half the time it takes to consume the larger order
        cycle_years = (q_truck / weekly_demand) / 52.0 if weekly_demand > 0 else float("inf")
        added_holding = extra * unit_cost * holding_rate * cycle_years / 2.0
        steps["truck_added_holding_cost"] = added_holding
        steps["truck_freight_saved"] = freight_saved_per_truck
        if added_holding < freight_saved_per_truck:
            q, truck_raise = q_truck, True
    steps["truck_raised"] = truck_raise
    capped = False
    if expiry_controlled and shelf_life_days is not None and weekly_demand > 0:
        max_weeks = 0.5 * (shelf_life_days - (mrsl_days or 0.0)) / 7.0
        cap = max_weeks * weekly_demand
        steps["expiry_cap_weeks"] = max_weeks
        if q >= cap:
            unit = pallet_qty if pallet_qty > 0 else 1.0
            q_cap = math.floor(cap / unit + 1e-9) * unit
            if q_cap >= cap - 1e-9:                 # cover must stay strictly below the limit
                q_cap -= unit
            q, capped = max(q_cap, 0.0), True
    steps["expiry_capped"] = capped
    return {"qty": q, "weeks_of_cover": (q / weekly_demand if weekly_demand > 0 else None), **steps}


def _lcm_float(a: float, b: float) -> float:
    sa, sb = round(a * 1000), round(b * 1000)
    return (sa * sb // math.gcd(sa, sb)) / 1000.0


def compute_item_policy(*, d: float, sd_d: float, L: float, sd_L: float, service_level: float,
                        policy: str, R: float = 0.0, history=None, unit: float = 1.0,
                        seed: int = 0) -> dict:
    """Dispatch to the policy formula. All time quantities in the same period (weeks)."""
    if policy == "to_order":
        out = to_order_policy()
    elif policy == "empirical":
        out = empirical_order_up_to(history if history is not None else [], L, R, service_level,
                                    seed=seed, unit=unit)
    else:
        z = z_for_service_level(service_level)
        out = (continuous_policy(d, sd_d, L, sd_L, z, unit) if policy == "continuous"
               else periodic_policy(d, sd_d, L, sd_L, R, z, unit))
    out["service_level"] = service_level
    return out


def compute_policies(frame, histories=None, seed: int = 0):
    """Vectorised policy for a DataFrame with columns
    d, sd_d, L, sd_L, R, service_level, policy [, unit].

    Returns the frame plus z, safety_stock, rop, order_up_to. ``histories`` is
    an items x weeks array (same row order) used for the empirical policy.
    """
    f = frame.copy()
    unit = f["unit"].to_numpy(float) if "unit" in f else np.ones(len(f))
    z = np.round(norm.ppf(f["service_level"].to_numpy(float)), 2)
    d, sd_d = f["d"].to_numpy(float), f["sd_d"].to_numpy(float)
    L, sd_L, R = f["L"].to_numpy(float), f["sd_L"].to_numpy(float), f["R"].to_numpy(float)
    pol = f["policy"].to_numpy()
    horizon = np.where(pol == "periodic", L + R, L)
    ss = z * np.sqrt(horizon * sd_d ** 2 + d ** 2 * sd_L ** 2)
    ss = np.ceil(ss / unit - 1e-9) * unit
    rop = d * L + ss
    s_up = d * (L + R) + ss
    f["z"] = z
    f["safety_stock"] = np.where(np.isin(pol, ["continuous", "periodic"]), ss, 0.0)
    f["rop"] = np.where(pol == "continuous", rop, np.nan)
    f["order_up_to"] = np.where(pol == "periodic", s_up, np.nan)
    emp = np.flatnonzero(pol == "empirical")
    if emp.size:
        if histories is None:
            raise ValueError("empirical policy needs histories")
        h = np.asarray(histories, dtype=float)
        for i in emp:
            r = empirical_order_up_to(h[i], L[i], R[i], float(f["service_level"].iloc[i]),
                                      seed=seed + int(i), unit=unit[i])
            f.iloc[i, f.columns.get_loc("order_up_to")] = r["order_up_to"]
            f.iloc[i, f.columns.get_loc("safety_stock")] = r["safety_stock"]
    to = pol == "to_order"
    f.loc[to, ["rop", "order_up_to"]] = 0.0
    return f
