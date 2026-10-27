-- Task Tracker — every point, written down for good.
--
-- Lucky35's PO, 2026-10-09: "Log every point change." Until now a score was
-- worked out on the fly from the verdicts (`tt_task_reviews`) and the old
-- missed deadlines, and fixing a mistake meant flipping `excused_at` on the
-- row — the record changed under everyone's feet, and a deleted task took its
-- points with it. Raises and bonuses are now decided on this, so:
--
--   * Every −1 and every +0.5 is a row in `tt_score_entries`: whose, how
--     much, why (approved late, disapproved, five on time — and which five),
--     the task, when, and who decided. A disapproval carries its note.
--   * Nothing ever changes or leaves that table — not for an admin, not for
--     the service role (a trigger refuses UPDATE, DELETE and TRUNCATE), and
--     not when the task is deleted (no foreign key to it).
--   * A mistake is fixed by a CORRECTION: a new row of the opposite amount
--     pointing at the one it reverses (`corrects`). Both stay listed. By hand
--     only Lucky35 (`tt_score_admins`) or whoever made the decision may add
--     one, and it needs a note. The database adds them itself when a verdict
--     is undone or a task dismissed (and counts it again when restored).
--   * A score IS the sum of its entries.
--   * Each person reads only their own history; Lucky35 reads everyone's.
--
-- Decided with the user, 2026-10-09: Lucky35 is evilbongressurection; a board
-- owner who is not Lucky35 sees only their own points; when one of the five
-- tasks behind a +0.5 stops counting, the +0.5 is taken back automatically
-- and the other four wait for the next one.

-- ---------------------------------------------------------------------------
-- 1. Lucky35 — who reads everyone's history
-- ---------------------------------------------------------------------------
create table if not exists public.tt_score_admins (
  discord_id text primary key check (discord_id ~ '^[0-9]{17,20}$'),
  name       text,
  added_at   timestamptz not null default now()
);

comment on table public.tt_score_admins is
  'Discord accounts that read every person''s score history and export it (Lucky35). Kept by hand in SQL; no policy, so nobody edits it from the app.';

alter table public.tt_score_admins enable row level security;
revoke all on public.tt_score_admins from anon, authenticated;

insert into public.tt_score_admins (discord_id, name)
values ('219473743288729600', 'evilbongressurection')
on conflict (discord_id) do nothing;

create or replace function public.tt_is_score_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tt_score_admins a where a.discord_id = public.tt_my_discord_id()
  );
$$;

revoke all on function public.tt_is_score_admin() from public, anon;
grant execute on function public.tt_is_score_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. the history
-- ---------------------------------------------------------------------------
create table if not exists public.tt_score_entries (
  id                    uuid primary key default gen_random_uuid(),
  -- The order entries were written in; what "the latest in a chain" means.
  seq                   bigint generated always as identity unique,
  -- An original and every correction of it share the original's id here.
  root_id               uuid not null,
  -- The entry this one reverses. One correction per entry: correct the
  -- correction to put it back.
  corrects              uuid unique references public.tt_score_entries (id),
  -- The board the points were earned on. No foreign keys to a task or a user:
  -- the history outlives both.
  user_id               uuid,
  person_discord_id     text not null,
  person_name           text,
  amount                numeric(3, 1) not null check (amount in (-1, -0.5, 0.5, 1)),
  reason                text not null check (reason in ('approved_late', 'disapproved', 'on_time_bonus', 'missed_deadline', 'correction')),
  correction_cause      text check (correction_cause in (
                          'by_hand',            -- Lucky35 or the decider, with a note
                          'verdict_undone',     -- the reviewer took the verdict back
                          'task_dismissed',     -- the task was dismissed as not a task
                          'task_restored',      -- ... and brought back: it counts again
                          'bonus_member_lost',  -- one of a +0.5's five stopped counting
                          'excused',            -- excused by hand before this history existed
                          'deadline_moved')),   -- an old miss whose deadline was moved
  note                  text check (note is null or char_length(note) <= 500),
  -- What it is about: one task, or the five of a +0.5. Titles as they were.
  task_ids              uuid[] not null default '{}',
  task_titles           text[] not null default '{}',
  review_ids            uuid[] not null default '{}',
  miss_id               uuid,
  -- When it happened, and who decided it (null: the tracker itself).
  decided_at            timestamptz not null,
  decided_by_discord_id text,
  decided_by_name       text,
  recorded_at           timestamptz not null default now(),
  -- Written from the data that existed before this table (20261009_01).
  backfilled            boolean not null default false,
  constraint tt_score_entries_correction_shape check (
    (reason = 'correction') = (corrects is not null)
    and (corrects is null) = (correction_cause is null)
  ),
  constraint tt_score_entries_note_required check (
    backfilled
    or not (reason = 'disapproved' or correction_cause = 'by_hand')
    or char_length(btrim(coalesce(note, ''))) > 0
  )
);

