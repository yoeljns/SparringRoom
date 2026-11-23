-- Consignment stock and free goods (spec §4.2, §9.3, §10.1).
begin;
select plan(17);
select test.base();
select test.mk_user('planner') as planner \gset
select test.mk_user('operator') as op \gset
select test.mk_user('ops_manager') as ops \gset
select test.mk_user('sales_rep') as rep \gset
insert into rep_dealer (user_id, party_id) values (:'rep', test.id('party','logo_cari_code','D-A'));
insert into location (code, type, dealer_id) values ('TZ-CONS-A', 'consignment', test.id('party','logo_cari_code','D-A'));
insert into vehicle_type (id, code, min_kg, max_kg) values ('ffffffff-0000-0000-0000-000000000001', 'VAN', 0, 3500);
select test.stock('GRI', 'G1', app.today() + 300, 2, 'TZ-B01-L01');
select test.stock('BANT', 'B1', null, 1, 'TZ-B01-L02');

-- helper: confirm, allocate, pick everything, load everything, close
create function pg_temp.ship(p_order uuid, p_op uuid, p_planner uuid) returns jsonb language plpgsql as $$
declare v_ship uuid; t record; p record; v jsonb;
begin
  perform test.as_user(p_planner);
  v_ship := (rpc_confirm_order(p_order)->>'shipment_id')::uuid;
  perform rpc_allocate();
  perform test.as_user(p_op);
  for t in select * from v_task where type = 'pick' and shipment_id = v_ship loop
    if (select type from location where id = t.location_id) = 'block_lane' and t.qty_base >= app.units_per_pallet(t.item_id) then
      for p in select serial from pallet where location_id = t.location_id and status = 'active' and shipment_id is null limit ceil(t.pallets)::int loop
        v := rpc_floor('pick', jsonb_build_object('client_uuid', gen_random_uuid(), 'task_id', t.id, 'pallet_serial', p.serial, 'to_location', 'TZ-STG-01'));
        if v ? 'error' then raise exception 'pick: %', v; end if;
      end loop;
    else
      v := rpc_floor('pick', jsonb_build_object('client_uuid', gen_random_uuid(), 'task_id', t.id,
             'pallet_serial', (select serial from pallet where location_id = t.location_id and status = 'active' and shipment_id is null limit 1),
             'to_location', 'TZ-STG-01'));
      if v ? 'error' then raise exception 'partial pick: %', v; end if;
    end if;
  end loop;
  for p in select serial from pallet where shipment_id = v_ship loop
    v := rpc_floor('load', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', v_ship, 'pallet_serial', p.serial));
    if v ? 'error' then raise exception 'load: %', v; end if;
  end loop;
  v := rpc_floor('close_truck', jsonb_build_object('client_uuid', gen_random_uuid(), 'shipment_id', v_ship, 'e_irsaliye_no', 'IRS-' || left(v_ship::text, 6)));
  perform test.as_system();
  return v;
end $$;

-- consignment order: stock moves to the dealer's consignment location, still owned by Dayson
select test.as_user(:'planner');
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-A'), 'requested_date', app.today(),
  'order_type', 'consignment', 'vehicle_type_id', 'ffffffff-0000-0000-0000-000000000001',
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','GRI'), 'qty', 1, 'uom', 'pallet'))))->>'order_id') as o1 \gset
select is(pg_temp.ship(:'o1', :'op', :'planner')->>'state', 'dispatched', 'consignment truck closes');
select is((select count(*)::int from stock_txn where txn_type = 'consign_out'), 1, 'truck close posted consign_out');
select is(test.bal('GRI', 'TZ-CONS-A', 'available'), 1200::numeric, 'stock is available at the dealer''s consignment location');
select is((select owner_id from stock_balance where location_id = test.id('location','code','TZ-CONS-A') and qty_base > 0), app.dayson(), 'owner stays Dayson');
select is((select on_hand_available from v_available where sku = 'GRI'), 1200::numeric, 'consignment stock is excluded from central ATP');

-- the rep reports a sale: consignment_consume and an invoice request for Logo
select test.as_user(:'rep');
select is(rpc_floor('consignment_consume', jsonb_build_object('client_uuid', gen_random_uuid(), 'party_id', test.id('party','logo_cari_code','D-A'),
  'item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'G1'), 'qty', 100))->>'error', null, 'rep posts the dealer sale');
select is(rpc_floor('consignment_consume', jsonb_build_object('client_uuid', gen_random_uuid(), 'party_id', test.id('party','logo_cari_code','D-B'),
  'item_id', test.id('item','sku','GRI'), 'qty', 1))->>'error', 'NOT_PERMITTED', 'but not for another rep''s dealer');
select test.as_system();
select is(test.bal('GRI', 'TZ-CONS-A'), 1100::numeric, 'consignment balance reduced');
select is((select (payload->>'qty')::numeric from export_row where type = 'consignment_sales'), 100::numeric, 'invoice request written to the Logo outbound queue');

-- a rep count finds less than the balance: confirmed by a second user, posted as consumption
select test.as_user(:'rep');
select rpc_create_count_task('TZ-CONS-A', 'visit') as ct \gset
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct', 'qty', 1000,
  'item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'G1')))->>'state', 'recount', 'rep count with a shortfall needs a recount');
select test.as_user(:'ops');
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct', 'qty', 1000, 'reason_code', 'dealer_sale'))->>'state',
  'closed', 'confirmed by a second user');
select test.as_system();
select is(test.bal('GRI', 'TZ-CONS-A'), 1000::numeric, 'the shortfall was consumed');
select is((select count(*)::int from stock_txn where txn_type = 'consignment_consume'), 2, 'as consignment_consume, not as an adjustment');

-- free goods ship with issue_free_goods and stay separate from paid quantity
select test.as_user(:'planner');
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-B'), 'requested_date', app.today(),
  'vehicle_type_id', 'ffffffff-0000-0000-0000-000000000001',
  'lines', jsonb_build_array(
    jsonb_build_object('ref', 'p', 'item_id', test.id('item','sku','BANT'), 'qty', 240),
    jsonb_build_object('parent_ref', 'p', 'item_id', test.id('item','sku','BANT'), 'qty', 24, 'line_type', 'free', 'mechanic_code', 'buy_x_get_y'))))->>'order_id') as o2 \gset
select is(pg_temp.ship(:'o2', :'op', :'planner')->>'state', 'dispatched', 'order with a free line ships');
select is((select sum(m.qty_base) from stock_move m join stock_txn t on t.id = m.txn_id join location l on l.id = m.location_id
            where t.txn_type = 'issue_free_goods' and l.code = 'V-CUSTOMER'), 24::numeric, 'free line shipped with issue_free_goods');
select is((select sum(m.qty_base) from stock_move m join stock_txn t on t.id = m.txn_id join location l on l.id = m.location_id
            where t.txn_type = 'ship' and l.code = 'V-CUSTOMER'), 240::numeric, 'paid line shipped with ship');
select is((select array_agg(payload->>'line_type' order by payload->>'line_type') from export_row where type = 'shipment_confirm' and payload->>'logo_item_code' = 'L-BANT'),
  array['free','paid'], 'Logo receives paid and free lines apart');
select * from finish();
rollback;
