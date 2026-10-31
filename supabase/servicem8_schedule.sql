-- FraserFlow ServiceM8 link: refresh every outstanding work order from ServiceM8 every 10 minutes,
-- whether or not anyone has FraserFlow open. (Vercel's free plan only allows a daily schedule; Supabase's doesn't limit it.)
--
-- Before running: replace PASTE-CRON_SECRET-HERE below with the CRON_SECRET you set in Vercel → Settings → Environment
-- Variables, and check the address is FraserFlow's. Then Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again (it replaces the schedule). To stop it:  select cron.unschedule('servicem8-refresh');
-- To see it run:  select * from cron.job_run_details order by start_time desc limit 10;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'servicem8-refresh';
select cron.schedule('servicem8-refresh', '*/10 * * * *', $job$
  select net.http_get(
    url := 'https://fraserflow.app/api/servicem8?cron=1&all=1',
    headers := jsonb_build_object('Authorization', 'Bearer PASTE-CRON_SECRET-HERE'),
    timeout_milliseconds := 60000
  );
$job$);
