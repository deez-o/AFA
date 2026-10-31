-- FraserFlow: job pictures (Jobs › a job › Pictures), shift by shift, each with a label, who uploaded it and when.
-- Supervisors, planners, superusers and administrators see and add them.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql and prestarts.sql.
-- Safe to run again. It only adds a table, a private file store and their rules.

create or replace function public.photos_can()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser','planner','supervisor'), false)
$$;
create or replace function public.photos_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser'), false)
$$;

create table if not exists public.job_photos (
  id           uuid primary key default gen_random_uuid(),
  job_id       text not null,
  shift_date   date not null,
  label        text,
  path         text not null unique,
  size         bigint,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  created_name text,
  constraint job_photos_path check (path like 'jobs/' || job_id || '/%')
);
create index if not exists job_photos_job on public.job_photos (job_id, shift_date);

create or replace function public.job_photo_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.items where kind = 'job' and id = new.job_id) then
      raise exception 'No job with id %', new.job_id using errcode = '23503';
    end if;
    new.created_at = now();
    if auth.uid() is not null then new.created_by = auth.uid(); new.created_name = public.my_name(); end if;
    return new;
  end if;
  -- only the label changes afterwards
  new.id = old.id; new.job_id = old.job_id; new.shift_date = old.shift_date; new.path = old.path; new.size = old.size;
  new.created_at = old.created_at; new.created_by = old.created_by; new.created_name = old.created_name;
  return new;
end; $$;
drop trigger if exists job_photos_rules on public.job_photos;
create trigger job_photos_rules before insert or update on public.job_photos for each row execute function public.job_photo_rules();

alter table public.job_photos enable row level security;
grant select, insert, update, delete on public.job_photos to authenticated;
drop policy if exists "supervisors and up read" on public.job_photos;
create policy "supervisors and up read" on public.job_photos for select to authenticated using (public.photos_can());
drop policy if exists "supervisors and up add" on public.job_photos;
create policy "supervisors and up add" on public.job_photos for insert to authenticated with check (public.photos_can());
drop policy if exists "relabel own or administrators" on public.job_photos;
create policy "relabel own or administrators" on public.job_photos for update to authenticated
  using (public.photos_is_manager() or (public.photos_can() and created_by = auth.uid())) with check (public.photos_can());
drop policy if exists "remove own or administrators" on public.job_photos;
create policy "remove own or administrators" on public.job_photos for delete to authenticated
  using (public.photos_is_manager() or (public.photos_can() and created_by = auth.uid()));

-- the file store (Supabase Storage bucket "jobphotos", private): jobs/<job id>/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jobphotos', 'jobphotos', false, 15728640, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "job photos: read" on storage.objects;
create policy "job photos: read" on storage.objects for select to authenticated using (bucket_id = 'jobphotos' and public.photos_can());
drop policy if exists "job photos: add" on storage.objects;
create policy "job photos: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'jobphotos' and (storage.foldername(name))[1] = 'jobs' and public.photos_can());
drop policy if exists "job photos: remove" on storage.objects;
create policy "job photos: remove" on storage.objects for delete to authenticated using (bucket_id = 'jobphotos' and public.photos_can());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_photos') then
    alter publication supabase_realtime add table public.job_photos;
  end if;
end $$;

-- make the API see the new columns straight away
notify pgrst, 'reload schema';
