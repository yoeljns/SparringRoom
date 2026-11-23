"""rebuild_check: balances rebuilt from the ledger must equal stock_balance (§4, §13.1).

The comparison and its critical alert are done by rpc_rebuild_check(); the job fails when
they differ so the run is visible in job_run as well.
"""
from .. import db


def run(conn, as_of=None) -> dict:
    res = db.rpc(conn, "rpc_rebuild_check()")
    if res.get("differences"):
        conn.commit()                       # keep the alert the function raised
        raise RuntimeError(f"ledger and stock_balance differ in {res['differences']} rows")
    return res
