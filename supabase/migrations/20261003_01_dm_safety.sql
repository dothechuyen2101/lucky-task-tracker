-- Task Tracker — tasks by DM, made safe.
--
-- Lucky35, 2026-10-03, four holes in what 20261002_01 shipped:
--
--   1. A name typed in a DM ("@bob") was matched to whoever in the bot's
--      servers it looked like — two Bobs, and the task and its DMs went to the
--      wrong one with nobody the wiser. Now only an EXACT match to one person
--      the owner has worked with is assigned at once; anything else waits for
--      the owner to pick from `assignee_candidates` — in the DM, or on the
--      board — and nobody is DMed until they do.
--   2. Conversations went quiet after a month: a "done" sent in reply to an
--      older reminder was never read. Every conversation the bot has opened is
--      now read for good (the quiet ones less often), so that is code only.
--   3. Anyone given a task by DM could turn small talk into a card on the
--      owner's board. A request from someone other than the owner is now
--      filed only after its sender confirms it (`confirm_message_id`,
--      `confirmed_at`); small talk is answered 👀 and goes nowhere.
--   4. Stop-then-resume inside the quiet window told the giver nothing, so
--      they believed the assignee's reminders were still off. The giver's
--      last-known state is kept (`assignee_mute_told*`), and a change inside
--      the window is owed (`assignee_mute_notice_due`) and sent once the window
--      passes — if the state still differs from what they were last told.

-- ---------------------------------------------------------------------------
-- 1. who a DM might have meant, until the owner says
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists assignee_candidates jsonb;

comment on column public.tt_tasks.assignee_candidates is
  'People a name typed in a DM might mean ([{id, label, where}]), when it matched nobody exactly. The task has no assignee until the owner picks one; cleared when they do.';

-- ---------------------------------------------------------------------------
-- 3. a request by DM from someone else, waiting for its sender's "yes"
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists confirm_message_id text,
  add column if not exists confirmed_at timestamptz;

comment on column public.tt_messages.confirm_message_id is
  'The bot''s "send this as a task?" DM. A "yes" in reply to it files this message for the owner.';

comment on column public.tt_messages.confirmed_at is
  'When the sender confirmed this DM is a request for the owner. A confirmed request is filed as a task even if the classifier would call it small talk.';

create index if not exists tt_messages_confirm_idx
  on public.tt_messages (user_id, confirm_message_id)
  where confirm_message_id is not null;

-- ---------------------------------------------------------------------------
-- 4. what the giver last heard about the assignee's reminders
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists assignee_mute_told text,
  add column if not exists assignee_mute_told_at timestamptz,
  add column if not exists assignee_mute_notice_due boolean not null default false;

alter table public.tt_tasks drop constraint if exists tt_tasks_assignee_mute_told_check;

alter table public.tt_tasks
  add constraint tt_tasks_assignee_mute_told_check
  check (assignee_mute_told is null or assignee_mute_told in ('muted', 'unmuted'));

comment on column public.tt_tasks.assignee_mute_told is
  'Whether the giver was last told the assignee''s reminders are ''muted'' or ''unmuted''. Null: told nothing, which reads as on.';

comment on column public.tt_tasks.assignee_mute_notice_due is
  'The assignee switched their reminders inside the quiet window; the worker tells the giver the state once the window passes, if it still differs from assignee_mute_told.';

create index if not exists tt_tasks_mute_notice_idx
  on public.tt_tasks (user_id)
  where assignee_mute_notice_due;

-- Reminders the assignee switched off before this shipped: the giver was told
-- at the time.
update public.tt_tasks
set assignee_mute_told = 'muted',
    assignee_mute_told_at = assignee_muted_at
where assignee_muted_by = 'assignee'
  and assignee_muted_at is not null
  and assignee_mute_told is null;

notify pgrst, 'reload schema';
