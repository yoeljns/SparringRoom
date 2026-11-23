-- Promising and allocation rules (spec §7, §13.2 "Rules").
begin;
select plan(17);
select test.base();
select test.mk_user('planner') as planner \gset

-- GRI: three lots, the oldest fails the domestic MRSL of 180 days
select test.stock('GRI', 'OLD', app.today() + 150, 2, 'TZ-B01-L01');
select test.stock('GRI', 'MID', app.today() + 200, 2, 'TZ-B01-L02');
select test.stock('GRI', 'NEW', app.today() + 300, 2, 'TZ-B01-L03');
-- SIYAH: 5 pallets only
select test.stock('SIYAH', 'S1', app.today() + 320, 5, 'TZ-B01-L04');
select test.stock('SIYAH', 'S2', app.today() + 330, 5, 'TZ-B01-L05');

select test.as_user(:'planner');
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-A'), 'requested_date', app.today(),
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','GRI'), 'qty', 1, 'uom', 'pallet'))))->>'order_id') as o_dom \gset
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','I-DE'), 'requested_date', app.today(),
  'order_type', 'export_contract',
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','GRI'), 'qty', 1, 'uom', 'pallet'))))->>'order_id') as o_exp \gset
select lives_ok(format('select rpc_confirm_order(%L)', :'o_dom'), 'domestic order confirms');
select lives_ok(format('select rpc_confirm_order(%L)', :'o_exp'), 'export order confirms');
select is((select promised_date from so_line where order_id = :'o_dom'), app.today(), 'stock on hand: promised for the requested date');
select is((select count(*)::int from reservation where type = 'soft' and state = 'active'), 2, 'confirmation created soft reservations');
select is((select available_to_reserve from v_available where sku = 'GRI'), 7200 - 2400::numeric,
  'available to reserve = on hand - hard - soft');
select is((select priority_tier from sales_order where id = :'o_exp'), 1, 'export contract is tier 1');

select lives_ok('select rpc_allocate()', 'allocation runs');
select is((select l.lot_no from reservation r join lot l on l.id = r.lot_id join so_line s on s.id = r.demand_line_id
            where s.order_id = :'o_dom' and r.type = 'hard'), 'MID',
  'allocation picks the earliest-expiring lot that passes the MRSL, never the failing one');
select is((select l.lot_no from reservation r join lot l on l.id = r.lot_id join so_line s on s.id = r.demand_line_id
            where s.order_id = :'o_exp' and r.type = 'hard'), 'NEW', 'the export customer (240 days) gets the lot that passes its own MRSL');
select is((select count(*)::int from reservation r join lot l on l.id = r.lot_id where r.type = 'hard' and l.lot_no = 'OLD'), 0,
  'no reservation names the lot failing MRSL');
select is((select count(*)::int from task where type = 'pick' and state = 'open'), 2, 'pick tasks were created');

-- shortage: tier 1 wants 2 pallets, two tier-3 dealers want 4 each, supply is 5
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','I-DE'), 'requested_date', app.today(), 'order_type', 'export_contract',
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','SIYAH'), 'qty', 2, 'uom', 'pallet'))))->>'order_id') as s1 \gset
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-B'), 'requested_date', app.today(),
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','SIYAH'), 'qty', 4, 'uom', 'pallet'))))->>'order_id') as s2 \gset
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-C'), 'requested_date', app.today(),
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','SIYAH'), 'qty', 4, 'uom', 'pallet'))))->>'order_id') as s3 \gset
select rpc_confirm_order(:'s1'); select rpc_confirm_order(:'s2'); select rpc_confirm_order(:'s3');
-- supply then drops to 5 pallets (lot S2 is written off) before allocation runs
select test.as_system();
select test.post('count_adjust', jsonb_build_object('item_id', test.id('item','sku','SIYAH'), 'lot_id', (select id from lot where lot_no = 'S2'),
  'from_location', 'TZ-B01-L05', 'to_location', 'V-ADJUSTMENT', 'qty_entered', 6000), jsonb_build_object('reason_code', 'test'))->>'error';
select test.as_user(:'planner');
select rpc_allocate();

create temp view _alloc as
  select s.order_id, sum(r.original_qty) as qty from reservation r join so_line s on s.id = r.demand_line_id
   where r.type = 'hard' and r.item_id = test.id('item','sku','SIYAH') group by s.order_id;
select is((select qty from _alloc where order_id = :'s1'), 2400::numeric, 'the higher tier is filled completely first');
select is((select sum(qty) from _alloc), 6000::numeric, 'shortage sharing sums to supply');
select is((select count(*)::int from _alloc where qty % 1200 <> 0), 0, 'shares are whole pallets');
select is((select array_agg(qty order by qty desc) from _alloc where order_id in (:'s2', :'s3')), array[2400, 1200]::numeric[],
  'equal orders share 3 pallets as 2 + 1 (largest remainder)');
select is((select count(*)::int from v_backorder), 2, 'unfilled quantity stays as a backorder');
select ok((select bool_and(promised_date > app.today()) from so_line where order_id in (:'s2', :'s3')),
  'backorders carry a new promise date and are not cancelled');
select * from finish();
rollback;
