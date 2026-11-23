-- Roles, approvals, blind counts, parameters (spec §5.5, §12, §13.2).
begin;
select plan(43);
select test.base();
select test.mk_user('owner') as owner \gset
select test.mk_user('ops_manager') as ops \gset
select test.mk_user('operator') as op \gset
select test.mk_user('operator', 'operator 2') as op2 \gset
select test.mk_user('qc') as qc \gset
select test.mk_user('planner') as planner \gset
select test.mk_user('sales_rep') as rep \gset
select test.mk_user('finance') as fin \gset
select test.mk_user('auditor') as aud \gset
insert into rep_dealer (user_id, party_id) values (:'rep', test.id('party','logo_cari_code','D-A'));
select test.stock('GRI', 'G1', app.today() + 300, 2, 'TZ-B01-L01');
select test.stock('SIYAH', 'S1', app.today() + 300, 2, 'TZ-B01-L02');
select test.stock('BANT', 'B1', null, 1, 'TZ-STG-01');

-- §12.1: each role's forbidden actions are refused by the database, not only hidden
select test.as_user(:'owner');
select throws_ok($$ update stock_move set qty_base = 1 $$, '42501', null, 'owner: cannot edit ledger rows (nobody can)');
select throws_ok($$ delete from stock_txn $$, '42501', null, 'owner: cannot delete ledger rows');

select test.as_user(:'ops');
select throws_like($$ select rpc_param_propose('[{"param":"mrsl_days","value":150}]') $$, '%NOT_PERMITTED%', 'ops_manager: cannot publish planning parameters');
select throws_like($$ select rpc_plan_publish(app.current_plan_version()) $$, '%NOT_PERMITTED%', 'ops_manager: cannot publish the plan');

select test.as_system();
select rpc_create_count_task('TZ-B01-L01', 'scheduled') as ct1 \gset
select test.as_user(:'op');
select is((select count(*)::int from count_task), 0, 'operator: cannot read count_task (expected quantities)');
select is((select count(*)::int from v_count_task), 0, 'operator: the full count view is empty');
select is((select count(*)::int from v_count_task_blind), 1, 'operator: sees the blind count list');
select is((select count(*)::int from information_schema.columns where table_name = 'v_count_task_blind' and column_name in ('expected_qty','variance')), 0,
  'the blind list has no expected quantity or variance');
select is(test.post('count_adjust', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'G1'),
  'from_location', 'V-ADJUSTMENT', 'to_location', 'TZ-B01-L01', 'qty_entered', 1), '{"reason_code":"x"}')->>'error', 'NOT_PERMITTED', 'operator: cannot adjust stock');
select is((select count(*)::int from scan_event), 0, 'operator: cannot read scan logs');

select test.as_user(:'qc');
select is(test.post('ship', jsonb_build_object('item_id', test.id('item','sku','BANT'), 'from_location', 'TZ-STG-01', 'qty_entered', 1))->>'error',
  'NOT_PERMITTED', 'qc: cannot ship stock');

select test.as_user(:'rep');
select is((select count(*)::int from party where type = 'dealer'), 1, 'sales_rep: sees only own dealers');
select throws_like(format($$ select rpc_save_order(jsonb_build_object('party_id', %L, 'requested_date', app.today(), 'lines', '[]'::jsonb)) $$,
  test.id('party','logo_cari_code','D-B')), '%NOT_PERMITTED%', 'sales_rep: cannot order for another rep''s dealer');
select is(test.post('count_adjust', jsonb_build_object('item_id', test.id('item','sku','GRI'), 'lot_id', (select id from lot where lot_no = 'G1'),
  'from_location', 'TZ-B01-L01', 'to_location', 'V-ADJUSTMENT', 'qty_entered', 1), '{"reason_code":"x"}')->>'error', 'NOT_PERMITTED',
  'sales_rep: cannot adjust central stock');

select test.as_user(:'fin');
select is(test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','BANT'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 1))->>'error',
  'NOT_PERMITTED', 'finance: cannot post stock transactions');
select cmp_ok((select count(*)::int from stock_move), '>', 0, 'finance: reads the ledger');

select test.as_user(:'aud');
select is(test.post('receipt_purchase', jsonb_build_object('item_id', test.id('item','sku','BANT'), 'to_location', 'TZ-DOCK-01', 'qty_entered', 1))->>'error',
  'NOT_PERMITTED', 'auditor: cannot post stock transactions');
