-- Campaign engine (spec §9, §13.2 "Campaigns").
begin;
select plan(27);
select test.base();
select test.mk_user('owner') as owner \gset
select test.mk_user('planner') as planner \gset
select test.mk_user('operator') as op \gset
select test.stock('GRI', 'GA', app.today() + 200, 3, 'TZ-B01-L01');
select test.stock('SIYAH', 'SB', app.today() + 150, 1, 'TZ-B01-L02');

select test.as_user(:'planner');
-- each mechanic's parameters are validated against its schema
select throws_like(format($$ select rpc_campaign_save(jsonb_build_object('code', 'X-%s', 'name', 'x', 'order_from', app.today(), 'order_to', app.today() + 10,
  'mechanics', jsonb_build_array(jsonb_build_object('mechanic_type', %L, 'params', %L::jsonb)))) $$, m.code, m.code, m.bad),
  '%INVALID_PARAMS%', m.code || ': parameters outside the schema are rejected')
from (values
  ('price_discount', '{"discount_pct": 140}'),
  ('volume_tier', '{"tiers": []}'),
  ('buy_x_get_y', '{"buy_qty": 10, "free_qty": 1}'),
  ('mixed_set', '{"price": 10}'),
  ('gift_item', '{"gift_item": "X", "qty": -1}'),
  ('target_rebate', '{"period": "Q1", "rebate_pct": 3}'),
  ('launch_seed', '{"item": 5, "seed_qty": {}}'),
  ('export_push', '{"market": "DE", "items": []}')) m(code, bad);

select (rpc_campaign_save(jsonb_build_object('code', 'KMP-01', 'name', '10 al 1 bedava', 'order_from', app.today(), 'order_to', app.today() + 14,
  'scopes', jsonb_build_array(jsonb_build_object('item_rule', jsonb_build_object('skus', jsonb_build_array('GRI')), 'party_rule', '{"segments":["A"]}'::jsonb)),
  'mechanics', jsonb_build_array(jsonb_build_object('mechanic_type', 'buy_x_get_y',
     'params', jsonb_build_object('buy_item_rule', '{"skus":["GRI"]}'::jsonb, 'buy_qty', 10, 'free_item', 'same', 'free_qty', 1)))))->>'campaign_id') as c \gset
select is((select state from campaign where id = :'c'), 'draft', 'a valid campaign is saved as draft with data entry only');
select throws_like(format('select rpc_campaign_request_approval(%L)', :'c'), '%SIMULATION_STALE%',
  'a campaign cannot be approved without a simulation');

-- the worker completes a simulation against the current plan
select test.as_system();
insert into campaign_forecast (campaign_id, item_id, week, baseline, uplift, free_qty)
values (:'c', test.id('item','sku','GRI'), app.week_start(app.today()), 1000, 400, 40);
select rpc_campaign_simulation_done(:'c', null, '{"items":[]}');
select is((select state from campaign where id = :'c'), 'simulated', 'simulation moves the campaign to simulated');
-- a newer plan version makes the simulation stale
insert into plan_version (id, name) values ('dddddddd-0000-0000-0000-000000000001', 'yeni plan');
select test.as_user(:'owner');
select rpc_plan_publish('dddddddd-0000-0000-0000-000000000001');
select test.as_user(:'planner');
select throws_like(format('select rpc_campaign_request_approval(%L)', :'c'), '%SIMULATION_STALE%',
  'a simulation older than the current plan version does not count');
select test.as_system();
select rpc_campaign_simulation_done(:'c', null, '{"items":[]}');
select test.as_user(:'planner');
select (rpc_campaign_request_approval(:'c')) as ap \gset
select throws_like(format('select rpc_decide_approval(%L, true)', :'ap'), '%NOT_PERMITTED%', 'planner: cannot approve own campaign');
select test.as_user(:'owner');
select lives_ok(format('select rpc_decide_approval(%L, true)', :'ap'), 'owner approves the campaign');
select is((select state from campaign where id = :'c'), 'approved', 'campaign is approved');
select is((select qty_base from reservation where campaign_id = :'c' and demand_line_id is null and state = 'active'), 440::numeric,
  'approval creates the ring-fence reservation');
