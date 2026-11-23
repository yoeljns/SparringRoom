# Database API (what the web app and worker call)

All writes go through functions. Tables and views are read-only for the app (`select` under row-level security).
Source of truth: `supabase/migrations/*.sql`.

## Error conventions

- `post_txn` and `rpc_floor` **return** a refusal as `{"error": "CODE", "message": "CODE: detail"}` (HTTP 200) so the
  refusal can be logged and alerted. Success has no `error` key. A replayed `client_uuid` returns the first result with
  `"duplicate": true`.
- Every other `rpc_*` **raises**: PostgREST returns HTTP 400 with `message = "CODE: detail"`.
- Codes: `NOT_PERMITTED`, `INVALID`, `INVALID_STATE`, `NOT_FOUND`, `REASON_REQUIRED`, `APPROVAL_REQUIRED`, `UNBALANCED`,
  `NEGATIVE_BALANCE`, `LANE_MIXED`, `LOT_REQUIRED`, `LOT_EXPIRY_MISMATCH`, `MRSL_BLOCKED`, `NOT_AVAILABLE`,
  `INVALID_LOCATION`, `UNKNOWN_ITEM`, `UNKNOWN_PALLET`, `UNKNOWN_LOCATION`, `UOM_UNKNOWN`, `WEIGHT_REQUIRED`,
  `DUPLICATE_PALLET`, `WRONG_ITEM`, `WRONG_LOCATION`, `WRONG_TRUCK`, `LOT_REFUSED`, `PALLET_REQUIRED`, `ALREADY_PICKED`,
  `PALLET_UNSCANNED`, `EIRSALIYE_REQUIRED`, `WEIGHT_OUT_OF_WINDOW`, `NOTHING_TO_DO`, `RECOUNT_DIFFERENT_USER`,
  `ALREADY_REVERSED`, `SIMULATION_STALE`, `INVALID_PARAMS`, `NOT_SELLABLE`, `INVALID_ATTRIBUTES`, `INVALID_SKU`.

## Floor: `rpc_floor(p_cmd text, p_args jsonb) -> jsonb`

Every command needs `client_uuid` in `p_args`. Optional on all: `event_at`, `reason_code`, `device_id`, `scan_method`
(`scan` | `manual`). Locations may be given as code (`TZ-B01-L03`) or id.

| cmd | args | result (besides txn_id, moves, balances_after) |
| --- | --- | --- |
| `receive` | `doc_type` (`po_line` \| `production_order` \| `customer_return` \| `consign_return` \| `none`), `doc_id`, `item_id` \| `gtin` \| `sku` (not needed with a document), `lot_no`, `prod_date`, `expiry_date`, `supplier_lot`, `qty` (default 1), `uom` (default `pallet`), `to_location` (dock), `actual_pallet_kg` (first pallet of a lot), `this_pallet_kg`, `pallet_serial` (from GS1 (00); generated if absent), `party_id` (returns), `approval_id` | `pallet_id`, `pallet_serial`, `lot_id`, `first_pallet_of_lot`, `label` {serial, sku, name, gtin, lot_no, prod_date, expiry_date, qty_base, kg}, `putaway` {location, rule} |
| `opening_balance` | as receive plus `status` (`available` \| `quarantine`), `to_location` any real location | same |
| `qc` | `lot_id`, `decision` (`release` \| `reject`), `reason_code` (reject), `from_status` (default `quarantine`; `blocked_expiry` for a retest release) | `qc_status` |
| `putaway` | `pallet_serial`, `to_location`, `from_location?`, `task_id?` | `to_location`, `label` |
| `transfer` | `pallet_serial` or (`item_id`, `lot_id`, `qty`, `uom`, `from_location`), `to_location`, `task_id?` | `carton_labels` (true when moved to a pick face) |
| `pick` | `task_id` or `reservation_id`, `lane?`, `pallet_serial` (omit for carton picks from a pick face, then `qty`, `uom`), `to_location` (staging) | `picked_qty`, `remaining`, `reservation_swapped`, `pallet_id`, `label` (new shipping pallet for partial / carton picks) |
| `load` | `shipment_id`, `pallet_serial`, `unload?` | truck status (see `rpc_truck_status`) |
| `close_truck` | `shipment_id`, `e_irsaliye_no?`, `seal_no?`, `vehicle_ref?` | `state: dispatched`, `loaded_kg`, `in_window`, `weight_override` |
| `count` | `count_task_id`, `qty`, `uom?`, `reason_code` (needed when a recount confirms a variance), `item_id?`, `lot_id?` | `state` (`closed` \| `recount` \| `pending_approval`) |
| `consignment_consume` | `party_id`, `item_id`, `lot_id?`, `qty`, `uom?` | |
| `kit_assemble` | `bundle_id`, `qty`, `kit_lot_no?`, `to_location`, `components?` [{item_id, lot_id, from_location, qty}] | `kit_lot_id`, `kit_lot_no`, `kit_expiry` |
| `dealer_observation` | `party_id`, `item_id`, `qty`, `source` (`count` \| `rep_visual` \| `self_report`) | `observation_id` |

