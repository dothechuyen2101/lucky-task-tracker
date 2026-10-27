-- Task Tracker — everyone a message tags gets the task.
--
-- Lucky35's PO, 2026-10-05: a message that tagged Cenri and Rea filed a card
-- with "No assignee". A card held one person, and with two named the
-- classifier refused to guess. Now each person tagged gets their own card —
-- the same words, the same deadline — with their own reminders, their own
-- "done", their own review and their own score (`lib/tagged.ts`).
--
-- The first card keeps `message_id`, and `tt_tasks_one_per_message` stays as
-- it is: the worker deployed before this one upserts on it, and must keep
-- working whichever of the two lands first. Every card a message filed
-- carries `source_message_id` and its place among them, `message_part`, and
-- that pair is what keeps a retry from filing anyone's card twice.

alter table public.tt_tasks
  add column if not exists source_message_id uuid references public.tt_messages (id) on delete set null,
  add column if not exists message_part smallint not null default 0,
  add column if not exists source_mentions jsonb not null default '[]'::jsonb,
  add column if not exists split_pending boolean not null default false;

comment on column public.tt_tasks.source_message_id is
  'The tagged message this card was filed from. Every card a message filed carries it; message_id is on the first card only (tt_tasks_one_per_message).';

comment on column public.tt_tasks.message_part is
  'This card''s place among the cards its message filed: 0 for the first person tagged, 1 for the next, and so on.';

comment on column public.tt_tasks.source_mentions is
  'Who the message @-mentioned — [{id, name}], the people its cards went to — so the board reads the message back with names, not snowflakes.';

comment on column public.tt_tasks.split_pending is
  'Filed with nobody on it before everyone tagged got a card. The worker gives each person tagged their card once, and clears this.';

-- Plain, not partial: a partial index cannot be an ON CONFLICT target through
-- PostgREST (AGENTS.md). Hand-added cards have no source message, and NULLs
-- are distinct, so they are unconstrained.
create unique index if not exists tt_tasks_one_per_person_per_message
  on public.tt_tasks (source_message_id, message_part);

-- Every card filed so far is the first and only one of its message.
update public.tt_tasks
set source_message_id = message_id
where message_id is not null
  and source_message_id is null;

-- Names for the board, from the message each card was filed from.
update public.tt_tasks t
set source_mentions = m.mentions
from public.tt_messages m
where t.message_id = m.id
  and t.source_mentions = '[]'::jsonb
  and jsonb_array_length(m.mentions) > 0;

-- The cards this was written for: open work handed out, filed from a message
-- that tagged people, with nobody on it. Work somebody already gave to a
-- person is left as they left it.
update public.tt_tasks t
set split_pending = true
from public.tt_messages m
where t.message_id = m.id
  and t.status = 'open'
  and t.direction = 'given'
  and t.assignee_discord_id is null
  and t.assignee_candidates is null
  and jsonb_array_length(m.mentions) > 0;

create index if not exists tt_tasks_split_pending_idx
  on public.tt_tasks (user_id)
  where split_pending;

-- A card given to someone only now, for a deadline that had already passed,
-- was never theirs to miss: the worker records that miss excused.
alter table public.tt_deadline_misses drop constraint if exists tt_deadline_misses_excused_reason_check;

alter table public.tt_deadline_misses
  add constraint tt_deadline_misses_excused_reason_check
  check (excused_reason is null or excused_reason in ('by_hand', 'dismissed', 'before_tracking', 'assigned_late'));

notify pgrst, 'reload schema';
