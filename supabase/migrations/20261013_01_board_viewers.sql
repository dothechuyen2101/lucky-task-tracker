-- Task Tracker — read-only viewers of someone's board.
--
-- 2026-10-13: the developer who builds the tracker (tomsmith4754) checks new
-- features against Lucky35's real board before they are deployed. A board's
-- owner names who may VIEW it (`tt_board_viewers`, by Discord id); a viewer
-- reads every task on it, with its verdicts and proof — and writes nothing:
-- every write policy stays the owner's, and the board treats the rows as
-- someone else's (`isShared`), read only.
--
-- Keyed on `tt_my_discord_id()`, which reads auth.identities — never
-- tt_profiles.discord_user_id, which its owner can edit (CLAUDE.md).

create table if not exists public.tt_board_viewers (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{5,25}$'),
  name            text,
  created_at      timestamptz not null default now(),
  unique (owner_id, discord_user_id)
);

comment on table public.tt_board_viewers is
  'People a board''s owner lets VIEW their board, read only, by Discord id. Written by the owner (or by hand); each viewer can read the rows naming them.';

alter table public.tt_board_viewers enable row level security;

drop policy if exists "own board viewers" on public.tt_board_viewers;
create policy "own board viewers" on public.tt_board_viewers
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "boards I view" on public.tt_board_viewers;
create policy "boards I view" on public.tt_board_viewers
  for select to authenticated
  using (discord_user_id = (select public.tt_my_discord_id()));

revoke all on public.tt_board_viewers from anon, authenticated;
grant select, insert, delete on public.tt_board_viewers to authenticated;

-- Whether the caller may view this owner's board. Security definer so the
-- policies below can ask it whatever the viewers table's own policies say;
-- it answers yes or no and nothing else.
create or replace function public.tt_views_board(owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tt_board_viewers v
    where v.owner_id = owner
      and v.discord_user_id = public.tt_my_discord_id()
  )
$$;

revoke all on function public.tt_views_board(uuid) from public, anon;
grant execute on function public.tt_views_board(uuid) to authenticated;

-- Read only: SELECT policies, nothing else. The activity (`tt_task_events`)
-- follows the tasks by itself — its policy reads them under the caller's RLS.
drop policy if exists "boards I may view" on public.tt_tasks;
create policy "boards I may view" on public.tt_tasks
  for select to authenticated
  using (public.tt_views_board(user_id));

drop policy if exists "reviews of boards I may view" on public.tt_task_reviews;
create policy "reviews of boards I may view" on public.tt_task_reviews
  for select to authenticated
  using (public.tt_views_board(user_id));

drop policy if exists "proofs of boards I may view" on public.tt_task_proofs;
create policy "proofs of boards I may view" on public.tt_task_proofs
  for select to authenticated
  using (public.tt_views_board(user_id));

notify pgrst, 'reload schema';
