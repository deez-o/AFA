-- FraserFlow: Lab. Past shifts by job with what was laid (from the submitted QA packs), and the lab's reports.
-- Adds the "lab" login role (sees the Lab screen only).
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql and qa.sql.
-- Safe to run again. It only adds a role, a table, a private file store and their rules.

-- (the Lab role is in the roles table: Admin › Roles; see roles.sql)

create or replace function public.lab_can_see()
returns boolean language sql stable security definer set search_path = public as $$
  select public.can('lab', 1) or public.can('jobs.paperwork', 1)   -- Admin › Roles
$$;
create or replace function public.lab_can_upload()
returns boolean language sql stable security definer set search_path = public as $$
  select public.can('lab.upload', 2) or public.can('jobs.paperwork', 2)
$$;
create or replace function public.lab_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.can('lab.manage', 2) or public.can('jobs.manage', 2)
$$;

-- a lab report: for a job, optionally one shift
create table if not exists public.lab_reports (
  id           uuid primary key default gen_random_uuid(),
  job_id       text not null,
  shift_date   date,
  block_id     text,
  name         text not null,
  path         text not null unique,
  mime         text,
  size         bigint,
  note         text,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  created_name text,
  constraint lab_reports_path check (path like 'jobs/' || job_id || '/%')
);
create index if not exists lab_reports_job on public.lab_reports (job_id, shift_date);
-- what sort of report: asphalt report, core report, NCR, or a QA pack uploaded by hand (a scan)
alter table public.lab_reports add column if not exists kind text not null default 'other';
alter table public.lab_reports drop constraint if exists lab_reports_kind;
alter table public.lab_reports add constraint lab_reports_kind check (kind in ('asphalt','core','ncr','qa','other'));

create or replace function public.lab_report_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.items where kind = 'job' and id = new.job_id) then
    raise exception 'No job with id %', new.job_id using errcode = '23503';
  end if;
  new.created_at = now();
  if auth.uid() is not null then
    new.created_by = auth.uid();
    new.created_name = coalesce((select p.email from public.profiles p where p.id = auth.uid()), new.created_name);
  end if;
  return new;
end; $$;
drop trigger if exists lab_reports_rules on public.lab_reports;
create trigger lab_reports_rules before insert on public.lab_reports for each row execute function public.lab_report_rules();

alter table public.lab_reports enable row level security;
grant select, insert, delete on public.lab_reports to authenticated;
drop policy if exists "lab and office read" on public.lab_reports;
create policy "lab and office read" on public.lab_reports for select to authenticated using (public.lab_can_see());
drop policy if exists "lab adds" on public.lab_reports;
create policy "lab adds" on public.lab_reports for insert to authenticated with check (public.lab_can_upload());
drop policy if exists "remove own or administrators" on public.lab_reports;
create policy "remove own or administrators" on public.lab_reports for delete to authenticated using (public.lab_is_manager() or (created_by = auth.uid() and public.lab_can_upload()));

-- the file store (Supabase Storage bucket "lab", private): jobs/<job id>/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab', 'lab', false, 26214400, array['application/pdf','image/jpeg','image/png','image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "lab files: read" on storage.objects;
create policy "lab files: read" on storage.objects for select to authenticated using (bucket_id = 'lab' and public.lab_can_see());
drop policy if exists "lab files: add" on storage.objects;
create policy "lab files: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'lab' and (storage.foldername(name))[1] = 'jobs' and public.lab_can_upload());
drop policy if exists "lab files: remove" on storage.objects;
create policy "lab files: remove" on storage.objects for delete to authenticated using (bucket_id = 'lab' and public.lab_can_upload());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lab_reports') then
    alter publication supabase_realtime add table public.lab_reports;
  end if;
end $$;

-- a shift the lab has finished with (asphalt report and core report in): it moves to Complete in Lab
create table if not exists public.lab_done (
  job_id     text not null,
  shift_date date not null,
  done_at    timestamptz not null default now(),
  done_by    uuid default auth.uid(),
  done_name  text,
  primary key (job_id, shift_date)
);
create or replace function public.lab_done_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.lab_reports where job_id = new.job_id and shift_date = new.shift_date and kind = 'asphalt')
     or not exists (select 1 from public.lab_reports where job_id = new.job_id and shift_date = new.shift_date and kind = 'core') then
    raise exception 'A shift is done once it has an asphalt report and a core report' using errcode = '22023';
  end if;
  new.done_at = now();
  if auth.uid() is not null then new.done_by = auth.uid(); new.done_name = public.my_name(); end if;
  return new;
end; $$;
drop trigger if exists lab_done_rules on public.lab_done;
create trigger lab_done_rules before insert on public.lab_done for each row execute function public.lab_done_rules();
alter table public.lab_done enable row level security;
grant select, insert, delete on public.lab_done to authenticated;
drop policy if exists "lab and office read" on public.lab_done;
create policy "lab and office read" on public.lab_done for select to authenticated using (public.lab_can_see());
drop policy if exists "lab marks done" on public.lab_done;
create policy "lab marks done" on public.lab_done for insert to authenticated with check (public.lab_can_upload());
drop policy if exists "lab reopens" on public.lab_done;
create policy "lab reopens" on public.lab_done for delete to authenticated using (public.lab_can_upload());

-- make the API see the new columns straight away
notify pgrst, 'reload schema';
