-- Task Tracker — the bot's servers and channels are found by themselves.
--
-- 2026-10-06: Lucky35 tagged Rocky Tracker in #cenri-john and nothing happened.
-- The channel was in a server ("Task") the bot joined after the owner last
-- pressed "Refresh from Discord" — so it was on no list, never read, and eight
-- tags there went unanswered, with nothing anywhere saying so. Channels were
-- only ever learned by hand.
--
-- The worker now lists the bot's servers and channels itself, every few
-- minutes (`syncChannels`, `lib/channel-sync-server.ts`), and watches each new
-- channel from the moment it could first have been missed: its own creation,
-- or this account's previous look — whichever is later — so tags made before
-- it was found are read, and an old channel the bot only now can see does not
-- pour years of history in. `channels_synced_at` is that previous look.

alter table public.tt_connections
  add column if not exists channels_synced_at timestamptz;

comment on column public.tt_connections.channels_synced_at is
  'When the bot''s servers and channels were last listed in full without an error — by the worker every few minutes, or Refresh from Discord. A channel found later is read from this moment (or its own creation, if later). Null: never; the newest tt_channels row stands in.';

notify pgrst, 'reload schema';
