-- Ledger invariants (spec §4.3, §13.2 "Ledger").
begin;
select plan(27);
select test.base();

-- receive two pallets of lot L1 and one of L2 onto the dock (quarantine)
select lives_ok($$ insert into lot (item_id, lot_no, expiry_date) values
  (test.id('item','sku','GRI'), 'L1', current_date + 300), (test.id('item','sku','GRI'), 'L2', current_date + 330) $$, 'lots created');
select is(test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','GRI'),
  'lot_id', (select id from lot where lot_no = 'L1'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 2, 'uom', 'pallet'))->>'error',
  null, 'receipt posts');
select is(test.bal('GRI', 'TZ-DOCK-01', 'quarantine'), 2400::numeric, 'receipt lands in quarantine, converted through uom_pack');
select is(test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','GRI'),
  'lot_id', (select id from lot where lot_no = 'L2'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 1, 'uom', 'pallet'))->>'error',
  null, 'second lot received');

-- 1. an unbalanced transaction is rejected
insert into stock_txn (id, txn_type, event_at, client_uuid) values ('11111111-1111-1111-1111-111111111111', 'transfer', now(), gen_random_uuid());
select throws_like($$
  insert into stock_move (txn_id, line_no, item_id, lot_id, location_id, owner_id, stock_status, qty_base)
  select '11111111-1111-1111-1111-111111111111', 1, test.id('item','sku','GRI'), (select id from lot where lot_no = 'L1'),
         test.id('location','code','TZ-B01-L08'), app.dayson(), 'available', 5;
  set constraints all immediate; $$, '%UNBALANCED%', 'an unbalanced transaction is rejected');

-- 2. UPDATE and DELETE on stock_move fail for every role
select ok(not has_table_privilege('anon', 'public.stock_move', 'UPDATE') and not has_table_privilege('anon', 'public.stock_move', 'DELETE')
          and not has_table_privilege('anon', 'public.stock_move', 'INSERT'), 'anon holds no write privilege on stock_move');
select ok(not has_table_privilege('authenticated', 'public.stock_move', 'UPDATE') and not has_table_privilege('authenticated', 'public.stock_move', 'DELETE')
          and not has_table_privilege('authenticated', 'public.stock_move', 'INSERT'), 'authenticated holds no write privilege on stock_move');
select ok(not has_table_privilege('service_role', 'public.stock_move', 'UPDATE') and not has_table_privilege('service_role', 'public.stock_move', 'DELETE')
          and not has_table_privilege('service_role', 'public.stock_txn', 'UPDATE') and not has_table_privilege('service_role', 'public.stock_txn', 'DELETE'),
          'the service role holds no UPDATE or DELETE on the ledger');
select throws_like($$ update stock_move set qty_base = 1 $$, '%IMMUTABLE%', 'UPDATE on stock_move fails even for the table owner');
select throws_like($$ delete from stock_move $$, '%IMMUTABLE%', 'DELETE on stock_move fails even for the table owner');
select throws_like($$ delete from stock_txn $$, '%IMMUTABLE%', 'DELETE on stock_txn fails even for the table owner');

-- put-away before QC release: status travels with the stock
select is(test.post('putaway', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'L1'),
  'from_location', 'TZ-DOCK-01', 'to_location', 'TZ-B01-L01', 'qty_entered', 2, 'uom', 'pallet'))->>'error', null, 'put-away before QC release is allowed');
select is(test.bal('GRI', 'TZ-B01-L01', 'quarantine'), 2400::numeric, 'status travels with the pallet');

-- 5. put-away of a second lot into an occupied lane fails with LANE_MIXED
select is(test.post('putaway', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'L2'),
  'from_location', 'TZ-DOCK-01', 'to_location', 'TZ-B01-L01', 'qty_entered', 1, 'uom', 'pallet'))->>'error', 'LANE_MIXED',
  'a second lot into an occupied lane fails with LANE_MIXED');

-- QC release, then 3. a pick larger than the balance fails with NEGATIVE_BALANCE
select is(test.post('qc_release', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'L1'),
  'location', 'TZ-B01-L01', 'qty_entered', 2400))->>'error', null, 'qc_release posts');
select is(test.post('pick', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'L1'),
  'from_location', 'TZ-B01-L01', 'to_location', 'TZ-STG-01', 'qty_entered', 3, 'uom', 'pallet'))->>'error', 'NEGATIVE_BALANCE',
  'a pick larger than the balance fails with NEGATIVE_BALANCE');
select is(test.bal('GRI', 'TZ-B01-L01'), 2400::numeric, 'the refused pick left the balance untouched');
select is((select count(*)::int from alert where rule = 'negative_balance'), 1, 'the refusal raised a real-time alert');

-- 4. the same client_uuid posted twice creates one transaction
select is((post_txn(jsonb_build_object('client_uuid', '22222222-2222-2222-2222-222222222222', 'txn_type', 'pick',
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'L1'),
  'from_location', 'TZ-B01-L01', 'to_location', 'TZ-STG-01', 'qty_entered', 1, 'uom', 'pallet')))))->>'duplicate', 'false', 'first post');
select is((post_txn(jsonb_build_object('client_uuid', '22222222-2222-2222-2222-222222222222', 'txn_type', 'pick',
  'lines', jsonb_build_array(jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'L1'),
  'from_location', 'TZ-B01-L01', 'to_location', 'TZ-STG-01', 'qty_entered', 1, 'uom', 'pallet')))))->>'duplicate', 'true',
  'second post with the same client_uuid returns the original result');
select is((select count(*)::int from stock_txn where client_uuid = '22222222-2222-2222-2222-222222222222'), 1, 'one transaction exists');
select is(test.bal('GRI', 'TZ-STG-01'), 1200::numeric, 'and it moved stock once');

-- 6. a reversal restores balances exactly and cannot be reversed again
select is((post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', 'reversal', 'reason_code', 'wrong_pallet',
  'reverses_txn_id', (select id from stock_txn where client_uuid = '22222222-2222-2222-2222-222222222222'))))->>'error', null, 'reversal posts');
select ok(test.bal('GRI', 'TZ-STG-01') = 0 and test.bal('GRI', 'TZ-B01-L01', 'available') = 2400, 'the reversal restores balances exactly');
select is((post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', 'reversal', 'reason_code', 'again',
  'reverses_txn_id', (select id from stock_txn where client_uuid = '22222222-2222-2222-2222-222222222222'))))->>'error', 'ALREADY_REVERSED',
  'a transaction can be reversed once');

-- 6b. an expiry-controlled item needs a lot with an expiry date
select is(test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 1))->>'error',
  'LOT_REQUIRED', 'a move for an expiry-controlled item requires a lot');

-- 8. event_at earlier than recorded_at needs a reason code
select is(test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','BANT'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 5),
  jsonb_build_object('event_at', now() - interval '2 hours'))->>'error', 'REASON_REQUIRED', 'backdating needs a reason code');

select * from finish();
rollback;
