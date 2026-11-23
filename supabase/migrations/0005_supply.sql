-- 0005 Supply (spec §3.3): purchase and production orders, inbound shipments, capacity.
-- From day one every purchase and production order is logged with promised and actual
-- dates: they are the source of the lead-time measurements.

create sequence public.doc_no_seq;
create or replace function app.next_doc_no(p_prefix text) returns text
language sql as $$
  select p_prefix || '-' || to_char(now(), 'YYMM') || '-' || lpad(nextval('public.doc_no_seq')::text, 5, '0')
$$;

create table public.purchase_order (
  id uuid primary key default gen_random_uuid(),
  po_no text not null unique default app.next_doc_no('PO'),
  supplier_id uuid not null references public.party (id),
  supplier_lane_id uuid references public.supplier_lane (id),
  ordered_at timestamptz,
  promised_date date,
  confirmed_date date,
  state text not null default 'draft' check (state in ('draft','ordered','confirmed','partially_received','received','cancelled')),
  logo_doc_no text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.po_line (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_order (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references public.item (id),
  qty numeric(14,3) not null check (qty > 0),          -- base units
  received_qty numeric(14,3) not null default 0,
  promised_date date,
  confirmed_date date,
  first_receipt_at timestamptz,
  qc_released_at timestamptz,                          -- lead time ends at QC release (§8.4)
  state text not null default 'open' check (state in ('open','partially_received','received','cancelled')),
  suggestion_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (po_id, line_no)
);
create index po_line_item_idx on public.po_line (item_id) where state in ('open','partially_received');

create table public.production_order (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique default app.next_doc_no('PR'),
  item_id uuid not null references public.item (id),
  qty numeric(14,3) not null check (qty > 0),          -- base units
  received_qty numeric(14,3) not null default 0,
  line text,
  ordered_at timestamptz default now(),
  planned_start date,
  planned_finish date,
  actual_finish date,
  qc_released_at timestamptz,
  lot_id uuid references public.lot (id),
  state text not null default 'draft' check (state in ('draft','planned','in_progress','finished','cancelled')),
  suggestion_id uuid,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index production_order_item_idx on public.production_order (item_id) where state in ('planned','in_progress');

create table public.inbound_shipment (
  id uuid primary key default gen_random_uuid(),
  etd date,
  eta date,
  arrived_at timestamptz,
  vehicle_ref text,
  state text not null default 'planned' check (state in ('planned','in_transit','arrived','cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.inbound_line (
  id uuid primary key default gen_random_uuid(),
  inbound_shipment_id uuid not null references public.inbound_shipment (id) on delete cascade,
  po_line_id uuid not null references public.po_line (id),
  qty numeric(14,3) not null check (qty > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create table public.capacity_calendar (
  id uuid primary key default gen_random_uuid(),
  line text not null,
  date date not null,
  pallets_per_day numeric(14,3) not null check (pallets_per_day >= 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  unique (line, date)
);

select app.track(t) from unnest(array[
  'public.purchase_order','public.po_line','public.production_order',
  'public.inbound_shipment','public.inbound_line','public.capacity_calendar']::regclass[]) t;

-- Measured lead time per supplier lane / production line (§8.4), recomputed nightly.
create table public.lead_time_stat (
  id uuid primary key default gen_random_uuid(),
  supplier_lane_id uuid references public.supplier_lane (id) on delete cascade,
  production_line text,
  n int not null default 0,
  mean_days numeric(8,2) not null,
  sd_days numeric(8,2) not null,
  p90_days numeric(8,2) not null,
  source text not null default 'measured' check (source in ('measured','quoted')),
  as_of date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check (supplier_lane_id is not null or production_line is not null)
);
create index lead_time_stat_lane_idx on public.lead_time_stat (supplier_lane_id, as_of desc);
create index lead_time_stat_line_idx on public.lead_time_stat (production_line, as_of desc);

-- Expected receipts per item with the date ATP may rely on them (§7.3):
-- inbound shipment ETA, else the confirmed date, else order date + the lane's p90 lead time,
-- else the promised date. Late receipts are pushed to today.
create or replace view public.v_expected_receipt as
select 'po_line'::text as source_type, pl.id as source_id, pl.item_id,
       pl.qty - pl.received_qty as qty_base,
       greatest(coalesce(
         (select min(s.eta) from public.inbound_line il join public.inbound_shipment s on s.id = il.inbound_shipment_id
           where il.po_line_id = pl.id and s.state in ('planned','in_transit')),
         pl.confirmed_date, po.confirmed_date,
         (po.ordered_at::date + ceil((
            select ls.p90_days from public.lead_time_stat ls
             where ls.supplier_lane_id = po.supplier_lane_id order by ls.as_of desc limit 1))::int),
         pl.promised_date, po.promised_date, current_date + 14), current_date) as expected_date,
       coalesce(pl.promised_date, po.promised_date) as promised_date,
       po.supplier_lane_id, po.po_no as doc_no
from public.po_line pl join public.purchase_order po on po.id = pl.po_id
where po.state in ('ordered','confirmed','partially_received') and pl.state in ('open','partially_received')
  and pl.qty > pl.received_qty
union all
select 'production_order', pr.id, pr.item_id, pr.qty - pr.received_qty,
       greatest(coalesce(pr.planned_finish, current_date + 21), current_date),
       pr.planned_finish, null, pr.order_no
from public.production_order pr
where pr.state in ('planned','in_progress') and pr.qty > pr.received_qty;
