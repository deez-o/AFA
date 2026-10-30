-- FraserFlow Fleet & Maintenance: database (Phase 3: digital prestarts)
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql and maintenance.sql.
-- Safe to run again. It only adds tables, rules and a file store; roster data in `items` is not changed.
--
-- Prestart checklists are kept per machine category. Changing a checklist saves a new version, so an old
-- prestart always shows the exact questions that operator answered. A submitted prestart is permanent:
-- nobody can change or delete it, administrators included.

-- 1. Logins linked to Staff records ----------------------------------------------
--    Each operator signs in as themselves; their login points at their Staff record, so a prestart
--    carries the operator's name from the roster.
alter table public.profiles add column if not exists staff_id text;
create unique index if not exists profiles_one_login_per_staff on public.profiles (staff_id) where staff_id is not null;

-- role changes: nobody changes their own role, and only the admin gives or takes away the admin role
-- (superusers can manage everyone else). Changes made in the SQL Editor are not limited.
create or replace function public.profile_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  new.id = old.id; new.email = old.email; new.created_at = old.created_at;
  if new.role is distinct from old.role then
    if old.id = auth.uid() then
      raise exception 'You can''t change your own role' using errcode = '42501';
    end if;
    if (new.role = 'admin' or old.role = 'admin') and public.my_role() <> 'admin' then
      raise exception 'Only the administrator can give or remove the admin role' using errcode = '42501';
    end if;
  end if;
  if new.staff_id is not null and new.staff_id is distinct from old.staff_id and not exists (
    select 1 from public.items where kind = 'resource' and id = new.staff_id and data->>'type' = 'person'
  ) then
    raise exception 'No staff member with id % on the roster', new.staff_id using errcode = '23503';
  end if;
  return new;
end; $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute function public.profile_guard();

-- the signed-in person's name: their Staff record if linked, otherwise their email
create or replace function public.my_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select i.data->>'name' from public.items i where i.kind = 'resource' and i.id = p.staff_id), p.email)
  from public.profiles p where p.id = auth.uid()
$$;

-- who may fill in a prestart: everyone signed in except viewers
create or replace function public.maint_can_prestart()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin','superuser','planner','supervisor','mechanic','operator'), false)
$$;

-- 2. Prestart checklists (one per machine category, versioned) -------------------
--    items: [{ "key": "tyres", "section": "Walk-around", "text": "Tyres / tracks OK", "kind": "check"|"number"|"text", "critical": true }]
--    A checklist with no category covers every machine whose category has no checklist of its own.
create table if not exists public.prestart_templates (
  id             uuid primary key default gen_random_uuid(),
  family         uuid not null,
  version        int not null,
  name           text not null,
  category       text,
  items          jsonb not null,
  active         boolean not null default true,
  superseded_at  timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  unique (family, version)
);
-- one checklist in use per category (and one for "all other machines")
create unique index if not exists prestart_templates_one_active on public.prestart_templates (lower(btrim(coalesce(category, '')))) where active;

