-- LOCAL / CI ONLY: fixtures and helpers shared by the pgTAP tests.
create schema if not exists test;
grant usage on schema test to authenticated, service_role, anon;

create or replace function test.mk_user(p_role text, p_name text default null) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, v_id || '@test.local');
  insert into public.app_user (id, full_name, role) values (v_id, coalesce(p_name, p_role), p_role);
  return v_id;
end $$;

-- Act as a signed-in user, the way PostgREST does.
create or replace function test.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function test.as_system() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant execute on all functions in schema test to authenticated, service_role, anon;

create or replace function test.id(p_table text, p_col text, p_val text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  execute format('select id from public.%I where %I = $1', p_table, p_col) into v using p_val;
  return v;
end $$;

-- Minimal warehouse: one expiry-controlled sealant (1200 per pallet, 598 kg), one tape
-- without expiry, docks, lanes, staging, a pick face, dealers and a default truck.
create or replace function test.base() returns void
language plpgsql as $$
declare v_fam uuid; v_tr uuid; v_de uuid; v_site uuid;
begin
  insert into public.site (code, name) values ('TZ', 'Tuzla') returning id into v_site;
  insert into public.market (code, name, is_domestic) values ('TR', 'Türkiye', true) returning id into v_tr;
  insert into public.market (code, name, is_domestic) values ('DE', 'Almanya', false) returning id into v_de;
  insert into public.planning_param (scope_type, scope_id, param, value) values ('market', v_de::text, 'mrsl_days', '240');
  insert into public.item_family (code, name, shelf_life_days) values ('SEAL', 'Mastik', 365) returning id into v_fam;
  insert into public.item (sku, name, gtin, family_id, lot_expiry_controlled, shelf_life_days, logo_item_code, production_line)
  values ('GRI', 'Gri Mastik', '08690000010010', v_fam, true, 365, 'L-GRI', 'MASTIK-1'),
         ('SIYAH', 'Siyah Mastik', '08690000010027', v_fam, true, 365, 'L-SIYAH', 'MASTIK-1');
  insert into public.item (sku, name, family_id, lot_expiry_controlled, logo_item_code)
  values ('BANT', 'Bant', v_fam, false, 'L-BANT');
  insert into public.uom_pack (item_id, level, qty_base, gross_kg, logo_unit)
  select i.id, v.level, v.qty, v.kg, v.lu from public.item i,
    (values ('carton', 24::numeric, null::numeric, 'KOLI'), ('pallet', 1200::numeric, 598::numeric, 'PALET')) v(level, qty, kg, lu);
  update public.uom_pack set gross_kg = 589 where level = 'pallet' and item_id = test.id('item', 'sku', 'SIYAH');
  insert into public.item_cost (item_id, cost_eur, as_of) select id, 2.0, current_date from public.item;
  insert into public.location (site_id, code, type) values
    (v_site, 'TZ-DOCK-01', 'dock'), (v_site, 'TZ-STG-01', 'staging'), (v_site, 'TZ-PF-01', 'pick_face');
  insert into public.location (site_id, code, type, depth_positions, max_stack_height)
  select v_site, 'TZ-B01-L' || lpad(n::text, 2, '0'), 'block_lane', 10, 5 from generate_series(1, 8) n;
  insert into public.vehicle_type (code, min_kg, max_kg, max_items, is_default) values ('TIR', 24900, 25075, 5, true);
  insert into public.party (type, name, logo_cari_code, segment, market_id) values
    ('dealer', 'Bayi A', 'D-A', 'A', v_tr), ('dealer', 'Bayi B', 'D-B', 'B', v_tr), ('dealer', 'Bayi C', 'D-C', 'B', v_tr),
    ('importer', 'Importer DE', 'I-DE', 'A', v_de), ('supplier', 'Tedarikçi', 'S-1', null, null);
  insert into public.plan_version (name, kind, state, published_at) values ('test plan', 'plan', 'published', now() - interval '1 hour');
end $$;

-- Put stock straight into a lane as available (opening balance), one pallet row per pallet.
create or replace function test.stock(p_sku text, p_lot text, p_expiry date, p_pallets int, p_lane text, p_kg numeric default null)
returns uuid language plpgsql as $$
declare v_lot uuid; v_item uuid := test.id('item', 'sku', p_sku); v jsonb;
begin
  for n in 1..p_pallets loop
    v := public.rpc_floor('opening_balance', jsonb_strip_nulls(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'item_id', v_item, 'lot_no', p_lot, 'expiry_date', p_expiry,
      'qty', 1, 'uom', 'pallet', 'to_location', p_lane, 'status', 'available', 'actual_pallet_kg', p_kg,
      'skip_weight', p_kg is null, 'scan_method', 'system')));
    if v ? 'error' then raise exception 'test.stock failed: %', v; end if;
  end loop;
  select id into v_lot from public.lot where item_id = v_item and lot_no = p_lot;
  return v_lot;
end $$;

create or replace function test.post(p_type text, p_line jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select public.post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', p_type,
                                            'lines', jsonb_build_array(p_line)) || p_extra)
$$;

create or replace function test.bal(p_sku text, p_loc text, p_status text default null) returns numeric
language sql as $$
  select coalesce(sum(b.qty_base), 0) from public.stock_balance b
   where b.item_id = test.id('item', 'sku', p_sku) and b.location_id = test.id('location', 'code', p_loc)
     and (p_status is null or b.stock_status = p_status)
$$;
grant execute on all functions in schema test to authenticated, service_role, anon;
