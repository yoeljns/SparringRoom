-- 0010 Network, control and exchange (spec §3.7, §10, §11, §12).

-- ---------------------------------------------------------------------------
-- Two-person approvals (§12.2)
-- ---------------------------------------------------------------------------
create table public.approval_rule (
  type text primary key,
  requester_roles text[],              -- null = any role
  approver_roles text[] not null,
  description text
);
insert into public.approval_rule values
  ('count_adjust',     '{operator,ops_manager,sales_rep}', '{ops_manager,owner}', 'Count adjustment above the EUR threshold'),
  ('scrap',            '{qc}',                             '{ops_manager,owner}', 'Scrap'),
  ('weight_override',  '{operator}',                       '{ops_manager}',       'Truck weight override'),
  ('mrsl_override',    '{planner}',                        '{owner}',             'MRSL override for one shipment'),
  ('param_publish',    '{planner}',                        '{owner}',             'Planning parameter publish'),
  ('campaign_approval','{planner}',                        '{owner,ops_manager}', 'Campaign approval'),
  ('backdate',         null,                               '{ops_manager}',       'Backdated transaction older than 3 days'),
  ('over_receipt',     '{operator}',                       '{ops_manager,owner}', 'Over-receipt above tolerance');

create table public.approval_request (
  id uuid primary key default gen_random_uuid(),
  type text not null references public.approval_rule (type),
  payload jsonb not null default '{}'::jsonb,
  requested_by uuid,
  approved_by uuid,
  state text not null default 'pending' check (state in ('pending','approved','rejected','executed','cancelled')),
  reason text,
  decision_note text,
  entity_type text,
  entity_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (approved_by is null or approved_by is distinct from requested_by)   -- two-person rule
);
create index approval_request_state_idx on public.approval_request (state, created_at);
select app.track('public.approval_request');

create or replace function public.rpc_request_approval(p_type text, p_payload jsonb, p_reason text default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_rule approval_rule;
  v_id uuid;
begin
  if app.user_role() is null then perform app.fail('NOT_PERMITTED', 'unknown user'); end if;
  select * into v_rule from approval_rule where type = p_type;
  if v_rule.type is null then perform app.fail('INVALID', 'unknown approval type'); end if;
  if p_type in ('param_publish','campaign_approval','count_adjust') then
    perform app.fail('INVALID', 'this approval is raised by its own workflow');
  end if;
  if v_rule.requester_roles is not null and not (app.user_role() = any (v_rule.requester_roles || array['owner','ops_manager','system'])) then
    perform app.fail('NOT_PERMITTED', format('role %s may not request %s', app.user_role(), p_type));
  end if;
  if nullif(p_reason, '') is null then perform app.fail('REASON_REQUIRED', 'a reason is required'); end if;
  insert into approval_request (type, payload, requested_by, reason, entity_type, entity_id, created_by)
  values (p_type, coalesce(p_payload, '{}'::jsonb), app.uid(), p_reason,
          case when p_payload ? 'shipment_id' then 'shipment' end, (p_payload->>'shipment_id')::uuid, app.uid())
  returning id into v_id;
  if p_type = 'scrap' then
    perform app.raise_alert('scrap_request', 'warning', true, jsonb_build_object('approval_id', v_id, 'reason', p_reason, 'payload', p_payload), 'approval_request', v_id);
  end if;
  return v_id;
end $$;

-- An approval_request must be approved by a different user holding the approving role
-- before the action executes.
create or replace function public.rpc_decide_approval(p_id uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  a approval_request;
  v_rule approval_rule;
  v_role text := app.user_role();
  v_result jsonb := '{}'::jsonb;
  v_lines jsonb;
  v_res jsonb;
begin
  select * into a from approval_request where id = p_id for update;
  if a.id is null then perform app.fail('NOT_FOUND', 'approval request'); end if;
  if a.state <> 'pending' then perform app.fail('INVALID_STATE', 'request is already decided'); end if;
  select * into v_rule from approval_rule where type = a.type;
  if v_role is null or not (v_role = any (v_rule.approver_roles) or v_role = 'owner') then
    perform app.fail('NOT_PERMITTED', format('role %s may not approve %s', coalesce(v_role, 'none'), a.type));
  end if;
  if a.requested_by is not distinct from app.uid() then
    perform app.fail('NOT_PERMITTED', 'two-person rule: the requester cannot approve their own request');
  end if;

  if not p_approve then
    update approval_request set state = 'rejected', approved_by = null, decision_note = p_note, decided_at = now() where id = p_id;
    if a.type = 'count_adjust' then
      update count_task set state = 'recount', counted_by = null, approval_id = null where id = (a.payload->>'count_task_id')::uuid;
    elsif a.type = 'param_publish' then
      update planning_param set state = 'rejected' where proposal_id = (a.payload->>'proposal_id')::uuid and state = 'draft';
    end if;
    return jsonb_build_object('id', p_id, 'state', 'rejected');
  end if;

  update approval_request set state = 'approved', approved_by = app.uid(), decision_note = p_note, decided_at = now() where id = p_id;

  if a.type = 'count_adjust' then
    v_result := app.count_apply_adjust((a.payload->>'count_task_id')::uuid);
    update approval_request set state = 'executed' where id = p_id;
  elsif a.type = 'scrap' then
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item_id', l->>'item_id', 'lot_id', l->>'lot_id', 'pallet_serial', l->>'pallet_serial',
             'from_location', l->>'location', 'from_status', l->>'status',
             'qty_entered', (l->>'qty')::numeric, 'uom', l->>'uom', 'scan_method', 'system')))
      into v_lines from jsonb_array_elements(a.payload->'lines') l;
    v_result := app.post_txn_internal(jsonb_build_object(
      'client_uuid', app.derive_uuid(a.id, 'scrap'), 'txn_type', 'scrap', 'reason_code', coalesce(a.reason, 'scrap'),
      'ref_doc_type', 'approval_request', 'ref_doc_id', a.id, 'approval_id', a.id, 'lines', v_lines), true);
    insert into export_row (type, ref_id, payload, created_by)
    select 'adjustments', v_result->>'txn_id', jsonb_build_object('txn_id', v_result->>'txn_id', 'date', app.today(),
             'logo_item_code', i.logo_item_code, 'qty_signed', m.qty_base, 'reason_code', 'scrap',
             'approved_by', (select full_name from app_user where id = app.uid())), app.uid()
      from stock_move m join item i on i.id = m.item_id join location l on l.id = m.location_id
     where m.txn_id = (v_result->>'txn_id')::uuid and l.type <> 'virtual';
    update approval_request set state = 'executed' where id = p_id;
  elsif a.type = 'mrsl_override' then
    insert into param_override (scope_type, scope_id, param, value, reason, approved_by, valid_to, created_by)
    values ('shipment', (a.payload->>'shipment_id')::uuid, 'mrsl_days', to_jsonb((a.payload->>'mrsl_days')::numeric),
            coalesce(a.reason, 'approved override'), app.uid(), now() + interval '60 days', a.requested_by);
    update approval_request set state = 'executed' where id = p_id;
  elsif a.type = 'param_publish' then
    v_result := jsonb_build_object('param_version', app.publish_params((a.payload->>'proposal_id')::uuid, app.uid()));
    update approval_request set state = 'executed' where id = p_id;
  elsif a.type = 'campaign_approval' then
    perform app.campaign_approve((a.payload->>'campaign_id')::uuid, app.uid());
    update approval_request set state = 'executed' where id = p_id;
  end if;
  -- weight_override, backdate and over_receipt stay 'approved' and are consumed by the command that needs them
  return jsonb_build_object('id', p_id, 'state', 'approved', 'result', v_result);
end $$;

