-- FraserFlow defects: database rule tests (Phase 4)
-- Run in Supabase → SQL Editor after schema.sql, maintenance.sql, prestarts.sql and defects.sql.
-- Everything runs inside one transaction that is rolled back at the end: it leaves no data behind.
-- Each check prints PASS in the messages; the first failure stops the run with FAIL.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000a3','t-super@test.local'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local'),
  ('00000000-0000-0000-0000-0000000000a6','t-operator@test.local')
on conflict (id) do nothing;
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000a3','t-super@test.local','supervisor'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local','mechanic'),
  ('00000000-0000-0000-0000-0000000000a6','t-operator@test.local','prestart')
on conflict (id) do update set role = excluded.role, staff_id = null;
insert into public.items (kind, id, data) values
  ('resource','t-mach-1','{"type":"machine","name":"TEST01","sub":"Test roller","category":"Test Rollers"}'),
  ('resource','t-mach-2','{"type":"machine","name":"TEST02","sub":"Test broom","category":"Test Brooms"}');
insert into storage.buckets (id, name, public) values ('maintenance','maintenance',false) on conflict (id) do nothing;
update public.prestart_templates set active = false where active;   -- other checklists would get in the way

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
-- a prestart on TEST01 by the operator; answers: {"leaks": "pass"|"fail", "brakes": ...}
create function pg_temp.ps(leaks text, brakes text, hrs int) returns jsonb language sql as $$
  select public.submit_prestart(jsonb_build_object('client_id', gen_random_uuid(), 'asset_id', 't-mach-1',
    'template_id', '00000000-0000-0000-0000-00000000d101', 'hours', hrs,
    'signature', 'prestarts/00000000-0000-0000-0000-0000000000a6/d/sig.png',
    'answers', jsonb_build_object(
      'leaks', jsonb_build_object('answer', leaks, 'comment', case when leaks = 'fail' then 'Hydraulic weep at the drum' end,
                                  'photos', case when leaks = 'fail' then '["prestarts/00000000-0000-0000-0000-0000000000a6/d/leak.jpg"]'::jsonb else '[]'::jsonb end),
      'brakes', jsonb_build_object('answer', brakes, 'comment', case when brakes = 'fail' then 'Park brake slips' end))))
$$;
create function pg_temp.d(item text) returns public.defects language sql as $$
  select * from public.defects where asset_id = 't-mach-1' and item_key = item order by number desc limit 1
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- setup: a checklist with one critical question, and the operator's uploads
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into public.prestart_templates (id, name, category, items) values ('00000000-0000-0000-0000-00000000d101','Roller prestart','Test Rollers',
  '[{"key":"leaks","text":"No oil or fuel leaks","kind":"check"},{"key":"brakes","text":"Brakes and park brake work","kind":"check","critical":true}]');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
insert into storage.objects (bucket_id, name) values ('maintenance','prestarts/00000000-0000-0000-0000-0000000000a6/d/sig.png'),('maintenance','prestarts/00000000-0000-0000-0000-0000000000a6/d/leak.jpg');

-- 1. A failed item becomes a defect; failing again adds to it ------------------------
select pg_temp.ps('fail','pass',100);
reset role;
select pg_temp.ok((select status = 'reported' and severity = 'major' and source = 'prestart' and title = 'No oil or fuel leaks' and times_reported = 1
                     and photos[1] like '%leak.jpg' and description like '%Hydraulic weep%' and prestart_id is not null from pg_temp.d('leaks')),
  'a failed prestart item creates a linked defect, with the comment and photo');
select pg_temp.ok(not exists (select 1 from public.restrictions where asset_id = 't-mach-1' and active), 'a non-critical defect doesn''t restrict the machine');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.ps('fail','pass',110);
reset role;
select pg_temp.ok((select count(*) from public.defects where asset_id = 't-mach-1' and item_key = 'leaks') = 1 and (pg_temp.d('leaks')).times_reported = 2,
  'the same fault on the next prestart adds to the open defect (no duplicate)');

-- 2. A critical failure restricts the machine; a passing prestart doesn't clear it --------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.ps('pass','fail',120);
reset role;
select pg_temp.ok((pg_temp.d('brakes')).severity = 'critical'
  and exists (select 1 from public.restrictions where defect_id = (pg_temp.d('brakes')).id and active), 'a failed critical item creates a critical defect and restricts the machine');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.ps('pass','pass',130);
reset role;
select pg_temp.ok((pg_temp.d('brakes')).status = 'reported' and (pg_temp.d('leaks')).status = 'reported'
  and exists (select 1 from public.restrictions where defect_id = (pg_temp.d('brakes')).id and active), 'a later passing prestart clears neither the defects nor the restriction');

-- 3. Who can change defects ------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
with u as (update public.defects set status = 'dismissed', resolution = 'x' where asset_id = 't-mach-1' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'an operator can''t change defects');
select pg_temp.refused($$insert into public.defects (asset_id, title) values ('t-mach-1','x')$$, 'an operator adding a defect directly');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.defects (asset_id, title, severity) values ('t-mach-2','Cracked broom guard','minor');
select pg_temp.ok((select reported_name = 't-mech@test.local' and status = 'reported' from public.defects where asset_id = 't-mach-2'), 'a mechanic reports a defect by hand');
select pg_temp.refused($$update public.defects set status = 'repaired' where id = (pg_temp.d('leaks')).id$$, 'marking a defect repaired without saying what was done');
select pg_temp.refused($$update public.defects set status = 'closed' where id = (pg_temp.d('leaks')).id$$, 'closing a defect that hasn''t been repaired');
update public.defects set status = 'acknowledged' where id = (pg_temp.d('leaks')).id;

