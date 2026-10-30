-- FraserFlow planner link: database rule tests (Phase 5)
-- Run in Supabase → SQL Editor after all the scripts (schema, maintenance, prestarts, defects, planner_link).
-- Everything runs inside one transaction that is rolled back at the end: it leaves no data behind.
-- Each check prints PASS in the messages; the first failure stops the run with FAIL.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000a2','t-planner@test.local'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local')
on conflict (id) do nothing;
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000a2','t-planner@test.local','planner'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local','mechanic')
on conflict (id) do update set role = excluded.role;
insert into public.items (kind, id, data) values
  ('resource','t-mach-1','{"type":"machine","name":"TEST01","sub":"Test roller","category":"Test Rollers"}'),
  ('resource','t-mach-2','{"type":"machine","name":"TEST02","sub":"Test roller","category":"Test Rollers"}'),
  ('resource','t-crew-1','{"type":"crew","name":"Test crew"}'),
  ('block','t-old','{"kind":"job","resourceId":"t-crew-1","start":"2026-11-02","end":"2026-11-03","plantIds":["t-mach-1"]}');

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
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS: % (refused: %)', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % (it was allowed)', label;
end; $$;
create function pg_temp.alert(a text) returns public.machine_alerts language sql as $$ select * from public.machine_alerts where asset_id = a $$;
grant execute on all functions in schema pg_temp to authenticated;

-- TEST01 gets a critical defect: restricted
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.defects (asset_id, title, severity) values ('t-mach-1','Brakes fail','critical');
reset role;

-- 1. Restricted machines can't be added by any route ----------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
insert into public.items (kind, id, data) values ('block','t-new-ok','{"kind":"job","resourceId":"t-crew-1","start":"2026-11-04","end":"2026-11-04","plantIds":["t-mach-2"]}');
select pg_temp.ok(true, 'a booking with an unrestricted machine saves as before');
select pg_temp.refused($$insert into public.items (kind, id, data) values ('block','t-new-bad','{"kind":"job","resourceId":"t-crew-1","start":"2026-11-04","end":"2026-11-04","plantIds":["t-mach-2","t-mach-1"]}')$$,
  'a new booking with a restricted machine');
select pg_temp.refused($$update public.items set data = jsonb_set(data, '{plantIds}', '["t-mach-2","t-mach-1"]') where kind = 'block' and id = 't-new-ok'$$,
  'adding a restricted machine to an existing booking');
select pg_temp.refused($$insert into public.items (kind, id, data) values ('plan','t-plan','{"name":"Test plan","machineIds":["t-mach-1"]}')$$,
  'a job plan that needs a restricted machine');
select pg_temp.refused($$insert into public.items (kind, id, data) values ('block','t-new-bad','{"kind":"job","resourceId":"t-crew-1","start":"2026-11-04","end":"2026-11-04","plantIds":["t-mach-1"]}') on conflict (kind, id) do update set data = excluded.data$$,
  'an upsert (how the app saves) with a restricted machine');
update public.items set data = jsonb_set(data, '{title}', '"Changed"') where kind = 'block' and id = 't-old';
select pg_temp.ok((select data->>'title' from public.items where kind = 'block' and id = 't-old') = 'Changed', 'a booking that already had the machine can still be edited');
update public.items set data = jsonb_set(data, '{plantIds}', '[]') where kind = 'block' and id = 't-old';
select pg_temp.ok((select data->'plantIds' from public.items where kind = 'block' and id = 't-old') = '[]'::jsonb, 'the restricted machine can be taken off a booking');
insert into public.items (kind, id, data) values ('block','t-down','{"kind":"repair","resourceId":"t-mach-1","start":"2026-11-04","end":"2026-11-05"}');
select pg_temp.ok(true, 'downtime on the restricted machine''s own row can still be booked');
reset role;

-- 2. What the planner sees ------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.ok((pg_temp.alert('t-mach-1')).restricted and (pg_temp.alert('t-mach-1')).restriction like 'Critical defect D-%Brakes fail'
  and (pg_temp.alert('t-mach-1')).open_defects = 1 and (pg_temp.alert('t-mach-1')).critical_defects = 1, 'machine alerts: TEST01 restricted, with 1 critical defect');
select pg_temp.ok(not (pg_temp.alert('t-mach-2')).restricted and (pg_temp.alert('t-mach-2')).service is null, 'machine alerts: TEST02 clear');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into public.service_plans (id, category, name, every_hours) values ('00000000-0000-0000-0000-00000000b501','Test Rollers','250 hr service',250);
insert into public.service_records (asset_id, plan_id, service_type, done_on, hours) values ('t-mach-2','00000000-0000-0000-0000-00000000b501','250 hr service', current_date - 30, 1000);
insert into public.meter_readings (asset_id, kind, value, read_at) values ('t-mach-2','hours',1230, now() - interval '1 hour');
select pg_temp.ok((pg_temp.alert('t-mach-2')).service = 'soon' and (pg_temp.alert('t-mach-2')).service_plans = '250 hr service', 'machine alerts: a service within its warning (20 h to go) shows due soon');
insert into public.meter_readings (asset_id, kind, value) values ('t-mach-2','hours',1260);
select pg_temp.ok((pg_temp.alert('t-mach-2')).service = 'overdue', 'machine alerts: past 1,250 h it shows overdue');

-- 3. Back in service: it can be booked again ----------------------------------------------------
update public.defects set status = 'dismissed', resolution = 'Test' where asset_id = 't-mach-1';
update public.restrictions set active = false where asset_id = 't-mach-1';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
update public.items set data = jsonb_set(data, '{plantIds}', '["t-mach-1"]') where kind = 'block' and id = 't-old';
select pg_temp.ok((select data->'plantIds' ? 't-mach-1' from public.items where kind = 'block' and id = 't-old') and not (pg_temp.alert('t-mach-1')).restricted,
  'once returned to service, the machine can be booked again');
reset role;

select 'ALL PLANNER LINK TESTS PASSED' as result;
rollback;
