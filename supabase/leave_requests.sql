-- FraserFlow: leave requests. Supervisors put in leave for anyone on staff; it stays "waiting for approval"
-- (shown dashed on the leave calendar) until an administrator or superuser approves it, which puts it on
-- the leave calendar and the schedule, or declines it.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql and prestarts.sql.
-- Safe to run again. It only adds a table and its rules; roster data in `items` is not changed.

create table if not exists public.leave_requests (
  id              uuid primary key default gen_random_uuid(),
  person_id       text not null,                       -- the staff member (roster id)
  kind            text not null check (kind in ('leave','sick','rdo','training')),
  start_date      date not null,
  end_date        date not null,
  note            text,
  status          text not null default 'pending' check (status in ('pending','approved','declined')),
  requested_by    uuid default auth.uid(),
  requested_name  text,
  requested_at    timestamptz not null default now(),
  decided_by      uuid,
  decided_name    text,
  decided_at      timestamptz,
  decline_reason  text,
  block_id        text,                                -- the leave on the calendar, once approved
  check (end_date >= start_date)
);
create index if not exists leave_requests_status on public.leave_requests (status, start_date);

create or replace function public.leave_can_request()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser','planner','supervisor'), false)
$$;
create or replace function public.leave_can_decide()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser'), false)
$$;

create or replace function public.leave_request_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.items where kind = 'resource' and id = new.person_id and data->>'type' = 'person') then
      raise exception 'No staff member with id % on the roster', new.person_id using errcode = '23503';
    end if;
    new.status = 'pending'; new.requested_at = now();
    if auth.uid() is not null then new.requested_by = auth.uid(); new.requested_name = public.my_name(); end if;
    new.decided_by = null; new.decided_name = null; new.decided_at = null; new.decline_reason = null; new.block_id = null;
    return new;
  end if;
  -- a decision: only administrators and superusers, and only once
  new.id = old.id; new.person_id = old.person_id; new.requested_by = old.requested_by; new.requested_name = old.requested_name; new.requested_at = old.requested_at;
  if auth.uid() is not null and not public.leave_can_decide() then
    raise exception 'Only an administrator or superuser can approve or decline leave' using errcode = '42501';
  end if;
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'This leave request has already been %', old.status using errcode = '22023';
  end if;
  if new.status <> old.status then
    new.decided_at = now();
    if auth.uid() is not null then new.decided_by = auth.uid(); new.decided_name = public.my_name(); end if;
  end if;
  return new;
end; $$;
drop trigger if exists leave_requests_rules on public.leave_requests;
create trigger leave_requests_rules before insert or update on public.leave_requests for each row execute function public.leave_request_rules();

alter table public.leave_requests enable row level security;
grant select, insert, update, delete on public.leave_requests to authenticated;
drop policy if exists "signed-in people read" on public.leave_requests;
create policy "signed-in people read" on public.leave_requests for select to authenticated using (true);
drop policy if exists "supervisors request" on public.leave_requests;
create policy "supervisors request" on public.leave_requests for insert to authenticated with check (public.leave_can_request());
drop policy if exists "administrators decide" on public.leave_requests;
create policy "administrators decide" on public.leave_requests for update to authenticated using (public.leave_can_decide()) with check (public.leave_can_decide());
drop policy if exists "withdraw while waiting" on public.leave_requests;
create policy "withdraw while waiting" on public.leave_requests for delete to authenticated
  using ((status = 'pending' and requested_by = auth.uid()) or public.leave_can_decide());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leave_requests') then
    alter publication supabase_realtime add table public.leave_requests;
  end if;
end $$;
