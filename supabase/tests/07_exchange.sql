-- Logo file exchange and reconciliation (spec §11, §13.2 "Exchange").
begin;
select plan(22);
select test.base();
select test.mk_user('finance') as fin \gset
insert into item (sku, name, family_id, logo_item_code) values
  ('MAP', 'Mapping', test.id('item_family','code','SEAL'), 'L-MAP'), ('VAR', 'Variance', test.id('item_family','code','SEAL'), 'L-VAR'),
  ('MISS', 'Missing', test.id('item_family','code','SEAL'), 'L-MISS');
update item set attributes = '{"colour":"GRI"}' where sku = 'GRI';
update item set logo_unit = 'ADET';
insert into uom_pack (item_id, level, qty_base, gross_kg, logo_unit)
select id, 'pallet', 1200, 500, 'PALET' from item where sku in ('MAP', 'VAR', 'MISS');

select test.as_user(:'fin');
-- items file: detects new items, never overwrites attributes kept here
select is(rpc_import_batch('items_20270101_01.csv', 'hash-items-1', 'items', 'v1', '{logo_item_code,name,unit,gtin,active}',
  '[{"logo_item_code":"L-GRI","name":"GRI MASTIK (LOGO)","unit":"ADET","gtin":"","active":"true"},
    {"logo_item_code":"L-NEW","name":"Yeni Ürün","unit":"ADET","gtin":"","active":"true"}]')->>'state', 'applied', 'a clean file applies');
select is((select attributes->>'colour' from item where sku = 'GRI'), 'GRI', 'attributes kept here are not overwritten');
select is((select name from item where sku = 'GRI'), 'Gri Mastik', 'nor is our description');
select ok((select needs_review and not active from item where logo_item_code = 'L-NEW'), 'a new Logo item arrives inactive and flagged for master data');

-- the same file imported twice changes nothing
select is(rpc_import_batch('items_20270101_01.csv', 'hash-items-1', 'items', 'v1', '{logo_item_code,name,unit,gtin,active}',
  '[{"logo_item_code":"L-ZZZ","name":"Should not appear","unit":"ADET","gtin":"","active":"true"}]')->>'state', 'skipped',
  'a file hash seen before is skipped');
select is((select count(*)::int from item where logo_item_code = 'L-ZZZ'), 0, 'the same file imported twice changes nothing');
select is((select count(*)::int from import_batch), 1, 'one batch recorded');

-- a file with an unknown column is rejected whole
select is(rpc_import_batch('parties_20270101_01.csv', 'hash-p-1', 'parties', 'v1', '{logo_cari_code,name,vkn,type,city,country,active,credit_limit}',
  '[{"logo_cari_code":"P-9","name":"Yeni Bayi","vkn":"1","type":"dealer","city":"","country":"TR","active":"true","credit_limit":"5"}]')->>'state',
  'rejected', 'a file with an unknown column is rejected whole');
select is((select count(*)::int from party where logo_cari_code = 'P-9'), 0, 'nothing from the rejected file was applied');
select is(rpc_import_batch('parties_20270101_02.csv', 'hash-p-2', 'parties', 'v2', '{logo_cari_code,name,vkn,type,city,country,active}', '[]')->>'state',
  'rejected', 'an unknown schema version is rejected');
-- a file with any row error is held for review and not partially applied
select is(rpc_import_batch('item_cost_20270101_01.csv', 'hash-c-1', 'item_cost', 'v1', '{logo_item_code,cost_eur,as_of}',
  '[{"logo_item_code":"L-GRI","cost_eur":"9.99","as_of":"2027-01-01"},{"logo_item_code":"L-NOPE","cost_eur":"1","as_of":"2027-01-01"}]')->>'state',
  'held', 'a file with a row error is held');
select is((select count(*)::int from item_cost where cost_eur = 9.99), 0, 'and not partially applied');
select is((select count(*)::int from import_row_error), 1, 'row errors are recorded');
select test.as_system();
select is((select count(*)::int from alert where rule in ('import_file_rejected','import_file_held')), 3, 'rejected and held files raise alerts');

-- reconciliation: one seeded case per class
select test.stock('GRI', 'G1', app.today() + 300, 2, 'TZ-B01-L01');         -- matches Logo: no difference
select test.stock('VAR', 'V1', null, 2, 'TZ-B01-L02');                      -- Logo says 3 pallets, no open documents
select test.stock('MAP', 'M1', null, 1, 'TZ-B01-L03');                      -- Logo unit unknown
insert into lot (item_id, lot_no, expiry_date) values (test.id('item','sku','SIYAH'), 'T1', app.today() + 300);
select test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','SIYAH'), 'lot_id', (select id from lot where lot_no = 'T1'),
  'to_location', 'TZ-DOCK-01', 'qty_entered', 1200))->>'error';             -- received today, not yet in Logo: timing
select test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','MISS'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 500),
  jsonb_build_object('event_at', now() - interval '5 days', 'reason_code', 'late_entry'))->>'error';   -- 5 days old, not in Logo: missing_doc
select test.as_user(:'fin');
select is(rpc_import_batch('stock_snapshot_x.csv', 'hash-s-1', 'stock_snapshot', 'v1', '{as_of,logo_item_code,warehouse_code,qty,unit}',
  format('[{"as_of":"%1$s","logo_item_code":"L-GRI","warehouse_code":"TZ","qty":"2","unit":"PALET"},
           {"as_of":"%1$s","logo_item_code":"L-VAR","warehouse_code":"TZ","qty":"3","unit":"PALET"},
           {"as_of":"%1$s","logo_item_code":"L-MAP","warehouse_code":"TZ","qty":"5","unit":"KUTU"},
           {"as_of":"%1$s","logo_item_code":"L-SIYAH","warehouse_code":"TZ","qty":"0","unit":"ADET"},
           {"as_of":"%1$s","logo_item_code":"L-MISS","warehouse_code":"TZ","qty":"0","unit":"ADET"}]', app.today())::jsonb)->>'state',
  'applied', 'stock snapshot imports');
select lives_ok('select rpc_run_reconciliation()', 'reconciliation runs');
create temp view _r as select i.sku, r.class, r.diff from v_recon_open r join item i on i.id = r.item_id where r.level = 'item';
select is((select count(*)::int from _r where sku = 'GRI'), 0, 'matching quantities converted through uom_pack leave no difference');
select is((select class from _r where sku = 'VAR'), 'true_variance', 'quantities differ with all documents matched: true_variance');
select is((select class from _r where sku = 'MAP'), 'mapping', 'unit mismatch: mapping');
select is((select class from _r where sku = 'SIYAH'), 'timing', 'document in one system only, under 48 hours: timing');
select is((select class from _r where sku = 'MISS'), 'missing_doc', 'document in one system only, over 48 hours: missing_doc');
select test.as_system();
select cmp_ok((select count(*)::int from count_task where trigger = 'exception' and item_id = test.id('item','sku','VAR')), '>=', 1,
  'a true variance raises a count task for the item');
select * from finish();
rollback;
