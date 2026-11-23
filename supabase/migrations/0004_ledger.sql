-- 0004 Stock ledger (spec §3.2, §4). Every stock quantity is the sum of stock_move rows.
-- Clients never insert into stock_move: post_txn(jsonb) is the only write path.

-- ---------------------------------------------------------------------------
-- Alerts (§12.5) live here because the ledger raises them.
-- ---------------------------------------------------------------------------
create table public.alert (
  id uuid primary key default gen_random_uuid(),
  rule text not null,
  severity text not null default 'warning' check (severity in ('info','warning','critical')),
  realtime boolean not null default false,          -- pushed immediately to owner + ops_manager
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  sent_at timestamptz,
  acked_by uuid,
  acked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index alert_open_idx on public.alert (created_at desc) where acked_at is null;
create unique index alert_dedupe_idx on public.alert (dedupe_key) where dedupe_key is not null and acked_at is null;

create or replace function app.raise_alert(
  p_rule text, p_severity text, p_realtime boolean, p_payload jsonb,
  p_entity_type text default null, p_entity_id uuid default null, p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare v_id uuid;
begin
  insert into alert (rule, severity, realtime, entity_type, entity_id, payload, dedupe_key, created_by)
  values (p_rule, p_severity, p_realtime, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb), p_dedupe, app.uid())
  on conflict (dedupe_key) where dedupe_key is not null and acked_at is null do nothing
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Transaction type registry (§4.2) and role permissions (§12.1)
-- ---------------------------------------------------------------------------
create table public.txn_type_def (
  txn_type text primary key,
  from_virtual text,            -- fixed virtual source location code, if any
  to_virtual text,              -- fixed virtual destination location code, if any
  from_types text[],            -- allowed real source location types
  to_types text[],              -- allowed real destination location types
  same_location boolean not null default false,   -- zero-distance status change
  from_status text,
  to_status text,
  reason_required boolean not null default false,
  description text
);
insert into public.txn_type_def values
  ('opening_balance','V-ADJUSTMENT',null,null,'{block_lane,pick_face,dock,staging,consignment}',false,null,null,false,'go-live count'),
  ('receipt_purchase','V-SUPPLIER',null,null,'{dock}',false,null,'quarantine',false,'inbound scan'),
  ('receipt_production','V-PRODUCTION',null,null,'{dock}',false,null,'quarantine',false,'production output scan'),
  ('qc_release',null,null,null,null,true,'quarantine','available',false,'QC decision'),
  ('qc_reject',null,null,null,null,true,'quarantine','blocked',true,'QC decision'),
  ('putaway',null,null,'{dock}','{block_lane,pick_face}',false,null,null,false,'scan'),
  ('transfer',null,null,'{block_lane,pick_face,dock,staging}','{block_lane,pick_face,dock,staging}',false,null,null,false,'scan'),
  ('pick',null,null,'{block_lane,pick_face}','{staging}',false,'available','available',false,'pick task'),
  ('ship',null,'V-CUSTOMER','{staging}',null,false,'available','available',false,'truck close'),
  ('issue_free_goods',null,'V-CUSTOMER','{staging}',null,false,'available','available',false,'truck close, free lines'),
  ('consign_out',null,null,'{staging}','{consignment}',false,'available','available',false,'truck close'),
  ('consignment_consume',null,'V-CONSIGNMENT-SOLD','{consignment}',null,false,'available','available',false,'dealer sale or count'),
  ('consign_return',null,null,'{consignment}','{dock}',false,'available','quarantine',false,'return receipt'),
  ('customer_return','V-CUSTOMER',null,null,'{dock}',false,null,'quarantine',false,'return receipt'),
  ('kit_assemble',null,null,'{block_lane,pick_face,dock,staging}','{block_lane,pick_face,dock,staging}',false,null,null,false,'assembly order'),
  ('count_adjust',null,null,'{block_lane,pick_face,dock,staging,consignment}','{block_lane,pick_face,dock,staging,consignment}',false,null,null,true,'approved count variance'),
  ('expiry_block',null,null,null,null,true,'available','blocked_expiry',false,'nightly job'),
  ('scrap',null,'V-SCRAP','{block_lane,pick_face,dock,staging,consignment}',null,false,null,null,true,'approved request'),
  ('reversal',null,null,null,null,false,null,null,true,'correction');

create table public.txn_permission (
  role text not null,
  txn_type text not null references public.txn_type_def (txn_type),
  primary key (role, txn_type)
);
insert into public.txn_permission (role, txn_type)
select r, t from (values
  ('operator', array['receipt_purchase','receipt_production','putaway','transfer','pick','ship','issue_free_goods','consign_out','consign_return','customer_return','kit_assemble','opening_balance']),
  ('qc', array['qc_release','qc_reject','expiry_block']),
  ('sales_rep', array['consignment_consume']),
  ('ops_manager', array['opening_balance','receipt_purchase','receipt_production','qc_release','qc_reject','putaway','transfer','pick','ship','issue_free_goods','consign_out','consignment_consume','consign_return','customer_return','kit_assemble','count_adjust','expiry_block','scrap','reversal']),
  ('owner', array['opening_balance','receipt_purchase','receipt_production','qc_release','qc_reject','putaway','transfer','pick','ship','issue_free_goods','consign_out','consignment_consume','consign_return','customer_return','kit_assemble','count_adjust','expiry_block','scrap','reversal'])
) as p(r, ts), unnest(ts) as t;

-- ---------------------------------------------------------------------------
-- Ledger tables
-- ---------------------------------------------------------------------------
create table public.stock_txn (
  id uuid primary key default gen_random_uuid(),
  txn_type text not null references public.txn_type_def (txn_type),
  ref_doc_type text,
  ref_doc_id text,
  event_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  user_id uuid,
  device_id text,
  client_uuid uuid not null unique,                          -- invariant 4
  reason_code text,
  reverses_txn_id uuid unique references public.stock_txn (id),  -- invariant 7: reversed once
  campaign_id uuid,
  party_id uuid references public.party (id),
  approval_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index stock_txn_ref_idx on public.stock_txn (ref_doc_type, ref_doc_id);
create index stock_txn_event_idx on public.stock_txn (event_at);

create table public.stock_move (
  id uuid primary key default gen_random_uuid(),
  txn_id uuid not null references public.stock_txn (id),
  line_no int not null,
  item_id uuid not null references public.item (id),
  lot_id uuid references public.lot (id),
  location_id uuid not null references public.location (id),
  owner_id uuid not null references public.party (id),
  stock_status text not null check (stock_status in ('quarantine','available','blocked','blocked_expiry')),
  qty_base numeric(14,3) not null check (qty_base <> 0),      -- signed
  uom_entered text,
  qty_entered numeric(14,3),
  scan_method text not null default 'scan' check (scan_method in ('scan','manual','system')),
  pallet_id uuid references public.pallet (id),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index stock_move_txn_idx on public.stock_move (txn_id);
create index stock_move_item_idx on public.stock_move (item_id, lot_id, location_id);
create index stock_move_loc_idx on public.stock_move (location_id);

create table public.stock_balance (
  item_id uuid not null references public.item (id),
  lot_id uuid references public.lot (id),
  lot_key uuid generated always as (coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  location_id uuid not null references public.location (id),
  owner_id uuid not null references public.party (id),
  stock_status text not null,
  qty_base numeric(14,3) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (item_id, lot_key, location_id, owner_id, stock_status)
);
create index stock_balance_loc_idx on public.stock_balance (location_id) where qty_base <> 0;
create index stock_balance_lot_idx on public.stock_balance (lot_id) where qty_base <> 0;

-- Invariant 2: INSERT only. Privileges are revoked from every API role and a
-- trigger refuses UPDATE / DELETE / TRUNCATE even for the table owner.
create trigger trg_stock_txn_immutable before update or delete on public.stock_txn
  for each row execute function app.forbid_change();
create trigger trg_stock_move_immutable before update or delete on public.stock_move
  for each row execute function app.forbid_change();
create trigger trg_stock_txn_no_truncate before truncate on public.stock_txn
  for each statement execute function app.forbid_change();
create trigger trg_stock_move_no_truncate before truncate on public.stock_move
  for each statement execute function app.forbid_change();
revoke all on public.stock_txn, public.stock_move, public.stock_balance from public, anon, authenticated, service_role;
grant select on public.stock_txn, public.stock_move, public.stock_balance to authenticated, service_role;

-- Balances are maintained by trigger; invariant 3: never negative on a real location.
create or replace function app.stock_move_apply() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  v_qty numeric;
  v_type text;
begin
  insert into stock_balance as b (item_id, lot_id, location_id, owner_id, stock_status, qty_base)
  values (new.item_id, new.lot_id, new.location_id, new.owner_id, new.stock_status, new.qty_base)
  on conflict (item_id, lot_key, location_id, owner_id, stock_status)
  do update set qty_base = b.qty_base + excluded.qty_base, updated_at = now()
  returning b.qty_base into v_qty;
  if v_qty < 0 then
    select type into v_type from location where id = new.location_id;
    if v_type <> 'virtual' then
      raise exception 'NEGATIVE_BALANCE: % short at %', -v_qty,
        (select code from location where id = new.location_id)
        using errcode = 'P0001', hint = 'NEGATIVE_BALANCE';
    end if;
  end if;
  return new;
end $$;
create trigger trg_stock_move_apply after insert on public.stock_move
  for each row execute function app.stock_move_apply();

-- Invariant 1: per transaction, sum(qty_base) grouped by (item, lot) is zero.
create or replace function app.stock_txn_balanced() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from public.stock_move m where m.txn_id = new.txn_id
    group by m.item_id, m.lot_id having sum(m.qty_base) <> 0
  ) then
    raise exception 'UNBALANCED: transaction % does not sum to zero per item and lot', new.txn_id
      using errcode = 'P0001', hint = 'UNBALANCED';
  end if;
  return null;
end $$;
create constraint trigger trg_stock_txn_balanced after insert on public.stock_move
  deferrable initially deferred for each row execute function app.stock_txn_balanced();

-- ---------------------------------------------------------------------------
-- Reservations (§4.4): the only place reserved quantity is stored.
-- ---------------------------------------------------------------------------
create table public.reservation (
  id uuid primary key default gen_random_uuid(),
  demand_line_id uuid,                 -- so_line.id (null for campaign ring-fences)
  shipment_id uuid,
  party_id uuid references public.party (id),
  item_id uuid not null references public.item (id),
  lot_id uuid references public.lot (id),
  location_id uuid references public.location (id),
  qty_base numeric(14,3) not null check (qty_base >= 0),   -- remaining reserved quantity
  original_qty numeric(14,3),
  type text not null check (type in ('soft','hard')),
  campaign_id uuid,
  need_date date,
  expires_at timestamptz,
  state text not null default 'active' check (state in ('active','consumed','released','expired')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (type = 'soft' or (location_id is not null)),
  check (type = 'hard' or (lot_id is null and location_id is null))
);
create index reservation_item_idx on public.reservation (item_id) where state = 'active';
create index reservation_line_idx on public.reservation (demand_line_id);
create index reservation_shipment_idx on public.reservation (shipment_id);
select app.track('public.reservation');

-- Central stock a customer order may draw on: Dayson-owned, status available,
-- in lanes, pick faces or on the dock. Consignment and staging are excluded.
create or replace view public.v_central_stock as
select b.item_id, b.lot_id, b.location_id, l.type as location_type, l.code as location_code,
       b.qty_base, lot.expiry_date, lot.band
from public.stock_balance b
join public.location l on l.id = b.location_id
left join public.lot on lot.id = b.lot_id
where b.stock_status = 'available'
  and b.owner_id = app.dayson()
  and l.type in ('block_lane','pick_face','dock')
  and b.qty_base > 0;

-- Available to reserve = available on hand - hard - soft. A view, never a stored column.
create or replace view public.v_available as
select i.id as item_id, i.sku,
       coalesce(s.on_hand, 0) as on_hand_available,
       coalesce(r.hard, 0) as hard_reserved,
       coalesce(r.soft, 0) as soft_reserved,
       coalesce(s.on_hand, 0) - coalesce(r.hard, 0) - coalesce(r.soft, 0) as available_to_reserve
from public.item i
left join (select item_id, sum(qty_base) as on_hand from public.v_central_stock group by item_id) s on s.item_id = i.id
left join (
  select item_id,
         sum(qty_base) filter (where type = 'hard') as hard,
         sum(qty_base) filter (where type = 'soft' and (expires_at is null or expires_at > now())) as soft
  from public.reservation where state = 'active' group by item_id
) r on r.item_id = i.id;

-- Per lot and lane: quantity still free of hard reservations (used by allocation and put-away).
create or replace view public.v_lot_free as
select s.item_id, s.lot_id, s.location_id, s.location_type, s.location_code, s.expiry_date, s.band,
       s.qty_base,
       s.qty_base - coalesce((
         select sum(r.qty_base) from public.reservation r
          where r.state = 'active' and r.type = 'hard' and r.item_id = s.item_id
            and r.lot_id is not distinct from s.lot_id and r.location_id = s.location_id), 0) as free_qty
from public.v_central_stock s;

-- ---------------------------------------------------------------------------
-- post_txn
-- ---------------------------------------------------------------------------
create or replace function app.txn_result(p_txn uuid, p_duplicate boolean default false) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select jsonb_build_object(
    'txn_id', t.id,
    'txn_type', t.txn_type,
    'duplicate', p_duplicate,
    'moves', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_no', m.line_no, 'item_id', m.item_id, 'lot_id', m.lot_id, 'location_id', m.location_id,
        'location', l.code, 'stock_status', m.stock_status, 'qty_base', m.qty_base, 'pallet_id', m.pallet_id)
        order by m.line_no, m.qty_base)
      from stock_move m join location l on l.id = m.location_id where m.txn_id = t.id), '[]'::jsonb),
    'balances_after', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', b.item_id, 'lot_id', b.lot_id, 'location', l.code, 'stock_status', b.stock_status, 'qty_base', b.qty_base))
      from stock_balance b join location l on l.id = b.location_id
      where l.type <> 'virtual' and exists (
        select 1 from stock_move m where m.txn_id = t.id and m.item_id = b.item_id
          and m.lot_id is not distinct from b.lot_id and m.location_id = b.location_id
          and m.owner_id = b.owner_id and m.stock_status = b.stock_status)), '[]'::jsonb))
  from stock_txn t where t.id = p_txn
