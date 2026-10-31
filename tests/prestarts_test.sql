-- FraserFlow prestarts: database rule tests (Phase 3)
-- Run in Supabase → SQL Editor after schema.sql, maintenance.sql and prestarts.sql.
-- Everything runs inside one transaction that is rolled back at the end: it leaves no data or files behind.
-- Each check prints PASS in the messages; the first failure stops the run with FAIL.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000a2','t-planner@test.local'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local'),
  ('00000000-0000-0000-0000-0000000000a5','t-viewer@test.local'),
  ('00000000-0000-0000-0000-0000000000a6','t-operator@test.local'),
  ('00000000-0000-0000-0000-0000000000a7','t-superuser@test.local'),
  ('00000000-0000-0000-0000-0000000000a8','t-operator2@test.local')
on conflict (id) do nothing;
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1','t-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000a2','t-planner@test.local','planner'),
  ('00000000-0000-0000-0000-0000000000a4','t-mech@test.local','mechanic'),
  ('00000000-0000-0000-0000-0000000000a5','t-viewer@test.local','viewer'),
  ('00000000-0000-0000-0000-0000000000a6','t-operator@test.local','prestart'),
  ('00000000-0000-0000-0000-0000000000a7','t-superuser@test.local','superuser'),
  ('00000000-0000-0000-0000-0000000000a8','t-operator2@test.local','prestart')
on conflict (id) do update set role = excluded.role, staff_id = null;
insert into public.items (kind, id, data) values
  ('resource','t-mach-1','{"type":"machine","name":"TEST01","sub":"Test roller","category":"Test Rollers"}'),
  ('resource','t-mach-2','{"type":"machine","name":"TEST02","sub":"Test broom","category":"Test Brooms"}'),
  ('resource','t-truck-1','{"type":"machine","name":"TEST03","sub":"Test tipper","category":"Test Trucks"}'),
  ('resource','t-person-1','{"type":"person","name":"Pat Operator"}'),
  ('resource','t-crew-1','{"type":"crew","name":"Test crew"}');
