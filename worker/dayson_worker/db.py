"""All database access for the worker (psycopg 3, DATABASE_URL).

Jobs do: read (query / query_df) -> pure core -> write (insert_rows / rpc).
A direct connection is the "system" role of migration 0001: it bypasses RLS and
may call every rpc_* function. Table and column names are those of
supabase/migrations 0001-0012.
"""
from __future__ import annotations

import json
import math
import os
import uuid
from datetime import date, datetime
from decimal import Decimal

import pandas as pd


def connect(url: str | None = None):
    import psycopg
    from psycopg.rows import dict_row
    url = url or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg.connect(url, row_factory=dict_row, autocommit=False,
                           options="-c client_min_messages=warning")


def _plain(v):
    """Database value -> plain Python (Decimal -> float, UUID -> str)."""
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def query(conn, sql: str, params=None) -> list[dict]:
    """Rows as dicts; numerics are floats and uuids are strings."""
    with conn.cursor() as cur:
        cur.execute(sql, _params(params))
        if not cur.description:
            return []
        return [{k: _plain(v) for k, v in r.items()} for r in cur.fetchall()]


def one(conn, sql: str, params=None) -> dict | None:
    r = query(conn, sql, params)
    return r[0] if r else None


def scalar(conn, sql: str, params=None):
    r = one(conn, sql, params)
    return next(iter(r.values())) if r else None


def query_df(conn, sql: str, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, _params(params))
        cols = [d.name for d in cur.description]
        rows = [[_plain(v) for v in r.values()] for r in cur.fetchall()]
    return pd.DataFrame(rows, columns=cols)


def _params(params):
    if params is None:
        return None
    if isinstance(params, dict):
        return {k: _adapt(v) for k, v in params.items()}
    return [_adapt(p) for p in params]


def jsonable(o):
    """Recursively convert numpy / pandas / date values into JSON-safe Python."""
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [jsonable(v) for v in o]
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.date().isoformat() if (o.hour, o.minute, o.second) == (0, 0, 0) else o.isoformat()
    if isinstance(o, date):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, uuid.UUID):
        return str(o)
    if hasattr(o, "item") and not isinstance(o, (str, bytes)):
        o = o.item()
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    return o


def _adapt(v):
    from psycopg.types.json import Jsonb
    if isinstance(v, (dict,)):
        return Jsonb(jsonable(v))
    if isinstance(v, list) and (not v or isinstance(v[0], (dict, list))):
        return Jsonb(jsonable(v))
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):      # numpy scalar
        v = v.item()
    if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):   # NaN / inf -> NULL
        return None
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime()
    if v is pd.NaT:
        return None
    return v


def as_json(v):
    """Force a value (also a list of scalars) to be sent as jsonb."""
    from psycopg.types.json import Jsonb
    return Jsonb(jsonable(v))


def insert_rows(conn, table: str, rows: list[dict], returning: str | None = None) -> list:
    """Insert dict rows (all with the same keys). dict values are sent as jsonb."""
    if not rows:
        return []
    cols = list(rows[0])
    sql = f"insert into {table} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})"
    out = []
    with conn.cursor() as cur:
        if returning:
            for r in rows:
                cur.execute(sql + f" returning {returning}", [_adapt(r[c]) for c in cols])
                out.append(_plain(cur.fetchone()[returning]))
        else:
            cur.executemany(sql, [[_adapt(r[c]) for c in cols] for r in rows])
    return out


def insert_one(conn, table: str, row: dict, returning: str = "id"):
    return insert_rows(conn, table, [row], returning)[0]


def execute(conn, sql: str, params=None) -> int:
    with conn.cursor() as cur:
        cur.execute(sql, _params(params))
        return cur.rowcount


# ------------------------------------------------------------ database helpers
def today(conn) -> date:
    """Business date (Europe/Istanbul), the same one the SQL functions use."""
    return scalar(conn, "select app.today()")


def rpc(conn, call: str, params=None):
    """select <call> and return its single value, e.g. rpc(conn, 'rpc_campaign_tick()')."""
    return scalar(conn, f"select {call} as r", params)


