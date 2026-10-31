-- FraserFlow services raised automatically: database rule tests
-- Run in Supabase → SQL Editor after maintenance.sql and service_auto.sql. Rolled back at the end: leaves no data behind.
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local'),('00000000-0000-0000-0000-0000000000a3','t-super@test.local') on conflict (id) do nothing;
insert into public.profiles (id, email, role) values ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local','mechanic'),('00000000-0000-0000-0000-0000000000a3','t-super@test.local','supervisor')
on conflict (id) do update set role = excluded.role;
update public.fleet_settings set auto_service = false where id = 1;
create function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end; $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
update public.fleet_settings set auto_service = true where id = 1;
reset role;
select pg_temp.ok((select not auto_service from public.fleet_settings), 'a supervisor can’t switch automatic services on');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.ok((select count(*) from public.fleet_settings) = 1, 'everyone signed in can see the setting');
update public.fleet_settings set auto_service = true where id = 1;
reset role;
select pg_temp.ok((select auto_service and updated_by = '00000000-0000-0000-0000-0000000000a4' from public.fleet_settings), 'a mechanic switches it on (and it records who)');
select 'ALL SERVICE AUTO TESTS PASSED' as result;
rollback;