insert into storage.buckets (id, name, public) values ('maintenance','maintenance',false) on conflict (id) do nothing;
-- other checklists already in this database would get in the way of these checks: take them out of use for the test
update public.prestart_templates set active = false where active;

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
-- a prestart for t-mach-1 with every answer filled in; tweak it per check
create function pg_temp.ps(tpl uuid, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('client_id', gen_random_uuid(), 'asset_id', 't-mach-1', 'template_id', tpl, 'hours', 1500,
    'signature', 'prestarts/00000000-0000-0000-0000-0000000000a6/c1/signature.png',
    'answers', jsonb_build_object('leaks', jsonb_build_object('answer','pass'), 'brakes', jsonb_build_object('answer','pass'),
                                  'fuel', jsonb_build_object('answer','75'), 'note', jsonb_build_object('answer',''))) || extra
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 1. Logins linked to Staff records; role changes are guarded -------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
update public.profiles set staff_id = 't-person-1' where id = '00000000-0000-0000-0000-0000000000a6';
select pg_temp.ok((select staff_id from public.profiles where id = '00000000-0000-0000-0000-0000000000a6') = 't-person-1', 'admin links an operator''s login to their Staff record');
select pg_temp.refused($$update public.profiles set staff_id = 't-person-1' where id = '00000000-0000-0000-0000-0000000000a8'$$, 'the same Staff record linked to a second login');
select pg_temp.refused($$update public.profiles set staff_id = 't-crew-1' where id = '00000000-0000-0000-0000-0000000000a8'$$, 'a login linked to a crew instead of a person');
select pg_temp.refused($$update public.profiles set role = 'viewer' where id = '00000000-0000-0000-0000-0000000000a1'$$, 'changing your own role');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
set local role authenticated;
select pg_temp.refused($$update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a2'$$, 'superuser making someone an admin');
select pg_temp.refused($$update public.profiles set role = 'viewer' where id = '00000000-0000-0000-0000-0000000000a1'$$, 'superuser demoting the admin');
select pg_temp.refused($$update public.profiles set role = 'planner' where id = '00000000-0000-0000-0000-0000000000a7'$$, 'superuser demoting themselves');
update public.profiles set role = 'prestart' where id = '00000000-0000-0000-0000-0000000000a8';
select pg_temp.ok((select role from public.profiles where id = '00000000-0000-0000-0000-0000000000a8') = 'prestart', 'superuser can set other roles');
reset role;

-- 2. Checklists: administrators and mechanics only; saved versions never change ----------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select pg_temp.refused($$insert into public.prestart_templates (name, category, items) values ('x','Test Rollers','[{"key":"a","text":"A"}]')$$, 'planner creating a checklist');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into public.prestart_templates (id, name, category, items) values ('00000000-0000-0000-0000-00000000d001','Roller prestart','Test Rollers',
  '[{"key":"leaks","section":"Walk-around","text":"No oil or fuel leaks","kind":"check"},
    {"key":"brakes","section":"Controls","text":"Brakes and park brake work","kind":"check","critical":true},
    {"key":"fuel","section":"Fluids","text":"Fuel level (%)","kind":"number"},
    {"key":"note","text":"Anything else","kind":"text"}]');
select pg_temp.ok((select version = 1 and active and family = id from public.prestart_templates where id = '00000000-0000-0000-0000-00000000d001'), 'admin creates a checklist: version 1, in use');
select pg_temp.refused($$insert into public.prestart_templates (name, category, items) values ('Empty','Test Brooms','[]')$$, 'a checklist with no questions');
select pg_temp.refused($$insert into public.prestart_templates (name, category, items) values ('Dup','Test Brooms','[{"key":"a","text":"A"},{"key":"a","text":"B"}]')$$, 'two questions with the same key');
select pg_temp.refused($$insert into public.prestart_templates (name, category, items) values ('Second','test rollers','[{"key":"a","text":"A"}]')$$, 'a second checklist for the same category');
select pg_temp.refused($$update public.prestart_templates set items = '[{"key":"z","text":"Z"}]' where id = '00000000-0000-0000-0000-00000000d001'$$, 'changing the questions of a saved checklist');
insert into public.prestart_templates (id, family, name, category, items) values ('00000000-0000-0000-0000-00000000d002','00000000-0000-0000-0000-00000000d001','Roller prestart','Test Rollers',
  '[{"key":"leaks","section":"Walk-around","text":"No oil or fuel leaks","kind":"check"},
    {"key":"brakes","section":"Controls","text":"Brakes and park brake work","kind":"check","critical":true},
    {"key":"fuel","section":"Fluids","text":"Fuel level (%)","kind":"number"},
    {"key":"note","text":"Anything else","kind":"text"},
    {"key":"spray","section":"Walk-around","text":"Water spray bars clear","kind":"check"}]');
select pg_temp.ok((select version from public.prestart_templates where id = '00000000-0000-0000-0000-00000000d002') = 2
  and (select not active and superseded_at is not null from public.prestart_templates where id = '00000000-0000-0000-0000-00000000d001'), 'editing saves version 2 and takes version 1 out of use');
select pg_temp.refused($$update public.prestart_templates set active = true where id = '00000000-0000-0000-0000-00000000d001'$$, 'putting an old version back into use');
insert into public.prestart_templates (id, name, category, items) values ('00000000-0000-0000-0000-00000000d003','General plant',null,'[{"key":"walk","text":"Walk-around done","kind":"check"}]');
insert into public.prestart_templates (id, name, category, items) values ('00000000-0000-0000-0000-00000000d004','Truck prestart','Test Trucks','[{"key":"walk","text":"Walk-around done","kind":"check"}]');
reset role;
select pg_temp.ok(public.prestart_template_for('t-mach-2') = '00000000-0000-0000-0000-00000000d003', 'a machine with no checklist for its category gets the one for all other machines');

-- 3. The file store -----------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
insert into storage.objects (bucket_id, name) values ('maintenance','prestarts/00000000-0000-0000-0000-0000000000a6/c1/signature.png'),
  ('maintenance','prestarts/00000000-0000-0000-0000-0000000000a6/c1/brakes-1.jpg');
select pg_temp.ok(true, 'operator uploads a photo and signature to their own folder');
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values ('maintenance','prestarts/00000000-0000-0000-0000-0000000000a8/x.jpg')$$, 'uploading into someone else''s folder');
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values ('maintenance','assets/t-mach-1/manual.pdf')$$, 'operator uploading a machine manual');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a8');
set local role authenticated;
insert into storage.objects (bucket_id, name) values ('maintenance','prestarts/00000000-0000-0000-0000-0000000000a8/c9/photo.jpg');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a5');
set local role authenticated;
select pg_temp.refused($$insert into storage.objects (bucket_id, name) values ('maintenance','prestarts/00000000-0000-0000-0000-0000000000a5/x.jpg')$$, 'viewer uploading a file');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
set local role authenticated;
insert into storage.objects (bucket_id, name) values ('maintenance','assets/t-mach-1/manual.pdf');
insert into public.maintenance_files (asset_id, kind, name, path) values ('t-mach-1','manual','Operator manual.pdf','assets/t-mach-1/manual.pdf');
select pg_temp.ok((select count(*) from public.maintenance_files where asset_id = 't-mach-1') = 1, 'mechanic adds a manual to a machine');
select pg_temp.refused($$insert into public.maintenance_files (asset_id, name, path) values ('t-mach-1','x','assets/t-mach-2/x.pdf')$$, 'a document filed under a different machine');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
set local role authenticated;
with d as (delete from public.maintenance_files where asset_id = 't-mach-1' returning 1)
select pg_temp.ok((select count(*) from d) = 0, 'a planner cannot remove a manual');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
with d as (delete from public.maintenance_files where asset_id = 't-mach-1' returning 1)
select pg_temp.ok((select count(*) from d) = 1, 'administrator removes a manual');
reset role;
-- files themselves can only be removed through Supabase's Storage API (as the app does), so here we check the rule it applies:
-- the only remove rule on the file store covers machine documents, for administrators; prestart photos and signatures have none
select pg_temp.ok((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('DELETE','ALL') and qual like '%maintenance%') = 1
  and (select qual from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'maintenance files: administrators remove documents') like '%assets%maint_is_manager%',
  'only administrators can remove files, and only machine documents (never prestart photos or signatures)');

