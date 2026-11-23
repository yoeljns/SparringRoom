import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

import mechanics

VALID = {
    "price_discount": {"discount_pct": 10},
    "volume_tier": {"tiers": [{"min_qty": 10, "discount_pct": 3}, {"min_qty": 50, "discount_pct": 6}]},
    "buy_x_get_y": {"buy_item_rule": {"item_ids": ["A"]}, "buy_qty": 10, "free_item": "same", "free_qty": 1,
                    "max_per_order": None},
    "mixed_set": {"bundle_id": "B1", "price": 99.0},
    "gift_item": {"threshold_eur": 500, "gift_item": "GIFT-1", "qty": 1},
    "target_rebate": {"period": {"from": "2026-01-01", "to": "2026-03-31"}, "targets": {"A": 50000, "B": 20000},
                      "rebate_pct": 2.5},
    "launch_seed": {"item": "NEW-1", "seed_qty": {"A": 48, "B": 24}},
    "export_push": {"market": "DE", "items": ["A", "B"], "terms": {"discount_pct": 5, "payment_days": 60}},
}
INVALID = {
    "price_discount": [{}, {"discount_pct": 0}, {"discount_pct": 101}, {"discount_pct": "10"},
                       {"discount_pct": 10, "extra": 1}],
    "volume_tier": [{}, {"tiers": []}, {"tiers": [{"min_qty": 10}]}, {"tiers": [[10, 3]]},
                    {"tiers": [{"min_qty": 50, "discount_pct": 6}, {"min_qty": 10, "discount_pct": 3}]},
                    {"tiers": [{"min_qty": 10, "discount_pct": 6}, {"min_qty": 50, "discount_pct": 3}]}],
    "buy_x_get_y": [{}, {**VALID["buy_x_get_y"], "buy_qty": 0}, {**VALID["buy_x_get_y"], "free_qty": 1.5},
                    {**VALID["buy_x_get_y"], "buy_item_rule": {}}, {**VALID["buy_x_get_y"], "max_per_order": 0},
                    {k: v for k, v in VALID["buy_x_get_y"].items() if k != "free_item"}],
    "mixed_set": [{}, {"bundle_id": "B1"}, {"bundle_id": "B1", "price": -1}, {"bundle_id": 5, "price": 1}],
    "gift_item": [{"gift_item": "G", "qty": 1}, {"threshold_eur": 500, "threshold_qty": 10, "gift_item": "G", "qty": 1},
                  {"threshold_eur": 500, "gift_item": "G", "qty": 0}, {"threshold_qty": 10, "qty": 1}],
    "target_rebate": [{}, {**VALID["target_rebate"], "targets": {}}, {**VALID["target_rebate"], "rebate_pct": 0},
                      {**VALID["target_rebate"], "period": {"from": "2026-01-01"}},
                      {**VALID["target_rebate"], "period": {"from": "2026-03-31", "to": "2026-01-01"}}],
    "launch_seed": [{}, {"item": "N"}, {"item": "N", "seed_qty": {}}, {"item": "N", "seed_qty": {"A": 0}}],
    "export_push": [{}, {"market": "DE", "items": [], "terms": {}}, {"market": "DE", "items": ["A"]},
                    {"market": "DE", "items": ["A", "A"], "terms": {}},
                    {"market": "DE", "items": ["A"], "terms": {"discount_pct": 120}}],
}
CODES = ["price_discount", "volume_tier", "buy_x_get_y", "mixed_set", "gift_item", "target_rebate",
         "launch_seed", "export_push"]


def test_registry_has_the_eight_v1_mechanics_with_the_plugin_interface():
    assert sorted(mechanics.REGISTRY) == sorted(CODES)
    for code, m in mechanics.REGISTRY.items():
        assert m.CODE == code
        Draft202012Validator.check_schema(m.PARAM_SCHEMA)
        assert all(callable(getattr(m, f)) for f in ("validate", "explode", "demand_effect", "settle"))
    rows = mechanics.mechanic_type_rows()
    assert {r["code"] for r in rows} == set(CODES) and all(r["active"] for r in rows)


@pytest.mark.parametrize("code", CODES)
def test_validate_accepts_valid_parameters(code):
    assert mechanics.get(code).validate(VALID[code]) == []


@pytest.mark.parametrize("code,params", [(c, p) for c in CODES for p in INVALID[c]])
def test_validate_rejects_parameters_outside_schema(code, params):
    errs = mechanics.get(code).validate(params)
    assert errs and all(isinstance(e, str) for e in errs)


