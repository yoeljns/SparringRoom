-- 0003 Parameters (spec §3.5 planning_param, §3.8 lookup chains).
-- Every rule and planning parameter is an effective-dated, versioned row.
-- One function, resolve_param(name, context), performs every lookup and reports
-- which level supplied the value.

create table public.planning_param (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in
    ('global','site','family','class','item','vehicle_type','market','market_segment','party','party_item')),
  scope_id text not null default '*',     -- uuid, class code such as 'AX', or 'a:b' for composite scopes
  param text not null,
  value jsonb not null,
  valid_from date not null default current_date,
  valid_to date,
  version int not null default 1,
  state text not null default 'published' check (state in ('draft','published','superseded','rejected')),
  proposal_id uuid,
  note text,
  approved_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index planning_param_lookup on public.planning_param (param, scope_type, scope_id) where state = 'published';
select app.track('public.planning_param');

-- One-off overrides on a single lot, pallet, order or shipment, with approval and expiry.
create table public.param_override (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('lot','pallet','order','shipment')),
  scope_id uuid not null,
  param text not null,
  value jsonb not null,
  reason text not null,
  approved_by uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index param_override_lookup on public.param_override (param, scope_type, scope_id);
select app.track('public.param_override');

create or replace function app.param_version() returns int
language sql stable as $$
  select coalesce(max(version), 0) from public.planning_param where state = 'published'
$$;