$$;

-- Which status holds the stock we are about to move, when the caller did not say.
create or replace function app.infer_status(p_item uuid, p_lot uuid, p_loc uuid, p_owner uuid, p_qty numeric)
returns text language sql stable as $$
  select stock_status from public.stock_balance
   where item_id = p_item and lot_id is not distinct from p_lot and location_id = p_loc and owner_id = p_owner
     and qty_base > 0
   order by (qty_base >= p_qty) desc, qty_base desc limit 1
$$;

-- Internal implementation. p_trusted = true is used only by other database functions
-- that have already checked role and approval (truck close, approvals, nightly jobs).
create or replace function app.post_txn_internal(p_txn jsonb, p_trusted boolean default false) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_role text := app.user_role();
  v_client uuid := (p_txn->>'client_uuid')::uuid;
  v_type text := p_txn->>'txn_type';
  v_def txn_type_def;
  v_event timestamptz := coalesce((p_txn->>'event_at')::timestamptz, now());
  v_reason text := nullif(p_txn->>'reason_code', '');
  v_party uuid := (p_txn->>'party_id')::uuid;
  v_approval uuid := (p_txn->>'approval_id')::uuid;
  v_txn uuid;
  v_orig stock_txn;
  v_line jsonb;
  v_no int := 0;
  v_item item;
  v_lot lot;
  v_pallet pallet;
  v_from uuid; v_to uuid;
  v_from_loc location; v_to_loc location;
  v_from_status text; v_to_status text;
  v_owner uuid; v_to_owner uuid;
  v_qty numeric;
  v_uom text;
  v_scan text;
  v_mrsl numeric;
  v_ship_date date;
  v_value numeric;
  v_ok boolean;