def test_schemas_json_matches_the_registry():
    path = Path(mechanics.__file__).with_name("schemas.json")
    assert json.loads(path.read_text(encoding="utf-8")) == mechanics.schemas()


def test_buy_10_get_1_on_35_units_adds_3_free_units():
    p = {"buy_item_rule": {"item_ids": ["A"]}, "buy_qty": 10, "free_item": "same", "free_qty": 1}
    line = {"id": "L1", "item_id": "A", "qty": 35}
    assert mechanics.get("buy_x_get_y").explode(line, p) == [
        {"item_id": "A", "qty": 3, "line_type": "free", "parent_line_id": "L1"}]
    assert mechanics.get("buy_x_get_y").explode({**line, "qty": 9}, p) == []
    assert mechanics.get("buy_x_get_y").explode({**line, "item_id": "Z"}, p) == []
    capped = mechanics.get("buy_x_get_y").explode(line, {**p, "max_per_order": 2, "free_item": "F", "free_qty": 2})
    assert capped == [{"item_id": "F", "qty": 4, "line_type": "free", "parent_line_id": "L1"}]
    by_attr = {**p, "buy_item_rule": {"attributes": {"colour": ["Gri", "Siyah"]}}}
    assert mechanics.get("buy_x_get_y").explode({**line, "attributes": {"colour": "Gri"}}, by_attr)[0]["qty"] == 3
    assert mechanics.get("buy_x_get_y").explode({**line, "attributes": {"colour": "Beyaz"}}, by_attr) == []


def test_no_extra_lines_for_discount_tier_rebate_export_and_seed():
    line = {"id": "L1", "item_id": "A", "qty": 100, "unit_price": 10}
    for code in ("price_discount", "volume_tier", "target_rebate", "export_push", "launch_seed"):
        assert mechanics.get(code).explode(line, VALID[code]) == []


def test_mixed_set_explodes_to_component_lines_from_bundle_line():
    line = {"id": "L9", "item_id": "SET-1", "qty": 3, "bundle_id": "B1",
            "bundle_lines": [{"component_item_id": "A", "qty": 2}, {"component_item_id": "B", "qty": 1}]}
    out = mechanics.get("mixed_set").explode(line, VALID["mixed_set"])
    assert out == [{"item_id": "A", "qty": 6, "line_type": "bundle_component", "parent_line_id": "L9"},
                   {"item_id": "B", "qty": 3, "line_type": "bundle_component", "parent_line_id": "L9"}]
    assert mechanics.get("mixed_set").explode({**line, "bundle_id": "other"}, VALID["mixed_set"]) == []


def test_gift_item_free_line_when_threshold_reached():
    g = mechanics.get("gift_item")
    assert g.explode({"id": "L1", "item_id": "A", "qty": 10, "order_total_eur": 500}, VALID["gift_item"]) == [
        {"item_id": "GIFT-1", "qty": 1, "line_type": "free", "parent_line_id": "L1"}]
    assert g.explode({"id": "L1", "item_id": "A", "qty": 10, "order_total_eur": 499.99}, VALID["gift_item"]) == []
    by_qty = {"threshold_qty": 20, "gift_item": "GIFT-1", "qty": 2}
    assert g.explode({"id": "L1", "item_id": "A", "qty": 20}, by_qty)[0]["qty"] == 2
    assert g.explode({"id": "L2", "item_id": "A", "qty": 20, "order_anchor": False}, by_qty) == []


def test_launch_seed_suggests_lines_per_dealer():
    dealers = [{"party_id": "d1", "segment": "A"}, {"party_id": "d2", "segment": "B"}, {"party_id": "d3", "segment": "C"}]
    out = mechanics.get("launch_seed").suggest_lines(dealers, VALID["launch_seed"])
    assert [(l["party_id"], l["item_id"], l["qty"]) for l in out] == [("d1", "NEW-1", 48), ("d2", "NEW-1", 24)]
    eff = mechanics.get("launch_seed").demand_effect([], {"weeks": [1, 2], "dealers_by_segment": {"A": 10, "B": 5}},
                                                     VALID["launch_seed"], None)
    assert sum(r["uplift"] for r in eff) == 10 * 48 + 5 * 24 and {r["item_id"] for r in eff} == {"NEW-1"}


