-- Two additions.
--
-- 1. Record which KIND of Claude credential is stored, so the settings page can
--    stop offering models the credential cannot reach. A subscription token
--    (`sk-ant-oat…`) is refused by Opus and Sonnet on the Messages API and
--    Anthropic reports that as a 429 rate limit, which is indistinguishable
--    from a real one unless you already know. Offering the choice at all was
--    the bug; the fix is to not offer it.
--
-- 2. A third kind of tracked message: one that mentions THE BOT. Those are
--    instructions to the tracker itself ("@Lucky Tracker deadline Friday 5pm"),
--    not work for a human, so they must never become tasks.

alter table public.tt_connections
  add column if not exists anthropic_credential_kind text
    check (anthropic_credential_kind in ('api_key', 'oauth'));

comment on column public.tt_connections.anthropic_credential_kind is
  'api_key = sk-ant-api (metered, every model). oauth = sk-ant-oat subscription token (Haiku only).';

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
  c.anthropic_credential_kind,
  c.anthropic_connected_at,
  c.anthropic_last_error
from public.tt_connections c
where c.user_id = (select auth.uid());

revoke all on public.tt_connection_status from anon;
grant select on public.tt_connection_status to authenticated;

-- Backfill: every credential connected before this migration was stored
-- without its kind. The hint cannot tell us, so infer from the model — anyone
-- who was working on Opus or Sonnet must have had an API key, because a
-- subscription token cannot reach those at all.
update public.tt_connections
set anthropic_credential_kind =
      case when anthropic_model like 'claude-haiku%' then 'oauth' else 'api_key' end
where anthropic_key_cipher is not null
  and anthropic_credential_kind is null;

-- ---------------------------------------------------------------------------
-- Commands: messages addressed to the bot
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  drop constraint if exists tt_messages_direction_check;

alter table public.tt_messages
  add constraint tt_messages_direction_check
    check (direction in ('sent', 'received', 'command'));

comment on column public.tt_messages.direction is
  'sent = this user wrote it. received = someone else wrote it and mentioned this user. command = it mentions the BOT and is an instruction to the tracker.';

-- What a command was aimed at and what came of it, so a misfire is visible
-- rather than silent.
alter table public.tt_messages
  add column if not exists command_target_task uuid references public.tt_tasks (id) on delete set null,
  add column if not exists command_result      text,
  -- Discord's own reply pointer. Replying to the message that created a task is
  -- the least ambiguous way to say WHICH task a command is about.
  add column if not exists reply_to_message_id text;

notify pgrst, 'reload schema';
