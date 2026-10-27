-- Task Tracker — work asked through someone else's bot is filed, and the
-- person who asked can see it.
--
-- Lucky35's team, 2026-10-06: Cenri tags Luka's bot (Rocky Tracker) to hand
-- out work — to a developer, or to herself — and to ask Luka for things. Two
-- gaps: a tag that did not @-mention Luka was answered 👀 "I only track
-- evilbongressurection's tasks" and nothing was saved (the rule since
-- 2026-09-30); and what she DID ask of Luka sat on his board, where she could
-- not see it. Her "I asked for" stayed empty.
--
-- Decided (Lucky35, 2026-10-06): a tag of the bot by someone who has signed in
-- to the tracker is filed on the BOT OWNER's board, as asked by them
-- (`requested_by_*`). The owner's bot reminds and the owner reviews; the
-- person who asked reads it — read only — through the policy below, and sees
-- it under "I asked for". Someone who never signed in still gets 👀 and a
-- fixed reply, and nothing is stored.

-- ---------------------------------------------------------------------------
-- 1. who asked
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists requested_by_discord_id text,
  add column if not exists requested_by_name text;

comment on column public.tt_tasks.requested_by_discord_id is
  'Who asked for this, when it was not the board''s owner: the author of the message that tagged the owner''s bot — asking the owner (direction received) or handing it to someone (given). They can read the task (policy "tasks I asked for readable"). A Discord snowflake from the message itself, never from a profile.';

create index if not exists tt_tasks_requested_by_idx
  on public.tt_tasks (requested_by_discord_id)
  where requested_by_discord_id is not null;

-- The second read path besides "tasks given to me readable" — SELECT only, on
-- the proven Discord identity, never tt_profiles.discord_user_id (CLAUDE.md).
drop policy if exists "tasks I asked for readable" on public.tt_tasks;
create policy "tasks I asked for readable" on public.tt_tasks
  for select
  to authenticated
  using (
    requested_by_discord_id is not null
    and requested_by_discord_id = (select public.tt_my_discord_id())
  );

-- Work already asked of an owner by someone else — in a channel, or by a DM
-- its sender confirmed: the asker is its message's author. (A card made
-- before 20261005_01 carries the message in message_id.)
update public.tt_tasks t
set requested_by_discord_id = m.author_id,
    requested_by_name = coalesce(t.counterparty, m.author_name)
from public.tt_messages m
where m.id = coalesce(t.source_message_id, t.message_id)
  and t.direction = 'received'
  and t.requested_by_discord_id is null
  and m.author_id is not null;

-- ---------------------------------------------------------------------------
-- 2. who may hand out work through someone else's bot
-- ---------------------------------------------------------------------------
-- Everyone who has signed in to the tracker with Discord. The worker asks it
-- once a tick; a tag from anyone else stays an answered, unstored stranger's.
create or replace function public.tt_tracker_discord_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select distinct i.provider_id
  from auth.identities i
  where i.provider = 'discord' and i.provider_id is not null
$$;

comment on function public.tt_tracker_discord_ids() is
  'The Discord ids of everyone signed in to the tracker. The worker reads it to decide whose tags of someone else''s bot are filed (as asked by them) rather than answered and dropped.';

revoke all on function public.tt_tracker_discord_ids() from public, anon, authenticated;
grant execute on function public.tt_tracker_discord_ids() to service_role;

notify pgrst, 'reload schema';
