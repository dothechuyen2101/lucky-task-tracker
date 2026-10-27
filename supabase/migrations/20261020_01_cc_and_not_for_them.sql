-- Task Tracker — tagged to be told, not to do it.
--
-- Cenri, 2026-10-20: "@jfabbs … please share it here with @umer so he can
-- import it" gave umer a card of his own — everyone tagged gets one
-- (20261005_01) — with reminders, an overdue countdown and a "done" that was
-- never his. Cenri, who asked for it through Luka's bot, could not close it;
-- the way out was to have umer "reply done", which put an on-time approval
-- he never earned into his score history.
--
--   * A person tagged ONLY after "cc", "cc:", "/cc" or "fyi" is copied in:
--     no card, named on the task (`tt_tasks.cc`, `splitCc` in lib/tagged.ts).
--     Decided with the user: the words decide, never a model's guess.
--   * A card given to someone who was only copied in can be closed as such —
--     by the board's owner, or by whoever asked for it (`/api/tasks/not-for`):
--     dismissed, `dismiss_reason = 'only_cc'`, so nothing counts for or
--     against them (the dismissal trigger corrects their points), and they
--     are told. The person on a card can say it is not theirs
--     (`/api/tasks/not-mine`): kept in the activity, and the reviewer told.

-- ---------------------------------------------------------------------------
-- 1. who a card's message only copied in, and why a card was dismissed
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists cc jsonb not null default '[]'::jsonb,
  add column if not exists dismiss_reason text;

alter table public.tt_tasks drop constraint if exists tt_tasks_dismiss_reason_check;
alter table public.tt_tasks
  add constraint tt_tasks_dismiss_reason_check
  check (dismiss_reason is null or dismiss_reason = 'only_cc');

comment on column public.tt_tasks.cc is
  'People the message only copied in — tagged after "cc" / "fyi" — as [{id, name}]; a name typed in a DM has a null id. No card, no reminders: named on the task.';
comment on column public.tt_tasks.dismiss_reason is
  '''only_cc'': dismissed because its person was only copied in (/api/tasks/not-for). Null for any other dismissal; cleared whenever the card is not dismissed.';

-- A reason belongs to a dismissal only: a card restored, or written in any
-- other state, carries none — whoever wrote it.
create or replace function public.tt_clear_dismiss_reason()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from 'dismissed' then
    new.dismiss_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tt_tasks_dismiss_reason on public.tt_tasks;
create trigger tt_tasks_dismiss_reason
  before insert or update of status, dismiss_reason on public.tt_tasks
  for each row
  execute function public.tt_clear_dismiss_reason();

-- ---------------------------------------------------------------------------
-- 2. "not mine", in the task's activity
-- ---------------------------------------------------------------------------
alter table public.tt_task_events drop constraint if exists tt_task_events_kind_check;
alter table public.tt_task_events
  add constraint tt_task_events_kind_check
  check (kind in ('created', 'changed', 'reminded', 'not_mine'));

notify pgrst, 'reload schema';
