-- Task Tracker — the three gaps that were still silent.
--
-- Lucky35, 2026-09-29, after 20260929_01:
--
--   * History read before the bot's role in a server was known passed over
--     every tag of that role, and said nothing. `tt_channels.rescan_reason`
--     marks such a channel so Settings can say its history needs reading again
--     (the backfill route now learns the role before it reads anything).
--   * A bot invited with the old link cannot react. The task was filed, the ✅
--     never appeared, the guide said that meant "unread", and people tagged
--     again. `tt_channels.react_error` records where the bot cannot react so
--     the board can say so; a repeat of a request already on the board is now
--     recognised (skip_category 'duplicate') instead of filed twice.
--   * "Not filed" rows fell off the board after a fortnight, taking the only
--     trace of a misjudged message with them. They now stay until a person
--     reviews them: `tt_messages.skip_reviewed_at`.
--
-- No new read path: every column rides on a table whose "own ..." policy
-- already says who may read it.

-- ---------------------------------------------------------------------------
-- 1. repeats are a kind of "not filed"
-- ---------------------------------------------------------------------------
alter table public.tt_messages drop constraint if exists tt_messages_skip_category_check;

alter table public.tt_messages
  add constraint tt_messages_skip_category_check
  check (skip_category is null or skip_category in ('thanks', 'chatter', 'question', 'command', 'duplicate'));

-- ---------------------------------------------------------------------------
-- 2. "Not filed" stays until somebody decides
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists skip_reviewed_at timestamptz;

comment on column public.tt_messages.skip_reviewed_at is
  'When a person reviewed a "Not filed" row and agreed it is not a task. Null keeps it on the board; there is no age limit.';

drop index if exists public.tt_messages_skipped_idx;

create index tt_messages_skipped_idx
  on public.tt_messages (user_id, sent_at desc)
  where skip_category is not null and is_task = false and skip_reviewed_at is null;

-- ---------------------------------------------------------------------------
-- 3. where the bot cannot answer, and where history must be read again
-- ---------------------------------------------------------------------------
alter table public.tt_channels
  add column if not exists react_error text,
  add column if not exists react_error_at timestamptz,
  add column if not exists rescan_reason text;

comment on column public.tt_channels.react_error is
  'Why the bot could not add ✅ / 👀 here (no Add Reactions). While set, a missing reaction in this channel does not mean the tag was unread. Cleared by the next reaction that succeeds.';

comment on column public.tt_channels.rescan_reason is
  'Set when this channel''s history was read before the bot''s role in its server was known. Backfill reads the history again and clears it.';

notify pgrst, 'reload schema';
