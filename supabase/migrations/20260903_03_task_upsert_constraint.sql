-- Make one-task-per-message usable by upsert.
--
-- 20260902_01 created this as a PARTIAL index:
--
--   create unique index tt_tasks_one_per_message on tt_tasks (message_id)
--     where message_id is not null;
--
-- which is correct as a constraint and useless as an ON CONFLICT target.
-- Postgres will only infer a partial index if the statement repeats its
-- predicate (`on conflict (message_id) where message_id is not null`), and
-- PostgREST's `onConflict=` emits the column list alone. The worker therefore
-- failed every insert with:
--
--   there is no unique or exclusion constraint matching the ON CONFLICT
--   specification
--
-- A plain unique index does the same job here, because Postgres treats NULLs
-- as distinct in a unique index: many hand-added tasks (message_id null) can
-- coexist, while any one message still maps to at most one task. That is
-- exactly the guarantee the worker relies on when it inserts the task before
-- marking the message classified.

drop index if exists public.tt_tasks_one_per_message;

create unique index if not exists tt_tasks_one_per_message
  on public.tt_tasks (message_id);

notify pgrst, 'reload schema';