create or replace function public.prestart_template_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare it jsonb; keys text[] := '{}'; k text;
begin
  if tg_op = 'UPDATE' then
    -- a saved version never changes: only taking it out of use (or back into use) is allowed
    if new.family <> old.family or new.version <> old.version or new.name <> old.name
       or new.category is distinct from old.category or new.items <> old.items
       or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
      raise exception 'A saved checklist can''t be changed. Save a new version instead.' using errcode = '42501';
    end if;
    if new.active and not old.active and exists (select 1 from public.prestart_templates where family = old.family and version > old.version) then
      raise exception 'Only the newest version of a checklist can be put back into use' using errcode = '22023';
    end if;
    new.superseded_at = case when new.active then null
                             when auth.uid() is null then coalesce(new.superseded_at, now())   -- SQL Editor
                             else coalesce(old.superseded_at, now()) end;
    return new;
  end if;
  -- a new checklist, or a new version of one
  new.created_by = auth.uid(); new.created_at = now(); new.active = true; new.superseded_at = null;
  new.category = nullif(btrim(new.category), '');
  new.name = btrim(new.name);
  if new.name = '' then raise exception 'Name the checklist' using errcode = '22023'; end if;
  if jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 then
    raise exception 'A checklist needs at least one question' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(new.items) loop
    k := btrim(coalesce(it->>'key', ''));
    if k = '' or btrim(coalesce(it->>'text', '')) = '' then raise exception 'Every question needs its wording' using errcode = '22023'; end if;
    if k = any(keys) then raise exception 'Two questions share the key %', k using errcode = '22023'; end if;
    if coalesce(it->>'kind', 'check') not in ('check','number','text') then raise exception 'Unknown question type %', it->>'kind' using errcode = '22023'; end if;
    keys := keys || k;
  end loop;
  if exists (select 1 from public.prestart_templates where active and family is distinct from new.family
             and lower(coalesce(category, '')) = lower(coalesce(new.category, ''))) then
    raise exception '%', case when new.category is null then 'There is already a checklist for all other machines. Edit that one instead.'
                              else 'There is already a checklist for ' || new.category || '. Edit that one instead.' end using errcode = '23505';
  end if;
  if new.family is null then
    new.family = new.id; new.version = 1;
  else
    if not exists (select 1 from public.prestart_templates where family = new.family) then
      raise exception 'No checklist to make a new version of' using errcode = '23503';
    end if;
    select max(version) + 1 into new.version from public.prestart_templates where family = new.family;
    -- the older versions go out of use; their answers stay readable
    update public.prestart_templates set active = false where family = new.family and active;
  end if;
  return new;
end; $$;
drop trigger if exists prestart_templates_rules on public.prestart_templates;
create trigger prestart_templates_rules before insert or update on public.prestart_templates for each row execute function public.prestart_template_rules();

-- 3. Prestarts (permanent once submitted) -------------------------------------------
create table if not exists public.prestarts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null unique,         -- made on the phone: sending twice never makes two prestarts
  asset_id       text not null,
  template_id    uuid not null references public.prestart_templates(id),
  operator       uuid not null,
  staff_id       text,
  operator_name  text not null,
  started_at     timestamptz,
  submitted_at   timestamptz not null default now(),
  hours          numeric check (hours is null or hours >= 0),
  km             numeric check (km is null or km >= 0),
  meter_note     text,                          -- why a meter reading wasn't saved, if it wasn't
  location       text,
  result         text not null check (result in ('pass','defects','unsafe')),
  failed         int not null default 0,
  notes          text,
  signature      text not null                  -- the signature picture, in the file store
);
create index if not exists prestarts_asset on public.prestarts (asset_id, submitted_at desc);
create index if not exists prestarts_operator on public.prestarts (operator, submitted_at desc);

create table if not exists public.prestart_answers (
  id           bigint generated always as identity primary key,
  prestart_id  uuid not null references public.prestarts(id),
  pos          int not null,
  item_key     text not null,
  section      text,
  question     text not null,
  kind         text not null,
  critical     boolean not null default false,
  answer       text not null,                   -- pass, fail or na; or the number / text entered
  comment      text,
  photos       text[] not null default '{}',
  unique (prestart_id, item_key)
);

create or replace function public.prestart_locked()
returns trigger language plpgsql as $$
begin
  -- the one way out: the administrator deleting a prestart with delete_prestart() (below), which records why
  if tg_op = 'DELETE' and coalesce(current_setting('fraserflow.prestart_delete', true), '') = 'on' then return old; end if;
  raise exception 'A submitted prestart can''t be changed or deleted' using errcode = '42501';
end; $$;
drop trigger if exists prestarts_locked on public.prestarts;
create trigger prestarts_locked before update or delete on public.prestarts for each row execute function public.prestart_locked();
drop trigger if exists prestart_answers_locked on public.prestart_answers;
create trigger prestart_answers_locked before update or delete on public.prestart_answers for each row execute function public.prestart_locked();
drop trigger if exists prestarts_asset on public.prestarts;
create trigger prestarts_asset before insert on public.prestarts for each row execute function public.maint_check_asset();

-- the file store holds the photos and signature; they must be the operator's own uploads
create or replace function public.prestart_file_ok(path text)
returns boolean language sql stable security definer set search_path = public as $$
  select path like 'prestarts/' || auth.uid()::text || '/%'
     and exists (select 1 from storage.objects o where o.bucket_id = 'maintenance' and o.name = path)
