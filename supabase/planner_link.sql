-- FraserFlow Fleet & Maintenance: database (Phase 5: the planner link)
-- Run once in Supabase → SQL Editor → New query → paste → Run, after schema.sql, maintenance.sql, prestarts.sql
-- and defects.sql. Safe to run again. Roster data in `items` is not changed.
--
-- 1. A restricted machine (a critical defect, or taken out of service by an administrator) can't be ADDED to a
--    booking (its Machines tab) or a job plan (Machines needed), from any screen. Bookings and plans that already
--    had it keep it, so nothing in the roster breaks: the app flags them instead.
-- 2. machine_alerts: one row per machine with what the planner should know (restricted, open defects,
--    service overdue or due soon), so the booking and planning screens can warn without loading all of maintenance.

-- 1. No restricted machine added to a booking or plan --------------------------------------
create or replace function public.items_no_restricted_machines()
returns trigger language plpgsql security definer set search_path = public as $$
declare key text; added text[]; bad text;
begin
  if new.kind = 'block' then key := 'plantIds';
  elsif new.kind = 'plan' then key := 'machineIds';
  else return new; end if;
  select coalesce(array_agg(x), '{}') into added
    from jsonb_array_elements_text(case when jsonb_typeof(new.data->key) = 'array' then new.data->key else '[]'::jsonb end) x
   where tg_op = 'INSERT' or not (coalesce(old.data->key, '[]'::jsonb) ? x);
  if array_length(added, 1) is null then return new; end if;
  select string_agg(coalesce(i.data->>'name', r.asset_id) || ' (' || r.reason || ')', '; ') into bad
    from public.restrictions r left join public.items i on i.kind = 'resource' and i.id = r.asset_id
   where r.active and r.asset_id = any(added);
  if bad is not null then
    raise exception 'Restricted machine: do not use. % can''t be added to a booking or plan until it is returned to service.', bad using errcode = '23514';
  end if;
  return new;
end; $$;
drop trigger if exists items_no_restricted_machines on public.items;
create trigger items_no_restricted_machines before insert or update on public.items
  for each row when (new.kind in ('block','plan')) execute function public.items_no_restricted_machines();

-- 2. What the planner should know about each machine ------------------------------------------
--    service: 'overdue' or 'soon', worked out the same way as the Fleet dashboard
--    (by hours, km or days from the last service on each plan; whichever comes first)
create or replace view public.machine_alerts with (security_invoker = true) as
with m as (
  select i.id as asset_id, i.data->>'name' as name, lower(btrim(coalesce(i.data->>'category', ''))) as cat,
         coalesce((select p.meter_type from public.asset_profiles p where p.asset_id = i.id),
                  case when concat_ws(' ', i.data->>'category', i.data->>'name', i.data->>'sub') ~* 'truck' then 'both' else 'hours' end) as mt,
         coalesce((select p.retired from public.asset_profiles p where p.asset_id = i.id), false) as retired
    from public.items i where i.kind = 'resource' and i.data->>'type' = 'machine'
), cur as (
  select m.*,
         (select r.value from public.meter_readings r where r.asset_id = m.asset_id and r.kind = 'hours' order by r.read_at desc, r.created_at desc limit 1) as hrs,
         (select r.value from public.meter_readings r where r.asset_id = m.asset_id and r.kind = 'km' order by r.read_at desc, r.created_at desc limit 1) as kms
    from m
), parts as (
  select c.asset_id, sp.name as plan_name,
         case when sp.every_hours is not null and c.mt <> 'km' and l.hours is not null and c.hrs is not null then l.hours + sp.every_hours - c.hrs end as left_h, sp.warn_hours,
         case when sp.every_km is not null and c.mt <> 'hours' and l.km is not null and c.kms is not null then l.km + sp.every_km - c.kms end as left_km, sp.warn_km,
         case when sp.every_days is not null then (l.done_on + sp.every_days) - (now() at time zone 'Australia/Brisbane')::date end as left_d, sp.warn_days
    from cur c
    join public.service_plans sp on sp.active and (sp.asset_id = c.asset_id or (sp.category is not null and lower(btrim(sp.category)) = c.cat))
    cross join lateral (select r.done_on, r.hours, r.km from public.service_records r where r.asset_id = c.asset_id and r.plan_id = sp.id
                        order by r.done_on desc, r.created_at desc limit 1) l
), svc as (
  select asset_id,
         string_agg(plan_name, ', ') filter (where left_h <= 0 or left_km <= 0 or left_d <= 0) as overdue,
         string_agg(plan_name, ', ') filter (where not (coalesce(left_h <= 0, false) or coalesce(left_km <= 0, false) or coalesce(left_d <= 0, false))
                                           and ((left_h > 0 and left_h <= warn_hours) or (left_km > 0 and left_km <= warn_km) or (left_d > 0 and left_d <= warn_days))) as soon
    from parts group by asset_id
)
select m.asset_id, m.name,
       exists (select 1 from public.restrictions r where r.asset_id = m.asset_id and r.active) as restricted,
       (select string_agg(r.reason, '; ' order by r.created_at) from public.restrictions r where r.asset_id = m.asset_id and r.active) as restriction,
       (select count(*) from public.defects d where d.asset_id = m.asset_id and d.status not in ('closed','dismissed'))::int as open_defects,
       (select count(*) from public.defects d where d.asset_id = m.asset_id and d.status not in ('closed','dismissed') and d.severity = 'critical')::int as critical_defects,
       case when s.overdue is not null then 'overdue' when s.soon is not null then 'soon' end as service,
       coalesce(s.overdue, s.soon) as service_plans
  from m left join svc s using (asset_id)
 where not m.retired;

revoke all on public.machine_alerts from anon;
grant select on public.machine_alerts to authenticated;
