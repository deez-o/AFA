-- FraserFlow leave requests: database rule tests
-- Run in Supabase → SQL Editor after supabase/leave_requests.sql. Rolled back at the end: it leaves no data behind.

begin;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1','t-lv-admin@test.local'),
  ('00000000-0000-0000-0000-0000000000c2','t-lv-super@fraserflow.local'),
  ('00000000-0000-0000-0000-0000000000c3','t-lv-op@fraserflow.local'),
  ('00000000-0000-0000-0000-0000000000c4','t-lv-sup2@fraserflow.local')
on conflict (id) do nothing;
insert into public.items (kind, id, data) values ('resource','t-lv-p1','{"type":"person","name":"Pat Paver"}'),('resource','t-lv-p2','{"type":"person","name":"Sue Supervisor"}');
insert into public.profiles (id, email, role) values
  ('00000000-0000-0000-0000-0000000000c1','t-lv-admin@test.local','admin'),
  ('00000000-0000-0000-0000-0000000000c2','t-lv-super@fraserflow.local','supervisor'),
  ('00000000-0000-0000-0000-0000000000c3','t-lv-op@fraserflow.local','prestart'),
  ('00000000-0000-0000-0000-0000000000c4','t-lv-sup2@fraserflow.local','supervisor')
on conflict (id) do update set role = excluded.role;
update public.profiles set staff_id = 't-lv-p2' where id = '00000000-0000-0000-0000-0000000000c2';

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

-- a supervisor puts in leave for someone else
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
set local role authenticated;
insert into public.leave_requests (id, person_id, kind, start_date, end_date, note, status) values ('30000000-0000-0000-0000-000000000001','t-lv-p1','rdo','2026-11-09','2026-11-09','Dentist','approved');
select pg_temp.ok((select status = 'pending' and requested_name = 'Sue Supervisor' from public.leave_requests where id = '30000000-0000-0000-0000-000000000001'), 'a supervisor requests leave for anyone: it waits for approval (it can’t approve itself), with their name');
select pg_temp.refused($$insert into public.leave_requests (person_id, kind, start_date, end_date) values ('nobody','leave','2026-11-09','2026-11-09')$$, 'leave for someone not on staff');
select pg_temp.refused($$insert into public.leave_requests (person_id, kind, start_date, end_date) values ('t-lv-p1','leave','2026-11-09','2026-11-08')$$, 'leave that ends before it starts');
update public.leave_requests set status = 'approved' where id = '30000000-0000-0000-0000-000000000001';
select pg_temp.ok((select status = 'pending' from public.leave_requests where id = '30000000-0000-0000-0000-000000000001'), 'the supervisor can’t approve it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select pg_temp.refused($$insert into public.leave_requests (person_id, kind, start_date, end_date) values ('t-lv-p1','leave','2026-11-09','2026-11-09')$$, 'an operator can’t put in leave');
reset role;
-- another supervisor can't withdraw it; the one who asked can
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c4');
set local role authenticated;
delete from public.leave_requests where id = '30000000-0000-0000-0000-000000000001';
select pg_temp.ok(exists (select 1 from public.leave_requests where id = '30000000-0000-0000-0000-000000000001'), 'another supervisor can’t withdraw it');
insert into public.leave_requests (id, person_id, kind, start_date, end_date) values ('30000000-0000-0000-0000-000000000002','t-lv-p1','leave','2026-12-01','2026-12-05');
delete from public.leave_requests where id = '30000000-0000-0000-0000-000000000002';
select pg_temp.ok(not exists (select 1 from public.leave_requests where id = '30000000-0000-0000-0000-000000000002'), 'a supervisor can withdraw their own request while it waits');
reset role;
-- an operator: leave for themselves only, as a draft first
update public.profiles set staff_id = 't-lv-p1' where id = '00000000-0000-0000-0000-0000000000c3';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
insert into public.leave_requests (id, person_id, kind, start_date, end_date, status) values ('30000000-0000-0000-0000-000000000003','t-lv-p1','leave','2026-12-21','2026-12-24','draft');
select pg_temp.ok((select status = 'draft' from public.leave_requests where id = '30000000-0000-0000-0000-000000000003'), 'an operator saves a draft for themselves');
select pg_temp.refused($$insert into public.leave_requests (person_id, kind, start_date, end_date) values ('t-lv-p2','leave','2026-12-21','2026-12-24')$$, 'an operator putting in leave for someone else');
update public.leave_requests set end_date = '2026-12-31' where id = '30000000-0000-0000-0000-000000000003';
select pg_temp.refused($$update public.leave_requests set status = 'approved' where id = '30000000-0000-0000-0000-000000000003'$$, 'an operator approving their own draft');
select pg_temp.ok((select status = 'draft' and end_date = '2026-12-31' from public.leave_requests where id = '30000000-0000-0000-0000-000000000003'), 'they can change their draft');
update public.leave_requests set status = 'pending' where id = '30000000-0000-0000-0000-000000000003';
select pg_temp.ok((select status = 'pending' from public.leave_requests where id = '30000000-0000-0000-0000-000000000003'), 'then submit it');
update public.leave_requests set end_date = '2027-01-10' where id = '30000000-0000-0000-0000-000000000003';
select pg_temp.ok((select end_date = '2026-12-31' from public.leave_requests where id = '30000000-0000-0000-0000-000000000003'), 'once submitted they can’t change it');
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
update public.leave_requests set status = 'declined', end_date = '2027-01-10' where id = '30000000-0000-0000-0000-000000000003';
select pg_temp.ok((select status = 'declined' and end_date = '2026-12-31' from public.leave_requests where id = '30000000-0000-0000-0000-000000000003'), 'the administrator declines it (and can’t change what was asked for)');
reset role;

-- the administrator approves; once decided, it stays decided
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
update public.leave_requests set status = 'approved', block_id = 'b-test' where id = '30000000-0000-0000-0000-000000000001';
select pg_temp.ok((select status = 'approved' and decided_by = '00000000-0000-0000-0000-0000000000c1' and decided_at is not null and block_id = 'b-test' from public.leave_requests where id = '30000000-0000-0000-0000-000000000001'), 'the administrator approves it (who and when recorded)');
select pg_temp.refused($$update public.leave_requests set status = 'declined' where id = '30000000-0000-0000-0000-000000000001'$$, 'changing a decision');
reset role;

select 'ALL LEAVE REQUEST TESTS PASSED' as result;
rollback;