-- Parameter changes: planners propose, the owner publishes (two-person rule); an owner's
-- own proposal publishes directly.
create or replace function public.rpc_param_propose(p_rows jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_proposal uuid := gen_random_uuid();
  r jsonb;
  v_approval uuid;
begin
  perform app.require_role('planner','owner');
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into planning_param (scope_type, scope_id, param, value, valid_from, valid_to, state, proposal_id, note, created_by)
    values (coalesce(r->>'scope_type', 'global'), coalesce(r->>'scope_id', '*'), r->>'param', r->'value',
            coalesce((r->>'valid_from')::date, current_date), (r->>'valid_to')::date, 'draft', v_proposal,
            coalesce(r->>'note', p_note), app.uid());
  end loop;
  if app.user_role() in ('owner','system') then
    return jsonb_build_object('proposal_id', v_proposal, 'published', true, 'param_version', app.publish_params(v_proposal, app.uid()));
  end if;
  insert into approval_request (type, payload, requested_by, reason, created_by)
  values ('param_publish', jsonb_build_object('proposal_id', v_proposal, 'rows', p_rows), app.uid(), p_note, app.uid())
  returning id into v_approval;
  return jsonb_build_object('proposal_id', v_proposal, 'published', false, 'approval_id', v_approval);
end $$;

-- Monthly cycle, week 4: the owner signs off and the plan version is published (§8.7).
create or replace function public.rpc_plan_publish(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('owner');
  update plan_version set state = 'archived' where state = 'published' and kind = 'plan' and id <> p_plan;
  update plan_version set state = 'published', kind = 'plan', published_at = clock_timestamp(), signed_by = app.uid(),
         param_version = app.param_version() where id = p_plan;
  if not found then perform app.fail('NOT_FOUND', 'plan version'); end if;
  return jsonb_build_object('plan_version_id', p_plan, 'state', 'published');
end $$;

-- ---------------------------------------------------------------------------
-- Dealer stock (§10)
-- ---------------------------------------------------------------------------
create table public.dealer_stock_observation (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.party (id),
  item_id uuid not null references public.item (id),
  qty numeric(14,3) not null check (qty >= 0),
  source text not null check (source in ('count','rep_visual','self_report')),
  observed_at timestamptz not null default now(),
  user_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index dealer_obs_idx on public.dealer_stock_observation (party_id, item_id, observed_at desc);

-- Rebuilt nightly: one row per dealer and item. Advisory only; planning never waits for it.
create table public.dealer_stock_estimate (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.party (id),
  item_id uuid not null references public.item (id),
  qty_est numeric(14,3),
  method text not null check (method in ('observed_count','rep_visual','self_report','inferred','unknown')),
  confidence numeric(6,4) not null default 0,
  weekly_sell_through numeric(14,3),
  cover_weeks numeric(10,2),
  as_of date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (party_id, item_id)
);

-- Vendor-managed replenishment pilot (§10.4).
create table public.vmi_param (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.party (id),
  item_id uuid not null references public.item (id),
  min_qty numeric(14,3) not null,
  max_qty numeric(14,3) not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (party_id, item_id)
);
select app.track('public.vmi_param');

create table public.vmi_proposal (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.party (id),
  lines jsonb not null,                -- [{item_id, on_hand, min, max, qty}]
  state text not null default 'proposed' check (state in ('proposed','approved','rejected','superseded')),
  order_id uuid references public.sales_order (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create trigger trg_touch before update on public.vmi_proposal for each row execute function app.touch();

create or replace function app.cmd_dealer_observation(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_party uuid := (a->>'party_id')::uuid;
  v_item item;
  v_id uuid;
begin
  perform app.require_role('sales_rep','ops_manager','owner');
  if not app.rep_can(v_party) then perform app.fail('NOT_PERMITTED', 'not your dealer'); end if;
  v_item := app.find_item(a);
  insert into dealer_stock_observation (party_id, item_id, qty, source, observed_at, user_id, created_by)
  values (v_party, v_item.id, (a->>'qty')::numeric, coalesce(a->>'source', 'rep_visual'),
          coalesce((a->>'event_at')::timestamptz, now()), app.uid(), app.uid())
  returning id into v_id;
  update task set state = 'done', done_at = now(), done_by = app.uid()
   where type = 'count_request' and party_id = v_party and state in ('open','in_progress')
     and (item_id is null or item_id = v_item.id);
  return jsonb_build_object('observation_id', v_id);
end $$;

-- One-tap approval of a VMI proposal: becomes a draft order for the dealer.
create or replace function public.rpc_vmi_decide(p_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v vmi_proposal;
  v_order jsonb;
begin
  perform app.require_role('sales_rep','planner','ops_manager','owner');
  select * into v from vmi_proposal where id = p_id for update;
  if v.id is null then perform app.fail('NOT_FOUND', 'proposal'); end if;
  if not app.rep_can(v.party_id) then perform app.fail('NOT_PERMITTED', 'not your dealer'); end if;
  if v.state <> 'proposed' then perform app.fail('INVALID_STATE', 'proposal already decided'); end if;
  if not p_approve then
    update vmi_proposal set state = 'rejected', decided_at = now() where id = p_id;
    return jsonb_build_object('id', p_id, 'state', 'rejected');
  end if;
  v_order := public.rpc_save_order(jsonb_build_object(
    'party_id', v.party_id, 'requested_date', app.today() + 7, 'note', 'VMI',
    'lines', (select jsonb_agg(jsonb_build_object('item_id', l->>'item_id', 'qty', (l->>'qty')::numeric, 'uom', 'base'))
                from jsonb_array_elements(v.lines) l where (l->>'qty')::numeric > 0)));
  update vmi_proposal set state = 'approved', order_id = (v_order->>'order_id')::uuid, decided_at = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'state', 'approved', 'order_id', v_order->>'order_id');
end $$;

-- ---------------------------------------------------------------------------
-- Logo Tiger file exchange (§11)
-- ---------------------------------------------------------------------------
create table public.import_contract (
  file_type text primary key,
  direction text not null check (direction in ('inbound','outbound')),
  columns text[] not null
);
insert into public.import_contract values
  ('items','inbound','{logo_item_code,name,unit,gtin,active}'),
  ('parties','inbound','{logo_cari_code,name,vkn,type,city,country,active}'),
  ('sales_docs','inbound','{doc_type,doc_no,doc_date,logo_cari_code,logo_item_code,qty,unit,unit_price_eur,is_free,e_irsaliye_no,ref_shipment_id}'),
  ('purchase_docs','inbound','{doc_no,doc_date,logo_cari_code,logo_item_code,qty,unit}'),
  ('stock_snapshot','inbound','{as_of,logo_item_code,warehouse_code,qty,unit}'),
  ('item_cost','inbound','{logo_item_code,cost_eur,as_of}'),
  ('shipment_confirm','outbound','{shipment_id,ship_date,logo_cari_code,logo_item_code,qty,unit,lot_no,line_type,campaign_code}'),
  ('receipts','outbound','{receipt_id,date,supplier_code,logo_item_code,qty,lot_no}'),
  ('adjustments','outbound','{txn_id,date,logo_item_code,qty_signed,reason_code,approved_by}'),
  ('consignment_sales','outbound','{dealer_code,logo_item_code,qty,period}'),
  ('campaign_settlement','outbound','{campaign_code,dealer_code,type,amount_eur,qty}');

create table public.import_batch (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_hash text not null unique,              -- a file imports once
  file_type text,
  schema_version text,
  state text not null default 'validating' check (state in ('validating','applied','rejected','held')),
  row_count int not null default 0,
  error_count int not null default 0,
  error text,
  rows jsonb,                                  -- kept while the file is held for review
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.import_row_error (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batch (id) on delete cascade,
  row_no int not null,
  error text not null,
  raw jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.export_batch (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  period date not null default current_date,
  seq int not null default 1,
  file_name text not null unique,
  row_count int not null default 0,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.logo_sales_doc (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.import_batch (id),
  doc_type text not null check (doc_type in ('irsaliye','invoice')),
  doc_no text not null,
  doc_date date not null,
  party_id uuid references public.party (id),
  item_id uuid references public.item (id),
  qty numeric(14,3) not null,
  unit text,
  qty_base numeric(14,3),
  unit_price_eur numeric(14,4),
  is_free boolean not null default false,
  e_irsaliye_no text,
  ref_shipment_id text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index logo_sales_doc_key on public.logo_sales_doc (doc_type, doc_no, item_id, is_free, qty);
create index logo_sales_doc_ref_idx on public.logo_sales_doc (ref_shipment_id);
create index logo_sales_doc_item_idx on public.logo_sales_doc (item_id, doc_date);

create table public.logo_purchase_doc (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.import_batch (id),
  doc_no text not null,
  doc_date date not null,
  party_id uuid references public.party (id),
  item_id uuid references public.item (id),
  qty numeric(14,3) not null,
  unit text,
  qty_base numeric(14,3),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index logo_purchase_doc_key on public.logo_purchase_doc (doc_no, item_id, qty);

create table public.logo_stock_snapshot (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.import_batch (id),
  as_of date not null,
  item_id uuid references public.item (id),
  logo_item_code text not null,
  warehouse_code text,
  qty numeric(14,3) not null,
  unit text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index logo_stock_snapshot_idx on public.logo_stock_snapshot (as_of, item_id);

create or replace function app.try_num(p text) returns numeric language plpgsql immutable as $$
begin return p::numeric; exception when others then return null; end $$;
create or replace function app.try_date(p text) returns date language plpgsql immutable as $$
begin
  if p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then return null; end $$;
create or replace function app.try_bool(p text) returns boolean language sql immutable as $$
  select case lower(coalesce(p, '')) when 'true' then true when '1' then true when 'false' then false when '0' then false else null end
$$;

-- Logo unit -> base units through uom_pack; null means there is no mapping.
create or replace function app.logo_to_base(p_item uuid, p_qty numeric, p_unit text) returns numeric
language sql stable as $$
  select p_qty * coalesce(
    (select 1::numeric from public.item i where i.id = p_item
       and (p_unit is null or lower(p_unit) = lower(i.base_uom) or lower(p_unit) = lower(coalesce(i.logo_unit, '')))),
    (select u.qty_base from public.uom_pack u where u.item_id = p_item
       and (lower(u.logo_unit) = lower(p_unit) or lower(u.level) = lower(p_unit)) limit 1))
$$;

-- Import one parsed file. Rules (§11.1): a hash seen before is skipped; a file with an
-- unknown column or schema version is rejected whole; a file with any row error is held
-- for review and not partially applied.
create or replace function public.rpc_import_batch(
  p_file_name text, p_file_hash text, p_file_type text, p_schema_version text, p_header text[], p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, app as $$
declare
  v_batch uuid;
  v_cols text[];
  v_existing import_batch;
  r jsonb;
  v_no int := 0;
  v_err text;
  v_errors int := 0;
  v_item uuid; v_party uuid;
  v_family uuid;
  v_applied int := 0;
begin
  perform app.require_role('finance','ops_manager','owner');
  select * into v_existing from import_batch where file_hash = p_file_hash;
  if v_existing.id is not null then
    return jsonb_build_object('batch_id', v_existing.id, 'state', 'skipped', 'reason', 'file already imported');
  end if;
  select columns into v_cols from import_contract where file_type = p_file_type and direction = 'inbound';
  if v_cols is null or p_schema_version is distinct from 'v1'
     or not (p_header <@ v_cols and p_header @> v_cols) then
    insert into import_batch (file_name, file_hash, file_type, schema_version, state, row_count, error, created_by)
    values (p_file_name, p_file_hash, p_file_type, p_schema_version, 'rejected', coalesce(jsonb_array_length(p_rows), 0),
            case when v_cols is null then 'unknown file type'
                 when p_schema_version is distinct from 'v1' then 'unknown schema version'
                 else 'unknown or missing column' end, app.uid())
    returning id into v_batch;
    perform app.raise_alert('import_file_rejected', 'critical', true,
      jsonb_build_object('file_name', p_file_name, 'file_type', p_file_type), 'import_batch', v_batch);
    return jsonb_build_object('batch_id', v_batch, 'state', 'rejected');
  end if;

  insert into import_batch (file_name, file_hash, file_type, schema_version, state, row_count, created_by)
  values (p_file_name, p_file_hash, p_file_type, p_schema_version, 'validating', jsonb_array_length(p_rows), app.uid())
  returning id into v_batch;

  -- validate every row first
  for r in select * from jsonb_array_elements(p_rows) loop
    v_no := v_no + 1;
    v_err := null;
    if p_file_type in ('items','sales_docs','purchase_docs','stock_snapshot','item_cost') and nullif(r->>'logo_item_code', '') is null then
      v_err := 'logo_item_code is empty';
    elsif p_file_type in ('sales_docs','purchase_docs','stock_snapshot','item_cost')
          and not exists (select 1 from item where logo_item_code = r->>'logo_item_code') then
      v_err := format('unknown item %s', r->>'logo_item_code');
    elsif p_file_type in ('parties','sales_docs','purchase_docs') and nullif(r->>'logo_cari_code', '') is null then
      v_err := 'logo_cari_code is empty';
    elsif p_file_type in ('sales_docs','purchase_docs')
          and not exists (select 1 from party where logo_cari_code = r->>'logo_cari_code') then
      v_err := format('unknown party %s', r->>'logo_cari_code');
    elsif p_file_type = 'items' and (nullif(r->>'name', '') is null or nullif(r->>'unit', '') is null or app.try_bool(r->>'active') is null) then
      v_err := 'name, unit and active are required';
    elsif p_file_type = 'parties' and (nullif(r->>'name', '') is null or r->>'type' not in ('dealer','supplier','importer') or app.try_bool(r->>'active') is null) then
      v_err := 'name, a valid type and active are required';
    elsif p_file_type = 'sales_docs' and (r->>'doc_type' not in ('irsaliye','invoice') or nullif(r->>'doc_no', '') is null
          or app.try_date(r->>'doc_date') is null or app.try_num(r->>'qty') is null or app.try_bool(r->>'is_free') is null
          or (nullif(r->>'unit_price_eur', '') is not null and app.try_num(r->>'unit_price_eur') is null)) then
      v_err := 'invalid doc_type, doc_no, doc_date, qty, unit_price_eur or is_free';
    elsif p_file_type = 'purchase_docs' and (nullif(r->>'doc_no', '') is null or app.try_date(r->>'doc_date') is null or app.try_num(r->>'qty') is null) then
      v_err := 'invalid doc_no, doc_date or qty';
    elsif p_file_type = 'stock_snapshot' and (app.try_date(r->>'as_of') is null or app.try_num(r->>'qty') is null) then
      v_err := 'invalid as_of or qty';
    elsif p_file_type = 'item_cost' and (app.try_date(r->>'as_of') is null or app.try_num(r->>'cost_eur') is null) then
      v_err := 'invalid as_of or cost_eur';
    end if;
    if v_err is not null then
      insert into import_row_error (batch_id, row_no, error, raw, created_by) values (v_batch, v_no, v_err, r, app.uid());
      v_errors := v_errors + 1;
    end if;
  end loop;
  if v_errors > 0 then
    update import_batch set state = 'held', error_count = v_errors, rows = p_rows where id = v_batch;
    perform app.raise_alert('import_file_held', 'warning', true,
      jsonb_build_object('file_name', p_file_name, 'errors', v_errors), 'import_batch', v_batch);
    return jsonb_build_object('batch_id', v_batch, 'state', 'held', 'errors', v_errors);
  end if;

  -- apply
  for r in select * from jsonb_array_elements(p_rows) loop
    v_item := null; v_party := null;
    if p_file_type <> 'parties' then select id into v_item from item where logo_item_code = r->>'logo_item_code'; end if;
    if p_file_type in ('sales_docs','purchase_docs') then select id into v_party from party where logo_cari_code = r->>'logo_cari_code'; end if;

    if p_file_type = 'items' then
      -- detects new or changed items; never overwrites attributes kept here
      if v_item is null then
        select id into v_family from item_family where code = 'UNASSIGNED';
        if v_family is null then
          insert into item_family (code, name) values ('UNASSIGNED', 'Atanmamış (Logo''dan yeni)') returning id into v_family;
        end if;
        insert into item (sku, name, gtin, family_id, base_uom, logo_item_code, logo_name, logo_unit, logo_active,
                          active, needs_review, created_by)
        values (r->>'logo_item_code', r->>'name', nullif(r->>'gtin', ''), v_family, 'piece', r->>'logo_item_code',
                r->>'name', r->>'unit', app.try_bool(r->>'active'), false, true, app.uid())
        returning id into v_item;
        insert into task (type, priority, item_id, assigned_role, payload, created_by)
        values ('master_data', 2, v_item, 'planner', jsonb_build_object('reason', 'new item from Logo', 'code', r->>'logo_item_code'), app.uid());
      else
        update item set needs_review = needs_review
                 or logo_name is distinct from r->>'name' or logo_unit is distinct from r->>'unit'
                 or logo_active is distinct from app.try_bool(r->>'active'),
               logo_name = r->>'name', logo_unit = r->>'unit', logo_active = app.try_bool(r->>'active'),
               gtin = coalesce(gtin, nullif(r->>'gtin', ''))
         where id = v_item;
      end if;
    elsif p_file_type = 'parties' then
      insert into party (type, name, vkn, logo_cari_code, city, country, active, created_by)
      values (r->>'type', r->>'name', nullif(r->>'vkn', ''), r->>'logo_cari_code', nullif(r->>'city', ''),
              nullif(r->>'country', ''), app.try_bool(r->>'active'), app.uid())
      on conflict (logo_cari_code) do update
        set name = excluded.name, vkn = coalesce(excluded.vkn, party.vkn), city = excluded.city,
            country = excluded.country, active = excluded.active;
    elsif p_file_type = 'sales_docs' then
      insert into logo_sales_doc (batch_id, doc_type, doc_no, doc_date, party_id, item_id, qty, unit, qty_base,
                                  unit_price_eur, is_free, e_irsaliye_no, ref_shipment_id, created_by)
      values (v_batch, r->>'doc_type', r->>'doc_no', (r->>'doc_date')::date, v_party, v_item, (r->>'qty')::numeric, r->>'unit',
              app.logo_to_base(v_item, (r->>'qty')::numeric, r->>'unit'), app.try_num(r->>'unit_price_eur'),
              app.try_bool(r->>'is_free'), nullif(r->>'e_irsaliye_no', ''), nullif(r->>'ref_shipment_id', ''), app.uid())
      on conflict do nothing;
      -- the e-İrsaliye number and invoice come back from Logo against our shipment number
      if nullif(r->>'ref_shipment_id', '') is not null then
        if r->>'doc_type' = 'irsaliye' then
          update shipment set e_irsaliye_no = coalesce(e_irsaliye_no, nullif(r->>'e_irsaliye_no', ''), r->>'doc_no')
           where shipment_no = r->>'ref_shipment_id' and e_irsaliye_no is null;
        else
          update shipment set invoice_doc_no = r->>'doc_no' where shipment_no = r->>'ref_shipment_id' and invoice_doc_no is null;
        end if;
      end if;
    elsif p_file_type = 'purchase_docs' then
      insert into logo_purchase_doc (batch_id, doc_no, doc_date, party_id, item_id, qty, unit, qty_base, created_by)
      values (v_batch, r->>'doc_no', (r->>'doc_date')::date, v_party, v_item, (r->>'qty')::numeric, r->>'unit',
              app.logo_to_base(v_item, (r->>'qty')::numeric, r->>'unit'), app.uid())
      on conflict do nothing;
    elsif p_file_type = 'stock_snapshot' then
      insert into logo_stock_snapshot (batch_id, as_of, item_id, logo_item_code, warehouse_code, qty, unit, created_by)
      values (v_batch, (r->>'as_of')::date, v_item, r->>'logo_item_code', r->>'warehouse_code', (r->>'qty')::numeric, r->>'unit', app.uid());
    elsif p_file_type = 'item_cost' then
      insert into item_cost (item_id, cost_eur, as_of, created_by)
      values (v_item, (r->>'cost_eur')::numeric, (r->>'as_of')::date, app.uid())
      on conflict (item_id, as_of) do update set cost_eur = excluded.cost_eur;
    end if;
    v_applied := v_applied + 1;
  end loop;
  update import_batch set state = 'applied' where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'state', 'applied', 'rows', v_applied);
end $$;

-- Build the next outbound file for a type from the pending export rows.
create or replace function public.rpc_export_build(p_type text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_cols text[];
  v_seq int;
  v_batch uuid;
  v_name text;
  v_rows jsonb;
  v_n int;
begin
  perform app.require_role('finance','ops_manager','owner');
  select columns into v_cols from import_contract where file_type = p_type and direction = 'outbound';
  if v_cols is null then perform app.fail('INVALID', 'unknown outbound file type'); end if;
  select count(*) into v_n from export_row where type = p_type and export_batch_id is null;
  if v_n = 0 then return jsonb_build_object('state', 'empty', 'type', p_type); end if;
  select coalesce(max(seq), 0) + 1 into v_seq from export_batch where type = p_type and period = app.today();
  v_name := format('%s_%s_%s.csv', p_type, to_char(app.today(), 'YYYYMMDD'), lpad(v_seq::text, 2, '0'));
  insert into export_batch (type, period, seq, file_name, row_count, created_by)
  values (p_type, app.today(), v_seq, v_name, v_n, app.uid()) returning id into v_batch;
  update export_row set export_batch_id = v_batch where type = p_type and export_batch_id is null;
  select jsonb_agg(payload order by created_at) into v_rows from export_row where export_batch_id = v_batch;
  return jsonb_build_object('state', 'built', 'batch_id', v_batch, 'file_name', v_name, 'schema', 'v1',
                            'header', to_jsonb(v_cols), 'rows', v_rows);
end $$;

create or replace function public.rpc_export_get(p_batch uuid) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select jsonb_build_object('batch_id', b.id, 'file_name', b.file_name, 'schema', 'v1',
           'header', (select to_jsonb(columns) from import_contract where file_type = b.type),
           'rows', (select coalesce(jsonb_agg(payload order by created_at), '[]'::jsonb) from export_row where export_batch_id = b.id))
    from export_batch b where b.id = p_batch and app.user_role() in ('finance','ops_manager','owner','auditor','system')
$$;

create or replace function public.rpc_export_ack(p_batch uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('finance','owner');
  update export_batch set acknowledged_at = now() where id = p_batch;
end $$;

-- ---------------------------------------------------------------------------
-- Daily reconciliation (§11.4)
-- ---------------------------------------------------------------------------
create table public.recon_run (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  cutoff_at timestamptz not null,
  kind text not null default 'daily' check (kind in ('daily','month_end')),
  signed_by uuid,
  signed_at timestamptz,
  summary jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index recon_run_date_idx on public.recon_run (run_date desc);

create table public.recon_result (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.recon_run (id) on delete cascade,
  level text not null check (level in ('item','doc')),
  item_id uuid references public.item (id),
  doc_no text,
  doc_side text,                         -- inventory | logo : which system holds the unmatched document
  logo_qty numeric(14,3),
  ledger_qty numeric(14,3),
  diff numeric(14,3),
  class text not null check (class in ('timing','mapping','missing_doc','true_variance')),
  first_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index recon_result_open_idx on public.recon_result (run_id) where resolved_at is null;

create or replace function public.rpc_run_reconciliation(p_as_of date default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_as_of date := coalesce(p_as_of, (select max(as_of) from logo_stock_snapshot), app.today());
  v_cutoff timestamptz := ((v_as_of + 1)::timestamp at time zone 'Europe/Istanbul');
  v_hours numeric := coalesce(app.param_num('recon_timing_hours'), 48);
  v_cons boolean := coalesce(app.param_text('logo_carries_consignment')::boolean, true);
  v_run uuid; v_prev uuid;
  r record; d record;
  v_class text;
  v_unmatched int; v_old int;
begin
  perform app.require_role('finance','owner','ops_manager');
  select id into v_prev from recon_run order by created_at desc limit 1;
  insert into recon_run (run_date, cutoff_at, created_by) values (v_as_of, v_cutoff, app.uid()) returning id into v_run;

  -- 3. document level: every dispatched shipment against a Logo irsaliye by ref_shipment_id,
  --    every receipt against a purchase document; and Logo documents we cannot place.
  drop table if exists _unmatched;
  create temp table _unmatched on commit drop as
  select 'inventory'::text as side, s.shipment_no as doc_no, i.id as item_id, s.dispatched_at as doc_at
    from shipment s
    join pallet p on p.shipment_id = s.id
    join item i on i.id = p.item_id
   where s.state = 'dispatched' and s.dispatched_at < v_cutoff
     and not exists (select 1 from logo_sales_doc ld where ld.doc_type = 'irsaliye' and ld.ref_shipment_id = s.shipment_no and ld.item_id = i.id)
   group by s.shipment_no, i.id, s.dispatched_at
  union all
  select 'logo', ld.doc_no, ld.item_id, ld.doc_date::timestamptz
    from logo_sales_doc ld
   where ld.doc_type = 'irsaliye' and ld.doc_date <= v_as_of and ld.doc_date > v_as_of - 60
     and not exists (select 1 from shipment s where s.shipment_no = ld.ref_shipment_id and s.state = 'dispatched')
  union all
  select 'inventory', t.id::text, m.item_id, t.event_at
    from stock_txn t join stock_move m on m.txn_id = t.id and m.qty_base > 0
   where t.txn_type = 'receipt_purchase' and t.event_at < v_cutoff and t.event_at > v_cutoff - interval '60 days'
     and not exists (select 1 from stock_txn rv where rv.reverses_txn_id = t.id)
     and not exists (select 1 from logo_purchase_doc pd where pd.item_id = m.item_id
                      and pd.qty_base = m.qty_base and abs(pd.doc_date - (t.event_at at time zone 'Europe/Istanbul')::date) <= 3)
  union all
  select 'logo', pd.doc_no, pd.item_id, pd.doc_date::timestamptz
    from logo_purchase_doc pd
   where pd.doc_date <= v_as_of and pd.doc_date > v_as_of - 60
     and not exists (select 1 from stock_txn t join stock_move m on m.txn_id = t.id and m.qty_base > 0
                      where t.txn_type = 'receipt_purchase' and m.item_id = pd.item_id and m.qty_base = pd.qty_base
                        and abs(pd.doc_date - (t.event_at at time zone 'Europe/Istanbul')::date) <= 3);

  insert into recon_result (run_id, level, item_id, doc_no, doc_side, class, first_seen_at, created_by)
  select v_run, 'doc', u.item_id, u.doc_no, u.side,
         case when u.doc_at > now() - make_interval(hours => v_hours::int) then 'timing' else 'missing_doc' end,
         coalesce((select min(pr.first_seen_at) from recon_result pr where pr.run_id = v_prev and pr.level = 'doc'
                    and pr.doc_no = u.doc_no and pr.item_id is not distinct from u.item_id), now()), app.uid()
    from _unmatched u;

  -- 1 + 2. item level at the same cut-off time
  for r in
    select i.id as item_id, i.sku,
           (select sum(app.logo_to_base(i.id, s.qty, s.unit)) from logo_stock_snapshot s where s.item_id = i.id and s.as_of = v_as_of) as logo_qty,
           exists (select 1 from logo_stock_snapshot s where s.item_id = i.id and s.as_of = v_as_of
                    and app.logo_to_base(i.id, s.qty, s.unit) is null) as unmapped,
           exists (select 1 from logo_stock_snapshot s where s.item_id = i.id and s.as_of = v_as_of) as in_logo,
           coalesce((select sum(m.qty_base) from stock_move m join stock_txn t on t.id = m.txn_id join location l on l.id = m.location_id
                      where m.item_id = i.id and m.owner_id = app.dayson() and l.type <> 'virtual'
                        and (v_cons or l.type <> 'consignment') and t.event_at < v_cutoff), 0) as ledger_qty
      from item i where i.active or exists (select 1 from logo_stock_snapshot s where s.item_id = i.id and s.as_of = v_as_of)
  loop
    continue when not r.in_logo and r.ledger_qty = 0;
    if r.unmapped then
      v_class := 'mapping';
    elsif coalesce(r.logo_qty, 0) = r.ledger_qty then
      continue;
    else
      select count(*), count(*) filter (where doc_at <= now() - make_interval(hours => v_hours::int))
        into v_unmatched, v_old from _unmatched where item_id = r.item_id;
      v_class := case when v_unmatched = 0 then 'true_variance' when v_old > 0 then 'missing_doc' else 'timing' end;
    end if;
    insert into recon_result (run_id, level, item_id, logo_qty, ledger_qty, diff, class, first_seen_at, created_by)
    values (v_run, 'item', r.item_id, r.logo_qty, r.ledger_qty, r.ledger_qty - coalesce(r.logo_qty, 0), v_class,
            coalesce((select min(pr.first_seen_at) from recon_result pr where pr.run_id = v_prev and pr.level = 'item'
                       and pr.item_id = r.item_id and pr.class = v_class), now()), app.uid());
    -- 4. actions per class
    if v_class = 'mapping' and not exists (select 1 from task where type = 'master_data' and item_id = r.item_id and state in ('open','in_progress')) then
      insert into task (type, priority, item_id, assigned_role, payload, created_by)
      values ('master_data', 2, r.item_id, 'planner', jsonb_build_object('reason', 'Logo unit or code mismatch'), app.uid());
    elsif v_class = 'missing_doc' and not exists (select 1 from task where type = 'finance' and item_id = r.item_id and state in ('open','in_progress')) then
      insert into task (type, priority, item_id, assigned_role, payload, created_by)
      values ('finance', 2, r.item_id, 'finance', jsonb_build_object('reason', 'document in one system only, over 48 hours'), app.uid());
    elsif v_class = 'true_variance' then
      insert into count_task (location_id, item_id, lot_id, trigger, created_by)
      select b.location_id, b.item_id, b.lot_id, 'exception', app.uid()
        from stock_balance b join location l on l.id = b.location_id
       where b.item_id = r.item_id and b.qty_base > 0 and l.type in ('block_lane','pick_face')
         and not exists (select 1 from count_task ct where ct.location_id = b.location_id and ct.state in ('open','recount','pending_approval'))
       group by b.location_id, b.item_id, b.lot_id limit 10;
    end if;
  end loop;

  -- timing differences auto-clear when the other side arrives: the previous run is superseded
  update recon_result set resolved_at = now() where run_id = v_prev and resolved_at is null;
  update recon_run set summary = (
    select jsonb_build_object(
      'open', count(*),
      'by_class', coalesce((select jsonb_object_agg(class, n) from (select class, count(*) n from recon_result where run_id = v_run group by class) x), '{}'::jsonb),
      'unexplained_over_48h', count(*) filter (where class <> 'timing' and first_seen_at <= now() - make_interval(hours => v_hours::int)))
      from recon_result where run_id = v_run)
   where id = v_run;
  return (select jsonb_build_object('run_id', id, 'as_of', run_date) || summary from recon_run where id = v_run);
end $$;

-- Finance signs off the month-end reconciliation in the app.
create or replace function public.rpc_recon_signoff(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('finance','owner');
  update recon_run set kind = 'month_end', signed_by = app.uid(), signed_at = now() where id = p_run and signed_at is null;
  if not found then perform app.fail('INVALID_STATE', 'run not found or already signed'); end if;
  return jsonb_build_object('run_id', p_run, 'signed', true);
end $$;

create or replace view public.v_recon_open as
select rr.*, r.run_date, i.sku, i.name as item_name,
       round(extract(epoch from now() - rr.first_seen_at) / 3600.0, 1) as age_hours
from public.recon_result rr
join public.recon_run r on r.id = rr.run_id
left join public.item i on i.id = rr.item_id
where rr.resolved_at is null
  and rr.run_id = (select id from public.recon_run order by created_at desc limit 1);

-- ---------------------------------------------------------------------------
-- Ageing bands (§7.2), recomputed nightly. Margins resolve through the chain
-- lot override, item, family, global.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_update_expiry_bands() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  l record;
  v_today date := app.today();
  v_left int; v_band text;
  v_amber numeric; v_blocked numeric; v_dom numeric; v_min numeric;
  v_lines jsonb;
  v_changed int := 0; v_blocked_n int := 0;
  v_camp uuid;
begin
  perform app.require_role('owner','qc','ops_manager');
  select min((value #>> '{}')::numeric) into v_min from planning_param where param = 'mrsl_days' and state = 'published'
     and valid_from <= v_today and (valid_to is null or valid_to >= v_today);
  for l in
    select lot.*, i.sku, i.name as item_name from lot join item i on i.id = lot.item_id
     where lot.expiry_date is not null
       and exists (select 1 from stock_balance b join location loc on loc.id = b.location_id
                    where b.lot_id = lot.id and b.qty_base > 0 and loc.type <> 'virtual')
  loop
    v_left := l.expiry_date - v_today;
    v_amber := coalesce((l.band_override->>'amber_margin_days')::numeric,
                        app.param_num('band_amber_margin_days', jsonb_build_object('item_id', l.item_id)), 90);
    v_blocked := coalesce((l.band_override->>'blocked_days')::numeric,
                          app.param_num('band_blocked_days', jsonb_build_object('item_id', l.item_id)), 60);
    v_dom := coalesce(app.param_num('mrsl_domestic_days', jsonb_build_object('item_id', l.item_id)), 180);
    v_band := case when v_left < v_blocked then 'blocked'
                   when v_left < coalesce(v_min, v_dom) then 'red'
                   when v_left < v_dom + v_amber then 'amber'
                   else 'green' end;
    if v_band is distinct from l.band then
      update lot set band = v_band, band_as_of = v_today where id = l.id;
      v_changed := v_changed + 1;
      if v_band in ('amber','red') then
        perform app.raise_alert('lot_band_' || v_band, 'warning', false,
          jsonb_build_object('sku', l.sku, 'lot_no', l.lot_no, 'expiry_date', l.expiry_date, 'days_left', v_left), 'lot', l.id);
      end if;
      -- amber lots at a dealer raise a rotate-or-recall task (§10.1)
      if v_band = 'amber' then
        insert into task (type, priority, item_id, lot_id, location_id, party_id, assigned_role, created_by)
        select 'rotate_recall', 2, l.item_id, l.id, loc.id, loc.dealer_id, 'sales_rep', app.uid()
          from stock_balance b join location loc on loc.id = b.location_id
         where b.lot_id = l.id and b.qty_base > 0 and loc.type = 'consignment'
         group by loc.id, loc.dealer_id;
      end if;
      -- red: excluded from normal allocation; a draft liquidation campaign is proposed
      if v_band = 'red' and not exists (select 1 from campaign c where c.code = 'LIQ-' || l.sku and c.state = 'draft') then
        insert into campaign (code, name, type, order_from, order_to, note, created_by)
        values ('LIQ-' || l.sku, 'Tasfiye önerisi: ' || l.item_name, 'liquidation', v_today, v_today + 30,
                format('Otomatik öneri: lot %s kırmızı bantta (%s gün kaldı)', l.lot_no, v_left), app.uid())
        on conflict (code) do nothing
        returning id into v_camp;
        if v_camp is not null then
          insert into campaign_scope (campaign_id, item_rule) values (v_camp, jsonb_build_object('item_ids', jsonb_build_array(l.item_id::text)));
        end if;
      end if;
    end if;
    -- blocked: expiry_block posted; QA decides retest or scrap
    if v_band = 'blocked' then
      select jsonb_agg(jsonb_build_object('item_id', b.item_id, 'lot_id', b.lot_id, 'location', b.location_id,
               'owner_id', b.owner_id, 'qty_entered', b.qty_base, 'scan_method', 'system'))
        into v_lines
        from stock_balance b join location loc on loc.id = b.location_id
       where b.lot_id = l.id and b.stock_status = 'available' and b.qty_base > 0 and loc.type <> 'virtual';
      if v_lines is not null then
        perform app.post_txn_internal(jsonb_build_object(
          'client_uuid', app.derive_uuid(l.id, 'expiry_block:' || v_today::text), 'txn_type', 'expiry_block',
          'reason_code', 'expiry', 'ref_doc_type', 'lot', 'ref_doc_id', l.id, 'lines', v_lines), true);
        update reservation set state = 'released' where lot_id = l.id and type = 'hard' and state = 'active';
        insert into task (type, priority, item_id, lot_id, assigned_role, payload, created_by)
        values ('qc', 1, l.item_id, l.id, 'qc', jsonb_build_object('reason', 'expiry_block: retest or scrap'), app.uid());
        v_blocked_n := v_blocked_n + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('bands_changed', v_changed, 'lots_blocked', v_blocked_n);
end $$;

-- ---------------------------------------------------------------------------
-- Nightly control checks that feed the digest and alerts (§12.4, §12.5)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_nightly_checks() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_n int := 0;
  r record;
  v_days int := coalesce(app.param_num('invoice_alert_days'), 5)::int;
  v_pct numeric := coalesce(app.param_num('campaign_demand_alert_pct'), 30);
begin
  perform app.require_role('owner','ops_manager');
  -- shipments without a matching invoice after N days
  for r in select s.* from shipment s where s.state = 'dispatched' and s.dispatched_at < now() - make_interval(days => v_days)
             and s.invoice_doc_no is null
             and not exists (select 1 from logo_sales_doc ld where ld.doc_type = 'invoice' and ld.ref_shipment_id = s.shipment_no) loop
    perform app.raise_alert('shipment_no_invoice', 'warning', false,
      jsonb_build_object('shipment_no', r.shipment_no, 'dispatched_at', r.dispatched_at), 'shipment', r.id, 'shipment_no_invoice:' || r.id);
    v_n := v_n + 1;
  end loop;
  -- inbound orders later than their lane's p90 lead time; flags the orders promised against them
  for r in
    select pl.id, po.po_no, i.sku, po.ordered_at, ls.p90_days,
           (select coalesce(jsonb_agg(distinct o.order_no), '[]'::jsonb) from so_line l join sales_order o on o.id = l.order_id
             where l.promise_basis->'basis' @> jsonb_build_array(jsonb_build_object('id', pl.id))
               and o.state in ('confirmed','allocated','picking')) as orders
      from po_line pl join purchase_order po on po.id = pl.po_id join item i on i.id = pl.item_id
      join lateral (select p90_days from lead_time_stat x where x.supplier_lane_id = po.supplier_lane_id order by as_of desc limit 1) ls on true
     where po.state in ('ordered','confirmed','partially_received') and pl.state in ('open','partially_received')
       and po.ordered_at::date + ceil(ls.p90_days)::int < app.today()
  loop
    perform app.raise_alert('inbound_late', 'warning', false,
      jsonb_build_object('po_no', r.po_no, 'sku', r.sku, 'ordered_at', r.ordered_at, 'p90_days', r.p90_days, 'affected_orders', r.orders),
      'po_line', r.id, 'inbound_late:' || r.id);
    v_n := v_n + 1;
  end loop;
  -- live campaigns where actual demand differs from forecast by more than N%
  for r in select * from v_campaign where state = 'live' and forecast_qty > 0
             and abs(actual_qty - forecast_qty * least(1, (app.today() - order_from + 1)::numeric / greatest(order_to - order_from + 1, 1)))
                 > v_pct / 100.0 * forecast_qty * least(1, (app.today() - order_from + 1)::numeric / greatest(order_to - order_from + 1, 1)) loop
    perform app.raise_alert('campaign_off_forecast', 'warning', false,
      jsonb_build_object('code', r.code, 'forecast_qty', r.forecast_qty, 'actual_qty', r.actual_qty), 'campaign', r.id,
      'campaign_off_forecast:' || r.id || ':' || app.today());
    v_n := v_n + 1;
  end loop;
  -- KVKK retention of scan logs
  delete from scan_event where at < now() - make_interval(days => coalesce(app.param_num('scan_log_retention_days'), 365)::int);
  return jsonb_build_object('alerts', v_n);
end $$;

-- Job failure reported by the worker (§12.5).
create or replace function public.rpc_job_failed(p_job text, p_error text) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('owner');
  perform app.raise_alert('nightly_job_failed', 'critical', true, jsonb_build_object('job', p_job, 'error', left(p_error, 2000)));
end $$;

create or replace function public.rpc_alert_ack(p_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_role('owner','ops_manager','finance','planner','qc');
  update alert set acked_by = app.uid(), acked_at = now() where id = p_id and acked_at is null;
end $$;

-- Real-time alert delivery (§12.5): the notifier reads unsent alerts and marks them sent.
create or replace function public.rpc_alerts_mark_sent(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_n int;
begin
  perform app.require_role('owner','ops_manager');
  update alert set sent_at = now() where id = any (p_ids) and sent_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Who receives the digest and real-time pushes: active owners and ops managers.
create or replace function public.rpc_alert_recipients() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'full_name', full_name, 'role', role, 'email', email,
                                                'telegram_chat_id', telegram_chat_id)), '[]'::jsonb)
    from app_user where active and role in ('owner','ops_manager') and app.user_role() in ('owner','ops_manager','system')
$$;

-- ---------------------------------------------------------------------------
-- KPIs, daily digest (§12.4) and owner dashboard (§12.6)
-- ---------------------------------------------------------------------------
alter table public.so_line add column shipped_complete_at timestamptz;
create or replace function app.so_line_complete() returns trigger
language plpgsql as $$
begin
  if new.shipped_qty >= new.qty and new.shipped_complete_at is null then
    new.shipped_complete_at := now();
  end if;
  return new;
end $$;
create trigger trg_so_line_complete before update of shipped_qty on public.so_line
  for each row execute function app.so_line_complete();

-- Fill rate: lines shipped complete on the promised date / lines due.
create or replace view public.v_fill_rate as
select o.order_type = 'export_contract' as is_export,
       count(*) as lines_due,
       count(*) filter (where l.shipped_complete_at is not null
                          and (l.shipped_complete_at at time zone 'Europe/Istanbul')::date <= l.promised_date) as lines_on_time,
       round(100.0 * count(*) filter (where l.shipped_complete_at is not null
                          and (l.shipped_complete_at at time zone 'Europe/Istanbul')::date <= l.promised_date) / nullif(count(*), 0), 2) as fill_rate_pct
from public.so_line l join public.sales_order o on o.id = l.order_id
where not l.is_phantom and o.state not in ('draft','cancelled')
  and l.promised_date between current_date - 30 and current_date
group by 1;

create or replace view public.v_backorder as
select l.id as so_line_id, o.order_no, o.party_id, p.name as party_name, l.item_id, i.sku, l.qty, l.shipped_qty,
       l.promised_date, o.requested_date, current_date - o.requested_date as age_days,
       (select coalesce(sum(r.qty_base), 0) from public.reservation r where r.demand_line_id = l.id and r.state = 'active' and r.type = 'soft') as open_qty
from public.so_line l join public.sales_order o on o.id = l.order_id
join public.party p on p.id = o.party_id join public.item i on i.id = l.item_id
where l.backorder and l.shipped_qty < l.qty and o.state not in ('cancelled','closed','draft');

create or replace view public.v_ageing_value as
select coalesce(lot.band, 'green') as band, count(distinct lot.id) as lots, sum(b.qty_base) as qty_base,
       round(sum(b.qty_base * coalesce(app.item_cost(b.item_id), 0)), 2) as value_eur
from public.stock_balance b
join public.location l on l.id = b.location_id and l.type <> 'virtual'
left join public.lot on lot.id = b.lot_id
where b.qty_base > 0
group by 1;

create or replace function public.rpc_digest() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_today date := app.today();
  v_plan uuid := app.current_plan_version();
begin
  perform app.require_role('owner','ops_manager','finance','planner','auditor');
  return jsonb_build_object(
    'date', v_today,
    'accuracy', jsonb_build_object(
      'ira_yesterday', (select ira_pct from v_ira_daily where day = v_today - 1),
      'ira_7d', (select round(100.0 * sum(within_tolerance) / nullif(sum(counted), 0), 2) from v_ira_daily where day >= v_today - 7),
      'scan_yesterday', (select compliance_pct from v_scan_compliance_daily where day = v_today - 1),
      'scan_7d', (select round(100.0 * sum(scanned) / nullif(sum(required), 0), 2) from v_scan_compliance_daily where day >= v_today - 7)),
    'reconciliation', jsonb_build_object(
      'by_class', coalesce((select jsonb_object_agg(class, n) from (select class, count(*) n from v_recon_open group by class) x), '{}'::jsonb),
      'older_than_48h', (select count(*) from v_recon_open where class <> 'timing' and age_hours > 48)),
    'below_safety_4w', coalesce((select jsonb_agg(jsonb_build_object('sku', i.sku, 'week', sp.week, 'projected', sp.projected_qty, 'safety_stock', sp.safety_stock) order by sp.week)
        from stock_projection sp join item i on i.id = sp.item_id
       where sp.plan_version_id = v_plan and sp.below_safety and sp.week < v_today + 28), '[]'::jsonb),
    'lots_amber_red', coalesce((select jsonb_agg(a.payload || jsonb_build_object('band', replace(a.rule, 'lot_band_', '')))
        from alert a where a.rule in ('lot_band_amber','lot_band_red') and a.created_at > now() - interval '24 hours'), '[]'::jsonb),
    'expiry_blocked_waiting', coalesce((select jsonb_agg(jsonb_build_object('sku', q.sku, 'lot_no', q.lot_no, 'qty', q.qty_base))
        from v_qc_queue q where q.stock_status = 'blocked_expiry'), '[]'::jsonb),
    'inbound_late', coalesce((select jsonb_agg(a.payload) from alert a where a.rule = 'inbound_late' and a.acked_at is null), '[]'::jsonb),
    'campaigns_off_forecast', coalesce((select jsonb_agg(a.payload) from alert a
        where a.rule = 'campaign_off_forecast' and a.created_at > now() - interval '24 hours'), '[]'::jsonb),
    'weight_overrides', coalesce((select jsonb_agg(a.payload) from alert a
        where a.rule = 'truck_weight_override' and a.created_at > now() - interval '24 hours'), '[]'::jsonb),
    'shipments_no_invoice', coalesce((select jsonb_agg(a.payload) from alert a where a.rule = 'shipment_no_invoice' and a.acked_at is null), '[]'::jsonb),
    'approvals_waiting', coalesce((select jsonb_agg(jsonb_build_object('id', ar.id, 'type', ar.type, 'reason', ar.reason, 'created_at', ar.created_at,
          'for_owner', 'owner' = any ((select approver_roles from approval_rule where type = ar.type))))
        from approval_request ar where ar.state = 'pending'), '[]'::jsonb),
    'negative_fva_sources', coalesce((select jsonb_agg(x) from (
        select source, round(avg(fva), 4) as fva from forecast_override
         where fva is not null and created_at > now() - interval '3 months' group by source having avg(fva) < 0) x), '[]'::jsonb));
end $$;

create or replace function public.rpc_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_today date := app.today();
  v_plan uuid := app.current_plan_version();
  v_run uuid := (select id from forecast_run where is_current limit 1);
begin
  if app.user_role() is null then perform app.fail('NOT_PERMITTED', ''); end if;
  return jsonb_build_object(
    'stock_health', jsonb_build_object(
      'ira_7d', (select round(100.0 * sum(within_tolerance) / nullif(sum(counted), 0), 2) from v_ira_daily where day >= v_today - 7),
      'ira_yesterday', (select ira_pct from v_ira_daily where day = v_today - 1),
      'scan_compliance_7d', (select round(100.0 * sum(scanned) / nullif(sum(required), 0), 2) from v_scan_compliance_daily where day >= v_today - 7),
      'recon_open', (select count(*) from v_recon_open),
      'recon_unexplained_48h', (select count(*) from v_recon_open where class <> 'timing' and age_hours > 48),
      'open_counts', (select count(*) from count_task where state in ('open','recount','pending_approval'))),
    'service', jsonb_build_object(
      'fill_rate_domestic', (select fill_rate_pct from v_fill_rate where not is_export),
      'fill_rate_export', (select fill_rate_pct from v_fill_rate where is_export),
      'backorders', (select count(*) from v_backorder),
      'backorders_by_age', (select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb) from (
          select case when age_days <= 7 then '0-7' when age_days <= 14 then '8-14' when age_days <= 30 then '15-30' else '30+' end as bucket,
                 count(*) n from v_backorder group by 1) x),
      'truck_window_first_time_pct', (select round(100.0 * count(*) filter (where window_ok and override_by is null) / nullif(count(*), 0), 2)
          from truck_load where closed_at > now() - interval '30 days')),
    'stock_risk', jsonb_build_object(
      'below_safety_4w', (select count(distinct item_id) from stock_projection where plan_version_id = v_plan and below_safety and week < v_today + 28),
      'ageing', (select coalesce(jsonb_object_agg(band, jsonb_build_object('lots', lots, 'value_eur', value_eur)), '{}'::jsonb) from v_ageing_value),
      'slow_items', (select count(*) from slow_stock where state = 'open' and run_date = (select max(run_date) from slow_stock)),
      'slow_value_eur', (select coalesce(sum(value_eur), 0) from slow_stock where state = 'open' and run_date = (select max(run_date) from slow_stock))),
    'campaigns_plan', jsonb_build_object(
      'live', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'forecast_qty', forecast_qty, 'actual_qty', actual_qty)), '[]'::jsonb)
                 from v_campaign where state = 'live'),
      'pending_approvals', (select count(*) from approval_request where state = 'pending'),
      'open_suggestions', (select count(*) from replenishment_suggestion where state = 'proposed' and plan_version_id is not distinct from v_plan),
      'forecast_by_family', (select coalesce(jsonb_agg(jsonb_build_object('family', f.code, 'wape', fa.wape, 'bias', fa.bias)), '[]'::jsonb)
                 from forecast_accuracy fa join item_family f on f.id = fa.family_id where fa.run_id = v_run and fa.item_id is null)));
end $$;

-- ---------------------------------------------------------------------------
-- Generic master-data write: every business write goes through a function (§2).
-- ---------------------------------------------------------------------------
create table public.table_permission (
  table_name text not null,
  role text not null,
  primary key (table_name, role)
);
insert into public.table_permission (table_name, role)
select t, r from unnest(array[
  'item_family','item','uom_pack','pack_config','market','site','location','party','supplier_lane','vehicle_type',
  'rep_dealer','bundle','bundle_line','standard_terms','capacity_calendar','purchase_order','po_line',
  'production_order','inbound_shipment','inbound_line','vmi_param','uplift_library','slow_stock']) t,
  unnest(array['owner','ops_manager','planner']) r
where not (r = 'planner' and t in ('location','site','rep_dealer'))
   or false;
insert into public.table_permission values ('app_user','owner'), ('task','ops_manager'), ('task','owner'), ('lot','qc'), ('lot','ops_manager'), ('lot','owner');

create or replace function public.rpc_upsert(p_table text, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_role text := app.user_role();
  v_cols text;
  v_sets text;
  v_id uuid := (p_row->>'id')::uuid;
  v_out jsonb;
begin
  if v_role is null or (v_role <> 'system' and not exists (
       select 1 from table_permission where table_name = p_table and role = v_role)) then
    perform app.fail('NOT_PERMITTED', format('role %s may not edit %s', coalesce(v_role, 'none'), p_table));
  end if;
  if not exists (select 1 from table_permission where table_name = p_table) then
    perform app.fail('INVALID', 'table is not editable');
  end if;
  select string_agg(quote_ident(c.column_name), ', '),
         string_agg(format('%I = r.%I', c.column_name, c.column_name), ', ')
    into v_cols, v_sets
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = p_table and p_row ? c.column_name
     and c.column_name not in ('id','created_at','created_by','updated_at') and c.is_generated = 'NEVER';
  if v_cols is null then perform app.fail('INVALID', 'no known columns in row'); end if;
  if v_id is not null and (select count(*) from information_schema.columns
                            where table_schema = 'public' and table_name = p_table and column_name = 'id') = 1 then
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id = $2 returning to_jsonb(t)',
                   p_table, v_sets, p_table) into v_out using p_row, v_id;
    if v_out is not null then return v_out; end if;
  end if;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) r returning to_jsonb(%I)',
                 p_table, v_cols, replace(v_cols, ', ', ', r.') , p_table, p_table)
    into v_out using p_row;
  return v_out;
end $$;

create or replace function public.rpc_delete(p_table text, p_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_role text := app.user_role();
begin
  if v_role is null or (v_role <> 'system' and not exists (
       select 1 from table_permission where table_name = p_table and role = v_role)) then
    perform app.fail('NOT_PERMITTED', format('role %s may not edit %s', coalesce(v_role, 'none'), p_table));
  end if;
  if p_table in ('app_user','item','party','location','lot') then
    perform app.fail('INVALID', 'this record is deactivated, not deleted');
  end if;
  execute format('delete from public.%I where id = $1', p_table) using p_id;
end $$;

-- Owner assigns roles (§12.1). The auth user must already exist.
create or replace function public.rpc_set_user(p_user uuid, p_full_name text, p_role text, p_active boolean default true, p_email text default null)
returns jsonb language plpgsql security definer set search_path = public, app as $$
begin
  -- bootstrap: the very first user registers themself as owner
  if exists (select 1 from app_user) then
    perform app.require_role('owner');
  elsif p_user is distinct from auth.uid() or p_role <> 'owner' then
    perform app.fail('NOT_PERMITTED', 'the first user must register as owner');
  end if;
  insert into app_user (id, full_name, role, active, email, created_by)
  values (p_user, p_full_name, p_role, p_active, p_email, app.uid())
  on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, active = excluded.active,
                                 email = coalesce(excluded.email, app_user.email);
  return (select to_jsonb(u) from app_user u where u.id = p_user);
end $$;

-- True while no application user exists yet: the login screen then offers owner registration.
create or replace function public.rpc_bootstrap_needed() returns boolean
language sql stable security definer set search_path = public, app as $$
  select not exists (select 1 from app_user)
$$;

-- Storage buckets for the file exchange (§2).
insert into storage.buckets (id, name, public) values ('logo-in', 'logo-in', false), ('logo-out', 'logo-out', false)
on conflict (id) do nothing;