-- 4. Repair through a work order; release only after the repair is verified ---------------
insert into public.work_orders (id, asset_id, wo_type, title) values ('00000000-0000-0000-0000-00000000c101','t-mach-1','defect','Park brake and leak');
insert into public.work_orders (id, asset_id, wo_type, title) values ('00000000-0000-0000-0000-00000000c102','t-mach-2','defect','Other machine');
select pg_temp.refused($$update public.defects set work_order_id = '00000000-0000-0000-0000-00000000c102' where id = (pg_temp.d('brakes')).id$$, 'linking a defect to another machine''s work order');
update public.defects set work_order_id = '00000000-0000-0000-0000-00000000c101' where id in ((pg_temp.d('brakes')).id, (pg_temp.d('leaks')).id);
select pg_temp.ok((pg_temp.d('brakes')).status = 'in_repair' and (pg_temp.d('leaks')).status = 'in_repair', 'several defects go on one work order and show as in repair');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.refused($$update public.restrictions set active = false where defect_id = (pg_temp.d('brakes')).id$$, 'releasing the machine while the repair isn''t verified');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
update public.work_orders set status = 'completed', completion_notes = 'Adjusted park brake, replaced hose' where id = '00000000-0000-0000-0000-00000000c101';
select pg_temp.ok((pg_temp.d('brakes')).status = 'repaired' and (pg_temp.d('brakes')).resolution like 'Adjusted park brake%', 'completing the work order marks its defects repaired');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
with u as (update public.defects set status = 'closed' where id = (pg_temp.d('brakes')).id returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'an operator can''t verify a repair');
with u as (update public.restrictions set active = false where defect_id = (pg_temp.d('brakes')).id returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'an operator can''t release a restriction');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
update public.work_orders set status = 'closed' where id = '00000000-0000-0000-0000-00000000c101';
select pg_temp.ok((pg_temp.d('brakes')).status = 'closed' and (pg_temp.d('brakes')).closed_by = '00000000-0000-0000-0000-0000000000a3', 'verifying the work order closes its defects');
select pg_temp.ok(exists (select 1 from public.restrictions where defect_id = (pg_temp.d('brakes')).id and active), 'the machine stays restricted until an administrator releases it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
update public.restrictions set active = false, release_note = 'Tested on site' where defect_id = (pg_temp.d('brakes')).id;
select pg_temp.ok((select not active and released_by = '00000000-0000-0000-0000-0000000000a1' from public.restrictions where defect_id = (pg_temp.d('brakes')).id), 'after a verified repair the administrator returns the machine to service');
select pg_temp.refused($$update public.restrictions set active = true where defect_id = (pg_temp.d('brakes')).id$$, 'reactivating a released restriction');
reset role;

-- 5. After it is closed, a new failure is a new defect -------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
create temp table before_no on commit drop as select (pg_temp.d('brakes')).number as n;
select pg_temp.ps('pass','fail',140);
reset role;
select pg_temp.ok((pg_temp.d('brakes')).number > (select n from before_no) and (pg_temp.d('brakes')).status = 'reported'
  and (select count(*) from public.restrictions where asset_id = 't-mach-1' and active) = 1, 'the same fault after a closed repair is a new defect, with a new restriction');

-- 6. Dismissing, and cancelled work orders -------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
with u as (update public.defects set status = 'dismissed', resolution = 'Not a fault' where asset_id = 't-mach-2' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'an operator can''t dismiss a defect');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into public.work_orders (id, asset_id, wo_type, title) values ('00000000-0000-0000-0000-00000000c103','t-mach-2','defect','Guard');
update public.defects set work_order_id = '00000000-0000-0000-0000-00000000c103' where asset_id = 't-mach-2';
update public.work_orders set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000c103';
select pg_temp.ok((select status = 'acknowledged' and work_order_id is null from public.defects where asset_id = 't-mach-2'), 'cancelling a work order puts its defects back to waiting for repair');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
set local role authenticated;
select pg_temp.refused($$update public.defects set status = 'dismissed' where asset_id = 't-mach-2'$$, 'dismissing without a reason');
update public.defects set status = 'dismissed', resolution = 'Guard was already replaced' where asset_id = 't-mach-2';
select pg_temp.ok((select status = 'dismissed' from public.defects where asset_id = 't-mach-2'), 'a supervisor dismisses a defect, with a reason');
with d as (delete from public.defects where asset_id = 't-mach-2' returning 1)
select pg_temp.ok((select count(*) from d) = 0, 'defects are never deleted');
reset role;

-- 7. Deleting a test prestart dismisses the defects only it reported ------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select public.delete_prestart((select prestart_id from pg_temp.d('brakes')), 'Test prestart');
reset role;
select pg_temp.ok((pg_temp.d('brakes')).status = 'dismissed' and not exists (select 1 from public.restrictions where asset_id = 't-mach-1' and active),
  'the administrator deleting a test prestart dismisses its defect and lifts its restriction');

select 'ALL DEFECT TESTS PASSED' as result;
rollback;
