-- Task Tracker — what happened on a task, who moves its status, and undo.
--
-- Lucky35's PO, 2026-10-07 (two Looms):
--
--   * Looking at a task, the reviewer could not tell who had done what, or
--     whether anyone had been messaged — so could not decide to close it,
--     keep it open or send a reminder. Every change to a task is now kept
--     (`tt_task_events`, written by a trigger, with who made it), and the
--     board shows it beside the bot's messages, the proof and the verdicts.
--   * The PO clicked "Completed" by mistake and could not undo it — and said
--     the status should not be his to move at all on work he gave out: the
--     person doing it says how far along it is, and he reviews. A verdict
--     keeps what the task was before it (`tt_task_reviews.before`), so it can
--     be taken back while nothing has happened since (`after`); a verdict
--     taken back stays listed, excused as 'undone', and counts nothing.
--   * Disapproving reopens the task — there is no "close as failed" any more.
--     That is code only; old verdicts keep their decision.

-- ---------------------------------------------------------------------------
-- 1. who made the last change, when the server made it
-- ---------------------------------------------------------------------------
-- The board's own writes are attributed from the caller's sign-in (auth.uid()
-- → auth.identities). Writes the server makes for someone — the assignee's
-- answer, a verdict, a reply in Discord — carry the person here, stamped with
-- `last_actor_at` so a stale name is never reused for the next write.
alter table public.tt_tasks
  add column if not exists last_actor_discord_id text,
  add column if not exists last_actor_name text,
  add column if not exists last_actor_at timestamptz;

comment on column public.tt_tasks.last_actor_name is
  'Who the server last changed this task for (the assignee answering, a reviewer, the owner replying in Discord). Read by the activity trigger only when last_actor_at moved in the same write; a write from the board is attributed from the signed-in caller instead.';

-- ---------------------------------------------------------------------------
-- 2. the task's activity
-- ---------------------------------------------------------------------------
create table if not exists public.tt_task_events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  task_id          uuid not null references public.tt_tasks (id) on delete cascade,
  at               timestamptz not null default now(),
  -- Who did it. Both null: the tracker itself (the worker, a reminder sweep).
  actor_discord_id text,
  actor_name       text,
  kind             text not null check (kind in ('created', 'changed')),
  -- {field: [before, after]} for each field that moved; on 'created', what it
  -- started with.
  changes          jsonb not null default '{}'::jsonb
);

comment on table public.tt_task_events is
  'Every change to a task''s status, stage, deadline, assignee, review state, priority or title, and who made it. Written only by the tt_tasks trigger. Readable by whoever can read the task.';

create index if not exists tt_task_events_task_idx on public.tt_task_events (task_id, at);

alter table public.tt_task_events enable row level security;

-- Whoever can read the task — its owner, its assignee, the person who asked
-- for it — reads what happened to it: the subquery runs under their own RLS.
drop policy if exists "events of readable tasks" on public.tt_task_events;
create policy "events of readable tasks" on public.tt_task_events
  for select to authenticated
  using (exists (select 1 from public.tt_tasks t where t.id = task_id));

revoke all on public.tt_task_events from anon, authenticated;
grant select on public.tt_task_events to authenticated;

create or replace function public.tt_note_task_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changes jsonb := '{}'::jsonb;
  caller uuid := auth.uid();
  who_id text;
  who_name text;
begin
  if tg_op = 'INSERT' then
    changes := jsonb_strip_nulls(jsonb_build_object(
      'assignee', coalesce(new.assignee_name, new.assignee_discord_id),
      'deadline', new.deadline,
      'priority', new.priority
    ));
  else
    if new.status is distinct from old.status then
      changes := changes || jsonb_build_object('status', jsonb_build_array(old.status, new.status));
    end if;
    if new.stage is distinct from old.stage then
      changes := changes || jsonb_build_object('stage', jsonb_build_array(old.stage, new.stage));
    end if;
    if new.deadline is distinct from old.deadline then
      changes := changes || jsonb_build_object('deadline', jsonb_build_array(old.deadline, new.deadline));
    end if;
    if new.assignee_discord_id is distinct from old.assignee_discord_id then
      changes := changes || jsonb_build_object('assignee', jsonb_build_array(
        coalesce(old.assignee_name, old.assignee_discord_id), coalesce(new.assignee_name, new.assignee_discord_id)));
    end if;
    if new.review_state is distinct from old.review_state then
      changes := changes || jsonb_build_object('review_state', jsonb_build_array(old.review_state, new.review_state));
    end if;
    if new.priority is distinct from old.priority then
      changes := changes || jsonb_build_object('priority', jsonb_build_array(old.priority, new.priority));
    end if;
    if new.title is distinct from old.title then
      changes := changes || jsonb_build_object('title', jsonb_build_array(old.title, new.title));
    end if;
    if changes = '{}'::jsonb then
      return new;
    end if;
  end if;

  if caller is not null then
    -- The board: the signed-in person, from what only Supabase Auth writes.
    select i.provider_id,
           coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'user_name', i.identity_data ->> 'name')
      into who_id, who_name
    from auth.identities i
    where i.user_id = caller and i.provider = 'discord'
    order by i.created_at
    limit 1;
    if who_name is null then
      select p.discord_username into who_name from public.tt_profiles p where p.id = caller;
    end if;
  elsif new.last_actor_at is not null
        and (tg_op = 'INSERT' or new.last_actor_at is distinct from old.last_actor_at) then
    -- The server, acting for someone it named in this very write.
    who_id := new.last_actor_discord_id;
    who_name := new.last_actor_name;
  end if;

  insert into public.tt_task_events (user_id, task_id, actor_discord_id, actor_name, kind, changes)
  values (new.user_id, new.id, who_id, who_name, case when tg_op = 'INSERT' then 'created' else 'changed' end, changes);
  return new;
end;
$$;

-- No grants to adjust: a function returning `trigger` cannot be called except
-- by a trigger. Security definer: the board may not insert events itself.

drop trigger if exists tt_tasks_activity on public.tt_tasks;
create trigger tt_tasks_activity
  after insert or update of status, stage, deadline, assignee_discord_id, review_state, priority, title
  on public.tt_tasks
  for each row
  execute function public.tt_note_task_event();

-- ---------------------------------------------------------------------------
-- 3. a verdict can be taken back
-- ---------------------------------------------------------------------------
alter table public.tt_task_reviews
  add column if not exists before jsonb,
  add column if not exists after jsonb;

comment on column public.tt_task_reviews.before is
  'What the task was before this verdict (status, stage, deadline, review fields…), so it can be undone. Null on verdicts given before undo existed.';
comment on column public.tt_task_reviews.after is
  'What this verdict made of the task. Undo is allowed only while the task still stands so.';

alter table public.tt_task_reviews drop constraint if exists tt_task_reviews_excused_reason_check;
alter table public.tt_task_reviews
  add constraint tt_task_reviews_excused_reason_check
  check (excused_reason is null or excused_reason in ('by_hand', 'dismissed', 'undone'));

-- ---------------------------------------------------------------------------
-- 4. live
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_task_events'
     ) then
    alter publication supabase_realtime add table public.tt_task_events;
  end if;
end;
$$;

notify pgrst, 'reload schema';
