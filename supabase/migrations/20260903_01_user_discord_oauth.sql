-- Store the user's own Discord OAuth token, so the app can list the servers
-- THEY are in and offer to invite their bot to the ones it is missing from.
--
-- Two different Discord credentials now live on this row and they do different
-- jobs, which is worth being explicit about because confusing them is easy:
--
--   discord_bot_token_cipher    the user's BOT. Reads messages. Long-lived.
--   discord_user_token_cipher   the USER, via sign-in. Read-only, and used for
--                               exactly one thing: `GET /users/@me/guilds`, to
--                               find out which servers they belong to. It can
--                               never read a message.
--
-- The user token is short-lived (Discord issues ~7 days) and Supabase hands it
-- to us once, at the moment of sign-in. We keep the refresh token beside it so
-- the list can be refreshed without making the user sign in again, and record
-- the expiry so the UI can say "sign in again to refresh" rather than failing
-- with a bare 401.

alter table public.tt_connections
  add column if not exists discord_user_token_cipher   text,
  add column if not exists discord_user_refresh_cipher text,
  add column if not exists discord_user_token_expires  timestamptz;

-- The status view gains only whether a usable user token exists and when it
-- lapses. Never the token itself — same rule as every other secret here.
--
-- DROP then CREATE, not CREATE OR REPLACE: Postgres will only let a replace
-- APPEND columns, and these two belong beside the other discord_* ones rather
-- than tacked on the end. Replacing in place fails with
--   42P16: cannot change name of view column "anthropic_connected" ...
-- because it matches the new column list against the old one positionally.
drop view if exists public.tt_connection_status;

create view public.tt_connection_status
with (security_invoker = off)
as
select
  c.user_id,
  c.discord_bot_token_cipher is not null as discord_connected,
  c.discord_bot_user_id,
  c.discord_bot_username,
  c.discord_connected_at,
  c.discord_last_error,
  c.discord_user_token_cipher is not null as discord_user_linked,
  c.discord_user_token_expires,
  c.anthropic_key_cipher is not null      as anthropic_connected,
  c.anthropic_key_hint,
  c.anthropic_model,
  c.anthropic_connected_at,
  c.anthropic_last_error
from public.tt_connections c
where c.user_id = (select auth.uid());

revoke all on public.tt_connection_status from anon;
grant select on public.tt_connection_status to authenticated;

-- ---------------------------------------------------------------------------
-- guilds — the servers the USER belongs to, cached from their own token.
--
-- Cached rather than fetched live because the settings page renders it on every
-- load and Discord rate-limits per token. `bot_present` is filled by comparing
-- against the bot's own guild list, and `can_invite` records whether this user
-- holds MANAGE_GUILD there — without it Discord will refuse the invite, and an
-- invite button that cannot work is worse than no button.
-- ---------------------------------------------------------------------------
create table if not exists public.tt_guilds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  guild_id     text not null,
  guild_name   text,
  icon         text,
  bot_present  boolean not null default false,
  can_invite   boolean not null default false,
  refreshed_at timestamptz not null default now(),
  unique (user_id, guild_id)
);

create index if not exists tt_guilds_user_idx on public.tt_guilds (user_id, guild_name);

alter table public.tt_guilds enable row level security;

drop policy if exists "own guilds" on public.tt_guilds;
create policy "own guilds" on public.tt_guilds
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

notify pgrst, 'reload schema';
