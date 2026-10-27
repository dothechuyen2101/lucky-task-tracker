-- Task Tracker — "Remind now", by hand, recorded with who sent it.
--
-- Lucky35's PO, 2026-10-07 (task 5): a button beside "Stop reminding" pings
-- the person a task is on at once — the usual reminder, or the reviewer's own
-- words — instead of waiting for the schedule. It counts in "Sent so far",
-- and it goes in the task's activity with who sent it and what it said: a
-- 'reminded' event, written by the route that sent it (the service role).

alter table public.tt_task_events drop constraint if exists tt_task_events_kind_check;

alter table public.tt_task_events
  add constraint tt_task_events_kind_check
  check (kind in ('created', 'changed', 'reminded'));

comment on column public.tt_task_events.kind is
  '''created'' and ''changed'' are written by the tt_tasks trigger; ''reminded'' by /api/tasks/remind — a reminder sent by hand: changes {to, message, ok, error}.';

notify pgrst, 'reload schema';
