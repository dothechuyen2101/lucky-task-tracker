-- Record WHO set a task's deadline: the machine, or a human.
--
-- Erik reversed the deadlines-are-manual rule in session on 2026-09-07. The
-- classifier now writes `tt_tasks.deadline` directly, resolved from the
-- `suggested_deadline` it already produces, in the same tick that classifies
-- the message. It no longer merely proposes a date and waits for a click.
--
-- This SUPERSEDES the comment block at
-- supabase/migrations/20260902_01_task_tracker_core.sql:157-160, which still
-- reads "...but it never writes `deadline`". That migration is already applied.
-- An applied migration is history and must NOT be edited, so the reversal is
-- recorded here, in the migration that actually ships the change.
--
-- The deadline clause ONLY is reversed. The rest of that rule stands: the
-- machine fills the row, the human sets the clock for `stage` and for grading.
-- Nothing here touches either of those.
--
-- Why the provenance lives on the row rather than in the app: once a machine
-- may write the clock, "who set this" becomes load-bearing. A later pass that
-- resolves a fresh date must never overwrite a date a human chose, and the
-- board wants to say out loud when the date was set for you. Both readers need
-- the answer stored next to the deadline itself.
--
-- The default is 'manual', deliberately, and it fails safe in both directions:
--   * every deadline in the table today was set by a human -- the board's
--     picker, the "Use <date>" button, or an @bot deadline command -- so the
--     backfill of existing rows is correct by construction; and
--   * a write that omits the column while PostgREST's schema cache is still
--     stale lands as 'manual', which the machine may never clobber.
--
-- Additive and self-contained: no new table, no new access rule. The existing
-- user-scoped `own tasks` policy on public.tt_tasks already reaches every
-- column of the row, so a column added here inherits it.

alter table public.tt_tasks
  add column if not exists deadline_source text not null default 'manual'
    check (deadline_source in ('auto', 'manual'));

-- Every deadline that exists today was set by a human: the board's picker,
-- the "Use <date>" button, or an @bot deadline command. The default already
-- covers them; this is belt and braces for rows written mid-deploy.
update public.tt_tasks set deadline_source = 'manual' where deadline_source is null;

notify pgrst, 'reload schema';