-- 4. Submitting a prestart ---------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a5');
set local role authenticated;
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002'))$$, 'viewer submitting a prestart');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002'))$$, 'a question left unanswered (the new spray bar question)');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"fail"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))$$, 'a failed check with no comment');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"pass"},"fuel":{"answer":"lots"},"spray":{"answer":"pass"}}}'))$$, 'a number question answered with words');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"signature":"prestarts/00000000-0000-0000-0000-0000000000a6/none.png","answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"pass"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))$$, 'no signature');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"answers":{"leaks":{"answer":"pass","photos":["prestarts/00000000-0000-0000-0000-0000000000a8/c9/photo.jpg"]},"brakes":{"answer":"pass"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))$$, 'someone else''s photo');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"hours":null,"answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"pass"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))$$, 'no engine hours');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d003', '{"answers":{"walk":{"answer":"pass"}}}'))$$, 'the wrong checklist for this machine');
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d004', '{"asset_id":"t-truck-1","answers":{"walk":{"answer":"pass"}}}'))$$, 'a truck prestart with no km');
create temp table r on commit drop as
  select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"client_id":"00000000-0000-0000-0000-00000000e001","location":"Duntroon Rd","answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"fail","comment":"Park brake slips","photos":["prestarts/00000000-0000-0000-0000-0000000000a6/c1/brakes-1.jpg"]},"fuel":{"answer":"75"},"note":{"answer":""},"spray":{"answer":"na"}}}')) as res;