-- resolve_param: most specific level first, first level holding a value wins.
--   1. approved one-off overrides: shipment, order, pallet, lot
--   2. party+item, party, market+segment, market, vehicle type, item, class, family, site, global
-- Context keys (all optional): shipment_id, order_id, pallet_id, lot_id, party_id, item_id,
-- market_id, segment, vehicle_type_id, family_id, class, site_id, as_of.
-- Missing keys are derived where possible (item -> family/class, party -> market/segment,
-- shipment -> party/vehicle type, lot -> item).
create or replace function public.resolve_param(p_name text, p_ctx jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
declare
  c jsonb := coalesce(p_ctx, '{}'::jsonb);
  v_as_of date := coalesce((c->>'as_of')::date, current_date);
  v_shipment uuid := (c->>'shipment_id')::uuid;
  v_order uuid := (c->>'order_id')::uuid;
  v_pallet uuid := (c->>'pallet_id')::uuid;
  v_lot uuid := (c->>'lot_id')::uuid;
  v_party uuid := (c->>'party_id')::uuid;
  v_item uuid := (c->>'item_id')::uuid;
  v_market uuid := (c->>'market_id')::uuid;
  v_segment text := c->>'segment';
  v_vehicle uuid := (c->>'vehicle_type_id')::uuid;
  v_family uuid := (c->>'family_id')::uuid;
  v_class text := c->>'class';
  v_site uuid := (c->>'site_id')::uuid;
  v_val jsonb;
  v_src uuid;
  r record;
begin
  if v_shipment is not null and (v_party is null or v_vehicle is null) then
    execute 'select party_id, vehicle_type_id from public.shipment where id = $1' into r using v_shipment;
    v_party := coalesce(v_party, r.party_id);
    v_vehicle := coalesce(v_vehicle, r.vehicle_type_id);
  end if;
  if v_lot is not null and v_item is null then
    select item_id into v_item from lot where id = v_lot;
  end if;
  if v_party is not null and (v_market is null or v_segment is null) then
    select coalesce(v_market, market_id), coalesce(v_segment, segment) into v_market, v_segment from party where id = v_party;
  end if;
  if v_item is not null and v_family is null then
    select family_id into v_family from item where id = v_item;
  end if;
  if v_item is not null and v_class is null and to_regclass('public.item_class') is not null then
    execute 'select ic.abc || ic.xyz from public.item_class ic join public.classification_run cr on cr.id = ic.run_id
             where ic.item_id = $1 and cr.is_current limit 1' into v_class using v_item;
  end if;

  -- 1. one-off overrides
  for r in
    select * from (values ('shipment', v_shipment), ('order', v_order), ('pallet', v_pallet), ('lot', v_lot)) as t(scope_type, scope_id)
    where scope_id is not null
  loop
    select o.value, o.id into v_val, v_src from param_override o
     where o.param = p_name and o.scope_type = r.scope_type and o.scope_id = r.scope_id
       and o.approved_by is not null and o.valid_from <= now() and (o.valid_to is null or o.valid_to >= now())
     order by o.created_at desc limit 1;
    if v_val is not null then
      return jsonb_build_object('value', v_val, 'level', r.scope_type || '_override', 'source_id', v_src);
    end if;
  end loop;

  -- 2. effective-dated parameter rows
  for r in
    select * from (values
      (1, 'party_item', v_party::text || ':' || v_item::text),
      (2, 'party', v_party::text),
      (3, 'market_segment', v_market::text || ':' || v_segment),
      (4, 'market', v_market::text),
      (5, 'vehicle_type', v_vehicle::text),
      (6, 'item', v_item::text),
      (7, 'class', v_class),
      (8, 'family', v_family::text),
      (9, 'site', v_site::text),
      (10, 'global', '*')) as t(ord, scope_type, scope_id)
    where scope_id is not null
    order by ord
  loop
    select p.value, p.id into v_val, v_src from planning_param p
     where p.param = p_name and p.scope_type = r.scope_type and p.scope_id = r.scope_id
       and p.state = 'published' and p.valid_from <= v_as_of and (p.valid_to is null or p.valid_to >= v_as_of)
     order by p.version desc, p.valid_from desc limit 1;
    if v_val is not null then
      return jsonb_build_object('value', v_val, 'level', r.scope_type, 'source_id', v_src);
    end if;
  end loop;
  return jsonb_build_object('value', null, 'level', null, 'source_id', null);
end $$;

create or replace function app.param_num(p_name text, p_ctx jsonb default '{}'::jsonb) returns numeric
language sql stable as $$ select (public.resolve_param(p_name, p_ctx)->>'value')::numeric $$;

create or replace function app.param_text(p_name text, p_ctx jsonb default '{}'::jsonb) returns text
language sql stable as $$ select public.resolve_param(p_name, p_ctx)->>'value' $$;

-- Publish a set of draft rows: they become a new version, and the rows they replace are closed.
create or replace function app.publish_params(p_proposal uuid, p_approver uuid) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  v_version int := app.param_version() + 1;
  r record;
begin
  for r in select * from planning_param where proposal_id = p_proposal and state = 'draft' loop
    update planning_param
       set valid_to = r.valid_from - 1, state = 'superseded'
     where param = r.param and scope_type = r.scope_type and scope_id = r.scope_id
       and state = 'published' and (valid_to is null or valid_to >= r.valid_from);
    update planning_param
       set state = 'published', version = v_version, approved_by = p_approver
     where id = r.id;
  end loop;
  return v_version;
end $$;

-- Starting values. Every one is a placeholder the owner can change without code (§15).
insert into public.planning_param (scope_type, scope_id, param, value, note) values
  ('global','*','mrsl_days','180','Domestic dealers; assumption to confirm'),
  ('global','*','mrsl_domestic_days','180','Reference MRSL used for ageing bands'),
  ('global','*','band_amber_margin_days','90','Amber = between MRSL and MRSL + this'),
  ('global','*','band_blocked_days','60','Remaining life under this posts expiry_block'),
  ('global','*','shelf_life_days','365','Placeholder until technical data sheets are supplied'),
  ('global','*','truck_min_kg','24900','Truck weight window, lower edge'),
  ('global','*','truck_max_kg','25075','Truck weight window, upper edge'),
  ('global','*','truck_max_items','5','Maximum different items per truck'),
  ('global','*','over_receipt_tolerance_pct','5','Over-receipt above this needs a supervisor'),
  ('global','*','count_tolerance_pct','0','Full pallets: zero tolerance'),
  ('global','*','count_tolerance_carton_pct','2','Cartons of C items: larger of 1 box or 2%'),
  ('global','*','count_tolerance_carton_min_boxes','1',null),
  ('global','*','adjust_approval_eur','500','Adjustments above this EUR value need a second approver (to set)'),
  ('global','*','backdate_approval_days','3','Backdating older than this needs ops manager approval'),
  ('global','*','backdate_reason_minutes','15','event_at earlier than recorded_at by more than this needs a reason code'),
  ('global','*','release_horizon_working_days','5','Allocation release horizon'),
  ('global','*','allocation_sharing_rule','"ordered"','ordered | trailing_90d'),
  ('global','*','service_level','0.95',null),
  ('class','AX','service_level','0.98',null), ('class','AY','service_level','0.975',null), ('class','AZ','service_level','0.95',null),
  ('class','BX','service_level','0.97',null), ('class','BY','service_level','0.95',null), ('class','BZ','service_level','0.93',null),
  ('class','CX','service_level','0.95',null), ('class','CY','service_level','0.92',null), ('class','CZ','service_level','0.90',null),
  ('global','*','review_period_days','7',null),
  ('global','*','abc_a_pct','80',null), ('global','*','abc_b_pct','95',null),
  ('global','*','xyz_x_max','0.5',null), ('global','*','xyz_y_max','1.0',null),
  ('global','*','adi_cut','1.32',null), ('global','*','cv2_cut','0.49',null),
  ('global','*','lt_window_receipts','20',null), ('global','*','lt_min_receipts','5',null),
  ('global','*','lt_default_sd_pct','25',null), ('global','*','lt_alert_change_pct','15',null),
  ('global','*','production_lt_days','21','3 weeks, example only'),
  ('global','*','production_lt_sd_days','7','1 week, example only'),
  ('global','*','slow_cover_weeks','26',null), ('global','*','obsolete_months','12',null),
  ('global','*','dealer_confidence_half_life_days','45',null),
  ('global','*','dealer_confidence_threshold','0.5',null),
  ('global','*','channel_cover_weeks','12','Channel-loading warning threshold'),
  ('global','*','ring_fence_release_days','7',null),
  ('global','*','campaign_review_weeks','8',null),
  ('global','*','campaign_demand_alert_pct','30',null),
  ('global','*','honeycombing_allowance_pct','35',null),
  ('global','*','invoice_alert_days','5',null),
  ('global','*','recon_timing_hours','48',null),
  ('global','*','logo_carries_consignment','true','Include consignment stock in reconciliation'),
  ('global','*','scan_log_retention_days','365','KVKK retention for scan logs'),
  ('global','*','sscc_company_prefix','"869000000"','Placeholder until GS1 Türkiye prefix is confirmed'),
  ('global','*','holding_cost_pct_year','20','Used for full-truck rounding of order quantities'),
  ('global','*','freight_eur_per_truck','900','Used for full-truck rounding of order quantities');
