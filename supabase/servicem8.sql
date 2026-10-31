-- FraserFlow Fleet & Maintenance: ServiceM8 link (the contract mechanic's job software)
-- Run once in Supabase → SQL Editor → New query → paste → Run, after maintenance.sql, prestarts.sql and defects.sql.
-- Safe to run again. It only adds tables and rules; nothing existing is changed.
--
-- New work orders are sent to the mechanic's ServiceM8 as jobs (automatically, unless someone ticks "don't send").
-- He works the job in ServiceM8; its progress comes back here: booked → Scheduled (with the dates on the schedule
-- board), work started → In progress, his "awaiting parts" queue → Awaiting parts, Completed → Completed (with his
-- work-done notes, parts and meter readings; a service also becomes the service record), Unsuccessful → Cancelled.
-- Verifying and closing stays in FraserFlow, as before.
--
-- The sending and receiving is done by the server (api/servicem8.js) with Supabase's service role key.
-- Nobody signed in to the app can read the ServiceM8 credentials: they live in servicem8_secrets, which has no rules
-- that let anyone but the server in.

-- 1. Settings (one row) ----------------------------------------------------------------
create table if not exists public.servicem8_settings (
  id               int primary key default 1 check (id = 1),
  enabled          boolean not null default false,       -- the link is on
  auto_send        boolean not null default true,        -- new work orders go to ServiceM8 unless held back
  client_name      text not null default 'AFA',          -- the client record for AFA in the mechanic's ServiceM8
  company_uuid     text,                                 -- that record's id (found or made by the server)
  contractor_name  text,                                 -- shown as "Assigned" on work orders he has
  job_address      text,                                 -- where the machines are (the job address on his jobs)
  parts_queue_uuid text,                                 -- his ServiceM8 queue that means "awaiting parts"
  parts_queue_name text,
  hooks_on_at      timestamptz,                          -- when ServiceM8 was told to report job changes
  updated_at       timestamptz not null default now(),
  updated_by       uuid default auth.uid()
);
insert into public.servicem8_settings (id) values (1) on conflict (id) do nothing;
drop trigger if exists servicem8_settings_touch on public.servicem8_settings;
create trigger servicem8_settings_touch before update on public.servicem8_settings for each row execute function public.maint_touch();

-- 2. Credentials (server only) ------------------------------------------------------------
create table if not exists public.servicem8_secrets (
  id            int primary key default 1 check (id = 1),
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  webhook_key   text,           -- part of the address ServiceM8 calls, so nobody else can poke it
  updated_at    timestamptz not null default now()
);
insert into public.servicem8_secrets (id) values (1) on conflict (id) do nothing;
alter table public.servicem8_secrets enable row level security;   -- and no policies: only the service role gets in
revoke all on public.servicem8_secrets from anon, authenticated;

-- 3. Which work order is which ServiceM8 job ----------------------------------------------------
create table if not exists public.servicem8_jobs (
  work_order_id uuid primary key references public.work_orders(id) on delete cascade,
  state         text not null default 'pending' check (state in ('pending','sending','sent','held','error','skipped','removed')),
  -- pending: waiting to be sent · sending: being sent right now · sent: a job in ServiceM8 · held: someone chose not to send it
  -- error: sending failed (last_error says why) · skipped: finished before it was sent · removed: the job was deleted in ServiceM8
  dirty         boolean not null default false,   -- changed here since it was sent (title, description, priority, cancelled)
  job_uuid      text unique,
  job_no        text,                             -- ServiceM8's own job number
  sm8_status    text,                             -- Quote / Work Order / Completed / Unsuccessful (as last seen)
  sm8_queue     text,                             -- the job's ServiceM8 queue (as last seen)
  last_error    text,
  attempts      int not null default 0,
  sent_at       timestamptz,
  synced_at     timestamptz,
  requested_by  uuid default auth.uid(),
  updated_at    timestamptz not null default now()
);
alter table public.servicem8_jobs add column if not exists sm8_queue text;
create index if not exists servicem8_jobs_todo on public.servicem8_jobs (state) where state in ('pending','sending','error') or dirty;

-- his photos and PDFs from a ServiceM8 job are copied into the machine's files (Storage bucket "maintenance"),
-- linked to the work order; sm8_uuid stops one being copied twice. (Needs prestarts.sql, which makes maintenance_files.)
alter table public.maintenance_files add column if not exists work_order_id uuid references public.work_orders(id) on delete set null;
alter table public.maintenance_files add column if not exists sm8_uuid text unique;
create index if not exists maintenance_files_wo on public.maintenance_files (work_order_id) where work_order_id is not null;

-- 4. New work orders queue themselves to be sent ---------------------------------------------
create or replace function public.servicem8_queue_new()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.servicem8_settings;
begin
  select * into s from public.servicem8_settings where id = 1;
  if s.enabled and s.auto_send and new.status not in ('completed','closed','cancelled') then
    insert into public.servicem8_jobs (work_order_id, state) values (new.id, 'pending') on conflict (work_order_id) do nothing;
  end if;
  return null;
end; $$;
drop trigger if exists work_orders_servicem8_new on public.work_orders;
create trigger work_orders_servicem8_new after insert on public.work_orders for each row execute function public.servicem8_queue_new();

-- a change made here to a job already in ServiceM8 is sent on (unless the change came from ServiceM8 itself)
create or replace function public.servicem8_mark_dirty()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('servicem8.syncing', true), '') = 'on' then return null; end if;
  if new.title is distinct from old.title or new.description is distinct from old.description
     or new.priority is distinct from old.priority or (new.status = 'cancelled' and old.status <> 'cancelled') then
    update public.servicem8_jobs set dirty = true, updated_at = now() where work_order_id = new.id and state in ('sent','sending');
  end if;
  return null;