select throws_like($$ select rpc_upsert('market', '{"code":"XX","name":"x"}') $$, '%NOT_PERMITTED%', 'auditor: cannot write master data');
select throws_ok($$ insert into market (code, name) values ('YY', 'y') $$, '42501', null, 'auditor: direct writes are denied');
select cmp_ok((select count(*)::int from audit_log), '>', 0, 'auditor: reads the audit log');

select test.as_user(:'op');
select throws_ok($$ insert into item_family (code, name) values ('ZZ', 'z') $$, '42501', null, 'no role writes tables directly');
set local role anon;
select throws_ok($$ select count(*) from item $$, '42501', null, 'anonymous callers read nothing');
select throws_ok($$ select post_txn('{}'::jsonb) $$, '42501', null, 'anonymous callers cannot call post_txn');

-- §12.2 two-person rule: planner proposes a parameter, cannot approve it, owner publishes
select test.as_user(:'planner');
select (rpc_param_propose('[{"param":"release_horizon_working_days","value":7}]', 'daha uzun ufuk')->>'approval_id') as pa \gset
select throws_like(format('select rpc_decide_approval(%L, true)', :'pa'), '%NOT_PERMITTED%', 'planner: cannot approve own parameter change');
select is((resolve_param('release_horizon_working_days')->>'value')::int, 5, 'a draft parameter has no effect');
select test.as_user(:'owner');
select lives_ok(format('select rpc_decide_approval(%L, true)', :'pa'), 'owner publishes the parameter change');
select is((resolve_param('release_horizon_working_days')->>'value')::int, 7, 'the published version is in force');
select is((select count(*)::int from planning_param where param = 'release_horizon_working_days' and state = 'superseded'), 1, 'the old row is kept, effective-dated');

-- §3.8 lookup chain: the most specific level wins and is reported
select test.as_system();
select is(resolve_param('mrsl_days', jsonb_build_object('party_id', test.id('party','logo_cari_code','D-A')))->>'level', 'global', 'domestic dealer: global default');
select is(resolve_param('mrsl_days', jsonb_build_object('party_id', test.id('party','logo_cari_code','I-DE')))->>'value', '240', 'export market: 240 days');
insert into planning_param (scope_type, scope_id, param, value) values ('party', test.id('party','logo_cari_code','I-DE')::text, 'mrsl_days', '270');
select is(resolve_param('mrsl_days', jsonb_build_object('party_id', test.id('party','logo_cari_code','I-DE')))->>'level', 'party', 'importer contract overrides the market');

-- §5.5 counting
select test.as_user(:'op');
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct1', 'qty', 2, 'uom', 'pallet'))->>'state', 'closed',
  'a count within tolerance closes the task');
select test.as_system();
select is((select ira_pct from v_ira_daily limit 1), 100.00::numeric, 'inventory record accuracy = within tolerance / counted');
select rpc_create_count_task('TZ-B01-L02', 'scheduled') as ct2 \gset
select test.as_user(:'op');
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct2', 'qty', 1, 'uom', 'pallet'))->>'state', 'recount',
  'a variance outside tolerance creates a recount');
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct2', 'qty', 1, 'uom', 'pallet', 'reason_code', 'missing'))->>'error',
  'RECOUNT_DIFFERENT_USER', 'the recount must be a different user');
select test.as_user(:'op2');
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct2', 'qty', 1, 'uom', 'pallet'))->>'error',
  'REASON_REQUIRED', 'a confirmed variance needs a reason code');
select is(rpc_floor('count', jsonb_build_object('client_uuid', gen_random_uuid(), 'count_task_id', :'ct2', 'qty', 1, 'uom', 'pallet', 'reason_code', 'missing'))->>'state',
  'pending_approval', 'an adjustment above the EUR threshold waits for a second approver');
select test.as_system();
select is(test.bal('SIYAH', 'TZ-B01-L02'), 2400::numeric, 'no adjustment before approval');
select test.as_user(:'ops');
select lives_ok(format('select rpc_decide_approval(%L, true)', (select approval_id from count_task where id = :'ct2')), 'ops manager approves the adjustment');
select test.as_system();
select is(test.bal('SIYAH', 'TZ-B01-L02'), 1200::numeric, 'count_adjust posted after the confirmed recount');
select is((select reason_code from stock_txn where txn_type = 'count_adjust'), 'missing', 'the adjustment carries its reason code');
select test.as_user(:'owner');
select lives_ok('select rpc_digest()', 'the daily digest builds');
select lives_ok('select rpc_dashboard()', 'the owner dashboard builds');
select * from finish();
rollback;
