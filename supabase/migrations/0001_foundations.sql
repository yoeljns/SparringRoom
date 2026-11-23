-- 0001 Foundations: helper schema, users and roles, audit, error helper, JSON validation.
-- Conventions (spec §2): snake_case, numeric(14,3) base-unit quantities, timestamptz UTC,
-- every table has id / created_at / created_by, mutable tables add updated_at + audit trigger.

create extension if not exists pgcrypto;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Users and roles (spec §12.1)
-- ---------------------------------------------------------------------------
create table public.app_user (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text,
  role text not null check (role in
    ('owner','ops_manager','operator','qc','planner','sales_rep','finance','auditor')),
  active boolean not null default true,
  telegram_chat_id text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

-- Acting user. The planning worker connects directly and may set app.user_id.
create or replace function app.uid() returns uuid
language sql stable as $$
  select coalesce(auth.uid(), nullif(current_setting('app.user_id', true), '')::uuid)
$$;

-- Application role of the caller.
--   registered user  -> their app_user.role
--   service key, or a direct database connection (worker, migrations) -> 'system'
--   anything else    -> null (no access)
create or replace function app.user_role() returns text
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  v_set_role text := coalesce(current_setting('role', true), 'none');
  v_role text;
begin
  if auth.uid() is not null then
    select u.role into v_role from app_user u where u.id = auth.uid() and u.active;
    return v_role;
  end if;
  if v_claims->>'role' = 'service_role' then
    return 'system';
  end if;
  if v_claims = '{}'::jsonb and v_set_role not in ('anon','authenticated') then
    return 'system';
  end if;
  return null;
end $$;

create or replace function app.has_role(variadic p_roles text[]) returns boolean
language sql stable as $$
  select app.user_role() = any (p_roles) or app.user_role() = 'system'
$$;

-- Business error: message is "CODE: detail"; clients switch on the code prefix.
create or replace function app.fail(p_code text, p_detail text default '') returns void
language plpgsql as $$
begin
  raise exception '%: %', p_code, p_detail using errcode = 'P0001', hint = p_code;
end $$;

create or replace function app.require_role(variadic p_roles text[]) returns void
language plpgsql stable as $$
begin
  if not app.has_role(variadic p_roles) then
    perform app.fail('NOT_PERMITTED', format('role %s may not do this', coalesce(app.user_role(), 'none')));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Audit log (spec §12.3) and standard triggers
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid,
  action text not null,
  old jsonb,
  new jsonb,
  user_id uuid,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index audit_log_row_idx on public.audit_log (table_name, row_id, at desc);
create index audit_log_at_idx on public.audit_log (at desc);

create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, action, new, user_id)
    values (tg_table_name, new.id, tg_op, to_jsonb(new), app.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(new) - 'updated_at' is distinct from to_jsonb(old) - 'updated_at' then
      insert into audit_log (table_name, row_id, action, old, new, user_id)
      values (tg_table_name, new.id, tg_op, to_jsonb(old), to_jsonb(new), app.uid());
    end if;
    return new;
  else
    insert into audit_log (table_name, row_id, action, old, user_id)
    values (tg_table_name, old.id, tg_op, to_jsonb(old), app.uid());
    return old;
  end if;
end $$;

create or replace function app.touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Attach updated_at + audit triggers to a mutable table.
create or replace function app.track(p_table regclass) returns void
language plpgsql as $$
begin
  execute format('create trigger trg_touch before update on %s for each row execute function app.touch()', p_table);
  execute format('create trigger trg_audit after insert or update or delete on %s for each row execute function app.audit()', p_table);
end $$;

-- Tables that may never be updated or deleted (ledger, logs).
create or replace function app.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE: % on % is not allowed', tg_op, tg_table_name using errcode = 'P0001', hint = 'IMMUTABLE';
end $$;

select app.track('public.app_user');

create trigger trg_audit_immutable before update or delete on public.audit_log
  for each row execute function app.forbid_change();

-- ---------------------------------------------------------------------------
-- Minimal JSON Schema validator (type, required, properties, enum, minimum,
-- maximum, items, minItems, additionalProperties:false, pattern). Enough for
-- item attribute schemas and campaign mechanic parameter schemas.
-- ---------------------------------------------------------------------------
create or replace function app.validate_json(p_schema jsonb, p_doc jsonb, p_path text default '$')
returns text[] language plpgsql immutable as $$
declare
  v_err text[] := '{}';
  v_type text := p_schema->>'type';
  v_doc_type text := jsonb_typeof(p_doc);
  v_key text;
  v_sub jsonb;
  v_i int := 0;
begin
  if p_schema is null or p_schema = '{}'::jsonb then
    return v_err;
  end if;
  if p_doc is null then
    return array[p_path || ': missing'];
  end if;
  if v_type is not null then
    if v_type = 'integer' then
      if v_doc_type <> 'number' or (p_doc #>> '{}')::numeric <> trunc((p_doc #>> '{}')::numeric) then
        return array[p_path || ': expected integer'];
      end if;
    elsif v_type <> v_doc_type then
      return array[format('%s: expected %s, got %s', p_path, v_type, v_doc_type)];
    end if;
  end if;
  if p_schema ? 'enum' and not (p_schema->'enum') @> jsonb_build_array(p_doc) then
    v_err := v_err || (p_path || ': not an allowed value');
  end if;
  if v_doc_type = 'number' then
    if p_schema ? 'minimum' and (p_doc #>> '{}')::numeric < (p_schema->>'minimum')::numeric then
      v_err := v_err || format('%s: below minimum %s', p_path, p_schema->>'minimum');
    end if;
    if p_schema ? 'exclusiveMinimum' and (p_doc #>> '{}')::numeric <= (p_schema->>'exclusiveMinimum')::numeric then
      v_err := v_err || format('%s: must be above %s', p_path, p_schema->>'exclusiveMinimum');
    end if;
    if p_schema ? 'maximum' and (p_doc #>> '{}')::numeric > (p_schema->>'maximum')::numeric then
      v_err := v_err || format('%s: above maximum %s', p_path, p_schema->>'maximum');
    end if;
  end if;
  if v_doc_type = 'string' and p_schema ? 'pattern' and (p_doc #>> '{}') !~ (p_schema->>'pattern') then
    v_err := v_err || (p_path || ': does not match pattern');
  end if;
  if v_doc_type = 'object' then
    if p_schema ? 'required' then
      for v_key in select jsonb_array_elements_text(p_schema->'required') loop
        if not p_doc ? v_key then
          v_err := v_err || format('%s.%s: required', p_path, v_key);
        end if;
      end loop;
    end if;
    if p_schema ? 'properties' then
      for v_key, v_sub in select key, value from jsonb_each(p_schema->'properties') loop
        if p_doc ? v_key then
          v_err := v_err || app.validate_json(v_sub, p_doc->v_key, p_path || '.' || v_key);
        end if;
      end loop;
    end if;
    if p_schema->'additionalProperties' = 'false'::jsonb then
      for v_key in select jsonb_object_keys(p_doc) loop
        if not coalesce(p_schema->'properties', '{}'::jsonb) ? v_key then
          v_err := v_err || format('%s.%s: unknown property', p_path, v_key);
        end if;
      end loop;
    end if;
  end if;
  if v_doc_type = 'array' then
    if p_schema ? 'minItems' and jsonb_array_length(p_doc) < (p_schema->>'minItems')::int then
      v_err := v_err || format('%s: needs at least %s items', p_path, p_schema->>'minItems');
    end if;
    if p_schema ? 'items' then
      for v_sub in select jsonb_array_elements(p_doc) loop
        v_err := v_err || app.validate_json(p_schema->'items', v_sub, format('%s[%s]', p_path, v_i));
        v_i := v_i + 1;
      end loop;
    end if;
  end if;
  return v_err;
end $$;

-- GS1 mod-10 check digit for a numeric string (without the check digit).
create or replace function app.gs1_check_digit(p_digits text) returns text
language plpgsql immutable as $$
declare
  v_sum int := 0;
  v_len int := length(p_digits);
  i int;
begin
  for i in 1..v_len loop
    v_sum := v_sum + substr(p_digits, v_len - i + 1, 1)::int * (case when i % 2 = 1 then 3 else 1 end);
  end loop;
  return ((10 - (v_sum % 10)) % 10)::text;
end $$;

-- Working-day arithmetic (Mon-Fri) used by the allocation release horizon.
create or replace function app.add_working_days(p_from date, p_days int) returns date
language plpgsql immutable as $$
declare
  v_d date := p_from;
  v_left int := p_days;
begin
  while v_left > 0 loop
    v_d := v_d + 1;
    if extract(isodow from v_d) < 6 then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_d;
end $$;

create or replace function app.week_start(p_d date) returns date
language sql immutable as $$ select date_trunc('week', p_d::timestamp)::date $$;

-- "Today" in the warehouse's timezone.
create or replace function app.today() returns date
language sql stable as $$ select (now() at time zone 'Europe/Istanbul')::date $$;
