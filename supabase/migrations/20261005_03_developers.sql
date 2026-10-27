-- Task Tracker — Developers: which dev is on what, kept by hand, seen live.
--
-- Lucky35's PO, 2026-10-05: one place that shows, in real time, what each
-- developer is working on and how it is going. The devs' work lives in
-- ClickUp; until that is wired in, a person the board's owner names — Naukhaiz
-- — keeps it here by hand, and everyone allowed to see it sees each change the
-- moment it is saved (Supabase Realtime, section 4).
--
-- The first table in this app shared ACROSS accounts. The owner says who may
-- keep their list (`tt_dev_editors`, by Discord id); the policy asks
-- `tt_my_discord_id()`, which reads auth.identities — never
-- tt_profiles.discord_user_id, which its owner can edit (CLAUDE.md).

-- ---------------------------------------------------------------------------
-- 1. who keeps an owner's list
-- ---------------------------------------------------------------------------
create table if not exists public.tt_dev_editors (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{5,25}$'),
  -- Labels only: who the editor is, and whose list they keep.
  name            text,
  owner_name      text,
  created_at      timestamptz not null default now(),
  unique (owner_id, discord_user_id)
);

comment on table public.tt_dev_editors is
  'People an owner lets keep their Developers list, by Discord id. Written by the owner; each editor can read the rows naming them, so they know whose lists they keep.';

alter table public.tt_dev_editors enable row level security;

drop policy if exists "own dev editors" on public.tt_dev_editors;
create policy "own dev editors" on public.tt_dev_editors
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "dev lists I keep" on public.tt_dev_editors;
create policy "dev lists I keep" on public.tt_dev_editors
  for select to authenticated
  using (discord_user_id = (select public.tt_my_discord_id()));

revoke all on public.tt_dev_editors from anon, authenticated;
grant select, insert, update, delete on public.tt_dev_editors to authenticated;

-- ---------------------------------------------------------------------------
-- 2. the list
-- ---------------------------------------------------------------------------
create table if not exists public.tt_developers (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  -- Optional: when the dev was picked from the server, who they are there.
  discord_user_id text check (discord_user_id is null or discord_user_id ~ '^[0-9]{5,25}$'),
  working_on      text not null default '' check (char_length(working_on) <= 500),
  status          text not null default 'idle'
                  check (status in ('working', 'blocked', 'review', 'idle', 'off')),
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  -- Written by the trigger below, never by the browser: when, and by whom.
  updated_at      timestamptz not null default now(),
  updated_by_name text
);

comment on table public.tt_developers is
  'One row per developer on an owner''s Developers list: what they are working on and how it is going. Kept by hand by the owner and the editors they name (tt_dev_editors); ClickUp can feed it later.';

create index if not exists tt_developers_owner_idx on public.tt_developers (owner_id, sort_order);

-- Whether the caller may see and keep this owner's list: the owner, or an
-- editor they named. Security definer so the policy can read tt_dev_editors
-- whatever that table's own policies say; it answers yes or no and nothing else.
create or replace function public.tt_keeps_dev_list(owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select owner = auth.uid()
      or exists (
        select 1
        from public.tt_dev_editors e
        where e.owner_id = owner
          and e.discord_user_id = public.tt_my_discord_id()
      )
$$;

revoke all on function public.tt_keeps_dev_list(uuid) from public, anon;
grant execute on function public.tt_keeps_dev_list(uuid) to authenticated;

alter table public.tt_developers enable row level security;

drop policy if exists "dev lists I may keep" on public.tt_developers;
create policy "dev lists I may keep" on public.tt_developers
  for all to authenticated
  using ((select public.tt_keeps_dev_list(owner_id)))
  with check ((select public.tt_keeps_dev_list(owner_id)));

revoke all on public.tt_developers from anon, authenticated;
grant select, insert, update, delete on public.tt_developers to authenticated;

-- ---------------------------------------------------------------------------
-- 3. who changed it, and when — from the caller's proven Discord identity
-- ---------------------------------------------------------------------------
create or replace function public.tt_stamp_developer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A row stays on the list it was put on: an editor of one list who owns
  -- another cannot move rows between them.
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;
    new.created_at := old.created_at;
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

drop trigger if exists tt_developers_stamp on public.tt_developers;
create trigger tt_developers_stamp
  before insert or update on public.tt_developers
  for each row
  execute function public.tt_stamp_developer();

-- The editor reads whose list it is from the row the owner wrote; the name is
-- the owner's proven one, not one the browser sent.
create or replace function public.tt_fill_dev_editor_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.owner_id := old.owner_id;
  end if;

  select coalesce(
           i.identity_data ->> 'full_name',
           i.identity_data ->> 'user_name',
           i.identity_data ->> 'name',
           p.discord_username
         )
    into new.owner_name
  from public.tt_profiles p
  left join auth.identities i
    on i.user_id = p.id
   and i.provider = 'discord'
  where p.id = new.owner_id
  order by i.created_at
  limit 1;

  return new;
end;
$$;

drop trigger if exists tt_dev_editors_owner on public.tt_dev_editors;
create trigger tt_dev_editors_owner
  before insert or update on public.tt_dev_editors
  for each row
  execute function public.tt_fill_dev_editor_owner();

-- ---------------------------------------------------------------------------
-- 4. live: every viewer hears each change as it is saved
-- ---------------------------------------------------------------------------
-- Realtime respects RLS: each viewer hears only the lists they may keep.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_developers'
    ) then
      alter publication supabase_realtime add table public.tt_developers;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_dev_editors'
    ) then
      alter publication supabase_realtime add table public.tt_dev_editors;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
