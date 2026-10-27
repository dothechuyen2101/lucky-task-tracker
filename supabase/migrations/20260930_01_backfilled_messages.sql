-- Task Tracker — tell a message read live from one found in history.
--
-- Lucky35, 2026-09-30: where the bot may not react, only tags read within the
-- hour got an answer by DM, so a tag read late or found by Backfill got none,
-- looked unread, and was tagged again. The worker now answers every such tag
-- in one digest per run: live tags to whoever tagged, history to the account
-- owner who read it (DMing a colleague about a message from last spring would
-- be noise, not an answer). This column is how it tells the two apart.
--
-- Set by the backfill route in its own insert. Existing rows keep the default,
-- which is right for everything the poller stored; the ignoreDuplicates trap in
-- AGENTS.md does not bite, because nothing needs this on an older row.

alter table public.tt_messages
  add column if not exists backfilled boolean not null default false;

comment on column public.tt_messages.backfilled is
  'True when the message was found by Backfill (history) rather than read live by the poller. Decides who is answered when the bot cannot react: the tagger for live tags, the owner for history.';

notify pgrst, 'reload schema';