begin
  if v_role is null then perform app.fail('NOT_PERMITTED', 'unknown user'); end if;
  if v_client is null then perform app.fail('INVALID', 'client_uuid is required'); end if;

  -- invariant 4: a repeated client_uuid returns the original result
  select id into v_txn from stock_txn where client_uuid = v_client;
  if v_txn is not null then
    return app.txn_result(v_txn, true);
  end if;

  select * into v_def from txn_type_def where txn_type = v_type;
  if v_def.txn_type is null then perform app.fail('INVALID', format('unknown txn_type %s', v_type)); end if;

  if not p_trusted and v_role <> 'system'
     and not exists (select 1 from txn_permission where role = v_role and txn_type = v_type) then
    perform app.fail('NOT_PERMITTED', format('role %s may not post %s', v_role, v_type));
  end if;

  if v_event > now() + interval '5 minutes' then
    perform app.fail('INVALID', 'event_at is in the future');
  end if;
  -- invariant 8: backdating needs a reason code; older than N days needs approval
  if v_event < now() - make_interval(mins => app.param_num('backdate_reason_minutes')::int) and v_reason is null then
    perform app.fail('REASON_REQUIRED', 'event_at is earlier than recorded_at; a reason code is required');
  end if;
  if v_def.reason_required and v_reason is null then
    perform app.fail('REASON_REQUIRED', format('%s needs a reason code', v_type));
  end if;
  if not p_trusted and v_role <> 'system'
     and v_event < now() - make_interval(days => app.param_num('backdate_approval_days')::int) then
    select exists (select 1 from approval_request a where a.id = v_approval and a.type = 'backdate' and a.state = 'approved') into v_ok;
    if not v_ok then
      perform app.fail('APPROVAL_REQUIRED', 'backdated transaction older than the allowed days needs ops manager approval');
    end if;
  end if;
  if v_type = 'scrap' and not p_trusted and v_role <> 'system' then
    select exists (select 1 from approval_request a where a.id = v_approval and a.type = 'scrap' and a.state = 'approved') into v_ok;
    if not v_ok then
      perform app.fail('APPROVAL_REQUIRED', 'scrap needs an approved request');
    end if;
  end if;

  -- invariant 7: reversal mirrors the original; a transaction can be reversed once
  if v_type = 'reversal' then
    select * into v_orig from stock_txn where id = (p_txn->>'reverses_txn_id')::uuid;
    if v_orig.id is null then perform app.fail('INVALID', 'reverses_txn_id not found'); end if;
    if v_orig.txn_type = 'reversal' then perform app.fail('INVALID', 'a reversal cannot be reversed'); end if;
    if exists (select 1 from stock_txn where reverses_txn_id = v_orig.id) then
      perform app.fail('ALREADY_REVERSED', 'this transaction has already been reversed');
    end if;
    insert into stock_txn (txn_type, ref_doc_type, ref_doc_id, event_at, user_id, device_id, client_uuid,
                           reason_code, reverses_txn_id, campaign_id, party_id, created_by)
    values ('reversal', v_orig.ref_doc_type, v_orig.ref_doc_id, v_event, app.uid(), p_txn->>'device_id', v_client,
            v_reason, v_orig.id, v_orig.campaign_id, v_orig.party_id, app.uid())
    returning id into v_txn;
    insert into stock_move (txn_id, line_no, item_id, lot_id, location_id, owner_id, stock_status, qty_base,
                            uom_entered, qty_entered, scan_method, pallet_id, created_by)
    select v_txn, m.line_no, m.item_id, m.lot_id, m.location_id, m.owner_id, m.stock_status, -m.qty_base,
           m.uom_entered, m.qty_entered, 'system', m.pallet_id, app.uid()
      from stock_move m where m.txn_id = v_orig.id order by m.line_no, m.qty_base desc;
    set constraints trg_stock_txn_balanced immediate;
    set constraints trg_stock_txn_balanced deferred;
    perform app.lanes_refresh(array(select distinct location_id from stock_move where txn_id = v_txn));
    return app.txn_result(v_txn);
  end if;

  if jsonb_typeof(p_txn->'lines') <> 'array' or jsonb_array_length(p_txn->'lines') = 0 then
    perform app.fail('INVALID', 'at least one line is required');
  end if;

  insert into stock_txn (txn_type, ref_doc_type, ref_doc_id, event_at, user_id, device_id, client_uuid,
                         reason_code, campaign_id, party_id, approval_id, created_by)
  values (v_type, p_txn->>'ref_doc_type', p_txn->>'ref_doc_id', v_event, app.uid(), p_txn->>'device_id', v_client,
          v_reason, (p_txn->>'campaign_id')::uuid, v_party, v_approval, app.uid())
  returning id into v_txn;

  for v_line in select * from jsonb_array_elements(p_txn->'lines') loop
    v_no := v_no + 1;
    v_pallet := null;
    if v_line ? 'pallet_id' or v_line ? 'pallet_serial' then
      select * into v_pallet from pallet
       where (v_line ? 'pallet_id' and id = (v_line->>'pallet_id')::uuid)
          or (v_line ? 'pallet_serial' and serial = v_line->>'pallet_serial')
       for update;
      if v_pallet.id is null then perform app.fail('UNKNOWN_PALLET', coalesce(v_line->>'pallet_serial', v_line->>'pallet_id')); end if;
    end if;

    select * into v_item from item where id = coalesce((v_line->>'item_id')::uuid, v_pallet.item_id);
    if v_item.id is null then perform app.fail('UNKNOWN_ITEM', coalesce(v_line->>'item_id', '')); end if;
    v_lot := null;
    if coalesce((v_line->>'lot_id')::uuid, v_pallet.lot_id) is not null then
      select * into v_lot from lot where id = coalesce((v_line->>'lot_id')::uuid, v_pallet.lot_id);
      if v_lot.id is null or v_lot.item_id <> v_item.id then
        perform app.fail('INVALID', 'lot does not belong to the item');
      end if;
    end if;
    -- invariant 6
    if v_item.lot_expiry_controlled and (v_lot.id is null or v_lot.expiry_date is null) then
      perform app.fail('LOT_REQUIRED', format('%s is expiry-controlled: a lot with an expiry date is required', v_item.sku));
    end if;

    v_uom := coalesce(v_line->>'uom', v_item.base_uom);
    if v_line ? 'qty_entered' then
      v_qty := app.to_base(v_item.id, (v_line->>'qty_entered')::numeric, v_uom, v_lot.id);
    elsif v_pallet.id is not null then
      v_qty := v_pallet.qty_base;
      v_uom := v_item.base_uom;
    else
      perform app.fail('INVALID', 'qty_entered is required');
    end if;
    if v_qty is null or v_qty <= 0 then perform app.fail('INVALID', 'quantity must be positive'); end if;
    v_scan := coalesce(v_line->>'scan_method', 'scan');

    -- locations
    if v_def.same_location then
      v_from := app.loc(coalesce(v_line->>'location', v_line->>'from_location', v_line->>'to_location'));
      if v_from is null and v_pallet.id is not null then v_from := v_pallet.location_id; end if;
      v_to := v_from;
    else
      v_from := app.loc(coalesce(v_def.from_virtual, v_line->>'from_location'));
      if v_from is null and v_pallet.id is not null then v_from := v_pallet.location_id; end if;
      v_to := app.loc(coalesce(v_def.to_virtual, v_line->>'to_location'));
    end if;
    if v_from is null or v_to is null then perform app.fail('INVALID', 'from_location and to_location are required'); end if;
    select * into v_from_loc from location where id = v_from;
    select * into v_to_loc from location where id = v_to;
    if v_from_loc.id is null or v_to_loc.id is null then perform app.fail('UNKNOWN_LOCATION', ''); end if;

    if not v_def.same_location then
      if v_type in ('kit_assemble','count_adjust') then
        -- one side is the virtual counterpart, the other a real location
        if not ((v_from_loc.type = 'virtual') <> (v_to_loc.type = 'virtual')) then
          perform app.fail('INVALID_LOCATION', format('%s moves between a real location and its virtual counterpart', v_type));
        end if;
        if (v_type = 'kit_assemble' and 'V-PRODUCTION' not in (v_from_loc.code, v_to_loc.code))
           or (v_type = 'count_adjust' and 'V-ADJUSTMENT' not in (v_from_loc.code, v_to_loc.code)) then
          perform app.fail('INVALID_LOCATION', 'wrong virtual location');
        end if;
      else
        if v_def.from_virtual is null and not (v_from_loc.type = any (v_def.from_types)) then
          perform app.fail('INVALID_LOCATION', format('%s cannot take stock from a %s location', v_type, v_from_loc.type));
        end if;
        if v_def.to_virtual is null and not (v_to_loc.type = any (v_def.to_types)) then
          perform app.fail('INVALID_LOCATION', format('%s cannot move stock to a %s location', v_type, v_to_loc.type));
        end if;
        if v_from = v_to then perform app.fail('INVALID_LOCATION', 'source and destination are the same'); end if;
      end if;
    elsif v_from_loc.type = 'virtual' then
      perform app.fail('INVALID_LOCATION', 'status changes happen at a real location');
    end if;

    v_owner := coalesce((v_line->>'owner_id')::uuid, app.dayson());
    v_to_owner := coalesce((v_line->>'to_owner_id')::uuid, v_owner);

    -- lock lanes involved so the one-lot-per-lane rule holds under concurrency
    perform 1 from location where id in (v_from, v_to) and type = 'block_lane' order by id for update;

    -- statuses; the virtual side mirrors the real side
    v_from_status := coalesce(v_line->>'from_status', v_def.from_status);
    v_to_status := coalesce(v_line->>'to_status', v_def.to_status);
    if v_from_loc.type = 'virtual' then
      v_to_status := coalesce(v_to_status, v_line->>'status', 'available');
      v_from_status := v_to_status;
    else
      v_from_status := coalesce(v_from_status, v_line->>'status',
                                app.infer_status(v_item.id, v_lot.id, v_from, v_owner, v_qty), 'available');
      if v_to_loc.type = 'virtual' then
        v_to_status := v_from_status;
      else
        v_to_status := coalesce(v_to_status, v_from_status);
      end if;
    end if;
    if v_def.same_location and v_from_status = v_to_status then
      perform app.fail('INVALID', 'status change needs two different statuses');
    end if;
    if v_type in ('pick','ship','issue_free_goods','consign_out','consignment_consume') and v_from_status <> 'available' then
      perform app.fail('NOT_AVAILABLE', 'only available stock can be picked or shipped');
    end if;
    if v_type = 'opening_balance' and v_to_status not in ('available','quarantine') then
      perform app.fail('INVALID', 'opening balance is available or quarantine');
    end if;

    -- invariant 5: one item and one lot per block-stack lane
    if v_to_loc.type = 'block_lane' and exists (
        select 1 from stock_balance b
         where b.location_id = v_to and b.qty_base > 0
           and (b.item_id <> v_item.id or b.lot_id is distinct from v_lot.id)) then
      perform app.fail('LANE_MIXED', format('lane %s already holds another item or lot', v_to_loc.code));
    end if;

    -- minimum remaining shelf life when stock leaves for a customer (§7.2)
    if v_party is not null and v_lot.expiry_date is not null
       and v_type in ('pick','ship','issue_free_goods','consign_out') then
      v_ship_date := coalesce((p_txn->>'ship_date')::date, (v_event at time zone 'Europe/Istanbul')::date);
      v_mrsl := app.param_num('mrsl_days', jsonb_build_object(
        'party_id', v_party, 'item_id', v_item.id,
        'shipment_id', case when p_txn->>'ref_doc_type' = 'shipment' then p_txn->>'ref_doc_id' end));
      if v_mrsl is not null and (v_lot.expiry_date - v_ship_date) < v_mrsl then
        perform app.fail('MRSL_BLOCKED', format('lot %s has %s days left, customer needs %s',
          v_lot.lot_no, v_lot.expiry_date - v_ship_date, v_mrsl));
      end if;
    end if;

    -- count adjustments above the EUR threshold need a second approver (§5.5)
    if v_type = 'count_adjust' and not p_trusted and v_role <> 'system' then
      v_value := v_qty * coalesce(app.item_cost(v_item.id), 0);
      if v_value > coalesce(app.param_num('adjust_approval_eur', jsonb_build_object('item_id', v_item.id)), 0) then
        select exists (select 1 from approval_request a where a.id = v_approval and a.type = 'count_adjust' and a.state = 'approved') into v_ok;
        if not v_ok then
          perform app.fail('APPROVAL_REQUIRED', format('adjustment worth EUR %s needs a second approver', round(v_value, 2)));
        end if;
      end if;
    end if;

    insert into stock_move (txn_id, line_no, item_id, lot_id, location_id, owner_id, stock_status, qty_base,
                            uom_entered, qty_entered, scan_method, pallet_id, created_by)
    values
      (v_txn, v_no, v_item.id, v_lot.id, v_from, v_owner, v_from_status, -v_qty, v_uom,
       coalesce((v_line->>'qty_entered')::numeric, v_qty), v_scan, v_pallet.id, app.uid()),
      (v_txn, v_no, v_item.id, v_lot.id, v_to, v_to_owner, v_to_status, v_qty, v_uom,
       coalesce((v_line->>'qty_entered')::numeric, v_qty), v_scan, v_pallet.id, app.uid());

    -- pallet index upkeep
    if v_pallet.id is not null and not v_def.same_location then
      update pallet
         set location_id = case when v_to_loc.type = 'virtual' then null else v_to end,
             status = case
               when v_to_loc.code = 'V-CUSTOMER' then 'shipped'
               when v_to_loc.code = 'V-SCRAP' then 'scrapped'
               when v_to_loc.code in ('V-PRODUCTION','V-CONSIGNMENT-SOLD','V-ADJUSTMENT') then 'consumed'
               else status end,
             qty_base = case when v_qty < qty_base and v_to_loc.type = 'virtual' then qty_base - v_qty else qty_base end
       where id = v_pallet.id;
    end if;
  end loop;

  -- surface an unbalanced transaction now rather than at commit
  set constraints trg_stock_txn_balanced immediate;
  set constraints trg_stock_txn_balanced deferred;

  perform app.lanes_refresh(array(select distinct location_id from stock_move where txn_id = v_txn));
  return app.txn_result(v_txn);
