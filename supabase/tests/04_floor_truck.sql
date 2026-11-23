-- Floor flow: receive, QC, put-away, pick, load, truck close (spec §5, §13.2 "Rules").
begin;
select plan(34);
select test.base();
select test.mk_user('operator') as op \gset
select test.mk_user('ops_manager') as ops \gset
select test.mk_user('planner') as planner \gset
select test.mk_user('qc') as qc \gset

-- a purchase order for 2 pallets of BANT... use GRI (expiry-controlled) to exercise lot rules
insert into purchase_order (id, supplier_id, ordered_at, state) values
  ('aaaaaaaa-0000-0000-0000-000000000001', test.id('party','logo_cari_code','S-1'), now() - interval '20 days', 'ordered');
insert into po_line (id, po_id, line_no, item_id, qty) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 1, test.id('item','sku','GRI'), 2400);

select test.as_user(:'op');
select is(rpc_floor('receive', jsonb_build_object('client_uuid', gen_random_uuid(), 'doc_type', 'po_line', 'doc_id', 'aaaaaaaa-0000-0000-0000-000000000002',
  'lot_no', 'RCV1', 'prod_date', app.today(), 'qty', 1, 'uom', 'pallet', 'to_location', 'TZ-DOCK-01'))->>'error', 'WEIGHT_REQUIRED',
  'the first pallet of a lot needs its weighed kg');
select is(rpc_floor('receive', jsonb_build_object('client_uuid', 'bbbbbbbb-0000-0000-0000-000000000001', 'doc_type', 'po_line', 'doc_id', 'aaaaaaaa-0000-0000-0000-000000000002',
  'lot_no', 'RCV1', 'prod_date', app.today(), 'qty', 1, 'uom', 'pallet', 'to_location', 'TZ-DOCK-01', 'actual_pallet_kg', 601))->>'error', null,
  'receipt against the purchase order posts');
select is((select actual_pallet_kg from lot where lot_no = 'RCV1'), 601::numeric, 'weighed kg stored on the lot as actual_pallet_kg');
select is((select expiry_date from lot where lot_no = 'RCV1'), app.today() + 365, 'expiry defaults from production date + item shelf life');
select is(test.bal('GRI', 'TZ-DOCK-01', 'quarantine'), 1200::numeric, 'receipt is in quarantine on the dock');
select is(rpc_floor('receive', jsonb_build_object('client_uuid', gen_random_uuid(), 'doc_type', 'po_line', 'doc_id', 'aaaaaaaa-0000-0000-0000-000000000002',
  'lot_no', 'RCV1', 'expiry_date', app.today() + 100, 'qty', 1, 'uom', 'pallet', 'to_location', 'TZ-DOCK-01'))->>'error', 'LOT_EXPIRY_MISMATCH',
  'a lot number that exists with a different expiry is rejected');
select is(rpc_floor('receive', jsonb_build_object('client_uuid', gen_random_uuid(), 'doc_type', 'po_line', 'doc_id', 'aaaaaaaa-0000-0000-0000-000000000002',
  'lot_no', 'RCV1', 'qty', 2, 'uom', 'pallet', 'to_location', 'TZ-DOCK-01'))->>'error', 'APPROVAL_REQUIRED',
  'over-receipt above 5% needs supervisor confirmation');
select is(rpc_floor('qc', jsonb_build_object('client_uuid', gen_random_uuid(), 'lot_id', (select id from lot where lot_no = 'RCV1'), 'decision', 'release'))->>'error',
  'NOT_PERMITTED', 'an operator cannot release a lot');
select is(rpc_floor('putaway', jsonb_build_object('client_uuid', gen_random_uuid(),
  'pallet_serial', (select serial from pallet where lot_id = (select id from lot where lot_no = 'RCV1')), 'to_location', 'TZ-B01-L08'))->>'error', null,
  'put-away before QC release');
select test.as_user(:'qc');
select is(rpc_floor('qc', jsonb_build_object('client_uuid', gen_random_uuid(), 'lot_id', (select id from lot where lot_no = 'RCV1'), 'decision', 'release'))->>'error',
  null, 'QC releases the lot');
select test.as_system();
select is(test.bal('GRI', 'TZ-B01-L08', 'available'), 1200::numeric, 'released stock is available in its lane');
select ok((select qc_released_at is not null from po_line where id = 'aaaaaaaa-0000-0000-0000-000000000002'), 'QC release date recorded for lead time');
select is((select count(*)::int from export_row where type = 'receipts'), 1, 'receipt written to the Logo outbound queue');
-- take that pallet out of the way for the truck scenario
select test.post('count_adjust', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'RCV1'),
  'from_location', 'TZ-B01-L08', 'to_location', 'V-ADJUSTMENT', 'qty_entered', 1200), '{"reason_code":"test"}')->>'error';
update pallet set status = 'consumed', location_id = null where lot_id = (select id from lot where lot_no = 'RCV1');

-- truck: 20 Gri (598 kg) + 22 Siyah (589 kg) = 24,918 kg
select test.stock('GRI', 'G1', app.today() + 300, 21, 'TZ-B01-L01');
select test.stock('SIYAH', 'S1', app.today() + 300, 22, 'TZ-B01-L02');
select test.as_user(:'planner');
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-A'), 'requested_date', app.today(),
  'lines', jsonb_build_array(
    jsonb_build_object('item_id', test.id('item','sku','GRI'), 'qty', 20, 'uom', 'pallet'),
    jsonb_build_object('item_id', test.id('item','sku','SIYAH'), 'qty', 22, 'uom', 'pallet'))))->>'order_id') as o1 \gset
select (rpc_confirm_order(:'o1')->>'shipment_id') as sh1 \gset
select is((select planned_kg from truck_load where shipment_id = :'sh1'), 24918::numeric, 'planned truck weight from pack weights');
select rpc_allocate();

