# task-tracker — conventions

See `AGENTS.md` for the traps, and `DESIGN.md` for the visual language
(inherited from `vdm-project-manager`, which inherited it from `impressions`).

- Stack: Next.js 16 (App Router, Turbopack) + Supabase + Tailwind 4 + pnpm.
  Follow the `normal-stack` skill.
- **Auth is required everywhere.** Unlike `vdm-project-manager`, this app has a
  login. Every page starts with `requireUser()`, every API route with
  `getUser()`. `anon` has no policy on any table.
- **Secrets never reach the browser.** `tt_connections` has RLS on and no
  policies; only the service role reads it. The browser gets
  `tt_connection_status`, a view of booleans and hints. If you find yourself
  adding a policy to `tt_connections`, stop — you are about to publish
  everyone's Discord bot tokens.
- **There is no app-level Anthropic key and no shared Discord bot.** Every read
  runs on the credentials of the person whose messages are being read. Do not
  add a fallback key "so it works out of the box"; the absence of one is the
  privacy guarantee.
- Ordinary mutations happen from the client via `createSupabaseBrowserClient()`,
  applied optimistically and rolled back on failure (`mutate()` in
  `components/tracker.tsx`). API routes exist only where a secret or the Discord
  API is involved. Do not add a parallel write path without a reason.
- **`next_alert_at` is derived, never typed.** Anything that changes a task's
  deadline, cadence or status must route through `withSchedule()` in the UI or
  `nextAlertFor()` in the worker and routes. Writing it directly is how the scheduler
  gets out of step with the row it is scheduling.
- **Deadlines are set by the classifier, and overridden by hand.** When the
  model resolves a real time out of the message's own words, `classifyUser`
  writes `deadline` directly — with a cadence and a derived `next_alert_at`, so
  the reminder is live in the same tick. `tt_tasks.deadline_source` records who
  set it, and **a later pass never overwrites `'manual'`**. Every decision lives
  in `decideAutoDeadline()` in `lib/deadlines.ts`; the classifier resolves
  against the message's own `sent_at` **in the user's `tt_profiles.timezone`**,
  and refuses to auto-apply a date already in the past — which is what stops a
  backfill retro-dating months of history into live reminders. When the model
  returns nothing, `pickDeadlinePhrase()` reads the message's own words
  ("deadline is 24 hours") before giving up — only shapes that say "deadline"
  (a cue word, or a duration standing alone after the ask), never a bare day
  name or "in 5 minutes": an invented deadline DMs people. "next Tuesday" is
  the nearest Tuesday, the same as "Tuesday" (Lucky35, 2026-09-30). *(Erik
  reversed the old manual-deadline rule in session on 2026-09-07. Stage and
  grade are still the human's: the machine fills the row, the human still
  judges it.)*
- **Grading is manual.** The classifier never writes `grade`. It may fill a
  person's row with facts; the score is Erik's. That is why `tt_people.grade`
  carries a CHECK constraint rather than only a comment.
- `app/page.tsx`, `app/settings/page.tsx` and `app/summary/page.tsx` are
  `force-dynamic`: the worker changes them between requests; none is cached.
- New Anthropic API code: read the `claude-api` skill first. Default model is
  `claude-opus-5`; never downgrade for cost without being asked.
