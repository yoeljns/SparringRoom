import numpy as np
import pytest

from dayson_worker.core.leadtime import lead_time_stat, lead_time_change, stock_impact_of_change


def test_uses_latest_20_receipts():
    days = [100] * 10 + list(range(20, 40))
    st = lead_time_stat(days, quoted_days=30)
    assert st.n == 20 and st.source == "measured"
    assert st.mean_days == pytest.approx(29.5)
    assert st.sd_days == pytest.approx(np.std(range(20, 40), ddof=1))
    assert st.p90_days == pytest.approx(np.percentile(range(20, 40), 90))


def test_below_5_receipts_uses_quoted_with_sd_25_percent():
    st = lead_time_stat([50, 60, 70, 80], quoted_days=42)
    assert (st.n, st.mean_days, st.sd_days, st.source) == (4, 42.0, 10.5, "quoted")
    assert st.p90_days == pytest.approx(42 + 1.2816 * 10.5, abs=0.01)
    assert lead_time_stat([50, 60, 70, 80, 90], quoted_days=42).source == "measured"
    with pytest.raises(ValueError):
        lead_time_stat([], quoted_days=None)


def test_change_over_15_percent_raises_alert():
    old = {"mean_days": 40.0, "p90_days": 50.0}
    assert lead_time_change(old, {"mean_days": 45.0, "p90_days": 57.0}) is None          # +12.5%, +14%
    ch = lead_time_change(old, {"mean_days": 47.0, "p90_days": 50.0})
    assert set(ch) == {"mean_days"} and ch["mean_days"]["change"] == pytest.approx(0.175)
    assert set(lead_time_change(old, {"mean_days": 40.0, "p90_days": 40.0})) == {"p90_days"}
    assert lead_time_change(None, old) is None


def test_stock_impact_of_6_to_10_weeks():
    imp = stock_impact_of_change(10, 4, 1.96, {"mean_days": 42, "sd_days": 7}, {"mean_days": 70, "sd_days": 7})
    assert imp["ss_delta"] > 0 and imp["rop_delta"] == pytest.approx(10 * 4 + imp["ss_delta"])