end; $$;
drop trigger if exists work_orders_servicem8_dirty on public.work_orders;
create trigger work_orders_servicem8_dirty after update on public.work_orders for each row execute function public.servicem8_mark_dirty();

-- a work order whose job is still open in ServiceM8 can't be deleted: cancel it first, so his job is closed too
create or replace function public.servicem8_keep_open_jobs()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.servicem8_jobs where work_order_id = old.id and state in ('sent','sending')
             and coalesce(sm8_status, '') not in ('Completed','Unsuccessful')) then
    raise exception 'Work order % is still open in ServiceM8. Cancel it first, so the mechanic''s job is closed too', old.number using errcode = '22023';
  end if;
  return old;
end; $$;
drop trigger if exists work_orders_servicem8_delete on public.work_orders;
create trigger work_orders_servicem8_delete before delete on public.work_orders for each row execute function public.servicem8_keep_open_jobs();

-- 5. "Send to ServiceM8" / "Don't send" from the work order (mechanics, supervisors, administrators) ---------
create or replace function public.servicem8_request(p_wo uuid, p_send boolean)
returns text language plpgsql security definer set search_path = public as $$
declare cur text; st text;
begin
  if not public.maint_can_work() then
    raise exception 'Only mechanics, supervisors and administrators can change this' using errcode = '42501';
  end if;
  select status into st from public.work_orders where id = p_wo;
  if st is null then raise exception 'No such work order' using errcode = '23503'; end if;
  select state into cur from public.servicem8_jobs where work_order_id = p_wo for update;
  if p_send then
    if st in ('completed','closed','cancelled') then
      raise exception 'This work order is already finished' using errcode = '22023';
    end if;
    if cur in ('sent','sending') then return cur; end if;
    insert into public.servicem8_jobs (work_order_id, state, attempts, last_error, requested_by)
    values (p_wo, 'pending', 0, null, auth.uid())
    on conflict (work_order_id) do update set state = 'pending', attempts = 0, last_error = null, requested_by = auth.uid(),
      job_uuid = case when servicem8_jobs.state = 'removed' then null else servicem8_jobs.job_uuid end, updated_at = now();
    return 'pending';
  else
    if cur in ('sent','sending') then
      raise exception 'It is already in ServiceM8. Cancel the work order, or have the mechanic mark the job Unsuccessful' using errcode = '22023';
    end if;
    insert into public.servicem8_jobs (work_order_id, state, requested_by) values (p_wo, 'held', auth.uid())
    on conflict (work_order_id) do update set state = 'held', last_error = null, requested_by = auth.uid(), updated_at = now();
    return 'held';
  end if;
end; $$;

