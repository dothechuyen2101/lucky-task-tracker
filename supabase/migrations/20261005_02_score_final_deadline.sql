-- Task Tracker — the score: only the final deadline counts.
--
-- Lucky35's PO, 2026-10-05, three rules for the score each person carries:
--
--   1. A missed deadline, by however little: -1. (Already so: `20261004_01`.)
--   2. Every 5 tasks finished on time: +0.5, counted cumulatively — not a
--      streak. Computed by the board from the tasks themselves
--      (`scoreOf`, `lib/team.ts`); nothing new is stored for it.
--   3. A deadline that is moved counts only as its final value. Until now each
--      deadline that passed while the task was open was its own -1, and moving
--      it after it passed could not undo that. Now moving it — while the task
--      is still on the same person — takes back the misses of the deadlines it
--      replaced: they stay listed, excused ('redated'), and cost nothing. If
--      the final deadline is missed too, that one counts.
--
-- Handing the task to someone else while it is overdue still counts against
-- the person it was taken from: their last deadline was that one.

alter table public.tt_deadline_misses drop constraint if exists tt_deadline_misses_excused_reason_check;

alter table public.tt_deadline_misses
  add constraint tt_deadline_misses_excused_reason_check
  check (excused_reason is null or excused_reason in ('by_hand', 'dismissed', 'before_tracking', 'assigned_late', 'redated'));

create or replace function public.tt_note_missed_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Moved, still on the same person: only the final deadline counts. Every
  -- miss of a deadline it replaced is excused — kept, so the record never
  -- quietly shrinks, and worth nothing.
  if new.deadline is distinct from old.deadline
     and old.assignee_discord_id is not null
     and new.assignee_discord_id is not distinct from old.assignee_discord_id then
    update public.tt_deadline_misses
    set excused_at = now(), excused_reason = 'redated'
    where task_id = new.id
      and assignee_discord_id = old.assignee_discord_id
      and excused_at is null
      and deadline is distinct from new.deadline;
  end if;

  -- Handed to someone else, or nobody, while overdue: the deadline was theirs
  -- and it passed.
  if old.status = 'open'
     and old.direction = 'given'
     and old.assignee_discord_id is not null
     and new.assignee_discord_id is distinct from old.assignee_discord_id
     and old.deadline is not null
     and old.deadline <= now()
     and new.status <> 'dismissed' then
    insert into public.tt_deadline_misses (user_id, task_id, assignee_discord_id, assignee_name, task_title, deadline)
    values (old.user_id, old.id, old.assignee_discord_id, old.assignee_name, old.title, old.deadline)
    on conflict (task_id, deadline) do nothing;
  end if;

  -- Closed after its final deadline, by however little: late. (Closed by the
  -- assignee, the clock stopped when they said it was finished — this update.)
  if old.status = 'open'
     and new.status = 'done'
     and new.direction = 'given'
     and new.assignee_discord_id is not null
     and new.assignee_discord_id is not distinct from old.assignee_discord_id
     and new.deadline is not null
     and new.deadline <= now() then
    insert into public.tt_deadline_misses (user_id, task_id, assignee_discord_id, assignee_name, task_title, deadline)
    values (new.user_id, new.id, new.assignee_discord_id, new.assignee_name, new.title, new.deadline)
    on conflict (task_id, deadline) do nothing;
  end if;

  if new.status = 'dismissed' and old.status <> 'dismissed' then
    update public.tt_deadline_misses
    set excused_at = now(), excused_reason = 'dismissed'
    where task_id = new.id and excused_at is null;
  elsif old.status = 'dismissed' and new.status <> 'dismissed' then
    update public.tt_deadline_misses
    set excused_at = null, excused_reason = null
    where task_id = new.id and excused_reason = 'dismissed';
  end if;

  return new;
end;
$$;

-- The trigger itself is unchanged (`20261004_01`): it fires on status,
-- deadline and assignee, which is everything above reads.

-- The same rule for what is already recorded: a miss of a deadline the task
-- has since moved on from, while still on that person, no longer counts.
update public.tt_deadline_misses m
set excused_at = now(), excused_reason = 'redated'
from public.tt_tasks t
where m.task_id = t.id
  and m.excused_at is null
  and t.assignee_discord_id = m.assignee_discord_id
  and t.deadline is distinct from m.deadline;

-- The board counts finishes on time from the tasks; this keeps that read cheap.
create index if not exists tt_tasks_finished_idx
  on public.tt_tasks (user_id, assignee_discord_id)
  where status = 'done' and deadline is not null;

notify pgrst, 'reload schema';
