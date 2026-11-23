-- After 10,000 random valid transactions, rebuilt balances equal stock_balance (spec §13.2).
begin;
select plan(4);
select test.base();

do $$
declare
  v_items uuid[] := array[test.id('item','sku','GRI'), test.id('item','sku','SIYAH'), test.id('item','sku','BANT')];
  v_lots uuid[];
  v_real text[] := array['TZ-DOCK-01','TZ-STG-01','TZ-PF-01','TZ-B01-L01','TZ-B01-L02','TZ-B01-L03','TZ-B01-L04','TZ-B01-L05','TZ-B01-L06','TZ-B01-L07','TZ-B01-L08'];
  v_ok int := 0; v_tries int := 0;
  v_item uuid; v_lot uuid; v_from text; v_to text; v_type text; v_qty numeric; v_r float; v_res jsonb;
  v_txns uuid[] := '{}';
  v_line jsonb;
begin
  perform setseed(0.7);
  insert into lot (item_id, lot_no, expiry_date)
  select i, 'R' || n, current_date + 200 + n * 10 from unnest(v_items[1:2]) i, generate_series(1, 3) n;
  while v_ok < 10000 and v_tries < 80000 loop
    v_tries := v_tries + 1;
    v_item := v_items[1 + floor(random() * 3)::int];
    v_lot := case when v_item = v_items[3] then null
                  else (select id from lot where item_id = v_item order by random() limit 1) end;
    v_from := v_real[1 + floor(random() * 11)::int];
    v_to := v_real[1 + floor(random() * 11)::int];
    v_qty := 1 + floor(random() * 40);
    v_r := random();
    v_line := jsonb_strip_nulls(jsonb_build_object('item_id', v_item, 'lot_id', v_lot, 'qty_entered', v_qty));
    if v_r < 0.25 then
      v_type := 'receipt_purchase'; v_line := v_line || jsonb_build_object('to_location', 'TZ-DOCK-01', 'qty_entered', v_qty * 20);
    elsif v_r < 0.35 then
      v_type := 'qc_release'; v_line := v_line || jsonb_build_object('location', v_from);
    elsif v_r < 0.55 then
      v_type := 'putaway'; v_line := v_line || jsonb_build_object('from_location', 'TZ-DOCK-01', 'to_location', v_to);
    elsif v_r < 0.70 then
      v_type := 'transfer'; v_line := v_line || jsonb_build_object('from_location', v_from, 'to_location', v_to);
    elsif v_r < 0.82 then
      v_type := 'pick'; v_line := v_line || jsonb_build_object('from_location', v_from, 'to_location', 'TZ-STG-01');
    elsif v_r < 0.90 then
      v_type := 'ship'; v_line := v_line || jsonb_build_object('from_location', 'TZ-STG-01');
    elsif v_r < 0.94 then
      v_type := 'count_adjust';
      v_line := v_line || case when random() < 0.5
        then jsonb_build_object('from_location', 'V-ADJUSTMENT', 'to_location', v_to, 'qty_entered', 1)
        else jsonb_build_object('from_location', v_from, 'to_location', 'V-ADJUSTMENT', 'qty_entered', 1) end;
    elsif v_r < 0.97 then
      v_type := 'qc_reject'; v_line := v_line || jsonb_build_object('location', v_from);
    else
      v_type := 'reversal';
    end if;
    if v_type = 'reversal' then
      continue when cardinality(v_txns) = 0;
      v_res := post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', 'reversal', 'reason_code', 'test',
                 'reverses_txn_id', v_txns[1 + floor(random() * cardinality(v_txns))::int]));
    else
      v_res := post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', v_type, 'reason_code', 'test',
                 'lines', jsonb_build_array(v_line)));
    end if;
    if not v_res ? 'error' then
      v_ok := v_ok + 1;
      if v_type <> 'reversal' and cardinality(v_txns) < 500 then v_txns := v_txns || (v_res->>'txn_id')::uuid; end if;
    end if;
  end loop;
  perform set_config('test.valid_txns', v_ok::text, true);
end $$;

select cmp_ok(current_setting('test.valid_txns')::int, '>=', 10000, '10,000 random valid transactions were posted');
select is((
  select count(*)::int from (
    select item_id, lot_id, location_id, owner_id, stock_status, sum(qty_base) q from stock_move group by 1,2,3,4,5) s
  full join stock_balance b on b.item_id = s.item_id and b.lot_id is not distinct from s.lot_id and b.location_id = s.location_id
       and b.owner_id = s.owner_id and b.stock_status = s.stock_status
  where coalesce(s.q, 0) <> coalesce(b.qty_base, 0)), 0, 'balances rebuilt from the ledger equal stock_balance');
select is((select count(*)::int from stock_balance b join location l on l.id = b.location_id where l.type <> 'virtual' and b.qty_base < 0), 0,
  'no real location is negative');
select is((select count(*)::int from (select txn_id from stock_move group by txn_id, item_id, lot_id having sum(qty_base) <> 0) x), 0,
  'every transaction sums to zero per item and lot');
select * from finish();
rollback;
