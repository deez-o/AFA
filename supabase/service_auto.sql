-- FraserFlow Fleet: services raised automatically
-- Run once in Supabase → SQL Editor → New query → paste → Run, after maintenance.sql. Safe to run again.
--
-- When it's switched on (Fleet › Service plans), the server checks every machine on the regular schedule
-- (supabase/servicem8_schedule.sql, every 10 minutes): when a service comes within its plan's warning window,
-- or is overdue, a service work order is made, the same as clicking "Create work order". With the ServiceM8 link
-- on, it then goes to the mechanic like any other new work order. Cancelling one means "not this time": it isn't
-- raised again until the next service is due.

create table if not exists public.fleet_settings (
  id            int primary key default 1 check (id = 1),
  auto_service  boolean not null default false,   -- raise service work orders automatically
  last_check_at timestamptz,                     -- when the server last looked
  last_raised   int,                             -- how many it raised then
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);
insert into public.fleet_settings (id) values (1) on conflict (id) do nothing;
drop trigger if exists fleet_settings_touch on public.fleet_settings;
create trigger fleet_settings_touch before update on public.fleet_settings for each row execute function public.maint_touch();
drop trigger if exists fleet_settings_audit on public.fleet_settings;
create trigger fleet_settings_audit after insert or update or delete on public.fleet_settings for each row execute function public.maint_audit();

alter table public.fleet_settings enable row level security;
revoke all on public.fleet_settings from anon, authenticated;   -- Supabase grants everything by default
grant select, update on public.fleet_settings to authenticated;
drop policy if exists "signed-in people read" on public.fleet_settings;
create policy "signed-in people read" on public.fleet_settings for select to authenticated using (true);
drop policy if exists "fleet managers change" on public.fleet_settings;
create policy "fleet managers change" on public.fleet_settings for update to authenticated using (public.maint_is_manager()) with check (public.maint_is_manager());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fleet_settings') then
    alter publication supabase_realtime add table public.fleet_settings;
  end if;
end $$;

notify pgrst, 'reload schema';
