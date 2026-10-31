-- FraserFlow: service plans with several intervals (e.g. 250 / 500 / 750 / 1000 hours), each with its own notes,
-- and plans that cover several machine categories.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after maintenance.sql.
-- Safe to run again. It only adds a column; existing plans keep working as they are.

alter table public.service_plans add column if not exists intervals jsonb;
alter table public.service_plans drop constraint if exists service_plans_intervals;
alter table public.service_plans add constraint service_plans_intervals check (intervals is null or jsonb_typeof(intervals) = 'array');

-- several machine categories on one plan (category stays the first of them)
alter table public.service_plans add column if not exists categories text[];


-- several hand-picked machines on one plan (e.g. a yearly COI inspection for every truck that needs one).
-- A plan covers exactly one of: a machine category (or several), one machine, or a list of machines.
alter table public.service_plans add column if not exists asset_ids text[];
alter table public.service_plans drop constraint if exists service_plans_scope;
alter table public.service_plans add constraint service_plans_scope check (
  (category is not null)::int + (asset_id is not null)::int + (coalesce(cardinality(asset_ids), 0) > 0)::int = 1);

-- COI inspection plans made one per truck: bundle them into one plan for all of those machines (safe to run again)
do $$
declare keep uuid; ids text[]; old uuid[];
begin
  select array_agg(id), array_agg(distinct asset_id) into old, ids from public.service_plans where asset_id is not null and name ilike 'COI%';
  if old is null then return; end if;
  select id into keep from public.service_plans where asset_ids is not null and name ilike 'COI%' order by created_at limit 1;
  if keep is null then
    insert into public.service_plans (name, asset_ids, every_days, warn_days) values ('COI inspection', ids, 365, 30) returning id into keep;
  else
    update public.service_plans set asset_ids = (select array_agg(distinct x) from unnest(asset_ids || ids) x) where id = keep;
  end if;
  update public.service_records set plan_id = keep where plan_id = any(old);
  update public.work_orders set plan_id = keep where plan_id = any(old);
  delete from public.service_plans where id = any(old);
end $$;

notify pgrst, 'reload schema';