$$;

-- the checklist that applies to a machine: its category's, else the one for all other machines
create or replace function public.prestart_template_for(asset text)
returns uuid language sql stable security definer set search_path = public as $$
  select t.id from public.prestart_templates t
   where t.active and (lower(btrim(coalesce(t.category, ''))) = lower(btrim(coalesce(
           (select i.data->>'category' from public.items i where i.kind = 'resource' and i.id = asset), ''))) or t.category is null)
   order by (t.category is null) limit 1
$$;

-- submit a prestart: checked and saved in one go, together with its meter readings
-- p = { client_id, asset_id, template_id, started_at, hours, km, location, notes, signature,
--       answers: { "<key>": { "answer": "pass"|"fail"|"na"|"<value>", "comment": "...", "photos": ["prestarts/<uid>/..."] } } }
create or replace function public.submit_prestart(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); pid uuid; t public.prestart_templates; cur uuid; it jsonb; a jsonb; ans text; cmt text; ph text[];
  i int := 0; nfail int := 0; ncrit int := 0; res text; mt text; mach jsonb; note text := null; prof public.profiles;
  hrs numeric; kms numeric; ph1 text;
begin
  if me is null or not public.maint_can_prestart() then
    raise exception 'You don''t have access to fill in prestarts' using errcode = '42501';
  end if;
  if coalesce(p->>'client_id', '') !~ '^[0-9a-fA-F-]{36}$' then raise exception 'The prestart is missing its id' using errcode = '22023'; end if;
  -- sent again (a retry after a dropped connection): the first copy stands
  select id into pid from public.prestarts where client_id = (p->>'client_id')::uuid;
  if pid is not null then
    if (select operator from public.prestarts where id = pid) <> me then raise exception 'That prestart belongs to someone else' using errcode = '42501'; end if;
    return (select jsonb_build_object('id', id, 'result', result, 'meter_note', meter_note, 'again', true) from public.prestarts where id = pid);
  end if;
  select data into mach from public.items where kind = 'resource' and id = p->>'asset_id' and data->>'type' = 'machine';
  if mach is null then raise exception 'No machine with id % on the roster', p->>'asset_id' using errcode = '23503'; end if;
  if exists (select 1 from public.asset_profiles where asset_id = p->>'asset_id' and retired) then
    raise exception 'This machine is retired' using errcode = '22023';
  end if;
  -- the checklist must be the one in use for this machine (or the version it replaced in the last 12 hours,
  -- so a change in the office doesn't throw away a prestart being filled in)
  select * into t from public.prestart_templates where id = (p->>'template_id')::uuid;
  cur := public.prestart_template_for(p->>'asset_id');
  if t.id is null or cur is null or not (t.id = cur or (t.family = (select family from public.prestart_templates where id = cur) and t.superseded_at > now() - interval '12 hours')) then
    raise exception 'This checklist is no longer in use for this machine. Start the prestart again.' using errcode = '22023';
  end if;
  -- meters
  hrs := nullif(p->>'hours', '')::numeric; kms := nullif(p->>'km', '')::numeric;
  select meter_type into mt from public.asset_profiles where asset_id = p->>'asset_id';
  mt := coalesce(mt, case when concat_ws(' ', mach->>'category', mach->>'name', mach->>'sub') ~* 'truck' then 'both' else 'hours' end);
  if mt in ('hours','both') and hrs is null then raise exception 'Enter the engine hours' using errcode = '22023'; end if;
  if mt in ('km','both') and kms is null then raise exception 'Enter the odometer km' using errcode = '22023'; end if;
  -- signature
  if not public.prestart_file_ok(p->>'signature') then raise exception 'Sign the prestart before submitting' using errcode = '22023'; end if;
  -- every question answered; a failed check needs a comment
  for it in select * from jsonb_array_elements(t.items) loop
    a := coalesce(p->'answers'->(it->>'key'), '{}'::jsonb);
    ans := btrim(coalesce(a->>'answer', '')); cmt := nullif(btrim(coalesce(a->>'comment', '')), '');
    if coalesce(it->>'kind', 'check') = 'check' then
      if ans not in ('pass','fail','na') then raise exception 'Answer every question: "%" is missing', it->>'text' using errcode = '22023'; end if;
      if ans = 'fail' and cmt is null then raise exception 'Say what is wrong for "%"', it->>'text' using errcode = '22023'; end if;
      if ans = 'fail' then nfail := nfail + 1; if coalesce((it->>'critical')::boolean, false) then ncrit := ncrit + 1; end if; end if;
    elsif it->>'kind' = 'number' then
      if ans !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception 'Enter a number for "%"', it->>'text' using errcode = '22023'; end if;
    end if;
    ph := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(a->'photos', '[]'::jsonb)) x), '{}');
    foreach ph1 in array ph loop
      if not public.prestart_file_ok(ph1) then raise exception 'A photo for "%" didn''t finish uploading. Take it again.', it->>'text' using errcode = '22023'; end if;
    end loop;
  end loop;
  res := case when ncrit > 0 then 'unsafe' when nfail > 0 then 'defects' else 'pass' end;
  select * into prof from public.profiles where id = me;
  -- meter readings (a reading that goes backwards is noted on the prestart instead of stopping it)
  if hrs is not null and mt in ('hours','both') then
    begin
      insert into public.meter_readings (asset_id, kind, value, source, note) values (p->>'asset_id', 'hours', hrs, 'prestart', 'Prestart by ' || public.my_name());
    exception when others then note := 'Hours not saved: ' || sqlerrm;
    end;
  end if;
  if kms is not null and mt in ('km','both') then
    begin
      insert into public.meter_readings (asset_id, kind, value, source, note) values (p->>'asset_id', 'km', kms, 'prestart', 'Prestart by ' || public.my_name());
    exception when others then note := concat_ws('. ', note, 'Km not saved: ' || sqlerrm);
    end;
  end if;
  insert into public.prestarts (client_id, asset_id, template_id, operator, staff_id, operator_name, started_at, submitted_at, hours, km, meter_note, location, result, failed, notes, signature)
  values ((p->>'client_id')::uuid, p->>'asset_id', t.id, me, prof.staff_id, public.my_name(),
          least(coalesce(nullif(p->>'started_at', '')::timestamptz, now()), now()), now(),
          case when mt in ('hours','both') then hrs end, case when mt in ('km','both') then kms end, note,
          nullif(btrim(coalesce(p->>'location', '')), ''), res, nfail, nullif(btrim(coalesce(p->>'notes', '')), ''), p->>'signature')
  returning id into pid;
  for it in select * from jsonb_array_elements(t.items) loop
    i := i + 1;
    a := coalesce(p->'answers'->(it->>'key'), '{}'::jsonb);
    insert into public.prestart_answers (prestart_id, pos, item_key, section, question, kind, critical, answer, comment, photos)
    values (pid, i, it->>'key', nullif(btrim(coalesce(it->>'section', '')), ''), it->>'text', coalesce(it->>'kind', 'check'),
            coalesce((it->>'critical')::boolean, false), btrim(coalesce(a->>'answer', '')), nullif(btrim(coalesce(a->>'comment', '')), ''),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(a->'photos', '[]'::jsonb)) x), '{}'));
  end loop;
  return jsonb_build_object('id', pid, 'result', res, 'meter_note', note, 'again', false);
