# Dayson planning worker

Python 3.12 worker for the Dayson Inventory System (spec §8–§10, §7.5): classification,
forecasts, lead-time stats, policies, suggestions, truck loads, campaign effects.

```
uv sync                                    # Python 3.12 + dependencies
uv run pytest                              # planning + campaign tests (§13.2), no database needed
uv run dayson-worker nightly               # needs DATABASE_URL
uv run dayson-worker nightly --only classify,forecast --date 2026-12-01
uv run dayson-worker serve                 # polls job_queue: plan_trucks, simulate_campaign, simulate_scenario, run_job
uv run python scripts/emit_mechanic_schemas.py   # regenerate mechanics/schemas.json (use --check in CI)
```

## Layout

| Path | What |
|---|---|
| `dayson_worker/core/` | Pure logic (plain Python / pandas in, plain data out). All tests target this. |
| `dayson_worker/jobs/` | One module per job: `run(conn)` = read → core → write. Queries carry `# SCHEMA:` tags. |
| `dayson_worker/db.py` | The only place that talks to Postgres (psycopg 3). |
| `dayson_worker/cli.py` | `nightly` (jobs in §8.1 order, failures isolated and alerted) and `serve`. |
| `mechanics/` | One module per campaign mechanic (§9.2) + registry + `schemas.json` for TypeScript and the DB seed. |

## Notes

- Forecast baselines use `statsforecast`; reconciliation uses `hierarchicalforecast` MinTrace (`wls_struct`),
  then bottom-level negatives are clipped and aggregates re-summed so every level adds up.
- The service factor is the normal inverse rounded to two decimals (97.5% → 1.96, as in the spec example).
- The load planner is a CP-SAT model with a lexicographic objective; each stage has a time limit
  (`time_limit_s`, default 10 s) and reports `OPTIMAL` or `FEASIBLE` in `status`.
- Weeks are identified by their Monday. Quantities are base units; weights are kg.
- `WORKER_N_JOBS` sets the statsforecast process count (default: all cores).
