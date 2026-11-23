import pytest

from dayson_worker.core.loadplan import plan_trucks, single_item_feasibility, smallest_top_up, signature

KG = {"Beyaz": 595, "Antrasit": 594, "Siyah": 589, "Gri": 598, "Kırmızı": 605,
      "Sosis Beyaz": 891, "Sosis Antrasit": 890, "Sosis JF7 Gri": 960,
      "Sosis Siyah": 879, "Sosis Gri": 903, "Sosis Kırmızı": 916}
MIN_KG, MAX_KG = 24_900, 25_075

# the table on spec p23: item -> (pallets, kg) when a single-colour truck is in the window
IN_WINDOW = {"Beyaz": (42, 24_990), "Antrasit": (42, 24_948), "Sosis Beyaz": (28, 24_948),
             "Sosis Antrasit": (28, 24_920), "Sosis JF7 Gri": (26, 24_960)}
# item -> ((pallets, kg) under, (pallets, kg) over)
ALONE_INFEASIBLE = {"Siyah": ((42, 24_738), (43, 25_327)), "Gri": ((41, 24_518), (42, 25_116)),
                    "Kırmızı": ((41, 24_805), (42, 25_410)), "Sosis Siyah": ((28, 24_612), (29, 25_491)),
                    "Sosis Gri": ((27, 24_381), (28, 25_284)), "Sosis Kırmızı": ((27, 24_732), (28, 25_648))}


@pytest.mark.parametrize("item,expected", IN_WINDOW.items())
def test_single_colour_in_window(item, expected):
    pallets, kg = expected
    f = single_item_feasibility(KG[item], MIN_KG, MAX_KG)
    assert f["feasible"] and (f["pallets"], f["kg"]) == (pallets, kg)
    plan = plan_trucks({item: pallets}, KG, MIN_KG, MAX_KG)
    assert plan["n_trucks"] == 1 and plan["remainder"] == {}
    assert plan["trucks"][0]["kg"] == kg and plan["trucks"][0]["window_ok"]
    assert plan["trucks"][0]["lines"] == [{"item": item, "pallets": pallets, "kg": kg}]


@pytest.mark.parametrize("item,expected", ALONE_INFEASIBLE.items())
def test_single_colour_infeasible_alone(item, expected):
    (u_p, u_kg), (o_p, o_kg) = expected
    f = single_item_feasibility(KG[item], MIN_KG, MAX_KG)
    assert not f["feasible"]
    assert (f["under"]["pallets"], f["under"]["kg"]) == (u_p, u_kg) and u_kg < MIN_KG
    assert (f["over"]["pallets"], f["over"]["kg"]) == (o_p, o_kg) and o_kg > MAX_KG
    for pallets in (u_p, o_p):                         # the solver agrees: no truck, everything is remainder
        plan = plan_trucks({item: pallets}, KG, MIN_KG, MAX_KG)
        assert plan["n_trucks"] == 0 and plan["remainder"] == {item: pallets}
        assert plan["top_up"] is None                  # no top-up exists from this item alone


def test_two_colour_mix_20_gri_22_siyah():
    plan = plan_trucks({"Gri": 20, "Siyah": 22}, KG, MIN_KG, MAX_KG)
    assert plan["n_trucks"] == 1 and plan["remainder"] == {} and plan["n_patterns"] == 1
    t = plan["trucks"][0]
    assert t["kg"] == 24_918 and t["pallets"] == 42 and t["signature"] == "Gri:20|Siyah:22"
    assert {l["item"]: l["pallets"] for l in t["lines"]} == {"Gri": 20, "Siyah": 22}


def test_126_beyaz_returns_3_identical_trucks():
    plan = plan_trucks({"Beyaz": 126}, KG, MIN_KG, MAX_KG)
    assert plan["n_trucks"] == 3 and plan["n_patterns"] == 1 and plan["remainder"] == {}
    assert {t["signature"] for t in plan["trucks"]} == {"Beyaz:42"}
    assert len({t["pattern_id"] for t in plan["trucks"]}) == 1
    assert all(t["kg"] == 24_990 for t in plan["trucks"]) and plan["avg_kg"] == 24_990
    assert plan["patterns"][0]["trucks"] == 3
    assert all(v == "OPTIMAL" for v in plan["status"].values())


def test_every_truck_obeys_window_items_and_ships_whole_pallets():
    order = {"Beyaz": 84, "Gri": 40, "Siyah": 44, "Antrasit": 42}
    plan = plan_trucks(order, KG, MIN_KG, MAX_KG, max_items=5)
    shipped = {}
    for t in plan["trucks"]:
        assert MIN_KG <= t["kg"] <= MAX_KG and len(t["lines"]) <= 5
        assert t["kg"] == sum(l["pallets"] * KG[l["item"]] for l in t["lines"])
        for l in t["lines"]:
            assert l["pallets"] == int(l["pallets"]) > 0
            shipped[l["item"]] = shipped.get(l["item"], 0) + l["pallets"]
    assert plan["remainder"] == {} and shipped == order
    assert plan["n_trucks"] == 5
    # fewest pairings first: 3 single-colour trucks + 2 Gri/Siyah mixes = 7 pairings, 3 distinct patterns
    assert plan["pairings"] == 7 and plan["n_patterns"] == 3
    assert sorted(t["signature"] for t in plan["trucks"]).count("Gri:20|Siyah:22") == 2


