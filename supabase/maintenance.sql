-- FraserFlow Fleet & Maintenance: database (Phase 2: core maintenance)
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql.
-- Safe to run again. It only adds tables, rules and roles; roster data in `items` is not changed.
--
-- Every maintenance record points at an existing machine by its id (the machine's id in `items`).
-- Machines stay the master list: nothing here copies or overwrites them, and a machine's history
-- is kept even if it is later removed from the roster.
-- No costs, rates or prices are stored anywhere in this module.

-- 1. Roles ------------------------------------------------------------------
--    admin / superuser: everything, and authorises maintenance (service plans, closing work orders, corrections)
--    planner:    the schedule, as before; can see maintenance
--    supervisor: reviews and verifies maintenance work, allocates work orders
--    mechanic:   records services, meter readings and work order progress
--    operator:   prestarts (Phase 3); can see maintenance status
--    viewer:     look only
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','superuser','planner','supervisor','mechanic','operator','viewer'));

create or replace function public.maint_can_work()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser','supervisor','mechanic'), false)
$$;
create or replace function public.maint_can_verify()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser','supervisor'), false)
$$;
create or replace function public.maint_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser'), false)
$$;

-- a maintenance record must point at a machine on the roster when it is created
create or replace function public.maint_check_asset()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.asset_id is not null and not exists (
    select 1 from public.items where kind = 'resource' and id = new.asset_id and data->>'type' = 'machine'
  ) then
    raise exception 'No machine with id % on the roster', new.asset_id using errcode = '23503';
  end if;
  return new;
end; $$;

-- every change to a maintenance record is logged, with who and when
create table if not exists public.maintenance_audit (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  who     uuid default auth.uid(),
  tbl     text not null,
  row_id  text,
  action  text not null,
  old     jsonb,
  new     jsonb
);
create index if not exists maintenance_audit_row on public.maintenance_audit (tbl, row_id, at desc);

create or replace function public.maint_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.maintenance_audit (tbl, row_id, action, old, new)
  values (tg_table_name, coalesce(r->>'id', r->>'asset_id'), lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end; $$;

-- 2. Machine maintenance profiles -------------------------------------------
create table if not exists public.asset_profiles (
  asset_id    text primary key,
  make        text,
  model       text,
  year        int check (year is null or year between 1950 and 2100),
  serial      text,
  meter_type  text not null default 'hours' check (meter_type in ('hours','km','both')),
  retired     boolean not null default false,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

create or replace function public.maint_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if to_jsonb(new) ? 'updated_by' then new.updated_by = auth.uid(); end if;
  return new;
end; $$;

drop trigger if exists asset_profiles_check on public.asset_profiles;
create trigger asset_profiles_check before insert on public.asset_profiles for each row execute function public.maint_check_asset();
drop trigger if exists asset_profiles_touch on public.asset_profiles;
create trigger asset_profiles_touch before insert or update on public.asset_profiles for each row execute function public.maint_touch();

-- 3. Meter readings (engine hours and kilometres) ----------------------------
--    Readings are never edited or deleted. A wrong reading is fixed by an administrator
--    adding a 'correction'; a new meter or hour clock is recorded as a 'replacement'.
create table if not exists public.meter_readings (
  id          uuid primary key default gen_random_uuid(),
  asset_id    text not null,
  kind        text not null check (kind in ('hours','km')),
  value       numeric not null check (value >= 0),
  read_at     timestamptz not null default now(),
  source      text not null default 'manual' check (source in ('manual','service','prestart','work_order','correction','replacement')),
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index if not exists meter_readings_asset on public.meter_readings (asset_id, kind, read_at desc);

create or replace function public.maint_check_reading()
returns trigger language plpgsql security definer set search_path = public as $$
declare since timestamptz; before_v numeric; after_v numeric;
begin
  new.created_by = auth.uid();
  new.created_at = now();
  if new.read_at > now() + interval '1 day' then
    raise exception 'A meter reading can''t be dated in the future' using errcode = '22023';
  end if;
  if new.source in ('correction','replacement') then
    if not public.maint_is_manager() then
      raise exception 'Only an administrator can record a meter correction or replacement' using errcode = '42501';
    end if;
    return new;
  end if;
  -- readings only count from the last meter replacement on or before this one
  select max(read_at) into since from public.meter_readings
   where asset_id = new.asset_id and kind = new.kind and source = 'replacement' and read_at <= new.read_at;
  select value into before_v from public.meter_readings
   where asset_id = new.asset_id and kind = new.kind and read_at <= new.read_at and (since is null or read_at >= since)
   order by read_at desc, created_at desc limit 1;
  select value into after_v from public.meter_readings
   where asset_id = new.asset_id and kind = new.kind and read_at > new.read_at
     and source <> 'correction'
     and not exists (select 1 from public.meter_readings r2 where r2.asset_id = new.asset_id and r2.kind = new.kind
                     and r2.source = 'replacement' and r2.read_at > new.read_at and r2.read_at <= meter_readings.read_at)
   order by read_at asc, created_at asc limit 1;
  if before_v is not null and new.value < before_v then
    raise exception 'Reading % is lower than the previous reading of % %', new.value, before_v, new.kind using errcode = '22023';
  end if;
  if after_v is not null and new.value > after_v then
    raise exception 'Reading % is higher than a later reading of % %', new.value, after_v, new.kind using errcode = '22023';
  end if;
  return new;
end; $$;

drop trigger if exists meter_readings_asset on public.meter_readings;
create trigger meter_readings_asset before insert on public.meter_readings for each row execute function public.maint_check_asset();
drop trigger if exists meter_readings_check on public.meter_readings;
create trigger meter_readings_check before insert on public.meter_readings for each row execute function public.maint_check_reading();

-- 4. Service plans (per machine category, or for one machine) ---------------
--    Due by hours, km or days; whichever comes first counts.
create table if not exists public.service_plans (
  id          uuid primary key default gen_random_uuid(),
  category    text,
  asset_id    text,
  name        text not null,
  every_hours numeric check (every_hours is null or every_hours > 0),
  every_km    numeric check (every_km is null or every_km > 0),
  every_days  int check (every_days is null or every_days > 0),
  warn_hours  numeric not null default 50,
  warn_km     numeric not null default 1000,
  warn_days   int not null default 14,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  constraint service_plans_scope check ((category is null) <> (asset_id is null)),
  constraint service_plans_trigger check (every_hours is not null or every_km is not null or every_days is not null)
);
drop trigger if exists service_plans_asset on public.service_plans;
create trigger service_plans_asset before insert on public.service_plans for each row execute function public.maint_check_asset();
drop trigger if exists service_plans_touch on public.service_plans;
create trigger service_plans_touch before update on public.service_plans for each row execute function public.maint_touch();

-- 5. Work orders ---------------------------------------------------------------
create sequence if not exists public.work_order_no start 1001;
create table if not exists public.work_orders (
  id               uuid primary key default gen_random_uuid(),
  number           bigint not null default nextval('public.work_order_no') unique,
  asset_id         text not null,
  wo_type          text not null check (wo_type in ('service','defect','breakdown','request')),
  plan_id          uuid references public.service_plans(id) on delete set null,
  title            text not null,
  description      text,
  priority         text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status           text not null default 'open' check (status in ('open','scheduled','in_progress','awaiting_parts','completed','closed','cancelled')),
  assigned_to      text,
  start_date       date,
  end_date         date,
  safe_to_operate  boolean,
  reported_hours   numeric,
  reported_km      numeric,
  parts            jsonb not null default '[]'::jsonb,
  completion_notes text,
  completed_at     timestamptz,
  completed_by     uuid,
  verified_at      timestamptz,
  verified_by      uuid,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now(),
  constraint work_orders_dates check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists work_orders_asset on public.work_orders (asset_id, status);
-- one open service work order per machine and service plan: no duplicates when a service is due by several triggers
create unique index if not exists work_orders_one_open_per_plan on public.work_orders (asset_id, plan_id)
  where plan_id is not null and status not in ('completed','closed','cancelled');

create or replace function public.maint_work_order_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by = auth.uid(); new.created_at = now(); new.updated_at = now();
    new.completed_at = null; new.completed_by = null; new.verified_at = null; new.verified_by = null;
    if new.status in ('completed','closed') then
      raise exception 'A new work order can''t start as completed or closed' using errcode = '22023';
    end if;
    return new;
  end if;
  new.id = old.id; new.number = old.number; new.asset_id = old.asset_id;
  new.created_at = old.created_at; new.created_by = old.created_by; new.updated_at = now();
  if old.status in ('closed','cancelled') and not public.maint_is_manager() then
    raise exception 'Work order % is %; only an administrator can change it', old.number, old.status using errcode = '42501';
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    new.completed_at = now(); new.completed_by = auth.uid();
  elsif new.status not in ('completed','closed') then
    new.completed_at = null; new.completed_by = null;
  else
    new.completed_at = old.completed_at; new.completed_by = old.completed_by;
  end if;
  if new.status = 'closed' and old.status <> 'closed' then
    if old.status <> 'completed' then
      raise exception 'Work order % must be completed before it is verified and closed', old.number using errcode = '22023';
    end if;
    if not public.maint_can_verify() then
      raise exception 'Only a supervisor or administrator can verify and close a work order' using errcode = '42501';
    end if;
    new.verified_at = now(); new.verified_by = auth.uid();
  elsif new.status <> 'closed' then
    new.verified_at = null; new.verified_by = null;
  else
    new.verified_at = old.verified_at; new.verified_by = old.verified_by;
  end if;
  return new;
end; $$;

drop trigger if exists work_orders_asset on public.work_orders;
create trigger work_orders_asset before insert on public.work_orders for each row execute function public.maint_check_asset();
drop trigger if exists work_orders_rules on public.work_orders;
create trigger work_orders_rules before insert or update on public.work_orders for each row execute function public.maint_work_order_rules();

-- scheduled work shows on the schedule board as machine downtime (a booking on the machine's row)
create or replace function public.maint_sync_downtime()
returns trigger language plpgsql security definer set search_path = public as $$
declare bid text;
begin
  bid := 'wo-' || coalesce(new.id, old.id)::text;
  if tg_op = 'DELETE' or new.start_date is null or new.status = 'cancelled' then
    delete from public.items where kind = 'block' and id = bid;
    return null;
  end if;
  insert into public.items (kind, id, data)
  values ('block', bid, jsonb_build_object(
    'resourceId', new.asset_id,
    'kind', case when new.wo_type = 'service' then 'service' else 'repair' end,
    'start', new.start_date::text,
    'end', coalesce(new.end_date, new.start_date)::text,
    'title', 'WO ' || new.number || ' · ' || new.title,
    'woId', new.id::text,
    'fromMaintenance', true))
  on conflict (kind, id) do update set data = excluded.data;
  return null;
end; $$;

drop trigger if exists work_orders_downtime on public.work_orders;
create trigger work_orders_downtime after insert or update or delete on public.work_orders
  for each row execute function public.maint_sync_downtime();

-- 6. Service records (each service done, with what was done and parts used) ---
create table if not exists public.service_records (
  id             uuid primary key default gen_random_uuid(),
  asset_id       text not null,
  plan_id        uuid references public.service_plans(id) on delete set null,
  work_order_id  uuid references public.work_orders(id) on delete set null,
  service_type   text not null,
  done_on        date not null,
  hours          numeric check (hours is null or hours >= 0),
  km             numeric check (km is null or km >= 0),
  mechanic       text,
  work_done      text,
  parts          jsonb not null default '[]'::jsonb,
  notes          text,
  baseline       boolean not null default false,   -- the last service before FraserFlow: a starting point only
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid()
);
create index if not exists service_records_asset on public.service_records (asset_id, done_on desc);

create or replace function public.maint_service_record()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_by = auth.uid(); new.created_at = now();
  return new;
end; $$;

-- a service's hours and km become meter readings (when they are the newest)
create or replace function public.maint_service_meters()
returns trigger language plpgsql security definer set search_path = public as $$
declare cur numeric; at_ts timestamptz := (new.done_on::timestamp + time '12:00') at time zone 'Australia/Brisbane';
begin
  -- a service dated today counts as now; earlier dates as midday that day
  if at_ts > now() or new.done_on >= (now() at time zone 'Australia/Brisbane')::date then at_ts := now(); end if;
  if new.hours is not null then
    select value into cur from public.meter_readings where asset_id = new.asset_id and kind = 'hours' order by read_at desc, created_at desc limit 1;
    if cur is null or (new.hours >= cur and at_ts >= coalesce((select max(read_at) from public.meter_readings where asset_id = new.asset_id and kind = 'hours'), at_ts)) then
      insert into public.meter_readings (asset_id, kind, value, read_at, source, note)
      values (new.asset_id, 'hours', new.hours, at_ts, 'service', 'From service: ' || new.service_type);
    end if;
  end if;
  if new.km is not null then
    select value into cur from public.meter_readings where asset_id = new.asset_id and kind = 'km' order by read_at desc, created_at desc limit 1;
    if cur is null or (new.km >= cur and at_ts >= coalesce((select max(read_at) from public.meter_readings where asset_id = new.asset_id and kind = 'km'), at_ts)) then
      insert into public.meter_readings (asset_id, kind, value, read_at, source, note)
      values (new.asset_id, 'km', new.km, at_ts, 'service', 'From service: ' || new.service_type);
    end if;
  end if;
  return null;
end; $$;

drop trigger if exists service_records_asset on public.service_records;
create trigger service_records_asset before insert on public.service_records for each row execute function public.maint_check_asset();
drop trigger if exists service_records_rules on public.service_records;
create trigger service_records_rules before insert on public.service_records for each row execute function public.maint_service_record();
drop trigger if exists service_records_meters on public.service_records;
create trigger service_records_meters after insert on public.service_records for each row execute function public.maint_service_meters();

-- 7. Audit triggers on every maintenance table --------------------------------
do $$
declare t text;
begin
  foreach t in array array['asset_profiles','meter_readings','service_plans','work_orders','service_records'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.maint_audit()', t, t);
  end loop;
end $$;

-- 8. Who can see and change what (enforced by the database, not just the screens) ---
alter table public.asset_profiles   enable row level security;
alter table public.meter_readings   enable row level security;
alter table public.service_plans    enable row level security;
alter table public.work_orders      enable row level security;
alter table public.service_records  enable row level security;
alter table public.maintenance_audit enable row level security;

grant select, insert, update, delete on public.asset_profiles, public.service_plans, public.work_orders, public.service_records to authenticated;
grant select, insert on public.meter_readings to authenticated;
grant select on public.maintenance_audit to authenticated;
grant usage on sequence public.work_order_no to authenticated;

do $$
declare t text;
begin
  -- everyone signed in can see maintenance status
  foreach t in array array['asset_profiles','meter_readings','service_plans','work_orders','service_records'] loop
    execute format('drop policy if exists "signed-in people read" on public.%I', t);
    execute format('create policy "signed-in people read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists "maintenance staff add" on public.asset_profiles;
create policy "maintenance staff add" on public.asset_profiles for insert to authenticated with check (public.maint_can_work());
drop policy if exists "maintenance staff change" on public.asset_profiles;
create policy "maintenance staff change" on public.asset_profiles for update to authenticated using (public.maint_can_work()) with check (public.maint_can_work());
drop policy if exists "administrators remove" on public.asset_profiles;
create policy "administrators remove" on public.asset_profiles for delete to authenticated using (public.maint_is_manager());

drop policy if exists "maintenance staff add" on public.meter_readings;
create policy "maintenance staff add" on public.meter_readings for insert to authenticated with check (public.maint_can_work());
-- no update or delete policy: readings are permanent

drop policy if exists "administrators manage" on public.service_plans;
create policy "administrators manage" on public.service_plans for all to authenticated using (public.maint_is_manager()) with check (public.maint_is_manager());

drop policy if exists "maintenance staff add" on public.work_orders;
create policy "maintenance staff add" on public.work_orders for insert to authenticated with check (public.maint_can_work());
drop policy if exists "maintenance staff change" on public.work_orders;
create policy "maintenance staff change" on public.work_orders for update to authenticated using (public.maint_can_work()) with check (public.maint_can_work());
drop policy if exists "administrators remove" on public.work_orders;
create policy "administrators remove" on public.work_orders for delete to authenticated using (public.maint_is_manager());

drop policy if exists "maintenance staff add" on public.service_records;
create policy "maintenance staff add" on public.service_records for insert to authenticated with check (public.maint_can_work());
drop policy if exists "administrators change" on public.service_records;
create policy "administrators change" on public.service_records for update to authenticated using (public.maint_is_manager()) with check (public.maint_is_manager());
drop policy if exists "administrators remove" on public.service_records;
create policy "administrators remove" on public.service_records for delete to authenticated using (public.maint_is_manager());

drop policy if exists "administrators read" on public.maintenance_audit;
create policy "administrators read" on public.maintenance_audit for select to authenticated using (public.maint_is_manager());

-- 9. Live updates ---------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['asset_profiles','meter_readings','service_plans','work_orders','service_records'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