Other floor calls:
- `rpc_log_scans(p_events jsonb)`: `[{at, screen, kind, method, accepted, raw, parsed_class, reason_code, device_id}]`
- `rpc_scan_lookup(p_code text, p_gtin text, p_lot_no text)` -> `{kind: pallet|location|item|unknown, ...}`
- `rpc_putaway_suggestion(p_pallet_serial text)` -> `{location, location_id, rule}`
- `rpc_truck_status(p_shipment uuid)` -> `{loaded_kg, pallets_loaded, pallets_total, min_kg, max_kg, to_min_kg, to_max_kg, in_window, e_irsaliye_no, unpicked_qty, pallets:[{serial, sku, lot_no, kg, kg_source, loaded}]}`
- `post_txn(txn jsonb)`: raw ledger entry (spec §4.5) for ad hoc cases; the floor app normally uses `rpc_floor`.

Floor views: `v_task` (open tasks: type, priority, location_code, to_location_code, sku, item_name, lot_no, expiry_date,
pallet_serial, shipment_no, party_name, qty_base, pallets, payload), `v_count_task_blind`, `v_qc_queue`, `v_shipment`,
`v_stock`, `v_lane_utilisation`, `v_consolidation`. Open documents for receiving: `po_line` + `purchase_order`,
`production_order`.

## Orders and shipping

- `rpc_save_order(p jsonb)` -> `{order_id}`. `p`: `id?`, `party_id`, `requested_date`, `market_id?`, `priority_tier?`,
  `campaign_id?`, `order_type?` (`standard` | `export_contract` | `consignment`), `forward_buy?`,
  `schedule?` {trucks_per_month, months, start}, `vehicle_type_id?`, `note?`,
  `lines`: [{`ref?`, `parent_ref?`, `item_id`, `qty`, `uom?`, `line_type?` (`paid` | `free` | `bundle_component`),
  `bundle_id?`, `mechanic_code?`, `terms?`}]. Free and bundle lines come from the mechanic `explode` functions.
- `rpc_campaigns_for_order(p_party uuid, p_date date)` -> live campaigns in scope with mechanics, params and bundle lines.
- `rpc_confirm_order(p_order uuid)` -> promised dates, tier, shipment (or queues a `plan_trucks` job when a schedule is set).
- `rpc_cancel_order(p_order uuid, p_reason text)`.
- `rpc_atp(p_item uuid, p_party uuid)` -> 26 weekly rows `{week_start, eligible_on_hand, receipts_cum, hard, soft_cum, atp}`.
- `rpc_allocate(p_shipment uuid default null)` -> `{hard_reservations, backorders, horizon}`.
- `rpc_apply_truck_plan(p_order uuid, p_plan jsonb)` (worker).
- Views: `v_shipment`, `v_backorder`, `v_available`, `v_lot_free`, `v_expected_receipt`, `v_fill_rate`.

## Planning

