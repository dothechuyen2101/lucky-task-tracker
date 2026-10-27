-- Task Tracker — review with proof, a score from the reviewer's choice, and
-- priority.
--
-- Lucky35's PO, 2026-10-07 (task.md): the person who handed work out only got
-- "task done" on Discord and had no way to check it was.
--
--   1. "Done" from the assignee is never the end: it waits for review
--      (`review_state = 'pending'`), and it is NOT Completed on the rail until
--      someone approves it — pending work sits at Testing (stage 3).
--   2. The reviewer is whoever created the task: the person who asked for it
--      through the owner's bot (`requested_by_discord_id`), else the board's
--      owner. The owner may always review too.
--   3. Four choices, each recorded in `tt_task_reviews`, which IS the score:
--        approve_on_time    counts towards +0.5 per 5 (cumulative)
--        approve_late       -1
--        disapprove_close   -1, and the task ends as 'failed'
--        disapprove_reopen  -1, and it is open again with a new deadline
--        extend             no penalty; open again with a new deadline
--   4. Proof is required to report work done: words, a link or a file —
--      `tt_task_proofs`, kept for good, through every round.
--   5. A deadline that passes no longer costs anything by itself (decided
--      2026-10-07: the score comes from the review alone). Misses already
--      recorded keep counting; nothing new is recorded.
--   6. Every task has a priority — high, medium or low; medium by default.

-- ---------------------------------------------------------------------------
-- 1. tasks: failed, extended, priority
-- ---------------------------------------------------------------------------
alter table public.tt_tasks drop constraint if exists tt_tasks_status_check;
alter table public.tt_tasks
  add constraint tt_tasks_status_check check (status in ('open', 'done', 'dismissed', 'failed'));

alter table public.tt_tasks drop constraint if exists tt_tasks_review_state_check;
alter table public.tt_tasks
  add constraint tt_tasks_review_state_check
  check (review_state is null or review_state in ('pending', 'accepted', 'rejected', 'extended'));

