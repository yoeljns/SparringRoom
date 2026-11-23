#!/usr/bin/env bash
# 50 concurrent picks on one lot never oversell (spec §13.2). Stock: 30 units; 50 sessions
# each try to pick 1 unit at the same moment. Exactly 30 may succeed.
set -euo pipefail
URL="${DATABASE_URL:?}"
psql -Xq -v ON_ERROR_STOP=1 "$URL" >/dev/null <<'SQL'
insert into site (code, name) values ('CC', 'Concurrency');
insert into item_family (code, name) values ('CCF', 'cc');
insert into item (sku, name, family_id) select 'CC-ITEM', 'cc', id from item_family where code = 'CCF';
insert into location (code, type) values ('CC-B01-L01', 'block_lane'), ('CC-STG-01', 'staging');
select post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', 'opening_balance', 'lines', jsonb_build_array(
  jsonb_build_object('item_id', (select id from item where sku = 'CC-ITEM'), 'to_location', 'CC-B01-L01', 'qty_entered', 30))));
SQL
pids=()
for i in $(seq 1 50); do
  psql -Xqt "$URL" -c "select pg_sleep(0.3 - extract(epoch from clock_timestamp())::numeric % 0.3);
    select post_txn(jsonb_build_object('client_uuid', gen_random_uuid(), 'txn_type', 'pick', 'lines', jsonb_build_array(
      jsonb_build_object('item_id', (select id from item where sku = 'CC-ITEM'), 'from_location', 'CC-B01-L01',
                         'to_location', 'CC-STG-01', 'qty_entered', 1))))" >/dev/null 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
read -r lane staging picks < <(psql -XAt -F' ' "$URL" -c "
  select (select coalesce(sum(qty_base),0) from stock_balance b join location l on l.id=b.location_id where l.code='CC-B01-L01'),
         (select coalesce(sum(qty_base),0) from stock_balance b join location l on l.id=b.location_id where l.code='CC-STG-01'),
         (select count(*) from stock_txn where txn_type='pick' and id in (select txn_id from stock_move m join location l on l.id=m.location_id where l.code='CC-STG-01'))")
if [ "${lane%.*}" = "0" ] && [ "${staging%.*}" = "30" ] && [ "$picks" = "30" ]; then
  echo "PASS concurrency: 50 concurrent picks on 30 units -> 30 succeeded, lane balance 0, never negative"
else
  echo "FAIL concurrency: lane=$lane staging=$staging picks=$picks"; exit 1
fi
