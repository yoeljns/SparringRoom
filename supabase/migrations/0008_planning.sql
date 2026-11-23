-- 0008 Planning (spec §3.5, §8). The Python worker writes every result as a new versioned
-- run; nothing is overwritten. Planners decide on suggestions through rpc_* functions.

-- On-demand requests for the worker (truck plans, simulations, ad hoc job runs).
create table public.job_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('plan_trucks','simulate_campaign','simulate_scenario','run_job')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check (state in ('queued','running','done','failed')),
  result jsonb,
  error text,
  requested_by uuid,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index job_queue_state_idx on public.job_queue (state, created_at);

-- One row per job execution (nightly or on demand).
create table public.job_run (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','failed')),
  stats jsonb,
  error text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index job_run_idx on public.job_run (job, started_at desc);

-- Weekly demand per item, party and market; paid and free kept apart (§8.1, §9.3).
create table public.demand_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item (id),
  party_id uuid references public.party (id),
  market_id uuid references public.market (id),
  week date not null,
  qty_paid numeric(14,3) not null default 0,
  qty_free numeric(14,3) not null default 0,
  source text not null default 'order',          -- order | logo | bundle:<id>
  campaign_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index demand_history_item_idx on public.demand_history (item_id, week);
create index demand_history_party_idx on public.demand_history (party_id, item_id, week);

create table public.classification_run (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  params jsonb,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index classification_run_current on public.classification_run (is_current) where is_current;

create table public.item_class (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.classification_run (id) on delete cascade,
  item_id uuid not null references public.item (id),
  abc text not null check (abc in ('A','B','C')),
  xyz text not null check (xyz in ('X','Y','Z')),
  pattern text check (pattern in ('smooth','erratic','intermittent','lumpy','none')),
  adi numeric(10,4),
  cv2 numeric(10,4),
  cv_monthly numeric(10,4),
  criticality boolean not null default false,
  service_class text,                            -- class after the criticality step, e.g. 'AX'
  service_level numeric(6,4),
  consumption_value_eur numeric(16,2),
  lifecycle_flag text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (run_id, item_id)
);
create index item_class_item_idx on public.item_class (item_id);

create table public.plan_version (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_version_id uuid references public.plan_version (id),
  kind text not null default 'plan' check (kind in ('plan','scenario')),
  state text not null default 'draft' check (state in ('draft','published','archived')),
  param_version int,
  context jsonb,                                 -- what a scenario changed (campaign, lead time, ...)
  published_at timestamptz,
  signed_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create unique index plan_version_one_published on public.plan_version (state) where state = 'published' and kind = 'plan';
select app.track('public.plan_version');

create or replace function app.current_plan_version() returns uuid
language sql stable as $$
  select id from public.plan_version where state = 'published' and kind = 'plan' limit 1
$$;

create table public.forecast_run (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  is_current boolean not null default false,
  plan_version_id uuid references public.plan_version (id) on delete cascade,
  classification_run_id uuid references public.classification_run (id),
  param_version int,
  metrics jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index forecast_run_current on public.forecast_run (is_current) where is_current;

-- 26 weekly buckets per SKU, 18 monthly per family. final = base + campaign_delta + override_delta.
create table public.forecast (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.forecast_run (id) on delete cascade,
  level text not null check (level in ('sku','group','family','total','market')),
  item_id uuid references public.item (id),
  node text not null,                            -- sku / family:group / family code / TOTAL / market code
  bucket text not null check (bucket in ('week','month')),
  period date not null,
  base numeric(14,3) not null default 0,
  campaign_delta numeric(14,3) not null default 0,
  override_delta numeric(14,3) not null default 0,
  final numeric(14,3) not null default 0,
  method text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index forecast_run_item_idx on public.forecast (run_id, item_id, period);
create index forecast_node_idx on public.forecast (run_id, level, node, period);

-- Accuracy at lag = lead time: WAPE and bias per family, MASE for intermittent items,
-- and forecast value added (naive vs statistical vs final).
create table public.forecast_accuracy (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.forecast_run (id) on delete cascade,
  family_id uuid references public.item_family (id),
  item_id uuid references public.item (id),
  lag_weeks int,
  n int,
  wape numeric(10,4),
  bias numeric(10,4),
  mase numeric(10,4),
  wape_naive numeric(10,4),
  wape_stat numeric(10,4),
  wape_final numeric(10,4),
  fva_stat numeric(10,4),                        -- naive error - statistical error
  fva_final numeric(10,4),                       -- statistical error - final error
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index forecast_accuracy_run_idx on public.forecast_accuracy (run_id);

create table public.forecast_override (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.item (id),
  level text not null default 'sku',
  node text not null,
  bucket text not null default 'week',
  period date not null,
  delta numeric(14,3) not null,
  reason text not null,
  user_id uuid,
  source text not null default 'planner',        -- planner | sales | campaign:<id>
  state text not null default 'active' check (state in ('active','withdrawn')),
  fva numeric(10,4),                             -- scored by forecast value added
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index forecast_override_idx on public.forecast_override (node, period) where state = 'active';
select app.track('public.forecast_override');

-- Policy per item and plan version: safety stock, reorder point or order-up-to level (§8.5).
create table public.item_policy (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references public.plan_version (id) on delete cascade,
  item_id uuid not null references public.item (id),
  policy text not null check (policy in ('continuous','periodic','empirical','to_order')),
  service_level numeric(6,4),
  z numeric(8,4),
  d_mean numeric(14,3),
  sd_d numeric(14,3),
  lt_mean_days numeric(8,2),
  lt_sd_days numeric(8,2),
  review_days int,
  safety_stock numeric(14,3),
  rop numeric(14,3),
  order_up_to numeric(14,3),
  order_qty numeric(14,3),
  inputs jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (plan_version_id, item_id)
);

-- Weekly projection of available stock against safety stock (digest, dashboard, sandbox).
create table public.stock_projection (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references public.plan_version (id) on delete cascade,
  item_id uuid not null references public.item (id),
  week date not null,
  projected_qty numeric(14,3) not null,
  safety_stock numeric(14,3),
  below_safety boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index stock_projection_idx on public.stock_projection (plan_version_id, item_id, week);

-- inputs jsonb stores every number used, for explainability (§8.6).
create table public.replenishment_suggestion (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid references public.plan_version (id) on delete cascade,
  item_id uuid not null references public.item (id),
  type text not null check (type in ('purchase','production')),
  reason text not null default 'rop',            -- rop | review | campaign_prebuild | vmi
  qty numeric(14,3) not null check (qty > 0),
  need_date date,
  release_date date,
  supplier_id uuid references public.party (id),
  supplier_lane_id uuid references public.supplier_lane (id),
  group_key text,                                -- one order per supplier per review
  inputs jsonb not null default '{}'::jsonb,
  state text not null default 'proposed' check (state in ('proposed','accepted','edited','rejected','superseded')),
  final_qty numeric(14,3),
  edit_reason text,
  decided_by uuid,
  decided_at timestamptz,
  result_doc_type text,
  result_doc_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index replenishment_suggestion_state_idx on public.replenishment_suggestion (state, plan_version_id);
select app.track('public.replenishment_suggestion');

-- Monthly slow and expiring stock list (§8.8).
create table public.slow_stock (
  id uuid primary key default gen_random_uuid(),
  run_date date not null default current_date,
  item_id uuid not null references public.item (id),
  lot_id uuid references public.lot (id),
  category text not null check (category in ('slow','obsolete','at_risk')),
  qty_base numeric(14,3),
  cover_weeks numeric(10,2),
  value_eur numeric(16,2),
  proposed_action text check (proposed_action in ('free_goods_bundle','dealer_push','export_clearance','supplier_return','scrap')),
  owner_id uuid references public.app_user (id),
  state text not null default 'open' check (state in ('open','actioned','dismissed')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create trigger trg_touch before update on public.slow_stock for each row execute function app.touch();

-- Phase 5 shadow run of demand-driven buffers on the sealant family (§8.9).
create table public.ddmrp_buffer (
  id uuid primary key default gen_random_uuid(),
  as_of date not null default current_date,
  item_id uuid not null references public.item (id),
  adu numeric(14,3),
  dlt_days numeric(8,2),
  red numeric(14,3),
  yellow numeric(14,3),
  green numeric(14,3),
  on_hand numeric(14,3),
  net_flow numeric(14,3),
  zone text,
  suggested_qty numeric(14,3),
  metrics jsonb,                                 -- fill rate and average stock for the comparison
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (as_of, item_id)
);

-- ---------------------------------------------------------------------------
-- Planner actions
-- ---------------------------------------------------------------------------
create or replace function public.rpc_enqueue_job(p_kind text, p_payload jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid;
begin
  perform app.require_role('planner','ops_manager','owner','finance');
  insert into job_queue (kind, payload, requested_by, created_by)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), app.uid(), app.uid()) returning id into v_id;
  return v_id;
end $$;

-- Accept, edit or reject a suggestion. Acceptance creates a draft purchase or production
-- order; edits are logged with a reason (§8.6).
create or replace function public.rpc_suggestion_decide(
  p_id uuid, p_action text, p_qty numeric default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  s replenishment_suggestion;
  v_qty numeric;
  v_po uuid; v_doc uuid; v_line int;
  v_item item;
begin
  perform app.require_role('planner','ops_manager','owner');
  select * into s from replenishment_suggestion where id = p_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'suggestion'); end if;
  if s.state <> 'proposed' then perform app.fail('INVALID_STATE', 'suggestion already decided'); end if;
  if p_action = 'reject' then
    update replenishment_suggestion set state = 'rejected', edit_reason = p_reason, decided_by = app.uid(), decided_at = now() where id = p_id;
    return jsonb_build_object('id', p_id, 'state', 'rejected');
  end if;
  if p_action not in ('accept','edit') then perform app.fail('INVALID', 'action is accept, edit or reject'); end if;
  v_qty := coalesce(p_qty, s.qty);
  if p_action = 'edit' or v_qty <> s.qty then
    if nullif(p_reason, '') is null then perform app.fail('REASON_REQUIRED', 'an edited suggestion needs a reason'); end if;
  end if;
  select * into v_item from item where id = s.item_id;
  if s.type = 'purchase' then
    if s.supplier_id is null then perform app.fail('INVALID', 'suggestion has no supplier'); end if;
    select id into v_po from purchase_order
     where supplier_id = s.supplier_id and state = 'draft' and note = 'from suggestions'
       and created_at::date = current_date and supplier_lane_id is not distinct from s.supplier_lane_id
     limit 1;
    if v_po is null then
      insert into purchase_order (supplier_id, supplier_lane_id, promised_date, note, created_by)
      values (s.supplier_id, s.supplier_lane_id, s.need_date, 'from suggestions', app.uid()) returning id into v_po;
    end if;
    select coalesce(max(line_no), 0) + 1 into v_line from po_line where po_id = v_po;
    insert into po_line (po_id, line_no, item_id, qty, promised_date, suggestion_id, created_by)
    values (v_po, v_line, s.item_id, v_qty, s.need_date, s.id, app.uid());
    v_doc := v_po;
  else
    insert into production_order (item_id, qty, line, planned_start, planned_finish, suggestion_id, state, created_by)
    values (s.item_id, v_qty, v_item.production_line, s.release_date, s.need_date, s.id, 'draft', app.uid())
    returning id into v_doc;
  end if;
  update replenishment_suggestion
     set state = case when v_qty <> s.qty then 'edited' else 'accepted' end,
         final_qty = v_qty, edit_reason = p_reason, decided_by = app.uid(), decided_at = now(),
         result_doc_type = case when s.type = 'purchase' then 'purchase_order' else 'production_order' end,
         result_doc_id = v_doc
   where id = p_id;
  return jsonb_build_object('id', p_id, 'state', case when v_qty <> s.qty then 'edited' else 'accepted' end,
                            'doc_type', s.type, 'doc_id', v_doc);
end $$;

create or replace function public.rpc_forecast_override(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid;
begin
  perform app.require_role('planner','owner');
  if nullif(p->>'reason', '') is null then perform app.fail('REASON_REQUIRED', 'an override needs a reason'); end if;
  if (p->>'withdraw_id') is not null then
    update forecast_override set state = 'withdrawn' where id = (p->>'withdraw_id')::uuid;
    return (p->>'withdraw_id')::uuid;
  end if;
  insert into forecast_override (item_id, level, node, bucket, period, delta, reason, user_id, source, created_by)
  values ((p->>'item_id')::uuid, coalesce(p->>'level', 'sku'),
          coalesce(p->>'node', (select sku from item where id = (p->>'item_id')::uuid)),
          coalesce(p->>'bucket', 'week'), (p->>'period')::date, (p->>'delta')::numeric, p->>'reason',
          app.uid(), coalesce(p->>'source', 'planner'), app.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Purchase / production order maintenance from the back office.
create or replace function public.rpc_po_set_state(p_po uuid, p_state text, p_confirmed date default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('planner','ops_manager','owner');
  if p_state not in ('ordered','confirmed','cancelled') then perform app.fail('INVALID', 'state'); end if;
  update purchase_order set state = p_state,
         ordered_at = case when p_state = 'ordered' then coalesce(ordered_at, now()) else ordered_at end,
         confirmed_date = coalesce(p_confirmed, confirmed_date)
   where id = p_po and state in ('draft','ordered','confirmed');
  if not found then perform app.fail('INVALID_STATE', 'purchase order cannot change state'); end if;
  if p_state = 'cancelled' then update po_line set state = 'cancelled' where po_id = p_po and state = 'open'; end if;
  return jsonb_build_object('id', p_po, 'state', p_state);
end $$;

create or replace function public.rpc_production_set_state(p_id uuid, p_state text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('planner','ops_manager','owner');
  if p_state not in ('planned','in_progress','cancelled') then perform app.fail('INVALID', 'state'); end if;
  update production_order set state = p_state where id = p_id and state in ('draft','planned','in_progress');
  if not found then perform app.fail('INVALID_STATE', 'production order cannot change state'); end if;
  return jsonb_build_object('id', p_id, 'state', p_state);
end $$;

-- Latest classification per item, for screens.
create or replace view public.v_item_class as
select ic.* from public.item_class ic join public.classification_run cr on cr.id = ic.run_id where cr.is_current;

-- Suggestions with the inputs line shown under the quantity (§8.6).
create or replace view public.v_suggestion as
select s.*, i.sku, i.name as item_name, p.name as supplier_name,
       round(s.qty / nullif(app.units_per_pallet(s.item_id), 0), 2) as pallets,
       sl.moq, sl.order_multiple, sl.price_breaks
from public.replenishment_suggestion s
join public.item i on i.id = s.item_id
left join public.party p on p.id = s.supplier_id
left join public.supplier_lane sl on sl.id = s.supplier_lane_id;
