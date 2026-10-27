-- Task Tracker — the team at a glance, a score for missed deadlines, review of
-- finished work, and project channels split into active and done.
--
-- Lucky35, 2026-10-04, four asks from Luka in #task-tracker:
--
--   1. See, live, which dev is working on what. The board subscribes to
--      `tt_tasks` through Supabase Realtime (section 5), and the assignee can
--      now say "I'm on it" (stage In progress) — the board's Team view shows it
--      the moment it lands.
--   2. A missed deadline counts against the person it was on: -1 per missed
--      deadline. `tt_deadline_misses`, one row per (task, deadline), written by
--      the database — a trigger at the moment an overdue task is closed,
--      re-dated or handed on, and a sweep the worker runs every tick for the
--      ones still open. Kept apart from `tt_people.grade`, which is the
--      owner's hand-set judgement and stays that way (CLAUDE.md).
--   3. "Done" from the assignee is a claim, not a verdict. It now waits for the
--      giver's review (`review_state = 'pending'`): accept closes it, send
--      back reopens it with the reason, and the assignee is told by DM.
--   4. Project channels are moved between two Discord categories — "Active
--      projects" and "Done projects" — from Settings. The bot needs Manage
--      Channels for that (`BOT_PERMISSIONS`); the categories it uses are kept
--      per server in `tt_project_categories`.

-- ---------------------------------------------------------------------------
-- 3. review of work the assignee says is finished
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists review_state text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists review_rejections integer not null default 0;

alter table public.tt_tasks drop constraint if exists tt_tasks_review_state_check;

alter table public.tt_tasks
  add constraint tt_tasks_review_state_check
  check (review_state is null or review_state in ('pending', 'accepted', 'rejected'));

