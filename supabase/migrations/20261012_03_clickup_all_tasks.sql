-- Task Tracker — every ClickUp task, done ones too; each developer sees theirs.
--
-- Lucky35's team, 2026-10-12: take ALL the tasks — finished and not — so
-- each developer can see all of theirs, and the managers everyone's.
--
--   managers    the list's owner (Lucky35) and whoever keeps it (Naukhaiz):
--               every task (`tt_keeps_dev_list`)
--   a developer the tasks assigned to THEM, and nothing else — not the
--               notes or the hand-set status the managers keep about them
--
-- Who a signed-in person is in ClickUp comes from their row on the list:
-- `tt_developers.discord_user_id` next to its `clickup_user_id`. The worker
-- fills it when a verified Discord email equals the ClickUp email of exactly
-- one person (`tt_tracker_identities`, service role only); a manager can set
-- it by hand ("Signs in as…").

-- ---------------------------------------------------------------------------
-- 1. one row per ClickUp task, written by the worker alone
-- ---------------------------------------------------------------------------
create table if not exists public.tt_clickup_tasks (
  owner_id        uuid not null references auth.users (id) on delete cascade,
  id              text not null,
  name            text not null,
  url             text not null,
  status          text not null,
  color           text,
  -- ClickUp's kind of status: open / unstarted / custom / done / closed.
  type            text not null,
  orderindex      integer not null default 0,
  list            text,
  assignee_ids    text[] not null default '{}',
  assignee_names  text[] not null default '{}',
  created_at      timestamptz,
  updated_at      timestamptz,
  done_at         timestamptz,
  due_at          timestamptz,
  synced_at       timestamptz not null default now(),
  primary key (owner_id, id)
);

comment on table public.tt_clickup_tasks is
  'Every task in the ClickUp workspace that feeds an owner''s Developers list — finished ones too. Written by the worker (lib/clickup-sync.ts); read by the list''s managers (all) and by each developer (their own).';

create index if not exists tt_clickup_tasks_assignees_idx on public.tt_clickup_tasks using gin (assignee_ids);

alter table public.tt_developers
  add column if not exists discord_name text;

comment on column public.tt_developers.discord_name is
  'The name of the Discord person this developer signs in as — a label next to discord_user_id.';

-- ---------------------------------------------------------------------------
-- 2. who may read what
-- ---------------------------------------------------------------------------
-- The ClickUp people the caller is, on that owner's list. Security definer:
-- a developer cannot read the list's rows themselves (the notes stay the
-- managers'); this answers with ids and nothing else.
create or replace function public.tt_my_clickup_ids(owner uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(d.clickup_user_id), '{}')
  from public.tt_developers d
  where d.owner_id = owner
    and d.clickup_user_id is not null
    and d.discord_user_id is not null
    and d.discord_user_id = public.tt_my_discord_id()
$$;

revoke all on function public.tt_my_clickup_ids(uuid) from public, anon;
grant execute on function public.tt_my_clickup_ids(uuid) to authenticated;

alter table public.tt_clickup_tasks enable row level security;

drop policy if exists "clickup tasks: managers all, developers theirs" on public.tt_clickup_tasks;
create policy "clickup tasks: managers all, developers theirs" on public.tt_clickup_tasks
  for select to authenticated
  using (
    public.tt_keeps_dev_list(owner_id)
    or assignee_ids && public.tt_my_clickup_ids(owner_id)
  );

revoke all on public.tt_clickup_tasks from anon, authenticated;
grant select on public.tt_clickup_tasks to authenticated;

-- A developer sees when ClickUp was last read for them.
drop policy if exists "clickup state of lists I am on" on public.tt_clickup_state;
create policy "clickup state of lists I am on" on public.tt_clickup_state
  for select to authenticated
  using (cardinality(public.tt_my_clickup_ids(owner_id)) > 0);

-- Everyone signed in to the tracker, with their VERIFIED Discord email, for
-- the worker to match against ClickUp. Service role only.
create or replace function public.tt_tracker_identities()
returns table (discord_id text, email text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.provider_id,
         lower(btrim(i.identity_data ->> 'email')),
         coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'user_name', i.identity_data ->> 'name')
  from auth.identities i
  where i.provider = 'discord'
    and i.provider_id is not null
    and coalesce(i.identity_data ->> 'email', '') <> ''
    and coalesce((i.identity_data ->> 'email_verified')::boolean, false)
$$;

revoke all on function public.tt_tracker_identities() from public, anon, authenticated;
grant execute on function public.tt_tracker_identities() to service_role;

-- ---------------------------------------------------------------------------
-- 3. the stamp: only a person moves "who changed it, and when"
-- ---------------------------------------------------------------------------
-- The worker now writes links (a matched email) as well as tasks; neither is
-- someone changing the row. A write without a session keeps the stamp.
create or replace function public.tt_stamp_developer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.clickup_tasks := '[]'::jsonb;
      new.added_from := 'hand';
    elsif new.clickup_user_id is distinct from old.clickup_user_id then
      new.clickup_tasks := '[]'::jsonb;
    else
      new.clickup_tasks := old.clickup_tasks;
    end if;
  end if;

  -- A row stays on the list it was put on: an editor of one list who owns
  -- another cannot move rows between them.
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
    new.added_from := old.added_from;

    if auth.uid() is null
       or (new.name, new.discord_user_id, new.discord_name, new.working_on, new.status, new.sort_order, new.clickup_user_id, new.hidden_at)
          is not distinct from
          (old.name, old.discord_user_id, old.discord_name, old.working_on, old.status, old.sort_order, old.clickup_user_id, old.hidden_at) then
      new.updated_at := old.updated_at;
      new.updated_by_name := old.updated_by_name;
      return new;
    end if;
  end if;

  new.updated_at := now();
  select coalesce(
           i.identity_data ->> 'full_name',
           i.identity_data ->> 'user_name',
           i.identity_data ->> 'name',
           p.discord_username
         )
    into new.updated_by_name
  from public.tt_profiles p
  left join auth.identities i
    on i.user_id = p.id
   and i.provider = 'discord'
  where p.id = auth.uid()
  order by i.created_at
  limit 1;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. how far the reading has got
-- ---------------------------------------------------------------------------
alter table public.tt_clickup_state
  add column if not exists tasks_full_at timestamptz,
  add column if not exists tasks_synced_at timestamptz;

comment on column public.tt_clickup_state.tasks_full_at is
  'The last time the worker read EVERY task (and dropped those gone from ClickUp); in between it reads only what changed.';

-- ---------------------------------------------------------------------------
-- 5. live
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_clickup_tasks'
    ) then
      alter publication supabase_realtime add table public.tt_clickup_tasks;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
