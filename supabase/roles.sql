-- FraserFlow: roles and what each one can do (Admin › Roles).
-- Each role has a level for every area: 0 = hidden, 1 = view only, 2 = can change.
-- The database rules below read these levels, so a role set to "view only" really can't change anything.
-- The administrator ("admin") always has everything and can't be changed or deleted.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql (and before or after the
-- other files: it rewires their rules to these settings). Safe to run again: existing roles keep your changes.

create table if not exists public.roles (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label       text not null,
  description text,
  built_in    boolean not null default false,
  perms       jsonb not null default '{}'::jsonb,   -- { "<area>": 0 | 1 | 2 }
  opts        jsonb not null default '{}'::jsonb,   -- { home, simple, app_only }
  sort        int not null default 100,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

-- the starting roles: the same access as before roles could be changed
insert into public.roles (key, label, description, built_in, sort, perms, opts) values
 ('admin','Admin','Everything, always. Only the administrator manages roles.',true,0,'{}'::jsonb,'{}'::jsonb),
 ('superuser','Superuser','Everything except Ideas and managing roles.',true,10,'{"schedule":2,"schedule.settings":2,"schedule.exports":2,"schedule.forecast":2,"jobs":2,"jobs.paperwork":2,"jobs.pictures":2,"jobs.manage":2,"planning":2,"staff.leave":2,"staff.request":2,"staff.approve":2,"staff.people":2,"staff.logins":2,"fleet":2,"fleet.machines":2,"fleet.calendar":2,"fleet.workorders":2,"fleet.verify":2,"fleet.manage":2,"fleet.reports":1,"prestarts":2,"qa":2,"qa.fill":2,"qa.manage":2,"qa.all":1,"lab":1,"lab.upload":2,"lab.manage":2,"notify":1}'::jsonb,'{}'::jsonb),
 ('planner','Planner','Plans and books the work; sees Fleet.',true,20,'{"schedule":2,"schedule.settings":2,"schedule.exports":2,"schedule.forecast":2,"jobs":2,"jobs.paperwork":2,"jobs.pictures":2,"planning":2,"staff.leave":2,"staff.request":2,"staff.people":2,"fleet":1,"fleet.machines":2,"fleet.calendar":2,"fleet.workorders":1,"fleet.reports":1,"prestarts":2,"qa":2,"qa.fill":2,"qa.all":1,"lab":1,"lab.upload":2,"notify":1}'::jsonb,'{}'::jsonb),
 ('supervisor','Supervisor','On site: the crews’ schedule, jobs and pictures, leave, prestarts and QA.',true,30,'{"schedule":1,"jobs":1,"jobs.paperwork":1,"jobs.pictures":2,"staff.leave":1,"staff.request":2,"fleet.workorders":2,"fleet.verify":2,"prestarts":2,"qa":2,"qa.fill":2,"lab":1}'::jsonb,'{"simple":true}'::jsonb),
 ('mechanic','Mechanic','Fleet & Maintenance in full; the schedule to look at.',true,40,'{"schedule":1,"jobs":1,"planning":1,"staff.leave":1,"staff.people":1,"fleet":2,"fleet.machines":1,"fleet.calendar":1,"fleet.workorders":2,"fleet.verify":2,"fleet.manage":2,"fleet.reports":1,"prestarts":2,"notify":1}'::jsonb,'{}'::jsonb),
 ('prestart','Prestart (operator)','Prestarts on their phone, signing QA, and their own leave.',true,50,'{"prestarts":2,"qa":1,"staff.myleave":2}'::jsonb,'{"home":"prestarts","app_only":true}'::jsonb),
 ('lab','Lab','The Lab screen: reports and QA for each shift.',true,60,'{"lab":1,"lab.upload":2}'::jsonb,'{"home":"lab"}'::jsonb),
 ('viewer','Viewer','Looks at the schedule, jobs, plans and leave.',true,70,'{"schedule":1,"jobs":1,"planning":1,"staff.leave":1,"staff.people":1,"notify":1}'::jsonb,'{}'::jsonb)
on conflict (key) do nothing;

-- can the signed-in person do this?  can('qa.fill', 2) = can change; can('qa', 1) = can see
create or replace function public.can(area text, lvl int default 1)
returns boolean language sql stable security definer set search_path = public as $$
  select case when public.my_role() = 'admin' then true
              else coalesce((select (r.perms->>area)::int from public.roles r where r.key = public.my_role()), 0) >= lvl end
$$;
grant execute on function public.can(text, int) to authenticated;

-- only the administrator changes roles; everyone signed in can read them (the screens need their own)
create or replace function public.roles_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.key = 'admin' then raise exception 'The Admin role can''t be deleted' using errcode = '42501'; end if;
    if exists (select 1 from public.profiles where role = old.key) then
      raise exception 'Logins still have the % role. Give them another role first.', old.label using errcode = '23503';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    new.key = old.key; new.built_in = old.built_in;
    if old.key = 'admin' then new.perms = '{}'::jsonb; end if;
  end if;
  new.updated_at = now(); new.updated_by = auth.uid();
  return new;
end; $$;
drop trigger if exists roles_rules on public.roles;
create trigger roles_rules before insert or update or delete on public.roles for each row execute function public.roles_rules();

alter table public.roles enable row level security;
grant select, insert, update, delete on public.roles to authenticated;
drop policy if exists "signed-in people read" on public.roles;
create policy "signed-in people read" on public.roles for select to authenticated using (true);
drop policy if exists "administrator adds" on public.roles;
create policy "administrator adds" on public.roles for insert to authenticated with check (public.my_role() = 'admin');
drop policy if exists "administrator changes" on public.roles;
create policy "administrator changes" on public.roles for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
drop policy if exists "administrator removes" on public.roles;
create policy "administrator removes" on public.roles for delete to authenticated using (public.my_role() = 'admin');

-- a login's role must be one of these roles (instead of a fixed list)
alter table public.profiles drop constraint if exists profiles_role_check;
create or replace function public.profile_role_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'operator' then new.role = 'prestart'; end if;   -- the old name
  if not exists (select 1 from public.roles where key = new.role) then
    raise exception 'There is no % role', new.role using errcode = '23503';
  end if;
  return new;
end; $$;
drop trigger if exists profiles_role_valid on public.profiles;
create trigger profiles_role_valid before insert or update of role on public.profiles for each row execute function public.profile_role_check();

-- logins are managed by whoever has Logins
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.can('staff.logins', 2)
$$;

-- every rule that used a fixed list of roles now reads the settings
create or replace function public.maint_can_work()    returns boolean language sql stable security definer set search_path = public as $$ select public.can('fleet.workorders', 2) $$;
create or replace function public.maint_can_verify()  returns boolean language sql stable security definer set search_path = public as $$ select public.can('fleet.verify', 2) $$;
create or replace function public.maint_is_manager()  returns boolean language sql stable security definer set search_path = public as $$ select public.can('fleet.manage', 2) $$;
create or replace function public.maint_can_prestart() returns boolean language sql stable security definer set search_path = public as $$ select public.can('prestarts', 2) $$;
create or replace function public.qa_can_fill()       returns boolean language sql stable security definer set search_path = public as $$ select public.can('qa.fill', 2) $$;
create or replace function public.qa_is_manager()     returns boolean language sql stable security definer set search_path = public as $$ select public.can('qa.manage', 2) $$;
create or replace function public.leave_can_request() returns boolean language sql stable security definer set search_path = public as $$ select public.can('staff.leave', 2) or public.can('staff.request', 2) $$;
create or replace function public.leave_can_decide()  returns boolean language sql stable security definer set search_path = public as $$ select public.can('staff.approve', 2) $$;
create or replace function public.lab_can_see()       returns boolean language sql stable security definer set search_path = public as $$ select public.can('lab', 1) or public.can('jobs.paperwork', 1) $$;
create or replace function public.lab_can_upload()    returns boolean language sql stable security definer set search_path = public as $$ select public.can('lab.upload', 2) or public.can('jobs.paperwork', 2) $$;
create or replace function public.lab_is_manager()    returns boolean language sql stable security definer set search_path = public as $$ select public.can('lab.manage', 2) or public.can('jobs.manage', 2) $$;
create or replace function public.photos_can()        returns boolean language sql stable security definer set search_path = public as $$ select public.can('jobs.pictures', 2) $$;
create or replace function public.photos_can_see()    returns boolean language sql stable security definer set search_path = public as $$ select public.can('jobs.pictures', 1) $$;
create or replace function public.photos_is_manager() returns boolean language sql stable security definer set search_path = public as $$ select public.can('jobs.manage', 2) $$;
-- operators put in their own leave
create or replace function public.leave_can_request_for(pid text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  return public.leave_can_request() or (public.can('staff.myleave', 2) and pid is not null
    and pid is not distinct from (select staff_id from public.profiles where id = auth.uid()));
end; $$;

-- the roster (bookings, jobs, plans, settings, crews, staff and machines): anyone who can change one of those areas
-- who may change which part of the roster (Admin › Roles), by what it is:
--   bookings: leave (people) → Leave calendar or approvers; machine downtime → Machine calendar; the rest → Schedule board or Job planning
--   projects → Projects, Schedule or Planning; plans → Planning; crews, machines and people → Settings, Machines or People;
--   settings → Settings (or Machines, Planning, Ideas, which keep lists there); the change log → anyone who can change part of it
create or replace function public.items_can_change(k text, d jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when k in ('idea','suggestion') then public.can('ideas', 2)
    when k = 'block' then case
      when d->>'kind' in ('leave','sick','rdo','training') then public.can('staff.leave', 2) or public.can('staff.approve', 2)
      when d->>'kind' in ('service','repair','inspection') then public.can('fleet.calendar', 2) or public.can('schedule', 2)
      else public.can('schedule', 2) or public.can('planning', 2) end
    when k = 'job' then public.can('jobs', 2) or public.can('schedule', 2) or public.can('planning', 2)
    when k in ('plan','plan_img') then public.can('planning', 2)
    when k = 'resource' then public.can('schedule.settings', 2) or public.can('fleet.machines', 2) or public.can('staff.people', 2)
    when k = 'setting' then public.can('schedule.settings', 2) or public.can('fleet.machines', 2) or public.can('planning', 2) or public.can('ideas', 2)
    else public.can('schedule', 2) or public.can('schedule.settings', 2) or public.can('jobs', 2) or public.can('planning', 2)
      or public.can('fleet.machines', 2) or public.can('fleet.calendar', 2) or public.can('staff.people', 2) or public.can('staff.leave', 2) or public.can('staff.approve', 2) end
$$;
drop policy if exists "planners add" on public.items;
drop policy if exists "planners change" on public.items;
drop policy if exists "planners delete" on public.items;
do $$
declare p record;
begin
  -- the roster's add / change / remove rules, whatever they were called before
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'items' and cmd in ('INSERT','UPDATE','DELETE') loop
    execute format('drop policy if exists %I on public.items', p.policyname);
  end loop;
end $$;
create policy "everyone suggests" on public.items for insert to authenticated with check (kind = 'suggestion');
create policy "roles add" on public.items for insert to authenticated with check (public.items_can_change(kind, data));
create policy "roles change" on public.items for update to authenticated using (public.items_can_change(kind, data)) with check (public.items_can_change(kind, data));
create policy "roles remove" on public.items for delete to authenticated using (public.items_can_change(kind, data));
drop function if exists public.items_can_change(text);   -- the older rule (one part of the roster for all)

-- tables from the other files: their rules follow the settings too (skipped if that file isn't run yet)
do $$
begin
  if to_regclass('public.work_orders') is not null then
    execute 'drop policy if exists "administrators and mechanics remove finished" on public.work_orders';
    execute 'drop policy if exists "remove finished work orders" on public.work_orders';
    execute 'create policy "remove finished work orders" on public.work_orders for delete to authenticated using (public.maint_is_manager() and status in (''completed'',''closed''))';
  end if;
  if to_regclass('public.job_photos') is not null then
    execute 'drop policy if exists "supervisors and up read" on public.job_photos';
    execute 'create policy "supervisors and up read" on public.job_photos for select to authenticated using (public.photos_can_see())';
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'roles') then
    alter publication supabase_realtime add table public.roles;
  end if;
end $$;

notify pgrst, 'reload schema';