- `rpc_enqueue_job(p_kind text, p_payload jsonb)`: `plan_trucks` {order_id}, `simulate_campaign` {campaign_id},
  `simulate_scenario` {...}, `run_job` {jobs:[...]}. Poll `job_queue` (state, result, error).
- `rpc_suggestion_decide(p_id uuid, p_action text, p_qty numeric, p_reason text)`: `accept` | `edit` | `reject`.
- `rpc_forecast_override(p jsonb)`: {item_id, period, delta, reason, bucket?, level?, node?} or {withdraw_id, reason}.
- `rpc_param_propose(p_rows jsonb, p_note text)`: rows [{scope_type, scope_id, param, value, valid_from?}].
- `rpc_plan_publish(p_plan uuid)` (owner sign-off), `rpc_po_set_state`, `rpc_production_set_state`.
- `resolve_param(p_name text, p_ctx jsonb)` -> `{value, level, source_id}`.
- Tables/views: `v_item_class`, `forecast`, `forecast_run`, `forecast_accuracy`, `forecast_override`, `lead_time_stat`,
  `item_policy`, `stock_projection`, `v_suggestion`, `plan_version`, `planning_param`, `slow_stock`, `ddmrp_buffer`, `job_run`.

## Campaigns

- `rpc_campaign_save(p jsonb)`: {id?, code, name, type?, order_from, order_to, deliver_from?, deliver_to?, budget_eur?,
  lot_preference?, note?, scopes:[{item_rule, party_rule, market_ids?}], mechanics:[{mechanic_type, params}],
  dealer_overrides?:[{party_id, mechanic_type, params}]}.
- `rpc_campaign_simulate(p_campaign uuid)` -> job id; `rpc_campaign_request_approval(p_campaign uuid, p_note text)`.
- Tables/views: `v_campaign`, `campaign_scope`, `campaign_mechanic`, `mechanic_type` (param_schema), `campaign_forecast`,
  `campaign_simulation`, `campaign_review`, `uplift_library`, `bundle`, `bundle_line`, `standard_terms`.

## Control, dealers, exchange

- `rpc_request_approval(p_type text, p_payload jsonb, p_reason text)`: `scrap` {lines:[{item_id, lot_id?, pallet_serial?,
  location, qty, uom?, status?}]}, `weight_override` {shipment_id}, `mrsl_override` {shipment_id, mrsl_days}, `backdate`,
  `over_receipt`.
- `rpc_decide_approval(p_id uuid, p_approve boolean, p_note text)`.
- `rpc_create_count_task(p_location text, p_trigger text, p_assigned uuid)`, `rpc_generate_count_tasks()`.
- `rpc_vmi_decide(p_id uuid, p_approve boolean)`.
- `rpc_import_batch(p_file_name, p_file_hash, p_file_type, p_schema_version, p_header text[], p_rows jsonb)` ->
  `{state: applied|skipped|rejected|held, batch_id, errors?}`.
- `rpc_export_build(p_type text)` -> `{state: built|empty, batch_id, file_name, header, rows}`; `rpc_export_get(p_batch)`;
  `rpc_export_ack(p_batch)`.
- `rpc_run_reconciliation(p_as_of date)`, `rpc_recon_signoff(p_run uuid)`; view `v_recon_open`.
- `rpc_digest()`, `rpc_dashboard()`, `rpc_alert_ack(p_id uuid)`, `rpc_rebuild_check()`.
- `rpc_upsert(p_table text, p_row jsonb)` / `rpc_delete(p_table text, p_id uuid)`: master data (allowed tables and roles
  in `table_permission`). `rpc_set_user(p_user, p_full_name, p_role, p_active, p_email)`: owner assigns roles; the
  very first user registers themself as owner.
- Views/tables: `alert`, `approval_request`, `audit_log`, `v_count_task`, `v_ira_daily`, `v_scan_compliance`,
  `v_scan_compliance_daily`, `v_stock_moves` (ledger rows behind any stock number), `dealer_stock_estimate`,
  `dealer_stock_observation`, `vmi_proposal`, `import_batch`, `import_row_error`, `export_batch`, `v_ageing_value`.
