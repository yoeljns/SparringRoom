-- Demo / development data. Reference rows the system needs (transaction types, parameters,
-- mechanic types, approval rules, Logo contract) live in the migrations, not here.
-- Everything below is illustrative: pallet weights are the 11 sealant weights from the
-- spec (§7.5); units per pallet, shelf life, lanes, dealers and history are placeholders
-- to be replaced by the real masters in phase 0.

select setseed(0.42);

insert into site (code, name) values ('TZ', 'Tuzla');

insert into market (code, name, transit_days, label_language, is_domestic) values
  ('TR', 'Türkiye', 2, 'tr', true),
  ('DE', 'Almanya', 7, 'de', false),
  ('IQ', 'Irak', 10, 'ar', false),
  ('GE', 'Gürcistan', 5, 'ka', false);

-- MRSL: 180 days domestic (global default), 240 days for export markets (assumptions to confirm)
insert into planning_param (scope_type, scope_id, param, value, note)
select 'market', id::text, 'mrsl_days', '240', 'Export markets; assumption to confirm' from market where not is_domestic;

insert into item_family (code, name, sku_pattern, default_policy, shelf_life_days, group_attribute, attr_schema) values
  ('SEAL', 'PU Mastik', '^DYS-PU-[A-Z0-9]+-[A-Z0-9]+$', 'continuous', 365, 'colour',
   '{"type":"object","required":["colour","format"],"properties":{"colour":{"type":"string"},"format":{"type":"string","enum":["KRT","SOS"]},"volume_ml":{"type":"number"}}}'),
  ('TAPE', 'Maskeleme Bandı', '^DYS-MB-[A-Z0-9]+-[0-9]+MM$', 'periodic', null, 'width_mm',
   '{"type":"object","required":["colour","width_mm"],"properties":{"colour":{"type":"string"},"width_mm":{"type":"number"}}}'),
  ('ABR', 'Zımpara', '^[A-Z]+-[A-Z]+-[0-9]+-[0-9A-Z]+-P[0-9]+$', 'periodic', null, 'grit',
   '{"type":"object","required":["form","diameter","grit"],"properties":{"form":{"type":"string"},"diameter":{"type":"number"},"holes":{"type":"string"},"grit":{"type":"string"}}}'),
  ('GRP', 'GRIPTEC', '^GRP-[A-Z0-9]+-[A-Z0-9]+$', 'periodic', null, 'size', '{"type":"object"}'),
  ('GIFT', 'Promosyon Ürünleri', null, 'to_order', null, null, '{"type":"object"}'),
  ('SET', 'Setler', null, 'to_order', null, null, '{"type":"object"}');

-- The 11 sealant items with the pallet weights of spec §7.5
with s(sku, name, colour, format, kg, upp, carton) as (values
  ('DYS-PU-BEYAZ-KRT',    'PU Mastik Beyaz Kartuş 280 ml',    'BEYAZ',    'KRT', 595, 1200, 24),
  ('DYS-PU-ANTRASIT-KRT', 'PU Mastik Antrasit Kartuş 280 ml', 'ANTRASIT', 'KRT', 594, 1200, 24),
  ('DYS-PU-SIYAH-KRT',    'PU Mastik Siyah Kartuş 280 ml',    'SIYAH',    'KRT', 589, 1200, 24),
  ('DYS-PU-GRI-KRT',      'PU Mastik Gri Kartuş 280 ml',      'GRI',      'KRT', 598, 1200, 24),
  ('DYS-PU-KIRMIZI-KRT',  'PU Mastik Kırmızı Kartuş 280 ml',  'KIRMIZI',  'KRT', 605, 1200, 24),
  ('DYS-PU-BEYAZ-SOS',    'PU Mastik Beyaz Sosis 600 ml',     'BEYAZ',    'SOS', 891, 900, 20),
  ('DYS-PU-ANTRASIT-SOS', 'PU Mastik Antrasit Sosis 600 ml',  'ANTRASIT', 'SOS', 890, 900, 20),
  ('DYS-PU-JF7GRI-SOS',   'PU Mastik JF7 Gri Sosis 600 ml',   'JF7GRI',   'SOS', 960, 900, 20),
  ('DYS-PU-SIYAH-SOS',    'PU Mastik Siyah Sosis 600 ml',     'SIYAH',    'SOS', 879, 900, 20),
  ('DYS-PU-GRI-SOS',      'PU Mastik Gri Sosis 600 ml',       'GRI',      'SOS', 903, 900, 20),
  ('DYS-PU-KIRMIZI-SOS',  'PU Mastik Kırmızı Sosis 600 ml',   'KIRMIZI',  'SOS', 916, 900, 20)
), ins as (
  insert into item (sku, name, gtin, family_id, brand, attributes, base_uom, lot_expiry_controlled, shelf_life_days,
                    max_stack_height, logo_item_code, zone, depth_class, production_line)
  select s.sku, s.name, '0869000' || lpad((1000 + row_number() over ())::text, 6, '0') || '0',
         (select id from item_family where code = 'SEAL'), 'Dayson',
         jsonb_build_object('colour', s.colour, 'format', s.format), 'piece', true, 365, 1,
         'L-' || s.sku, 'A', 6, 'MASTIK-1'
    from s returning id, sku
)
select 1;