-- 6. What the server does with a job's progress (one transaction; service role only) ---------------
-- p_patch:   {status, start_date, end_date, parts, completion_notes, assigned_to}, each only when it should change
-- p_service: {done_on, hours, km, mechanic} when a scheduled service is completed (becomes the service record)
-- p_meters:  [{kind:'hours'|'km', value}] readings from his notes (for other work orders; kept only if newest)
-- p_job:     {job_no, sm8_status, queue_uuid, removed}
create or replace function public.servicem8_apply(p_wo uuid, p_patch jsonb, p_service jsonb, p_meters jsonb, p_job jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare w public.work_orders; nxt text; m jsonb; cur numeric;
begin
  perform set_config('servicem8.syncing', 'on', true);
  select * into w from public.work_orders where id = p_wo for update;
  if w.id is null then perform set_config('servicem8.syncing', '', true); return 'missing'; end if;

  update public.servicem8_jobs set synced_at = now(), updated_at = now(), last_error = null,
    job_no = coalesce(p_job->>'job_no', job_no), sm8_status = coalesce(p_job->>'sm8_status', sm8_status),
    sm8_queue = case when p_job ? 'queue_uuid' then nullif(p_job->>'queue_uuid', '') else sm8_queue end,
    state = case when (p_job->>'removed')::boolean then 'removed' else state end
   where work_order_id = p_wo;

  -- verified, closed or cancelled here: ServiceM8 no longer changes it
  if w.status in ('closed','cancelled') or p_patch is null or p_patch = '{}'::jsonb then
    perform set_config('servicem8.syncing', '', true); return w.status;
  end if;

  nxt := coalesce(p_patch->>'status', w.status);
  update public.work_orders set
    status           = nxt,
    start_date       = case when p_patch ? 'start_date' then (p_patch->>'start_date')::date else start_date end,
    end_date         = case when p_patch ? 'end_date' then (p_patch->>'end_date')::date else end_date end,
    parts            = case when p_patch ? 'parts' then p_patch->'parts' else parts end,
    completion_notes = case when p_patch ? 'completion_notes' then p_patch->>'completion_notes' else completion_notes end,
    assigned_to      = coalesce(nullif(btrim(assigned_to), ''), p_patch->>'assigned_to')
   where id = p_wo;

  if nxt = 'completed' and w.status <> 'completed' then
    if w.wo_type = 'service' and p_service is not null
       and not exists (select 1 from public.service_records where work_order_id = w.id) then   -- never twice for one work order
      -- the service record (its hours and km become meter readings, and the next service is worked out from it)
      insert into public.service_records (asset_id, plan_id, work_order_id, service_type, done_on, hours, km, mechanic, work_done, parts)
      values (w.asset_id, w.plan_id, w.id, w.title, coalesce((p_service->>'done_on')::date, (now() at time zone 'Australia/Brisbane')::date),
              nullif(p_service->>'hours', '')::numeric, nullif(p_service->>'km', '')::numeric, p_service->>'mechanic',
              coalesce(p_patch->>'completion_notes', w.completion_notes), coalesce(p_patch->'parts', w.parts));
    else
      for m in select * from jsonb_array_elements(coalesce(p_meters, '[]'::jsonb)) loop
        select value into cur from public.meter_readings where asset_id = w.asset_id and kind = m->>'kind' order by read_at desc, created_at desc limit 1;
        if cur is null or (m->>'value')::numeric > cur then
          insert into public.meter_readings (asset_id, kind, value, source, note)
          values (w.asset_id, m->>'kind', (m->>'value')::numeric, 'work_order', 'WO ' || w.number || ' (ServiceM8)');
        end if;
      end loop;
    end if;
  end if;
  perform set_config('servicem8.syncing', '', true);   -- only for this call, not the rest of the transaction
  return nxt;
end; $$;

-- 7. Access rules -----------------------------------------------------------------------
alter table public.servicem8_settings enable row level security;
alter table public.servicem8_jobs     enable row level security;
revoke all on public.servicem8_settings, public.servicem8_jobs from anon, authenticated;   -- Supabase grants everything by default
grant select, update on public.servicem8_settings to authenticated;
grant select on public.servicem8_jobs to authenticated;
drop policy if exists "signed-in people read" on public.servicem8_settings;
create policy "signed-in people read" on public.servicem8_settings for select to authenticated using (true);
drop policy if exists "administrators change" on public.servicem8_settings;
create policy "administrators change" on public.servicem8_settings for update to authenticated using (public.maint_is_manager()) with check (public.maint_is_manager());
drop policy if exists "signed-in people read" on public.servicem8_jobs;
create policy "signed-in people read" on public.servicem8_jobs for select to authenticated using (true);
-- servicem8_jobs is only changed through servicem8_request (people) and the server

revoke all on function public.servicem8_request(uuid, boolean) from public, anon;
grant execute on function public.servicem8_request(uuid, boolean) to authenticated;
revoke all on function public.servicem8_apply(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.servicem8_apply(uuid, jsonb, jsonb, jsonb, jsonb) to service_role;
revoke all on function public.servicem8_queue_new() from public, anon, authenticated;
revoke all on function public.servicem8_mark_dirty() from public, anon, authenticated;
revoke all on function public.servicem8_keep_open_jobs() from public, anon, authenticated;

-- settings changes are audited; the link isn't (it is touched on every refresh, and the work order's own changes are audited)
drop trigger if exists servicem8_settings_audit on public.servicem8_settings;
create trigger servicem8_settings_audit after insert or update or delete on public.servicem8_settings for each row execute function public.maint_audit();
drop trigger if exists servicem8_jobs_audit on public.servicem8_jobs;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['servicem8_settings','servicem8_jobs'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
