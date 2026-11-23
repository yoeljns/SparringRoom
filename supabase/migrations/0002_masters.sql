-- 0002 Masters (spec §3.1) plus the per-lot / per-pallet variation tables of §3.8.

create table public.market (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  transit_days int not null default 0,
  label_language text not null default 'tr',
  is_domestic boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.item_family (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  attr_schema jsonb not null default '{}'::jsonb,   -- JSON Schema for item.attributes
  sku_pattern text,                                  -- regex the SKU must match
  default_policy text check (default_policy in ('continuous','periodic','empirical','to_order')),
  shelf_life_days int,                               -- family default (lookup chain §3.8)
  group_attribute text,                              -- attribute naming the colour/size group
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.item (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,                                -- Turkish description
  gtin text,
  family_id uuid not null references public.item_family (id),
  brand text,
  attributes jsonb not null default '{}'::jsonb,
  base_uom text not null default 'piece',
  lot_expiry_controlled boolean not null default false,
  shelf_life_days int,
  max_stack_height int,
  sellable boolean not null default true,
  lifecycle text not null default 'mature' check (lifecycle in ('launch','growth','mature','phase_out')),
  logo_item_code text unique,
  logo_name text,
  logo_unit text,
  logo_active boolean,
  replaces_item_id uuid references public.item (id),
  volume_justification text,
  analog_item_id uuid references public.item (id),  -- similar SKU for launch forecasts
  zone text,
  depth_class int,
  production_line text,                              -- set for items Dayson produces
  export_contract boolean not null default false,
  active boolean not null default true,
  needs_review boolean not null default false,       -- set by Logo import for new/changed items
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index item_family_idx on public.item (family_id);

-- Attributes are validated against the family schema; SKU against the family pattern.
create or replace function app.item_validate() returns trigger
language plpgsql as $$
declare
  v_fam public.item_family;
  v_err text[];
begin
  select * into v_fam from public.item_family where id = new.family_id;
  v_err := app.validate_json(v_fam.attr_schema, new.attributes);
  if array_length(v_err, 1) > 0 then
    perform app.fail('INVALID_ATTRIBUTES', array_to_string(v_err, '; '));
  end if;
  if v_fam.sku_pattern is not null and new.sku !~ v_fam.sku_pattern then
    perform app.fail('INVALID_SKU', format('%s does not match the %s pattern', new.sku, v_fam.code));
  end if;
  return new;
end $$;
create trigger trg_item_validate before insert or update of sku, attributes, family_id on public.item
  for each row execute function app.item_validate();

create table public.uom_pack (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item (id) on delete cascade,
  level text not null check (level in ('piece','carton','pallet')),
  qty_base numeric(14,3) not null check (qty_base > 0),
  gross_kg numeric(14,3),
  length_mm int,
  width_mm int,
  height_mm int,
  logo_unit text,                                    -- Logo unit code that maps to this level
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (item_id, level)
);

-- Named pallet configurations (§3.8): one item may have several.
create table public.pack_config (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item (id) on delete cascade,
  code text not null,
  pallet_type text not null default 'EUR',
  units_per_pallet numeric(14,3) not null check (units_per_pallet > 0),
  gross_kg numeric(14,3),
  footprint text,
  stack_height int,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (item_id, code)
);
create unique index pack_config_one_default on public.pack_config (item_id) where is_default;

create table public.site (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'Europe/Istanbul',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.party (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('dealer','supplier','importer','self')),
  name text not null,
  vkn text,                                          -- required before go-live
  logo_cari_code text unique,
  segment text,                                      -- A / B / C dealer segment
  market_id uuid references public.market (id),
  mrsl_profile text,                                 -- domestic / export / contract
  priority_tier int,
  city text,
  country text,
  consignment boolean not null default false,
  short_cycle boolean not null default false,        -- domestic short-cycle dealer (amber stock first)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Dayson itself: owner of all central and consignment stock.
insert into public.party (id, type, name, logo_cari_code)
values ('00000000-0000-0000-0000-00000000d001', 'self', 'Dayson', 'DAYSON');

create or replace function app.dayson() returns uuid
language sql immutable as $$ select '00000000-0000-0000-0000-00000000d001'::uuid $$;

-- Which dealers a sales rep covers (row-level scope, §12.1).
create table public.rep_dealer (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user (id) on delete cascade,
  party_id uuid not null references public.party (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (user_id, party_id)
);

create table public.lot (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item (id),
  lot_no text not null,
  prod_date date,
  expiry_date date,
  qc_status text not null default 'pending' check (qc_status in ('pending','released','rejected')),
  supplier_lot text,
  actual_pallet_kg numeric(14,3),
  pack_config_id uuid references public.pack_config (id),
  band_override jsonb,                               -- {"amber_days":..,"blocked_days":..}
  band text check (band in ('green','amber','red','blocked')),
  band_as_of date,
  is_kit boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (item_id, lot_no)
);
create index lot_expiry_idx on public.lot (item_id, expiry_date);

create table public.location (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references public.site (id),
  code text not null unique,
  type text not null check (type in ('block_lane','pick_face','staging','dock','consignment','virtual')),
  zone text,
  depth_positions int,
  max_stack_height int,
  depth_class int,
  lane_item_id uuid references public.item (id),
  lane_lot_id uuid references public.lot (id),
  dealer_id uuid references public.party (id),
  pick_min_qty numeric(14,3),
  dock_distance int,
  last_counted_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (type <> 'consignment' or dealer_id is not null),
  check (type <> 'block_lane' or code ~ '^[A-Z]{2}-B[0-9]{2}-L[0-9]{2}$')
);
create index location_type_idx on public.location (type);
create unique index location_one_consignment_per_dealer on public.location (dealer_id) where type = 'consignment';

-- The seven virtual locations (§4.1). They may go negative.
insert into public.location (code, type) values
  ('V-SUPPLIER','virtual'), ('V-PRODUCTION','virtual'), ('V-CUSTOMER','virtual'),
  ('V-IN-TRANSIT','virtual'), ('V-ADJUSTMENT','virtual'), ('V-SCRAP','virtual'),
  ('V-CONSIGNMENT-SOLD','virtual');

create or replace function app.loc(p_code_or_id text) returns uuid
language plpgsql stable as $$
declare v_id uuid;
begin
  if p_code_or_id is null then return null; end if;
  if p_code_or_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return p_code_or_id::uuid;
  end if;
  select id into v_id from public.location where code = p_code_or_id;
  if v_id is null then
    perform app.fail('UNKNOWN_LOCATION', p_code_or_id);
  end if;
  return v_id;
end $$;

create table public.supplier_lane (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.party (id),
  item_family_id uuid references public.item_family (id),
  item_id uuid references public.item (id),
  production_line text,                              -- for Dayson's own production lines
  mode text not null default 'road' check (mode in ('road','sea','air','rail','production')),
  quoted_lt_days numeric(8,2) not null,
  moq numeric(14,3),
  order_multiple numeric(14,3),
  price_breaks jsonb not null default '[]'::jsonb,
  review_days int,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (supplier_id is not null or production_line is not null),
  check (item_family_id is not null or item_id is not null)
);

create table public.vehicle_type (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text,
  min_kg numeric(14,3) not null,
  max_kg numeric(14,3) not null,
  positions jsonb not null default '{}'::jsonb,      -- {"EUR": 33, "IND": 26}
  max_items int,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Pallet: convenience index over the ledger so one scan resolves item, lot, quantity (§6).
create sequence public.pallet_serial_seq;
create table public.pallet (
  id uuid primary key default gen_random_uuid(),
  serial text not null unique check (serial ~ '^[0-9]{18}$'),
  item_id uuid not null references public.item (id),
  lot_id uuid references public.lot (id),
  qty_base numeric(14,3) not null check (qty_base >= 0),
  location_id uuid references public.location (id),
  actual_kg numeric(14,3),
  status text not null default 'active' check (status in ('active','shipped','consumed','scrapped')),
  shipment_id uuid,
  so_line_id uuid,
  loaded_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index pallet_loc_idx on public.pallet (location_id) where status = 'active';
create index pallet_lot_idx on public.pallet (lot_id);
create index pallet_shipment_idx on public.pallet (shipment_id);

-- Item cost in EUR, read from Logo; used only for ABC ranking and EUR thresholds.
create table public.item_cost (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.item (id) on delete cascade,
  cost_eur numeric(14,4) not null,
  as_of date not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (item_id, as_of)
);

create or replace function app.item_cost(p_item uuid) returns numeric
language sql stable as $$
  select cost_eur from public.item_cost where item_id = p_item order by as_of desc limit 1
$$;

-- Lot rules: expiry mandatory for expiry-controlled items, defaulted through the
-- chain lot -> item shelf life -> family default; never changes after first move.
create or replace function app.lot_validate() returns trigger
language plpgsql as $$
declare
  v_item public.item;
  v_shelf int;
begin
  select * into v_item from public.item where id = new.item_id;
  if tg_op = 'INSERT' and new.expiry_date is null and v_item.lot_expiry_controlled then
    v_shelf := coalesce(v_item.shelf_life_days,
                        (select shelf_life_days from public.item_family where id = v_item.family_id));
    if new.prod_date is not null and v_shelf is not null then
      new.expiry_date := new.prod_date + v_shelf;
    end if;
  end if;
  if v_item.lot_expiry_controlled and new.expiry_date is null then
    perform app.fail('LOT_REQUIRED', format('lot %s of an expiry-controlled item needs an expiry date', new.lot_no));
  end if;
  return new;
end $$;
create trigger trg_lot_validate before insert or update on public.lot
  for each row execute function app.lot_validate();

-- Units per pallet / pallet weight lookups (§3.8 chains).
create or replace function app.units_per_pallet(p_item uuid, p_lot uuid default null) returns numeric
language sql stable as $$
  select coalesce(
    (select pc.units_per_pallet from public.lot l join public.pack_config pc on pc.id = l.pack_config_id where l.id = p_lot),
    (select units_per_pallet from public.pack_config where item_id = p_item and is_default),
    (select qty_base from public.uom_pack where item_id = p_item and level = 'pallet'))
$$;

-- Returns {"kg": n, "level": "pallet|lot|pack_config|item"} — weighed pallet, lot actual,
-- pack configuration, item default; the first level holding a value wins.
create or replace function app.pallet_kg(p_item uuid, p_lot uuid default null, p_pallet uuid default null)
returns jsonb language plpgsql stable as $$
declare v numeric;
begin
  if p_pallet is not null then
    select actual_kg into v from public.pallet where id = p_pallet;
    if v is not null then return jsonb_build_object('kg', v, 'level', 'pallet'); end if;
  end if;
  if p_lot is not null then
    select actual_pallet_kg into v from public.lot where id = p_lot;
    if v is not null then return jsonb_build_object('kg', v, 'level', 'lot'); end if;
    select pc.gross_kg into v from public.lot l join public.pack_config pc on pc.id = l.pack_config_id where l.id = p_lot;
    if v is not null then return jsonb_build_object('kg', v, 'level', 'pack_config'); end if;
  end if;
  select gross_kg into v from public.pack_config where item_id = p_item and is_default;
  if v is not null then return jsonb_build_object('kg', v, 'level', 'pack_config'); end if;
  select gross_kg into v from public.uom_pack where item_id = p_item and level = 'pallet';
  return jsonb_build_object('kg', v, 'level', 'item');
end $$;

-- Convert an entered quantity to base units through uom_pack / pack_config.
create or replace function app.to_base(p_item uuid, p_qty numeric, p_uom text, p_lot uuid default null)
returns numeric language plpgsql stable as $$
declare
  v_item public.item;
  v_mult numeric;
begin
  select * into v_item from public.item where id = p_item;
  if v_item.id is null then perform app.fail('UNKNOWN_ITEM', p_item::text); end if;
  if p_uom is null or p_uom = v_item.base_uom or p_uom = 'base' then
    return round(p_qty, 3);
  end if;
  if p_uom = 'pallet' then
    v_mult := app.units_per_pallet(p_item, p_lot);
  else
    select qty_base into v_mult from public.uom_pack where item_id = p_item and level = p_uom;
  end if;
  if v_mult is null then
    perform app.fail('UOM_UNKNOWN', format('no %s pack defined for %s', p_uom, v_item.sku));
  end if;
  return round(p_qty * v_mult, 3);
end $$;

-- Internal 18-digit pallet serial in SSCC layout: extension digit + company prefix
-- + serial reference + check digit. The prefix is a parameter until GS1 Türkiye
-- membership is confirmed, so labels need no redesign later (§6).
create or replace function app.next_pallet_serial(p_prefix text default null) returns text
language plpgsql as $$
declare
  v_prefix text := coalesce(p_prefix, '869000000');   -- placeholder prefix, 9 digits
  v_body text;
begin
  v_body := '0' || v_prefix || lpad(nextval('public.pallet_serial_seq')::text, 17 - 1 - length(v_prefix), '0');
  return v_body || app.gs1_check_digit(v_body);
end $$;

select app.track(t) from unnest(array[
  'public.market','public.item_family','public.item','public.uom_pack','public.pack_config',
  'public.site','public.party','public.lot','public.location','public.supplier_lane',
  'public.vehicle_type']::regclass[]) t;
create trigger trg_touch before update on public.pallet for each row execute function app.touch();