insert into uom_pack (item_id, level, qty_base, gross_kg, logo_unit)
select i.id, v.level, v.qty, v.kg, v.logo_unit
from item i
cross join lateral (values
  ('piece', 1::numeric, null::numeric, 'ADET'),
  ('carton', case when i.attributes->>'format' = 'KRT' then 24 else 20 end, null, 'KOLI'),
  ('pallet', case when i.attributes->>'format' = 'KRT' then 1200 else 900 end,
     (case i.sku
        when 'DYS-PU-BEYAZ-KRT' then 595 when 'DYS-PU-ANTRASIT-KRT' then 594 when 'DYS-PU-SIYAH-KRT' then 589
        when 'DYS-PU-GRI-KRT' then 598 when 'DYS-PU-KIRMIZI-KRT' then 605 when 'DYS-PU-BEYAZ-SOS' then 891
        when 'DYS-PU-ANTRASIT-SOS' then 890 when 'DYS-PU-JF7GRI-SOS' then 960 when 'DYS-PU-SIYAH-SOS' then 879
        when 'DYS-PU-GRI-SOS' then 903 when 'DYS-PU-KIRMIZI-SOS' then 916 end)::numeric, 'PALET')) v(level, qty, kg, logo_unit)
where i.sku like 'DYS-PU-%';

insert into pack_config (item_id, code, pallet_type, units_per_pallet, gross_kg, footprint, stack_height, is_default)
select item_id, 'STD', 'EUR', qty_base, gross_kg, '800x1200', 1, true from uom_pack where level = 'pallet';

-- Tapes, abrasives, GRIPTEC, a gift item and a phantom set
insert into item (sku, name, family_id, brand, attributes, base_uom, logo_item_code, zone, depth_class, sellable) values
  ('DYS-MB-SARI-48MM', 'Maskeleme Bandı Sarı 48 mm', (select id from item_family where code = 'TAPE'), 'Dayson', '{"colour":"SARI","width_mm":48}', 'piece', 'L-DYS-MB-SARI-48MM', 'B', 4, true),
  ('DYS-MB-SARI-24MM', 'Maskeleme Bandı Sarı 24 mm', (select id from item_family where code = 'TAPE'), 'Dayson', '{"colour":"SARI","width_mm":24}', 'piece', 'L-DYS-MB-SARI-24MM', 'B', 4, true),
  ('SIA-DISK-150-15D-P240', 'Zımpara Disk 150 mm 15 Delik P240', (select id from item_family where code = 'ABR'), 'SIA', '{"form":"DISK","diameter":150,"holes":"15D","grit":"P240"}', 'piece', 'L-SIA-DISK-150-15D-P240', 'C', 4, true),
  ('SIA-DISK-150-15D-P320', 'Zımpara Disk 150 mm 15 Delik P320', (select id from item_family where code = 'ABR'), 'SIA', '{"form":"DISK","diameter":150,"holes":"15D","grit":"P320"}', 'piece', 'L-SIA-DISK-150-15D-P320', 'C', 4, true),
  ('GRP-TABANCA-600', 'GRIPTEC Sosis Tabancası 600 ml', (select id from item_family where code = 'GRP'), 'GRIPTEC', '{"size":"600"}', 'piece', 'L-GRP-TABANCA-600', 'C', 4, true),
  ('PROMO-TSHIRT', 'Dayson Tişört (promosyon)', (select id from item_family where code = 'GIFT'), 'Dayson', '{}', 'piece', 'L-PROMO-TSHIRT', 'C', 4, false),
  ('SET-USTA-01', 'Usta Seti (6 Beyaz Sosis + 1 Tabanca)', (select id from item_family where code = 'SET'), 'Dayson', '{}', 'piece', 'L-SET-USTA-01', null, null, true);

insert into uom_pack (item_id, level, qty_base, gross_kg, logo_unit)
select i.id, v.level, v.qty, v.kg, v.logo_unit from item i
cross join lateral (values ('piece', 1::numeric, null::numeric, 'ADET'), ('carton', 36::numeric, null, 'KOLI'), ('pallet', 1728::numeric, 310::numeric, 'PALET')) v(level, qty, kg, logo_unit)
where i.sku not like 'DYS-PU-%' and i.sku not like 'SET-%';
insert into pack_config (item_id, code, units_per_pallet, gross_kg, is_default)
select item_id, 'STD', qty_base, gross_kg, true from uom_pack u where level = 'pallet'
   and not exists (select 1 from pack_config pc where pc.item_id = u.item_id);