- **A task starts with "@bot", and every tag is answered.** Only a message that
  tags the user's own bot — `<@botId>`, or `<@&roleId>` for the role Discord
  made for it in that server (learned into `tt_connections.discord_bot_role_ids`)
  — is stored at all; `mentions` is never read for this. The classifier sorts
  each one (`category`): only `task` becomes a card, answered ✅ on Discord;
  thanks / chatter / question / command get 👀, no card, a fixed reply for a
  question or command (`skipReply`), and a row on the board's "Not filed" list
  via `tt_messages.skip_category`. The same words to the same people tagged
  again while that task is open get ✅ and no second card (`requestKey` keys on
  both; `skip_category = 'duplicate'`). No recognisable assignee or deadline still makes a task, shown
  on the board as missing it. **Never add a path that closes a tagged message
  off silently** — it gets a card, or 👀 and a "Not filed" row, and "Not filed"
  rows never age off: only a person clears one (`skip_reviewed_at`), and every
  one stays reachable — the board pages back through all of them and searches
  all of them on the server, never just the newest hundred. Where the bot may
  not react, that is recorded (`tt_channels.react_error`) and shown at the top
  of the board. A reaction only answers a tagger who is looking at the message,
  so every tag that was read LATE (`lateAnswer`: a slow read, a tag added by an
  edit, anything Backfill finds) or could not be MARKED is owed a DM
  (`tt_messages.answer_owed`), paid from the database by `sendOwedAnswers`
  (`lib/tag-answers.ts`): one DM per person, at most one per person every
  `ANSWER_DM_EVERY_MS`, to whoever tagged — the owner in their place when they
  cannot be DMed. A missing ✅ must never be mistaken for "unread", and a ✅
  nobody saw is not an answer. History is never replied to in public, and a
  command found in history is read as a tag, never replayed. The poller reads
  the newest page first, so a tag added by editing a recent message is read;
  a forward is read by what it forwards (`readableMessage`); a bot's or
  webhook's post is read like anyone's (`isApp`, `from_app`) but never replied
  to in public. Someone ELSE tagging the bot without naming the owner is
  filed when they have signed in to the tracker (a teammate, see below);
  a stranger's is answered (👀 and `foreignTagReply`) and nothing of it is
  stored. A message Claude cannot read is retried alone and, after
  `MAX_CLASSIFY_ATTEMPTS`, filed from its own words — it never blocks the queue.
  *(Lucky35: 2026-09-28 "only tagged messages", 2026-09-29 "no silent misses,
  no junk cards", 2026-09-29 and 2026-09-30 "no gap may be silent".)*
- **Everyone a message tags gets their own card** (`lib/tagged.ts`) — never a
  pick between them, never nobody because there were two. Only the first card
  keeps `message_id` (`tt_tasks_one_per_message`, which the previous worker
  upserts on); every card carries `source_message_id` + `message_part`, and
  that pair is the idempotency key for the rest. Look a message's cards up by
  `source_message_id`, never `message_id` with `.maybeSingle()`. A reply to the
  message applies to all of them. *(Lucky35's PO, 2026-10-05.)* EXCEPT anyone
  tagged only after "cc", "cc:", "/cc" or "fyi" (`splitCc`): copied in, no card,
  named on the cards as CC (`tt_tasks.cc`, `20261020_01`) — the words decide,
  never a model's guess (the user, 2026-10-20). A card given to someone only
  copied in is closed by its owner or its asker (`/api/tasks/not-for`:
  dismissed, `dismiss_reason = 'only_cc'`, points corrected, they are DMed);
  its person may say "Not mine" (`/api/tasks/not-mine`: activity + the
  reviewer DMed, nothing changed).
- **The score is a permanent history** (`tt_score_entries`, `20261009_01`;
  PO, 2026-10-09): every −1 (approved late; disapproved, its note required)
  and every +0.5 (five approved on time, the five listed — cumulative, not a
  streak) is a row: whose, how much, why, which task, when, who decided. A
  score IS the sum of a person's entries. Nothing ever updates or deletes one
  — a trigger refuses it, the service role included — and no foreign key ties
  it to a task, so it outlives a deleted one. A mistake gets a CORRECTION: a
  new entry of the opposite amount (`corrects`), listed beside the original.
  Points are written in the database only: `tt_settle_scores` brings the
  history in line with the verdicts (a correction when a verdict is undone or
  its task dismissed or restored; a +0.5 taken back when one of its five stops
  counting, the other four kept for the next — never over a correction made by
  hand), run by `tt_give_verdict` / `tt_undo_verdict` in the verdict's own
  transaction and swept each tick; by hand only `tt_correct_score`, for
  Lucky35 (`tt_score_admins`) or whoever decided, with a note. Each person
  reads their own history and Lucky35 everyone's (RLS on
  `tt_my_discord_id()` / `tt_is_score_admin()`); a board owner who is not
  Lucky35 sees no one else's points, not a misleading 0. `/scores`: per
  person by day, week (Monday) or month in the viewer's zone, entries
  underneath, CSV for Lucky35 — all from `lib/score-history.ts`. A Minus or
  Plus figure opens exactly the entries it counted (`entriesOfSign`); each
  minus shows its deadline and report (`lateLine`), note and task. A deadline
  passing costs nothing by itself. To give more time on open work: the
  board's +1h / +6h / +1 day, or a reply "6 more hours" (`extendDeadline`).
- **Developers is the one thing shared across accounts by choice.** The owner
  names editors (`tt_dev_editors`, by Discord id); `tt_keeps_dev_list()` asks
  `tt_my_discord_id()`. Who changed a row is written by a trigger from
  `auth.identities`, never sent by the browser. An editor picks developers
  from the OWNER's servers (`/api/members?owner=`, the owner's bot, allowed
  only when `tt_keeps_dev_list` says yes on the editor's own session).
  ClickUp feeds ONE owner's list (`CLICKUP_API_KEY` / `_WORKSPACE_ID` /
  `_DEVELOPERS_OWNER`, `lib/clickup-sync.ts`, `20261012_01`): a row linked to
  a ClickUp person carries what is open on them there (`clickup_tasks`,
  ClickUp's own statuses), written by the worker alone; the hand-kept fields
  stay editable, and a sync write never moves "who changed it, and when".
  Everyone with unfinished ClickUp work is ADDED by the sync
  (`peopleWithOpenWork`, `added_from = 'clickup'`, `20261012_02`) and never
  removed by it: a linked row is hidden (`hidden_at`), not deleted.
  EVERY ClickUp task, done ones too, is a row of `tt_clickup_tasks`
  (`20261012_03`): the managers (owner + keepers) read all, a developer only
  those assigned to them (`tt_my_clickup_ids`, from their row's Discord id) —
  never the managers' note or hand-set status about them. A row's Discord
  person is matched by exact verified email (`linksByEmail`,
  `tt_tracker_identities`, service role only) or set by a manager. The read
  runs on its OWN cron, `/api/cron/clickup` (`vercel.json`), never inside
  the tick.
- **Channels are found by themselves.** Every `CHANNEL_SYNC_EVERY_MS` the
  worker lists the bot's servers and channels (`discoverChannels` →
  `syncChannels`, the same as Refresh), and a channel never seen before is
  added WATCHED, read from the later of its creation and the account's last
  look (`seedCursor`, `tt_connections.channels_synced_at`, never more than
  `MAX_LOOK_BACK_MS` back). A known channel's switch, cursor and history are
  never touched. Waiting for someone to press Refresh is how a whole server's
  tags went unread (2026-10-06).
- **The bot's role is learned before history is read.** `ensureBotRole`
  (`lib/bot-roles.ts`) runs on Refresh, before Backfill, and on the first live
  mention of an unknown role. A failed lookup stops the read instead of
  passing over what it could not place; a role learned late flags the history
  already read (`tt_channels.rescan_reason`) for Backfill to redo.
- **The assignee can read what they were given, and answer it — nothing else.**
  One SELECT-only policy on `tt_tasks`, keyed on `tt_my_discord_id()`, which
  reads `auth.identities`. Do not widen it, and never key access on
  `tt_profiles.discord_user_id` — its owner can edit it. A board therefore holds
  rows owned by other accounts: check `isShared()` before any write. The
  assignee's only writes — start, done, stop / resume reminders — go through
  `/api/tasks/assignee`, which checks `tt_my_discord_id()` on the caller's own
  session and DMs the giver (`lib/assignee.ts`).
- **A teammate hands out work through the owner's bot.** A tag of the bot
  by someone signed in to the tracker (`tt_tracker_discord_ids()`, read once
  a tick) that does not name the owner is `sent`, filed on the OWNER's board
  with `requested_by_*` — as is work asked OF the owner (`received`). The
  owner's bot reminds and the owner reviews; the asker reads it through a
  second SELECT-only policy ("tasks I asked for readable", on
  `tt_my_discord_id()`) and sees it under "I asked for" (`askedByViewer`),
  read only. A teammate's reply is never a command. *(Lucky35, 2026-10-06.)*
- **Reminders go to the giver and to the assignee** — the assignee's copy by DM
  only, from the giver's own bot, and first, so the giver's copy carries a line
  on how the assignee's stream is going (`assigneeStatusLine`). The assignee
  gets at most `ASSIGNEE_OVERDUE_LIMIT` DMs after the deadline, then the giver
  is told to follow up; either side can switch the assignee's reminders off.
  The same `next_alert_at` drives both — it is the next moment EITHER stream is
  due. The cadence on the row is the giver's: "No reminder" silences the
  giver's copy only, and the assignee keeps theirs at
  `ASSIGNEE_FALLBACK_CADENCE_MINUTES` (Lucky35, 2026-09-30). A new assignee
  starts a fresh stream (`FRESH_ASSIGNEE_STREAM`).
- **One clock decides "overdue" on the board.** The board's `now` ticks every
  30s AND at the exact next deadline (`nextDeadlineAfter`); `LiveCountdown`
  takes its overdue state from that, never from its own seconds. Do not let a
  leaf decide urgency for itself — that is how a card said "Overdue" while the
  count beside it did not.
- **Every time on the page is in the person's zone.** `formatWhen`,
  `toZonedInput` and `bucketOf(…, timeZone)` read `tt_profiles.timezone` from
  `TimeZoneContext`, never the machine's, and the board's clock starts at the
  server's `renderedAt` — so the server (UTC on Vercel) and the browser render
  the same page. `toLocaleString()` in a component is a hydration bug.
- **A DM to the bot is a tag; a DM between people is never read.** The worker
  reads the bot's own DMs — with its owner and the people the owner gave work
  to or noted in `DM_PEOPLE_WINDOW_DAYS` (`pollDms`, `tt_dm_channels`; a bot
  cannot discover a DM a stranger opened). The owner's DM is filed like a
  tag (`tt_messages.via_dm`) and answered in the DM; names typed as words are
  matched by `whoIsItFor` (known people, then `searchGuildMembers`), never
  guessed: only an EXACT match to one person the owner has worked with
  (`exactKnown`) assigns; anything else files the task with nobody on it and
  `assignee_candidates` for the owner to pick — by number in the DM, or on the
  board — and nobody is DMed until they do. Anyone else's DM is
  `direction = 'dm_in'` until `runDirectMessages` reads it: `done` / `stop` /
  `resume` go through `applyAssigneeAnswer` (`lib/assignee-server.ts`, the same
  path as the board's); a request is filed only after its SENDER replies
  `yes` to the bot's question (`confirm_message_id`, `confirmed_at`); small
  talk gets 👀 and is neither a card nor a "Not filed" row. A reply to the
  bot's own message finds its task through `tt_alerts.message_id` — keep
  storing it on every DM the bot sends about a task — and a reply about a task
  closed or moved on is answered as such. A conversation once opened is never
  dropped: active ones every minute, the rest at least hourly
  (`DM_QUIET_POLL_MS`). *(Lucky35, 2026-10-02 and 2026-10-03.)*
- **Every assignee is told, once.** A channel tag @-mentions them
  (`assignee_told_at` stamped at birth); anything else — a DM task, a hand-made
  card, a reassignment (`FRESH_ASSIGNEE_STREAM`) — is DMed by `tellAssignees`.
  **My tasks** (`/?mine`, `components/my-tasks.tsx`, `groupMine`) is the one
  place an assignee sees everything given to them; accounts with no bot land
  there.
- **The giver hears every stop / resume, never a burst.** What they last heard
  is on the row (`assignee_mute_told`); a switch inside `TOGGLE_QUIET_MS` is
  owed (`assignee_mute_notice_due`) and sent by `tellOwedToggles` once the
  window passes, if it still differs (`toggleNoticeDue`). Never drop a switch
  to keep the noise down — that is how "stop, resume" left the giver believing
  reminders were off.
- **"Done" needs proof, and waits for review — never Completed until
  approved.** The assignee reports it with words, a link or files
  (`tt_task_proofs`; board uploads go into the private `task-proofs` bucket
  through `/api/tasks/proof-upload`; Discord files keep their URL, refreshed
  with the owner's bot when opened); `applyAssigneeAnswer` refuses `done`
  without it. It sets `review_state = 'pending'` at Testing (`PENDING_STAGE`)
  and the REVIEWER is DMed `finishedNotice` with the proof and a link to the
  task — the person who asked for it through the owner's bot
  (`requested_by_discord_id`), else the owner; the owner may always review
  (`canReview`). Choices (`ReviewPanel`, `reviewChanges`): approve on
  time / late (the tool suggests, the reviewer chooses), disapprove — which
  REOPENS it, In progress on a new deadline (never `failed` any more: PO,
  2026-10-07) — or extend (open again, no penalty). All go through
  `/api/tasks/review` or the owner's Discord reply (`approve`,
  `disapprove: …`, `extend 2 days`) — `decide()` — and DM the assignee.
  Every verdict keeps `before` / `after`, so the newest can be taken back
  while nothing has happened since (`undoChanges`, `undoVerdict`): it stays
  listed, excused 'undone', and its points get a correction. Closing work given to someone else yourself IS
  approving it; reported work is never reopened silently. On work given to
  someone else, the STAGE is theirs (`assigneeActionChanges` `stage`,
  `withdraw`): the giver's rail is read only — they review. On Discord the proof goes to the
  task the message replies to, else the sender's only open task, else they
  pick from a numbered list (`proof_pick_message_id`). The assignee may also
  say `start` (In progress) — what the Team view reads as "working on".
  *(Lucky35, 2026-10-04; PO, 2026-10-07.)*
- **What happened on a task is kept** (`tt_task_events`, trigger
  `tt_note_task_event`, `20261007_02`): every change to status, stage,
  deadline, assignee, review state, priority or title, credited to the
  signed-in caller (`auth.uid()`), or to whom the server named in that same
  write (`last_actor_*` with a fresh `last_actor_at`) — so every server write
  made FOR someone sets them. The board shows it with the proof, verdicts,
  the bot's messages (`tt_alerts`) and replies (`activityOf`).
- **"Remind now" pings the assignee at once** (`/api/tasks/remind`,
  `components/remind-now.tsx`, beside "Stop reminding"): the reviewer's own
  words, or the usual reminder when the box is empty (`manualReminderText`),
  by DM from the owner's bot — to the assignee on the row, never anyone the
  browser names. It counts in "Sent so far" (`alerts_sent`) and the
  assignee's stream, never in the overdue cap, and never touches
  `last_alert_at` — the schedule is derived from it. Who sent it and what it
  said is a `reminded` row in `tt_task_events` (`20261007_03`), shown in the
  activity and as "Last reminded by hand". *(PO, 2026-10-07, task 5.)*
- **Missed deadlines are history.** `tt_deadline_misses` keeps the −1s
  recorded before reviews scored everything (2026-10-07); nothing records new
  ones (`tt_record_missed_deadlines()` returns 0; the trigger only excuses a
  dismissed task's misses and verdicts). Those that counted are entries of
  the score history; nobody edits a miss or a verdict from the board any more.
  None of the score is `tt_people.grade`: the grade stays the human's, and
  nothing here may write it.
- **Every task has a priority** (high / medium / low, medium by default —
  `priorityOf`). The classifier reads it from the message ("urgent", "low
  priority"); the board sets it. The board's sort and filters (`BoardView`,
  `filterTasks`) apply to every tab and the search, and are kept in the
  browser (`tt.board.view`), read after mount so the server render matches.
- **The board is live.** It subscribes to `tt_tasks`, `tt_task_reviews`
  and `tt_score_entries` (INSERT only — nothing else ever happens to one) through Supabase Realtime (RLS decides what arrives)
  and merges row by row with `mergeLive` — newer wins, missing fields kept.
- **A task taken off someone says so.** Every change of assignee is a row in
  `tt_task_handoffs` (trigger `tt_note_handoff`), readable by the person it
  was taken from. Their open board drops the task on that row's Realtime
  INSERT (`dropHandedOff` — the task's own UPDATE never reaches someone who can
  no longer read it), My tasks lists it under "Moved off you" (`movedOffMe`),
  and `tellHandoffs` DMs them once (`handoffDecision`).
- **Project channels move by hand, between two categories.** Settings →
  Project channels → `/api/channels/project` puts a channel in "Active
  projects" or "Done projects" (`chooseCategory`, overflowing at 50). The bot
  needs Manage Channels, which ONLY the invite there asks for
  (`PROJECT_BOT_PERMISSIONS`); the ordinary `BOT_PERMISSIONS` stays without it.
- **"Ask" answers from the owner's own tasks, by number.** "Did I already
  give someone a task about X?" (Lucky35, 2026-10-12): `/api/tasks/ask` sends
  every task the owner GAVE — open and finished, their board only, read on
  their session — as numbered lines (`askLines`) to Claude on their OWN
  credential (`askAboutTasks`). Claude returns numbers and a short answer;
  every task shown comes from the database (`matchesOf` drops a number not on
  the list). Never render a task from the model's words.
- **A board can have read-only viewers** (`tt_board_viewers`,
  `20261013_01`): the owner names them by Discord id; `tt_views_board()` (on
  `tt_my_discord_id()`) adds SELECT policies on `tt_tasks`,
  `tt_task_reviews` and `tt_task_proofs` — never a write. Their board shows
  the owner's tasks as someone else's (`isShared`), read only. Made so the
  developer can check features on Lucky35's real board before a deploy.

## Commands

`node_modules` is not committed, so `pnpm install` first. There is no
`.env.example` in the repo (`.gitignore`'s trailing `.env*` swallows it); the
variables are listed in README §3, and `pnpm keygen` prints `APP_ENCRYPTION_KEY`.

```bash
pnpm dev
pnpm test                                    # vitest run; collects lib/**/*.test.ts only
pnpm test lib/deadlines.test.ts              # one file
pnpm test lib/deadlines.test.ts -t "manual"  # tests whose name matches
pnpm typecheck && pnpm lint && pnpm build
pnpm tick [url]            # one worker pass against a running app; export CRON_SECRET first, it does not read .env.local
pnpm backfill:assignees    # dry run; --apply is the only form that writes
```

## Architecture

Two halves share one database and never call each other.

- **The board** (`app/page.tsx` → `components/tracker.tsx`) reads and writes as
  the signed-in user, through RLS: `lib/supabase/client.ts` in the browser,
  `lib/supabase/server.ts` in server components and routes. `tracker.tsx` holds
  the state, the focus and the one write path; `task-track.tsx`,
  `task-detail.tsx` and `person-view.tsx` only show and raise callbacks. Per-
  second countdowns subscribe to `components/clock.ts`, never to board state.
- **The worker** (`runTick` in `lib/worker.ts`) runs as the service role across
  every user, and is entered only through `/api/cron/tick`. The missed-deadline
  sweep runs first (one SQL call for everyone), then `remindUser` and
  `nudgeReviews`, for every account, so no backlog delays a reminder; then per
  account, starting from a different one each minute: `discoverChannels` (when
  due) → `pollUser` → `pollDms` →
  `runDirectMessages` → `runCommands` → `classifyUser` (live tags before
  history) → `tellAssignees` → `tellHandoffs`, and the owed answers. Every stage checks one shared wall
  clock (`DEFAULT_LIMITS.budgetMs`) and leaves the rest for the next minute.

The service-role client (`lib/supabase/service-role.ts`) belongs only in the
worker and the routes that handle a secret or call Discord:
`connections/{discord,anthropic}` verify a credential and seal it
(`lib/crypto.ts`), `channels/{refresh,backfill}` and `guilds` call Discord,
`auth/callback` stores the user's Discord link, `message` sends one DM, and
`tasks/assignee` applies the assignee's answer to a row they do not own and DMs
the giver (through `lib/assignee-server.ts`, which the worker also uses for an
answer sent by DM), `tasks/review` accepts finished work or sends it back
and DMs the assignee (`lib/review-server.ts`, likewise shared), `channels/project`
moves a channel between the two project categories, and `members` lists the
members of the bot's servers for "Given to" (ids and names only; the token
never leaves the route), `tasks/proof-upload` grants one upload into a task's
folder, and `tasks/proof/[id]` opens a proof file through a short-lived link.

**Only `lib/**/*.test.ts` is collected**, so the worker, routes and components
have no tests. Logic that needs pinning is pulled out into a pure `lib/` module
and tested there (`deadlines`, `reminders`, `board`, `people`, `relevance`,
`messaging`, `triage`, `assignee`, `review`, `team`, `projects`, `handoffs`,
`summary`, `tagged`, `members`, `developers`, `proof`, `score-history`), and the
worker, route or component calls it. Keep those modules free of network, database and clock; `now` is passed in.
`lib/deadlines.ts` imports nothing, deliberately. Most of these (`board`,
`reminders`, `deadlines`, `triage`, `messaging`, `discord-links`, `review`,
`team`, `projects`, `handoffs`, `summary`, `tagged`, `members`, `developers`,
`proof`, `score-history`)
are imported by client components, so a server import there breaks the browser bundle.
`vitest.config.mts` mirrors the `@/` alias from `tsconfig.json`, and the two
have to agree.

**Schema changes** are a new `supabase/migrations/YYYYMMDD_NN_<what>.sql`,
applied by hand in the Supabase SQL editor (there is no Supabase CLI setup here)
and ending with `notify pgrst, 'reload schema'`. `lib/types/database.ts` is
hand-written: update it in the same change, together with any worker
`.select(...)` that reads the new column. A type widened without its select
typechecks and is `undefined` at runtime.

## Docs are cited by line number

Code comments point into these files as `CLAUDE.md:24-27` and
`AGENTS.md:21-22`. When editing either file, append rather than insert, or
re-point every citation:
`grep -rnE "(CLAUDE|AGENTS)\.md:[0-9]+" app components lib scripts supabase`.

@AGENTS.md