reset role;
select pg_temp.ok((select res->>'result' from r) = 'unsafe', 'a failed critical check makes the result "do not operate"');
select pg_temp.ok((select operator = '00000000-0000-0000-0000-0000000000a6' and operator_name = 'Pat Operator' and staff_id = 't-person-1' and failed = 1 and hours = 1500
                   from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001'), 'the prestart records the operator (from their Staff record), hours and failures');
select pg_temp.ok((select count(*) from public.prestart_answers a join public.prestarts p on p.id = a.prestart_id where p.client_id = '00000000-0000-0000-0000-00000000e001') = 5
  and (select photos[1] from public.prestart_answers a join public.prestarts p on p.id = a.prestart_id where p.client_id = '00000000-0000-0000-0000-00000000e001' and item_key = 'brakes') like '%brakes-1.jpg', 'every answer is saved with its question wording and photos');
select pg_temp.ok((select value = 1500 and source = 'prestart' from public.meter_readings where asset_id = 't-mach-1' order by read_at desc limit 1), 'the prestart hours become a meter reading');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.ok((public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"client_id":"00000000-0000-0000-0000-00000000e001"}'))->>'again')::boolean
  and (select count(*) from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001') = 1, 'sending the same prestart twice keeps one copy');
select pg_temp.ok((public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"hours":1400,"answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"pass"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))->>'meter_note') like 'Hours not saved%',
  'hours lower than the last reading: the prestart is still saved, with a note, and the reading is not');
select pg_temp.ok((select max(value) from public.meter_readings where asset_id = 't-mach-1' and kind = 'hours') = 1500, 'the lower reading was not recorded');
reset role;

-- 5. Submitted prestarts are permanent ------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
with u as (update public.prestarts set result = 'pass' where client_id = '00000000-0000-0000-0000-00000000e001' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'admin cannot change a submitted prestart');
with d as (delete from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001' returning 1)
select pg_temp.ok((select count(*) from d) = 0, 'admin cannot delete a submitted prestart');
select pg_temp.refused($$insert into public.prestarts (client_id, asset_id, template_id, operator, operator_name, result, signature) values (gen_random_uuid(),'t-mach-1','00000000-0000-0000-0000-00000000d002','00000000-0000-0000-0000-0000000000a1','x','pass','x')$$, 'writing a prestart directly, around the checks');
reset role;
-- not even from the SQL Editor
select pg_temp.refused($$update public.prestarts set result = 'pass' where client_id = '00000000-0000-0000-0000-00000000e001'$$, 'changing a prestart in the SQL Editor');
select pg_temp.refused($$delete from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001'$$, 'deleting a prestart in the SQL Editor');
select pg_temp.refused($$update public.prestart_answers set answer = 'pass' where item_key = 'brakes'$$, 'changing an answer in the SQL Editor');
-- a checklist changed while someone is part way through: the version it replaced still counts for 12 hours
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
insert into public.prestart_templates (family, name, category, items) select family, name, category, items || '[{"key":"horn","text":"Horn works"}]'::jsonb from public.prestart_templates where id = '00000000-0000-0000-0000-00000000d002';
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.ok((public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"hours":1510,"answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"pass"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))->>'result') = 'pass', 'a prestart started just before the checklist changed is accepted');
reset role;
select set_config('request.jwt.claims', '', true);   -- as the SQL Editor
update public.prestart_templates set superseded_at = now() - interval '13 hours' where id = '00000000-0000-0000-0000-00000000d002';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a6');
set local role authenticated;
select pg_temp.refused($$select public.submit_prestart(pg_temp.ps('00000000-0000-0000-0000-00000000d002', '{"answers":{"leaks":{"answer":"pass"},"brakes":{"answer":"pass"},"fuel":{"answer":"75"},"spray":{"answer":"pass"}}}'))$$, 'a checklist replaced more than 12 hours ago');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.ok((select count(*) from public.maintenance_audit where tbl = 'prestarts') >= 2, 'prestarts are in the audit trail');
reset role;

-- 6. The administrator can delete a prestart (e.g. a test), with a reason that is kept
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a7');
set local role authenticated;
select pg_temp.refused($$select public.delete_prestart((select id from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001'), 'test')$$, 'superuser deleting a prestart');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;
select pg_temp.refused($$select public.delete_prestart((select id from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001'), '  ')$$, 'deleting a prestart without a reason');
create temp table gone on commit drop as select id from public.prestarts where client_id = '00000000-0000-0000-0000-00000000e001';
select public.delete_prestart((select id from gone), 'Test prestart');
select pg_temp.ok(not exists (select 1 from public.prestarts where id = (select id from gone)) and not exists (select 1 from public.prestart_answers where prestart_id = (select id from gone)),
  'administrator deletes a prestart and its answers');
select pg_temp.ok((select new->>'reason' = 'Test prestart' and jsonb_array_length(old->'answers') = 5 from public.maintenance_audit where row_id = (select id from gone)::text and action = 'delete (administrator)'),
  'the reason and a full copy of the prestart are kept in the audit trail');
reset role;
select pg_temp.refused($$delete from public.prestarts where id = (select id from public.prestarts limit 1)$$, 'other prestarts still can''t be deleted directly');

select 'ALL PRESTART TESTS PASSED' as result;
rollback;