comment on table public.tt_score_entries is
  'Every point a person gained or lost, and why. Append-only: a trigger refuses UPDATE, DELETE and TRUNCATE for everyone. A score is the sum of a person''s entries; a mistake is reversed by a correction (`corrects`). Written by tt_settle_scores and tt_correct_score only.';

create index if not exists tt_score_entries_person_idx on public.tt_score_entries (person_discord_id, decided_at);
create index if not exists tt_score_entries_root_idx on public.tt_score_entries (root_id, seq);
create index if not exists tt_score_entries_tasks_idx on public.tt_score_entries using gin (task_ids);
create index if not exists tt_score_entries_reviews_idx on public.tt_score_entries using gin (review_ids);
-- One −1 per verdict, one per old miss — whoever settles first.
create unique index if not exists tt_score_entries_one_per_verdict
  on public.tt_score_entries ((review_ids[1]))
  where reason in ('approved_late', 'disapproved');
create unique index if not exists tt_score_entries_one_per_miss
  on public.tt_score_entries (miss_id)
  where reason = 'missed_deadline';

-- A row's shape is the database's to decide: an original is its own chain; a
-- correction reverses exactly what it corrects, about the same person and
-- tasks, whatever the caller sent.
create or replace function public.tt_score_entry_shape()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  prev public.tt_score_entries;
begin
  if new.corrects is null then
    new.root_id := new.id;
    if new.reason in ('approved_late', 'disapproved', 'missed_deadline') and new.amount <> -1 then
      raise exception 'A % entry is −1.', new.reason;
    end if;
    if new.reason = 'on_time_bonus' and new.amount <> 0.5 then
      raise exception 'Five on time is +0.5.';
    end if;
  else
    select * into prev from public.tt_score_entries where id = new.corrects;
    if not found then
      raise exception 'There is no entry % to correct.', new.corrects;
    end if;
    new.root_id := prev.root_id;
    new.amount := -prev.amount;
    new.user_id := prev.user_id;
    new.person_discord_id := prev.person_discord_id;
    new.person_name := prev.person_name;
    new.task_ids := prev.task_ids;
    new.task_titles := prev.task_titles;
    new.review_ids := prev.review_ids;
    new.miss_id := prev.miss_id;
  end if;
  if not new.backfilled then
    new.recorded_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists tt_score_entries_shape on public.tt_score_entries;
create trigger tt_score_entries_shape
  before insert on public.tt_score_entries
  for each row
  execute function public.tt_score_entry_shape();

-- Permanent. A trigger, not only a missing grant: the service role and the
-- table's owner bypass RLS and grants, but not this.
create or replace function public.tt_score_entries_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Score history is permanent: an entry cannot be changed or removed. Add a correction instead.'
    using errcode = '42501';
end;
$$;

drop trigger if exists tt_score_entries_no_change on public.tt_score_entries;
create trigger tt_score_entries_no_change
  before update or delete on public.tt_score_entries
  for each row
  execute function public.tt_score_entries_frozen();

drop trigger if exists tt_score_entries_no_truncate on public.tt_score_entries;
create trigger tt_score_entries_no_truncate
  before truncate on public.tt_score_entries
  for each statement
  execute function public.tt_score_entries_frozen();

alter table public.tt_score_entries enable row level security;

-- Your own history; Lucky35 reads everyone's. Keyed on the Discord identity
-- Supabase Auth wrote (`tt_my_discord_id()`), never on a profile field.
drop policy if exists "own history, or everyone's for Lucky35" on public.tt_score_entries;
create policy "own history, or everyone's for Lucky35" on public.tt_score_entries
  for select to authenticated
  using (
    person_discord_id = (select public.tt_my_discord_id())
    or (select public.tt_is_score_admin())
  );

