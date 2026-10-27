-- Task Tracker — finished work is chased, and a handed-on task leaves its old
-- assignee's list visibly.
--
-- Lucky35's PO, 2026-10-04, on what 20261004_01 shipped:
--
--   1. "A late review on a finished task can ding the assignee's score for a
--      delay that's actually yours." The clock now stops while finished work
--      waits for review: sending it back gives the assignee the time they had
--      left when they said it was finished (`restoredDeadline`, code only —
--      the trigger already never counts a deadline that passed while the task
--      was closed).
--   2. "Tasks marked finished go silent — nobody chases confirmation." The
--      giver is reminded every day until they accept it or send it back
--      (`review_nudge_at`, `review_nudges`), and the assignee is told when it
--      is accepted.
--   3. "Reassigning a task leaves it sitting on the old dev's list with no sign
--      it's stale." Every change of assignee is recorded (`tt_task_handoffs`,
--      by trigger): the old assignee is DMed that it is no longer on them, the
--      board they have open drops it the moment it happens (Realtime), and
--      My tasks lists it under "Moved off you".

-- ---------------------------------------------------------------------------
-- 2. chasing the giver's review
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists review_nudge_at timestamptz,
  add column if not exists review_nudges integer not null default 0;

comment on column public.tt_tasks.review_nudge_at is
  'When the giver is next reminded that this finished work waits for their review. Set when the assignee marks it finished; cleared by accepting or sending it back.';

create index if not exists tt_tasks_review_nudge_idx
  on public.tt_tasks (review_nudge_at)
  where review_state = 'pending';

-- Work already waiting when this shipped is chased from the next tick.
update public.tt_tasks
set review_nudge_at = now()
where status = 'done' and review_state = 'pending' and review_nudge_at is null;

-- ---------------------------------------------------------------------------
-- 3. every change of assignee, for the person it was taken from
-- ---------------------------------------------------------------------------
create table if not exists public.tt_task_handoffs (
  id              uuid primary key default gen_random_uuid(),
  -- The task's owner, the giver.
  user_id         uuid not null references auth.users (id) on delete cascade,
  task_id         uuid not null references public.tt_tasks (id) on delete cascade,
  task_title      text not null,
  -- The giver's name, as the task carried it — what the old assignee reads.
  owner_name      text,
  from_discord_id text not null,
  from_name       text,
  -- Null when the task was taken off them and given to nobody.
  to_discord_id   text,
  to_name         text,
  moved_at        timestamptz not null default now(),
  -- Whether the person it was taken from had been told the task was theirs —
  -- nobody is told "this is no longer yours" about work they never heard of.
  from_was_told   boolean not null default false,
  task_open       boolean not null default true,
  -- When the worker settled it: DMed the old assignee, or decided there was
  -- nothing to tell. Null: owed.
  told_at         timestamptz
);

comment on table public.tt_task_handoffs is
  'Each time a task''s assignee changed. Written only by the tt_tasks trigger; the worker DMs the person it was taken from. Readable by the owner and by that person (tt_my_discord_id), so their board drops the task and says why.';

create index if not exists tt_task_handoffs_owed_idx
  on public.tt_task_handoffs (user_id, moved_at)
  where told_at is null;

create index if not exists tt_task_handoffs_from_idx
  on public.tt_task_handoffs (from_discord_id, moved_at desc);

alter table public.tt_task_handoffs enable row level security;

drop policy if exists "own handoffs readable" on public.tt_task_handoffs;
create policy "own handoffs readable" on public.tt_task_handoffs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The person a task was taken from sees that it was — keyed on the proven
-- Discord identity, never on tt_profiles.discord_user_id (CLAUDE.md).
drop policy if exists "handoffs from me readable" on public.tt_task_handoffs;
create policy "handoffs from me readable" on public.tt_task_handoffs
  for select to authenticated
  using (from_discord_id = (select public.tt_my_discord_id()));

revoke all on public.tt_task_handoffs from anon, authenticated;
grant select on public.tt_task_handoffs to authenticated;

create or replace function public.tt_note_handoff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tt_task_handoffs
    (user_id, task_id, task_title, owner_name, from_discord_id, from_name, to_discord_id, to_name, from_was_told, task_open)
  values
    (new.user_id, new.id, new.title, new.owner_name, old.assignee_discord_id, old.assignee_name,
     new.assignee_discord_id, new.assignee_name, old.assignee_told_at is not null, new.status = 'open');
  return new;
end;
$$;

-- Security definer because the board reassigns as the signed-in owner, who
-- may not insert handoffs. No grants to adjust: a function returning
-- `trigger` cannot be called except by a trigger.

drop trigger if exists tt_tasks_handoff on public.tt_tasks;
create trigger tt_tasks_handoff
  after update of assignee_discord_id on public.tt_tasks
  for each row
  when (old.assignee_discord_id is not null and old.assignee_discord_id is distinct from new.assignee_discord_id)
  execute function public.tt_note_handoff();

-- The old assignee's open board hears the handoff live: an UPDATE to a task
-- they can no longer read never reaches them, this INSERT does.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_task_handoffs'
     ) then
    alter publication supabase_realtime add table public.tt_task_handoffs;
  end if;
end;
$$;

notify pgrst, 'reload schema';
