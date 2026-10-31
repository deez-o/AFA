-- FraserFlow ServiceM8 link: database rule tests
-- Run in Supabase → SQL Editor after schema.sql, maintenance.sql, prestarts.sql, defects.sql, planner_link.sql and servicem8.sql.
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
  ('resource','t-mach-1','{"type":"machine","name":"TEST01","sub":"Test roller","category":"Test Rollers"}');
insert into public.meter_readings (asset_id, kind, value, source) values ('t-mach-1','hours',1000,'manual');
update public.servicem8_settings set enabled = false, auto_send = true, contractor_name = 'Test Mechanical', parts_queue_uuid = null where id = 1;

create function pg_temp.as_user(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.as_server() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
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
create function pg_temp.link(wo uuid) returns public.servicem8_jobs language sql as $$ select * from public.servicem8_jobs where work_order_id = wo $$;
create function pg_temp.wo(wo uuid) returns public.work_orders language sql as $$ select * from public.work_orders where id = wo $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- 1. Switched off: nothing is queued ---------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.work_orders (id, asset_id, wo_type, title) values ('00000000-0000-0000-0000-00000000d001','t-mach-1','request','Before switching on');
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d001')).work_order_id is null, 'while the link is off, new work orders aren’t queued for ServiceM8');
-- a mechanic can't switch it on
update public.servicem8_settings set enabled = true where id = 1;
reset role;
select pg_temp.ok((select not enabled from public.servicem8_settings), 'a mechanic can’t change the ServiceM8 settings');

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
update public.servicem8_settings set enabled = true where id = 1;
reset role;
select pg_temp.ok((select enabled from public.servicem8_settings), 'an administrator switches the link on');

-- 2. Credentials and the server's function are out of reach ------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.refused($$select * from public.servicem8_secrets$$, 'not even an administrator can read the ServiceM8 credentials');
select pg_temp.refused($$select public.servicem8_apply('00000000-0000-0000-0000-00000000d001', '{"status":"completed"}', null, '[]', '{}')$$, 'people can’t call the server’s sync function');
reset role;

-- 3. New work orders queue themselves; "don't send" and "send" ------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.work_orders (id, asset_id, wo_type, plan_id, title) values ('00000000-0000-0000-0000-00000000d002','t-mach-1','service',null,'250 h service');
insert into public.work_orders (id, asset_id, wo_type, title) values ('00000000-0000-0000-0000-00000000d003','t-mach-1','breakdown','Hose burst');
reset role;
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d002')).state = 'pending' and (pg_temp.link('00000000-0000-0000-0000-00000000d003')).state = 'pending',
  'once it is on, a new work order waits to be sent');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.refused($$update public.servicem8_jobs set state = 'sent' where work_order_id = '00000000-0000-0000-0000-00000000d002'$$, 'people can’t change the link directly');
select pg_temp.ok(public.servicem8_request('00000000-0000-0000-0000-00000000d003', false) = 'held', 'a mechanic chooses not to send a work order');
select pg_temp.ok(public.servicem8_request('00000000-0000-0000-0000-00000000d001', true) = 'pending', 'a mechanic sends an older work order');
reset role;
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d003')).state = 'held' and (pg_temp.link('00000000-0000-0000-0000-00000000d001')).state = 'pending', 'held and pending are recorded');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.refused($$select public.servicem8_request('00000000-0000-0000-0000-00000000d003', true)$$, 'a planner can’t send work orders to ServiceM8');
reset role;

-- 4. The server sends it; his booking comes back ------------------------------------------------
select pg_temp.as_server();
set local role service_role;
update public.servicem8_jobs set state = 'sent', job_uuid = '00000000-0000-0000-0000-0000000000f1', sent_at = now() where work_order_id = '00000000-0000-0000-0000-00000000d002';
update public.servicem8_jobs set state = 'sent', job_uuid = '00000000-0000-0000-0000-0000000000f2', sent_at = now() where work_order_id = '00000000-0000-0000-0000-00000000d001';
select pg_temp.ok(public.servicem8_apply('00000000-0000-0000-0000-00000000d002',
  json_build_object('status','scheduled','start_date',current_date + 2,'end_date',current_date + 3,'assigned_to','Test Mechanical')::jsonb, null, '[]', '{"job_no":"501","sm8_status":"Work Order"}') = 'scheduled',
  'his booking: the work order becomes Scheduled');
reset role;
select pg_temp.ok((pg_temp.wo('00000000-0000-0000-0000-00000000d002')).start_date = current_date + 2 and (pg_temp.wo('00000000-0000-0000-0000-00000000d002')).assigned_to = 'Test Mechanical',
  'with his dates, and the contractor as Assigned');
select pg_temp.ok(exists (select 1 from public.items where kind = 'block' and id = 'wo-00000000-0000-0000-0000-00000000d002'), 'his booking shows on the schedule board as the machine’s downtime');
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d002')).job_no = '501' and not (pg_temp.link('00000000-0000-0000-0000-00000000d002')).dirty,
  'his job number is kept, and a change from ServiceM8 isn’t sent back to it');

