-- Task Tracker — a disapproval with no note must not stall the score history.
--
-- 20261009_01 requires a note on every disapproval's −1 (the PO's rule), and
-- the code now asks for one before it records the verdict. But a verdict can
-- reach the database without one — given by the build deployed before that
-- code, or by a future path that forgets — and then `tt_settle_scores`
-- raised on the note check: one bad row stopped the sweep for EVERY person,
-- every minute. Such a −1 still counts; its entry now says plainly that no
-- reason was recorded. Only the function changes; nothing is written.

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
                  -- A disapproval given before notes were required (or by code
                  -- that did not ask) still counts; it says it has no reason
                  -- rather than failing the note check and stalling every
                  -- person's settling behind it.
                  case when r.decision = 'approve_late' then r.note
                       else coalesce(nullif(btrim(r.note), ''), 'No reason was recorded with this disapproval.') end,
                  array[r.task_id], array[r.task_title], array[r.id], r.decided_at, r.reviewer_discord_id, r.reviewer_name);
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

notify pgrst, 'reload schema';
