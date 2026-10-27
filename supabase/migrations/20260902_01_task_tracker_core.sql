-- Task Tracker — core schema.
--
-- Multi-user from the first migration. Every row belongs to exactly one
-- auth.users row and RLS enforces that; there is no shared or global state and
-- no admin role. Two people using this app cannot see each other at all.
--
-- Tables are prefixed `tt_` for the same reason the project manager prefixes
-- `pm_`: it costs nothing now and means this database can be shared later
-- without a rename.
--
-- The one asymmetry worth reading before touching anything: `tt_connections`
-- holds each user's Discord bot token and Anthropic API key, sealed with
-- AES-256-GCM (see lib/crypto.ts). It has RLS ON and DELIBERATELY NO POLICIES,
-- so anon and authenticated can do nothing with it at all — not even the owner
-- reading their own row. Only the service role, which bypasses RLS, can touch
-- it, and that key exists only on the server. The browser learns whether a
-- connection exists through `tt_connection_status`, a view that exposes
-- booleans and hints and never the ciphertext.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles — one per signed-in user, keyed to auth.users.
--
-- discord_user_id is the snowflake from the Discord OAuth identity. It is what
-- the poller matches message authors against: a message is "his" when its
-- author id equals this. Unique, so two accounts cannot claim one Discord user.
-- ---------------------------------------------------------------------------
create table public.tt_profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  discord_user_id     text unique,
  discord_username    text,
  avatar_url          text,
  timezone            text not null default 'UTC',
  -- Where reminders go. null = DM the user, which is the default. A channel id
  -- sends them there instead: the escape hatch for a user whose privacy
  -- settings block bot DMs.
  reminder_channel_id text,
  onboarded_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- connections — the secrets. See the header. No policies, on purpose.
