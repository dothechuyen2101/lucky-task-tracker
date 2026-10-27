-- Task Tracker — the person a task was given to can see it.
--
-- Lucky35's first round of feedback, 2026-09-28: "the assignee sees the same
-- task, deadline and countdown the giver sees — it is not only visible on the
-- giver's board." Until now every table was `user_id = auth.uid()` and two
-- accounts could not see each other at all. This migration opens exactly ONE
-- read path, and nothing wider:
--
--   a signed-in person may SELECT a tt_tasks row whose assignee_discord_id is
--   their own Discord id.
--
-- They cannot insert, update or delete it — the "own tasks" policy still
-- governs every write. They cannot read the giver's messages, people notes,
-- grades, alerts, channels or connections. tt_connections still has no
-- policies at all.
--
-- WHERE "their own Discord id" COMES FROM is the whole security question.
-- tt_profiles.discord_user_id is NOT safe to use: the "own profile" policy lets
-- a person update their own profile row, so trusting it would let anyone type
-- somebody else's snowflake into their profile and read every task handed to
-- that person, on every account. auth.identities is written by Supabase Auth
-- alone, during the Discord OAuth sign-in, so the id there is one the person
-- has proved they own. The security-definer function below is the only way the
-- authenticated role reads it, and it returns only the caller's own id.

-- ---------------------------------------------------------------------------
-- 1. the caller's proven Discord id
-- ---------------------------------------------------------------------------
create or replace function public.tt_my_discord_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.provider_id
  from auth.identities i
  where i.user_id = auth.uid()
    and i.provider = 'discord'
  order by i.created_at
  limit 1
$$;

comment on function public.tt_my_discord_id() is
  'The signed-in caller''s Discord snowflake, read from auth.identities (written only by Supabase Auth). Used by the "tasks given to me" policy. Never read tt_profiles.discord_user_id for access control: the owner can edit it.';

revoke all on function public.tt_my_discord_id() from public;
revoke all on function public.tt_my_discord_id() from anon;
grant execute on function public.tt_my_discord_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. the one new read path
--
-- Permissive policies are OR'ed, so the board's single `select * from tt_tasks`
-- now returns the caller's own rows plus the rows given to them. Writes are
-- untouched: this policy is FOR SELECT only.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks given to me readable" on public.tt_tasks;

create policy "tasks given to me readable" on public.tt_tasks
  for select
  to authenticated
  using (
    assignee_discord_id is not null
    and assignee_discord_id = (select public.tt_my_discord_id())
  );

-- The existing assignee index leads with user_id, which this policy does not
-- filter on. A plain btree — not unique and not partial, for the reasons given
-- in 20260907_01_task_assignee.sql.
create index if not exists tt_tasks_assignee_any_owner_idx
  on public.tt_tasks (assignee_discord_id);

-- ---------------------------------------------------------------------------
-- 3. who gave it, readable by the person it was given to
--
-- The assignee cannot read the giver's tt_profiles row, and should not be able
-- to, so the giver's name rides on the task itself. Filled on insert from the
-- owner's own profile by a trigger, so every insert path — the worker, the
-- board's add-by-hand, anything later — carries it without remembering to.
-- A label, never a key; stale after a rename, which is fine for a label.
-- ---------------------------------------------------------------------------
alter table public.tt_tasks add column if not exists owner_name text;

comment on column public.tt_tasks.owner_name is
  'Discord name of the account that owns (gave) this task, as it read when the row was written. Shown to the assignee. A mutable label only - never group, join or match on it.';

-- Runs as the inserting role: a browser insert can read its own profile under
-- "own profile", and the worker's service role bypasses RLS.
create or replace function public.tt_fill_owner_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_name is null then
    select p.discord_username into new.owner_name
    from public.tt_profiles p
    where p.id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tt_tasks_owner_name on public.tt_tasks;

create trigger tt_tasks_owner_name
  before insert on public.tt_tasks
  for each row execute function public.tt_fill_owner_name();

update public.tt_tasks t
set owner_name = p.discord_username
from public.tt_profiles p
where p.id = t.user_id
  and t.owner_name is null;

notify pgrst, 'reload schema';
