"""campaign_tick: open and close campaign order windows, release ring-fences (§9.1)."""
from .. import db


def run(conn, as_of=None) -> dict:
    res = db.rpc(conn, "rpc_campaign_tick()")
    return res if isinstance(res, dict) else {"result": res}
