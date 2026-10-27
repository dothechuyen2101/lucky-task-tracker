-- The people you hand work to — a label, an avatar, free-text notes, a grade.
--
-- One row per (owner, person), created lazily: the first note or grade Erik
-- sets for somebody is what brings their row into existence. A person who has
-- tasks but no row here is the NORMAL first state of this feature, not a
-- missing parent, so every single-person read is a `.maybeSingle()`.
--
-- SECURITY, stated out loud because this table is easy to get backwards in
-- BOTH directions. This is ORDINARY PER-USER DATA and it gets the ordinary
-- owner-only policy — exactly the `own tasks` shape at 20260902_01:335-338:
-- RLS on, one policy, `user_id = (select auth.uid())` on both sides.
--
-- It is deliberately NOT the other shape in this schema — the service-role-
-- only, RLS-on-with-zero-policies default deny that the sealed-credential
-- table carries. Copying that here would make the person panel permanently
-- unreadable from the browser, because the panel reads through the ordinary
-- signed-in client and there is no server route for it. Nothing in this table
-- is a secret: it is one user's own notes about their own contacts.
--
-- The signed-out role is blocked here the way it is blocked on every other
-- table in this schema — by never being named in a policy at all. No
-- privileges are handed to any role in this file.
--
-- Nothing the machine writes lands here. `grade` is Erik's, set by hand; the
-- CHECK constraint below is what makes that more than a convention in a
-- comment. Neither the classifier's verdict schema (lib/claude.ts) nor the
-- worker's task write set (lib/worker.ts) gains the column.

-- ---------------------------------------------------------------------------
-- the table
--
-- `discord_user_id` is the same snowflake 20260907_01 put on tt_tasks as
-- `assignee_discord_id`, and it is the whole join: the panel matches one
-- against the other. A snowflake survives a rename, so it is the identity;
-- `display_name` is a mutable label and must never be joined or grouped on.
--
-- `avatar_url` is nullable and is READ, never fetched. There is no by-id
-- Discord user helper in this codebase and adding one would need a server
-- route holding the bot token, which this feature did not ask for. Null means
-- the panel renders initials.
--
-- The unique constraint is PLAIN — no `where` clause — because the write path
-- is an upsert whose ON CONFLICT target is exactly this column pair, and
-- PostgREST emits the column list alone: a predicate it cannot repeat makes
-- every insert fail (AGENTS.md:94-100; this is the retrofit 20260903_03 had to
-- make for tt_tasks). The key column is `not null` for the same reason —
-- Postgres treats NULLs as distinct, so a nullable key would quietly let
-- duplicate rows for one person accumulate behind the constraint's back.
-- ---------------------------------------------------------------------------
create table public.tt_people (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  discord_user_id text not null,
  display_name    text not null default '',
  avatar_url      text,
  notes           text not null default '',
  grade           smallint check (grade is null or (grade between 1 and 5)),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tt_people_one_per_person unique (user_id, discord_user_id)
);

comment on table public.tt_people is
  'Per-owner notes and a hand-set grade for a person work is handed to. Ordinary per-user data with an owner-only policy - not the service-role-only shape used by the sealed-credential table. Created lazily: no row until the owner writes a note or a grade.';

comment on column public.tt_people.discord_user_id is
  'Discord snowflake, joined against tt_tasks.assignee_discord_id. The identity and the only thing to match on: it survives a rename.';

comment on column public.tt_people.display_name is
  'Mutable label, written from whatever name the UI already had on screen. Never fetched from Discord, never joined or grouped on. Empty string is normal.';

comment on column public.tt_people.avatar_url is
  'Read, never fetched. Null means the panel renders initials instead of an image.';

comment on column public.tt_people.grade is
  'Erik''s 1-5 score, set by hand and by nothing else. The classifier and the worker never write this column; the CHECK constraint is what enforces that beyond convention. Null means ungraded, which is the default and is not a failure.';

-- The panel's read: every person row this owner has, in one go.
create index tt_people_user_idx on public.tt_people (user_id);

-- ---------------------------------------------------------------------------
-- RLS — the ordinary owner-only shape, copied from `own tasks`.
--
-- auth.uid() stays wrapped in a scalar subselect so Postgres evaluates it once
-- per query rather than once per row, matching every other table policy here.
-- ---------------------------------------------------------------------------
alter table public.tt_people enable row level security;

create policy "own people" on public.tt_people
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- updated_at is NOT automatic - it needs its own trigger, the same way
-- tt_profiles, tt_tasks and the credential table each got one. The function
-- already exists (20260902_01:243-251); it is attached here, not redefined.
-- ---------------------------------------------------------------------------
create trigger tt_people_touch before update on public.tt_people
  for each row execute function public.tt_touch_updated_at();

notify pgrst, 'reload schema';