insert into bundle (item_id, name, kind) select id, 'Usta Seti', 'phantom' from item where sku = 'SET-USTA-01';
insert into bundle_line (bundle_id, component_item_id, qty)
select b.id, i.id, case i.sku when 'DYS-PU-BEYAZ-SOS' then 6 else 1 end
from bundle b, item i where i.sku in ('DYS-PU-BEYAZ-SOS', 'GRP-TABANCA-600');

insert into item_cost (item_id, cost_eur, as_of)
select id, case when sku like '%-KRT' then 1.85 when sku like '%-SOS' then 3.10 when sku like 'DYS-MB%' then 0.90
                when sku like 'SIA%' then 0.22 when sku like 'GRP%' then 14.50 when sku like 'PROMO%' then 4.00 else 20 end, current_date - 30
from item where sku not like 'SET-%';

-- Warehouse: docks, staging, pick faces, three blocks of lanes in depth classes 4 / 6 / 10
insert into location (site_id, code, type, zone) select s.id, c, t, null from site s,
  (values ('TZ-DOCK-01', 'dock'), ('TZ-DOCK-02', 'dock'), ('TZ-STG-01', 'staging'), ('TZ-STG-02', 'staging')) v(c, t);
insert into location (site_id, code, type, zone, pick_min_qty)
select s.id, 'TZ-PF-' || lpad(n::text, 2, '0'), 'pick_face', 'P', 48 from site s, generate_series(1, 6) n;
insert into location (site_id, code, type, zone, depth_positions, max_stack_height, depth_class, dock_distance)
select s.id, format('TZ-B%s-L%s', lpad(b::text, 2, '0'), lpad(l::text, 2, '0')), 'block_lane',
       case b when 1 then 'A' when 2 then 'A' else case when l <= 6 then 'B' else 'C' end end,
       case b when 1 then 10 when 2 then 6 else 4 end, 1, case b when 1 then 10 when 2 then 6 else 4 end, b * 10 + l
from site s, generate_series(1, 3) b, generate_series(1, 12) l;

insert into vehicle_type (code, name, min_kg, max_kg, positions, max_items, is_default) values
  ('TIR', 'Tır (tam yük)', 24900, 25075, '{}', 5, true),
  ('KAMYON', 'Kamyon', 0, 15000, '{}', 12, false),
  ('KAMYONET', 'Kamyonet', 0, 3500, '{}', 20, false);

-- Parties
insert into party (type, name, vkn, logo_cari_code, segment, market_id, mrsl_profile, city, country, consignment, short_cycle) values
  ('dealer', 'Yapı Market Anadolu A.Ş.', '1234567890', '120.01.001', 'A', (select id from market where code = 'TR'), 'domestic', 'İstanbul', 'TR', true, true),
  ('dealer', 'Ege Boya Hırdavat Ltd.', '2345678901', '120.01.002', 'A', (select id from market where code = 'TR'), 'domestic', 'İzmir', 'TR', false, true),
  ('dealer', 'Karadeniz Nalbur', '3456789012', '120.01.003', 'B', (select id from market where code = 'TR'), 'domestic', 'Trabzon', 'TR', false, false),
  ('dealer', 'Başkent İnşaat Malzemeleri', '4567890123', '120.01.004', 'B', (select id from market where code = 'TR'), 'domestic', 'Ankara', 'TR', false, false),
  ('dealer', 'Güney Yapı Kimyasalları', '5678901234', '120.01.005', 'C', (select id from market where code = 'TR'), 'domestic', 'Adana', 'TR', false, false),
  ('importer', 'Bau Chemie Import GmbH', null, '120.02.001', 'A', (select id from market where code = 'DE'), 'contract', 'Hamburg', 'DE', false, false),
  ('importer', 'Erbil Construction Supplies', null, '120.02.002', 'B', (select id from market where code = 'IQ'), 'export', 'Erbil', 'IQ', false, false),
  ('supplier', 'sia Abrasives Industries AG', null, '320.01.001', null, null, null, 'Frauenfeld', 'CH', false, false),
  ('supplier', 'Bant Sanayi A.Ş.', '6789012345', '320.01.002', null, null, null, 'Kocaeli', 'TR', false, false),
  ('supplier', 'Hırdavat İthalat Ltd.', '7890123456', '320.01.003', null, null, null, 'İstanbul', 'TR', false, false);
-- importer contract: MRSL as contracted, for example 270 days
insert into planning_param (scope_type, scope_id, param, value, note)
select 'party', id::text, 'mrsl_days', '270', 'As contracted' from party where logo_cari_code = '120.02.001';
update party set priority_tier = 1 where type = 'importer';

