"""reconciliation: compare our stock with the latest Logo snapshot (§11.4).

Runs only when a logo_stock_snapshot exists and the latest one has not been reconciled yet.
"""
from .. import db


def run(conn, as_of=None) -> dict:
    snap = db.scalar(conn, "select max(as_of) from logo_stock_snapshot")
    if snap is None:
        return {"skipped": "no logo_stock_snapshot"}
    if db.scalar(conn, "select 1 from recon_run where run_date = %s limit 1", [snap]):
        return {"skipped": f"snapshot {snap} already reconciled"}
    res = db.rpc(conn, "rpc_run_reconciliation()")
    return res if isinstance(res, dict) else {"result": res}
