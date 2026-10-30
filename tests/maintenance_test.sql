-- FraserFlow maintenance: database rule tests (Phase 2)
-- Run in Supabase → SQL Editor after schema.sql and maintenance.sql.
-- Everything runs inside one transaction that is rolled back at the end: it leaves no data behind.
-- Each check prints PASS in the messages; the first failure stops the run with FAIL.

begin;

-- test people (one per role) and a test machine
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000a2','t-planner@test.local'),
  ('00000000-0000-0000-0000-0000000000a3','t-super@test.local'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local'),
  ('00000000-0000-0000-0000-0000000000a5','t-viewer@test.local')
on conflict (id) do nothing;
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000a2','t-planner@test.local','planner'),
  ('00000000-0000-0000-0000-0000000000a3','t-super@test.local','supervisor'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local','mechanic'),
  ('00000000-0000-0000-0000-0000000000a5','t-viewer@test.local','viewer')
on conflict (id) do update set role = excluded.role;
insert into public.items (kind, id, data) values
  ('resource','t-mach-1','{"type":"machine","name":"TEST01","sub":"Test roller","category":"Steel Rollers"}'),
  ('resource','t-crew-1','{"type":"crew","name":"Test crew"}');

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
grant execute on all functions in schema pg_temp to authenticated;

-- 1. Existing machines appear in maintenance; records must point at a real machine
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.asset_profiles (asset_id, make, model, year, serial, meter_type) values ('t-mach-1','Dynapac','CC1200',2019,'SN123','hours');
select pg_temp.ok((select make from public.asset_profiles where asset_id = 't-mach-1') = 'Dynapac', 'mechanic adds a maintenance profile to an existing machine');
select pg_temp.refused($$insert into public.asset_profiles (asset_id) values ('no-such-machine')$$, 'profile for a machine that is not on the roster');
select pg_temp.refused($$insert into public.asset_profiles (asset_id) values ('t-crew-1')$$, 'profile for a crew (not a machine)');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
with u as (update public.asset_profiles set make = 'X' where asset_id = 't-mach-1' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'planner cannot change a maintenance profile');
select pg_temp.ok((select count(*) from public.asset_profiles where asset_id = 't-mach-1') = 1, 'planner can see maintenance profiles');
reset role;

-- 2. Meter readings: never go backwards; corrections by an administrator only; never edited or deleted
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.meter_readings (asset_id, kind, value, read_at) values ('t-mach-1','hours',1200, now() - interval '2 days');
select pg_temp.refused($$insert into public.meter_readings (asset_id, kind, value) values ('t-mach-1','hours',1150)$$, 'reading lower than the last one');
select pg_temp.refused($$insert into public.meter_readings (asset_id, kind, value, source) values ('t-mach-1','hours',1150,'correction')$$, 'mechanic recording a correction');
select pg_temp.refused($$insert into public.meter_readings (asset_id, kind, value, read_at) values ('t-mach-1','hours',1300, now() + interval '5 days')$$, 'reading dated in the future');
insert into public.meter_readings (asset_id, kind, value) values ('t-mach-1','hours',1210);
with d as (delete from public.meter_readings where asset_id = 't-mach-1' returning 1)
select pg_temp.ok((select count(*) from d) = 0, 'readings cannot be deleted');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into public.meter_readings (asset_id, kind, value, source, note) values ('t-mach-1','hours',1205,'correction','typo');
select pg_temp.ok(true, 'administrator records a correction');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a5');
set local role authenticated;
select pg_temp.refused($$insert into public.meter_readings (asset_id, kind, value) values ('t-mach-1','hours',1300)$$, 'viewer adding a reading');
reset role;

-- 3. Service plans: administrators only
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.refused($$insert into public.service_plans (category, name, every_hours) values ('Steel Rollers','250 hr',250)$$, 'mechanic creating a service plan');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into public.service_plans (id, category, name, every_hours, every_days) values ('00000000-0000-0000-0000-00000000b001','Steel Rollers','250 hr service',250,180);
select pg_temp.refused($$insert into public.service_plans (category, name) values ('Steel Rollers','No interval')$$, 'plan with no interval');
reset role;

-- 4. Service records: a completed service also records the meter
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.service_records (asset_id, plan_id, service_type, done_on, hours, work_done, parts)
values ('t-mach-1','00000000-0000-0000-0000-00000000b001','250 hr service', current_date, 1250, 'Oil and filters', '[{"part":"Oil filter","qty":1}]');
select pg_temp.ok((select max(value) from public.meter_readings where asset_id = 't-mach-1' and kind = 'hours') = 1250, 'service hours become the latest meter reading');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.refused($$insert into public.service_records (asset_id, service_type, done_on) values ('t-mach-1','x', current_date)$$, 'planner recording a service');
reset role;

-- 5. Work orders: no duplicates per plan; completed before closed; only supervisors/admins verify
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.work_orders (id, asset_id, wo_type, plan_id, title, start_date, end_date)
values ('00000000-0000-0000-0000-00000000c001','t-mach-1','service','00000000-0000-0000-0000-00000000b001','500 hr service', current_date + 3, current_date + 4);
select pg_temp.refused($$insert into public.work_orders (asset_id, wo_type, plan_id, title) values ('t-mach-1','service','00000000-0000-0000-0000-00000000b001','again')$$, 'second open work order for the same plan');
select pg_temp.refused($$insert into public.work_orders (asset_id, wo_type, title, status) values ('t-mach-1','request','x','closed')$$, 'new work order already closed');
reset role;
-- scheduled work shows on the board as machine downtime
select pg_temp.ok((select data->>'kind' = 'service' and data->>'resourceId' = 't-mach-1' and data->>'start' = (current_date + 3)::text
                   from public.items where kind = 'block' and id = 'wo-00000000-0000-0000-0000-00000000c001'), 'scheduled work order appears as downtime on the board');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.refused($$update public.work_orders set status = 'closed' where id = '00000000-0000-0000-0000-00000000c001'$$, 'closing a work order that is not completed');
update public.work_orders set status = 'completed', completion_notes = 'Done' where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.ok((select completed_by = '00000000-0000-0000-0000-0000000000a4' from public.work_orders where id = '00000000-0000-0000-0000-00000000c001'), 'completion records who completed it');
select pg_temp.refused($$update public.work_orders set status = 'closed' where id = '00000000-0000-0000-0000-00000000c001'$$, 'mechanic verifying and closing');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
update public.work_orders set status = 'closed' where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.ok((select verified_by = '00000000-0000-0000-0000-0000000000a3' and verified_at is not null from public.work_orders where id = '00000000-0000-0000-0000-00000000c001'), 'supervisor verifies and closes');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.refused($$update public.work_orders set title = 'changed' where id = '00000000-0000-0000-0000-00000000c001'$$, 'mechanic changing a closed work order');
insert into public.work_orders (id, asset_id, wo_type, plan_id, title) values ('00000000-0000-0000-0000-00000000c002','t-mach-1','service','00000000-0000-0000-0000-00000000b001','Next 250 hr');
select pg_temp.ok(true, 'a new work order for the plan is allowed once the last one is closed');
insert into public.work_orders (id, asset_id, wo_type, title, start_date) values ('00000000-0000-0000-0000-00000000c003','t-mach-1','breakdown','Hydraulic leak', current_date);
update public.work_orders set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000c003';
reset role;
select pg_temp.ok(not exists (select 1 from public.items where id = 'wo-00000000-0000-0000-0000-00000000c003'), 'cancelling removes the downtime from the board');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.refused($$insert into public.work_orders (asset_id, wo_type, title) values ('t-mach-1','request','x')$$, 'planner creating a work order');
reset role;

-- 6. Audit trail: written automatically, readable by administrators only
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.ok((select count(*) from public.maintenance_audit) = 0, 'mechanic cannot read the audit trail');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.ok((select count(*) from public.maintenance_audit where tbl = 'work_orders' and row_id = '00000000-0000-0000-0000-00000000c001') >= 3, 'every work order change is in the audit trail');
reset role;

-- 7. Existing roster still works for planners
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
insert into public.items (kind, id, data) values ('block','t-block-1','{"kind":"job","resourceId":"t-crew-1","start":"2026-11-02","end":"2026-11-03"}');
select pg_temp.ok(exists (select 1 from public.items where id = 't-block-1'), 'planner can still add bookings');
reset role;

select 'ALL MAINTENANCE TESTS PASSED' as result;
rollback;
