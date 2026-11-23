-- 0007 Warehouse floor (spec §5, §6): one idempotent command entry point, rpc_floor(cmd, args),
-- for everything the handheld app does. Each command carries a client_uuid; a repeated
-- client_uuid returns the first result, so the offline outbox can replay safely.

create table public.command_log (
  client_uuid uuid primary key,
  cmd text not null,
  args jsonb not null,
  result jsonb not null,
  user_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

-- Scan log (§6): every confirmation, scanned or typed, accepted or refused. Personal data
-- under KVKK: readable by owner and ops_manager only; retention is a parameter.
create table public.scan_event (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  device_id text,
  at timestamptz not null default now(),
  screen text,
  kind text,                                  -- source | pallet | destination | other
  method text not null check (method in ('scan','manual')),
  accepted boolean not null default true,
  raw text,
  parsed_class text,                          -- location | gs1 | pallet_serial | unknown
  reason_code text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index scan_event_user_idx on public.scan_event (user_id, at);

create table public.count_task (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.location (id),
  item_id uuid references public.item (id),
  lot_id uuid references public.lot (id),
  trigger text not null check (trigger in ('scheduled','lane_emptied','exception','lane_closing','visit')),
  assigned_to uuid references public.app_user (id),
  state text not null default 'open' check (state in ('open','recount','pending_approval','closed','cancelled')),
  expected_qty numeric(14,3),                 -- hidden from operators: counts are blind
  counted_qty numeric(14,3),
  counted_by uuid,
  counted_at timestamptz,
  recount_qty numeric(14,3),
  recount_by uuid,
  variance numeric(14,3),
  tolerance numeric(14,3),
  within_tolerance boolean,
  reason_code text,
  adjusted boolean not null default false,
  adjust_txn_id uuid,
  approval_id uuid,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index count_task_open_idx on public.count_task (location_id) where state in ('open','recount');
create trigger trg_touch before update on public.count_task for each row execute function app.touch();

create table public.count_result (
  id uuid primary key default gen_random_uuid(),
  count_task_id uuid not null references public.count_task (id) on delete cascade,
  seq int not null,
  counted_by uuid,
  qty numeric(14,3) not null,
  scan_method text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

-- Rows waiting to be written to the next Logo outbound file (§11.3).
create table public.export_row (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('shipment_confirm','receipts','adjustments','consignment_sales','campaign_settlement')),
  payload jsonb not null,
  ref_id text,
  export_batch_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index export_row_pending_idx on public.export_row (type) where export_batch_id is null;

create or replace function app.derive_uuid(p_base uuid, p_salt text) returns uuid
language sql immutable as $$ select md5(p_base::text || ':' || p_salt)::uuid $$;

-- ---------------------------------------------------------------------------
-- Put-away suggestion (§5.3): same item+lot lane with free depth; else an empty lane in
-- the item's zone whose depth class fits the lot, nearest the dock for A items; else any
-- empty lane.
-- ---------------------------------------------------------------------------
create or replace function app.suggest_putaway(p_item uuid, p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_loc record;
  v_item item;
  v_lot_pallets int;
  v_is_a boolean := false;
begin
  select * into v_item from item where id = p_item;
  select l.id, l.code into v_loc
    from location l
   where l.type = 'block_lane' and l.active and l.lane_item_id = p_item and l.lane_lot_id is not distinct from p_lot
     and (select count(*) from pallet p where p.location_id = l.id and p.status = 'active')
         < coalesce(l.depth_positions, 1) * coalesce(l.max_stack_height, v_item.max_stack_height, 1)
   order by l.code limit 1;
  if v_loc.id is not null then
    return jsonb_build_object('location_id', v_loc.id, 'location', v_loc.code, 'rule', 'same_lot_lane');
  end if;
  select count(*) into v_lot_pallets from pallet where lot_id = p_lot and status = 'active';
  if to_regclass('public.item_class') is not null then
    execute 'select exists (select 1 from public.item_class ic join public.classification_run cr on cr.id = ic.run_id
                             where cr.is_current and ic.item_id = $1 and ic.abc = ''A'')' into v_is_a using p_item;
  end if;
  select l.id, l.code into v_loc
    from location l
   where l.type = 'block_lane' and l.active and l.lane_item_id is null
     and not exists (select 1 from stock_balance b where b.location_id = l.id and b.qty_base > 0)
     and (v_item.zone is null or l.zone = v_item.zone)
   order by (coalesce(l.depth_positions, 1) * coalesce(l.max_stack_height, 1) >= greatest(v_lot_pallets, 1)) desc,
            abs(coalesce(l.depth_class, l.depth_positions, 0) - coalesce(v_item.depth_class, v_lot_pallets, 0)),
            case when v_is_a then coalesce(l.dock_distance, 9999) else 0 end,
            l.code
   limit 1;
  if v_loc.id is not null then
    return jsonb_build_object('location_id', v_loc.id, 'location', v_loc.code, 'rule', 'empty_lane_in_zone');
  end if;
  select l.id, l.code into v_loc
    from location l
   where l.type = 'block_lane' and l.active and l.lane_item_id is null
     and not exists (select 1 from stock_balance b where b.location_id = l.id and b.qty_base > 0)
   order by l.code limit 1;
  if v_loc.id is not null then
    return jsonb_build_object('location_id', v_loc.id, 'location', v_loc.code, 'rule', 'any_empty_lane');
  end if;
  return jsonb_build_object('location_id', null, 'location', null, 'rule', 'no_empty_lane');
end $$;

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------
create or replace function app.find_item(p jsonb) returns item
language plpgsql stable as $$
declare v item;
begin
  if p ? 'item_id' and p->>'item_id' is not null then
    select * into v from public.item where id = (p->>'item_id')::uuid;
  elsif p ? 'sku' then
    select * into v from public.item where sku = p->>'sku';
  elsif p ? 'gtin' then
    select * into v from public.item where gtin = p->>'gtin' or gtin = ltrim(p->>'gtin', '0');
  end if;
  if v.id is null then perform app.fail('UNKNOWN_ITEM', coalesce(p->>'sku', p->>'gtin', p->>'item_id', '')); end if;
  return v;
end $$;

-- Find or create the lot; a lot number that already exists with a different expiry is rejected.
create or replace function app.ensure_lot(p_item item, p jsonb) returns lot
language plpgsql security definer set search_path = public, app as $$
declare v lot;
begin
  if nullif(p->>'lot_no', '') is null then
    if p_item.lot_expiry_controlled then perform app.fail('LOT_REQUIRED', 'lot number is required'); end if;
    return null;
  end if;
  select * into v from lot where item_id = p_item.id and lot_no = p->>'lot_no';
  if v.id is not null then
    if (p->>'expiry_date') is not null and v.expiry_date is distinct from (p->>'expiry_date')::date then
      perform app.fail('LOT_EXPIRY_MISMATCH', format('lot %s already exists with expiry %s', v.lot_no, v.expiry_date));
    end if;
    return v;
  end if;
  insert into lot (item_id, lot_no, prod_date, expiry_date, supplier_lot, pack_config_id, created_by)
  values (p_item.id, p->>'lot_no', (p->>'prod_date')::date, (p->>'expiry_date')::date, p->>'supplier_lot',
          (p->>'pack_config_id')::uuid, app.uid())
  returning * into v;
  return v;
end $$;

create or replace function app.label_data(p_pallet uuid) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select jsonb_build_object(
    'serial', p.serial, 'sku', i.sku, 'name', i.name, 'gtin', i.gtin, 'lot_no', l.lot_no,
    'prod_date', l.prod_date, 'expiry_date', l.expiry_date, 'qty_base', p.qty_base, 'base_uom', i.base_uom,
    'kg', round(coalesce(p.actual_kg, (app.pallet_kg(p.item_id, p.lot_id, p.id)->>'kg')::numeric
                 * p.qty_base / nullif(app.units_per_pallet(p.item_id, p.lot_id), 0)), 1))
  from pallet p join item i on i.id = p.item_id left join lot l on l.id = p.lot_id where p.id = p_pallet
$$;

-- Mal Kabul (§5.2) and go-live opening balance.
create or replace function app.cmd_receive(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_client uuid := (a->>'client_uuid')::uuid;
  v_doc_type text := coalesce(a->>'doc_type', 'none');
  v_item item; v_lot lot;
  v_qty numeric; v_tol numeric;
  v_pol po_line; v_po purchase_order; v_pr production_order;
  v_txn_type text; v_from text;
  v_serial text; v_pallet uuid;
  v_res jsonb; v_first boolean;
  v_dock text := a->>'to_location';
  v_party uuid := (a->>'party_id')::uuid;
  v_sug jsonb;
begin
  if v_doc_type = 'po_line' then
    select * into v_pol from po_line where id = (a->>'doc_id')::uuid for update;
    if v_pol.id is null then perform app.fail('NOT_FOUND', 'purchase order line'); end if;
    select * into v_po from purchase_order where id = v_pol.po_id;
    select * into v_item from item where id = v_pol.item_id;
    v_txn_type := 'receipt_purchase';
  elsif v_doc_type = 'production_order' then
    select * into v_pr from production_order where id = (a->>'doc_id')::uuid for update;
    if v_pr.id is null then perform app.fail('NOT_FOUND', 'production order'); end if;
    select * into v_item from item where id = v_pr.item_id;
    v_txn_type := 'receipt_production';
  elsif v_doc_type = 'customer_return' then
    v_item := app.find_item(a); v_txn_type := 'customer_return';
  elsif v_doc_type = 'consign_return' then
    v_item := app.find_item(a); v_txn_type := 'consign_return';
    select code into v_from from location where type = 'consignment' and dealer_id = v_party;
    if v_from is null then perform app.fail('NOT_FOUND', 'consignment location of the dealer'); end if;
  elsif v_doc_type = 'opening_balance' then
    v_item := app.find_item(a); v_txn_type := 'opening_balance';
  else
    v_item := app.find_item(a); v_txn_type := 'receipt_purchase';
  end if;
  if a ? 'gtin' and v_item.gtin is not null and ltrim(a->>'gtin', '0') <> ltrim(v_item.gtin, '0') then
    perform app.fail('WRONG_ITEM', 'scanned item does not match the document');
  end if;

  v_lot := app.ensure_lot(v_item, a);
  v_qty := app.to_base(v_item.id, coalesce((a->>'qty')::numeric, 1), coalesce(a->>'uom', 'pallet'), v_lot.id);

  -- over-receipt above tolerance needs supervisor confirmation
  if v_doc_type in ('po_line','production_order') then
    v_tol := coalesce(app.param_num('over_receipt_tolerance_pct', jsonb_build_object('item_id', v_item.id)), 5) / 100.0;
    if (v_doc_type = 'po_line' and v_pol.received_qty + v_qty > v_pol.qty * (1 + v_tol))
       or (v_doc_type = 'production_order' and v_pr.received_qty + v_qty > v_pr.qty * (1 + v_tol)) then
      if not app.has_role('ops_manager','owner')
         and not exists (select 1 from approval_request ar where ar.id = (a->>'approval_id')::uuid
                          and ar.type = 'over_receipt' and ar.state = 'approved') then
        perform app.fail('APPROVAL_REQUIRED', 'over-receipt above tolerance needs supervisor confirmation');
      end if;
    end if;
  end if;

  -- first pallet of each lot: the weighed pallet kg is stored on the lot
  if v_lot.id is not null then
    v_first := not exists (select 1 from pallet where lot_id = v_lot.id);
    if v_lot.actual_pallet_kg is null and (a->>'actual_pallet_kg') is not null then
      update lot set actual_pallet_kg = (a->>'actual_pallet_kg')::numeric where id = v_lot.id;
    elsif v_first and v_lot.actual_pallet_kg is null and coalesce(a->>'uom', 'pallet') = 'pallet'
          and v_doc_type in ('po_line','production_order','opening_balance')
          and not coalesce((a->>'skip_weight')::boolean, false) then
      perform app.fail('WEIGHT_REQUIRED', 'enter the weighed kg for the first pallet of this lot');
    end if;
  end if;

  v_serial := coalesce(nullif(a->>'pallet_serial', ''), app.next_pallet_serial(app.param_text('sscc_company_prefix')));
  if exists (select 1 from pallet where serial = v_serial) then
    perform app.fail('DUPLICATE_PALLET', format('pallet %s already exists', v_serial));
  end if;
  insert into pallet (serial, item_id, lot_id, qty_base, location_id, actual_kg, created_by)
  values (v_serial, v_item.id, v_lot.id, v_qty, app.loc(v_dock),
          case when (a->>'this_pallet_kg') is not null then (a->>'this_pallet_kg')::numeric end, app.uid())
  returning id into v_pallet;

  v_res := app.post_txn_internal(jsonb_build_object(
    'client_uuid', v_client, 'txn_type', v_txn_type, 'event_at', a->>'event_at',
    'reason_code', a->>'reason_code', 'device_id', a->>'device_id',
    'ref_doc_type', v_doc_type, 'ref_doc_id', coalesce(a->>'doc_id', ''), 'approval_id', a->>'approval_id',
    'lines', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'item_id', v_item.id, 'lot_id', v_lot.id, 'from_location', v_from, 'to_location', v_dock,
      'to_status', case when v_doc_type = 'opening_balance' then coalesce(a->>'status', 'available') end,
      'qty_entered', v_qty, 'uom', v_item.base_uom, 'scan_method', coalesce(a->>'scan_method', 'scan'))))),
    false);
  -- attach the pallet to the move index without touching the ledger rows
  update pallet set location_id = app.loc(v_dock) where id = v_pallet;

  if v_doc_type = 'po_line' then
    update po_line set received_qty = received_qty + v_qty,
           first_receipt_at = coalesce(first_receipt_at, now()),
           state = case when received_qty + v_qty >= qty then 'received' else 'partially_received' end
     where id = v_pol.id;
    update purchase_order po set state = case
        when not exists (select 1 from po_line l where l.po_id = po.id and l.state in ('open','partially_received')) then 'received'
        else 'partially_received' end
     where po.id = v_pol.po_id;
  elsif v_doc_type = 'production_order' then
    update production_order set received_qty = received_qty + v_qty, lot_id = coalesce(lot_id, v_lot.id),
           state = case when received_qty + v_qty >= qty then 'finished' else 'in_progress' end,
           actual_finish = case when received_qty + v_qty >= qty then app.today() else actual_finish end
     where id = v_pr.id;
  end if;

  if v_doc_type in ('po_line','production_order') then
    insert into export_row (type, ref_id, payload, created_by) values ('receipts', v_res->>'txn_id', jsonb_build_object(
      'receipt_id', v_res->>'txn_id', 'date', app.today(),
      'supplier_code', (select p.logo_cari_code from party p where p.id = v_po.supplier_id),
      'logo_item_code', v_item.logo_item_code, 'qty', v_qty, 'lot_no', v_lot.lot_no), app.uid());
  end if;

  if (select type from location where id = app.loc(v_dock)) = 'dock' then
    if v_lot.id is not null and not exists (select 1 from task where type = 'qc' and lot_id = v_lot.id and state in ('open','in_progress')) then
      insert into task (type, priority, item_id, lot_id, assigned_role, created_by)
      values ('qc', 2, v_item.id, v_lot.id, 'qc', app.uid());
    end if;
    v_sug := app.suggest_putaway(v_item.id, v_lot.id);
    insert into task (type, priority, item_id, lot_id, pallet_id, location_id, to_location_id, qty_base, assigned_role, payload, created_by)
    values ('putaway', 3, v_item.id, v_lot.id, v_pallet, app.loc(v_dock), (v_sug->>'location_id')::uuid, v_qty, 'operator', v_sug, app.uid());
  end if;

  return v_res || jsonb_build_object('pallet_id', v_pallet, 'pallet_serial', v_serial, 'lot_id', v_lot.id,
    'first_pallet_of_lot', coalesce(v_first, false), 'label', app.label_data(v_pallet), 'putaway', v_sug);
end $$;

-- Kalite (§5.3): release or reject every quarantined balance of the lot.
create or replace function app.cmd_qc(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_lot lot;
  v_decision text := a->>'decision';
  v_lines jsonb;
  v_res jsonb;
  v_from text := coalesce(a->>'from_status', 'quarantine');
begin
  select * into v_lot from lot where id = (a->>'lot_id')::uuid for update;
  if v_lot.id is null then perform app.fail('NOT_FOUND', 'lot'); end if;
  if v_decision not in ('release','reject') then perform app.fail('INVALID', 'decision is release or reject'); end if;
  select jsonb_agg(jsonb_build_object('item_id', b.item_id, 'lot_id', b.lot_id, 'location', b.location_id,
           'owner_id', b.owner_id, 'from_status', v_from, 'qty_entered', b.qty_base, 'scan_method', coalesce(a->>'scan_method', 'scan')))
    into v_lines
    from stock_balance b join location l on l.id = b.location_id
   where b.lot_id = v_lot.id and b.stock_status = v_from and b.qty_base > 0 and l.type <> 'virtual';
  if v_lines is null then perform app.fail('NOTHING_TO_DO', format('lot has no %s stock', v_from)); end if;
  v_res := app.post_txn_internal(jsonb_build_object(
    'client_uuid', a->>'client_uuid', 'txn_type', case v_decision when 'release' then 'qc_release' else 'qc_reject' end,
    'event_at', a->>'event_at', 'reason_code', a->>'reason_code', 'device_id', a->>'device_id',
    'ref_doc_type', 'lot', 'ref_doc_id', v_lot.id, 'lines', v_lines), false);
  update lot set qc_status = case v_decision when 'release' then 'released' else 'rejected' end where id = v_lot.id;
  if v_decision = 'release' then
    -- lead time ends at QC release (§8.4)
    update po_line set qc_released_at = now()
     where qc_released_at is null and id in (
       select t.ref_doc_id::uuid from stock_txn t join stock_move m on m.txn_id = t.id
        where t.txn_type = 'receipt_purchase' and t.ref_doc_type = 'po_line' and m.lot_id = v_lot.id);
    update production_order set qc_released_at = now()
     where qc_released_at is null and id in (
       select t.ref_doc_id::uuid from stock_txn t join stock_move m on m.txn_id = t.id
        where t.txn_type = 'receipt_production' and t.ref_doc_type = 'production_order' and m.lot_id = v_lot.id);
  end if;
  update task set state = 'done', done_at = now(), done_by = app.uid()
   where type = 'qc' and lot_id = v_lot.id and state in ('open','in_progress');
  return v_res || jsonb_build_object('lot_id', v_lot.id, 'qc_status', v_decision);
end $$;

-- Yerleştirme / Transfer: move one pallet (or a loose quantity) between locations.
create or replace function app.cmd_move(a jsonb, p_type text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_pallet pallet;
  v_to location;
  v_res jsonb;
  v_line jsonb;
begin
  select * into v_to from location where id = app.loc(a->>'to_location');
  if a ? 'pallet_serial' or a ? 'pallet_id' then
    select * into v_pallet from pallet
     where serial = a->>'pallet_serial' or id = (a->>'pallet_id')::uuid for update;
    if v_pallet.id is null then perform app.fail('UNKNOWN_PALLET', coalesce(a->>'pallet_serial', '')); end if;
    if v_pallet.status <> 'active' or v_pallet.location_id is null then
      perform app.fail('INVALID_STATE', 'pallet is not in the warehouse');
    end if;
    if a ? 'from_location' and app.loc(a->>'from_location') <> v_pallet.location_id then
      perform app.fail('WRONG_LOCATION', 'pallet is not at the scanned source location');
    end if;
    v_line := jsonb_build_object('pallet_id', v_pallet.id, 'to_location', v_to.id,
                                 'scan_method', coalesce(a->>'scan_method', 'scan'));
  else
    v_line := jsonb_strip_nulls(jsonb_build_object(
      'item_id', (app.find_item(a)).id, 'lot_id', a->>'lot_id', 'from_location', a->>'from_location',
      'to_location', v_to.id, 'qty_entered', (a->>'qty')::numeric, 'uom', a->>'uom',
      'scan_method', coalesce(a->>'scan_method', 'scan')));
  end if;
  v_res := app.post_txn_internal(jsonb_build_object(
    'client_uuid', a->>'client_uuid', 'txn_type', p_type, 'event_at', a->>'event_at',
    'reason_code', a->>'reason_code', 'device_id', a->>'device_id',
    'ref_doc_type', case when v_pallet.id is not null then 'pallet' end, 'ref_doc_id', v_pallet.serial,
    'lines', jsonb_build_array(v_line)), false);
  if v_pallet.id is not null then
    -- a pallet broken down to a pick face stops being a pallet (carton labels are printed)
    if v_to.type = 'pick_face' then
      update pallet set status = 'consumed', location_id = null where id = v_pallet.id;
    end if;
    update task set state = 'done', done_at = now(), done_by = app.uid()
     where type in ('putaway','transfer','replenish','consolidate') and pallet_id = v_pallet.id and state in ('open','in_progress');
  end if;
  if a ? 'task_id' then
    update task set state = 'done', done_at = now(), done_by = app.uid() where id = (a->>'task_id')::uuid;
  end if;
  return v_res || jsonb_build_object('to_location', v_to.code,
    'carton_labels', v_to.type = 'pick_face', 'label', case when v_pallet.id is not null then app.label_data(v_pallet.id) end);
end $$;

-- Toplama (§5.4): scan lane, pallet, staging. Converts the hard reservation into a pick move
-- in one database transaction. A pallet of another lot is accepted only if that lot also
-- passes the customer's shelf-life rule and no older stock is being skipped; the
-- reservation then swaps to the scanned lot.
create or replace function app.cmd_pick(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_res reservation;
  v_task task;
  v_pallet pallet;
  v_ship shipment;
  v_lot lot; v_res_lot lot;
  v_mrsl numeric;
  v_qty numeric;
  v_from uuid;
  v_new_pallet uuid;
  v_serial text;
  v_out jsonb;
  v_line jsonb;
  v_swapped boolean := false;
  v_pf location;
  v_bal numeric;
begin
  if a ? 'task_id' then
    select * into v_task from task where id = (a->>'task_id')::uuid;
  end if;
  select * into v_res from reservation where id = coalesce((a->>'reservation_id')::uuid, v_task.reservation_id) for update;
  if v_res.id is null or v_res.type <> 'hard' then perform app.fail('NOT_FOUND', 'pick reservation'); end if;
  if v_res.state <> 'active' or v_res.qty_base <= 0 then perform app.fail('ALREADY_PICKED', 'nothing left to pick for this task'); end if;
  select * into v_ship from shipment where id = v_res.shipment_id;
  v_from := v_res.location_id;

  if a ? 'pallet_serial' then
    select * into v_pallet from pallet where serial = a->>'pallet_serial' for update;
    if v_pallet.id is null then perform app.fail('UNKNOWN_PALLET', a->>'pallet_serial'); end if;
    if v_pallet.status <> 'active' or v_pallet.location_id is null then perform app.fail('INVALID_STATE', 'pallet is not in the warehouse'); end if;
    if v_pallet.item_id <> v_res.item_id then perform app.fail('WRONG_ITEM', 'pallet holds a different item'); end if;
    if v_pallet.shipment_id is not null then perform app.fail('ALREADY_PICKED', 'pallet is already picked'); end if;
    if a ? 'lane' and app.loc(a->>'lane') <> v_pallet.location_id then
      perform app.fail('WRONG_LOCATION', 'pallet is not in the scanned lane');
    end if;
    if v_pallet.lot_id is distinct from v_res.lot_id or v_pallet.location_id <> v_res.location_id then
      select * into v_lot from lot where id = v_pallet.lot_id;
      select * into v_res_lot from lot where id = v_res.lot_id;
      v_mrsl := coalesce(app.param_num('mrsl_days', jsonb_build_object(
                  'party_id', v_res.party_id, 'item_id', v_res.item_id, 'shipment_id', v_res.shipment_id)), 0);
      if v_lot.expiry_date is not null and v_lot.expiry_date - v_ship.planned_date < v_mrsl then
        perform app.fail('LOT_REFUSED', 'scanned lot fails the customer''s shelf-life rule');
      end if;
      if coalesce(v_lot.band, 'green') in ('red','blocked') then
        perform app.fail('LOT_REFUSED', 'scanned lot is excluded from allocation');
      end if;
      -- not older stock skipped elsewhere: the reserved lot, or any other free eligible lot,
      -- must not expire before the scanned one
      if v_lot.expiry_date is not null and (
           (v_res_lot.expiry_date is not null and v_res_lot.expiry_date < v_lot.expiry_date)
           or exists (select 1 from v_lot_free f where f.item_id = v_res.item_id and f.free_qty > 0
                       and f.lot_id is distinct from v_lot.id and f.expiry_date < v_lot.expiry_date
                       and f.expiry_date - v_ship.planned_date >= v_mrsl
                       and coalesce(f.band, 'green') not in ('red','blocked'))) then
        perform app.fail('LOT_REFUSED', 'older stock would be skipped (FEFO)');
      end if;
      -- the scanned lot must be free of other reservations at that lane
      if coalesce((select f.free_qty from v_lot_free f where f.item_id = v_res.item_id
                     and f.lot_id is not distinct from v_pallet.lot_id and f.location_id = v_pallet.location_id), 0)
         < least(v_pallet.qty_base, v_res.qty_base) then
        perform app.fail('LOT_REFUSED', 'scanned pallet is reserved for another order or not available');
      end if;
      update reservation set lot_id = v_pallet.lot_id, location_id = v_pallet.location_id where id = v_res.id;
      update task set lot_id = v_pallet.lot_id, location_id = v_pallet.location_id where reservation_id = v_res.id and state in ('open','in_progress');
      v_res.lot_id := v_pallet.lot_id; v_res.location_id := v_pallet.location_id;
      v_swapped := true;
    end if;
    v_from := v_pallet.location_id;
    v_qty := least(v_pallet.qty_base, v_res.qty_base, coalesce(app.to_base(v_res.item_id, (a->>'qty')::numeric, a->>'uom', v_res.lot_id), v_pallet.qty_base));
  else
    -- carton pick: only from a pick face
    select * into v_pf from location where id = v_res.location_id;
    if v_pf.type <> 'pick_face' then perform app.fail('PALLET_REQUIRED', 'scan the pallet; carton picks come only from pick faces'); end if;
    if a ? 'lane' and app.loc(a->>'lane') <> v_res.location_id then perform app.fail('WRONG_LOCATION', 'wrong pick face'); end if;
    v_qty := least(v_res.qty_base, coalesce(app.to_base(v_res.item_id, (a->>'qty')::numeric, a->>'uom', v_res.lot_id), v_res.qty_base));
  end if;
  if v_qty is null or v_qty <= 0 then perform app.fail('INVALID', 'quantity must be positive'); end if;

  if v_pallet.id is not null and v_qty = v_pallet.qty_base then
    v_line := jsonb_build_object('pallet_id', v_pallet.id, 'to_location', a->>'to_location',
                                 'scan_method', coalesce(a->>'scan_method', 'scan'));
  else
    v_line := jsonb_build_object('item_id', v_res.item_id, 'lot_id', v_res.lot_id, 'from_location', v_from,
                                 'to_location', a->>'to_location', 'qty_entered', v_qty,
                                 'scan_method', coalesce(a->>'scan_method', 'scan'));
  end if;
  v_out := app.post_txn_internal(jsonb_strip_nulls(jsonb_build_object(
    'client_uuid', a->>'client_uuid', 'txn_type', 'pick', 'event_at', a->>'event_at',
    'reason_code', a->>'reason_code', 'device_id', a->>'device_id',
    'ref_doc_type', 'shipment', 'ref_doc_id', v_res.shipment_id, 'party_id', v_res.party_id,
    'ship_date', v_ship.planned_date, 'campaign_id', v_res.campaign_id,
    'lines', jsonb_build_array(jsonb_strip_nulls(v_line)))), false);

  if v_pallet.id is not null and v_qty = v_pallet.qty_base then
    update pallet set shipment_id = v_res.shipment_id, so_line_id = v_res.demand_line_id where id = v_pallet.id;
    v_new_pallet := v_pallet.id;
  else
    -- part of a pallet or loose cartons: the picked quantity becomes its own shipping pallet
    if v_pallet.id is not null then
      update pallet set qty_base = qty_base - v_qty where id = v_pallet.id;
    end if;
    v_serial := app.next_pallet_serial(app.param_text('sscc_company_prefix'));
    insert into pallet (serial, item_id, lot_id, qty_base, location_id, shipment_id, so_line_id, created_by)
    values (v_serial, v_res.item_id, v_res.lot_id, v_qty, app.loc(a->>'to_location'), v_res.shipment_id, v_res.demand_line_id, app.uid())
    returning id into v_new_pallet;
  end if;

  update reservation set qty_base = qty_base - v_qty,
         state = case when qty_base - v_qty <= 0 then 'consumed' else state end where id = v_res.id;
  update task set state = case when v_res.qty_base - v_qty <= 0 then 'done' else 'in_progress' end,
         qty_base = greatest(v_res.qty_base - v_qty, 0),
         done_at = case when v_res.qty_base - v_qty <= 0 then now() end,
         done_by = case when v_res.qty_base - v_qty <= 0 then app.uid() end
   where reservation_id = v_res.id and state in ('open','in_progress');
  update shipment set state = 'picking' where id = v_res.shipment_id and state in ('planned','allocated');
  update sales_order set state = 'picking'
   where state in ('confirmed','allocated') and id = (select order_id from so_line where id = v_res.demand_line_id);

  -- pick face below its minimum: replenishment task from the FEFO lane
  select * into v_pf from location where id = v_from;
  if v_pf.type = 'pick_face' and v_pf.pick_min_qty is not null then
    select coalesce(sum(qty_base), 0) into v_bal from stock_balance
     where location_id = v_pf.id and item_id = v_res.item_id and stock_status = 'available';
    if v_bal < v_pf.pick_min_qty and not exists (
         select 1 from task where type = 'replenish' and to_location_id = v_pf.id and state in ('open','in_progress')) then
      insert into task (type, priority, item_id, lot_id, location_id, to_location_id, assigned_role, created_by)
      select 'replenish', 2, f.item_id, f.lot_id, f.location_id, v_pf.id, 'operator', app.uid()
        from v_lot_free f where f.item_id = v_res.item_id and f.location_type = 'block_lane' and f.free_qty > 0
       order by f.expiry_date nulls last limit 1;
    end if;
  end if;

  return v_out || jsonb_build_object('picked_qty', v_qty, 'remaining', greatest(v_res.qty_base - v_qty, 0),
    'reservation_swapped', v_swapped, 'pallet_id', v_new_pallet,
    'label', case when v_new_pallet is distinct from v_pallet.id then app.label_data(v_new_pallet) end);
end $$;

-- Truck weight window: approved override on the shipment, vehicle type, site default (§3.8).
create or replace function app.truck_window(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_min jsonb := public.resolve_param('truck_min_kg', jsonb_build_object('shipment_id', p_shipment));
  v_max jsonb := public.resolve_param('truck_max_kg', jsonb_build_object('shipment_id', p_shipment));
  v_vt vehicle_type;
begin
  select vt.* into v_vt from shipment s join vehicle_type vt on vt.id = s.vehicle_type_id where s.id = p_shipment;
  if v_vt.id is not null and v_min->>'level' not in ('shipment_override','vehicle_type') then
    v_min := jsonb_build_object('value', v_vt.min_kg, 'level', 'vehicle_type');
  end if;
  if v_vt.id is not null and v_max->>'level' not in ('shipment_override','vehicle_type') then
    v_max := jsonb_build_object('value', v_vt.max_kg, 'level', 'vehicle_type');
  end if;
  return jsonb_build_object('min_kg', (v_min->>'value')::numeric, 'max_kg', (v_max->>'value')::numeric,
                            'min_level', v_min->>'level', 'max_level', v_max->>'level');
end $$;

-- Running weight from actual lot weights, and the distance to the window (§5.4.5).
create or replace function public.rpc_truck_status(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_w jsonb := app.truck_window(p_shipment);
  v_kg numeric; v_loaded int; v_total int; v_sources jsonb;
begin
  if app.user_role() is null then perform app.fail('NOT_PERMITTED', ''); end if;
  select coalesce(sum(x.kg) filter (where x.loaded), 0), count(*) filter (where x.loaded), count(*),
         coalesce(jsonb_agg(jsonb_build_object('serial', x.serial, 'sku', x.sku, 'lot_no', x.lot_no, 'kg', round(x.kg, 1),
                  'kg_source', x.kg_source, 'loaded', x.loaded) order by x.loaded, x.serial), '[]'::jsonb)
    into v_kg, v_loaded, v_total, v_sources
    from (
      select p.serial, i.sku, l.lot_no, p.loaded_at is not null as loaded,
             case when p.actual_kg is not null then 'pallet' else app.pallet_kg(p.item_id, p.lot_id)->>'level' end as kg_source,
             coalesce(p.actual_kg, (app.pallet_kg(p.item_id, p.lot_id)->>'kg')::numeric
                      * p.qty_base / nullif(app.units_per_pallet(p.item_id, p.lot_id), 0)) as kg
        from pallet p join item i on i.id = p.item_id left join lot l on l.id = p.lot_id
       where p.shipment_id = p_shipment) x;
  return v_w || jsonb_build_object(
    'shipment_id', p_shipment, 'loaded_kg', round(v_kg, 1), 'pallets_loaded', v_loaded, 'pallets_total', v_total,
    'to_min_kg', round((v_w->>'min_kg')::numeric - v_kg, 1), 'to_max_kg', round((v_w->>'max_kg')::numeric - v_kg, 1),
    'in_window', v_kg between (v_w->>'min_kg')::numeric and (v_w->>'max_kg')::numeric,
    'e_irsaliye_no', (select e_irsaliye_no from shipment where id = p_shipment),
    'unpicked_qty', (select coalesce(sum(qty_base), 0) from reservation where shipment_id = p_shipment and type = 'hard' and state = 'active'),
    'pallets', v_sources);
end $$;

-- Yükleme: scan the truck, then each pallet.
create or replace function app.cmd_load(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_ship shipment;
  v_pallet pallet;
begin
  perform app.require_role('operator','ops_manager','owner');
  select * into v_ship from shipment where id = (a->>'shipment_id')::uuid for update;
  if v_ship.id is null then perform app.fail('NOT_FOUND', 'shipment'); end if;
  if v_ship.state in ('dispatched','cancelled') then perform app.fail('INVALID_STATE', 'truck is already closed'); end if;
  select * into v_pallet from pallet where serial = a->>'pallet_serial' for update;
  if v_pallet.id is null then perform app.fail('UNKNOWN_PALLET', coalesce(a->>'pallet_serial', '')); end if;
  if v_pallet.shipment_id is distinct from v_ship.id then
    perform app.fail('WRONG_TRUCK', 'this pallet is not picked for this truck');
  end if;
  if coalesce((a->>'unload')::boolean, false) then
    update pallet set loaded_at = null where id = v_pallet.id;
  else
    update pallet set loaded_at = coalesce(loaded_at, now()) where id = v_pallet.id;
  end if;
  update shipment set state = 'loading' where id = v_ship.id and state in ('planned','allocated','picking');
  return jsonb_build_object('pallet_serial', v_pallet.serial) || public.rpc_truck_status(v_ship.id);
end $$;

-- Truck close (§5.4.6-7): blocked when weight is outside the window, any pallet is
-- unscanned, or the e-İrsaliye number is missing. Posts ship, issue_free_goods and
-- consign_out in one transaction and writes the shipment confirmation for Logo.
create or replace function app.cmd_close_truck(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_client uuid := (a->>'client_uuid')::uuid;
  v_ship shipment;
  v_truck truck_load;
  v_status jsonb;
  v_eirs text;
  v_override boolean := false;
  v_staging uuid;
  v_cons_loc uuid;
  v_kind text;
  v_lines jsonb;
  v_results jsonb := '[]'::jsonb;
  v_party party;
  r record;
begin
  perform app.require_role('operator','ops_manager','owner');
  select * into v_ship from shipment where id = (a->>'shipment_id')::uuid for update;
  if v_ship.id is null then perform app.fail('NOT_FOUND', 'shipment'); end if;
  if v_ship.state = 'dispatched' then perform app.fail('INVALID_STATE', 'truck is already closed'); end if;
  select * into v_truck from truck_load where shipment_id = v_ship.id for update;
  select * into v_party from party where id = v_ship.party_id;
  v_status := public.rpc_truck_status(v_ship.id);

  if (v_status->>'pallets_total')::int = 0 then perform app.fail('NOTHING_TO_DO', 'no pallets picked for this truck'); end if;
  if (v_status->>'pallets_loaded')::int < (v_status->>'pallets_total')::int then
    perform app.fail('PALLET_UNSCANNED', format('%s of %s pallets scanned onto the truck',
      v_status->>'pallets_loaded', v_status->>'pallets_total'));
  end if;
  v_eirs := nullif(trim(coalesce(a->>'e_irsaliye_no', v_ship.e_irsaliye_no, '')), '');
  if v_eirs is null then perform app.fail('EIRSALIYE_REQUIRED', 'e-İrsaliye number is missing'); end if;
  if not (v_status->>'in_window')::boolean then
    -- weight override needs the ops manager role and a reason, through an approved request
    select true into v_override from approval_request ar
     where ar.type = 'weight_override' and ar.state = 'approved' and (ar.payload->>'shipment_id')::uuid = v_ship.id limit 1;
    if not coalesce(v_override, false) then
      perform app.fail('WEIGHT_OUT_OF_WINDOW', format('truck weighs %s kg; window is %s to %s kg',
        v_status->>'loaded_kg', v_status->>'min_kg', v_status->>'max_kg'));
    end if;
  end if;

  -- one stock transaction per kind, all inside this database transaction
  for v_kind in select unnest(array['ship','issue_free_goods','consign_out']) loop
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('pallet_id', p.id,
             'to_location', case when v_kind = 'consign_out' then
               (select l.id::text from location l where l.type = 'consignment' and l.dealer_id = v_ship.party_id) end,
             'scan_method', 'scan')))
      into v_lines
      from pallet p
      join so_line sl on sl.id = p.so_line_id
      join sales_order o on o.id = sl.order_id
     where p.shipment_id = v_ship.id and p.status = 'active'
       and case when o.order_type = 'consignment' then 'consign_out'
                when sl.line_type = 'free' then 'issue_free_goods' else 'ship' end = v_kind;
    continue when v_lines is null;
    if v_kind = 'consign_out' and not exists (select 1 from location l where l.type = 'consignment' and l.dealer_id = v_ship.party_id) then
      perform app.fail('NOT_FOUND', 'dealer has no consignment location');
    end if;
    v_results := v_results || jsonb_build_array(app.post_txn_internal(jsonb_build_object(
      'client_uuid', app.derive_uuid(v_client, v_kind), 'txn_type', v_kind, 'event_at', a->>'event_at',
      'reason_code', a->>'reason_code', 'device_id', a->>'device_id',
      'ref_doc_type', 'shipment', 'ref_doc_id', v_ship.id, 'party_id', v_ship.party_id,
      'lines', v_lines), false));
  end loop;

  -- shipped quantities, order states
  for r in select p.so_line_id, sum(p.qty_base) as qty from pallet p where p.shipment_id = v_ship.id group by p.so_line_id loop
    update so_line set shipped_qty = shipped_qty + r.qty where id = r.so_line_id;
    update shipment_line set shipped_qty = shipped_qty + r.qty where shipment_id = v_ship.id and so_line_id = r.so_line_id;
  end loop;
  -- anything reserved for this truck but not picked goes back to the backorder queue
  for r in select * from reservation where shipment_id = v_ship.id and state = 'active' loop
    update reservation set state = 'released' where id = r.id;
    insert into reservation (demand_line_id, party_id, item_id, qty_base, original_qty, type, campaign_id, need_date, created_by)
    values (r.demand_line_id, r.party_id, r.item_id, r.qty_base, r.qty_base, 'soft', r.campaign_id, app.today(), app.uid());
    update so_line set backorder = true where id = r.demand_line_id;
  end loop;
  update task set state = 'cancelled' where shipment_id = v_ship.id and state in ('open','in_progress');
  update sales_order o set state = 'shipped'
   where o.id in (select sl.order_id from pallet p join so_line sl on sl.id = p.so_line_id where p.shipment_id = v_ship.id)
     and not exists (select 1 from so_line l where l.order_id = o.id and not l.is_phantom and l.shipped_qty < l.qty);

  update shipment set state = 'dispatched', e_irsaliye_no = v_eirs, seal_no = coalesce(a->>'seal_no', seal_no),
         vehicle_ref = coalesce(a->>'vehicle_ref', vehicle_ref), dispatched_at = now() where id = v_ship.id;
  update truck_load set actual_kg = (v_status->>'loaded_kg')::numeric, window_ok = (v_status->>'in_window')::boolean,
         override_by = case when v_override then (select approved_by from approval_request ar
              where ar.type = 'weight_override' and ar.state = 'approved' and (ar.payload->>'shipment_id')::uuid = v_ship.id limit 1) end,
         override_reason = case when v_override then (select reason from approval_request ar
              where ar.type = 'weight_override' and ar.state = 'approved' and (ar.payload->>'shipment_id')::uuid = v_ship.id limit 1) end,
         closed_at = now()
   where id = v_truck.id;
  insert into truck_load_line (truck_load_id, item_id, lot_id, pallets, kg, kg_source, actual, created_by)
  select v_truck.id, p.item_id, p.lot_id, count(*),
         sum(coalesce(p.actual_kg, (app.pallet_kg(p.item_id, p.lot_id)->>'kg')::numeric * p.qty_base / nullif(app.units_per_pallet(p.item_id, p.lot_id), 0))),
         min(case when p.actual_kg is not null then 'pallet' else app.pallet_kg(p.item_id, p.lot_id)->>'level' end), true, app.uid()
    from pallet p where p.shipment_id = v_ship.id group by p.item_id, p.lot_id;
  if v_truck.pattern_id is not null and (v_status->>'in_window')::boolean then
    update load_pattern set approved = true where id = v_truck.pattern_id;
  end if;

  -- shipment confirmation rows for the Logo outbound file
  insert into export_row (type, ref_id, payload, created_by)
  select 'shipment_confirm', v_ship.id::text, jsonb_build_object(
           'shipment_id', v_ship.shipment_no, 'ship_date', app.today(), 'logo_cari_code', v_party.logo_cari_code,
           'logo_item_code', i.logo_item_code, 'qty', sum(p.qty_base), 'unit', i.base_uom, 'lot_no', l.lot_no,
           'line_type', case when sl.line_type = 'free' then 'free' else 'paid' end,
           'campaign_code', (select c.code from campaign c where c.id = o.campaign_id)), app.uid()
    from pallet p join item i on i.id = p.item_id left join lot l on l.id = p.lot_id
    join so_line sl on sl.id = p.so_line_id join sales_order o on o.id = sl.order_id
   where p.shipment_id = v_ship.id
   group by i.logo_item_code, i.base_uom, l.lot_no, sl.line_type, o.campaign_id;

  if v_override then
    perform app.raise_alert('truck_weight_override', 'warning', false,
      jsonb_build_object('shipment_no', v_ship.shipment_no, 'kg', v_status->>'loaded_kg'), 'shipment', v_ship.id);
  end if;
  return jsonb_build_object('shipment_id', v_ship.id, 'state', 'dispatched', 'loaded_kg', v_status->>'loaded_kg',
    'in_window', v_status->>'in_window', 'weight_override', v_override, 'txns', v_results);
end $$;

-- ---------------------------------------------------------------------------
-- Counting (§5.5): blind counts, recount by a different user, adjustment after a
-- confirmed variance with a mandatory reason code.
-- ---------------------------------------------------------------------------
create or replace function app.count_expected(p_loc uuid, p_item uuid, p_lot uuid) returns numeric
language sql stable as $$
  select coalesce(sum(b.qty_base), 0) from public.stock_balance b
   where b.location_id = p_loc and (p_item is null or b.item_id = p_item)
     and (p_lot is null or b.lot_id = p_lot)
$$;

create or replace function app.count_tolerance(p_loc uuid, p_item uuid, p_expected numeric) returns numeric
language plpgsql stable as $$
declare
  v_type text;
  v_abc text;
  v_carton numeric;
begin
  select type into v_type from public.location where id = p_loc;
  if to_regclass('public.item_class') is not null and p_item is not null then
    execute 'select ic.abc from public.item_class ic join public.classification_run cr on cr.id = ic.run_id
              where cr.is_current and ic.item_id = $1' into v_abc using p_item;
  end if;
  if v_type = 'pick_face' and coalesce(v_abc, 'C') = 'C' then
    -- cartons of C items: the larger of 1 box or 2%
    select qty_base into v_carton from public.uom_pack where item_id = p_item and level = 'carton';
    return greatest(coalesce(v_carton, 1) * coalesce(app.param_num('count_tolerance_carton_min_boxes', jsonb_build_object('item_id', p_item)), 1),
                    p_expected * coalesce(app.param_num('count_tolerance_carton_pct', jsonb_build_object('item_id', p_item)), 2) / 100.0);
  end if;
  return p_expected * coalesce(app.param_num('count_tolerance_pct', jsonb_build_object('item_id', p_item)), 0) / 100.0;
end $$;

-- Post the adjustment for a confirmed variance. Consignment shortfalls become
-- consignment_consume with an invoice request to Logo (§10.1).
create or replace function app.count_apply_adjust(p_task uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  t count_task;
  v_loc location;
  v_item item;
  v_res jsonb;
  v_type text := 'count_adjust';
  v_line jsonb;
  v_status text;
begin
  select * into t from count_task where id = p_task for update;
  if t.adjusted then return jsonb_build_object('already_adjusted', true); end if;
  select * into v_loc from location where id = t.location_id;
  select * into v_item from item where id = t.item_id;
  if t.variance = 0 or t.item_id is null then
    update count_task set state = 'closed', closed_at = now() where id = p_task;
    return jsonb_build_object('adjusted', false);
  end if;
  v_status := coalesce(app.infer_status(t.item_id, t.lot_id, t.location_id, app.dayson(), abs(t.variance)), 'available');
  if v_loc.type = 'consignment' and t.variance < 0 then
    v_type := 'consignment_consume';
    v_line := jsonb_build_object('item_id', t.item_id, 'lot_id', t.lot_id, 'from_location', t.location_id,
                                 'qty_entered', -t.variance, 'scan_method', 'system');
    insert into export_row (type, ref_id, payload, created_by) values ('consignment_sales', t.id::text, jsonb_build_object(
      'dealer_code', (select logo_cari_code from party where id = v_loc.dealer_id),
      'logo_item_code', v_item.logo_item_code, 'qty', -t.variance, 'period', to_char(app.today(), 'YYYY-MM')), app.uid());
  elsif t.variance > 0 then
    v_line := jsonb_build_object('item_id', t.item_id, 'lot_id', t.lot_id, 'from_location', 'V-ADJUSTMENT',
                                 'to_location', t.location_id, 'status', v_status, 'qty_entered', t.variance, 'scan_method', 'system');
  else
    v_line := jsonb_build_object('item_id', t.item_id, 'lot_id', t.lot_id, 'from_location', t.location_id,
                                 'to_location', 'V-ADJUSTMENT', 'from_status', v_status, 'qty_entered', -t.variance, 'scan_method', 'system');
  end if;
  v_res := app.post_txn_internal(jsonb_build_object(
    'client_uuid', app.derive_uuid(t.id, 'count_adjust'), 'txn_type', v_type,
    'reason_code', coalesce(t.reason_code, 'count_variance'), 'ref_doc_type', 'count_task', 'ref_doc_id', t.id,
    'approval_id', t.approval_id, 'lines', jsonb_build_array(jsonb_strip_nulls(v_line))), true);
  if v_type = 'count_adjust' then
    insert into export_row (type, ref_id, payload, created_by) values ('adjustments', v_res->>'txn_id', jsonb_build_object(
      'txn_id', v_res->>'txn_id', 'date', app.today(), 'logo_item_code', v_item.logo_item_code, 'qty_signed', t.variance,
      'reason_code', coalesce(t.reason_code, 'count_variance'),
      'approved_by', (select full_name from app_user where id = (select approved_by from approval_request where id = t.approval_id))), app.uid());
  end if;
  update count_task set adjusted = true, adjust_txn_id = (v_res->>'txn_id')::uuid, state = 'closed', closed_at = now() where id = p_task;
  update location set last_counted_at = now() where id = t.location_id;
  return v_res;
end $$;

create or replace function app.cmd_count(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  t count_task;
  v_loc location;
  v_item uuid; v_lot uuid;
  v_qty numeric; v_expected numeric; v_tol numeric; v_var numeric;
  v_value numeric;
  v_approval uuid;
begin
  perform app.require_role('operator','ops_manager','owner','sales_rep');
  select * into t from count_task where id = (a->>'count_task_id')::uuid for update;
  if t.id is null then perform app.fail('NOT_FOUND', 'count task'); end if;
  select * into v_loc from location where id = t.location_id;
  if app.user_role() = 'sales_rep' and (v_loc.type <> 'consignment' or not app.rep_can(v_loc.dealer_id)) then
    perform app.fail('NOT_PERMITTED', 'reps count only their own dealers'' consignment stock');
  end if;
  if t.state not in ('open','recount') then perform app.fail('INVALID_STATE', 'count task is closed'); end if;
  v_item := coalesce(t.item_id, (a->>'item_id')::uuid, v_loc.lane_item_id);
  v_lot := coalesce(t.lot_id, (a->>'lot_id')::uuid, case when t.item_id is null then v_loc.lane_lot_id end);
  v_qty := case when v_item is not null then app.to_base(v_item, (a->>'qty')::numeric, a->>'uom', v_lot) else (a->>'qty')::numeric end;
  if v_qty is null or v_qty < 0 then perform app.fail('INVALID', 'counted quantity is required'); end if;
  v_expected := app.count_expected(t.location_id, v_item, v_lot);
  v_tol := app.count_tolerance(t.location_id, v_item, v_expected);
  v_var := v_qty - v_expected;
  insert into count_result (count_task_id, seq, counted_by, qty, scan_method, created_by)
  values (t.id, case when t.state = 'open' then 1 else 2 end, app.uid(), v_qty, coalesce(a->>'scan_method', 'scan'), app.uid());

  if t.state = 'open' then
    if abs(v_var) <= v_tol then
      update count_task set item_id = v_item, lot_id = v_lot, expected_qty = v_expected, counted_qty = v_qty,
             counted_by = app.uid(), counted_at = now(), variance = v_var, tolerance = v_tol,
             within_tolerance = true, state = 'closed', closed_at = now() where id = t.id;
      update location set last_counted_at = now() where id = t.location_id;
      return jsonb_build_object('count_task_id', t.id, 'state', 'closed', 'accepted', true);
    end if;
    -- outside tolerance: a different user recounts
    update count_task set item_id = v_item, lot_id = v_lot, expected_qty = v_expected, counted_qty = v_qty,
           counted_by = app.uid(), counted_at = now(), variance = v_var, tolerance = v_tol, state = 'recount',
           assigned_to = null where id = t.id;
    return jsonb_build_object('count_task_id', t.id, 'state', 'recount', 'accepted', true);
  end if;

  -- recount
  if t.counted_by is not distinct from app.uid() then
    perform app.fail('RECOUNT_DIFFERENT_USER', 'the recount must be done by a different user');
  end if;
  if abs(v_var) <= v_tol then
    update count_task set recount_qty = v_qty, recount_by = app.uid(), expected_qty = v_expected, variance = v_var,
           tolerance = v_tol, within_tolerance = true, state = 'closed', closed_at = now() where id = t.id;
    update location set last_counted_at = now() where id = t.location_id;
    return jsonb_build_object('count_task_id', t.id, 'state', 'closed', 'accepted', true);
  end if;
  if nullif(a->>'reason_code', '') is null then
    perform app.fail('REASON_REQUIRED', 'a confirmed variance needs a reason code');
  end if;
  update count_task set recount_qty = v_qty, recount_by = app.uid(), expected_qty = v_expected, variance = v_var,
         tolerance = v_tol, within_tolerance = false, reason_code = a->>'reason_code' where id = t.id;
  v_value := abs(v_var) * coalesce(app.item_cost(v_item), 0);
  if v_value > coalesce(app.param_num('adjust_approval_eur', jsonb_build_object('item_id', v_item)), 0) then
    insert into approval_request (type, payload, requested_by, reason, entity_type, entity_id, created_by)
    values ('count_adjust', jsonb_build_object('count_task_id', t.id, 'variance', v_var, 'value_eur', round(v_value, 2),
              'location', v_loc.code, 'item_id', v_item), app.uid(), a->>'reason_code', 'count_task', t.id, app.uid())
    returning id into v_approval;
    update count_task set state = 'pending_approval', approval_id = v_approval where id = t.id;
    return jsonb_build_object('count_task_id', t.id, 'state', 'pending_approval', 'accepted', true, 'approval_id', v_approval);
  end if;
  perform app.count_apply_adjust(t.id);
  return jsonb_build_object('count_task_id', t.id, 'state', 'closed', 'accepted', true, 'adjusted', true);
end $$;

-- Dealer reports a consignment sale (§10.1).
create or replace function app.cmd_consignment_consume(a jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_party uuid := (a->>'party_id')::uuid;
  v_loc location;
  v_item item;
  v_qty numeric;
  v_res jsonb;
begin
  perform app.require_role('sales_rep','ops_manager','owner');
  if not app.rep_can(v_party) then perform app.fail('NOT_PERMITTED', 'not your dealer'); end if;
  select * into v_loc from location where type = 'consignment' and dealer_id = v_party;
  if v_loc.id is null then perform app.fail('NOT_FOUND', 'consignment location'); end if;
  v_item := app.find_item(a);
  v_qty := app.to_base(v_item.id, (a->>'qty')::numeric, a->>'uom', (a->>'lot_id')::uuid);
  v_res := app.post_txn_internal(jsonb_build_object(
    'client_uuid', a->>'client_uuid', 'txn_type', 'consignment_consume', 'event_at', a->>'event_at',
    'reason_code', coalesce(a->>'reason_code', 'dealer_sale'), 'device_id', a->>'device_id',
    'ref_doc_type', 'party', 'ref_doc_id', v_party,
    'lines', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('item_id', v_item.id, 'lot_id', a->>'lot_id',
       'from_location', v_loc.id, 'qty_entered', v_qty, 'scan_method', coalesce(a->>'scan_method', 'manual'))))), false);
  insert into export_row (type, ref_id, payload, created_by) values ('consignment_sales', v_res->>'txn_id', jsonb_build_object(
    'dealer_code', (select logo_cari_code from party where id = v_party),
    'logo_item_code', v_item.logo_item_code, 'qty', v_qty, 'period', to_char(app.today(), 'YYYY-MM')), app.uid());
  return v_res;
end $$;

-- Refusals that must be seen immediately (§12.5) plus the exception count (§5.5).
create or replace function app.record_refusal(p_code text, p_msg text, p_cmd text, p_args jsonb) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_loc uuid;
begin
  if p_code in ('NEGATIVE_BALANCE','UNBALANCED','MRSL_BLOCKED') then
    perform app.raise_alert(lower(p_code), 'critical', true,
      jsonb_build_object('message', p_msg, 'cmd', p_cmd, 'args', p_args, 'user_id', app.uid()));
  end if;
  if p_code = 'NEGATIVE_BALANCE' then
    begin
      v_loc := coalesce(
        (select location_id from reservation where id = (p_args->>'reservation_id')::uuid),
        (select r.location_id from task tk join reservation r on r.id = tk.reservation_id where tk.id = (p_args->>'task_id')::uuid),
        (select location_id from pallet where serial = p_args->>'pallet_serial'),
        app.loc(coalesce(p_args->>'from_location', p_args->'lines'->0->>'from_location', p_args->'lines'->0->>'location')));
      if v_loc is not null and (select type from location where id = v_loc) <> 'virtual' then
        insert into count_task (location_id, trigger, state, created_by)
        select v_loc, 'exception', 'open', app.uid()
         where not exists (select 1 from count_task where location_id = v_loc and trigger = 'exception' and state in ('open','recount'));
      end if;
    exception when others then null;
    end;
  end if;
end $$;

-- The single entry point for the floor app and its offline outbox.
create or replace function public.rpc_floor(p_cmd text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_client uuid := (p_args->>'client_uuid')::uuid;
  v_result jsonb;
  v_msg text; v_code text;
begin
  if app.user_role() is null then
    return jsonb_build_object('error', 'NOT_PERMITTED', 'message', 'NOT_PERMITTED: unknown user');
  end if;
  if v_client is null then
    return jsonb_build_object('error', 'INVALID', 'message', 'INVALID: client_uuid is required');
  end if;
  select result || jsonb_build_object('duplicate', true) into v_result from command_log where client_uuid = v_client;
  if v_result is not null then return v_result; end if;

  begin
    v_result := case p_cmd
      when 'receive' then app.cmd_receive(p_args)
      when 'opening_balance' then app.cmd_receive(p_args || jsonb_build_object('doc_type', 'opening_balance'))
      when 'qc' then app.cmd_qc(p_args)
      when 'putaway' then app.cmd_move(p_args, 'putaway')
      when 'transfer' then app.cmd_move(p_args, 'transfer')
      when 'pick' then app.cmd_pick(p_args)
      when 'load' then app.cmd_load(p_args)
      when 'close_truck' then app.cmd_close_truck(p_args)
      when 'count' then app.cmd_count(p_args)
      when 'consignment_consume' then app.cmd_consignment_consume(p_args)
      when 'kit_assemble' then app.cmd_kit_assemble(p_args)
      when 'dealer_observation' then app.cmd_dealer_observation(p_args)
      else null end;
    if v_result is null then
      perform app.fail('INVALID', format('unknown command %s', p_cmd));
    end if;
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics v_msg = message_text;
      v_code := split_part(v_msg, ':', 1);
      v_result := null;
  end;
  if v_code is not null then
    perform app.record_refusal(v_code, v_msg, p_cmd, p_args);
    return jsonb_build_object('error', v_code, 'message', v_msg);
  end if;
  insert into command_log (client_uuid, cmd, args, result, user_id, created_by)
  values (v_client, p_cmd, p_args, v_result, app.uid(), app.uid())
  on conflict (client_uuid) do nothing;
  return v_result;
end $$;

-- Batched scan log from the handheld.
create or replace function public.rpc_log_scans(p_events jsonb) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_n int;
begin
  if app.user_role() is null then perform app.fail('NOT_PERMITTED', ''); end if;
  insert into scan_event (user_id, device_id, at, screen, kind, method, accepted, raw, parsed_class, reason_code, created_by)
  select app.uid(), e->>'device_id', coalesce((e->>'at')::timestamptz, now()), e->>'screen', e->>'kind',
         coalesce(e->>'method', 'scan'), coalesce((e->>'accepted')::boolean, true), left(e->>'raw', 200),
         e->>'parsed_class', e->>'reason_code', app.uid()
    from jsonb_array_elements(p_events) e;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Sorgu: scan anything to see what it is and where it is.
create or replace function public.rpc_scan_lookup(p_code text default null, p_gtin text default null, p_lot_no text default null)
returns jsonb language plpgsql stable security definer set search_path = public, app as $$
declare
  v_pallet pallet; v_loc location; v_item item;
begin
  if app.user_role() is null then perform app.fail('NOT_PERMITTED', ''); end if;
  if p_code ~ '^[0-9]{18}$' then
    select * into v_pallet from pallet where serial = p_code;
    if v_pallet.id is null then return jsonb_build_object('kind', 'unknown'); end if;
    return jsonb_build_object('kind', 'pallet', 'pallet', to_jsonb(v_pallet) || app.label_data(v_pallet.id),
      'location', (select code from location where id = v_pallet.location_id),
      'stock_status', (select b.stock_status from stock_balance b where b.item_id = v_pallet.item_id
                         and b.lot_id is not distinct from v_pallet.lot_id and b.location_id = v_pallet.location_id and b.qty_base > 0 limit 1),
      'lot', (select to_jsonb(l) from lot l where l.id = v_pallet.lot_id),
      'putaway', app.suggest_putaway(v_pallet.item_id, v_pallet.lot_id));
  end if;
  if p_code is not null then
    select * into v_loc from location where code = p_code;
    if v_loc.id is not null then
      return jsonb_build_object('kind', 'location', 'location', to_jsonb(v_loc),
        'stock', coalesce((select jsonb_agg(to_jsonb(s)) from v_stock s where s.location_id = v_loc.id), '[]'::jsonb),
        'pallets', coalesce((select jsonb_agg(jsonb_build_object('serial', p.serial, 'qty_base', p.qty_base)) from pallet p
                              where p.location_id = v_loc.id and p.status = 'active'), '[]'::jsonb));
    end if;
  end if;
  select * into v_item from item where gtin = coalesce(p_gtin, p_code) or gtin = ltrim(coalesce(p_gtin, p_code), '0') or sku = p_code;
  if v_item.id is not null then
    return jsonb_build_object('kind', 'item', 'item', to_jsonb(v_item),
      'stock', coalesce((select jsonb_agg(to_jsonb(s) order by s.expiry_date) from v_stock s
                          where s.item_id = v_item.id and (p_lot_no is null or s.lot_no = p_lot_no)), '[]'::jsonb));
  end if;
  return jsonb_build_object('kind', 'unknown');
end $$;

create or replace function public.rpc_putaway_suggestion(p_pallet_serial text) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select app.suggest_putaway(p.item_id, p.lot_id) from pallet p
   where p.serial = p_pallet_serial and app.user_role() is not null
$$;

-- Scheduled cycle counts (§5.5): A monthly, B quarterly, C twice a year, spread evenly.
create or replace function public.rpc_generate_count_tasks() returns int
language plpgsql security definer set search_path = public, app as $$
declare
  v_n int := 0;
  c record;
  v_made int;
begin
  perform app.require_role('ops_manager','owner');
  for c in select * from (values ('A', 30), ('B', 91), ('C', 182)) as t(abc, days) loop
    with lanes as (
      select l.id, l.lane_item_id, l.lane_lot_id, l.last_counted_at,
             coalesce((select ic.abc from item_class ic join classification_run cr on cr.id = ic.run_id
                        where cr.is_current and ic.item_id = b.item_id), 'C') as abc
        from location l
        join lateral (select item_id from stock_balance sb where sb.location_id = l.id and sb.qty_base > 0 limit 1) b on true
       where l.type in ('block_lane','pick_face') and l.active
    ), due as (
      select * from lanes where abc = c.abc
         and (last_counted_at is null or last_counted_at < now() - make_interval(days => c.days))
         and not exists (select 1 from count_task ct where ct.location_id = lanes.id and ct.state in ('open','recount','pending_approval'))
       order by last_counted_at nulls first
       limit greatest(1, ceil((select count(*) from lanes where abc = c.abc)::numeric / c.days))
    )
    insert into count_task (location_id, item_id, lot_id, trigger, created_by)
    select id, lane_item_id, lane_lot_id, 'scheduled', app.uid() from due;
    get diagnostics v_made = row_count;
    v_n := v_n + v_made;
  end loop;
  return v_n;
end $$;

create or replace function public.rpc_create_count_task(p_location text, p_trigger text default 'exception', p_assigned uuid default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare v_id uuid; v_loc location;
begin
  perform app.require_role('ops_manager','owner','sales_rep','finance');
  select * into v_loc from location where id = app.loc(p_location);
  if app.user_role() = 'sales_rep' and (v_loc.type <> 'consignment' or not app.rep_can(v_loc.dealer_id)) then
    perform app.fail('NOT_PERMITTED', 'not your dealer');
  end if;
  insert into count_task (location_id, item_id, lot_id, trigger, assigned_to, created_by)
  values (v_loc.id, v_loc.lane_item_id, v_loc.lane_lot_id, p_trigger, p_assigned, app.uid()) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Views for the floor and control screens
-- ---------------------------------------------------------------------------
-- Blind count list: no expected quantity, no variance.
create or replace view public.v_count_task_blind as
select t.id, t.location_id, l.code as location_code, l.type as location_type, t.item_id, i.sku, i.name as item_name,
       t.lot_id, lot.lot_no, t.trigger, t.state, t.assigned_to, t.counted_by, t.created_at
from public.count_task t
join public.location l on l.id = t.location_id
left join public.item i on i.id = t.item_id
left join public.lot on lot.id = t.lot_id
where t.state in ('open','recount')
  and app.user_role() is not null
  and (app.user_role() <> 'sales_rep' or (l.type = 'consignment' and app.rep_can(l.dealer_id)));

-- Full count data for everyone except operators and reps.
create or replace view public.v_count_task as
select t.*, l.code as location_code, i.sku, lot.lot_no,
       round(abs(coalesce(t.variance, 0)) * coalesce(app.item_cost(t.item_id), 0), 2) as variance_eur
from public.count_task t
join public.location l on l.id = t.location_id
left join public.item i on i.id = t.item_id
left join public.lot on lot.id = t.lot_id
where app.user_role() in ('owner','ops_manager','finance','auditor','planner','qc','system');

-- Inventory record accuracy = records within tolerance / records counted (§5.5).
create or replace view public.v_ira_daily as
select (t.closed_at at time zone 'Europe/Istanbul')::date as day,
       count(*) as counted,
       count(*) filter (where t.within_tolerance) as within_tolerance,
       round(100.0 * count(*) filter (where t.within_tolerance) / nullif(count(*), 0), 2) as ira_pct
from public.count_task t
where t.state = 'closed' and t.within_tolerance is not null
group by 1;

-- Scan compliance = scanned confirmations / required confirmations, per user and day (§6).
create or replace view public.v_scan_compliance as
select (e.at at time zone 'Europe/Istanbul')::date as day, e.user_id, u.full_name,
       count(*) filter (where e.accepted) as required,
       count(*) filter (where e.accepted and e.method = 'scan') as scanned,
       round(100.0 * count(*) filter (where e.accepted and e.method = 'scan') / nullif(count(*) filter (where e.accepted), 0), 2) as compliance_pct
from public.scan_event e
left join public.app_user u on u.id = e.user_id
where app.user_role() in ('owner','ops_manager','system')
group by 1, 2, 3;

-- Site-wide compliance without personal detail (dashboard, digest).
create or replace view public.v_scan_compliance_daily as
select (e.at at time zone 'Europe/Istanbul')::date as day,
       count(*) filter (where e.accepted) as required,
       count(*) filter (where e.accepted and e.method = 'scan') as scanned,
       round(100.0 * count(*) filter (where e.accepted and e.method = 'scan') / nullif(count(*) filter (where e.accepted), 0), 2) as compliance_pct
from public.scan_event e
group by 1;

-- QC queue with age in hours.
create or replace view public.v_qc_queue as
select b.lot_id, lot.lot_no, b.item_id, i.sku, i.name as item_name, lot.expiry_date, b.stock_status,
       sum(b.qty_base) as qty_base,
       round(extract(epoch from now() - min(lot.created_at)) / 3600.0, 1) as age_hours,
       string_agg(distinct l.code, ', ') as locations
from public.stock_balance b
join public.location l on l.id = b.location_id and l.type <> 'virtual'
join public.lot on lot.id = b.lot_id
join public.item i on i.id = b.item_id
where b.stock_status in ('quarantine','blocked_expiry') and b.qty_base > 0
group by b.lot_id, lot.lot_no, b.item_id, i.sku, i.name, lot.expiry_date, b.stock_status;

-- Lane utilisation and honeycombing (§5.6): capacity = depth_positions x max_stack_height.
create or replace view public.v_lane_utilisation as
select l.id as location_id, l.code, l.zone, l.depth_class, l.lane_item_id, i.sku, l.lane_lot_id, lot.lot_no,
       coalesce(l.depth_positions, 1) * coalesce(l.max_stack_height, 1) as capacity_pallets,
       (select count(*) from public.pallet p where p.location_id = l.id and p.status = 'active') as pallets,
       case when l.lane_item_id is not null then
         greatest(coalesce(l.depth_positions, 1) * coalesce(l.max_stack_height, 1)
                  - (select count(*) from public.pallet p where p.location_id = l.id and p.status = 'active'), 0)
       else 0 end as honeycomb_positions
from public.location l
left join public.item i on i.id = l.lane_item_id
left join public.lot on lot.id = l.lane_lot_id
where l.type = 'block_lane' and l.active;

-- Consolidation proposal: two lanes of the same lot each under half full.
create or replace view public.v_consolidation as
select a.lane_item_id as item_id, a.lane_lot_id as lot_id, a.sku, a.lot_no,
       a.location_id as from_location_id, a.code as from_code, a.pallets as from_pallets,
       b.location_id as to_location_id, b.code as to_code, b.pallets as to_pallets
from public.v_lane_utilisation a
join public.v_lane_utilisation b
  on b.lane_item_id = a.lane_item_id and b.lane_lot_id is not distinct from a.lane_lot_id and a.code < b.code
where a.lane_item_id is not null
  and a.pallets > 0 and b.pallets > 0
  and a.pallets * 2 < a.capacity_pallets and b.pallets * 2 < b.capacity_pallets
  and a.pallets + b.pallets <= b.capacity_pallets;

-- Operator's task list.
create or replace view public.v_task as
select t.id, t.type, t.priority, t.state, t.assigned_to, t.assigned_role, t.shipment_id, s.shipment_no,
       t.reservation_id, t.location_id, l.code as location_code, t.to_location_id, tl.code as to_location_code,
       t.item_id, i.sku, i.name as item_name, t.lot_id, lot.lot_no, lot.expiry_date, t.pallet_id, p.serial as pallet_serial,
       t.party_id, pa.name as party_name, t.qty_base,
       round(t.qty_base / nullif(app.units_per_pallet(t.item_id, t.lot_id), 0), 2) as pallets,
       t.payload, t.due_at, t.created_at
from public.task t
left join public.shipment s on s.id = t.shipment_id
left join public.location l on l.id = t.location_id
left join public.location tl on tl.id = t.to_location_id
left join public.item i on i.id = t.item_id
left join public.lot on lot.id = t.lot_id
left join public.pallet p on p.id = t.pallet_id
left join public.party pa on pa.id = t.party_id
where t.state in ('open','in_progress');
