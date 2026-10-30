-- FraserFlow Fleet & Maintenance: database (Phase 4: defects)
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql, maintenance.sql and prestarts.sql.
-- Safe to run again. It only adds tables and rules; roster data in `items` is not changed.
--
-- A failed prestart item becomes a defect. While that defect is open, the same item failing again on the same
-- machine adds to it instead of making a new one. A critical defect puts a restriction on the machine
-- ("do not use"). A later passing prestart never clears a defect or a restriction.
-- Defects are repaired through work orders (or on the spot), verified by a supervisor or administrator,
-- and only then can an administrator release the restriction: the machine's return to service.

-- 1. Defects ------------------------------------------------------------------------
create sequence if not exists public.defect_no start 1001;
create table if not exists public.defects (
  id                uuid primary key default gen_random_uuid(),
  number            bigint not null default nextval('public.defect_no') unique,
  asset_id          text not null,
  item_key          text,                          -- the checklist question it came from (prestart defects)
  title             text not null,
  description       text,
  severity          text not null default 'major' check (severity in ('minor','major','critical')),
  status            text not null default 'reported' check (status in ('reported','acknowledged','in_repair','repaired','closed','dismissed')),
  source            text not null default 'manual' check (source in ('prestart','manual')),
  prestart_id       uuid references public.prestarts(id) on delete set null,
  last_prestart_id  uuid references public.prestarts(id) on delete set null,
  photos            text[] not null default '{}',
  times_reported    int not null default 1,
  last_reported_at  timestamptz not null default now(),
  reported_by       uuid default auth.uid(),
  reported_name     text,
  work_order_id     uuid references public.work_orders(id) on delete set null,
  resolution        text,
  repaired_at       timestamptz,
  repaired_by       uuid,
  closed_at         timestamptz,
  closed_by         uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists defects_asset on public.defects (asset_id, status);
-- one open defect per machine and checklist question: no duplicates from later prestarts
create unique index if not exists defects_one_open_per_item on public.defects (asset_id, item_key)
  where item_key is not null and status not in ('closed','dismissed');

create or replace function public.defect_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare wo_asset text;
begin
  if tg_op = 'INSERT' then
    new.created_at = now(); new.updated_at = now(); new.last_reported_at = now();
    new.reported_by = coalesce(new.reported_by, auth.uid());
    new.reported_name = coalesce(nullif(btrim(new.reported_name), ''), public.my_name(), 'Unknown');
    new.repaired_at = null; new.repaired_by = null; new.closed_at = null; new.closed_by = null;
    if new.status not in ('reported','acknowledged') then
      raise exception 'A new defect starts as reported' using errcode = '22023';
    end if;
    if btrim(coalesce(new.title, '')) = '' then raise exception 'Describe the defect' using errcode = '22023'; end if;
  else
    -- what it is and where it came from don't change
    new.id = old.id; new.number = old.number; new.asset_id = old.asset_id; new.item_key = old.item_key; new.source = old.source;
    new.reported_by = old.reported_by; new.reported_name = old.reported_name; new.created_at = old.created_at; new.updated_at = now();
    if new.prestart_id is not null and new.prestart_id is distinct from old.prestart_id then new.prestart_id = old.prestart_id; end if;
  end if;
  -- a work order must be for the same machine
  if new.work_order_id is not null and (tg_op = 'INSERT' or new.work_order_id is distinct from old.work_order_id) then
    select asset_id into wo_asset from public.work_orders where id = new.work_order_id;
    if wo_asset is distinct from new.asset_id then raise exception 'That work order is for a different machine' using errcode = '22023'; end if;
  end if;
  -- linking or unlinking a work order moves the defect into or out of repair
  if new.work_order_id is not null and new.status in ('reported','acknowledged') then new.status = 'in_repair'; end if;
  if new.work_order_id is null and new.status = 'in_repair' then new.status = 'acknowledged'; end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status in ('closed','dismissed') and not public.maint_is_manager() then
      raise exception 'Defect D-% is %; only an administrator can reopen it', old.number, old.status using errcode = '42501';
    end if;
    if new.status = 'repaired' then
      if not public.maint_can_work() then raise exception 'Only maintenance staff can mark a defect repaired' using errcode = '42501'; end if;
      if btrim(coalesce(new.resolution, '')) = '' then raise exception 'Say what was done to fix it' using errcode = '22023'; end if;
      new.repaired_at = now(); new.repaired_by = auth.uid();
    elsif new.status = 'closed' then
      if old.status <> 'repaired' then raise exception 'Defect D-% must be repaired before it is verified and closed', old.number using errcode = '22023'; end if;
      if not public.maint_can_verify() then raise exception 'Only a supervisor or administrator can verify a repair' using errcode = '42501'; end if;
      new.closed_at = now(); new.closed_by = auth.uid();
    elsif new.status = 'dismissed' then
      if not public.maint_can_verify() then raise exception 'Only a supervisor or administrator can dismiss a defect' using errcode = '42501'; end if;
      if btrim(coalesce(new.resolution, '')) = '' then raise exception 'Say why it is being dismissed' using errcode = '22023'; end if;
      new.closed_at = now(); new.closed_by = auth.uid();
    else
      -- back into work (reopened, or its work order reopened)
      new.closed_at = null; new.closed_by = null;
      if new.status <> 'repaired' then new.repaired_at = null; new.repaired_by = null; end if;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists defects_asset on public.defects;
create trigger defects_asset before insert on public.defects for each row execute function public.maint_check_asset();
drop trigger if exists defects_rules on public.defects;
create trigger defects_rules before insert or update on public.defects for each row execute function public.defect_rules();

-- 2. Restrictions: a machine that must not be used -------------------------------------
create table if not exists public.restrictions (
  id            uuid primary key default gen_random_uuid(),
  asset_id      text not null,
  defect_id     uuid references public.defects(id) on delete set null,
  reason        text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  released_at   timestamptz,
  released_by   uuid,
  release_note  text
);
create index if not exists restrictions_asset on public.restrictions (asset_id) where active;
create unique index if not exists restrictions_one_per_defect on public.restrictions (defect_id) where active and defect_id is not null;

create or replace function public.restriction_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare ds text;
begin
  if tg_op = 'INSERT' then
    new.active = true; new.created_at = now(); new.created_by = auth.uid(); new.released_at = null; new.released_by = null; new.release_note = null;
    if btrim(coalesce(new.reason, '')) = '' then raise exception 'Give the reason for the restriction' using errcode = '22023'; end if;
    return new;
  end if;
  if new.id <> old.id or new.asset_id <> old.asset_id or new.defect_id is distinct from old.defect_id and new.defect_id is not null
     or new.reason <> old.reason or new.created_at <> old.created_at then
    raise exception 'A restriction can''t be changed, only released' using errcode = '42501';
  end if;
  if new.active and not old.active then raise exception 'A released restriction stays released. Add a new one if needed.' using errcode = '22023'; end if;
  if old.active and not new.active then
    if not public.maint_is_manager() then raise exception 'Only an administrator can release a restriction' using errcode = '42501'; end if;
    select status into ds from public.defects where id = old.defect_id;
    if old.defect_id is not null and ds not in ('closed','dismissed') then
      raise exception 'The repair must be verified (defect closed) before the machine goes back into service' using errcode = '22023';
    end if;
    new.released_at = now(); new.released_by = auth.uid();
  end if;
  return new;
end; $$;
drop trigger if exists restrictions_asset on public.restrictions;
create trigger restrictions_asset before insert on public.restrictions for each row execute function public.maint_check_asset();
drop trigger if exists restrictions_rules on public.restrictions;
create trigger restrictions_rules before insert or update on public.restrictions for each row execute function public.restriction_rules();

-- a critical defect restricts the machine (when it is reported, or when it is raised to critical)
create or replace function public.defect_restrict()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.severity = 'critical' and new.status not in ('closed','dismissed')
     and not exists (select 1 from public.restrictions where defect_id = new.id and active) then
    insert into public.restrictions (asset_id, defect_id, reason)
    values (new.asset_id, new.id, 'Critical defect D-' || new.number || ': ' || new.title);
  end if;
  return null;
end; $$;
drop trigger if exists defects_restrict on public.defects;
create trigger defects_restrict after insert or update of severity, status on public.defects for each row execute function public.defect_restrict();

-- 3. Failed prestart items become defects --------------------------------------------
create or replace function public.prestart_answer_defect()
returns trigger language plpgsql security definer set search_path = public as $$
declare ps public.prestarts; d public.defects; note text;
begin
  if new.kind <> 'check' or new.answer <> 'fail' then return null; end if;
  select * into ps from public.prestarts where id = new.prestart_id;
  note := to_char(ps.submitted_at at time zone 'Australia/Brisbane', 'DD Mon HH24:MI') || ', ' || ps.operator_name || ': ' || coalesce(new.comment, '');
  select * into d from public.defects where asset_id = ps.asset_id and item_key = new.item_key and status not in ('closed','dismissed') for update;
  if d.id is null then
    insert into public.defects (asset_id, item_key, title, description, severity, source, prestart_id, last_prestart_id, photos, reported_by, reported_name)
    values (ps.asset_id, new.item_key, new.question, note, case when new.critical then 'critical' else 'major' end, 'prestart',
            ps.id, ps.id, new.photos, ps.operator, ps.operator_name);
  else
    -- already reported: the same defect, seen again
    update public.defects set times_reported = times_reported + 1, last_reported_at = now(), last_prestart_id = ps.id,
           photos = photos || new.photos, description = concat_ws(E'\n', description, note),
           severity = case when new.critical then 'critical' else severity end
     where id = d.id;
  end if;
  return null;
end; $$;
drop trigger if exists prestart_answers_defect on public.prestart_answers;
create trigger prestart_answers_defect after insert on public.prestart_answers for each row execute function public.prestart_answer_defect();

-- a prestart deleted by the administrator (e.g. a test): defects only it reported are dismissed, and their restrictions released
create or replace function public.prestart_delete_defects()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.defects set status = 'dismissed', resolution = 'Its prestart was deleted by the administrator'
   where prestart_id = old.id and times_reported = 1 and work_order_id is null and status in ('reported','acknowledged');
  update public.restrictions r set active = false, release_note = 'Its prestart was deleted by the administrator'
    from public.defects d where r.defect_id = d.id and r.active and d.prestart_id = old.id and d.status = 'dismissed';
  return old;
end; $$;
drop trigger if exists prestarts_delete_defects on public.prestarts;
create trigger prestarts_delete_defects before delete on public.prestarts for each row execute function public.prestart_delete_defects();

-- 4. Work orders carry their defects through repair and verification ---------------------
create or replace function public.work_order_defects_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = old.status then return null; end if;
  if new.status = 'completed' then
    update public.defects set status = 'repaired', resolution = coalesce(nullif(btrim(resolution), ''), new.completion_notes, 'Repaired under WO ' || new.number)
     where work_order_id = new.id and status = 'in_repair';
  elsif new.status = 'closed' then
    update public.defects set status = 'closed' where work_order_id = new.id and status = 'repaired';
  elsif new.status = 'cancelled' then
    update public.defects set work_order_id = null, status = 'acknowledged' where work_order_id = new.id and status in ('in_repair','repaired');
  elsif old.status in ('completed','closed') then
    update public.defects set status = 'in_repair' where work_order_id = new.id and status in ('repaired','closed');
  end if;
  return null;
end; $$;
drop trigger if exists work_orders_defects on public.work_orders;
create trigger work_orders_defects after update of status on public.work_orders for each row execute function public.work_order_defects_sync();

-- 5. Audit, access rules and live updates --------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['defects','restrictions'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.maint_audit()', t, t);
  end loop;
end $$;

alter table public.defects      enable row level security;
alter table public.restrictions enable row level security;
grant select, insert, update on public.defects, public.restrictions to authenticated;
grant usage on sequence public.defect_no to authenticated;

do $$
declare t text;
begin
  foreach t in array array['defects','restrictions'] loop
    execute format('drop policy if exists "signed-in people read" on public.%I', t);
    execute format('create policy "signed-in people read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;
drop policy if exists "maintenance staff add" on public.defects;
create policy "maintenance staff add" on public.defects for insert to authenticated with check (public.maint_can_work());
drop policy if exists "maintenance staff change" on public.defects;
create policy "maintenance staff change" on public.defects for update to authenticated using (public.maint_can_work()) with check (public.maint_can_work());
drop policy if exists "administrators add" on public.restrictions;
create policy "administrators add" on public.restrictions for insert to authenticated with check (public.maint_is_manager());
drop policy if exists "administrators release" on public.restrictions;
create policy "administrators release" on public.restrictions for update to authenticated using (public.maint_is_manager()) with check (public.maint_is_manager());
-- no delete rules: defects are dismissed and restrictions released, never deleted

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['defects','restrictions'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
