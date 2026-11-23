"""nightly_checks: control checks that feed the digest and alerts (§12.4, §12.5)."""
from .. import db


def run(conn, as_of=None) -> dict:
    res = db.rpc(conn, "rpc_nightly_checks()")
    return res if isinstance(res, dict) else {"result": res}
