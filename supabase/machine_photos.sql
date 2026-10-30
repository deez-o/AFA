-- FraserFlow: a photo of each machine, shown on its card in Fleet › Machines.
-- Kept in its own table so the photos only load when a machine's card is opened.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after maintenance.sql.
-- Safe to run again. It only adds a table and its rules; nothing else is changed.

create table if not exists public.asset_photos (
  asset_id    text primary key,
  photo       text not null check (photo like 'data:image/%' and length(photo) < 1500000),  -- a resized JPEG
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);

drop trigger if exists asset_photos_check on public.asset_photos;
create trigger asset_photos_check before insert on public.asset_photos for each row execute function public.maint_check_asset();
drop trigger if exists asset_photos_touch on public.asset_photos;
create trigger asset_photos_touch before insert or update on public.asset_photos for each row execute function public.maint_touch();

alter table public.asset_photos enable row level security;
grant select, insert, update, delete on public.asset_photos to authenticated;
drop policy if exists "signed-in people read" on public.asset_photos;
create policy "signed-in people read" on public.asset_photos for select to authenticated using (true);
drop policy if exists "maintenance staff add" on public.asset_photos;
create policy "maintenance staff add" on public.asset_photos for insert to authenticated with check (public.maint_can_work());
drop policy if exists "maintenance staff change" on public.asset_photos;
create policy "maintenance staff change" on public.asset_photos for update to authenticated using (public.maint_can_work()) with check (public.maint_can_work());
drop policy if exists "maintenance staff remove" on public.asset_photos;
create policy "maintenance staff remove" on public.asset_photos for delete to authenticated using (public.maint_can_work());