-- ---------------------------------------------------------------------------
create table public.tt_connections (
  user_id                    uuid primary key references auth.users (id) on delete cascade,

  -- Discord: the user's OWN bot, from their own application at
  -- discord.com/developers. Not a shared bot — Erik's ruling, 2026-09-02.
  discord_bot_token_cipher   text,
  discord_bot_user_id        text,
  discord_bot_username       text,
  discord_connected_at       timestamptz,
  discord_last_error         text,

  -- Anthropic: the user's OWN API key. This is the LLM that decides what
  -- counts as a task. No key, no classification — the app never falls back to
  -- a key of its own, so nobody's messages are ever read on someone else's bill.
  anthropic_key_cipher       text,
  anthropic_key_hint         text,
  anthropic_model            text not null default 'claude-opus-5',
  anthropic_connected_at     timestamptz,
  anthropic_last_error       text,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- What the browser is allowed to know about its own connections: that they
-- exist, when, under what name, and whether they last failed. Never the token.
--
-- security_invoker is OFF so the view can read a table the caller has no policy
-- on; the `where user_id = auth.uid()` clause below is therefore the entire
-- access control, and it is why this view must never gain a column holding
-- ciphertext.
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
  c.anthropic_key_cipher is not null     as anthropic_connected,
  c.anthropic_key_hint,
  c.anthropic_model,
  c.anthropic_connected_at,
  c.anthropic_last_error
from public.tt_connections c
where c.user_id = (select auth.uid());

revoke all on public.tt_connection_status from anon;
grant select on public.tt_connection_status to authenticated;

-- ---------------------------------------------------------------------------
-- channels — every text channel the user's bot can see, and whether we watch it.
--
-- last_message_id is a Discord snowflake used as the poll cursor. It is set to
-- "now" the moment a channel is switched on, so turning a channel on never
-- back-fills years of history: tracking starts when you say it starts.
-- ---------------------------------------------------------------------------
create table public.tt_channels (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  guild_id        text not null,
  guild_name      text,
  channel_id      text not null,
  channel_name    text,
  watching        boolean not null default false,
  last_message_id text,
  last_polled_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (user_id, channel_id)
);

create index tt_channels_watch_idx on public.tt_channels (user_id, watching);
create index tt_channels_due_idx   on public.tt_channels (last_polled_at) where watching = true;

-- ---------------------------------------------------------------------------
-- messages — every message the user wrote in a watched channel.
--
-- This is the raw log, kept whether or not it became a task, because the
-- classifier's "no" is as much a decision as its "yes" and you want to be able
-- to see what it passed over.
-- ---------------------------------------------------------------------------
create table public.tt_messages (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  guild_id               text,
  channel_id             text not null,
  channel_name           text,
  message_id             text not null,
  content                text not null,
  jump_url               text,
  sent_at                timestamptz not null,
  classified_at          timestamptz,
  is_task                boolean,
  classification_reason  text,
  classification_error   text,
  created_at             timestamptz not null default now(),
  unique (user_id, message_id)
);

-- The worker's hot path: "what have I not classified yet".
create index tt_messages_unclassified_idx on public.tt_messages (sent_at)
  where classified_at is null;
create index tt_messages_recent_idx on public.tt_messages (user_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- tasks — the list.
--
-- deadline and alert_every_minutes are BOTH set by hand, always. The classifier
-- proposes a title and may propose a date in suggested_deadline, but it never
-- writes `deadline`. That is the project manager's rule carried over: the
-- machine fills the row, the human sets the clock.
--
-- next_alert_at is the scheduler's whole index. A task is due for a reminder
-- when status = 'open' and next_alert_at <= now(). See lib/reminders.ts.
-- ---------------------------------------------------------------------------
create table public.tt_tasks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  message_id          uuid references public.tt_messages (id) on delete set null,

  title               text not null,
  detail              text not null default '',
  source_excerpt      text,
  source_url          text,
  color               text not null default '#7c5cff',

  status              text not null default 'open'
                        check (status in ('open', 'done', 'dismissed')),

  deadline            timestamptz,
  suggested_deadline  timestamptz,
  alert_every_minutes integer check (alert_every_minutes is null or alert_every_minutes > 0),
  next_alert_at       timestamptz,
  last_alert_at       timestamptz,
  alerts_sent         integer not null default 0,

  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz
);

create index tt_tasks_user_idx on public.tt_tasks (user_id, status, deadline);
-- One message makes at most one task. This is what lets the worker insert the
-- task BEFORE marking the message classified: if it dies between the two, the
-- message is retried next tick and this index absorbs the duplicate instead of
-- the list growing a second copy. Partial, so hand-added tasks (message_id
-- null) are unconstrained.
create unique index tt_tasks_one_per_message on public.tt_tasks (message_id)
  where message_id is not null;
-- The scheduler sweeps this across every user at once, so it is not prefixed
-- by user_id.
create index tt_tasks_due_idx on public.tt_tasks (next_alert_at)
  where status = 'open' and next_alert_at is not null;

-- ---------------------------------------------------------------------------
-- alerts — every reminder actually sent, successes and failures alike. Without
-- this there is no answer to "did it remind me?" but scrolling Discord.
-- ---------------------------------------------------------------------------
create table public.tt_alerts (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid references public.tt_tasks (id) on delete cascade,
  kind    text not null default 'deadline',
  target  text,
  ok      boolean not null,
  error   text,
  sent_at timestamptz not null default now()
);

create index tt_alerts_task_idx on public.tt_alerts (task_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- runs — one row per cron tick, so a silent worker is visibly silent.
-- ---------------------------------------------------------------------------
create table public.tt_runs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  users_seen          integer not null default 0,
  channels_polled     integer not null default 0,
  messages_ingested   integer not null default 0,
  messages_classified integer not null default 0,
  tasks_created       integer not null default 0,
  alerts_sent         integer not null default 0,
  errors              jsonb not null default '[]'::jsonb
);

create index tt_runs_recent_idx on public.tt_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function public.tt_touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

create trigger tt_profiles_touch    before update on public.tt_profiles
  for each row execute function public.tt_touch_updated_at();
create trigger tt_connections_touch before update on public.tt_connections
  for each row execute function public.tt_touch_updated_at();
create trigger tt_tasks_touch       before update on public.tt_tasks
  for each row execute function public.tt_touch_updated_at();

-- ---------------------------------------------------------------------------
-- New sign-up: give every auth.users row a profile and an empty connections
-- row, so nothing downstream has to cope with a missing parent.
--
-- The Discord snowflake and username come from the OAuth identity, which
-- Supabase writes into raw_user_meta_data as provider_id / sub. The auth
-- callback refreshes these on every sign-in; this trigger only guarantees the
-- row is never absent.
-- ---------------------------------------------------------------------------
create or replace function public.tt_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.tt_profiles (id, discord_user_id, discord_username, avatar_url)
  values (
    new.id,
    nullif(coalesce(new.raw_user_meta_data ->> 'provider_id',
                    new.raw_user_meta_data ->> 'sub'), ''),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name',
                    new.raw_user_meta_data ->> 'name',
                    new.raw_user_meta_data ->> 'user_name'), ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do nothing;

  insert into public.tt_connections (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$fn$;

create trigger tt_on_auth_user_created
  after insert on auth.users
  for each row execute function public.tt_handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS.
--
-- The security model in one line: every policy is `user_id = auth.uid()`, and
-- tt_connections gets no policy at all. anon gets nothing anywhere — this app
-- has a login, unlike the project-manager board.
--
-- auth.uid() is wrapped in a scalar subselect throughout so Postgres evaluates
-- it once per query rather than once per row.
-- ---------------------------------------------------------------------------
alter table public.tt_profiles    enable row level security;
alter table public.tt_connections enable row level security;
alter table public.tt_channels    enable row level security;
alter table public.tt_messages    enable row level security;
alter table public.tt_tasks       enable row level security;
alter table public.tt_alerts      enable row level security;
alter table public.tt_runs        enable row level security;

create policy "own profile" on public.tt_profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- tt_connections: intentionally no policies. Service role only.

create policy "own channels" on public.tt_channels
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own messages" on public.tt_messages
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own tasks" on public.tt_tasks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Read-only: the worker writes these, the user only looks.
create policy "own alerts readable" on public.tt_alerts
  for select to authenticated
  using (user_id = (select auth.uid()));

-- tt_runs: worker-only. Nobody reads it through the browser; it is a server log.

notify pgrst, 'reload schema';
