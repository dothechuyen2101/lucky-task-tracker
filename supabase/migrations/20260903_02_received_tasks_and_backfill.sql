-- Tasks you were GIVEN, not only the ones you handed out — plus backfill.
--
-- Until now the poller kept only messages whose author was the signed-in user,
-- which answers "what did I put on other people's plates" and completely
-- misses the other half: what someone put on mine. Both halves are the same
-- product; a tracker that only remembers your own promises is half a tracker.
--
-- The rule for "given to me" is a mention. On Discord, assigning work to a
-- person means @-ing them - so a message that mentions this user is a
-- candidate, and the classifier decides whether it is actually a task. We do
-- NOT keep every message in a watched channel: that would balloon both storage
-- and the classification bill, and it would mean reading conversations the
-- user is not part of, which is not what anyone agreed to.

-- ---------------------------------------------------------------------------
-- messages: who wrote it, and which way it points
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists author_id   text,
  add column if not exists author_name text,
  add column if not exists direction   text not null default 'sent'
    check (direction in ('sent', 'received'));

comment on column public.tt_messages.direction is
  'sent = this user wrote it. received = someone else wrote it and mentioned this user.';

create index if not exists tt_messages_direction_idx
  on public.tt_messages (user_id, direction, sent_at desc);

-- ---------------------------------------------------------------------------
-- tasks: the same split, plus who the other party is
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists direction    text not null default 'given'
    check (direction in ('given', 'received')),
  add column if not exists counterparty text;

comment on column public.tt_tasks.direction is
  'given = you asked someone for this. received = someone asked you.';
comment on column public.tt_tasks.counterparty is
  'For a received task, who asked. For a given task, who it was addressed to, when known.';

create index if not exists tt_tasks_direction_idx
  on public.tt_tasks (user_id, direction, status);

-- ---------------------------------------------------------------------------
-- channels: a second cursor, running backwards
--
-- last_message_id walks FORWARD from the moment a channel was switched on.
-- Backfill walks BACKWARD from that same point, so the two never collide and
-- a partially-finished backfill can resume exactly where it stopped rather
-- than restarting or double-reading.
-- ---------------------------------------------------------------------------
alter table public.tt_channels
  add column if not exists backfill_before_id text,
  add column if not exists backfill_done      boolean not null default false,
  add column if not exists backfill_messages  integer not null default 0,
  add column if not exists backfilled_at      timestamptz;

comment on column public.tt_channels.backfill_before_id is
  'Cursor walking backwards through history. Null means backfill has not started.';

notify pgrst, 'reload schema';
