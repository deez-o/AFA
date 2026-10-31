-- FraserFlow: timesheets (in development: only the administrator sees the screen until it's released).
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql, roles.sql, prestarts.sql and qa.sql.
-- Safe to run again.
--
-- One timesheet per staff member per week. The work week runs Tuesday to Monday. Each day is kept in `days`:
--   { "2026-11-02": { "kind": "work", "start": "06:00", "finish": "16:30", "break": 30, "hours": 10,
--                     "notes": "", "pack_id": "...", "block_id": "...", "crew_id": "...", "by": "self" | "supervisor" } }
--   kind: work | leave | sick | rdo | training | public_holiday | off
-- Someone can only put in their own time for a day they signed on to (signed a JSA in a QA pack that day);
-- anything else is added by a supervisor. Once the week is signed off it's locked (a supervisor can reopen it).
-- Who can do what (Admin › Roles): 'timesheets' (view: everyone's; change: edit anyone's and sign off),
-- 'timesheets.mine' (fill in their own). The administrator can do everything.

create table if not exists public.timesheets (
  id            uuid primary key default gen_random_uuid(),
  staff_id      text not null,                      -- the staff member (roster id)
  user_id       uuid,                               -- their login, if they have one
  name          text,
  week_start    date not null,   -- the Tuesday the week starts
  days          jsonb not null default '{}'::jsonb check (jsonb_typeof(days) = 'object'),
  status        text not null default 'open' check (status in ('open','submitted','approved')),
  submitted_at  timestamptz,
  approved_by   uuid,
  approved_name text,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
-- the week starts on a Tuesday (older set-ups had Monday)
alter table public.timesheets drop constraint if exists timesheets_week_start_check;
delete from public.timesheets where extract(isodow from week_start) <> 2;   -- trial timesheets from the Monday-start version (in development, no real data)
alter table public.timesheets add constraint timesheets_week_start_check check (extract(isodow from week_start) = 2);
create unique index if not exists timesheets_one_per_week on public.timesheets (staff_id, week_start);
create index if not exists timesheets_week on public.timesheets (week_start);
create index if not exists timesheets_user on public.timesheets (user_id);

-- signatures: the worker signs when they send it in (or on the supervisor's phone, e.g. someone without a login),
-- and the supervisor signs to sign it off. Both are needed before a week is signed off.
alter table public.timesheets add column if not exists worker_sig text check (worker_sig is null or (worker_sig like 'data:image/png;base64,%' and length(worker_sig) < 400000));
alter table public.timesheets add column if not exists worker_sig_name text;
alter table public.timesheets add column if not exists worker_signed_at timestamptz;
alter table public.timesheets add column if not exists worker_sig_by uuid;
alter table public.timesheets add column if not exists sup_sig text check (sup_sig is null or (sup_sig like 'data:image/png;base64,%' and length(sup_sig) < 400000));
alter table public.timesheets add column if not exists sup_signed_at timestamptz;

create or replace function public.ts_is_manager() returns boolean language sql stable security definer set search_path = public as $$
  select public.can('timesheets', 2) $$;
create or replace function public.ts_mine(sid text, uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (uid = auth.uid() or sid is not distinct from public.my_staff_id()) and public.can('timesheets.mine', 2) $$;
grant execute on function public.ts_is_manager() to authenticated;
grant execute on function public.ts_mine(text, uuid) to authenticated;

-- the rules: own days only on days they signed on; nothing changes once signed off unless a supervisor reopens it
create or replace function public.ts_rules() returns trigger language plpgsql security definer set search_path = public as $$
declare k text; d jsonb; o jsonb; mgr boolean := public.ts_is_manager();
begin
  new.updated_at := now(); new.updated_by := auth.uid();
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  -- a new or changed worker signature: stamp when and by whose login
  if new.worker_sig is not null and (tg_op = 'INSERT' or new.worker_sig is distinct from old.worker_sig) then
    new.worker_signed_at := now(); new.worker_sig_by := auth.uid();
  elsif new.worker_sig is null then
    new.worker_signed_at := null; new.worker_sig_by := null; new.worker_sig_name := null;
  end if;
  if mgr then
    if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
      if new.worker_sig is null then raise exception 'The worker needs to sign their timesheet before it''s signed off' using errcode = '22023'; end if;
      if new.sup_sig is null then raise exception 'Sign the timesheet to sign it off' using errcode = '22023'; end if;
      new.approved_by := auth.uid(); new.approved_at := now(); new.sup_signed_at := now();
    elsif new.status <> 'approved' then
      new.approved_by := null; new.approved_at := null; new.approved_name := null; new.sup_sig := null; new.sup_signed_at := null;
    end if;
    return new;
  end if;
  -- someone filling in their own
  if tg_op = 'UPDATE' then
    if old.status = 'approved' then raise exception 'This week has been signed off. Ask your supervisor to change it.' using errcode = '42501'; end if;
    if new.staff_id <> old.staff_id or new.week_start <> old.week_start then raise exception 'Not allowed' using errcode = '42501'; end if;
  end if;
  if new.status = 'approved' then raise exception 'Only a supervisor can sign off a timesheet' using errcode = '42501'; end if;
  new.approved_by := null; new.approved_at := null; new.approved_name := null; new.sup_sig := null; new.sup_signed_at := null;
  -- changing a day after signing means signing again
  if tg_op = 'UPDATE' and new.days is distinct from old.days and new.worker_sig is not distinct from old.worker_sig then
    new.worker_sig := null; new.worker_signed_at := null; new.worker_sig_by := null; new.worker_sig_name := null;
    if new.status = 'submitted' then new.status := 'open'; new.submitted_at := null; end if;   -- to be checked, signed and sent again
  end if;
  if new.status = 'submitted' and new.worker_sig is null then raise exception 'Sign your timesheet to send it in' using errcode = '22023'; end if;
  new.submitted_at := case when new.status = 'submitted' then coalesce(new.submitted_at, now()) else null end;
  for k, d in select key, value from jsonb_each(new.days) loop
    o := case when tg_op = 'UPDATE' then old.days -> k else null end;
    if d is not distinct from o then continue; end if;           -- unchanged day
    if (k::date) < new.week_start or (k::date) > new.week_start + 6 then raise exception 'Day % isn''t in this week', k using errcode = '22023'; end if;
    -- leave and other days are put in by a supervisor (or from the leave calendar when the timesheet is made)
    if coalesce(d->>'kind', 'work') <> 'work' then
      if tg_op = 'INSERT' then continue; end if;
      raise exception 'Leave and other days are changed by your supervisor' using errcode = '42501';
    end if;
    if not exists (select 1 from public.qa_signatures s join public.qa_packs p on p.id = s.pack_id
                    where s.form = 'jsa' and s.user_id = auth.uid() and p.shift_date = k::date) then
      raise exception 'You didn''t sign on to a job on % (sign the JSA first). Your supervisor can add the day.', to_char(k::date, 'Dy DD Mon') using errcode = '42501';
    end if;
  end loop;
  return new;
end; $$;
drop trigger if exists timesheets_rules on public.timesheets;
create trigger timesheets_rules before insert or update on public.timesheets for each row execute function public.ts_rules();

alter table public.timesheets enable row level security;
revoke all on public.timesheets from anon;
grant select, insert, update, delete on public.timesheets to authenticated;
drop policy if exists "read own or everyone's" on public.timesheets;
create policy "read own or everyone's" on public.timesheets for select to authenticated
  using (public.can('timesheets', 1) or user_id = auth.uid() or staff_id is not distinct from public.my_staff_id());
drop policy if exists "start own or anyone's" on public.timesheets;
create policy "start own or anyone's" on public.timesheets for insert to authenticated
  with check (public.ts_is_manager() or public.ts_mine(staff_id, user_id));
drop policy if exists "change own or anyone's" on public.timesheets;
create policy "change own or anyone's" on public.timesheets for update to authenticated
  using (public.ts_is_manager() or public.ts_mine(staff_id, user_id))
  with check (public.ts_is_manager() or public.ts_mine(staff_id, user_id));
drop policy if exists "managers remove" on public.timesheets;
create policy "managers remove" on public.timesheets for delete to authenticated using (public.ts_is_manager());

-- live updates
do $$ begin
  alter publication supabase_realtime add table public.timesheets;
exception when duplicate_object then null; when undefined_object then null; end $$;

notify pgrst, 'reload schema';
