-- Crew & Plant Roster: database setup
-- Run this once in Supabase → SQL Editor → New query → paste → Run.
-- It is safe to run again: it only creates what is missing.

-- 1. People who can sign in, and what they may do --------------------------
--    admin:     everything, and can change other people's roles; also sees features still in progress
--    superuser: the same as admin, except features the admin keeps to themselves while working on them
--    planner: can add, change and delete anything on the roster
--    viewer:  can look but not change anything (the default for new people)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'viewer' check (role in ('admin','superuser','planner','supervisor','mechanic','prestart','lab','viewer')),
  created_at timestamptz not null default now()
);

-- the full list of roles (for databases set up before superuser, supervisor, mechanic and operator existed)
alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles set role = 'prestart' where role = 'operator';   -- the role once called "operator" is now "prestart"
alter table public.profiles add constraint profiles_role_check check (role in ('admin','superuser','planner','supervisor','mechanic','prestart','lab','viewer'));

-- every new sign-in account gets a profile automatically
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- profiles for anyone who already has an account
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- the signed-in person's role (used by the rules below)
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- administrators and superusers have the same powers
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser'), false)
$$;

alter table public.profiles enable row level security;

drop policy if exists "read own profile, admins read all" on public.profiles;
create policy "read own profile, admins read all" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "admins change roles" on public.profiles;
create policy "admins change roles" on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 2. The roster ------------------------------------------------------------
--    One row per record. kind is one of:
--    resource (crew, staff member, machine, asphalt plant), job, block (booking),
--    quote_change (for notifications) or setting (mixes, binders, RAP %, default binders)
create table if not exists public.items (
  kind       text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (kind, id)
);

-- stamp who changed a row and when
create or replace function public.touch_item()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end; $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch
  before insert or update on public.items
  for each row execute function public.touch_item();

-- deleted rows are sent in full to other screens
alter table public.items replica identity full;

alter table public.items enable row level security;

drop policy if exists "signed-in people read the roster" on public.items;
create policy "signed-in people read the roster" on public.items
  for select to authenticated using (true);

drop policy if exists "planners add" on public.items;
create policy "planners add" on public.items
  for insert to authenticated
  with check (public.my_role() in ('admin','superuser','planner'));

drop policy if exists "planners change" on public.items;
create policy "planners change" on public.items
  for update to authenticated
  using (public.my_role() in ('admin','superuser','planner'))
  with check (public.my_role() in ('admin','superuser','planner'));

drop policy if exists "planners delete" on public.items;
create policy "planners delete" on public.items
  for delete to authenticated
  using (public.my_role() in ('admin','superuser','planner'));

-- 3. Live updates: other people's changes appear without refreshing ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;

-- 4. Ideas board and suggestions ---------------------------------------------
--    Only the administrator (role 'admin', not superusers) can read or change the
--    Ideas board (kind 'idea') and suggestions. Everyone signed in can send a suggestion.
drop policy if exists "signed-in people read the roster" on public.items;
create policy "signed-in people read the roster" on public.items
  for select to authenticated
  using (kind not in ('idea','suggestion') or public.my_role() = 'admin');

drop policy if exists "everyone suggests" on public.items;
create policy "everyone suggests" on public.items
  for insert to authenticated
  with check (kind = 'suggestion');

drop policy if exists "planners add" on public.items;
create policy "planners add" on public.items
  for insert to authenticated
  with check (public.my_role() = 'admin'
    or (public.my_role() in ('superuser','planner') and kind not in ('idea','suggestion')));

drop policy if exists "planners change" on public.items;
create policy "planners change" on public.items
  for update to authenticated
  using (public.my_role() = 'admin' or (public.my_role() in ('superuser','planner') and kind not in ('idea','suggestion')))
  with check (public.my_role() = 'admin' or (public.my_role() in ('superuser','planner') and kind not in ('idea','suggestion')));

drop policy if exists "planners delete" on public.items;
create policy "planners delete" on public.items
  for delete to authenticated
  using (public.my_role() = 'admin' or (public.my_role() in ('superuser','planner') and kind not in ('idea','suggestion')));
