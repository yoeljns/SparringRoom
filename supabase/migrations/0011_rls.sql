-- 0011 Row-level security and privileges (spec §12, §13.1).
-- Access is enforced in the database: RLS on every table, no direct writes for API roles
-- (every write goes through post_txn / rpc_*), and views run with the caller's rights
-- except the few that deliberately expose a reduced projection.

do $$
declare
  t record;
  v_using text;
begin
  for t in select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' loop
    execute format('alter table public.%I enable row level security', t.name);
    execute format('revoke all on public.%I from anon, public', t.name);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t.name);
    execute format('grant select on public.%I to authenticated', t.name);

    v_using := case t.name
      -- KVKK: scan logs and per-user metrics are limited to owner and ops_manager (§12.3)
      when 'scan_event' then $p$app.user_role() in ('owner','ops_manager')$p$
      when 'audit_log' then $p$app.user_role() in ('owner','ops_manager','auditor','finance')$p$
      when 'command_log' then $p$app.user_role() in ('owner','ops_manager','auditor') or user_id = auth.uid()$p$
      -- counts are blind: operators and reps read v_count_task_blind instead (§5.5)
      when 'count_task' then $p$app.user_role() in ('owner','ops_manager','finance','auditor','planner','qc')$p$
      when 'count_result' then $p$app.user_role() in ('owner','ops_manager','finance','auditor','planner','qc')$p$
      -- sales reps see only their own dealers (§12.1)
      when 'party' then $p$app.user_role() is not null and (type <> 'dealer' or app.rep_can(id))$p$
      when 'sales_order' then $p$app.user_role() is not null and app.rep_can(party_id)$p$
      when 'so_line' then $p$app.user_role() is not null and exists (select 1 from public.sales_order o where o.id = order_id)$p$
      when 'shipment' then $p$app.user_role() is not null and app.rep_can(party_id)$p$
      when 'shipment_line' then $p$app.user_role() is not null and exists (select 1 from public.shipment s where s.id = shipment_id)$p$
      when 'truck_load' then $p$app.user_role() is not null and exists (select 1 from public.shipment s where s.id = shipment_id)$p$
      when 'dealer_stock_observation' then $p$app.user_role() is not null and app.rep_can(party_id)$p$
      when 'dealer_stock_estimate' then $p$app.user_role() is not null and app.rep_can(party_id)$p$
      when 'vmi_param' then $p$app.user_role() is not null and app.rep_can(party_id)$p$
      when 'vmi_proposal' then $p$app.user_role() is not null and app.rep_can(party_id)$p$
      when 'rep_dealer' then $p$app.user_role() is not null and (app.user_role() <> 'sales_rep' or user_id = auth.uid())$p$
      when 'reservation' then $p$app.user_role() is not null and (party_id is null or app.rep_can(party_id))$p$
      when 'task' then $p$app.user_role() is not null and (party_id is null or app.rep_can(party_id))$p$
      when 'location' then $p$app.user_role() is not null and (dealer_id is null or app.rep_can(dealer_id))$p$
      else $p$app.user_role() is not null$p$ end;
    execute format('drop policy if exists p_select on public.%I', t.name);
    execute format('create policy p_select on public.%I for select to authenticated using (%s)', t.name, v_using);
  end loop;

  -- views: caller's rights by default, so the table policies above apply through them
  for t in select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'v' loop
    execute format('revoke all on public.%I from anon, public', t.name);
    execute format('grant select on public.%I to authenticated, service_role', t.name);
    if t.name not in ('v_count_task_blind','v_count_task','v_ira_daily','v_scan_compliance','v_scan_compliance_daily') then
      execute format('alter view public.%I set (security_invoker = true)', t.name);
    end if;
  end loop;
end $$;

-- The ledger stays insert-only for every role, including the service role (invariant 2).
revoke insert, update, delete, truncate on public.stock_txn, public.stock_move, public.stock_balance
  from anon, authenticated, service_role, public;
revoke update, delete, truncate on public.audit_log from anon, authenticated, service_role, public;

-- Functions: nothing for anonymous callers.
revoke execute on all functions in schema public from anon, public;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
alter default privileges in schema public revoke execute on functions from anon, public;

-- File exchange buckets: finance, ops manager and owner only.
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $p$drop policy if exists logo_files_rw on storage.objects$p$;
    execute $p$create policy logo_files_rw on storage.objects for all to authenticated
      using (bucket_id in ('logo-in','logo-out') and app.user_role() in ('finance','ops_manager','owner'))
      with check (bucket_id in ('logo-in','logo-out') and app.user_role() in ('finance','ops_manager','owner'))$p$;
  end if;
end $$;
