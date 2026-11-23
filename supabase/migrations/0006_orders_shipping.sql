-- 0006 Demand and shipping (spec §3.4, §7): orders, promising, allocation, truck loads.

create table public.sales_order (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique default app.next_doc_no('SO'),
  party_id uuid not null references public.party (id),
  market_id uuid references public.market (id),
  requested_date date not null,
  priority_tier int check (priority_tier between 1 and 4),
  campaign_id uuid,
  order_type text not null default 'standard' check (order_type in ('standard','export_contract','consignment')),
  forward_buy boolean not null default false,
  schedule jsonb,                       -- {"trucks_per_month": 4, "months": 6, "start": "2027-01-01"}
  vehicle_type_id uuid references public.vehicle_type (id),
  state text not null default 'draft' check (state in ('draft','confirmed','allocated','picking','shipped','closed','cancelled')),
  logo_doc_no text,
  note text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index sales_order_party_idx on public.sales_order (party_id);
create index sales_order_state_idx on public.sales_order (state);

create table public.so_line (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sales_order (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references public.item (id),
  qty numeric(14,3) not null check (qty > 0),          -- base units
  uom text,
  qty_entered numeric(14,3),
  line_type text not null default 'paid' check (line_type in ('paid','free','bundle_component')),
  parent_line_id uuid references public.so_line (id) on delete cascade,
  is_phantom boolean not null default false,           -- phantom bundle SKU line: never stocked
  bundle_id uuid,
  mechanic_code text,
  terms jsonb,
  promised_date date,
  promise_basis jsonb,                                 -- the supply rows the promise relied on
  shipped_qty numeric(14,3) not null default 0,
  backorder boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (order_id, line_no)
);
create index so_line_item_idx on public.so_line (item_id);

create table public.shipment (
  id uuid primary key default gen_random_uuid(),
  shipment_no text not null unique default app.next_doc_no('SH'),
  party_id uuid not null references public.party (id),
  planned_date date not null,
  state text not null default 'planned' check (state in ('planned','allocated','picking','loading','dispatched','cancelled')),
  e_irsaliye_no text,
  seal_no text,
  vehicle_type_id uuid references public.vehicle_type (id),
  vehicle_ref text,
  dispatched_at timestamptz,
  invoice_doc_no text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  -- a shipment cannot reach dispatched without its e-İrsaliye number (§3.4)
  check (state <> 'dispatched' or (e_irsaliye_no is not null and length(trim(e_irsaliye_no)) > 0))
);
create index shipment_state_idx on public.shipment (state, planned_date);

create table public.shipment_line (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipment (id) on delete cascade,
  so_line_id uuid not null references public.so_line (id) on delete cascade,
  qty_base numeric(14,3) not null check (qty_base > 0),
  shipped_qty numeric(14,3) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (shipment_id, so_line_id)
);

create table public.load_pattern (
  id uuid primary key default gen_random_uuid(),
  signature text not null unique,       -- canonical "sku:pallets|sku:pallets"
  lines jsonb not null,
  total_kg numeric(14,3) not null,
  times_used int not null default 0,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.truck_load (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null unique references public.shipment (id) on delete cascade,   -- one row per truck
  pattern_id uuid references public.load_pattern (id),
  planned_kg numeric(14,3),
  actual_kg numeric(14,3),
  window_ok boolean,
  override_by uuid,
  override_reason text,
  override_approval_id uuid,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.truck_load_line (
  id uuid primary key default gen_random_uuid(),
  truck_load_id uuid not null references public.truck_load (id) on delete cascade,
  item_id uuid not null references public.item (id),
  lot_id uuid references public.lot (id),
  pallets numeric(14,3) not null,
  kg numeric(14,3),
  kg_source text,                       -- which level of the weight chain supplied kg (§3.8)
  actual boolean not null default false,-- false = planned line, true = loaded
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Work queue shared by the floor app and the back office.
create table public.task (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('receive','qc','putaway','pick','load','count','transfer','replenish',
                                     'rotate_recall','master_data','finance','count_request','consolidate')),
  priority int not null default 3,
  state text not null default 'open' check (state in ('open','in_progress','done','cancelled')),
  assigned_to uuid references public.app_user (id),
  assigned_role text,
  shipment_id uuid references public.shipment (id) on delete cascade,
  reservation_id uuid,
  location_id uuid references public.location (id),
  to_location_id uuid references public.location (id),
  item_id uuid references public.item (id),
  lot_id uuid references public.lot (id),
  pallet_id uuid references public.pallet (id),
  party_id uuid references public.party (id),
  qty_base numeric(14,3),
  payload jsonb not null default '{}'::jsonb,
  due_at timestamptz,
  done_at timestamptz,
  done_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index task_open_idx on public.task (type, priority, created_at) where state in ('open','in_progress');
create index task_shipment_idx on public.task (shipment_id);

select app.track(t) from unnest(array[
  'public.sales_order','public.so_line','public.shipment','public.shipment_line',
  'public.load_pattern','public.truck_load','public.truck_load_line']::regclass[]) t;
create trigger trg_touch before update on public.task for each row execute function app.touch();

-- Sales reps act only for their own dealers (§12.1).
create or replace function app.rep_can(p_party uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.user_role() is distinct from 'sales_rep'
      or exists (select 1 from rep_dealer rd where rd.user_id = auth.uid() and rd.party_id = p_party)
$$;

-- ---------------------------------------------------------------------------
-- Available-to-promise (§7.3): weekly buckets for 26 weeks.
-- ATP(w) = available on hand eligible for this customer's MRSL
--        + receipts expected by week w - hard reservations - soft reservations with need date <= w
-- ---------------------------------------------------------------------------
create or replace function app.atp_rows(
  p_item uuid, p_party uuid default null, p_exclude_line uuid default null, p_campaign uuid default null)
returns table (week_start date, eligible numeric, receipts numeric, hard numeric, soft numeric, atp numeric)
language sql stable security definer set search_path = public, app as $$
  with p as (
    select coalesce(app.param_num('mrsl_days', jsonb_build_object('party_id', p_party, 'item_id', p_item)), 0) as mrsl,
           app.today() as today
  ), weeks as (
    select app.week_start((select today from p)) + n * 7 as wk from generate_series(0, 25) n
  )
  select w.wk,
    (select coalesce(sum(s.qty_base), 0) from v_central_stock s
      where s.item_id = p_item and coalesce(s.band, 'green') not in ('red','blocked')
        and (s.expiry_date is null or s.expiry_date - greatest(w.wk, (select today from p)) >= (select mrsl from p))),
    (select coalesce(sum(e.qty_base), 0) from v_expected_receipt e
      where e.item_id = p_item and e.expected_date < w.wk + 7),
    (select coalesce(sum(r.qty_base), 0) from reservation r
      where r.item_id = p_item and r.state = 'active' and r.type = 'hard'
        and r.demand_line_id is distinct from p_exclude_line),
    (select coalesce(sum(r.qty_base), 0) from reservation r
      where r.item_id = p_item and r.state = 'active' and r.type = 'soft'
        and (r.expires_at is null or r.expires_at > now())
        and (r.need_date is null or r.need_date < w.wk + 7)
        and r.demand_line_id is distinct from p_exclude_line
        and not (r.demand_line_id is null and p_campaign is not null and r.campaign_id = p_campaign)),
    0::numeric
  from weeks w
$$;

create or replace function public.rpc_atp(p_item uuid, p_party uuid default null) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'week_start', week_start, 'eligible_on_hand', eligible, 'receipts_cum', receipts,
    'hard', hard, 'soft_cum', soft, 'atp', eligible + receipts - hard - soft) order by week_start), '[]'::jsonb)
  from app.atp_rows(p_item, p_party)
  where app.user_role() is not null
$$;

-- Promise date for one line: first week where cumulative ATP covers it. From phase 3,
-- capable-to-promise adds unplanned production up to capacity_calendar. The supply rows
-- relied on are returned so a late receipt can flag the affected orders.
create or replace function app.promise(
  p_item uuid, p_party uuid, p_qty numeric, p_requested date,
  p_exclude_line uuid default null, p_campaign uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
declare
  r record;
  v_today date := app.today();
  v_best numeric := 0;
  v_date date;
  v_basis jsonb := '[]'::jsonb;
  v_item item;
  v_upp numeric;
  v_short numeric;
  v_cum numeric := 0;
  v_lt int;
  c record;
begin
  for r in select * from app.atp_rows(p_item, p_party, p_exclude_line, p_campaign) order by week_start loop
    v_best := greatest(v_best, r.eligible + r.receipts - r.hard - r.soft);
    if r.eligible + r.receipts - r.hard - r.soft >= p_qty and r.week_start + 6 >= p_requested then
      v_date := greatest(p_requested, r.week_start, v_today);
      if r.eligible - r.hard - r.soft < p_qty then
        select coalesce(jsonb_agg(jsonb_build_object('type', e.source_type, 'id', e.source_id, 'doc_no', e.doc_no,
                 'qty', e.qty_base, 'expected_date', e.expected_date)), '[]'::jsonb)
          into v_basis from v_expected_receipt e where e.item_id = p_item and e.expected_date < r.week_start + 7;
        v_date := greatest(v_date, (select max(e.expected_date) from v_expected_receipt e
                                     where e.item_id = p_item and e.expected_date < r.week_start + 7));
      end if;
      return jsonb_build_object('promised_date', v_date, 'method', 'atp', 'basis', v_basis);
    end if;
  end loop;

  -- capable-to-promise: unplanned production up to free line capacity
  select * into v_item from item where id = p_item;
  v_upp := coalesce(app.units_per_pallet(p_item), 1);
  v_short := p_qty - greatest(v_best, 0);
  if v_item.production_line is not null then
    v_lt := coalesce(app.param_num('production_lt_days', jsonb_build_object('item_id', p_item)), 21)::int;
    for c in
      select cc.date, cc.pallets_per_day - coalesce((
               select sum(po.qty / nullif(app.units_per_pallet(po.item_id), 0)
                          / greatest(1, po.planned_finish - po.planned_start + 1))
                 from production_order po
                where po.line = cc.line and po.state in ('planned','in_progress')
                  and cc.date between po.planned_start and po.planned_finish), 0) as free_pallets
        from capacity_calendar cc
       where cc.line = v_item.production_line and cc.date >= v_today + v_lt
       order by cc.date
    loop
      v_cum := v_cum + greatest(c.free_pallets, 0);
      if v_cum * v_upp >= v_short then
        return jsonb_build_object('promised_date', greatest(c.date, p_requested), 'method', 'ctp',
          'basis', jsonb_build_array(jsonb_build_object('type', 'capacity', 'line', v_item.production_line,
                                                        'date', c.date, 'pallets', ceil(v_short / v_upp))));
      end if;
    end loop;
  end if;

  -- last resort: quoted lead time of the item's supply lane
  select coalesce(max(sl.quoted_lt_days), 60)::int into v_lt from supplier_lane sl
   where sl.active and (sl.item_id = p_item or sl.item_family_id = v_item.family_id);
  return jsonb_build_object('promised_date', greatest(p_requested, v_today + v_lt), 'method', 'lead_time',
    'basis', jsonb_build_array(jsonb_build_object('type', 'quoted_lead_time', 'days', v_lt)));
end $$;

-- ---------------------------------------------------------------------------
-- Order intake (§7.1)
-- ---------------------------------------------------------------------------
-- Save a draft order. Lines arrive already exploded by the mechanic's explode function
-- (free and bundle_component lines carry parent_ref = the parent's ref).
create or replace function public.rpc_save_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_party uuid := (p->>'party_id')::uuid;
  v_order sales_order;
  v_line jsonb;
  v_no int := 0;
  v_new uuid;
  v_refs jsonb := '{}'::jsonb;
  v_item item;
  v_qty numeric;
  v_phantom boolean;
begin
  perform app.require_role('planner','sales_rep','ops_manager','owner');
  if not app.rep_can(v_party) then perform app.fail('NOT_PERMITTED', 'not your dealer'); end if;
  if v_id is not null then
    select * into v_order from sales_order where id = v_id for update;
    if v_order.id is null then perform app.fail('NOT_FOUND', 'order'); end if;
    if v_order.state <> 'draft' then perform app.fail('INVALID_STATE', 'only draft orders can be edited'); end if;
    update sales_order set
      party_id = v_party,
      market_id = coalesce((p->>'market_id')::uuid, (select market_id from party where id = v_party)),
      requested_date = (p->>'requested_date')::date,
      priority_tier = (p->>'priority_tier')::int,
      campaign_id = (p->>'campaign_id')::uuid,
      order_type = coalesce(p->>'order_type', 'standard'),
      forward_buy = coalesce((p->>'forward_buy')::boolean, false),
      schedule = nullif(p->'schedule', 'null'::jsonb),
      vehicle_type_id = (p->>'vehicle_type_id')::uuid,
      logo_doc_no = p->>'logo_doc_no',
      note = p->>'note'
    where id = v_id;
    delete from so_line where order_id = v_id;
  else
    insert into sales_order (party_id, market_id, requested_date, priority_tier, campaign_id, order_type,
                             forward_buy, schedule, vehicle_type_id, logo_doc_no, note, created_by)
    values (v_party, coalesce((p->>'market_id')::uuid, (select market_id from party where id = v_party)),
            (p->>'requested_date')::date, (p->>'priority_tier')::int, (p->>'campaign_id')::uuid,
            coalesce(p->>'order_type', 'standard'), coalesce((p->>'forward_buy')::boolean, false),
            nullif(p->'schedule', 'null'::jsonb), (p->>'vehicle_type_id')::uuid, p->>'logo_doc_no', p->>'note', app.uid())
    returning id into v_id;
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    v_no := v_no + 1;
    select * into v_item from item where id = (v_line->>'item_id')::uuid;
    if v_item.id is null then perform app.fail('UNKNOWN_ITEM', coalesce(v_line->>'item_id', '')); end if;
    v_qty := app.to_base(v_item.id, (v_line->>'qty')::numeric, coalesce(v_line->>'uom', v_item.base_uom));
    v_phantom := coalesce((v_line->>'is_phantom')::boolean, false);
    if not v_phantom and to_regclass('public.bundle') is not null then
      execute 'select exists (select 1 from public.bundle where item_id = $1 and kind = ''phantom'' and active)'
        into v_phantom using v_item.id;
    end if;
    if coalesce(v_line->>'line_type', 'paid') = 'paid' and not v_item.sellable then
      perform app.fail('NOT_SELLABLE', format('%s is not a sellable item', v_item.sku));
    end if;
    insert into so_line (order_id, line_no, item_id, qty, uom, qty_entered, line_type, parent_line_id,
                         is_phantom, bundle_id, mechanic_code, terms, created_by)
    values (v_id, v_no, v_item.id, v_qty, coalesce(v_line->>'uom', v_item.base_uom), (v_line->>'qty')::numeric,
            coalesce(v_line->>'line_type', 'paid'),
            (v_refs->>(v_line->>'parent_ref'))::uuid,
            v_phantom, (v_line->>'bundle_id')::uuid, v_line->>'mechanic_code', v_line->'terms', app.uid())
    returning id into v_new;
    if v_line ? 'ref' then
      v_refs := v_refs || jsonb_build_object(v_line->>'ref', v_new);
    end if;
  end loop;
  return jsonb_build_object('order_id', v_id, 'lines', v_no);
end $$;

-- Create one shipment + truck for a set of order lines.
create or replace function app.create_shipment(p_order uuid, p_date date, p_lines jsonb default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare
  v_order sales_order;
  v_ship uuid;
  v_truck uuid;
  v_kg numeric := 0;
  r record;
  v_w jsonb;
begin
  select * into v_order from sales_order where id = p_order;
  insert into shipment (party_id, planned_date, vehicle_type_id, created_by)
  values (v_order.party_id, p_date,
          coalesce(v_order.vehicle_type_id, (select id from vehicle_type where is_default limit 1)), app.uid())
  returning id into v_ship;
  insert into truck_load (shipment_id, created_by) values (v_ship, app.uid()) returning id into v_truck;
  for r in
    select l.id as so_line_id, l.item_id,
           coalesce((select (x->>'qty_base')::numeric from jsonb_array_elements(p_lines) x
                      where (x->>'so_line_id')::uuid = l.id), case when p_lines is null then l.qty end) as qty
      from so_line l where l.order_id = p_order and not l.is_phantom
  loop
    continue when r.qty is null or r.qty <= 0;
    insert into shipment_line (shipment_id, so_line_id, qty_base, created_by) values (v_ship, r.so_line_id, r.qty, app.uid());
    v_w := app.pallet_kg(r.item_id);
    insert into truck_load_line (truck_load_id, item_id, pallets, kg, kg_source, created_by)
    values (v_truck, r.item_id, round(r.qty / nullif(app.units_per_pallet(r.item_id), 0), 3),
            round(r.qty / nullif(app.units_per_pallet(r.item_id), 0) * (v_w->>'kg')::numeric, 3), v_w->>'level', app.uid());
    v_kg := v_kg + coalesce(r.qty / nullif(app.units_per_pallet(r.item_id), 0) * (v_w->>'kg')::numeric, 0);
  end loop;
  update truck_load set planned_kg = round(v_kg, 3) where id = v_truck;
  return v_ship;
end $$;

-- Confirm: soft reservations + promised date per line, planned shipment(s).
create or replace function public.rpc_confirm_order(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_order sales_order;
  v_party party;
  r record;
  v_promise jsonb;
  v_tier int;
  v_ship uuid;
  v_max date;
  v_left numeric;
  v_ring record;
begin
  perform app.require_role('planner','sales_rep','ops_manager','owner');
  perform pg_advisory_xact_lock(hashtext('dayson_atp'));
  select * into v_order from sales_order where id = p_order for update;
  if v_order.id is null then perform app.fail('NOT_FOUND', 'order'); end if;
  if not app.rep_can(v_order.party_id) then perform app.fail('NOT_PERMITTED', 'not your dealer'); end if;
  if v_order.state <> 'draft' then perform app.fail('INVALID_STATE', 'order is not a draft'); end if;
  if not exists (select 1 from so_line where order_id = p_order) then perform app.fail('INVALID', 'order has no lines'); end if;
  select * into v_party from party where id = v_order.party_id;

  -- priority tier (§7.4): 1 export contracts, 2 committed campaign orders from A dealers,
  -- 3 other dealer orders, 4 forward-buy
  v_tier := coalesce(v_order.priority_tier, v_party.priority_tier,
    case when v_order.order_type = 'export_contract' then 1
         when v_order.forward_buy then 4
         when v_order.campaign_id is not null and v_party.segment = 'A' then 2
         else 3 end);

  for r in select * from so_line where order_id = p_order and not is_phantom order by line_no loop
    v_promise := app.promise(r.item_id, v_order.party_id, r.qty, v_order.requested_date, r.id, v_order.campaign_id);
    update so_line set promised_date = (v_promise->>'promised_date')::date, promise_basis = v_promise where id = r.id;
    insert into reservation (demand_line_id, party_id, item_id, qty_base, original_qty, type, campaign_id, need_date, created_by)
    values (r.id, v_order.party_id, r.item_id, r.qty, r.qty, 'soft', v_order.campaign_id,
            (v_promise->>'promised_date')::date, app.uid());
    -- an order inside a campaign draws down that campaign's ring-fence
    if v_order.campaign_id is not null then
      v_left := r.qty;
      for v_ring in select * from reservation where campaign_id = v_order.campaign_id and demand_line_id is null
                      and item_id = r.item_id and state = 'active' and type = 'soft' order by created_at for update loop
        exit when v_left <= 0;
        update reservation set qty_base = greatest(qty_base - v_left, 0),
               state = case when qty_base - v_left <= 0 then 'consumed' else state end where id = v_ring.id;
        v_left := v_left - v_ring.qty_base;
      end loop;
    end if;
  end loop;

  update sales_order set state = 'confirmed', priority_tier = v_tier, confirmed_at = now() where id = p_order;

  if v_order.schedule is not null and to_regclass('public.job_queue') is not null then
    -- large orders: the load planner splits the schedule into one planned shipment per truck
    execute 'insert into public.job_queue (kind, payload, requested_by) values (''plan_trucks'', $1, $2)'
      using jsonb_build_object('order_id', p_order), app.uid();
  else
    select max(promised_date) into v_max from so_line where order_id = p_order and not is_phantom;
    v_ship := app.create_shipment(p_order, coalesce(v_max, v_order.requested_date));
    update reservation set shipment_id = v_ship
     where demand_line_id in (select id from so_line where order_id = p_order) and state = 'active';
  end if;
  return jsonb_build_object('order_id', p_order, 'tier', v_tier, 'shipment_id', v_ship,
    'lines', (select jsonb_agg(jsonb_build_object('line_id', id, 'promised_date', promised_date, 'promise', promise_basis)
                               order by line_no) from so_line where order_id = p_order));
end $$;

create or replace function public.rpc_cancel_order(p_order uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_order sales_order;
begin
  perform app.require_role('planner','sales_rep','ops_manager','owner');
  select * into v_order from sales_order where id = p_order for update;
  if v_order.id is null then perform app.fail('NOT_FOUND', 'order'); end if;
  if not app.rep_can(v_order.party_id) then perform app.fail('NOT_PERMITTED', 'not your dealer'); end if;
  if v_order.state in ('picking','shipped','closed') then
    perform app.fail('INVALID_STATE', 'picked or shipped orders cannot be cancelled');
  end if;
  update reservation set state = 'released'
   where demand_line_id in (select id from so_line where order_id = p_order) and state = 'active';
  update task set state = 'cancelled'
   where state in ('open','in_progress') and shipment_id in (
     select sl.shipment_id from shipment_line sl join so_line l on l.id = sl.so_line_id where l.order_id = p_order);
  delete from shipment_line where so_line_id in (select id from so_line where order_id = p_order);
  update shipment s set state = 'cancelled'
   where s.state in ('planned','allocated') and not exists (select 1 from shipment_line sl where sl.shipment_id = s.id);
  update sales_order set state = 'cancelled', note = coalesce(note || ' | ', '') || coalesce(p_reason, 'cancelled') where id = p_order;
  return jsonb_build_object('order_id', p_order, 'state', 'cancelled');
end $$;

-- Apply a truck plan produced by the load planner (§7.5): one planned shipment per truck,
-- each with its share of the order's soft reservations.
-- plan = {"trucks":[{"planned_date":"..","signature":"..","total_kg":n,
--                    "lines":[{"item_id":"..","pallets":n,"kg":n}]}], "remainder":[..]}
create or replace function public.rpc_apply_truck_plan(p_order uuid, p_plan jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_order sales_order;
  v_truck jsonb; v_tl jsonb;
  v_ship uuid; v_tload uuid; v_pattern uuid;
  v_count int := 0;
  v_line so_line;
  v_qty numeric; v_take numeric; v_left numeric;
  v_res reservation;
begin
  perform app.require_role('planner','ops_manager','owner');
  select * into v_order from sales_order where id = p_order for update;
  if v_order.id is null then perform app.fail('NOT_FOUND', 'order'); end if;
  if v_order.state not in ('confirmed','allocated') then perform app.fail('INVALID_STATE', 'order must be confirmed'); end if;
  if exists (select 1 from reservation r join so_line l on l.id = r.demand_line_id
              where l.order_id = p_order and r.type = 'hard' and r.state in ('active','consumed')) then
    perform app.fail('INVALID_STATE', 'order already has allocated stock; it cannot be re-planned');
  end if;
  -- drop earlier planned shipments of this order and fold reservations back to one per line
  delete from shipment where id in (
    select sl.shipment_id from shipment_line sl join so_line l on l.id = sl.so_line_id where l.order_id = p_order)
    and state = 'planned';
  delete from reservation where demand_line_id in (select id from so_line where order_id = p_order)
    and type = 'soft' and state = 'active';

  for v_truck in select * from jsonb_array_elements(p_plan->'trucks') loop
    v_count := v_count + 1;
    insert into load_pattern (signature, lines, total_kg, times_used, created_by)
    values (v_truck->>'signature', v_truck->'lines', (v_truck->>'total_kg')::numeric, 1, app.uid())
    on conflict (signature) do update set times_used = load_pattern.times_used + 1
    returning id into v_pattern;
    insert into shipment (party_id, planned_date, vehicle_type_id, created_by)
    values (v_order.party_id, coalesce((v_truck->>'planned_date')::date, v_order.requested_date),
            coalesce(v_order.vehicle_type_id, (select id from vehicle_type where is_default limit 1)), app.uid())
    returning id into v_ship;
    insert into truck_load (shipment_id, pattern_id, planned_kg, created_by)
    values (v_ship, v_pattern, (v_truck->>'total_kg')::numeric, app.uid()) returning id into v_tload;
    for v_tl in select * from jsonb_array_elements(v_truck->'lines') loop
      insert into truck_load_line (truck_load_id, item_id, pallets, kg, kg_source, created_by)
      values (v_tload, (v_tl->>'item_id')::uuid, (v_tl->>'pallets')::numeric, (v_tl->>'kg')::numeric,
              coalesce(v_tl->>'kg_source', 'item'), app.uid());
      -- spread this truck's quantity over the order's lines for that item
      v_left := (v_tl->>'pallets')::numeric * coalesce(app.units_per_pallet((v_tl->>'item_id')::uuid), 1);
      for v_line in select l.* from so_line l where l.order_id = p_order and l.item_id = (v_tl->>'item_id')::uuid
                     and not l.is_phantom order by l.line_no loop
        exit when v_left <= 0;
        v_qty := v_line.qty - coalesce((select sum(sl.qty_base) from shipment_line sl where sl.so_line_id = v_line.id), 0);
        continue when v_qty <= 0;
        v_take := least(v_qty, v_left);
        insert into shipment_line (shipment_id, so_line_id, qty_base, created_by) values (v_ship, v_line.id, v_take, app.uid())
        on conflict (shipment_id, so_line_id) do update set qty_base = shipment_line.qty_base + excluded.qty_base;
        insert into reservation (demand_line_id, shipment_id, party_id, item_id, qty_base, original_qty, type,
                                 campaign_id, need_date, created_by)
        values (v_line.id, v_ship, v_order.party_id, v_line.item_id, v_take, v_take, 'soft', v_order.campaign_id,
                coalesce((v_truck->>'planned_date')::date, v_order.requested_date), app.uid());
        v_left := v_left - v_take;
      end loop;
    end loop;
  end loop;

  -- anything the planner could not place on a valid truck stays reserved as a remainder
  for v_line in select l.* from so_line l where l.order_id = p_order and not l.is_phantom loop
    v_qty := v_line.qty - coalesce((select sum(sl.qty_base) from shipment_line sl where sl.so_line_id = v_line.id), 0);
    if v_qty > 0 then
      insert into reservation (demand_line_id, party_id, item_id, qty_base, original_qty, type, campaign_id, need_date, created_by)
      values (v_line.id, v_order.party_id, v_line.item_id, v_qty, v_qty, 'soft', v_order.campaign_id, v_line.promised_date, app.uid());
    end if;
  end loop;
  return jsonb_build_object('order_id', p_order, 'trucks', v_count, 'remainder', coalesce(p_plan->'remainder', '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Allocation (§7.4): soft -> hard for shipments inside the release horizon.
--   1. sort demand by priority tier, then promised date
--   2. FEFO among lots passing the customer's MRSL; prefer lots that empty a lane
--   3. short supply inside a tier is shared pro rata to ordered quantity, in whole
--      pallets by largest remainder; higher tiers are filled completely first
--   4. unfilled quantity stays as a backorder with a new promise date
-- ---------------------------------------------------------------------------
create or replace function public.rpc_allocate(p_shipment uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_horizon date := app.add_working_days(app.today(), coalesce(app.param_num('release_horizon_working_days'), 5)::int);
  v_rule text := coalesce(app.param_text('allocation_sharing_rule'), 'ordered');
  v_item uuid; v_tier int;
  v_upp numeric; v_unit numeric;
  v_supply numeric; v_need numeric; v_units numeric; v_given numeric; v_wsum numeric;
  d record; f record;
  v_left numeric; v_take numeric;
  v_hard int := 0; v_back int := 0;
  v_promise jsonb;
  v_res uuid;
begin
  perform app.require_role('planner','ops_manager','owner');
  perform pg_advisory_xact_lock(hashtext('dayson_atp'));

  create temp table _dem on commit drop as
  select r.id as res_id, r.demand_line_id, r.shipment_id, r.item_id, r.qty_base as need, 0::numeric as allot,
         0::numeric as share_raw, coalesce(o.priority_tier, 3) as tier, l.promised_date, o.party_id, s.planned_date,
         l.qty as weight, o.campaign_id, o.id as order_id, r.created_at,
         coalesce(app.param_num('mrsl_days', jsonb_build_object('party_id', o.party_id, 'item_id', r.item_id, 'shipment_id', s.id)), 0) as mrsl
    from reservation r
    join shipment s on s.id = r.shipment_id
    join so_line l on l.id = r.demand_line_id
    join sales_order o on o.id = l.order_id
   where r.type = 'soft' and r.state = 'active' and r.qty_base > 0
     and s.state in ('planned','allocated','picking')
     and ((p_shipment is null and s.planned_date <= v_horizon) or s.id = p_shipment);

  if v_rule = 'trailing_90d' then
    update _dem d set weight = greatest(coalesce((
      select sum(sl.shipped_qty) from shipment_line sl
        join so_line l on l.id = sl.so_line_id join sales_order o on o.id = l.order_id
        join shipment s on s.id = sl.shipment_id
       where o.party_id = d.party_id and l.item_id = d.item_id and s.dispatched_at > now() - interval '90 days'), 0), 0);
    update _dem d set weight = need where not exists (select 1 from _dem x where x.item_id = d.item_id and x.tier = d.tier and x.weight > 0);
  end if;

  for v_item in select distinct item_id from _dem loop
    v_upp := app.units_per_pallet(v_item);
    for v_tier in select distinct tier from _dem where item_id = v_item order by tier loop
      select coalesce(sum(need), 0), coalesce(sum(weight), 0) into v_need, v_wsum from _dem where item_id = v_item and tier = v_tier;
      -- supply still free after higher tiers, eligible for at least one demand of this tier
      select coalesce(sum(greatest(fr.free_qty, 0)), 0) into v_supply from v_lot_free fr
       where fr.item_id = v_item and coalesce(fr.band, 'green') not in ('red','blocked')
         and exists (select 1 from _dem x where x.item_id = v_item and x.tier = v_tier
                      and (fr.expiry_date is null or fr.expiry_date - x.planned_date >= x.mrsl));
      if v_need <= v_supply then
        update _dem set allot = need where item_id = v_item and tier = v_tier;
      elsif v_supply > 0 then
        -- shortage: pro rata in whole pallets, largest remainder
        v_unit := case when v_upp is not null and v_upp > 1
                        and not exists (select 1 from _dem where item_id = v_item and tier = v_tier and need < v_upp)
                       then v_upp else 1 end;
        v_units := floor(v_supply / v_unit);
        update _dem set share_raw = v_units * weight / nullif(v_wsum, 0) where item_id = v_item and tier = v_tier;
        update _dem set allot = least(floor(share_raw) * v_unit, need) where item_id = v_item and tier = v_tier;
        select coalesce(sum(allot), 0) into v_given from _dem where item_id = v_item and tier = v_tier;
        loop
          exit when v_units * v_unit - v_given < v_unit;
          select * into d from _dem where item_id = v_item and tier = v_tier and allot < need
           order by (share_raw - floor(share_raw)) desc, promised_date nulls last, created_at limit 1;
          exit when d.res_id is null;
          v_take := least(v_unit, d.need - d.allot);
          update _dem set allot = allot + v_take, share_raw = floor(share_raw) where res_id = d.res_id;
          v_given := v_given + v_take;
        end loop;
      end if;

      for d in select * from _dem where item_id = v_item and tier = v_tier and allot > 0
                order by promised_date nulls last, created_at loop
        v_left := d.allot;
        for f in
          select fr.* from v_lot_free fr
           where fr.item_id = v_item and fr.free_qty > 0 and coalesce(fr.band, 'green') not in ('red','blocked')
             and (fr.expiry_date is null or fr.expiry_date - d.planned_date >= d.mrsl)
           order by fr.expiry_date nulls last, (fr.free_qty <= v_left) desc, fr.free_qty, fr.location_code
        loop
          exit when v_left <= 0;
          v_take := least(f.free_qty, v_left);
          insert into reservation (demand_line_id, shipment_id, party_id, item_id, lot_id, location_id, qty_base,
                                   original_qty, type, campaign_id, need_date, created_by)
          values (d.demand_line_id, d.shipment_id, d.party_id, v_item, f.lot_id, f.location_id, v_take, v_take,
                  'hard', d.campaign_id, d.planned_date, app.uid())
          returning id into v_res;
          insert into task (type, priority, shipment_id, reservation_id, location_id, item_id, lot_id, party_id, qty_base, assigned_role, created_by)
          values ('pick', d.tier, d.shipment_id, v_res, f.location_id, v_item, f.lot_id, d.party_id, v_take, 'operator', app.uid());
          update reservation set qty_base = qty_base - v_take,
                 state = case when qty_base - v_take <= 0 then 'consumed' else state end
           where id = d.res_id;
          v_left := v_left - v_take;
          v_hard := v_hard + 1;
        end loop;
      end loop;
    end loop;
  end loop;

  -- backorders: new promise date, never cancelled automatically
  for d in select dm.*, r.qty_base as still from _dem dm join reservation r on r.id = dm.res_id
            where r.state = 'active' and r.qty_base > 0 loop
    v_promise := app.promise(d.item_id, d.party_id, d.still, greatest(app.today(), d.planned_date), d.demand_line_id, d.campaign_id);
    update so_line set backorder = true, promised_date = (v_promise->>'promised_date')::date,
           promise_basis = v_promise where id = d.demand_line_id;
    update reservation set need_date = (v_promise->>'promised_date')::date where id = d.res_id;
    v_back := v_back + 1;
  end loop;

  update shipment s set state = 'allocated'
   where s.state = 'planned' and exists (
     select 1 from reservation r where r.shipment_id = s.id and r.type = 'hard' and r.state = 'active');
  update sales_order o set state = 'allocated'
   where o.state = 'confirmed' and exists (
     select 1 from so_line l join reservation r on r.demand_line_id = l.id
      where l.order_id = o.id and r.type = 'hard' and r.state = 'active');
  return jsonb_build_object('hard_reservations', v_hard, 'backorders', v_back, 'horizon', v_horizon);
end $$;

-- Shipments with their truck, weights and progress, for the planning and loading screens.
create or replace view public.v_shipment as
select s.id, s.shipment_no, s.party_id, p.name as party_name, s.planned_date, s.state, s.e_irsaliye_no, s.seal_no,
       s.vehicle_type_id, s.vehicle_ref, s.dispatched_at, s.invoice_doc_no,
       tl.id as truck_load_id, tl.planned_kg, tl.actual_kg, tl.window_ok, tl.override_by, tl.pattern_id,
       (select count(*) from public.pallet pa where pa.shipment_id = s.id) as pallets_picked,
       (select count(*) from public.pallet pa where pa.shipment_id = s.id and pa.loaded_at is not null) as pallets_loaded,
       (select coalesce(sum(r.qty_base), 0) from public.reservation r where r.shipment_id = s.id and r.state = 'active' and r.type = 'hard') as qty_to_pick,
       (select coalesce(sum(r.qty_base), 0) from public.reservation r where r.shipment_id = s.id and r.state = 'active' and r.type = 'soft') as qty_backorder
from public.shipment s
join public.party p on p.id = s.party_id
left join public.truck_load tl on tl.shipment_id = s.id;