-- operator picks every pallet: lane, pallet, staging
select test.as_user(:'op');
do $$
declare t record; p record; v jsonb;
begin
  for t in select * from v_task where type = 'pick' loop
    for p in select serial from pallet where location_id = t.location_id and lot_id = t.lot_id and status = 'active' and shipment_id is null
              order by serial limit (t.pallets)::int loop
      v := rpc_floor('pick', jsonb_build_object('client_uuid', gen_random_uuid(), 'task_id', t.id, 'lane', t.location_code,
                     'pallet_serial', p.serial, 'to_location', 'TZ-STG-01'));
      if v ? 'error' then raise exception 'pick failed: %', v; end if;
    end loop;
  end loop;
end $$;
select is((select count(*)::int from pallet where shipment_id = :'sh1'), 42, '42 pallets picked to staging');
select is((select count(*)::int from reservation where shipment_id = :'sh1' and type = 'hard' and state = 'active'), 0,
  'hard reservations were converted to pick moves');
select is((select state from shipment where id = :'sh1'), 'picking', 'shipment is in picking');

-- load 41 of 42
do $$
declare p record; v jsonb;
begin
  for p in select serial from pallet where shipment_id = (select id from shipment where state = 'picking') order by serial limit 41 loop
    v := rpc_floor('load', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', (select id from shipment where state in ('picking','loading')), 'pallet_serial', p.serial));
    if v ? 'error' then raise exception 'load failed: %', v; end if;
  end loop;
end $$;
select is(rpc_floor('close_truck', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', :'sh1', 'e_irsaliye_no', 'IRS-1'))->>'error',
  'PALLET_UNSCANNED', 'truck close is blocked while a pallet is unscanned');
select is((rpc_floor('load', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', :'sh1',
  'pallet_serial', (select serial from pallet where shipment_id = :'sh1' and loaded_at is null)))->>'loaded_kg')::numeric, 24918::numeric,
  'running weight after the last pallet is 24,918 kg');
select is(rpc_floor('close_truck', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', :'sh1'))->>'error',
  'EIRSALIYE_REQUIRED', 'truck close is refused without an e-İrsaliye number');
select is(rpc_floor('close_truck', jsonb_build_object('client_uuid', 'cccccccc-0000-0000-0000-000000000001', 'shipment_id', :'sh1', 'e_irsaliye_no', 'IRS-1'))->>'state',
  'dispatched', 'truck inside the window closes');
select is(rpc_floor('close_truck', jsonb_build_object('client_uuid', 'cccccccc-0000-0000-0000-000000000001', 'shipment_id', :'sh1', 'e_irsaliye_no', 'IRS-1'))->>'duplicate',
  'true', 'replaying the close command is a no-op');
select test.as_system();
select ok(test.bal('GRI', 'TZ-STG-01') = 0 and test.bal('SIYAH', 'TZ-STG-01') = 0, 'staging is empty after the ship transaction');
select is((select state from sales_order where id = :'o1'), 'shipped', 'order is shipped');
select is((select count(*)::int from export_row where type = 'shipment_confirm'), 2, 'shipment confirmation written for Logo');
select ok((select window_ok and actual_kg = 24918 from truck_load where shipment_id = :'sh1'), 'truck recorded inside the window');

-- a one-pallet truck is outside the 24,900 - 25,075 kg window
select test.as_user(:'planner');
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-A'), 'requested_date', app.today(),
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','GRI'), 'qty', 1, 'uom', 'pallet'))))->>'order_id') as o2 \gset
select (rpc_confirm_order(:'o2')->>'shipment_id') as sh2 \gset
select rpc_allocate();
select test.as_user(:'op');
select rpc_floor('pick', jsonb_build_object('client_uuid', gen_random_uuid(), 'reservation_id', (select id from reservation where shipment_id = :'sh2' and type = 'hard'),
  'pallet_serial', (select serial from pallet where status = 'active' and shipment_id is null and item_id = test.id('item','sku','GRI') limit 1),
  'to_location', 'TZ-STG-01'))->>'error';
select rpc_floor('load', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', :'sh2',
  'pallet_serial', (select serial from pallet where shipment_id = :'sh2')))->>'error';
select is(rpc_floor('close_truck', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', :'sh2', 'e_irsaliye_no', 'IRS-2'))->>'error',
  'WEIGHT_OUT_OF_WINDOW', 'truck close is refused outside 24,900 to 25,075 kg');
select (rpc_request_approval('weight_override', jsonb_build_object('shipment_id', :'sh2'), 'müşteri küçük sipariş')) as ap \gset
select throws_like(format('select rpc_decide_approval(%L, true)', :'ap'), '%NOT_PERMITTED%', 'the operator cannot approve the weight override');
select test.as_user(:'ops');
select lives_ok(format('select rpc_decide_approval(%L, true)', :'ap'), 'the ops manager approves it');
select test.as_user(:'op');
select is(rpc_floor('close_truck', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', :'sh2', 'e_irsaliye_no', 'IRS-2'))->>'weight_override',
  'true', 'with the approved override the truck closes');
select test.as_system();
select ok((select override_by = :'ops' and not window_ok from truck_load where shipment_id = :'sh2'), 'override recorded with the approver');
select is((select count(*)::int from alert where rule = 'truck_weight_override'), 1, 'the override feeds the digest');
select is((select count(*)::int from (select txn_id from stock_move group by txn_id, item_id, lot_id having sum(qty_base) <> 0) x), 0, 'every transaction balanced');
select is((rpc_rebuild_check()->>'differences')::int, 0, 'ledger rebuild matches balances');
select * from finish();
rollback;
