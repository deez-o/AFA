-- FraserFlow roles: database rule tests
-- Run in Supabase → SQL Editor after supabase/roles.sql. Rolled back at the end: it leaves no data behind.

begin;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1','t-rl-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000e2','t-rl-custom@test.local'),
  ('00000000-0000-0000-0000-0000000000e3','t-rl-super@test.local')
on conflict (id) do nothing;
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000e1','t-rl-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000e2','t-rl-custom@test.local','viewer'),
  ('00000000-0000-0000-0000-0000000000e3','t-rl-super@test.local','superuser')
on conflict (id) do update set role = excluded.role;

create function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end; $$;
create function pg_temp.refused(stmt text, label text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then raise notice 'PASS: % (refused: %)', label, sqlerrm; return; end;
  raise exception 'FAIL: % (it was allowed)', label;
end; $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.ok((select count(*) = 8 from public.roles where key in ('admin','superuser','planner','supervisor','mechanic','prestart','lab','viewer')), 'the 8 starting roles are there');

-- only the administrator changes roles
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e3');
set local role authenticated;
select pg_temp.refused($$insert into public.roles (key, label) values ('sneaky','Sneaky')$$, 'a superuser adding a role');
update public.roles set perms = '{"ideas":2}' where key = 'superuser';
select pg_temp.ok((select not (perms ? 'ideas') from public.roles where key = 'superuser'), 'a superuser can''t change roles');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
insert into public.roles (key, label, perms) values ('foreman', 'Foreman', '{"schedule":1,"jobs":2}');
select pg_temp.ok(exists (select 1 from public.roles where key = 'foreman'), 'the administrator adds a role');
update public.roles set perms = '{"schedule":2}' where key = 'admin';
select pg_temp.ok((select perms = '{}'::jsonb from public.roles where key = 'admin'), 'the Admin role can''t be narrowed');
select pg_temp.refused($$delete from public.roles where key = 'admin'$$, 'deleting the Admin role');
reset role;

-- a login with the new role: jobs yes (change), bookings only view; the database follows the settings
update public.profiles set role = 'foreman' where id = '00000000-0000-0000-0000-0000000000e2';
select pg_temp.refused($$update public.profiles set role = 'nosuch' where id = '00000000-0000-0000-0000-0000000000e2'$$, 'a role that doesn''t exist');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
set local role authenticated;
select pg_temp.ok(public.can('jobs', 2) and public.can('schedule', 1) and not public.can('schedule', 2) and not public.can('qa', 1), 'can() reads the role''s levels');
insert into public.items (kind, id, data) values ('job', 't-rl-job', '{"name":"Foreman job"}');
select pg_temp.ok(exists (select 1 from public.items where id = 't-rl-job'), 'Jobs: change lets them add a job');
select pg_temp.ok(not public.maint_can_work() and not public.qa_can_fill(), 'and nothing it wasn''t given');
reset role;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
select pg_temp.refused($$delete from public.roles where key = 'foreman'$$, 'deleting a role that logins still have');
update public.roles set perms = '{"schedule":1,"jobs":1}' where key = 'foreman';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
set local role authenticated;
select pg_temp.refused($$insert into public.items (kind, id, data) values ('job', 't-rl-job2', '{}')$$, 'once Jobs is only view, the database refuses');
reset role;

-- each part of the roster follows its own area: leave rights don't let someone move bookings
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
update public.roles set perms = '{"schedule":1,"staff.leave":2}' where key = 'foreman';
insert into public.items (kind, id, data) values ('block', 't-rl-bk1', '{"kind":"job","resourceId":"x","start":"2026-11-02","end":"2026-11-02"}');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
set local role authenticated;
insert into public.items (kind, id, data) values ('block', 't-rl-lv1', '{"kind":"leave","resourceId":"p1","start":"2026-11-02","end":"2026-11-03"}');
select pg_temp.ok(exists (select 1 from public.items where id = 't-rl-lv1'), 'Leave calendar “change”: leave can be put on the calendar');
select pg_temp.refused($$insert into public.items (kind, id, data) values ('block', 't-rl-bk2', '{"kind":"job","resourceId":"x","start":"2026-11-02","end":"2026-11-02"}')$$, 'but not a job booking (Schedule board is only view)');
with u as (update public.items set data = jsonb_set(data, '{start}', '"2026-11-05"') where id = 't-rl-bk1' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'and an existing booking can''t be moved');
reset role;

select 'ALL ROLE TESTS PASSED' as result;
rollback;