end $$;

-- Keep location.lane_item_id / lane_lot_id in step with what the lane holds, and raise a
-- zero-check count when a lane is emptied (§5.5).
create or replace function app.lanes_refresh(p_locations uuid[]) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  r record;
  v_item uuid; v_lot uuid;
begin
  for r in select * from location where id = any (p_locations) and type = 'block_lane' loop
    select b.item_id, b.lot_id into v_item, v_lot
      from stock_balance b where b.location_id = r.id and b.qty_base > 0 limit 1;
    if v_item is null and r.lane_item_id is not null then
      update location set lane_item_id = null, lane_lot_id = null where id = r.id;
      if to_regclass('public.count_task') is not null then
        execute 'insert into public.count_task (location_id, item_id, lot_id, trigger, state)
                 select $1, $2, $3, ''lane_emptied'', ''open''
                 where not exists (select 1 from public.count_task
                                    where location_id = $1 and trigger = ''lane_emptied'' and state in (''open'',''recount''))'
          using r.id, r.lane_item_id, r.lane_lot_id;
      end if;
    elsif v_item is not null and (r.lane_item_id is distinct from v_item or r.lane_lot_id is distinct from v_lot) then
      update location set lane_item_id = v_item, lane_lot_id = v_lot where id = r.id;
    end if;
  end loop;
