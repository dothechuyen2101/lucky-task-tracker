-- Task Tracker — tagging the bot is answered, and the assignee can answer back.
--
-- Lucky35's second round of feedback, 2026-09-29:
--
--   * Tagging the bot's ROLE (which Discord offers right beside the bot) was
--     silently ignored. The worker now learns the role the bot has in each
--     server and counts it as a tag: `tt_connections.discord_bot_role_ids`.
--   * Every tagged "thanks" became a card. The classifier now sorts tagged
--     messages, and the ones it reads and does not file keep why, so the board
--     can list them one click from becoming a task: `tt_messages.skip_category`.
--   * The assignee got reminder after reminder with no way to answer, and the
--     giver could not tell. The assignee's stream now has its own state on the
--     task, the assignee (signed in) can close the task or silence their own
--     reminders, and the giver sees all of it: the `assignee_*` columns and
--     `completed_by` on `tt_tasks`.
--
-- No new read path: every new column rides on a table whose policies already
-- say who may read it. `tt_connections` still has no policies at all, and
-- `tt_connection_status` does not expose the new column.

-- ---------------------------------------------------------------------------
-- 1. the bot's roles — one per server it is in, learned by the worker
-- ---------------------------------------------------------------------------
alter table public.tt_connections
  add column if not exists discord_bot_role_ids text[] not null default '{}';

comment on column public.tt_connections.discord_bot_role_ids is
  'Ids of the roles Discord created for this user''s bot (one per server). A message mentioning one of them tagged the bot. Learned by the worker from each server''s role list; never typed.';

-- ---------------------------------------------------------------------------
-- 2. tagged messages read and not filed
--
-- Written by the worker when it classifies (an UPDATE), not at ingest, so the
-- ignoreDuplicates trap in AGENTS.md does not apply: every message classified
-- from now on carries it. Null on everything older, which is correct — the
-- old rows were never read under these rules.
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists skip_category text
    check (skip_category is null or skip_category in ('thanks', 'chatter', 'question', 'command'));

create index if not exists tt_messages_skipped_idx
  on public.tt_messages (user_id, sent_at desc)
  where skip_category is not null and is_task = false;

-- ---------------------------------------------------------------------------
-- 3. the assignee's side of a task
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists assignee_alerts_sent integer not null default 0,
  add column if not exists assignee_last_alert_at timestamptz,
  add column if not exists assignee_last_error text,
  add column if not exists assignee_overdue_alerts integer not null default 0,
  add column if not exists assignee_muted_at timestamptz,
  add column if not exists assignee_muted_by text
    check (assignee_muted_by is null or assignee_muted_by in ('owner', 'assignee')),
  add column if not exists completed_by text
    check (completed_by is null or completed_by in ('owner', 'assignee'));

comment on column public.tt_tasks.assignee_overdue_alerts is
  'DMs sent to the assignee after the deadline passed. The worker stops at ASSIGNEE_OVERDUE_LIMIT (lib/reminders.ts) and tells the giver; moving the deadline resets it.';

comment on column public.tt_tasks.assignee_muted_by is
  'Who switched the assignee''s reminders off: the owner from the board, or the assignee from their side. The giver''s own reminders are unaffected.';

notify pgrst, 'reload schema';
