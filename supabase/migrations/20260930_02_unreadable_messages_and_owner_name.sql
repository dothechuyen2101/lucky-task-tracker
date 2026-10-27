-- Task Tracker — two holes the 2026-09-30 audit found.
--
-- 1. One message Claude cannot read stalled everything behind it. A refusal or
--    an answer that does not fit the schema discards the whole batch, and the
--    same batch was sent again every minute, so every later tag for that
--    account waited forever with no ✅ / 👀. `classify_attempts` counts the
--    failures: a failed batch is retried one message at a time, and a message
--    that still fails alone is filed as a card from its own words — never
--    closed off silently, never left blocking the queue (lib/worker.ts).
--
-- 2. `tt_tasks.owner_name` — the "Given to you by …" the assignee reads — was
--    only filled when the insert left it empty, so a browser insert could name
--    anyone it liked. It is now always written by the trigger, from the
--    Discord identity Supabase Auth recorded at sign-in (auth.identities, which
--    no user can edit — the same source as tt_my_discord_id()), on every insert
--    and on any update that tries to change it.

-- ---------------------------------------------------------------------------
-- 1. messages Claude could not read
-- ---------------------------------------------------------------------------
alter table public.tt_messages
  add column if not exists classify_attempts integer not null default 0;

comment on column public.tt_messages.classify_attempts is
  'How many times Claude answered for this message in a way that could not be used (a refusal, an answer off the schema). Above zero it is classified alone; at the limit it is filed from its own words.';

-- ---------------------------------------------------------------------------
-- 2. owner_name is the owner's proven Discord name, and nothing else
-- ---------------------------------------------------------------------------
-- Security definer to read auth.identities for the row's owner; it reads only
-- that one owner's name and writes only NEW.owner_name.
create or replace function public.tt_fill_owner_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.owner_name is not distinct from old.owner_name then
    return new;
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
  where p.id = new.user_id
  order by i.created_at
  limit 1;

  return new;
end;
$$;

-- No grants to adjust: a function returning `trigger` cannot be called except
-- by a trigger.

drop trigger if exists tt_tasks_owner_name on public.tt_tasks;

create trigger tt_tasks_owner_name
  before insert or update of owner_name on public.tt_tasks
  for each row execute function public.tt_fill_owner_name();

-- Re-derive every existing label from the proven identity. Setting it to null
-- is a change, so the trigger above fills it in.
update public.tt_tasks set owner_name = null;

notify pgrst, 'reload schema';
