-- Task Tracker — Developers fed by ClickUp.
--
-- Lucky35's PO, 2026-10-12: the developers' work lives in ClickUp (workspace
-- LOOKUP MEDIA), and Naukhaiz runs it there. Each row on the Developers list
-- can be linked to a ClickUp person; every minute the worker reads what is
-- open on them in ClickUp and keeps it on the row (`clickup_tasks`), with
-- ClickUp's own status names and colours. The hand-kept fields stay theirs
-- to edit: "working on" and the status are never written by the sync.
--
-- One ClickUp token, in the server's environment (CLICKUP_API_KEY), feeds ONE
-- owner's list (CLICKUP_DEVELOPERS_OWNER) from ONE workspace
-- (CLICKUP_WORKSPACE_ID) — never anyone else's list.

-- ---------------------------------------------------------------------------
-- 1. a developer's ClickUp person, and what ClickUp says is open on them
-- ---------------------------------------------------------------------------
alter table public.tt_developers
  add column if not exists clickup_user_id text
    check (clickup_user_id is null or clickup_user_id ~ '^[0-9]{1,20}$'),
  add column if not exists clickup_tasks jsonb not null default '[]'::jsonb;

comment on column public.tt_developers.clickup_user_id is
  'The ClickUp person this developer is, picked by whoever keeps the list. Null: not linked.';
comment on column public.tt_developers.clickup_tasks is
  'What is open on them in ClickUp — [{id, name, url, status, color, type, list, updated_at, due_at}] — written by the worker alone (lib/clickup-sync.ts), never by a person.';

-- ---------------------------------------------------------------------------
-- 2. the link itself: which workspace, who is in it, how the last read went
-- ---------------------------------------------------------------------------
create table if not exists public.tt_clickup_state (
  owner_id       uuid primary key references auth.users (id) on delete cascade,
  workspace_id   text not null,
  workspace_name text,
  -- [{id, name, initials, color}] — names only, for picking who a row is.
  members        jsonb not null default '[]'::jsonb,
  members_at     timestamptz,
  synced_at      timestamptz,
  error          text,
  error_at       timestamptz
);

comment on table public.tt_clickup_state is
  'One row per Developers list that ClickUp feeds: the workspace, its members (names only), and when the worker last read it — or why it could not. Written by the worker; read by whoever keeps that list.';

alter table public.tt_clickup_state enable row level security;

drop policy if exists "clickup state of lists I keep" on public.tt_clickup_state;
create policy "clickup state of lists I keep" on public.tt_clickup_state
  for select to authenticated
  using ((select public.tt_keeps_dev_list(owner_id)));

revoke all on public.tt_clickup_state from anon, authenticated;
grant select on public.tt_clickup_state to authenticated;

-- ---------------------------------------------------------------------------
-- 3. "who changed it, and when" means a PERSON
-- ---------------------------------------------------------------------------
-- The sync rewrites `clickup_tasks` whenever ClickUp moves; that is not
-- someone changing the row, so it keeps the stamp a person left. And what
-- ClickUp says is ClickUp's: a person (anyone with a session) cannot write
-- it, and relinking a row to someone else clears it until the next read.
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

    if (new.name, new.discord_user_id, new.working_on, new.status, new.sort_order, new.clickup_user_id)
       is not distinct from
       (old.name, old.discord_user_id, old.working_on, old.status, old.sort_order, old.clickup_user_id) then
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
-- 4. live: a failed read shows on the page as it happens
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_clickup_state'
    ) then
      alter publication supabase_realtime add table public.tt_clickup_state;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
