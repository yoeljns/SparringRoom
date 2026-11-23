"""count_tasks: generate the cycle-count tasks of the day (§5.5)."""
from .. import db


def run(conn, as_of=None) -> dict:
    res = db.rpc(conn, "rpc_generate_count_tasks()")
    return res if isinstance(res, dict) else {"result": res}