end; $$;
revoke all on function public.submit_prestart(jsonb) from public, anon;
grant execute on function public.submit_prestart(jsonb) to authenticated;

-- the administrator (only) can delete a prestart, e.g. a test one. A reason is required, and a full copy of the
-- prestart and its answers is kept in the audit trail. Its photos, signature and meter readings stay.
create or replace function public.delete_prestart(pid uuid, reason text)
returns void language plpgsql security definer set search_path = public as $$
declare ps jsonb;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'Only the administrator can delete a prestart' using errcode = '42501';
  end if;
  if btrim(coalesce(reason, '')) = '' then raise exception 'Say why the prestart is being deleted' using errcode = '22023'; end if;
  select to_jsonb(p) || jsonb_build_object('answers', coalesce((select jsonb_agg(to_jsonb(a) order by a.pos) from public.prestart_answers a where a.prestart_id = p.id), '[]'::jsonb))
    into ps from public.prestarts p where p.id = pid;
  if ps is null then raise exception 'That prestart doesn''t exist' using errcode = '23503'; end if;
  insert into public.maintenance_audit (tbl, row_id, action, old, new)
  values ('prestarts', pid::text, 'delete (administrator)', ps, jsonb_build_object('reason', btrim(reason)));
  perform set_config('fraserflow.prestart_delete', 'on', true);
  delete from public.prestart_answers where prestart_id = pid;
  delete from public.prestarts where id = pid;
  perform set_config('fraserflow.prestart_delete', '', true);