end $$;

-- Public entry point. Business refusals are returned as {"error": CODE, "message": ...}
-- so the refusal itself (alert, exception count) can be recorded; everything the failed
-- transaction wrote is rolled back.
create or replace function public.post_txn(txn jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_msg text; v_code text; v_txn uuid; v_loc uuid;
begin
  begin
    return app.post_txn_internal(txn, false);
  exception
    when unique_violation then
      select id into v_txn from stock_txn where client_uuid = (txn->>'client_uuid')::uuid;
      if v_txn is not null then return app.txn_result(v_txn, true); end if;
      raise;
    when sqlstate 'P0001' then
      get stacked diagnostics v_msg = message_text;
      v_code := split_part(v_msg, ':', 1);
  end;
  if v_code in ('NEGATIVE_BALANCE','UNBALANCED','MRSL_BLOCKED') then
    perform app.raise_alert(lower(v_code), 'critical', true,
      jsonb_build_object('message', v_msg, 'txn', txn, 'user_id', app.uid()));
  end if;
  if v_code = 'NEGATIVE_BALANCE' and to_regclass('public.count_task') is not null then
    begin
      v_loc := app.loc(coalesce(txn->'lines'->0->>'from_location', txn->'lines'->0->>'location'));
      if v_loc is not null and (select type from location where id = v_loc) <> 'virtual' then
        execute 'insert into public.count_task (location_id, item_id, lot_id, trigger, state)
                 select $1, $2, $3, ''exception'', ''open''
                 where not exists (select 1 from public.count_task
                                    where location_id = $1 and trigger = ''exception'' and state in (''open'',''recount''))'
          using v_loc, (txn->'lines'->0->>'item_id')::uuid, (txn->'lines'->0->>'lot_id')::uuid;
      end if;
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('error', v_code, 'message', v_msg);
end $$;

-- Invariant 9: rebuild balances from the ledger and compare; any difference is critical.
create or replace function public.rpc_rebuild_check() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_diff int;
  v_sample jsonb;
begin
  perform app.require_role('owner','ops_manager','finance','auditor');
  create temp table if not exists _shadow_balance on commit drop as
    select item_id, lot_id, location_id, owner_id, stock_status, sum(qty_base) as qty_base
      from stock_move group by 1,2,3,4,5;
  with d as (
    select coalesce(s.item_id, b.item_id) as item_id, coalesce(s.lot_id, b.lot_id) as lot_id,
           coalesce(s.location_id, b.location_id) as location_id,
           coalesce(s.stock_status, b.stock_status) as stock_status,
           coalesce(s.qty_base, 0) as ledger_qty, coalesce(b.qty_base, 0) as balance_qty
      from _shadow_balance s
      full join stock_balance b
        on b.item_id = s.item_id and b.lot_id is not distinct from s.lot_id
       and b.location_id = s.location_id and b.owner_id = s.owner_id and b.stock_status = s.stock_status
     where coalesce(s.qty_base, 0) <> coalesce(b.qty_base, 0))
  select (select count(*) from d),
         coalesce((select jsonb_agg(to_jsonb(x)) from (select * from d limit 20) x), '[]'::jsonb)
    into v_diff, v_sample;
  if v_diff > 0 then
    perform app.raise_alert('ledger_rebuild_mismatch', 'critical', true,
      jsonb_build_object('differences', v_diff, 'sample', v_sample), null, null, 'ledger_rebuild_mismatch');
  end if;
  drop table if exists _shadow_balance;
  return jsonb_build_object('differences', v_diff, 'sample', v_sample);
end $$;

-- Readable stock views for the screens. Any number opens the ledger rows behind it
-- through v_stock_moves filtered on the same dimensions (§13.1 traceability).
create or replace view public.v_stock as
select b.item_id, i.sku, i.name as item_name, b.lot_id, lot.lot_no, lot.expiry_date, lot.band, lot.qc_status,
       b.location_id, l.code as location_code, l.type as location_type, l.dealer_id,
       b.owner_id, b.stock_status, b.qty_base,
       round(b.qty_base / nullif(app.units_per_pallet(b.item_id, b.lot_id), 0), 2) as pallets
from public.stock_balance b
join public.item i on i.id = b.item_id
join public.location l on l.id = b.location_id
left join public.lot on lot.id = b.lot_id
where b.qty_base <> 0 and l.type <> 'virtual';

create or replace view public.v_stock_moves as
select m.id, m.txn_id, t.txn_type, t.event_at, t.recorded_at, t.user_id, u.full_name as user_name, t.device_id,
       t.reason_code, t.ref_doc_type, t.ref_doc_id, t.reverses_txn_id,
       m.line_no, m.item_id, i.sku, m.lot_id, lot.lot_no, m.location_id, l.code as location_code,
       m.owner_id, m.stock_status, m.qty_base, m.uom_entered, m.qty_entered, m.scan_method, m.pallet_id
from public.stock_move m
join public.stock_txn t on t.id = m.txn_id
join public.item i on i.id = m.item_id
join public.location l on l.id = m.location_id
left join public.lot on lot.id = m.lot_id
left join public.app_user u on u.id = t.user_id;