def test_explode_order_line_runs_every_mechanic_of_the_campaign():
    cms = [{"mechanic_type": "price_discount", "params": VALID["price_discount"]},
           {"mechanic_type": "buy_x_get_y", "params": VALID["buy_x_get_y"]}]
    out = mechanics.explode_order_line({"id": "L1", "item_id": "A", "qty": 20}, cms)
    assert out == [{"item_id": "A", "qty": 2, "line_type": "free", "parent_line_id": "L1"}]
    with pytest.raises(KeyError):
        mechanics.get("nope")


def test_demand_effect_uses_library_prior_borrow_and_cannibalisation():
    baseline = [{"item_id": i, "week": w, "qty": 100.0} for i in ("A", "S") for w in range(1, 15)]
    scope = {"item_ids": ["A"], "weeks": [3, 4, 5, 6], "family_id": "F", "segment": None, "sisters": {"A": ["S"]}}
    lib = [{"id": "p1", "mechanic_type": "price_discount", "family_id": "F", "segment": None, "depth_band": "10-20",
            "prior_uplift": 0.30, "borrow_rate": 0.25, "cannibal_rate": 0.10}]
    rows = mechanics.get("price_discount").demand_effect(baseline, scope, {"discount_pct": 10}, lib)
    a = [r for r in rows if r["item_id"] == "A"]
    s = [r for r in rows if r["item_id"] == "S"]
    assert sum(r["uplift"] for r in a) == pytest.approx(120.0)             # 4 weeks x 100 x 30%
    assert {r["week"] for r in a if r["uplift"] > 0} == {3, 4, 5, 6}
    assert sum(r["pull_forward"] for r in a) == pytest.approx(30.0)        # 25% borrowed ...
    assert {r["week"] for r in a if r["pull_forward"] > 0} == set(range(7, 15))   # ... from the 8 weeks after
    assert sum(r["cannibalised"] for r in s) == pytest.approx(12.0) and all(r["prior_id"] == "p1" for r in rows)
    # no matching prior -> no effect
    none = mechanics.get("price_discount").demand_effect(baseline, scope, {"discount_pct": 3}, lib)
    assert sum(r["uplift"] for r in none) == 0
    # buy_x_get_y adds the free units as consumption on the free item
    bx = mechanics.get("buy_x_get_y").demand_effect(
        baseline, scope, {"buy_item_rule": {"all": True}, "buy_qty": 10, "free_item": "FREE", "free_qty": 1}, [])
    assert sum(r["uplift"] for r in bx if r["item_id"] == "FREE") == pytest.approx(40.0)


def test_settle_rows_rebate_free_goods_and_discount():
    cols = set(mechanics.SETTLEMENT_COLUMNS)
    lines = [{"party_id": "d1", "segment": "A", "item_id": "A", "qty": 100, "line_type": "paid", "net_eur": 60000,
              "list_eur": 66000, "unit_price": 660},
             {"party_id": "d2", "segment": "A", "item_id": "A", "qty": 10, "line_type": "paid", "net_eur": 30000,
              "list_eur": 33000},
             {"party_id": "d1", "segment": "A", "item_id": "A", "qty": 10, "line_type": "free", "unit_cost": 4.0}]
    rebate = mechanics.get("target_rebate").settle({"id": "C1", "params": VALID["target_rebate"], "lines": lines})
    assert rebate == [{"campaign_id": "C1", "mechanic": "target_rebate", "party_id": "d1", "item_id": None,
                       "kind": "rebate", "qty": 0.0, "amount_eur": 1500.0}]      # d2 missed the 50,000 target
    free = mechanics.get("buy_x_get_y").settle({"id": "C1", "params": VALID["buy_x_get_y"], "lines": lines})
    assert free[0]["kind"] == "free_goods" and free[0]["qty"] == 10 and free[0]["amount_eur"] == 40.0
    disc = mechanics.get("price_discount").settle({"id": "C1", "params": {"discount_pct": 10}, "lines": lines})
    assert [(r["party_id"], r["amount_eur"]) for r in disc] == [("d1", 6600.0), ("d2", 3300.0)]
    tier = mechanics.get("volume_tier").settle({"id": "C1", "params": VALID["volume_tier"], "lines": lines})
    assert [(r["party_id"], r["amount_eur"]) for r in tier] == [("d1", 3960.0), ("d2", 990.0)]
    for r in rebate + free + disc + tier:
        assert set(r) == cols
