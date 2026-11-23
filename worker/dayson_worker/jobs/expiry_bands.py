"""expiry_bands: expiry bands and expiry_block postings are done in SQL (§6.2); the nightly job calls the function."""
from .. import db


def run(conn, as_of=None) -> dict:
    res = db.rpc(conn, "rpc_update_expiry_bands()")
    return res if isinstance(res, dict) else {"result": res}