select test.as_system();
select rpc_campaign_tick();
select is((select state from campaign where id = :'c'), 'live', 'the order window opening makes the campaign live');
select test.as_user(:'planner');
select is(jsonb_array_length(rpc_campaigns_for_order(test.id('party','logo_cari_code','D-A'))), 1, 'in-scope dealer gets the live campaign at order entry');
select is(jsonb_array_length(rpc_campaigns_for_order(test.id('party','logo_cari_code','D-B'))), 0, 'out-of-scope dealer does not');

-- phantom bundle: the bundle SKU is never stocked; components are reserved and picked
select test.as_system();
insert into item (sku, name, family_id) values ('SET1', 'Set', test.id('item_family','code','SEAL'));
insert into bundle (id, item_id, kind) values ('eeeeeeee-0000-0000-0000-000000000001', test.id('item','sku','SET1'), 'phantom');
insert into bundle_line (bundle_id, component_item_id, qty) values ('eeeeeeee-0000-0000-0000-000000000001', test.id('item','sku','GRI'), 6);
select test.as_user(:'planner');
select (rpc_save_order(jsonb_build_object('party_id', test.id('party','logo_cari_code','D-B'), 'requested_date', app.today(),
  'lines', jsonb_build_array(
    jsonb_build_object('ref', 'a', 'item_id', test.id('item','sku','SET1'), 'qty', 2),
    jsonb_build_object('parent_ref', 'a', 'item_id', test.id('item','sku','GRI'), 'qty', 12, 'line_type', 'bundle_component',
                       'bundle_id', 'eeeeeeee-0000-0000-0000-000000000001'))))->>'order_id') as o \gset
select ok((select is_phantom from so_line where order_id = :'o' and item_id = test.id('item','sku','SET1')), 'the bundle SKU line is phantom');
select rpc_confirm_order(:'o');
select rpc_allocate();
select is((select array_agg(distinct i.sku) from reservation r join item i on i.id = r.item_id join so_line l on l.id = r.demand_line_id where l.order_id = :'o'),
  array['GRI'], 'a phantom bundle order reserves components only');
select is((select array_agg(distinct i.sku) from task t join item i on i.id = t.item_id where t.type = 'pick'), array['GRI'],
  'and picks components only');

-- pre-built kit: the kit lot takes the earliest component expiry
select test.as_system();
insert into item (sku, name, family_id, lot_expiry_controlled) values ('KIT1', 'Kit', test.id('item_family','code','SEAL'), true);
insert into bundle (id, item_id, kind) values ('eeeeeeee-0000-0000-0000-000000000002', test.id('item','sku','KIT1'), 'prebuilt');
insert into bundle_line (bundle_id, component_item_id, qty) values
  ('eeeeeeee-0000-0000-0000-000000000002', test.id('item','sku','GRI'), 2), ('eeeeeeee-0000-0000-0000-000000000002', test.id('item','sku','SIYAH'), 1);
select test.as_user(:'op');
select is(rpc_floor('kit_assemble', jsonb_build_object('client_uuid', gen_random_uuid(), 'bundle_id', 'eeeeeeee-0000-0000-0000-000000000002',
  'qty', 10, 'kit_lot_no', 'K1', 'to_location', 'TZ-B01-L05'))->>'error', null, 'kit_assemble posts');
select test.as_system();
select is((select expiry_date from lot where lot_no = 'K1'), app.today() + 150, 'the kit lot takes the earliest component expiry');
select is(test.bal('KIT1', 'TZ-B01-L05', 'available'), 10::numeric, 'kits are in stock');
select is(test.bal('SIYAH', 'TZ-B01-L02'), 1190::numeric, 'components were consumed');
select is((select count(*)::int from (select txn_id from stock_move group by txn_id, item_id, lot_id having sum(qty_base) <> 0) x), 0, 'kit transaction balanced per item and lot');
select * from finish();
rollback;
