create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('task-tracker-tick')
where exists (select 1 from cron.job where jobname = 'task-tracker-tick');

select cron.schedule(
  'task-tracker-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url     := 'https://task-tracker-gilt-gamma.vercel.app/api/cron/tick',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_CRON_SECRET"}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);

select jobid, jobname, schedule, active from cron.job where jobname = 'task-tracker-tick';
