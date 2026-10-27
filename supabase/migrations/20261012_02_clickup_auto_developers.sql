-- Task Tracker — Developers found by ClickUp itself.
--
-- Lucky35's team, 2026-10-12: "why only Tom and Leo — can it not find the
-- other developers by itself?" It can. Everyone with unfinished work assigned
-- in the ClickUp workspace now gets a row on the list ClickUp feeds, added by
-- the worker (`added_from = 'clickup'`), already linked. Nobody is ever
-- removed by the sync: a row stays when their work runs out, and whoever
-- keeps the list HIDES someone rather than deleting them — a deleted row
-- would simply come back the next minute.

alter table public.tt_developers
  add column if not exists hidden_at timestamptz,
  add column if not exists added_from text not null default 'hand'
    check (added_from in ('hand', 'clickup'));

comment on column public.tt_developers.hidden_at is
  'Hidden from the list by whoever keeps it; the ClickUp sync never adds the same person again while the row exists.';
comment on column public.tt_developers.added_from is
  '''hand'': added by a person; ''clickup'': added by the worker because they have unfinished work in ClickUp.';

-- One row per ClickUp person per list. A plain index (NULLs are distinct, so
-- every unlinked row coexists) — a partial one could not be an ON CONFLICT
-- target through PostgREST (AGENTS.md).
create unique index if not exists tt_developers_one_per_clickup
  on public.tt_developers (owner_id, clickup_user_id);

-- Hiding and showing again is a person's change: credited like any other.
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

    if (new.name, new.discord_user_id, new.working_on, new.status, new.sort_order, new.clickup_user_id, new.hidden_at)
       is not distinct from
       (old.name, old.discord_user_id, old.working_on, old.status, old.sort_order, old.clickup_user_id, old.hidden_at) then
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

notify pgrst, 'reload schema';
