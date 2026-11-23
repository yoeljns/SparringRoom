-- 0009 Campaign engine (spec §3.6, §9). A campaign is a record with a scope and one or more
-- mechanics; a new campaign of an existing type needs only data entry.

create table public.campaign (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  type text not null default 'promotion',
  state text not null default 'draft' check (state in ('draft','simulated','approved','live','closed','reviewed','cancelled')),
  order_from date not null,
  order_to date not null,
  deliver_from date,
  deliver_to date,
  owner_id uuid references public.app_user (id),
  budget_eur numeric(14,2),
  lot_preference text check (lot_preference in ('amber')),   -- prefer amber lots for free / bundle lines (§9.3)
  approved_by uuid,
  approved_at timestamptz,
  closed_at timestamptz,
  ring_fence_released_at timestamptz,
  reviewed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (order_to >= order_from)
);

-- Rules are attribute filters or explicit lists:
--   item_rule  {"all":true} | {"item_ids":[..]} | {"family":"SEAL"} | {"attributes":{"colour":"GRI"}}
--   party_rule {"all":true} | {"party_ids":[..]} | {"segments":["A","B"]} | {"type":"dealer"}
create table public.campaign_scope (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign (id) on delete cascade,
  item_rule jsonb not null default '{"all": true}'::jsonb,
  party_rule jsonb not null default '{"all": true}'::jsonb,
  market_ids uuid[],
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Plugin registry: one row per mechanic module in /worker/mechanics.
create table public.mechanic_type (
  id uuid not null unique default gen_random_uuid(),
  code text primary key,
  param_schema jsonb not null,
  module text not null,
  version int not null default 1,
  active boolean not null default true,
  description text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.campaign_mechanic (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign (id) on delete cascade,
  mechanic_type text not null references public.mechanic_type (code),
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Per-dealer override of campaign terms (§3.8 lookup chain).
create table public.campaign_dealer_override (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign (id) on delete cascade,
  party_id uuid not null references public.party (id),
  mechanic_type text not null references public.mechanic_type (code),
  params jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, party_id, mechanic_type)
);

create table public.bundle (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item (id),     -- the bundle SKU
  name text,
  kind text not null default 'phantom' check (kind in ('phantom','prebuilt')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create unique index bundle_item_active on public.bundle (item_id) where active;

create table public.bundle_line (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.bundle (id) on delete cascade,
  component_item_id uuid not null references public.item (id),
  qty numeric(14,3) not null check (qty > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (bundle_id, component_item_id)
);

-- Written by the mechanics' demand_effect.
create table public.campaign_forecast (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign (id) on delete cascade,
  item_id uuid not null references public.item (id),
  week date not null,
  baseline numeric(14,3) not null default 0,
  uplift numeric(14,3) not null default 0,
  pull_forward numeric(14,3) not null default 0,
  cannibalised numeric(14,3) not null default 0,
  free_qty numeric(14,3) not null default 0,
  prior_id uuid,
  override numeric(14,3),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, item_id, week)
);

-- Scenario result for a draft campaign (§9.7).
create table public.campaign_simulation (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign (id) on delete cascade,
  plan_version_id uuid references public.plan_version (id) on delete set null,
  base_plan_version_id uuid references public.plan_version (id) on delete set null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index campaign_simulation_idx on public.campaign_simulation (campaign_id, created_at desc);

-- Written 8 weeks after close (§9.5).
create table public.campaign_review (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaign (id) on delete cascade,
  item_id uuid references public.item (id),
  gross numeric(14,3),
  borrowed numeric(14,3),
  cannibalised numeric(14,3),
  net numeric(14,3),
  forecast_net numeric(14,3),
  confidence text check (confidence in ('high','medium','low')),
  details jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index campaign_review_idx on public.campaign_review (campaign_id);

-- One prior per (mechanic type, family, dealer segment, depth band), shrinkage-updated (§9.6).
create table public.uplift_library (
  id uuid primary key default gen_random_uuid(),
  mechanic_type text not null references public.mechanic_type (code),
  family_id uuid references public.item_family (id),
  segment text,
  depth_band text,
  prior_uplift numeric(10,4) not null,
  prior_low numeric(10,4),
  prior_high numeric(10,4),
  n_obs numeric(10,2) not null default 0,
  last_obs jsonb not null default '[]'::jsonb,      -- the last 5 observations
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create unique index uplift_library_key on public.uplift_library
  (mechanic_type, coalesce(family_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(segment, '*'), coalesce(depth_band, '*'));

-- The always-on commercial baseline (§9.4).
create table public.standard_terms (
  id uuid primary key default gen_random_uuid(),
  name text,
  scope jsonb not null default '{"all": true}'::jsonb,
  terms jsonb not null,
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

select app.track(t) from unnest(array[
  'public.campaign','public.campaign_scope','public.mechanic_type','public.campaign_mechanic',
  'public.campaign_dealer_override','public.bundle','public.bundle_line','public.campaign_forecast',
  'public.uplift_library','public.standard_terms']::regclass[]) t;

-- The eight mechanic types delivered in v1 (§9.2). The worker keeps these rows in step
-- with its module registry.
insert into public.mechanic_type (code, module, description, param_schema) values
  ('price_discount', 'mechanics.price_discount', 'Percentage discount', '{
     "type":"object","required":["discount_pct"],"additionalProperties":false,
     "properties":{"discount_pct":{"type":"number","exclusiveMinimum":0,"maximum":100}}}'),
  ('volume_tier', 'mechanics.volume_tier', 'Discount by quantity tier', '{
     "type":"object","required":["tiers"],"additionalProperties":false,
     "properties":{"tiers":{"type":"array","minItems":1,"items":{
       "type":"object","required":["min_qty","discount_pct"],"additionalProperties":false,
       "properties":{"min_qty":{"type":"number","exclusiveMinimum":0},"discount_pct":{"type":"number","exclusiveMinimum":0,"maximum":100}}}}}}'),
  ('buy_x_get_y', 'mechanics.buy_x_get_y', 'Free goods per multiple bought', '{
     "type":"object","required":["buy_item_rule","buy_qty","free_item","free_qty"],"additionalProperties":false,
     "properties":{"buy_item_rule":{"type":"object"},"buy_qty":{"type":"number","exclusiveMinimum":0},
       "free_item":{"type":"string"},"free_qty":{"type":"number","exclusiveMinimum":0},
       "max_per_order":{"type":"number","exclusiveMinimum":0}}}'),
  ('mixed_set', 'mechanics.mixed_set', 'Bundle sold as a set', '{
     "type":"object","required":["bundle_id"],"additionalProperties":false,
     "properties":{"bundle_id":{"type":"string"},"price":{"type":"number","minimum":0}}}'),
  ('gift_item', 'mechanics.gift_item', 'Gift above a threshold', '{
     "type":"object","required":["gift_item","qty"],"additionalProperties":false,
     "properties":{"threshold_eur":{"type":"number","exclusiveMinimum":0},"threshold_qty":{"type":"number","exclusiveMinimum":0},
       "gift_item":{"type":"string"},"qty":{"type":"number","exclusiveMinimum":0}}}'),
  ('target_rebate', 'mechanics.target_rebate', 'Rebate on reaching a period target', '{
     "type":"object","required":["period","targets","rebate_pct"],"additionalProperties":false,
     "properties":{"period":{"type":"string"},"targets":{"type":"object"},
       "rebate_pct":{"type":"number","exclusiveMinimum":0,"maximum":100}}}'),
  ('launch_seed', 'mechanics.launch_seed', 'Seed quantity of a launch item per dealer segment', '{
     "type":"object","required":["item","seed_qty"],"additionalProperties":false,
     "properties":{"item":{"type":"string"},"seed_qty":{"type":"object"}}}'),
  ('export_push', 'mechanics.export_push', 'Export market push', '{
     "type":"object","required":["market","items"],"additionalProperties":false,
     "properties":{"market":{"type":"string"},"items":{"type":"array","minItems":1,"items":{"type":"string"}},"terms":{"type":"object"}}}');

-- ---------------------------------------------------------------------------
-- Scope matching
-- ---------------------------------------------------------------------------
create or replace function app.rule_matches_item(p_rule jsonb, p_item uuid) returns boolean
language sql stable as $$
  select coalesce(p_rule, '{"all":true}'::jsonb) = '{}'::jsonb
      or coalesce((p_rule->>'all')::boolean, false)
      or (p_rule ? 'item_ids' and p_rule->'item_ids' @> to_jsonb(p_item::text))
      or (p_rule ? 'skus' and p_rule->'skus' @> to_jsonb((select sku from public.item where id = p_item)))
      or (p_rule ? 'family' and exists (select 1 from public.item i join public.item_family f on f.id = i.family_id
                                         where i.id = p_item and f.code = p_rule->>'family'))
      or (p_rule ? 'attributes' and exists (select 1 from public.item i where i.id = p_item and i.attributes @> (p_rule->'attributes')))
$$;

create or replace function app.rule_matches_party(p_rule jsonb, p_party uuid) returns boolean
language sql stable as $$
  select coalesce(p_rule, '{"all":true}'::jsonb) = '{}'::jsonb
      or coalesce((p_rule->>'all')::boolean, false)
      or (p_rule ? 'party_ids' and p_rule->'party_ids' @> to_jsonb(p_party::text))
      or (p_rule ? 'segments' and exists (select 1 from public.party p where p.id = p_party and p_rule->'segments' @> to_jsonb(p.segment)))
      or (p_rule ? 'type' and exists (select 1 from public.party p where p.id = p_party and p.type = p_rule->>'type'))
$$;

create or replace function app.campaign_in_scope(p_campaign uuid, p_party uuid, p_item uuid default null) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from campaign_scope s
     where s.campaign_id = p_campaign
       and app.rule_matches_party(s.party_rule, p_party)
       and (p_item is null or app.rule_matches_item(s.item_rule, p_item))
       and (s.market_ids is null or cardinality(s.market_ids) = 0
            or (select market_id from party where id = p_party) = any (s.market_ids)))
$$;

-- Live campaigns a dealer's order falls under, with mechanics (dealer override wins over
-- campaign scope) and bundle contents, for the order-entry explode functions.
create or replace function public.rpc_campaigns_for_order(p_party uuid, p_date date default null) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'code', c.code, 'name', c.name, 'order_from', c.order_from, 'order_to', c.order_to,
    'lot_preference', c.lot_preference,
    'scopes', (select jsonb_agg(jsonb_build_object('item_rule', s.item_rule)) from campaign_scope s
                where s.campaign_id = c.id and app.rule_matches_party(s.party_rule, p_party)),
    'mechanics', (select jsonb_agg(jsonb_build_object('mechanic_type', m.mechanic_type,
                     'params', coalesce((select o.params from campaign_dealer_override o
                                          where o.campaign_id = c.id and o.party_id = p_party and o.mechanic_type = m.mechanic_type), m.params),
                     'overridden', exists (select 1 from campaign_dealer_override o
                                            where o.campaign_id = c.id and o.party_id = p_party and o.mechanic_type = m.mechanic_type)))
                    from campaign_mechanic m where m.campaign_id = c.id),
    'bundles', (select jsonb_agg(jsonb_build_object('bundle_id', b.id, 'item_id', b.item_id, 'kind', b.kind,
                    'lines', (select jsonb_agg(jsonb_build_object('item_id', bl.component_item_id, 'qty', bl.qty)) from bundle_line bl where bl.bundle_id = b.id)))
                  from bundle b where b.active and exists (
                    select 1 from campaign_mechanic m where m.campaign_id = c.id and m.mechanic_type = 'mixed_set'
                       and m.params->>'bundle_id' = b.id::text)))), '[]'::jsonb)
  from campaign c
  where c.state = 'live' and coalesce(p_date, app.today()) between c.order_from and c.order_to
    and app.campaign_in_scope(c.id, p_party) and app.user_role() is not null
$$;

-- ---------------------------------------------------------------------------
-- Lifecycle (§9.1)
-- ---------------------------------------------------------------------------
create or replace function public.rpc_campaign_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_id uuid := (p->>'id')::uuid;
  c campaign;
  m jsonb; s jsonb;
  v_schema jsonb;
  v_err text[];
begin
  perform app.require_role('planner','ops_manager','owner');
  if v_id is not null then
    select * into c from campaign where id = v_id for update;
    if c.id is null then perform app.fail('NOT_FOUND', 'campaign'); end if;
    if c.state not in ('draft','simulated') then perform app.fail('INVALID_STATE', 'only draft campaigns can be edited'); end if;
    update campaign set code = coalesce(p->>'code', code), name = coalesce(p->>'name', name), type = coalesce(p->>'type', type),
           order_from = (p->>'order_from')::date, order_to = (p->>'order_to')::date,
           deliver_from = (p->>'deliver_from')::date, deliver_to = (p->>'deliver_to')::date,
           budget_eur = (p->>'budget_eur')::numeric, lot_preference = nullif(p->>'lot_preference', ''),
           note = p->>'note', state = 'draft'
     where id = v_id;
  else
    insert into campaign (code, name, type, order_from, order_to, deliver_from, deliver_to, owner_id, budget_eur, lot_preference, note, created_by)
    values (p->>'code', p->>'name', coalesce(p->>'type', 'promotion'), (p->>'order_from')::date, (p->>'order_to')::date,
            (p->>'deliver_from')::date, (p->>'deliver_to')::date, app.uid(), (p->>'budget_eur')::numeric,
            nullif(p->>'lot_preference', ''), p->>'note', app.uid())
    returning id into v_id;
  end if;

  if p ? 'scopes' then
    delete from campaign_scope where campaign_id = v_id;
    for s in select * from jsonb_array_elements(p->'scopes') loop
      insert into campaign_scope (campaign_id, item_rule, party_rule, market_ids, created_by)
      values (v_id, coalesce(s->'item_rule', '{"all":true}'::jsonb), coalesce(s->'party_rule', '{"all":true}'::jsonb),
              case when s ? 'market_ids' and jsonb_typeof(s->'market_ids') = 'array'
                   then array(select jsonb_array_elements_text(s->'market_ids'))::uuid[] end, app.uid());
    end loop;
  end if;
  if p ? 'mechanics' then
    delete from campaign_mechanic where campaign_id = v_id;
    for m in select * from jsonb_array_elements(p->'mechanics') loop
      select param_schema into v_schema from mechanic_type where code = m->>'mechanic_type' and active;
      if v_schema is null then perform app.fail('INVALID_PARAMS', format('unknown mechanic type %s', m->>'mechanic_type')); end if;
      v_err := app.validate_json(v_schema, coalesce(m->'params', '{}'::jsonb));
      if array_length(v_err, 1) > 0 then
        perform app.fail('INVALID_PARAMS', format('%s: %s', m->>'mechanic_type', array_to_string(v_err, '; ')));
      end if;
      insert into campaign_mechanic (campaign_id, mechanic_type, params, created_by)
      values (v_id, m->>'mechanic_type', m->'params', app.uid());
    end loop;
  end if;
  if p ? 'dealer_overrides' then
    delete from campaign_dealer_override where campaign_id = v_id;
    for m in select * from jsonb_array_elements(p->'dealer_overrides') loop
      select param_schema into v_schema from mechanic_type where code = m->>'mechanic_type';
      v_err := app.validate_json(v_schema, coalesce(m->'params', '{}'::jsonb));
      if array_length(v_err, 1) > 0 then
        perform app.fail('INVALID_PARAMS', format('%s: %s', m->>'mechanic_type', array_to_string(v_err, '; ')));
      end if;
      insert into campaign_dealer_override (campaign_id, party_id, mechanic_type, params, created_by)
      values (v_id, (m->>'party_id')::uuid, m->>'mechanic_type', m->'params', app.uid());
    end loop;
  end if;
  return jsonb_build_object('campaign_id', v_id, 'state', 'draft');
end $$;

create or replace function public.rpc_campaign_simulate(p_campaign uuid) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_job uuid;
begin
  perform app.require_role('planner','ops_manager','owner');
  if not exists (select 1 from campaign where id = p_campaign and state in ('draft','simulated')) then
    perform app.fail('INVALID_STATE', 'only draft campaigns can be simulated');
  end if;
  insert into job_queue (kind, payload, requested_by, created_by)
  values ('simulate_campaign', jsonb_build_object('campaign_id', p_campaign), app.uid(), app.uid()) returning id into v_job;
  return v_job;
end $$;

-- Called by the worker when a scenario run has completed against the published plan.
create or replace function public.rpc_campaign_simulation_done(p_campaign uuid, p_plan_version uuid, p_result jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid;
begin
  perform app.require_role('owner');  -- in practice only the worker (system) calls this
  insert into campaign_simulation (campaign_id, plan_version_id, base_plan_version_id, result, created_by)
  values (p_campaign, p_plan_version, app.current_plan_version(), p_result, app.uid()) returning id into v_id;
  update campaign set state = 'simulated' where id = p_campaign and state in ('draft','simulated');
  return v_id;
end $$;

-- A campaign cannot be approved without a simulation on the current plan version.
create or replace function app.campaign_simulation_current(p_campaign uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((
    select s.base_plan_version_id is not distinct from app.current_plan_version()
           and s.created_at >= coalesce((select published_at from plan_version where id = app.current_plan_version()), '-infinity')
      from campaign_simulation s where s.campaign_id = p_campaign order by s.created_at desc limit 1), false)
$$;

create or replace function app.campaign_approve(p_campaign uuid, p_approver uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  c campaign;
  v_release int := coalesce(app.param_num('ring_fence_release_days'), 7)::int;
begin
  select * into c from campaign where id = p_campaign for update;
  if c.state <> 'simulated' or not app.campaign_simulation_current(p_campaign) then
    perform app.fail('SIMULATION_STALE', 'campaign needs a simulation on the current plan version before approval');
  end if;
  update campaign set state = 'approved', approved_by = p_approver, approved_at = now() where id = p_campaign;
  -- ring-fence: soft reservations for the campaign's incremental and free volume
  insert into reservation (item_id, qty_base, original_qty, type, campaign_id, need_date, expires_at, created_by)
  select f.item_id, sum(greatest(coalesce(f.override, f.uplift), 0) + f.free_qty),
         sum(greatest(coalesce(f.override, f.uplift), 0) + f.free_qty), 'soft', p_campaign, c.order_from,
         (c.order_to + v_release)::timestamptz, p_approver
    from campaign_forecast f where f.campaign_id = p_campaign
   group by f.item_id having sum(greatest(coalesce(f.override, f.uplift), 0) + f.free_qty) > 0;
  -- the forecast delta enters the plan and pre-build suggestions are raised on the next run
  insert into job_queue (kind, payload, requested_by) values ('run_job', jsonb_build_object('jobs', array['forecast','compute_policy','suggest'], 'campaign_id', p_campaign), p_approver);
end $$;

create or replace function public.rpc_campaign_request_approval(p_campaign uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid; c campaign;
begin
  perform app.require_role('planner','ops_manager','owner');
  select * into c from campaign where id = p_campaign;
  if c.id is null then perform app.fail('NOT_FOUND', 'campaign'); end if;
  if c.state <> 'simulated' or not app.campaign_simulation_current(p_campaign) then
    perform app.fail('SIMULATION_STALE', 'campaign needs a simulation on the current plan version before approval');
  end if;
  insert into approval_request (type, payload, requested_by, reason, entity_type, entity_id, created_by)
  values ('campaign_approval', jsonb_build_object('campaign_id', p_campaign, 'code', c.code, 'name', c.name),
          app.uid(), p_note, 'campaign', p_campaign, app.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Nightly: open and close order windows, release ring-fences N days after close.
create or replace function public.rpc_campaign_tick() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_today date := app.today();
  v_release int := coalesce(app.param_num('ring_fence_release_days'), 7)::int;
  v_live int; v_closed int; v_released int;
begin
  perform app.require_role('owner');
  update campaign set state = 'live' where state = 'approved' and order_from <= v_today and order_to >= v_today;
  get diagnostics v_live = row_count;
  update campaign set state = 'closed', closed_at = now() where state in ('approved','live') and order_to < v_today;
  get diagnostics v_closed = row_count;
  update reservation r set state = 'released'
    from campaign c
   where r.campaign_id = c.id and r.demand_line_id is null and r.state = 'active'
     and c.state in ('closed','reviewed') and c.order_to + v_release <= v_today;
  get diagnostics v_released = row_count;
  update campaign set ring_fence_released_at = now()
   where state in ('closed','reviewed') and ring_fence_released_at is null and order_to + v_release <= v_today;
  return jsonb_build_object('live', v_live, 'closed', v_closed, 'ring_fences_released', v_released);
end $$;

-- Pre-built kit (§9.3): consumes components and creates a kit lot whose expiry is the
-- earliest component expiry.
create or replace function app.cmd_kit_assemble(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  b bundle;
  v_kits numeric := (a->>'qty')::numeric;
  v_lines jsonb := '[]'::jsonb;
  v_expiry date;
  v_lot lot;
  v_kit item;
  bl record; f record;
  v_need numeric; v_take numeric;
  c jsonb;
  v_res jsonb;
begin
  perform app.require_role('operator','ops_manager','owner');
  select * into b from bundle where id = (a->>'bundle_id')::uuid;
  if b.id is null then perform app.fail('NOT_FOUND', 'bundle'); end if;
  if b.kind <> 'prebuilt' then perform app.fail('INVALID', 'only pre-built kits are assembled; phantom bundles are never stocked'); end if;
  if v_kits is null or v_kits <= 0 then perform app.fail('INVALID', 'quantity must be positive'); end if;
  select * into v_kit from item where id = b.item_id;

  if a ? 'components' then
    for c in select * from jsonb_array_elements(a->'components') loop
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('item_id', c->>'item_id', 'lot_id', c->>'lot_id',
        'from_location', c->>'from_location', 'to_location', 'V-PRODUCTION', 'from_status', 'available',
        'qty_entered', (c->>'qty')::numeric, 'scan_method', coalesce(c->>'scan_method', 'scan')));
      v_expiry := least(v_expiry, (select expiry_date from lot where id = (c->>'lot_id')::uuid));
    end loop;
    -- the scanned components must cover the bill of materials
    for bl in select * from bundle_line where bundle_id = b.id loop
      if coalesce((select sum((x->>'qty')::numeric) from jsonb_array_elements(a->'components') x
                    where (x->>'item_id')::uuid = bl.component_item_id), 0) <> bl.qty * v_kits then
        perform app.fail('INVALID', 'components do not match the bundle definition');
      end if;
    end loop;
  else
    -- take components first-expired-first-out
    for bl in select * from bundle_line where bundle_id = b.id loop
      v_need := bl.qty * v_kits;
      for f in select * from v_lot_free where item_id = bl.component_item_id and free_qty > 0
                order by expiry_date nulls last, location_code loop
        exit when v_need <= 0;
        v_take := least(f.free_qty, v_need);
        v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('item_id', f.item_id, 'lot_id', f.lot_id,
          'from_location', f.location_id, 'to_location', 'V-PRODUCTION', 'from_status', 'available',
          'qty_entered', v_take, 'scan_method', 'system')));
        v_expiry := least(v_expiry, f.expiry_date);
        v_need := v_need - v_take;
      end loop;
      if v_need > 0 then perform app.fail('NEGATIVE_BALANCE', 'not enough component stock for the kit'); end if;
    end loop;
  end if;

  insert into lot (item_id, lot_no, prod_date, expiry_date, qc_status, is_kit, created_by)
  values (b.item_id, coalesce(nullif(a->>'kit_lot_no', ''), 'KIT-' || to_char(now(), 'YYMMDDHH24MISS')), app.today(),
          v_expiry, 'released', true, app.uid())
  returning * into v_lot;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('item_id', b.item_id, 'lot_id', v_lot.id,
    'from_location', 'V-PRODUCTION', 'to_location', a->>'to_location', 'to_status', 'available',
    'qty_entered', v_kits, 'scan_method', coalesce(a->>'scan_method', 'scan')));
  v_res := app.post_txn_internal(jsonb_build_object(
    'client_uuid', a->>'client_uuid', 'txn_type', 'kit_assemble', 'event_at', a->>'event_at',
    'reason_code', a->>'reason_code', 'device_id', a->>'device_id',
    'ref_doc_type', 'bundle', 'ref_doc_id', b.id, 'lines', v_lines), false);
  return v_res || jsonb_build_object('kit_lot_id', v_lot.id, 'kit_lot_no', v_lot.lot_no, 'kit_expiry', v_expiry);
end $$;

-- Campaign list with forecast against actual demand in the order window.
create or replace view public.v_campaign as
select c.*,
       (select coalesce(sum(coalesce(f.override, f.uplift) + f.baseline), 0) from public.campaign_forecast f where f.campaign_id = c.id) as forecast_qty,
       (select coalesce(sum(coalesce(f.override, f.uplift)), 0) from public.campaign_forecast f where f.campaign_id = c.id) as forecast_uplift,
       (select coalesce(sum(l.qty), 0) from public.so_line l join public.sales_order o on o.id = l.order_id
         where o.campaign_id = c.id and o.state <> 'cancelled' and not l.is_phantom) as actual_qty,
       (select max(s.created_at) from public.campaign_simulation s where s.campaign_id = c.id) as last_simulated_at,
       app.campaign_simulation_current(c.id) as simulation_current
from public.campaign c;