comment on column public.tt_tasks.review_state is
  '''pending'': the assignee reported it done, with proof, and nobody has reviewed it yet (stage Testing, never Completed). ''accepted'': approved. ''rejected'': disapproved — open again with a new deadline, or failed. ''extended'': given more time on review, and open again. Null: never through review.';

alter table public.tt_tasks
  add column if not exists priority text not null default 'medium';

alter table public.tt_tasks drop constraint if exists tt_tasks_priority_check;
alter table public.tt_tasks
  add constraint tt_tasks_priority_check check (priority in ('high', 'medium', 'low'));

comment on column public.tt_tasks.priority is
  'High, medium or low. Set by whoever creates the task (the classifier reads "urgent" or "low priority" in the message), changed on the board; medium when nobody said.';

-- Work waiting for review was put on Completed by the old "done". It is not
-- completed until someone approves it.
update public.tt_tasks
set stage = 3,
    stage_at = stage_at - '4' - '5'
where status = 'done'
  and review_state = 'pending'
  and stage > 3;

-- ---------------------------------------------------------------------------
-- 2. the reviews — the history of every verdict, and the score
-- ---------------------------------------------------------------------------
create table if not exists public.tt_task_reviews (
  id                  uuid primary key default gen_random_uuid(),
  -- The board the task is on, whose Team view scores it.
  user_id             uuid not null references auth.users (id) on delete cascade,
  task_id             uuid not null references public.tt_tasks (id) on delete cascade,
  -- Who decided, from their proven Discord identity (the route reads it).
  reviewer_discord_id text,
  reviewer_name       text,
  -- Who the verdict is about — whose score it moves.
  assignee_discord_id text,
  assignee_name       text,
  task_title          text not null,
  decision            text not null
                      check (decision in ('approve_on_time', 'approve_late', 'disapprove_close', 'disapprove_reopen', 'extend')),
  note                text check (note is null or char_length(note) <= 500),
  -- The deadline it was judged against, and the one it was given after.
  deadline            timestamptz,
  new_deadline        timestamptz,
  -- When the assignee reported it done; null when it never was.
  finished_at         timestamptz,
  decided_at          timestamptz not null default now(),
  -- A verdict that no longer counts: forgiven by the owner, or on a task
  -- dismissed as not a task. Kept, never deleted.
  excused_at          timestamptz,
  excused_reason      text check (excused_reason is null or excused_reason in ('by_hand', 'dismissed'))
);

comment on table public.tt_task_reviews is
  'Every review verdict on a task: approve on time (+0.5 per 5, cumulative), approve late (-1), disapprove — close or reopen — (-1), extend (nothing). Written by the review route and the worker with the service role; the owner may excuse or count a verdict again, nothing else.';

create index if not exists tt_task_reviews_person_idx
  on public.tt_task_reviews (user_id, assignee_discord_id, decided_at desc);
create index if not exists tt_task_reviews_task_idx
  on public.tt_task_reviews (task_id, decided_at);

alter table public.tt_task_reviews enable row level security;

-- The board's owner; and, on their proven Discord identity, the person it is
-- about and the person who decided it.
drop policy if exists "reviews readable" on public.tt_task_reviews;
create policy "reviews readable" on public.tt_task_reviews
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or assignee_discord_id = (select public.tt_my_discord_id())
    or reviewer_discord_id = (select public.tt_my_discord_id())
  );

drop policy if exists "own reviews excusable" on public.tt_task_reviews;
create policy "own reviews excusable" on public.tt_task_reviews
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.tt_task_reviews from anon, authenticated;
grant select on public.tt_task_reviews to authenticated;
grant update (excused_at, excused_reason) on public.tt_task_reviews to authenticated;

-- Work finished by its deadline before reviews existed keeps its credit
-- towards +0.5: one approve_on_time each. Late ones were already counted as
-- missed deadlines, and stay counted there.
insert into public.tt_task_reviews
  (user_id, task_id, assignee_discord_id, assignee_name, task_title, decision, note, deadline, finished_at, decided_at)
select t.user_id, t.id, t.assignee_discord_id, t.assignee_name, t.title, 'approve_on_time',
       'Recorded when reviews began: finished by its deadline.', t.deadline, t.completed_at,
       coalesce(t.reviewed_at, t.completed_at)
from public.tt_tasks t
where t.status = 'done'
  and t.direction = 'given'
  and t.assignee_discord_id is not null
  and t.deadline is not null
  and t.completed_at is not null
  and t.completed_at <= t.deadline
  and t.review_state is distinct from 'pending'
  and not exists (select 1 from public.tt_task_reviews r where r.task_id = t.id);

-- ---------------------------------------------------------------------------
-- 3. the proof
-- ---------------------------------------------------------------------------
create table if not exists public.tt_task_proofs (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users (id) on delete cascade,
  task_id                 uuid not null references public.tt_tasks (id) on delete cascade,
  submitted_by_discord_id text,
  submitted_by_name       text,
  source                  text not null check (source in ('board', 'discord')),
  kind                    text not null check (kind in ('text', 'link', 'file')),
  -- The words, or the link.
  body                    text check (body is null or char_length(body) <= 4000),
  -- A file uploaded on the board, in the private `task-proofs` bucket.
  file_path               text,
  file_name               text,
  content_type            text,
  size_bytes              bigint,
  -- A file sent on Discord: its attachment URL, signed and short-lived —
  -- refreshed with the owner's bot when someone opens it.
  discord_url             text,
  -- The Discord message it came in, when it came that way.
  message_url             text,
  created_at              timestamptz not null default now(),
  check (
    (kind in ('text', 'link') and body is not null and btrim(body) <> '')
    or (kind = 'file' and (file_path is not null or discord_url is not null))
  )
);

comment on table public.tt_task_proofs is
  'What the assignee sent to show the work is done — words, a link or a file — on the board or on Discord. Kept for good: a reopened task keeps every earlier round. Written with the service role only.';

create index if not exists tt_task_proofs_task_idx on public.tt_task_proofs (task_id, created_at);

alter table public.tt_task_proofs enable row level security;

-- The board's owner, and — on the proven Discord identity — the assignee and
-- the person who asked for it, who reviews it.
drop policy if exists "proofs readable" on public.tt_task_proofs;
create policy "proofs readable" on public.tt_task_proofs
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.tt_tasks t
      where t.id = task_id
        and (
          t.assignee_discord_id = (select public.tt_my_discord_id())
          or t.requested_by_discord_id = (select public.tt_my_discord_id())
        )
    )
  );

revoke all on public.tt_task_proofs from anon, authenticated;
grant select on public.tt_task_proofs to authenticated;

-- Files uploaded on the board. Private: every read and write goes through a
-- route that checks the task first (`/api/tasks/proof*`).
insert into storage.buckets (id, name, public, file_size_limit)
values ('task-proofs', 'task-proofs', false, 52428800)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. proof sent on Discord
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists proof_pick_message_id text,
  add column if not exists proof_task_ids jsonb;

comment on column public.tt_messages.attachments is
  'The files the message carried: [{id, filename, url, content_type, size}] as Discord sent them — the proof a report of done comes with.';
comment on column public.tt_messages.proof_pick_message_id is
  'The bot''s "which task is this for?" list, sent when the sender has several open tasks. A reply to it with a number attaches this message''s proof to that task.';
comment on column public.tt_messages.proof_task_ids is
  'The task ids that list offered, in its order.';

-- A tag of the bot by someone with open work from its owner: read first as a
-- report about that work (done, started, stop), and only then as anything else.
alter table public.tt_messages drop constraint if exists tt_messages_direction_check;
alter table public.tt_messages
  add constraint tt_messages_direction_check check (direction in ('sent', 'received', 'command', 'dm_in', 'report'));

create index if not exists tt_messages_proof_pick_idx
  on public.tt_messages (user_id, proof_pick_message_id)
  where proof_pick_message_id is not null;

-- ---------------------------------------------------------------------------
-- 5. a passing deadline costs nothing by itself any more
-- ---------------------------------------------------------------------------
-- The trigger keeps one job: a dismissed task's misses and verdicts stop
-- counting, and count again if it is restored.
create or replace function public.tt_note_missed_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'dismissed' and old.status <> 'dismissed' then
    update public.tt_deadline_misses
    set excused_at = now(), excused_reason = 'dismissed'
    where task_id = new.id and excused_at is null;
    update public.tt_task_reviews
    set excused_at = now(), excused_reason = 'dismissed'
    where task_id = new.id and excused_at is null;
  elsif old.status = 'dismissed' and new.status <> 'dismissed' then
    update public.tt_deadline_misses
    set excused_at = null, excused_reason = null
    where task_id = new.id and excused_reason = 'dismissed';
    update public.tt_task_reviews
    set excused_at = null, excused_reason = null
    where task_id = new.id and excused_reason = 'dismissed';
  end if;
  return new;
end;
$$;

-- The worker still calls the sweep at the top of every tick (and the one
-- deployed before this does too); it records nothing now.
create or replace function public.tt_record_missed_deadlines()
returns integer
language sql
set search_path = ''
as $$
  select 0;
$$;

-- ---------------------------------------------------------------------------
-- 6. live
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_task_reviews'
    ) then
      alter publication supabase_realtime add table public.tt_task_reviews;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_task_proofs'
    ) then
      alter publication supabase_realtime add table public.tt_task_proofs;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
