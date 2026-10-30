-- FraserFlow: service plans with several intervals (e.g. 250 / 500 / 750 / 1000 hours), each with its own notes,
-- and plans that cover several machine categories.
-- Run once in Supabase → SQL Editor → New query → paste → Run, after maintenance.sql.
-- Safe to run again. It only adds a column; existing plans keep working as they are.

alter table public.service_plans add column if not exists intervals jsonb;
alter table public.service_plans drop constraint if exists service_plans_intervals;
alter table public.service_plans add constraint service_plans_intervals check (intervals is null or jsonb_typeof(intervals) = 'array');

-- several machine categories on one plan (category stays the first of them)
alter table public.service_plans add column if not exists categories text[];
