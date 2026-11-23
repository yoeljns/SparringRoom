# Dayson planning worker

Python 3.12 worker for the Dayson Inventory System (spec §7.5, §8, §9, §10): classification,
forecasts, lead-time statistics, policies, replenishment suggestions, truck loads, campaign
effects and reviews, dealer stock estimates. It talks to Postgres directly (psycopg 3); a direct
connection is the `system` role of the migrations, so it bypasses RLS and may call every `rpc_*`.

## Run

```
uv sync                                     # Python 3.12 + dependencies
uv run pytest                               # unit tests (no database) — db tests are skipped
uv run dayson-worker nightly                # all nightly jobs, in order; exit code 1 if any job is not ok
uv run dayson-worker nightly --only classify,forecast --date 2026-12-01
uv run dayson-worker serve                  # poll job_queue forever (plan_trucks, simulate_campaign, simulate_scenario, run_job)
uv run dayson-worker serve --once           # process everything queued, then exit
uv run python -m dayson_worker.cli nightly  # same entrypoint without the console script
uv run python scripts/emit_mechanic_schemas.py   # regenerate mechanics/schemas.json (use --check in CI)
```

Docker: `ENTRYPOINT ["uv", "run", "--no-sync", "dayson-worker"]`, `CMD ["nightly"]`; run the same image
with the argument `serve` for the on-demand worker.

### Environment

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (required). Never baked into the image. |
| `WORKER_N_JOBS` | statsforecast process count (default `-1` = all cores; only used above 200 series). |
| `WORKER_PLAN_TIME_LIMIT_S` | CP-SAT time limit per load-planner stage (default `10`). |
| `WORKER_TEST_RESET` | `1` = the db test session resets its local database itself (see below). |

### Database tests

```
(cd .. && DB_NAME=dayson_worker bash scripts/dev-db.sh reset)        # shim + migrations + seed
DATABASE_URL=postgresql://postgres@127.0.0.1:54329/dayson_worker uv run pytest          # everything
DATABASE_URL=postgresql://postgres@127.0.0.1:54329/dayson_worker uv run pytest -m db    # only the db tests
```

`tests/test_integration_db.py` (marker `db`, skipped without `DATABASE_URL`) needs a freshly reset and
seeded database; with `WORKER_TEST_RESET=1` it runs `scripts/dev-db.sh reset` for that database first.

## Nightly jobs (in this order)

Every job runs in its own transaction and writes a `job_run` row. A failure is rolled back, recorded,
reported with `rpc_job_failed` (real-time alert) and the jobs that depend on it are skipped; the rest run.
At start-up `nightly` and `serve` upsert `mechanic_type` from the module registry, so the database
validates campaign parameters with the worker's schemas.

| Job | What it writes |
|---|---|
| `build_demand_history` | `demand_history` from dispatched shipments (free → `qty_free`, bundle components → `bundle:<id>`) and from Logo invoices without a matching shipment. Replaces only `order` / `bundle:*` rows and the `logo` weeks present in `logo_sales_doc`. |
| `measure_lead_times` | `lead_time_stat` per lane and day (QC release − order date; quoted below `lt_min_receipts`); alert on a change above `lt_alert_change_pct`. |
| `classify` | `classification_run` (current) + `item_class`; monthly, `force` to repeat. Value = trailing 52 weeks at item cost. |
| `forecast` | `forecast_run` (current) + `forecast`: 26 weekly rows per SKU, group, family and total (MinT), 18 monthly per family; `campaign_delta` from approved/live campaigns, `override_delta` from active SKU overrides; `forecast_accuracy` at lag = lead time. |
| `compute_policy` | `item_policy` for the published plan (upsert): policy, z, safety stock, ROP / order-up-to, order quantity, all inputs. |
| `suggest` | `replenishment_suggestion` (state `proposed`, older proposed rows `superseded`) with every input, one group per supplier and release date; `stock_projection`. |
| `expiry_bands` | `select rpc_update_expiry_bands()` |
| `slow_stock` | monthly `slow_stock` list: slow, obsolete, at risk (one row per amber lot). |
| `campaign_tick` | `select rpc_campaign_tick()` |
| `dealer_estimate` | `dealer_stock_estimate` (upsert), `count_request` tasks for A dealers with low confidence, channel-loading alerts after a campaign. |
| `campaign_review` | `campaign_review` rows, `uplift_library` shrinkage, campaign → `reviewed`; `export_row` `campaign_settlement` lines once the ring-fence is released. |
| `uplift_model` | per-family uplift model (coefficients in `job_run.stats`); fitted once a family has campaign history. |
| `ddmrp_shadow` | `ddmrp_buffer` for the families in `planning_param ddmrp_families` (shadow only). |
| `vmi_proposals` | `vmi_param` min/max from sell-through; `vmi_proposal` from new rep counts. |
| `load_planner` | plans confirmed scheduled orders that have no shipment yet (safety net for `plan_trucks`). |
| `count_tasks` | `select rpc_generate_count_tasks()` |
| `reconciliation` | `select rpc_run_reconciliation()` when an unreconciled `logo_stock_snapshot` exists. |
| `rebuild_check` | `select rpc_rebuild_check()`; fails when ledger and balances differ. |
| `nightly_checks` | `select rpc_nightly_checks()` |