-- 5. Changes made in FraserFlow are passed on -----------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
update public.work_orders set description = 'Also check the brakes' where id = '00000000-0000-0000-0000-00000000d002';
reset role;
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d002')).dirty, 'a description changed in FraserFlow waits to be passed on to his job');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
select pg_temp.ok(public.servicem8_request('00000000-0000-0000-0000-00000000d002', true) = 'sent', 'sending one already in ServiceM8 does nothing');
select pg_temp.refused($$select public.servicem8_request('00000000-0000-0000-0000-00000000d002', false)$$, 'one already in ServiceM8 can’t be held back');
reset role;

-- 6. He completes a service: the service record, its reading, the next service ---------------------------
select pg_temp.as_server();
set local role service_role;
update public.servicem8_jobs set dirty = false where work_order_id = '00000000-0000-0000-0000-00000000d002';
select pg_temp.ok(public.servicem8_apply('00000000-0000-0000-0000-00000000d002',
  '{"status":"completed","completion_notes":"Oil and filters. Hours: 1250","parts":[{"part":"Oil filter","qty":"1"}]}',
  json_build_object('done_on', current_date, 'hours', 1250, 'km', null, 'mechanic', 'Test Mechanical')::jsonb, '[]', '{"sm8_status":"Completed"}') = 'completed',
  'he completes the service');
reset role;
select pg_temp.ok((pg_temp.wo('00000000-0000-0000-0000-00000000d002')).completed_at is not null and (pg_temp.wo('00000000-0000-0000-0000-00000000d002')).completion_notes like 'Oil and filters%'
  and (pg_temp.wo('00000000-0000-0000-0000-00000000d002')).parts->0->>'part' = 'Oil filter', 'the work order is completed with his notes and parts');
select pg_temp.ok(exists (select 1 from public.service_records where work_order_id = '00000000-0000-0000-0000-00000000d002' and hours = 1250 and mechanic = 'Test Mechanical'),
  'it becomes the machine’s service record');
select pg_temp.ok(exists (select 1 from public.meter_readings where asset_id = 't-mach-1' and kind = 'hours' and value = 1250 and source = 'service'),
  'and its hours become the machine’s reading');
select pg_temp.ok(not (pg_temp.link('00000000-0000-0000-0000-00000000d002')).dirty, 'completing from ServiceM8 isn’t sent back to it');
select pg_temp.as_server();
set local role service_role;
select public.servicem8_apply('00000000-0000-0000-0000-00000000d002', '{"status":"in_progress"}', null, '[]', '{"sm8_status":"Work Order"}');
select public.servicem8_apply('00000000-0000-0000-0000-00000000d002', '{"status":"completed"}', json_build_object('done_on', current_date, 'hours', 1260)::jsonb, '[]', '{"sm8_status":"Completed"}');
reset role;
select pg_temp.ok((select count(*) from public.service_records where work_order_id = '00000000-0000-0000-0000-00000000d002') = 1, 'reopened and completed again: still one service record');

-- 7. A repair completed with a lower reading; then verified here, and ServiceM8 can't change it ------------
select pg_temp.as_server();
set local role service_role;
select public.servicem8_apply('00000000-0000-0000-0000-00000000d001', '{"status":"completed","completion_notes":"Done"}', null, '[{"kind":"hours","value":900}]', '{}');
reset role;
select pg_temp.ok((select count(*) from public.meter_readings where asset_id = 't-mach-1' and value = 900) = 0, 'a reading lower than the last one isn’t saved');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
update public.work_orders set status = 'closed' where id = '00000000-0000-0000-0000-00000000d001';
reset role;
select pg_temp.as_server();
set local role service_role;
select pg_temp.ok(public.servicem8_apply('00000000-0000-0000-0000-00000000d001', '{"status":"in_progress"}', null, '[]', '{"sm8_status":"Work Order"}') = 'closed',
  'a verified & closed work order isn’t reopened by ServiceM8');
select public.servicem8_apply('00000000-0000-0000-0000-00000000d001', '{}', null, '[]', '{"removed":true}');
reset role;
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d001')).state = 'removed', 'a job deleted in ServiceM8 is marked removed');

-- 8. Cancelling here is passed on ---------------------------------------------------------------
select pg_temp.as_server();
set local role service_role;
update public.servicem8_jobs set state = 'sent', job_uuid = '00000000-0000-0000-0000-0000000000f3', dirty = false where work_order_id = '00000000-0000-0000-0000-00000000d003';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
update public.work_orders set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000d003';
reset role;
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d003')).dirty, 'cancelling a work order here is passed on to his job');
select pg_temp.refused($$delete from public.work_orders where id = '00000000-0000-0000-0000-00000000d003'$$, 'a work order whose job is still open in ServiceM8 can’t be deleted');

-- 9. An edit while it is being sent isn't lost ------------------------------------------------------
select pg_temp.as_server();
set local role service_role;
update public.servicem8_jobs set state = 'sending', dirty = false where work_order_id = '00000000-0000-0000-0000-00000000d001';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
update public.work_orders set status = 'open' where id = '00000000-0000-0000-0000-00000000d001';
update public.work_orders set title = 'Renamed while sending' where id = '00000000-0000-0000-0000-00000000d001';
reset role;
select pg_temp.ok((pg_temp.link('00000000-0000-0000-0000-00000000d001')).dirty, 'a change made while it is being sent is passed on afterwards');

select 'ALL SERVICEM8 TESTS PASSED' as result;
rollback;