end; $$;
revoke all on function public.delete_prestart(uuid, text) from public, anon;
grant execute on function public.delete_prestart(uuid, text) to authenticated;

-- 4. Manuals and documents for a machine (files in the file store) -----------------
create table if not exists public.maintenance_files (
  id          uuid primary key default gen_random_uuid(),
  asset_id    text not null,
  kind        text not null default 'manual' check (kind in ('manual','document','photo')),
  name        text not null,
  path        text not null unique,
  mime        text,
  size        bigint,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  constraint maintenance_files_path check (path like 'assets/' || asset_id || '/%')
);
create index if not exists maintenance_files_asset on public.maintenance_files (asset_id);
drop trigger if exists maintenance_files_asset on public.maintenance_files;
create trigger maintenance_files_asset before insert on public.maintenance_files for each row execute function public.maint_check_asset();

-- 5. The file store (Supabase Storage bucket "maintenance", private) ----------------
--    prestarts/<login id>/...   photos and signatures: added by the operator, never changed or removed
--    assets/<machine id>/...    manuals and documents: added by maintenance staff, removed by administrators
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('maintenance', 'maintenance', false, 15728640, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "maintenance files: signed-in people read" on storage.objects;
create policy "maintenance files: signed-in people read" on storage.objects for select to authenticated
  using (bucket_id = 'maintenance');
drop policy if exists "maintenance files: add" on storage.objects;
create policy "maintenance files: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'maintenance' and (
    ((storage.foldername(name))[1] = 'prestarts' and (storage.foldername(name))[2] = auth.uid()::text and public.maint_can_prestart())
    or ((storage.foldername(name))[1] = 'assets' and public.maint_can_work())));
drop policy if exists "maintenance files: administrators remove documents" on storage.objects;
create policy "maintenance files: administrators remove documents" on storage.objects for delete to authenticated
  using (bucket_id = 'maintenance' and (storage.foldername(name))[1] = 'assets' and public.maint_is_manager());

-- 6. Audit, access rules and live updates --------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['prestart_templates','prestarts','maintenance_files'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.maint_audit()', t, t);
  end loop;
end $$;

alter table public.prestart_templates enable row level security;
alter table public.prestarts          enable row level security;
alter table public.prestart_answers   enable row level security;
alter table public.maintenance_files  enable row level security;

grant select, insert, update on public.prestart_templates to authenticated;
grant select on public.prestarts, public.prestart_answers to authenticated;   -- added only through submit_prestart()
grant select, insert, delete on public.maintenance_files to authenticated;

do $$
declare t text;
begin
  foreach t in array array['prestart_templates','prestarts','prestart_answers','maintenance_files'] loop
    execute format('drop policy if exists "signed-in people read" on public.%I', t);
    execute format('create policy "signed-in people read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;
drop policy if exists "administrators add" on public.prestart_templates;
create policy "administrators add" on public.prestart_templates for insert to authenticated with check (public.maint_is_manager());
drop policy if exists "administrators change" on public.prestart_templates;
create policy "administrators change" on public.prestart_templates for update to authenticated using (public.maint_is_manager()) with check (public.maint_is_manager());
drop policy if exists "maintenance staff add" on public.maintenance_files;
create policy "maintenance staff add" on public.maintenance_files for insert to authenticated with check (public.maint_can_work());
drop policy if exists "administrators remove" on public.maintenance_files;
create policy "administrators remove" on public.maintenance_files for delete to authenticated using (public.maint_is_manager());

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['prestart_templates','prestarts','maintenance_files'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
