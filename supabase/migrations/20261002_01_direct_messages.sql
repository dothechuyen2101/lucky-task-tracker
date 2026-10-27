-- Task Tracker — tasks by direct message, and telling the person they are for.
--
-- Lucky35, 2026-10-02: Luka hands out work in private messages, not only in
-- server channels, and the people who work closely with him need one place to
-- see what is on them instead of hunting through DMs and channels.
--
-- A bot cannot read a DM between two people, ever. What it CAN read is a DM
-- sent to the bot itself. So:
--
--   * The owner DMs their own bot — "@minh redo the thumbnail, 36 hours", no
--     tag needed — and it is filed exactly like a tag in a channel.
--   * The people the owner works with DM the same bot: reply `done` or `stop`
--     to a reminder, ask "my tasks", or ask the owner for something, which
--     becomes a task for the owner.
--
-- Without a live connection (Vercel cannot hold one) a bot cannot discover a
-- DM someone else opened. It can open — and then read — the DM with anyone it
-- knows: its owner, and everyone the owner has given work to. tt_dm_channels
-- is that list, with a cursor per conversation, read by the worker only.

-- ---------------------------------------------------------------------------
-- 1. the private conversations each bot reads
-- ---------------------------------------------------------------------------
create table if not exists public.tt_dm_channels (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- The other person in the conversation: the owner themselves, or someone
  -- they work with. A Discord snowflake.
  recipient_id    text not null,
  channel_id      text not null,
  last_message_id text,
  last_polled_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (user_id, recipient_id)
);

comment on table public.tt_dm_channels is
  'The DMs a bot reads: with its owner, and with the people the owner gives work to. Worker only — RLS on, no policies.';

-- Service role only, like tt_connections: nothing in the browser needs it.
alter table public.tt_dm_channels enable row level security;

create index if not exists tt_dm_channels_due_idx on public.tt_dm_channels (user_id, last_polled_at);

-- ---------------------------------------------------------------------------
-- 2. a message read in a DM, and one from someone other than the owner
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists via_dm boolean not null default false;

comment on column public.tt_messages.via_dm is
  'Sent to the bot in a private message rather than tagged in a server channel. Counts as a tag; answered in the DM itself.';

-- 'dm_in': a DM from someone other than the owner, not read yet. It becomes an
-- answer about their own tasks (done / stop / list), or a 'received' task for
-- the owner.
alter table public.tt_messages drop constraint if exists tt_messages_direction_check;

alter table public.tt_messages
  add constraint tt_messages_direction_check
  check (direction in ('sent', 'received', 'command', 'dm_in'));

-- ---------------------------------------------------------------------------
-- 3. which DM was about which task — so a reply to it finds the task
-- ---------------------------------------------------------------------------
alter table public.tt_alerts
  add column if not exists message_id text;

comment on column public.tt_alerts.message_id is
  'The Discord message the bot sent. A reply to it ("done", "deadline friday") is matched to task_id through this.';

create index if not exists tt_alerts_message_idx
  on public.tt_alerts (user_id, message_id)
  where message_id is not null;

-- ---------------------------------------------------------------------------
-- 4. has the person a task is for been told about it?
-- ---------------------------------------------------------------------------
-- A task given in a channel @-mentions its assignee, so they saw it. One given
-- in a DM to the bot, made by hand on the board, or moved to someone new was
-- seen by nobody but the giver: the worker DMs the assignee once and stamps
-- this. Existing tasks count as told, so this migration sends nothing.
alter table public.tt_tasks
  add column if not exists assignee_told_at timestamptz;

comment on column public.tt_tasks.assignee_told_at is
  'When the assignee was told the task exists (by the @-mention that created it, or by a DM from the bot). Null means they are owed that DM; reset when the assignee changes.';

update public.tt_tasks
set assignee_told_at = coalesce(created_at, now())
where assignee_told_at is null;

notify pgrst, 'reload schema';