insert into location (site_id, code, type, dealer_id)
select (select id from site), 'TZ-CONS-' || replace(logo_cari_code, '.', ''), 'consignment', id from party where consignment;

-- Supply lanes and capacity
insert into supplier_lane (supplier_id, item_family_id, mode, quoted_lt_days, moq, order_multiple, price_breaks, review_days) values
  ((select id from party where logo_cari_code = '320.01.001'), (select id from item_family where code = 'ABR'), 'road', 42, 5000, 500, '[{"min_qty":5000,"discount_pct":0},{"min_qty":20000,"discount_pct":3}]', 30),
  ((select id from party where logo_cari_code = '320.01.002'), (select id from item_family where code = 'TAPE'), 'road', 14, 1728, 1728, '[]', 7),
  ((select id from party where logo_cari_code = '320.01.003'), (select id from item_family where code = 'GRP'), 'sea', 60, 500, 100, '[]', 30),
  ((select id from party where logo_cari_code = '320.01.003'), (select id from item_family where code = 'GIFT'), 'road', 21, 100, 50, '[]', 30);
insert into supplier_lane (item_family_id, production_line, mode, quoted_lt_days, moq, order_multiple)
values ((select id from item_family where code = 'SEAL'), 'MASTIK-1', 'production', 21, 1200, 900);
insert into capacity_calendar (line, date, pallets_per_day)
select 'MASTIK-1', d::date, 40 from generate_series(current_date, current_date + 180, interval '1 day') d
where extract(isodow from d) < 6;

-- Two years of synthetic weekly demand so the planning worker has history
insert into demand_history (item_id, party_id, market_id, week, qty_paid, qty_free, source)
select i.id, p.id, p.market_id, w::date,
       greatest(0, round((case when i.sku like '%-KRT' then 2400 when i.sku like '%-SOS' then 1350
                               when i.sku like 'DYS-MB%' then 900 when i.sku like 'SIA%' then 1500 else 60 end
              * (case p.segment when 'A' then 1.0 when 'B' then 0.45 else 0.2 end)
              * (1 + 0.35 * sin(2 * pi() * extract(doy from w) / 365.0 - 1.2))      -- construction season
              * (0.6 + 0.8 * random())
              * (case when i.sku like 'GRP%' or i.sku like 'SIA%P320' then (random() < 0.35)::int else 1 end))::numeric, 0)),
       0, 'logo'
from item i
join party p on p.type in ('dealer', 'importer')
cross join generate_series(date_trunc('week', current_date - interval '104 weeks'), date_trunc('week', current_date - interval '1 week'), interval '1 week') w
where i.sellable and i.sku not like 'SET-%' and i.sku not like 'PROMO%';
delete from demand_history where qty_paid = 0 and qty_free = 0;

-- Opening stock through the ledger (runs as the system role)
do $$
declare
  r record;
  n int := 0;
  v_lane text;
  v_res jsonb;
begin
  for r in
    select i.id, i.sku, g as lot_n,
           case g when 1 then 130 when 2 then 60 else 20 end as age_days,
           case g when 1 then 3 when 2 then 5 else 4 end as pallets
      from item i cross join generate_series(1, 3) g
     where i.sku like 'DYS-PU-%' and (g <= 2 or i.sku in ('DYS-PU-BEYAZ-KRT', 'DYS-PU-GRI-KRT', 'DYS-PU-SIYAH-KRT'))
     order by i.sku, g
  loop
    n := n + 1;
    v_lane := format('TZ-B%s-L%s', lpad((1 + (n - 1) / 12)::text, 2, '0'), lpad((1 + (n - 1) % 12)::text, 2, '0'));
    for p in 1..r.pallets loop
      v_res := rpc_floor('opening_balance', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'item_id', r.id, 'lot_no', format('L%s-%s', to_char(current_date - r.age_days, 'YYMMDD'), r.lot_n),
        'prod_date', current_date - r.age_days, 'qty', 1, 'uom', 'pallet', 'to_location', v_lane, 'status', 'available',
        'actual_pallet_kg', (select gross_kg + (r.lot_n - 2) * 3 from uom_pack where item_id = r.id and level = 'pallet'),
        'scan_method', 'system'));
      if v_res ? 'error' then raise exception 'seed opening balance failed: %', v_res; end if;
    end loop;
  end loop;
  update lot set qc_status = 'released';
end $$;

select rpc_update_expiry_bands();

insert into plan_version (name, kind, state, published_at, param_version)
values ('Başlangıç planı', 'plan', 'published', now(), app.param_version());

insert into standard_terms (name, scope, terms, valid_from)
values ('Yıl boyu bayi koşulları', '{"type":"dealer"}', '{"list_discount_pct": 20, "free_goods_ratio": 0}', date_trunc('year', current_date)::date);