def raise_alert(conn, rule: str, severity: str, payload: dict, entity_type: str | None = None,
                entity_id=None, dedupe_key: str | None = None, realtime: bool = False):
    return scalar(conn, "select app.raise_alert(%s, %s, %s, %s, %s, %s, %s)",
                  [rule, severity, realtime, as_json(payload), entity_type, entity_id, dedupe_key])


def resolve_param(conn, name: str, context: dict | None = None) -> dict:
    """The one lookup function of §3.8: {"value", "level", "source_id"} (value None when unset)."""
    r = scalar(conn, "select resolve_param(%s, %s)", [name, as_json(context or {})])
    return r or {"value": None, "level": None, "source_id": None}


def param(conn, name: str, context: dict | None = None, default=None):
    v = resolve_param(conn, name, context)["value"]
    return default if v is None else v


def param_num(conn, name: str, context: dict | None = None, default: float | None = None) -> float | None:
    v = param(conn, name, context, default)
    return None if v is None else float(v)


def item_params(conn, name: str, extra_ctx_sql: str = "") -> dict:
    """resolve_param for every item in one round trip: {item_id: {"value","level","source_id"}}."""
    rows = query(conn, f"""
        select i.id, resolve_param(%s, jsonb_build_object('item_id', i.id){extra_ctx_sql}) as r
          from item i where i.active""", [name])
    return {r["id"]: r["r"] for r in rows}


def param_version(conn) -> int:
    return int(scalar(conn, "select app.param_version()") or 0)


def current_plan(conn) -> dict:
    r = one(conn, "select id, name, param_version from plan_version where id = app.current_plan_version()")
    if not r:
        raise RuntimeError("no published plan_version; publish a plan before running the planning jobs")
    return r


def current_run(conn, table: str) -> dict | None:
    return one(conn, f"select * from {table} where is_current order by run_at desc limit 1")


def upsert_mechanic_types(conn) -> int:
    """Keep mechanic_type in step with the module registry so the database validates
    campaign parameters with the same schemas (§9.2)."""
    import mechanics
    n = 0
    for r in mechanics.mechanic_type_rows():
        n += execute(conn, """
            insert into mechanic_type (code, param_schema, module, version, active)
            values (%s, %s, %s, %s, true)
            on conflict (code) do update
               set param_schema = excluded.param_schema, module = excluded.module, version = excluded.version
             where mechanic_type.param_schema is distinct from excluded.param_schema
                or mechanic_type.module is distinct from excluded.module
                or mechanic_type.version is distinct from excluded.version""",
                     [r["code"], as_json(r["param_schema"]), r["module"], r["version"]])
    return n


# ------------------------------------------------------------- job bookkeeping
def start_job_run(conn, job: str):
    return insert_one(conn, "job_run", {"job": job, "status": "running"})


def finish_job_run(conn, run_id, status: str, stats: dict | None = None, error: str | None = None) -> None:
    execute(conn, "update job_run set finished_at = now(), status = %s, stats = %s, error = %s where id = %s",
            [status, as_json(stats or {}), error, run_id])


def job_failed(conn, job: str, error: str) -> None:
    """Real-time alert for a failed job (§12.5)."""
    execute(conn, "select rpc_job_failed(%s, %s)", [job, error])


def claim_job(conn, kinds: list[str]) -> dict | None:
    """Take the oldest queued on-demand job (SKIP LOCKED so several workers can poll)."""
    r = query(conn, """
        update job_queue set state = 'running', started_at = now()
         where id = (select id from job_queue where state = 'queued' and kind = any(%s)
                      order by created_at, id for update skip locked limit 1)
        returning id, kind, payload""", [kinds])
    conn.commit()
    return r[0] if r else None


def finish_job(conn, job_id, result: dict | None = None, error: str | None = None) -> None:
    execute(conn, "update job_queue set state = %s, result = %s, error = %s, finished_at = now() where id = %s",
            ["failed" if error else "done", as_json(result or {}), error, job_id])
    conn.commit()


def dumps(o) -> str:
    return json.dumps(jsonable(o), ensure_ascii=False)
