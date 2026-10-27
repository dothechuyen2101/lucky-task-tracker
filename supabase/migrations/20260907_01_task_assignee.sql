-- Give a task an assignee, not just a counterparty.
--
-- A task Erik HANDED OUT has, today, nobody attached to it: the worker writes
-- `counterparty` only for the received half, so every `given` row lands with a
-- null. That makes "what does this person owe me" unanswerable, and it is the
-- reason the person-card board has nothing to group on.
--
-- The person is already in the data, and is thrown away. Discord's REST message
-- payload carries the users the author @-mentioned; the poller reads that array
-- purely to route direction and then discards it. So this migration does two
-- additive things: it keeps the mentions on the message, and it gives the task
-- a place to record which one of them the work went to.
--
-- Everything here is additive. `counterparty` keeps its exact meaning ("who
-- asked", on the received half) and is deliberately NOT overloaded: it holds a
-- display name, and display names merge two people who share one and split one
-- person who renames. The snowflake below is the stable identity instead.
--
-- No RLS work is needed. The existing `own messages` / `own tasks` policies on
-- these two tables already reach every column of the row, and nothing added
-- here is a secret.

-- ---------------------------------------------------------------------------
-- messages: keep the @-mentions the payload already carried
--
-- jsonb rather than a join table: this is a small, ordered, read-whole-or-not-
-- at-all attribute of one message, never queried across rows. Defaulting to
-- '[]' not null means every existing row reads as "nobody was mentioned"
-- instead of "unknown", so no reader has to branch on null.
--
-- Note that both message upserts run with ignoreDuplicates, so a re-poll will
-- NOT fill this column in on rows that already exist - they are skipped, not
-- merged. Only messages ingested after this ships carry mentions; history is
-- repaired separately, off the raw markup still sitting in `content`.
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists mentions jsonb not null default '[]'::jsonb;

comment on column public.tt_messages.mentions is
  'Users @-mentioned in this message, as [{ "id", "name" }] - the Discord snowflake and the username off the mention payload. Excludes the tracker bot. Ordered as Discord returned them. Empty array when nobody was mentioned.';

-- ---------------------------------------------------------------------------
-- tasks: who the work went to
--
-- Two columns, because identity and label are different things and only one of
-- them is safe to group on. Historical rows repaired from stored markup will
-- carry an id with a null name - the markup records no username - so every
-- reader must render the id when the name is missing.
-- ---------------------------------------------------------------------------
alter table public.tt_tasks
  add column if not exists assignee_discord_id text,
  add column if not exists assignee_name       text;

comment on column public.tt_tasks.assignee_discord_id is
  'Discord snowflake of the person this task was handed to. The identity and the grouping key: it survives a rename, so group and join on this and never on the name. Null when nobody was named, or when several people were and none was singled out - an unknown assignee is empty, never a guess.';

comment on column public.tt_tasks.assignee_name is
  'Human-readable label for that person as it read when the message was ingested. A mutable display label ONLY - never group, join or match on it. Null is normal, including on rows that do carry an assignee_discord_id.';

-- ---------------------------------------------------------------------------
-- and the index that answers "what does this person owe me"
--
-- A plain btree, deliberately. It must NOT be a unique index of any kind:
-- `tt_tasks_one_per_message` is the only unique index this table is allowed to
-- carry, because the task upsert names message_id as its ON CONFLICT target and
-- a second unique index here would collide with it. A partial one would be
-- worse still - PostgREST emits the column list alone, so a predicate it cannot
-- repeat makes every insert fail. One person legitimately owes many tasks.
-- ---------------------------------------------------------------------------
create index if not exists tt_tasks_assignee_idx
  on public.tt_tasks (user_id, assignee_discord_id, status);

notify pgrst, 'reload schema';
