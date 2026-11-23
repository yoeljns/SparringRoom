-- LOCAL ONLY: one demo user per role for the dev API (all share the dev password).
insert into auth.users (id, email)
select md5('dayson-dev-' || r)::uuid, r || '@dayson.test'
from unnest(array['owner','ops_manager','operator','operator2','qc','planner','sales_rep','finance','auditor']) r
on conflict do nothing;
insert into public.app_user (id, full_name, email, role)
select md5('dayson-dev-' || r)::uuid, n, r || '@dayson.test', regexp_replace(r, '2$', '')
from (values ('owner','Yoel (Sahip)'), ('ops_manager','Depo Müdürü'), ('operator','Operatör Ali'), ('operator2','Operatör Veli'),
             ('qc','Kalite Ayşe'), ('planner','Planlamacı Can'), ('sales_rep','Satış Temsilcisi Ece'), ('finance','Finans Deniz'), ('auditor','Denetçi')) v(r, n)
on conflict (id) do nothing;
insert into public.rep_dealer (user_id, party_id)
select md5('dayson-dev-sales_rep')::uuid, id from public.party where logo_cari_code in ('120.01.001', '120.01.002')
on conflict do nothing;