comment on column public.tt_tasks.review_state is
  '''pending'': the assignee marked it finished and the giver has not looked yet. ''accepted'': the giver agreed (stage Closed). ''rejected'': the giver sent it back and it is open again. Null: never through review — the giver closed it themselves.';

comment on column public.tt_tasks.review_note is
  'What the giver said was missing the last time they sent it back. Shown to the assignee with the reopened task.';

comment on column public.tt_tasks.review_rejections is
  'How many times the giver sent this back after the assignee said it was finished.';

create index if not exists tt_tasks_review_pending_idx
  on public.tt_tasks (user_id)
  where review_state = 'pending';

-- ---------------------------------------------------------------------------
-- 2. missed deadlines
-- ---------------------------------------------------------------------------
create table if not exists public.tt_deadline_misses (
  id                  uuid primary key default gen_random_uuid(),
  -- The task's owner — the giver, whose board scores the people they give
  -- work to. Not the assignee.
  user_id             uuid not null references auth.users (id) on delete cascade,
  task_id             uuid not null references public.tt_tasks (id) on delete cascade,
  -- Who the task was on when its deadline passed. A snowflake, like
  -- `tt_tasks.assignee_discord_id`; the name is only a label.
  assignee_discord_id text not null,
  assignee_name       text,
  task_title          text not null,
  deadline            timestamptz not null,
  recorded_at         timestamptz not null default now(),
  -- A miss that does not count: forgiven by the owner, on a task dismissed as
  -- not a task, or one already overdue when scoring began.
  excused_at          timestamptz,
  excused_reason      text,
  -- Per missed deadline: the same deadline is counted once however often the
  -- row is touched; a NEW deadline that is missed again is a second miss.
  unique (task_id, deadline)
);

alter table public.tt_deadline_misses drop constraint if exists tt_deadline_misses_excused_reason_check;

alter table public.tt_deadline_misses
  add constraint tt_deadline_misses_excused_reason_check
  check (excused_reason is null or excused_reason in ('by_hand', 'dismissed', 'before_tracking'));

comment on table public.tt_deadline_misses is
  'One row per deadline a task''s assignee missed: -1 on their score unless excused. Written only by the database (trigger and sweep); the owner may only excuse or count a miss.';

create index if not exists tt_deadline_misses_person_idx
  on public.tt_deadline_misses (user_id, assignee_discord_id, deadline desc);

alter table public.tt_deadline_misses enable row level security;

drop policy if exists "own misses readable" on public.tt_deadline_misses;
create policy "own misses readable" on public.tt_deadline_misses
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own misses excusable" on public.tt_deadline_misses;
create policy "own misses excusable" on public.tt_deadline_misses
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The owner can forgive a miss, and count it again — nothing else. No insert
-- and no delete: a miss is a fact the database records, not one a person
-- writes, and the column grant keeps the deadline and the person fixed.
revoke all on public.tt_deadline_misses from anon, authenticated;
grant select on public.tt_deadline_misses to authenticated;
grant update (excused_at, excused_reason) on public.tt_deadline_misses to authenticated;

-- The rule, once: an OPEN task GIVEN to someone, with a deadline that has
-- passed. Received work is the owner's own, and a task with nobody on it
-- scores nobody.
--
-- The trigger catches the moment such a task stops being one — closed late,
-- re-dated, handed to someone else — so a deadline missed between two worker
-- runs (once a day on Vercel Hobby) is still counted, against whoever had it.
create or replace function public.tt_note_missed_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'open'
     and old.direction = 'given'
     and old.assignee_discord_id is not null
     and old.deadline is not null
     and old.deadline <= now()
     -- Dismissed means "not a task": nothing missed on it counts.
     and new.status <> 'dismissed' then
    insert into public.tt_deadline_misses (user_id, task_id, assignee_discord_id, assignee_name, task_title, deadline)
    values (old.user_id, old.id, old.assignee_discord_id, old.assignee_name, old.title, old.deadline)
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

-- Security definer because the board writes tasks as the signed-in user, who
-- may not insert misses. No grants to adjust: a function returning `trigger`
-- cannot be called except by a trigger.

drop trigger if exists tt_tasks_missed_deadline on public.tt_tasks;
create trigger tt_tasks_missed_deadline
  after update of status, deadline, assignee_discord_id on public.tt_tasks
  for each row
  when (
    old.status is distinct from new.status
    or old.deadline is distinct from new.deadline
    or old.assignee_discord_id is distinct from new.assignee_discord_id
  )
  execute function public.tt_note_missed_deadline();

-- The sweep: every task still open past its deadline. The worker calls it at
-- the top of every tick, for every account at once. Returns how many misses
-- it recorded.
create or replace function public.tt_record_missed_deadlines()
returns integer
language sql
set search_path = ''
as $$
  with recorded as (
    insert into public.tt_deadline_misses (user_id, task_id, assignee_discord_id, assignee_name, task_title, deadline)
    select t.user_id, t.id, t.assignee_discord_id, t.assignee_name, t.title, t.deadline
    from public.tt_tasks t
    where t.status = 'open'
      and t.direction = 'given'
      and t.assignee_discord_id is not null
      and t.deadline <= now()
      and not exists (
        select 1 from public.tt_deadline_misses m where m.task_id = t.id and m.deadline = t.deadline
      )
    on conflict (task_id, deadline) do nothing
    returning 1
  )
  select count(*)::integer from recorded;
$$;

revoke all on function public.tt_record_missed_deadlines() from public, anon, authenticated;
grant execute on function public.tt_record_missed_deadlines() to service_role;

create index if not exists tt_tasks_open_deadline_idx
  on public.tt_tasks (deadline)
  where status = 'open' and assignee_discord_id is not null;

-- Already overdue when scoring began: recorded, so nothing is hidden, but
-- excused — nobody was told a missed deadline would count until now. The
-- owner can count any of them with one click.
insert into public.tt_deadline_misses
  (user_id, task_id, assignee_discord_id, assignee_name, task_title, deadline, excused_at, excused_reason)
select t.user_id, t.id, t.assignee_discord_id, t.assignee_name, t.title, t.deadline, now(), 'before_tracking'
from public.tt_tasks t
where t.status = 'open'
  and t.direction = 'given'
  and t.assignee_discord_id is not null
  and t.deadline <= now()
on conflict (task_id, deadline) do nothing;

-- ---------------------------------------------------------------------------
-- 4. project channels: which category each is in, and the two the tracker uses
-- ---------------------------------------------------------------------------
alter table public.tt_channels
  add column if not exists parent_id text,
  add column if not exists parent_name text;

comment on column public.tt_channels.parent_id is
  'The Discord category the channel sits in, as of the last Refresh or move. Null: in no category.';

create table if not exists public.tt_project_categories (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  guild_id           text not null,
  active_category_id text,
  done_category_id   text,
  updated_at         timestamptz not null default now(),
  unique (user_id, guild_id)
);

comment on table public.tt_project_categories is
  'The "Active projects" and "Done projects" categories the tracker moves channels between, per server. Written by /api/channels/project with the service role; readable by its owner.';

alter table public.tt_project_categories enable row level security;

drop policy if exists "own project categories readable" on public.tt_project_categories;
create policy "own project categories readable" on public.tt_project_categories
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. live: the board hears about task changes as they happen
-- ---------------------------------------------------------------------------
-- Realtime respects RLS: each board hears only the rows it can read.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_tasks'
    ) then
      alter publication supabase_realtime add table public.tt_tasks;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_deadline_misses'
    ) then
      alter publication supabase_realtime add table public.tt_deadline_misses;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
