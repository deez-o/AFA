-- FraserFlow site QA packs: database rule tests
-- Run in Supabase → SQL Editor after all the scripts (schema, maintenance, prestarts, defects, planner_link, qa).
-- Everything runs inside one transaction that is rolled back at the end: it leaves no data behind.
-- Each check prints PASS in the messages; the first failure stops the run with FAIL.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1','t-qa-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000b2','t-qa-super@fraserflow.local'),
  ('00000000-0000-0000-0000-0000000000b3','t-qa-op@fraserflow.local'),
  ('00000000-0000-0000-0000-0000000000b4','t-qa-op2@fraserflow.local'),
  ('00000000-0000-0000-0000-0000000000b5','t-qa-viewer@test.local')
on conflict (id) do nothing;
insert into public.items (kind, id, data) values
  ('resource','t-qa-p1','{"type":"person","name":"Olive Operator"}'),
  ('resource','t-qa-p2','{"type":"person","name":"Sam Supervisor"}');
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000b1','t-qa-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000b2','t-qa-super@fraserflow.local','supervisor'),
  ('00000000-0000-0000-0000-0000000000b3','t-qa-op@fraserflow.local','prestart'),
  ('00000000-0000-0000-0000-0000000000b4','t-qa-op2@fraserflow.local','prestart'),
  ('00000000-0000-0000-0000-0000000000b5','t-qa-viewer@test.local','viewer')
on conflict (id) do update set role = excluded.role;
update public.profiles set staff_id = 't-qa-p1' where id = '00000000-0000-0000-0000-0000000000b3';
update public.profiles set staff_id = 't-qa-p2' where id = '00000000-0000-0000-0000-0000000000b2';

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
-- a small, valid PNG data URL
create temp table sig as select 'data:image/png;base64,iVBORw0KGgo='::text as png;
grant select on sig to authenticated;

-- 1. The supervisor starts a pack; operators and viewers can't --------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b3');
set local role authenticated;
select pg_temp.refused($$insert into public.qa_packs (id, block_id, shift_date) values ('10000000-0000-0000-0000-000000000001','t-blk','2026-11-02')$$, 'an operator can’t start a pack');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b5');
set local role authenticated;
select pg_temp.refused($$insert into public.qa_packs (id, block_id, shift_date) values ('10000000-0000-0000-0000-000000000001','t-blk','2026-11-02')$$, 'a viewer can’t start a pack');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
insert into public.qa_packs (id, block_id, shift_date, job_id, crew_id, jsa) values ('10000000-0000-0000-0000-000000000001','t-blk','2026-11-02','t-job','t-crew','{"ticks":{"hs.plant.0":true}}');
select pg_temp.ok((select created_by = '00000000-0000-0000-0000-0000000000b2' and status = 'draft' from public.qa_packs where id = '10000000-0000-0000-0000-000000000001'), 'a supervisor starts a pack (a draft, recorded as theirs)');
insert into public.qa_packs (id, block_id, shift_date, label) values ('10000000-0000-0000-0000-000000000002','t-blk','2026-11-02','Second work area');
select pg_temp.ok((select count(*) = 2 from public.qa_packs where block_id = 't-blk' and shift_date = '2026-11-02'), 'a second pack for the same shift, with its own name');
update public.qa_packs set jsa = '{"ticks":{"hs.plant.0":true,"hs.plant.1":true}}' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.ok((select jsa->'ticks' ? 'hs.plant.1' and updated_by = '00000000-0000-0000-0000-0000000000b2' from public.qa_packs where id = '10000000-0000-0000-0000-000000000001'), 'the supervisor ticks controls (saved, with who changed it)');
-- a visitor signs on the supervisor's phone
insert into public.qa_signatures (id, pack_id, form, user_id, name, company, signature) select '20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','jsa',null,'Vic Visitor','Big Daves Profiling',png from sig;
select pg_temp.ok((select name = 'Vic Visitor' and company = 'Big Daves Profiling' from public.qa_signatures where id = '20000000-0000-0000-0000-000000000001'), 'a visitor signs on the supervisor’s phone, with their own company');
reset role;

-- 2. Operators sign as themselves only ---------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b3');
set local role authenticated;
update public.qa_packs set jsa = '{}' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.ok((select jsa->'ticks' ? 'hs.plant.1' from public.qa_packs where id = '10000000-0000-0000-0000-000000000001'), 'an operator can’t change the pack');
insert into public.qa_signatures (id, pack_id, form, user_id, name, signature, signed_at) select '20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','jsa','00000000-0000-0000-0000-0000000000b3','Someone Else',png, now() - interval '2 hours' from sig;
select pg_temp.ok((select name = 'Olive Operator' and company = 'Alex Fraser Asphalt' and signed_at < now() - interval '1 hour' from public.qa_signatures where id = '20000000-0000-0000-0000-000000000002'),
  'an operator signs: their roster name is used (not what was typed), AFA as the company, and the time they signed without reception is kept');
select pg_temp.refused($$insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) select '20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','jsa','00000000-0000-0000-0000-0000000000b3','Olive',png from sig$$, 'signing the same form twice');
select pg_temp.refused($$insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) select '20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','jsa','00000000-0000-0000-0000-0000000000b4','Pretend',png from sig$$, 'signing as another person');
select pg_temp.refused($$insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) select '20000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','jsa',null,'A visitor',png from sig$$, 'an operator adding a visitor’s signature');
select pg_temp.refused($$insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) values ('20000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','jsa','00000000-0000-0000-0000-0000000000b3','x','not a picture')$$, 'a signature that isn’t a picture');
insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) select '20000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000001','toolbox','00000000-0000-0000-0000-0000000000b3','x',png from sig;
select pg_temp.ok(true, 'the same operator also signs the toolbox meeting');
delete from public.qa_signatures where id = '20000000-0000-0000-0000-000000000007';
select pg_temp.ok(not exists (select 1 from public.qa_signatures where id = '20000000-0000-0000-0000-000000000007'), 'an operator can take back their own signature before it’s submitted');
delete from public.qa_signatures where id = '20000000-0000-0000-0000-000000000001';
select pg_temp.ok(exists (select 1 from public.qa_signatures where id = '20000000-0000-0000-0000-000000000001'), 'but not someone else’s');
reset role;

-- 3. Submitted: locked ----------------------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
set local role authenticated;
update public.qa_packs set status = 'submitted' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.ok((select submitted_name = 'Sam Supervisor' and submitted_at is not null from public.qa_packs where id = '10000000-0000-0000-0000-000000000001'), 'submitted: with who and when');
select pg_temp.refused($$update public.qa_packs set jsa = '{}' where id = '10000000-0000-0000-0000-000000000001'$$, 'a submitted pack can’t be changed by the supervisor');
select pg_temp.refused($$insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) select '20000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000001','jsa',null,'Late',png from sig$$, 'no signatures added after it’s submitted');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b4');
set local role authenticated;
select pg_temp.refused($$insert into public.qa_signatures (id, pack_id, form, user_id, name, signature) select '20000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001','jsa','00000000-0000-0000-0000-0000000000b4','x',png from sig$$, 'an operator can’t sign a submitted pack');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
set local role authenticated;
update public.qa_packs set status = 'draft' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.ok((select status = 'draft' and submitted_at is null from public.qa_packs where id = '10000000-0000-0000-0000-000000000001'), 'the administrator reopens it');
delete from public.qa_packs where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.ok(not exists (select 1 from public.qa_signatures where pack_id = '10000000-0000-0000-0000-000000000001'), 'deleting a pack (administrators only) removes its signatures');
reset role;

select 'ALL QA TESTS PASSED' as result;
rollback;