revoke all on public.tt_score_entries from anon, authenticated;
grant select on public.tt_score_entries to authenticated;

-- ---------------------------------------------------------------------------
-- 3. keeping the history in line with the verdicts
-- ---------------------------------------------------------------------------

-- One chain (an original and its corrections): make it count, or not, as its
-- source now says. A chain whose latest word is a person's (`by_hand`) is
-- left alone — the tracker never overrides a human. Returns the rows written.
create or replace function public.tt_score_follow(
  p_root uuid,
  p_stands boolean,
  p_cause text,
  p_actor_id text,
  p_actor_name text,
  p_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  last public.tt_score_entries;
  net numeric;
  who text := coalesce(p_actor_name, 'the tracker');
begin
  select coalesce(sum(amount), 0) into net from public.tt_score_entries where root_id = p_root;
  select * into last from public.tt_score_entries where root_id = p_root order by seq desc limit 1;
  if last.correction_cause = 'by_hand' then
    return 0;
  end if;
  if p_stands and net = 0 then
    insert into public.tt_score_entries (corrects, person_discord_id, amount, reason, correction_cause, note, decided_at, decided_by_discord_id, decided_by_name)
    values (last.id, last.person_discord_id, -last.amount, 'correction', 'task_restored',
            format('Counted again: %s brought the task back.', who), coalesce(p_at, now()), p_actor_id, p_actor_name);
    return 1;
  end if;
  if not p_stands and net <> 0 then
    insert into public.tt_score_entries (corrects, person_discord_id, amount, reason, correction_cause, note, decided_at, decided_by_discord_id, decided_by_name)
    values (last.id, last.person_discord_id, -last.amount, 'correction', p_cause,
            case p_cause
              when 'verdict_undone' then format('%s took the verdict back.', who)
              when 'task_dismissed' then format('%s dismissed the task as not a task.', who)
              else 'Excused.'
            end,
            coalesce(p_at, now()), p_actor_id, p_actor_name);
    return 1;
  end if;
  return 0;
end;
$$;

revoke all on function public.tt_score_follow(uuid, boolean, text, text, text, timestamptz) from public, anon, authenticated;

-- Bring a person's history (or everyone's, p_person null) in line with what
-- the verdicts and the old misses say now:
--   * a verdict that costs a point (approve late, disapprove) has its −1
--     while it stands; undone or dismissed, a correction gives it back;
--   * an old missed deadline likewise (they are only ever dismissed now);
--   * every five approvals on time not yet in a +0.5 earn one — oldest first,
--     across every board — and a +0.5 one of whose five stopped counting is
--     taken back, the other four going towards the next.
-- Idempotent, and serialised per person. `p_at` stamps what it writes; null
-- (the backfill) dates a +0.5 when its fifth approval was given.
create or replace function public.tt_settle_scores(
  p_person text default null,
  p_actor_id text default null,
  p_actor_name text default null,
  p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person text;
  r record;
  m record;
  b record;
  lost record;
  root uuid;
  last public.tt_score_entries;
  net numeric;
  pool uuid[];
  fifth public.tt_task_reviews;
  written integer := 0;
begin
  for v_person in
    select distinct x.who
    from (
      select assignee_discord_id as who from public.tt_task_reviews
      union select assignee_discord_id from public.tt_deadline_misses
    ) x
    where x.who is not null and btrim(x.who) <> '' and (p_person is null or x.who = p_person)
  loop
    perform pg_advisory_xact_lock(hashtextextended('tt_score:' || v_person, 0));

    -- (a) verdicts that cost a point
    for r in
      select v.*, (v.excused_at is null) as stands
      from public.tt_task_reviews v
      where v.assignee_discord_id = v_person
        and v.decision in ('approve_late', 'disapprove_close', 'disapprove_reopen')
      order by v.decided_at, v.id
    loop
      select e.id into root
      from public.tt_score_entries e
      where e.reason in ('approved_late', 'disapproved') and e.review_ids[1] = r.id;
      if root is null then
        if r.stands then
          insert into public.tt_score_entries (user_id, person_discord_id, person_name, amount, reason, note,
                                              task_ids, task_titles, review_ids, decided_at, decided_by_discord_id, decided_by_name)
          values (r.user_id, v_person, r.assignee_name, -1,
                  case when r.decision = 'approve_late' then 'approved_late' else 'disapproved' end,
                  r.note, array[r.task_id], array[r.task_title], array[r.id], r.decided_at, r.reviewer_discord_id, r.reviewer_name);
          written := written + 1;
        end if;
      else
        written := written + public.tt_score_follow(
          root, r.stands,
          case r.excused_reason when 'undone' then 'verdict_undone' when 'dismissed' then 'task_dismissed' else 'excused' end,
          p_actor_id, p_actor_name, p_at);
      end if;
    end loop;

    -- (b) deadlines missed before reviews scored everything
    for m in
      select d.*, (d.excused_at is null) as stands
      from public.tt_deadline_misses d
      where d.assignee_discord_id = v_person
      order by d.deadline, d.id
    loop
      select e.id into root from public.tt_score_entries e where e.reason = 'missed_deadline' and e.miss_id = m.id;
      if root is null then
        if m.stands then
          insert into public.tt_score_entries (user_id, person_discord_id, person_name, amount, reason, note,
                                              task_ids, task_titles, miss_id, decided_at)
          values (m.user_id, v_person, m.assignee_name, -1, 'missed_deadline', 'Missed the deadline, before reviews decided the score.',
                  array[m.task_id], array[m.task_title], m.id, m.deadline);
          written := written + 1;
        end if;
      else
        written := written + public.tt_score_follow(
          root, m.stands,
          case m.excused_reason when 'dismissed' then 'task_dismissed' when 'redated' then 'deadline_moved' else 'excused' end,
          p_actor_id, p_actor_name, p_at);
      end if;
    end loop;

    -- (c) a +0.5 whose five no longer all count is taken back
    for b in
      select e.*
      from public.tt_score_entries e
      where e.person_discord_id = v_person and e.reason = 'on_time_bonus'
      order by e.seq
    loop
      select coalesce(sum(amount), 0) into net from public.tt_score_entries where root_id = b.id;
      select * into last from public.tt_score_entries where root_id = b.id order by seq desc limit 1;
      continue when net = 0 or last.correction_cause = 'by_hand';
      -- A verdict gone with its deleted task still counts: the history keeps it.
      select v.task_title, v.excused_reason into lost
      from public.tt_task_reviews v
      where v.id = any (b.review_ids) and v.excused_at is not null
      order by v.excused_at
      limit 1;
      continue when not found;
      insert into public.tt_score_entries (corrects, person_discord_id, amount, reason, correction_cause, note,
                                          decided_at, decided_by_discord_id, decided_by_name)
      values (last.id, v_person, -last.amount, 'correction', 'bonus_member_lost',
              format('"%s" no longer counts as approved on time (%s), so this +0.5 is taken back; the other %s count towards the next one.',
                     lost.task_title,
                     case lost.excused_reason when 'undone' then 'its verdict was taken back'
                                              when 'dismissed' then 'the task was dismissed'
                                              else 'it was excused' end,
                     cardinality(b.review_ids) - 1),
              coalesce(p_at, now()), p_actor_id, p_actor_name);
      written := written + 1;
    end loop;

    -- (d) every five approved on time, not yet in a +0.5 that still holds them
    loop
      select array_agg(p.id order by p.decided_at, p.id) into pool
      from (
        select v.id, v.decided_at
        from public.tt_task_reviews v
        where v.assignee_discord_id = v_person
          and v.decision = 'approve_on_time'
          and v.excused_at is null
          and not exists (
            select 1
            from public.tt_score_entries e
            where e.reason = 'on_time_bonus'
              and v.id = any (e.review_ids)
              -- released only when the +0.5's latest word is "one of the five stopped counting"
              and not exists (
                select 1 from public.tt_score_entries c
                where c.root_id = e.id and c.correction_cause = 'bonus_member_lost'
                  and not exists (select 1 from public.tt_score_entries d where d.corrects = c.id)
              )
          )
        order by v.decided_at, v.id
        limit 5
      ) p;
      exit when coalesce(cardinality(pool), 0) < 5;
      select * into fifth from public.tt_task_reviews where id = pool[5];
      insert into public.tt_score_entries (user_id, person_discord_id, person_name, amount, reason, note,
                                          task_ids, task_titles, review_ids, decided_at, decided_by_discord_id, decided_by_name)
      select fifth.user_id, v_person, fifth.assignee_name, 0.5, 'on_time_bonus', '5 tasks approved on time.',
             array_agg(v.task_id order by u.ord), array_agg(v.task_title order by u.ord), pool,
             coalesce(p_at, fifth.decided_at), fifth.reviewer_discord_id, fifth.reviewer_name
      from unnest(pool) with ordinality as u(id, ord)
      join public.tt_task_reviews v on v.id = u.id;
      written := written + 1;
    end loop;
  end loop;
  return written;
end;
$$;

revoke all on function public.tt_settle_scores(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.tt_settle_scores(text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 4. a verdict, its task and its points in one transaction
-- ---------------------------------------------------------------------------
-- Until now the verdict was inserted, the task updated if it had not moved,
-- and the verdict deleted again if it had. With points that can never be
-- deleted, that order is not allowed: the task is locked, checked, changed,
-- and the verdict and its points written, together or not at all.

-- What a verdict (or taking one back) may change on a task — the fields of
-- `VERDICT_FIELDS` in lib/review.ts, the derived schedule, and who did it.
-- Anything else is refused, so the two lists cannot drift apart unnoticed.
create or replace function public.tt_apply_verdict_changes(p_task public.tt_tasks, p_changes jsonb)
returns public.tt_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  bad text;
  n public.tt_tasks;
begin
  select k into bad
  from jsonb_object_keys(p_changes) as k
  where k <> all (array[
    'status', 'stage', 'stage_at', 'completed_at', 'completed_by', 'review_state', 'reviewed_at', 'review_note',
    'review_rejections', 'review_nudge_at', 'deadline', 'deadline_source', 'alert_every_minutes',
    'assignee_overdue_alerts', 'next_alert_at', 'last_actor_discord_id', 'last_actor_name', 'last_actor_at'
  ])
  limit 1;
  if bad is not null then
    raise exception 'A verdict cannot change "%".', bad;
  end if;
  n := jsonb_populate_record(p_task, p_changes);
  update public.tt_tasks set
    status = n.status,
    stage = n.stage,
    stage_at = n.stage_at,
    completed_at = n.completed_at,
    completed_by = n.completed_by,
    review_state = n.review_state,
    reviewed_at = n.reviewed_at,
    review_note = n.review_note,
    review_rejections = n.review_rejections,
    review_nudge_at = n.review_nudge_at,
    deadline = n.deadline,
    deadline_source = n.deadline_source,
    alert_every_minutes = n.alert_every_minutes,
    assignee_overdue_alerts = n.assignee_overdue_alerts,
    next_alert_at = n.next_alert_at,
    last_actor_discord_id = n.last_actor_discord_id,
    last_actor_name = n.last_actor_name,
    last_actor_at = n.last_actor_at
  where id = p_task.id
  returning * into n;
  return n;
end;
$$;

revoke all on function public.tt_apply_verdict_changes(public.tt_tasks, jsonb) from public, anon, authenticated;

-- Give a verdict. Null when the task is no longer where the reviewer saw it
-- (status or review state moved): nothing is written.
create or replace function public.tt_give_verdict(
  p_task uuid,
  p_status text,
  p_review_state text,
  p_changes jsonb,
  p_review jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tt_tasks;
  n public.tt_tasks;
  v public.tt_task_reviews;
begin
  select * into t from public.tt_tasks where id = p_task for update;
  if not found or t.status is distinct from p_status or t.review_state is distinct from p_review_state then
    return null;
  end if;
  n := public.tt_apply_verdict_changes(t, p_changes);
  v := jsonb_populate_record(null::public.tt_task_reviews, p_review);
  insert into public.tt_task_reviews (user_id, task_id, reviewer_discord_id, reviewer_name, assignee_discord_id, assignee_name,
                                     task_title, decision, note, deadline, new_deadline, finished_at, decided_at, before, after)
  values (t.user_id, t.id, v.reviewer_discord_id, v.reviewer_name, v.assignee_discord_id, v.assignee_name,
          v.task_title, v.decision, v.note, v.deadline, v.new_deadline, v.finished_at, coalesce(v.decided_at, now()), v.before, v.after)
  returning * into v;
  perform public.tt_settle_scores(v.assignee_discord_id, v.reviewer_discord_id, v.reviewer_name, v.decided_at);
  return jsonb_build_object('task', to_jsonb(n), 'review', to_jsonb(v));
end;
$$;

revoke all on function public.tt_give_verdict(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.tt_give_verdict(uuid, text, text, jsonb, jsonb) to service_role;

-- Take a verdict back: marked 'undone', the task put back, and its points
-- corrected — together. Null when the task moved meanwhile.
create or replace function public.tt_undo_verdict(
  p_review uuid,
  p_task uuid,
  p_status text,
  p_review_state text,
  p_changes jsonb,
  p_actor_id text,
  p_actor_name text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tt_tasks;
  n public.tt_tasks;
  v public.tt_task_reviews;
begin
  select * into t from public.tt_tasks where id = p_task for update;
  if not found or t.status is distinct from p_status or t.review_state is distinct from p_review_state then
    return null;
  end if;
  update public.tt_task_reviews
  set excused_at = coalesce(p_at, now()), excused_reason = 'undone'
  where id = p_review and task_id = p_task and excused_reason is distinct from 'undone'
  returning * into v;
  if not found then
    raise exception 'It was already taken back.' using errcode = 'P0001';
  end if;
  n := public.tt_apply_verdict_changes(t, p_changes);
  perform public.tt_settle_scores(v.assignee_discord_id, p_actor_id, p_actor_name, coalesce(p_at, now()));
  return jsonb_build_object('task', to_jsonb(n), 'review', to_jsonb(v));
end;
$$;

revoke all on function public.tt_undo_verdict(uuid, uuid, text, text, jsonb, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.tt_undo_verdict(uuid, uuid, text, text, jsonb, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5. a correction by hand
-- ---------------------------------------------------------------------------
-- Lucky35, or whoever made the decision, reverses one entry — named directly
-- (the history page), or as the −1 of a verdict (the task's activity, where a
-- reviewer who is not Lucky35 can see it). A note is required. The entry
-- stays; the correction is listed beside it.
create or replace function public.tt_correct_score(p_entry uuid, p_review uuid, p_note text)
returns public.tt_score_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  me text := public.tt_my_discord_id();
  my_name text;
  e public.tt_score_entries;
  r public.tt_task_reviews;
  c public.tt_score_entries;
  why text := btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g'));
  allowed boolean;
begin
  if me is null then
    raise exception 'Sign in with Discord to correct a score.' using errcode = '42501';
  end if;
  if why = '' then
    raise exception 'Say why — a correction needs a note.' using errcode = '23514';
  end if;
  if char_length(why) > 500 then
    why := left(why, 499) || '…';
  end if;

  if p_entry is not null then
    select * into e from public.tt_score_entries where id = p_entry;
    if not found then
      raise exception 'That entry does not exist.' using errcode = 'P0002';
    end if;
    -- The entry's own decider; for a verdict's −1, also the verdict's reviewer.
    select * into r from public.tt_task_reviews where id = e.review_ids[1] and cardinality(e.review_ids) = 1;
    allowed := public.tt_is_score_admin() or e.decided_by_discord_id = me or (r.id is not null and r.reviewer_discord_id = me);
  elsif p_review is not null then
    select * into r from public.tt_task_reviews where id = p_review;
    if not found then
      raise exception 'That verdict does not exist.' using errcode = 'P0002';
    end if;
    -- The latest word on that verdict's −1.
    select x.* into e
    from public.tt_score_entries x
    where x.root_id = (select o.id from public.tt_score_entries o where o.reason in ('approved_late', 'disapproved') and o.review_ids[1] = r.id)
    order by x.seq desc
    limit 1;
    if not found then
      raise exception 'That verdict moved no points.' using errcode = 'P0002';
    end if;
    -- From the task, only a point that still counts is corrected; putting one
    -- back is done entry by entry, on the history.
    if (select sum(x.amount) from public.tt_score_entries x where x.root_id = e.root_id) = 0 then
      raise exception 'That verdict counts nothing now — there is nothing to correct.' using errcode = '23505';
    end if;
    allowed := public.tt_is_score_admin() or r.reviewer_discord_id = me or e.decided_by_discord_id = me;
  else
    raise exception 'Say which entry to correct.' using errcode = '22023';
  end if;

  if not allowed then
    raise exception 'Only Lucky35, or whoever made this decision, can correct it.' using errcode = '42501';
  end if;
  if exists (select 1 from public.tt_score_entries x where x.corrects = e.id) then
    raise exception 'It has already been corrected — correct the correction to put it back.' using errcode = '23505';
  end if;

  select coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'user_name', i.identity_data ->> 'name')
    into my_name
  from auth.identities i
  where i.user_id = auth.uid() and i.provider = 'discord'
  order by i.created_at
  limit 1;

  perform pg_advisory_xact_lock(hashtextextended('tt_score:' || e.person_discord_id, 0));
  insert into public.tt_score_entries (corrects, person_discord_id, amount, reason, correction_cause, note,
                                      decided_at, decided_by_discord_id, decided_by_name)
  values (e.id, e.person_discord_id, -e.amount, 'correction', 'by_hand', why, now(), me, my_name)
  returning * into c;
  return c;
end;
$$;

revoke all on function public.tt_correct_score(uuid, uuid, text) from public, anon;
grant execute on function public.tt_correct_score(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. dismissing a task gives its points back; restoring counts them again
-- ---------------------------------------------------------------------------
-- The trigger already excused a dismissed task's verdicts and misses
-- (20261007_01). It now writes the corrections too, credited to whoever
-- dismissed it.
create or replace function public.tt_note_missed_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who_id text;
  who_name text;
  person text;
begin
  if new.status = 'dismissed' and old.status <> 'dismissed' then
    update public.tt_deadline_misses
    set excused_at = now(), excused_reason = 'dismissed'
    where task_id = new.id and excused_at is null;
    update public.tt_task_reviews
    set excused_at = now(), excused_reason = 'dismissed'
    where task_id = new.id and excused_at is null;
  elsif old.status = 'dismissed' and new.status <> 'dismissed' then
    update public.tt_deadline_misses
    set excused_at = null, excused_reason = null
    where task_id = new.id and excused_reason = 'dismissed';
    update public.tt_task_reviews
    set excused_at = null, excused_reason = null
    where task_id = new.id and excused_reason = 'dismissed';
  else
    return new;
  end if;

  if auth.uid() is not null then
    select i.provider_id, coalesce(i.identity_data ->> 'full_name', i.identity_data ->> 'user_name', i.identity_data ->> 'name')
      into who_id, who_name
    from auth.identities i
    where i.user_id = auth.uid() and i.provider = 'discord'
    order by i.created_at
    limit 1;
  elsif new.last_actor_at is distinct from old.last_actor_at then
    who_id := new.last_actor_discord_id;
    who_name := new.last_actor_name;
  end if;

  for person in
    select assignee_discord_id from public.tt_task_reviews where task_id = new.id and assignee_discord_id is not null
    union
    select assignee_discord_id from public.tt_deadline_misses where task_id = new.id
  loop
    perform public.tt_settle_scores(person, who_id, who_name, now());
  end loop;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. nothing edits a verdict or a miss from the board any more
-- ---------------------------------------------------------------------------
-- "Excuse" flipped `excused_at` in place. A correction replaces it.
drop policy if exists "own reviews excusable" on public.tt_task_reviews;
drop policy if exists "own misses excusable" on public.tt_deadline_misses;
revoke update on public.tt_task_reviews from authenticated;
revoke update on public.tt_deadline_misses from authenticated;

-- ---------------------------------------------------------------------------
-- 8. proof outlives its task, for the history that points at it
-- ---------------------------------------------------------------------------
-- An entry opens onto its task's proof, and entries remain when the task is
-- deleted — so a proof row no longer goes with it.
alter table public.tt_task_proofs drop constraint if exists tt_task_proofs_task_id_fkey;
create index if not exists tt_task_proofs_task_idx on public.tt_task_proofs (task_id);

drop policy if exists "proofs readable" on public.tt_task_proofs;
create policy "proofs readable" on public.tt_task_proofs
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.tt_tasks t
      where t.id = task_id
        and (
          t.assignee_discord_id = (select public.tt_my_discord_id())
          or t.requested_by_discord_id = (select public.tt_my_discord_id())
        )
    )
    -- The proof behind a point: Lucky35, and the person it is about.
    or (select public.tt_is_score_admin())
    or exists (
      select 1
      from public.tt_score_entries e
      where e.person_discord_id = (select public.tt_my_discord_id())
        and task_id = any (e.task_ids)
    )
  );

-- ---------------------------------------------------------------------------
-- 9. the history before today
-- ---------------------------------------------------------------------------
-- Every point the old rules gave, at the time it was given; every excuse as a
-- correction at the time it was excused. Misses excused the moment they were
-- recorded (before scoring began, or already past when given) never counted,
-- and are not points.

-- (a) verdicts that cost a point
insert into public.tt_score_entries (user_id, person_discord_id, person_name, amount, reason, note,
                                    task_ids, task_titles, review_ids, decided_at, decided_by_discord_id, decided_by_name, backfilled, recorded_at)
select v.user_id, v.assignee_discord_id, v.assignee_name, -1,
       case when v.decision = 'approve_late' then 'approved_late' else 'disapproved' end,
       v.note, array[v.task_id], array[v.task_title], array[v.id], v.decided_at, v.reviewer_discord_id, v.reviewer_name, true, now()
from public.tt_task_reviews v
where v.decision in ('approve_late', 'disapprove_close', 'disapprove_reopen')
  and v.assignee_discord_id is not null
  and not exists (select 1 from public.tt_score_entries e where e.reason in ('approved_late', 'disapproved') and e.review_ids[1] = v.id)
order by v.decided_at, v.id;

insert into public.tt_score_entries (corrects, person_discord_id, amount, reason, correction_cause, note, decided_at, backfilled, recorded_at)
select e.id, e.person_discord_id, 1, 'correction',
       case v.excused_reason when 'undone' then 'verdict_undone' when 'dismissed' then 'task_dismissed' else 'excused' end,
       case v.excused_reason when 'undone' then 'The verdict was taken back.'
                             when 'dismissed' then 'The task was dismissed as not a task.'
                             else 'Excused by hand.' end,
       v.excused_at, true, now()
from public.tt_task_reviews v
join public.tt_score_entries e on e.reason in ('approved_late', 'disapproved') and e.review_ids[1] = v.id
where v.excused_at is not null
  and not exists (select 1 from public.tt_score_entries c where c.corrects = e.id)
order by v.excused_at, v.id;

-- (b) deadlines missed before reviews
insert into public.tt_score_entries (user_id, person_discord_id, person_name, amount, reason, note,
                                    task_ids, task_titles, miss_id, decided_at, backfilled, recorded_at)
select m.user_id, m.assignee_discord_id, m.assignee_name, -1, 'missed_deadline',
       'Missed the deadline, before reviews decided the score.',
       array[m.task_id], array[m.task_title], m.id, m.deadline, true, now()
from public.tt_deadline_misses m
where (m.excused_reason is null or m.excused_reason in ('dismissed', 'redated', 'by_hand'))
  and not exists (select 1 from public.tt_score_entries e where e.reason = 'missed_deadline' and e.miss_id = m.id)
order by m.deadline, m.id;

insert into public.tt_score_entries (corrects, person_discord_id, amount, reason, correction_cause, note, decided_at, backfilled, recorded_at)
select e.id, e.person_discord_id, 1, 'correction',
       case m.excused_reason when 'dismissed' then 'task_dismissed' when 'redated' then 'deadline_moved' else 'excused' end,
       case m.excused_reason when 'dismissed' then 'The task was dismissed as not a task.'
                             when 'redated' then 'The deadline was moved — only the last one counts.'
                             else 'Excused by hand.' end,
       m.excused_at, true, now()
from public.tt_deadline_misses m
join public.tt_score_entries e on e.reason = 'missed_deadline' and e.miss_id = m.id
where m.excused_at is not null
  and not exists (select 1 from public.tt_score_entries c where c.corrects = e.id)
order by m.excused_at, m.id;

-- (c) every five approved on time, dated when the fifth was given
select public.tt_settle_scores(null, null, null, null);

-- ---------------------------------------------------------------------------
-- 10. live
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tt_score_entries'
     ) then
    alter publication supabase_realtime add table public.tt_score_entries;
  end if;
end;
$$;

notify pgrst, 'reload schema';
