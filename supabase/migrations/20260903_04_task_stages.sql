-- Progress stages on a task, matching the project manager's rail.
--
--   0 not started · 1 Started · 2 In progress · 3 Testing · 4 Completed · 5 Closed
--
-- Same ordinal semantics as vdm-project-manager's seven-stage rail: N means
-- stages 1..N are reached, clicking the stage you are on steps back, and the
-- machine NEVER guesses a stage — Erik's rule there, carried over here.
--
-- stage_at records when each stage was first reached, keyed by stage number,
-- and is trimmed when you step back so the record cannot claim you reached
-- something you later undid.
--
-- Note this does NOT replace `status`. They answer different questions:
--   stage   how far along the work is          (a rail you click)
--   status  open / done / dismissed            (what the reminder loop reads)
-- lib/stages.ts owns the one link between them: reaching Completed or Closed
-- marks the task done, because a finished task that still sends reminders is
-- the fastest way to lose trust in the tracker.

alter table public.tt_tasks
  add column if not exists stage    integer not null default 0
    check (stage between 0 and 5),
  add column if not exists stage_at jsonb   not null default '{}'::jsonb;

create index if not exists tt_tasks_stage_idx
  on public.tt_tasks (user_id, stage);

notify pgrst, 'reload schema';