## On-demand jobs (`job_queue`, claimed with `FOR UPDATE SKIP LOCKED`)

| Kind | Payload | Effect |
|---|---|---|
| `plan_trucks` | `{"order_id"}` | Splits the order into trucks (weight window and item limit of the vehicle type, `sales_order.schedule` = `{"trucks_per_month": n or [n1, n2], "months": n, "start": date, "mix_tolerance"?}`, approved `load_pattern`s preferred) and calls `rpc_apply_truck_plan`. |
| `simulate_campaign` | `{"campaign_id"}` | `campaign_forecast` from the mechanics' `demand_effect` and `uplift_library`, a scenario `plan_version` with its `stock_projection`, then `rpc_campaign_simulation_done` (campaign → `simulated`). |
| `simulate_scenario` | `{"lead_time_change": {"supplier_lane_id", "days" or "delta_days", "sd_days"?}}` or `{"demand_change": {"family" or "item_ids", "pct", "weeks"?}}` | Scenario `plan_version` (+ `stock_projection`, and `item_policy` for a lead-time change); result in `job_queue.result`. |
| `run_job` | `{"job": name}` or `{"jobs": [names]}`, optional `force`, `date` | Runs nightly jobs on demand (queued by a campaign approval). |

The result (or the error) is stored on the `job_queue` row; a failed job also raises the job-failure alert.

## Layout

| Path | What |
|---|---|
| `dayson_worker/core/` | Pure logic (plain Python / pandas in, plain data out). The unit tests target this. |
| `dayson_worker/jobs/` | One module per job: `run(conn, as_of=None)` = read → core → write. |
| `dayson_worker/db.py` | The only place that talks to Postgres: queries, `resolve_param`, alerts, job bookkeeping. |
| `dayson_worker/cli.py` | `nightly` and `serve`. |
| `mechanics/` | One module per campaign mechanic (§9.2) + registry + `schemas.json`. |
| `../supabase/migrations/0012_worker.sql` | Parameters and starting uplift priors the worker reads. |

## Notes

- Parameters are read through `resolve_param(name, ctx)`; the level that supplied a value is stored in the
  `inputs` of policies and suggestions. Dates follow `app.today()` (Europe/Istanbul); weeks are Mondays.
- Policy choice: export contract → to order; `item_family.default_policy` where set (intermittent and lumpy
  items of a stocked family use the empirical quantile); a family without one gets weekly periodic review.
- Order quantity = max(forecast demand of one review cycle, MOQ) → whole pallets / order multiple → raised to
  a full truck when the added holding cost (`holding_cost_pct_year`) is below the freight of the empty part
  of the truck (`freight_eur_per_truck`) → expiry cap.
- Mechanic schemas use only the keywords `app.validate_json` checks (no `oneOf` / type unions); rules such as
  "exactly one threshold" are enforced in the module's `validate()`.
- Forecast baselines use `statsforecast`; reconciliation uses `hierarchicalforecast` MinTrace (`wls_struct`),
  then bottom-level negatives are clipped and aggregates re-summed so every level adds up. Series without
  history and contract schedules are not changed by reconciliation.
- The service factor is the normal inverse rounded to two decimals (97.5% → 1.96, as in the spec example).
- The load planner is a CP-SAT model with a lexicographic objective; each stage has a time limit and reports
  `OPTIMAL` or `FEASIBLE` in the job result.
