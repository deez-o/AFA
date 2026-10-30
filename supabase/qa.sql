-- FraserFlow: site QA packs (the JSA, and an optional toolbox meeting), one per booking shift.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql and prestarts.sql.
-- Safe to run again. It only adds tables and rules; roster data in `items` is not changed.
--
-- A supervisor fills the pack in on their phone for a crew's shift; everyone on the crew signs it on their
-- own phone (a drawn signature, recorded against their login), and visitors or subbies sign on the
-- supervisor's phone. Once submitted, a pack is locked: only an administrator or superuser can reopen it.

-- 1. Who may fill in a pack: supervisors, planners and administrators (operators only sign) --------------
create or replace function public.qa_can_fill()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser','planner','supervisor'), false)
$$;
create or replace function public.qa_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser'), false)
$$;

-- 2. Packs: per booking (block) and shift date; a shift can have more than one (e.g. a second work area) ----
--    jsa: { head:{...}, type:'asphalt'|'seal', ticks:{...}, quality:{...}, extra:[{hazard,risk,controls,residual}], checks:{...}, comms:{...} }
--    toolbox: null until a toolbox meeting is added; then { location, whs_rep, supervisor, manager, topics:[{topic,action,date,who}], training, meeting_point }
create table if not exists public.qa_packs (
  id             uuid primary key,              -- made on the phone, so a pack started without reception keeps its id
  block_id       text not null,
  shift_date     date not null,
  job_id         text,
  crew_id        text,
  status         text not null default 'draft' check (status in ('draft','submitted')),
  jsa            jsonb not null default '{}'::jsonb,
  toolbox        jsonb,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  submitted_at   timestamptz,
  submitted_by   uuid,
  submitted_name text
);
alter table public.qa_packs add column if not exists label text;
-- the rest of the QA pack, each form added when it's needed: { lot:{...}, aqr, hold, diagram, laying, env, costs }
alter table public.qa_packs add column if not exists forms jsonb not null default '{}'::jsonb;   -- e.g. "Second work area"; the first pack usually has none
alter table public.qa_packs drop constraint if exists qa_packs_block_id_shift_date_key;   -- (an earlier version allowed one pack per shift)
create index if not exists qa_packs_date on public.qa_packs (shift_date);
create index if not exists qa_packs_shift on public.qa_packs (block_id, shift_date);
create index if not exists qa_packs_job on public.qa_packs (job_id);

create or replace function public.qa_pack_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.id = old.id; new.block_id = old.block_id; new.shift_date = old.shift_date;
    new.created_at = old.created_at; new.created_by = old.created_by;
    if old.status = 'submitted' and auth.uid() is not null and not public.qa_is_manager() then
      raise exception 'This QA pack has been submitted. An administrator can reopen it.' using errcode = '42501';
    end if;
  else
    new.created_at = now(); new.created_by = auth.uid();
  end if;
  new.updated_at = now(); new.updated_by = auth.uid();
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status <> 'submitted') then
    new.submitted_at = now(); new.submitted_by = auth.uid(); new.submitted_name = public.my_name();
  elsif new.status = 'draft' then
    new.submitted_at = null; new.submitted_by = null; new.submitted_name = null;
  end if;
  return new;
end; $$;
drop trigger if exists qa_packs_rules on public.qa_packs;
create trigger qa_packs_rules before insert or update on public.qa_packs for each row execute function public.qa_pack_rules();

-- 3. Signatures ----------------------------------------------------------------------------------------
--    Your own signature carries your name from the roster (it can't be signed in someone else's name).
--    A visitor's signature (no login) is added by the person filling in the pack.
create table if not exists public.qa_signatures (
  id         uuid primary key,                 -- made on the phone (signing works without reception)
  pack_id    uuid not null references public.qa_packs(id) on delete cascade,
  form       text not null,
  user_id    uuid,
  name       text not null,
  company    text,
  signature  text not null check (signature like 'data:image/png;base64,%' and length(signature) < 400000),
  signed_at  timestamptz not null default now(),
  added_by   uuid default auth.uid()
);
-- which form a signature is on: jsa, toolbox, aqr_afa, aqr_client, hold_afa, hold_client, env, laying, diagram …
alter table public.qa_signatures drop constraint if exists qa_signatures_form_check;
alter table public.qa_signatures add constraint qa_signatures_form_check check (form ~ '^[a-z][a-z_]{1,29}$');
create unique index if not exists qa_signatures_once on public.qa_signatures (pack_id, form, user_id) where user_id is not null;
create index if not exists qa_signatures_pack on public.qa_signatures (pack_id);

create or replace function public.qa_signature_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from public.qa_packs where id = coalesce(new.pack_id, old.pack_id);
  if st = 'submitted' and auth.uid() is not null and not public.qa_is_manager() then
    raise exception 'This QA pack has been submitted, so its signatures can''t change' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.added_by = auth.uid();
  if auth.uid() is not null then
    if new.user_id is not null and new.user_id <> auth.uid() then
      raise exception 'You can only sign as yourself' using errcode = '42501';
    end if;
    if new.user_id is null and not public.qa_can_fill() then
      raise exception 'Only the person filling in the pack can add a visitor''s signature' using errcode = '42501';
    end if;
    if new.user_id is not null then new.name = public.my_name(); end if;
  end if;
  -- signed without reception: keep the time it was signed (up to a week back), never a time in the future
  if new.signed_at is null or new.signed_at > now() + interval '5 minutes' or new.signed_at < now() - interval '7 days' then
    new.signed_at = now();
  end if;
  new.company = coalesce(nullif(trim(new.company), ''), 'Alex Fraser Asphalt');
  return new;
end; $$;
drop trigger if exists qa_signatures_rules on public.qa_signatures;
create trigger qa_signatures_rules before insert or delete on public.qa_signatures for each row execute function public.qa_signature_rules();

-- 4. Who can see and change what -------------------------------------------------------------------------
alter table public.qa_packs enable row level security;
alter table public.qa_signatures enable row level security;
grant select, insert, update, delete on public.qa_packs, public.qa_signatures to authenticated;

drop policy if exists "signed-in people read" on public.qa_packs;
create policy "signed-in people read" on public.qa_packs for select to authenticated using (true);
drop policy if exists "supervisors fill in" on public.qa_packs;
create policy "supervisors fill in" on public.qa_packs for insert to authenticated with check (public.qa_can_fill());
drop policy if exists "supervisors change" on public.qa_packs;
create policy "supervisors change" on public.qa_packs for update to authenticated using (public.qa_can_fill()) with check (public.qa_can_fill());
drop policy if exists "administrators remove" on public.qa_packs;
drop policy if exists "remove a pack" on public.qa_packs;
-- a pack still in progress can be deleted by whoever fills packs in; a submitted one only by an administrator or superuser
create policy "remove a pack" on public.qa_packs for delete to authenticated using (public.qa_is_manager() or (public.qa_can_fill() and status = 'draft'));

drop policy if exists "signed-in people read" on public.qa_signatures;
create policy "signed-in people read" on public.qa_signatures for select to authenticated using (true);
drop policy if exists "sign" on public.qa_signatures;
create policy "sign" on public.qa_signatures for insert to authenticated with check (user_id = auth.uid() or (user_id is null and public.qa_can_fill()));
drop policy if exists "take back a signature" on public.qa_signatures;
create policy "take back a signature" on public.qa_signatures for delete to authenticated using (user_id = auth.uid() or public.qa_can_fill());

-- 5. Live updates (the supervisor sees signatures arrive) ---------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['qa_packs','qa_signatures'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
