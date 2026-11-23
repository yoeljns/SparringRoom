import numpy as np
import pandas as pd
import pytest

from dayson_worker.core import classification as C
from dayson_worker.core.forecast import route_method


def test_abc_80_15_5():
    v = pd.Series({"a": 50, "b": 30, "c": 10, "d": 5, "e": 3, "f": 2, "g": 0})
    abc = C.abc_classes(v)
    assert abc.to_dict() == {"a": "A", "b": "A", "c": "B", "d": "B", "e": "C", "f": "C", "g": "C"}


def test_xyz_cutoffs():
    assert [C.xyz_class(x) for x in (0.2, 0.49, 0.5, 1.0, 1.01)] == ["X", "X", "Y", "Y", "Z"]


def test_pattern_cutoffs_132_and_049():
    assert C.pattern(1.0, 0.2) == "smooth"
    assert C.pattern(1.31, 0.49) == "erratic"
    assert C.pattern(1.32, 0.48) == "intermittent"
    assert C.pattern(2.0, 0.6) == "lumpy"


def test_series_with_adi_3_25_is_intermittent_or_lumpy_and_routed_to_sba():
    y = np.zeros(52)
    y[[0, 3, 7, 10, 13, 16, 20, 23, 26, 29, 33, 36, 39, 42, 46, 49]] = [4, 5, 4, 6, 5, 4, 5, 6, 4, 5, 5, 4, 6, 5, 4, 5]
    adi, cv2 = C.adi_cv2(y)
    assert adi == pytest.approx(3.25)                       # 52 weeks / 16 demands
    pat = C.pattern(adi, cv2)
    assert pat in ("intermittent", "lumpy")
    assert route_method(pat, weeks_history=52, weeks_since_last_demand=2, mean_interval=adi) == "sba"
    # lumpy variant: same timing, very uneven sizes
    y2 = y.copy()
    y2[y2 > 0] = [1, 40, 2, 1, 60, 1, 2, 1, 35, 1, 2, 1, 1, 50, 1, 2]
    adi2, cv22 = C.adi_cv2(y2)
    assert adi2 == pytest.approx(3.25) and C.pattern(adi2, cv22) == "lumpy"
    assert route_method("lumpy", 52, weeks_since_last_demand=2, mean_interval=adi2) == "sba"
    # no demand for twice the usual interval -> TSB
    assert route_method(pat, 52, weeks_since_last_demand=7, mean_interval=adi) == "tsb"


def test_service_matrix_and_criticality_step():
    assert C.service_level("A", "Y") == 0.975
    assert C.service_level("C", "Z") == 0.90
    assert C.service_level("B", "Y", critical=True) == C.service_level("A", "Y") == 0.975
    assert C.service_level("C", "X", critical=True) == C.service_level("B", "X")
    assert C.service_level("A", "X", critical=True) == 0.98


def test_classify_frame():
    weeks = pd.date_range("2024-01-01", periods=104, freq="W-MON")
    rng = np.random.default_rng(0)
    smooth = 100 + rng.normal(0, 5, 104)
    inter = np.zeros(104)
    inter[::4] = 20
    tiny = np.r_[np.zeros(100), [1, 1, 1, 1]]
    w = pd.DataFrame([smooth, inter, tiny], index=["s", "i", "t"], columns=weeks)
    free = pd.DataFrame(0.0, index=w.index, columns=weeks)
    free.loc["t", weeks[-1]] = 1000                          # free goods valued at cost
    out = C.classify(w, unit_price=pd.Series({"s": 10.0, "i": 10.0, "t": 10.0}), weekly_free=free,
                     unit_cost=pd.Series({"s": 6.0, "i": 6.0, "t": 0.01}),
                     critical=pd.Series({"i": True}))
    assert out.loc["s", ["abc", "xyz", "pattern"]].tolist() == ["A", "X", "smooth"]
    assert out.loc["i", "pattern"] == "intermittent" and out.loc["i", "adi"] == pytest.approx(4.0)
    assert out.loc["t", "value_12m"] == pytest.approx(4 * 10 + 1000 * 0.01)
    assert out.loc["t", "abc"] == "C" and out.loc["t", "weeks_history"] == 4
    assert out.loc["i", "service_level"] == C.service_level(out.loc["i", "abc"], out.loc["i", "xyz"], True)
    # the vectorised statistics equal the scalar helper
    for k in ("s", "i", "t"):                              # pattern statistics use paid + free
        adi, cv2 = C.adi_cv2((w + free).loc[k].to_numpy())
        assert out.loc[k, "adi"] == pytest.approx(adi) and out.loc[k, "cv2"] == pytest.approx(cv2)