def test_remainder_reported_with_smallest_top_up():
    plan = plan_trucks({"Beyaz": 50}, KG, MIN_KG, MAX_KG)
    assert plan["n_trucks"] == 1 and plan["remainder"] == {"Beyaz": 8}
    top = plan["top_up"]
    assert top["add"] == {"Beyaz": 34} and top["added_pallets"] == 34 and top["kg"] == [24_990]
    # with other items allowed, fewer (heavier) pallets can complete the truck
    other = smallest_top_up({"Beyaz": 8}, KG, MIN_KG, MAX_KG)
    assert other["added_pallets"] < 34
    assert MIN_KG <= other["kg"][0] <= MAX_KG
    # a colour that cannot ship alone gets a mixed top-up
    siyah = smallest_top_up({"Siyah": 22}, {"Siyah": 589, "Gri": 598}, MIN_KG, MAX_KG)
    # 20 pallets either way; among those the lightest: 18 Gri + 2 Siyah -> 24 Siyah + 18 Gri = 24,900 kg
    assert siyah["added_pallets"] == 20 and siyah["add"] == {"Gri": 18, "Siyah": 2} and siyah["kg"] == [24_900]


def test_max_items_and_positions_are_hard_limits():
    one = plan_trucks({"Gri": 20, "Siyah": 22}, KG, MIN_KG, MAX_KG, max_items=1)
    assert one["n_trucks"] == 0 and one["remainder"] == {"Gri": 20, "Siyah": 22}
    cap = plan_trucks({"Beyaz": 42}, KG, MIN_KG, MAX_KG, max_positions=40)
    assert cap["n_trucks"] == 0
    ok = plan_trucks({"Sosis Beyaz": 28}, KG, MIN_KG, MAX_KG, max_positions=33)
    assert ok["n_trucks"] == 1


def test_known_patterns_are_preferred_and_keep_their_id():
    order = {"Gri": 36, "Siyah": 48}       # 2 trucks: 20/22 + 16/26 (24,882: invalid) ... or 2 x (18 Gri + 24 Siyah)
    free = plan_trucks(order, KG, MIN_KG, MAX_KG)
    assert free["n_trucks"] == 2 and free["n_patterns"] == 1
    known = [{"id": "LP-7", "lines": {"Gri": 18, "Siyah": 24}}]
    plan = plan_trucks(order, KG, MIN_KG, MAX_KG, known_patterns=known)
    assert {t["pattern_id"] for t in plan["trucks"]} == {"LP-7"} and plan["patterns"][0]["known"]
    assert signature({"Siyah": 24, "Gri": 18}) == "Gri:18|Siyah:24"


def test_delivery_schedule_keeps_monthly_mix_within_tolerance():
    order = {"Beyaz": 168, "Antrasit": 84}                       # 4 + 2 trucks, mix 2/3 : 1/3
    sched = {"trucks_per_month": [3, 3], "mix_tolerance": 0.05, "months": ["2026-12", "2027-01"]}
    plan = plan_trucks(order, KG, MIN_KG, MAX_KG, schedule=sched)
    assert plan["n_trucks"] == 6 and plan["remainder"] == {}
    for month in sched["months"]:
        ts = [t for t in plan["trucks"] if t["month"] == month]
        assert len(ts) == 3
        pallets = sum(t["pallets"] for t in ts)
        beyaz = sum(l["pallets"] for t in ts for l in t["lines"] if l["item"] == "Beyaz")
        assert abs(beyaz / pallets - 168 / 252) <= 0.05 + 1e-9
    # an uneven split (all Antrasit in one month) would violate the tolerance; without it nothing forbids it
    loose = plan_trucks(order, KG, MIN_KG, MAX_KG, schedule={**sched, "mix_tolerance": 1.0})
    assert loose["n_trucks"] == 6


def test_fractional_weights_are_scaled_to_grams():
    plan = plan_trucks({"A": 42}, {"A": 594.5}, MIN_KG, MAX_KG)
    assert plan["n_trucks"] == 1 and plan["trucks"][0]["kg"] == pytest.approx(24_969.0)


def test_objective_order_is_configurable():
    order = {"Beyaz": 84, "Gri": 40, "Siyah": 44}
    a = plan_trucks(order, KG, MIN_KG, MAX_KG, objective_order=("identical", "pairings", "avg_kg"))
    b = plan_trucks(order, KG, MIN_KG, MAX_KG, objective_order=("pairings", "identical", "avg_kg"))
    assert a["n_trucks"] == b["n_trucks"] == 4
    assert list(a["status"])[1] == "identical" and list(b["status"])[1] == "pairings"
    assert b["pairings"] == 6
