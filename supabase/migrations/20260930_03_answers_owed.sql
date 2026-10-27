-- Task Tracker — a tag answered where nobody will see it is not answered.
--
-- Lucky35, 2026-09-30 (again): tags added late, or brought in from somewhere
-- else, still went unnoticed. The bot's ✅ / 👀 is only an answer while the
-- person who tagged is looking at the message — Discord tells nobody when a
-- reaction lands on a message from hours or months ago — and the digest DM
-- only went out when the reaction itself failed, and for history only to the
-- owner. So the tagger saw nothing, tagged again, and the board got a copy.
--
-- Now every tag the tagger may not have seen answered is OWED an answer by
-- DM, and the debt is kept here rather than in the memory of one run:
--
--   answer_owed   'late'      read more than a few minutes after it was
--                             written (a slow read, a tag edited in later,
--                             anything Backfill finds);
--                 'unmarked'  the bot could not put ✅ / 👀 on it.
--   answered_at   when the DM carrying it went out (or was given up on);
--   answered_to   whose Discord it went to: the tagger, or the owner when
--                 the tagger cannot be DMed.
--
-- The worker sends what is owed at the end of each account's pass, one DM
-- per person, and at most one per person every few minutes, so a Backfill of
-- a busy year is two or three DMs rather than one per tag.
--
-- from_app marks a message written by a bot or a webhook — an integration
-- relaying work into the channel. Such a tag is read now instead of dropped
-- unseen; it is never replied to in public (an echo bot would answer the
-- answer), and its DM goes to the owner.
--
-- Set only by the worker on messages it processes; existing rows keep the
-- defaults, which is right: nothing is owed on anything already answered.

alter table public.tt_messages
  add column if not exists answer_owed text,
  add column if not exists answered_at timestamptz,
  add column if not exists answered_to text,
  add column if not exists from_app boolean not null default false;

alter table public.tt_messages drop constraint if exists tt_messages_answer_owed_check;

alter table public.tt_messages
  add constraint tt_messages_answer_owed_check
  check (answer_owed is null or answer_owed in ('late', 'unmarked'));

comment on column public.tt_messages.answer_owed is
  'Why the tagger is owed an answer by DM: ''late'' (read well after it was written, or found by Backfill) or ''unmarked'' (no ✅ / 👀 could be put on it). Null when the reaction was answer enough.';

comment on column public.tt_messages.answered_at is
  'When the DM answering this tag went out, or was given up on because neither the tagger nor the owner could be reached.';

comment on column public.tt_messages.answered_to is
  'The Discord id the answering DM went to: the tagger, or the owner when the tagger could not be DMed. Null when it could not be delivered to anyone.';

comment on column public.tt_messages.from_app is
  'Written by a bot or a webhook (an integration), not a person. Never replied to in public; its answer goes to the owner.';

drop index if exists public.tt_messages_answer_owed_idx;

create index tt_messages_answer_owed_idx
  on public.tt_messages (user_id, sent_at)
  where answer_owed is not null and answered_at is null;

notify pgrst, 'reload schema';
