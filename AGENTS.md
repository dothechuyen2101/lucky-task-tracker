# AGENTS — traps in this repo

Things that will cost you an hour if you don't know them.

## Discord

- **REST, not gateway, and it has to stay that way while this runs on Vercel.**
  Nothing holds a websocket open between serverless invocations. If you "fix"
  this by adding `discord.js`, you have built something that cannot deploy where
  it is deployed. Moving to a persistent host is a real option — it is not a
  code change you make quietly.
- **`Authorization: Bot <token>`.** The `Bot ` prefix is not optional and its
  absence gives a 401 that reads like a bad token.
- **Message Content Intent** is a per-application toggle in the developer
  portal. It gates message text in gateway events; enable it regardless, because
  a user who has not is going to see empty strings and blame the app.
- **`?after=` window semantics are ambiguous** in Discord's own docs about
  whether you get the oldest or newest slice. `getMessagesAfter` sorts ascending
  and the caller advances its cursor to the highest id it saw, which terminates
  and makes progress under either reading. Do not "simplify" that.
- **A bot cannot read a DM between two humans.** Ever, on any architecture. If
  someone asks for that, the answer is no, not a workaround.
- **429 is per bot token.** One user hitting a rate limit must not stall the
  others, which is why the worker abandons that user's pass and moves on.

## Supabase

- **`tt_connections` has RLS enabled and zero policies.** That is not an
  oversight and it is not a bug report. Default-deny is the design; the service
  role is the only reader.
- **`tt_connection_status` is `security_invoker = off`**, so its
  `where user_id = auth.uid()` clause *is* the access control. Add a column
  holding ciphertext and you have published it.
- **The sign-up trigger is on `auth.users`.** If a user exists with no
  `tt_profiles` row, the migration was applied after they signed up. Sign out
  and in again, or backfill.
- **`.single()` throws on zero rows, `.maybeSingle()` does not.** Connections and
  profiles use whichever matches whether the row is guaranteed.
- **Adding a column to `tt_messages` does not backfill existing rows on a
  re-poll.** Both message ingest paths upsert with
  `{ onConflict: "user_id,message_id", ignoreDuplicates: true }` (`lib/worker.ts`
  `pollChannel`, `app/api/channels/backfill/route.ts`), so a message already
  stored is **skipped, not merged** — the new column stays at its default
  forever and only messages ingested after the migration carry a value.
  Repairing history is a separate offline pass over the stored content
  (`scripts/backfill-assignees.mjs` is the worked example). Do not "fix" this by
  flipping `ignoreDuplicates` to `false`: a re-poll would then overwrite
  `classified_at`, `is_task` and `command_result` on rows the worker has already
  processed. Cost time once; it will cost it again.

## Vercel

- **Per-minute cron requires Pro.** On Hobby you get one run a day. The README
  documents the `pg_cron` and uptime-pinger alternatives; the endpoint accepts
  both `Authorization: Bearer` and `?key=` for exactly that reason.
- **`maxDuration = 60` on the tick, and the worker's own budget is 50s.** The
  worker must stop itself before Vercel kills it, or a run dies mid-write. If
  you raise one, raise the other, and keep the gap.
- **A killed tick loses nothing.** Cursors advance per channel, classification is
  keyed on `classified_at is null`, reminders on `next_alert_at <= now()`. Every
  stage is resumable, which is why it is safe to give up early.

## Anthropic

- **`stop_reason: "refusal"` is an HTTP 200.** Without the explicit check in
  `classifyBatch`, a declined batch would parse as an empty response and every
  message in it would be silently filed as "not a task". Check `stop_reason`
  before reading content.
- **A partial batch is discarded whole.** If the model grades 18 of 20, none are
  written; all 20 retry ALONE (`classify_attempts`), so one bad message cannot
  sink the rest twice. A silent "no" is never written — see the 2026-09-30 notes.
- **`zodOutputFormat(schema)` takes one argument** in the current SDK. Older
  examples show a second name parameter; it does not exist.
- **Error classes hang off the default export** — `Anthropic.AuthenticationError`,
  `Anthropic.APIError`. There is no `APIStatusError` in the TypeScript SDK.

## Scheduling

- **`computeNextAlertAt` must return a time strictly after `now`.** The worker
  selects `next_alert_at <= now()`; a value equal to `now` re-fires the reminder
  it has just sent, in the same tick. This is why the catch-up arithmetic is
  `floor + 1` and not `ceil`, and there is a test pinning it.
- **A failed reminder still reschedules.** Keeping the old `next_alert_at` would
  retry every minute forever; clearing it would go quiet without telling anyone.
  It moves to the next slot at the user's chosen cadence.

## Postgres shapes that look fine and are not

- **`CREATE OR REPLACE VIEW` can only APPEND columns.** Inserting one in the
  middle of the select list fails with
  `42P16: cannot change name of view column "x" to "y"` — it matches old and new
  column lists positionally. `DROP VIEW` then `CREATE VIEW` instead. Cost a whole
  migration round trip.
- **A PARTIAL unique index cannot be an `ON CONFLICT` target** unless the
  statement repeats its predicate, and PostgREST's `onConflict=` emits the column
  list alone. `tt_tasks_one_per_message` started as
  `unique (message_id) where message_id is not null` and made every task insert
  fail with *"no unique or exclusion constraint matching the ON CONFLICT
  specification"*. A plain unique index gives the same guarantee, because
  Postgres treats NULLs as distinct — many hand-added tasks coexist happily.
- **PostgREST caches the schema.** After DDL, a new column reads as
  `42703 does not exist` for a few seconds. `notify pgrst, 'reload schema'` at the
  end of every migration, and retry before concluding the migration failed.

## Anthropic credentials

- **A `claude setup-token` subscription token can only reach Haiku.** Opus 5 and
  Sonnet 5 return `429 rate_limit_error`, no `anthropic-ratelimit-*` headers, and
  the message `"Error"`. It fails on the FIRST request rather than after a burst,
  consumes nothing — so account usage never moves — and waiting never clears it.
  That is an entitlement boundary, not a rate limit. `modelsFor()` exists so the
  choice is never offered; do not "helpfully" re-add the full model list.
- **Haiku 4.5 rejects `thinking: {type:"adaptive"}` and `output_config.effort`**
  with a hard 400. Those arrived with 4.6. `supportsAdaptiveThinking()` gates
  them, and it matters because Haiku is exactly where people land when the
  bigger models are unavailable.
- **An OAuth token is `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`.**
  Sent as `x-api-key` it returns `401 API key is invalid`, which reads like a bad
  credential rather than a wrong scheme.

## Driving the Supabase dashboard from a browser tool

Written down because all three cost time in one session.

- **The shell cannot reach `supabase.com`** from this machine — that one IP is
  unroutable — while `api.supabase.com` and `<ref>.supabase.co` are fine. So
  verify schema over the REST API with the service-role key, but apply DDL
  through the browser.
- **Do not trust the clipboard.** Twice it held something other than what had
  just been copied — once a stray `DELETE`, once a password, both of which got
  pasted into the SQL editor. Screenshot and read what actually landed before
  pressing Run.
- **Clicking by coordinate misses.** The viewport reports 1920x945 while
  screenshots come back 1568x772, so coordinates land ~22% off and keystrokes go
  to global shortcuts instead of the editor. Use `find` to get an element ref and
  click by ref.
- **DDL raises a "Potential issue detected" dialog.** Clicking Run is not enough;
  the dialog's own "Run query" must be clicked, or the SQL silently never runs
  and the Results pane still shows the PREVIOUS query's success.

## Capture is "@bot", and `mentions` lies about it

- **A reply lists the author it answers in `mentions`** when the reply pings
  them, with no `<@id>` in the text. So "tagged the bot" and "named this
  person" are read from the `<@id>` markup in `content` (`tagsBot`,
  `assigneesOf`), never from `mentions` alone — otherwise replying "thanks" to
  one of the bot's own messages files a task called "thanks".
- **`<@&id>` is a role — and one role IS the bot.** Discord offers the bot's
  managed role next to the bot in the @ picker, under the same name, and people
  pick it. `ensureBotRole` (`lib/bot-roles.ts`: the role whose `tags.bot_id`
  is the bot) learns it into `tt_connections.discord_bot_role_ids` — on
  Refresh, before Backfill reads a page, and on the first live mention of an
  unknown role. Every other role mention is still not a tag. Pass the known ids
  to `tagsBot` everywhere a tag is checked — ingest, classify, backfill — or a
  role-tagged row is closed off as untagged.
- **A failed role lookup must never be read as "no role".** The worker does not
  move its cursor past a page it could not place (`learn` returns false), and
  Backfill refuses to scan a server whose roles Discord would not list. Reading
  on regardless is exactly how role tags vanished from history (2026-09-29).
  When a role is learned late, `ensureBotRole` marks every channel in that
  server whose history was already read (`rescan_reason`) and reopens its
  backfill; Settings lists them. Don't "optimise" that reset away.
- **A tagged message is never dropped silently.** It becomes a card (✅), a
  recognised repeat of an open task (✅, `skip_category = 'duplicate'`), or it
  is answered with 👀 and kept on the board's "Not filed" list. That list has
  NO age limit — a row leaves only when a person files it or marks it "Not a
  task" (`skip_reviewed_at`). Do not add a date filter to it. A tagged reply
  that points at no task, or that the model reads as new work, goes back to
  classification (`becomeTask`).
- **Reactions need Add Reactions, replies need Send Messages — and a refusal is
  never silent.** Bots invited with the old link (66560) may lack both. A 403
  on a reaction sets `tt_channels.react_error` (the board names the channel with
  an Invite again button), and the tag is owed a DM (`answer_owed =
  'unmarked'`). So is every tag read LATE (`'late'`): Discord tells nobody when
  a reaction lands on an old message, so a ✅ there answered nobody, the tagger
  tagged again, and the board got a copy (2026-09-30, twice). The debt lives in
  `tt_messages`, not in one run's memory, and `sendOwedAnswers` pays it to the
  TAGGER — history included — with the owner told in their place when the
  tagger cannot be DMed. A deleted message (404) is the only tag owed nothing.
  The next reaction that works clears the warning.
- **"Not filed" is paged by row, and searched on the server.** Never cap what a
  person can reach there: `olderThanFilter` pages by `(sent_at, id)` — not by
  offset, because rows leave the list as they are reviewed — and the search box
  runs `ilike` over every unreviewed row (`likeContains` escapes `%`, `_`, `\`).
  Values in a PostgREST `or=` must be double-quoted: a timestamp's `:` and `.`
  are syntax otherwise.
- **The worker checks the schema before it does anything.** Migrations are
  applied by hand; a worker ahead of them re-reads (and re-sends to Claude) any
  message whose write the old schema rejects, every minute. The probe at the top
  of `runTick` reads the newest columns and stops the tick if they are missing.
  When you add a migration the worker depends on, point the probe at it.

## The board holds rows from other accounts

- **`tt_tasks` returns the assignee's rows too**
  (`20260928_01_assignee_reads_their_tasks.sql`). `task.user_id` is not always
  the viewer. Check `isShared` before offering or attempting any write.
- **Never gate access on `tt_profiles.discord_user_id`.** Its owner can update
  it under "own profile", so a policy on it lets anyone claim anyone's tasks.
  `tt_my_discord_id()` reads `auth.identities`, which only Supabase Auth writes.
  `/api/tasks/assignee` asks it on the CALLER's session (`supabase.rpc`) before
  touching a row with the service role — never trust a Discord id from a body.
- **A leaf that decides "overdue" for itself will disagree with the board.**
  The countdown ticks every second, the board every 30 — so the board also
  ticks at `nextDeadlineAfter`, and `LiveCountdown` reads its urgency from the
  board. A figure that must match a count has to come from the same clock.

## Tooling

- **Every file in this repo is CRLF.** Python in text mode (and some editors)
  writes LF back, and the diff turns into every line of the file. Write bytes,
  or convert back before committing: `git ls-files --eol` shows what you have.
- **A Supabase query builder is lazy.** `supabase.from(...).update(...)` sends
  nothing until it is awaited or `.then()`-ed — the fetch lives inside
  `then()`. `void builder` compiles, lints clean and never runs; that is how
  the board's time-zone capture left every profile on UTC. Fire-and-forget is
  `.then(ok, fail)`, never `void`.
- **`history.replaceState` is throttled** by browsers — Safari throws past ~100
  calls in 30s. The board debounces the address bar (`URL_SYNC_MS`) because
  swiping the track moves focus several times a second.

## Found in the 2026-09-30 audit

- **One message Claude will not read used to stall the whole account.** A
  refusal or an off-schema answer fails the batch, and the same batch went back
  every minute. `classifyBatch` now says which kind of failure it was
  (`failure`): "unavailable" (key, network, Anthropic) stops the user until next
  tick; "unreadable" bumps `tt_messages.classify_attempts`, sends each message
  alone next time, and at `MAX_CLASSIFY_ATTEMPTS` files it from its own words.
  Do not collapse the two back into one error string.
- **A reply in a channel pings by default.** `postMessage` sets no
  `allowed_mentions` (right for a DM). Every PUBLIC answer goes through
  `replyTo`, which pings nobody — `skipReply` quotes `<@botId>` in its text.
- **A bot answering tags must never answer its own messages.** `relevanceOf`
  drops `author.bot` before the "someone else tagged the bot" branch; without
  that, the bot's own help text (which contains `<@botId>`) would be answered
  by the bot, forever.
- **`requestKey` keys on the people as well as the words.** "@alice submit
  your timesheet" and "@bob submit your timesheet" are two tasks. Pass the bot's
  ids (user and roles) so tagging by name or by role is still the same request.
- **Supabase caps a response at 1000 rows and says nothing.** `app/page.tsx`
  pages open tasks with `.range()` until a short page, and loads only the
  `CLOSED_TASKS_LOADED` most recently closed. Any new list that can grow past a
  thousand needs the same.
- **PostgREST turns `*` into `%` in a like pattern**, and no escape survives it.
  `likeContains` maps a literal `*` to `_`.
- **The server renders in UTC, the browser wherever the person is.**
  `toLocaleString()`, `setHours()` and `new Date()` in a component's first
  render all differ between the two, and React throws the server's page away
  (a `title` keeps the server's text for good). Use `formatWhen` /
  `toZonedInput` / `bucketOf(…, timeZone)` with `useTimeZone()`, and start
  clocks from `data.renderedAt`.
- **`redirectTo` with a query string can fail Supabase's allow-list.** The
  sign-in carries its destination in the `tt_next` cookie instead, and the
  callback only follows it through `safeNextPath` — `new URL("//x", origin)` is
  another site.
- **`tt_tasks.owner_name` is written by a trigger from `auth.identities`**
  (`20260930_02`), on insert and on any update that touches it. A value sent by
  the browser is overwritten; that is the point.
- **`import "server-only"` needs no package.** Next aliases it; the build fails
  if `lib/supabase/service-role.ts` ever reaches a client bundle.

## Tags that do not arrive as a new message

- **An edit that adds `@bot` is invisible to `?after=`.** The cursor only moves
  forward, so a message edited to tag the bot was never read. The poller now
  fetches the NEWEST page first (`getNewestMessages`): when it reaches back to
  the cursor it holds every new message plus the recent ones edited since the
  last read (`edited_timestamp`, with `EDIT_MARGIN_MS` of clock slack) — still
  one request. Only when more than a page arrived does it fall back to walking
  `?after=` from the cursor. Edits further back than the newest page are read
  by Backfill. Stored rows are skipped by the upsert, so an edit never files
  twice.
- **A forward's own `content` is empty.** What it forwards — tag and people —
  is in `message_snapshots[0].message`, and `message_reference.type` is 1.
  Read it through `readableMessage`, and ask `repliesTo` (not
  `message_reference` alone) whether it is a reply: a forward is not one.
- **Integrations post as bots or webhooks** (`author.bot`, `webhook_id`). They
  used to be dropped unseen. They are read like anyone else now; only the
  tracker's own bot is skipped. Never reply to one in public (`from_app`):
  `skipReply` quotes `<@bot>`, and an echo bot would tag the bot back.

## Tasks by DM

- **A bot can read DMs sent to it over REST — but cannot find them.** With no
  gateway there is no event when someone opens a DM with the bot. The worker
  opens the DM itself (`openDmChannel`, which sends nothing) with everyone it
  knows — the owner, and the people they gave work to or noted lately — keeps
  each in `tt_dm_channels` with a cursor, and reads it like a channel
  (`walkChannel`). A stranger who DMs the bot first is not heard; say so, do
  not promise otherwise. Message Content Intent does not gate DMs to the bot.
- **The @ list offers nobody in a DM.** Names arrive as words ("@minh"), never
  as `<@id>` markup, so `assigneesOf` finds nobody. `whoIsItFor` matches the
  model's pick (`people:` line, `named`) and plain `@handles` to known people,
  then to `searchGuildMembers` — which, unlike listing members, needs no
  privileged intent. Never assign on a guess between several matches.
- **A reply in a DM is to the BOT's message**, which is not in `tt_messages`.
  `findTargetTask` falls back to `taskOfBotMessage` through
  `tt_alerts.message_id`, so every DM about a task must store the id it got
  back (`sendDm`, `sendReminderMessage`, `replyTo` all return it).
- **`dm_in` must stay out of `classifyUser`** (`.in("direction", ["sent",
  "received"])`). A DM from an assignee saying "done" is an answer, not work;
  only `runDirectMessages` turns one into a `received` task.
- **A DM is answered in the DM, never owed.** `answer_owed` stays null on
  `via_dm` rows and a failed reaction there owes nothing — the words already
  went in the same conversation.
- **Only the two people in a DM can open a link into it**
  (`/channels/@me/…`, `isDmLink`). Never show it to the assignee as "Open in
  Discord", and never put it in a DM to anyone else (`assignedNotice`).

## Tasks by DM, made safe (2026-10-03)

- **A name that only looks right is the wrong person.** Searching every server
  the bot is in found the wrong Bob, and the task and its DMs went to him with
  nobody the wiser. `exactKnown` is the only auto-assign: a name EQUAL to one
  name of exactly one person the owner has worked with. Prefix matches and
  server members are only ever offered (`candidatesFor` →
  `assignee_candidates`), picked by the owner (`pickCandidate` on a reply,
  or the board), and `tellAssignees` sends nothing while nobody is on it. Do not
  "improve" matching back into a guess.
- **The model's name is not an identity.** For a DM, `named` is the name
  exactly as written; the model's pick from the `people:` line is ignored for
  assigning, because "Alice" → "Alice Nguyen" is the model choosing between two
  Alices.
- **Someone else's request needs their own `yes`.** `runDirectMessages` asks
  (`requestConfirmQuestion`, the id kept in `tt_messages.confirm_message_id`)
  and only a short `yes` IN REPLY to that question (`isYes` — "ok thanks" is
  not one) turns the row back into an unread `received` row with
  `confirmed_at`, which classification files even if it reads as chat. Small
  talk from others is 👀 only: not a card, not "Not filed".
- **Never drop a conversation.** `dmPeople` decides which DMs are read every
  minute (open tasks of any age, recent work, notes); every other row in
  `tt_dm_channels` is still read hourly. A window that stops reading a
  conversation silently ignores the "done" sent into it.
- **Throttling a notice must coalesce, not drop.** `toggleNoticeDue` compares
  the current state with what the giver was last told; inside the window it is
  owed, not discarded. A giver toggling it themselves on the board updates
  `assignee_mute_told` so nothing is owed to them about their own action.

## Team, review, missed deadlines, project channels (2026-10-04)

- **Realtime only hears tables in the `supabase_realtime` publication.**
  `20261004_01` adds `tt_tasks` and `tt_deadline_misses`; a new table the board
  should hear live needs the same, or it silently never arrives. RLS still
  decides who hears a row — a task reassigned AWAY from the viewer stops
  arriving, which is why the old assignee's board drops it on the
  `tt_task_handoffs` INSERT instead (`20261004_02`, `dropHandedOff`).
- **An UPDATE event can leave out a column it did not change.** A long text
  value stored out of line (TOAST) is not resent unless the table has
  `REPLICA IDENTITY FULL`. `mergeLive` spreads the event over the row it
  holds; replacing the row instead blanks `detail` on the first edit.
- **A miss is recorded against whoever had the task when its deadline
  passed.** The trigger reads `old.*`: closed late, re-dated after the
  deadline, or reassigned while overdue all count against the OLD assignee.
  Dismissing excuses the task's misses (`excused_reason = 'dismissed'`) and
  restoring it counts them again. It fires only on status / deadline /
  assignee changes — a reminder's `next_alert_at` write never runs it.
- **On Vercel Hobby the sweep runs once a day — the trigger is what keeps the
  score right.** A deadline missed at 10:00 and closed at 11:00 would never
  meet the 06:00 sweep; the close records it. Do not "simplify" the score into
  the worker alone.
- **`tt_deadline_misses` has a column grant, not just a policy.** The owner
  may update `excused_at` and `excused_reason` and nothing else; there is no
  insert or delete for anyone but the database. A policy alone would let the
  owner rewrite the deadline or the person a miss is on.
- **`-x * 1` is `-0` when `x` is 0**, and `Object.is(-0, 0)` is false — the
  score's test caught it. `scoreFor` returns a plain 0.
- **Reopening work its assignee finished is a send-back, everywhere.** The
  rail and Reopen open the reason form (`finishedByAssignee`); `setStatus` and
  `setStage` refuse the silent version. A reopened task the assignee never
  hears about is exactly the "done means nothing" problem this fixed.
- **Manage Channels is in `PROJECT_BOT_PERMISSIONS` only.** It can delete
  channels; the ordinary invite stays without it, so a server that never uses
  Project channels never grants it. Do not fold it into `BOT_PERMISSIONS`.
- **Moving a channel sends `parent_id` and nothing else.** No
  `permission_overwrites`, no sync: a private project channel keeps its own
  overwrites in "Done projects". A category holds 50 channels; a full one
  overflows into "Done projects 2" (`chooseCategory`) instead of failing.
- **`X-Audit-Log-Reason` must be URL-encoded.** Discord reads it encoded; a
  raw colon or non-ASCII character garbles the audit log entry.

## Review and handoffs, closed up (2026-10-04, after the PO)

- **A review's delay is the giver's, not the assignee's.** Work waiting for
  review is `status = 'done'`, so neither the sweep nor the trigger counts its
  deadline. The danger is the send-back: reopened with a deadline already
  passed, the very next sweep would charge the assignee. `sendBackChanges`
  therefore moves the deadline to now + the time they had left at finishing
  (`restoredDeadline`), and refuses a hand-picked one that is not in the
  future. Do not drop the restore "because the giver can edit the deadline":
  the miss lands within a minute, before anyone looks.
- **Two statements in one SELECT share a snapshot.** Calling
  `tt_record_missed_deadlines()` and counting `tt_deadline_misses` in the same
  query does not see the rows the call inserted — that made a correct sweep
  look broken in a test. Count in a second statement.
- **A handoff is told only to someone who knew.** `from_was_told` comes from
  the old row's `assignee_told_at`: a person picked by mistake and switched
  before `tellAssignees` ran never hears about a task they never had.
  Switching back before the worker runs is quiet too (`handoffDecision`):
  "it's yours" from `tellAssignees` is the only message they need.
- **Accept goes through the route now.** It used to be a plain board write;
  the assignee would then never hear their "finished" was accepted. Keep
  both verdicts on `/api/tasks/review` so both DM.

## Found 2026-10-05: one message, several cards

- **`message_id` is on the FIRST card of a message only.** Everyone tagged
  gets a card (`lib/tagged.ts`); the rest carry `source_message_id` and
  `message_part`. `.eq("message_id", …).maybeSingle()` finds one of them —
  look a message's cards up by `source_message_id`. The old index stays so the
  previously deployed worker keeps working whichever lands first.
- **An `ON CONFLICT` target only absorbs ITS index.** The first card upserts on
  `message_id`, the others on `source_message_id,message_part`; a conflict on
  the other unique index raises instead of being ignored. Do not "unify" them.
- **Listing a server's members needs Server Members Intent** (403 without it);
  searching them by name does not. `/api/members` falls back to search and the
  picker says how to switch the intent on.
- **"Đ" is a letter, not a D with a mark.** NFD leaves it whole, so a search
  for "dang" never finds "Đặng" — map `đ` to `d` after folding.
- **`sed -i` in Git Bash here rewrites CRLF to LF** — the whole file shows as
  changed — and `grep -c $'\r$'` cannot tell you. Edit with the editor tool,
  or run `unix2dos` after; check with `file`.
- **Node behind this office's TLS proxy** fails with `SELF_SIGNED_CERT_IN_CHAIN`
  (corepack, Supabase calls from scripts). `NODE_OPTIONS=--use-system-ca`
  trusts the Windows store, the way curl already does; never turn TLS checks off.

## Found 2026-10-06: a whole server nobody read

- **The channel list used to be learned only by pressing Refresh.** The bot
  joined a server ("Task") after the owner's last Refresh; its channels were on
  no list, so the poller never read them, and twelve tags across three new
  channels went unanswered — no ✅, no 👀, no "Not filed" row, nothing in the
  run log. `discoverChannels` now lists every account's servers every
  `CHANNEL_SYNC_EVERY_MS`. Do not make discovery opt-in again: a channel the
  bot can see but nobody listed is the silent miss this repo forbids.
- **A newly found channel starts where it could first have been missed.**
  Seeding at "now" (what switching a channel on does) would have dropped the
  very tags that exposed this. `seedCursor` takes the later of the channel's
  own creation and the account's last full look, so a new channel is read
  whole and an old one the bot was only now let into does not pour years of
  history in; `MAX_LOOK_BACK_MS` caps a look that went stale.
- **`channels_synced_at` moves only on a complete listing.** If one server
  would not list, a channel made there meanwhile must still be read from the
  earlier look. An account whose token is dead (401) therefore retries the
  listing every tick, logging it — that is the price of never skipping ahead.
- **Threads, forum posts and text-in-voice are still not read.** The poller
  takes channel types 0 and 5 only. A tag in a thread is unseen; say so in
  Settings rather than imply otherwise.

## Found 2026-10-06: work asked through someone else's bot

- **One team, one bot.** Lucky35's team tag Luka's bot (Rocky Tracker) for
  everything; a teammate's own bot is usually not even in the server. A tag
  that did not name Luka used to be answered "I only track evilbongressurection's
  tasks… nothing was saved", and what a teammate asked OF Luka sat on his
  board where they could not see it. Now a signed-in teammate's tag is filed
  on the owner's board with `requested_by_discord_id`, and they read it.
- **There are now TWO read paths into another account's tasks**: given to me
  (`assignee_discord_id`) and asked by me (`requested_by_discord_id`), both on
  `tt_my_discord_id()`. A row readable only through the second is NOT on the
  viewer: the assignee buttons (start, done, stop) must not show on it —
  `TaskDetail` checks `onViewer`, never `isShared` alone — and a handoff must
  not drop it from their board (`dropHandedOff`).
- **`requested_by_discord_id` comes from the message's author**, which Discord
  vouches for. Never from a profile or a request body.
- **"Signed in to the tracker" is `auth.identities`**, read through
  `tt_tracker_discord_ids()` (service role only). A failed read makes nobody a
  teammate for that tick — their tags are answered as a stranger's, never
  filed under the wrong rule — and the error is in the run log.
- **A teammate's reply is never a command.** Only the owner changes the
  owner's tasks by reply; a teammate's tagged reply is read as new work.

## Found 2026-10-07: review with proof, a score from the verdict

- **A passing deadline costs nothing by itself any more.** The score is the
  reviewer's verdicts (`tt_task_reviews`). `tt_record_missed_deadlines()`
  returns 0 and the trigger only excuses a dismissed task's rows; the misses
  recorded before stay and count. Do not "restore" the automatic −1: it would
  charge twice for work then approved late or disapproved (decided with the
  user, 2026-10-07).
- **Pending is `status = 'done'` + `review_state = 'pending'` at stage 3.**
  It stops the reminders and the clock like done, but the rail stays at
  Testing and the board does not strike it through: it is not Completed until
  approved. Code that asks "is it finished?" must ask `awaitsReview` too.
- **The verdict is written before the task, and taken back if the task moved
  meanwhile** (`decide`). The other order left a task approved with no score
  when the insert failed; this order never counts a verdict twice — the task
  update is guarded on the status and review state the reviewer saw.
- **A tag from someone with open work is a `report` first.** `relevanceOf`
  keeps it with that direction; `runReports` reads it as done / started /
  stop, and anything else is put back as what it would otherwise have been
  (`fallbackDirection`: received, a teammate's `sent`, or a stranger's tag
  answered and not stored). `classifyUser` never sees `report` rows. History
  found by Backfill is never read as a report.
- **Discord attachment URLs expire within a day.** `tt_task_proofs.discord_url`
  is refreshed with the owner's bot when someone opens it
  (`POST /attachments/refresh-urls`), falling back to the message link. Do not
  show the stored URL directly.
- **A board upload path is never trusted.** `/api/tasks/proof-upload` makes
  the path (`taskId/uuid-name`) and signs ONE upload; `/api/tasks/assignee`
  checks the path is in this task's folder AND that the object exists before
  it accepts the report.
- **The board's sort and filters live in `localStorage`** (`tt.board.view`)
  and are read in a `setTimeout` after mount. Reading them in the first
  render makes the browser's page differ from the server's.
- **Fonts are files in `app/fonts/`, never `next/font/google`.** Google
  sometimes answers the build-time fetch with extensionless
  `/l/font?kit=…&skey=…` URLs and Turbopack fails the whole build on the `&`
  ("next/font/google queries have exactly one entry", vercel/next.js#99114).
  It is intermittent, so a green rerun proves nothing. `fonts.css` is
  Fontsource 5.3.0's own CSS — every subset behind its `unicode-range`, so
  Vietnamese renders in the face — and the tokens in `globals.css` name
  `"Inter Variable"` and the rest directly. Do not move them back.
- **`pnpm add` hangs on this machine** once it has to resolve a package that
  is not in the lockfile: "resolved 17" and then nothing — no request, no
  retry, no error — while `pnpm view` of the same package answers at once.
  Cause not found (2026-10-07). And a stopped background shell leaves its
  `pnpm.exe` or `next start` running on Windows: look them up by command line
  (`Win32_Process`) and stop them, or the next attempt fights the last one.

## Found 2026-10-07 (later): activity, who moves the status, undo, scores

- **A trigger cannot know who acted through the service role.** `auth.uid()`
  is null for the worker and the routes. Server writes made for someone set
  `last_actor_discord_id` / `last_actor_name` AND a fresh `last_actor_at` in
  the same update; the trigger credits them only when `last_actor_at` moved,
  so a later write that names nobody is never credited to the last person.
  A board write is credited from the sign-in, whatever the row says.
- **Undo needs the state before AND after.** `before` restores the task;
  `after` is how undo knows nothing happened since (status, review state,
  stage, deadline). Verdicts from before `20261007_02` have neither and are
  not undoable. `snapshot` writes every verdict field, a missing one as null,
  or undo leaves the verdict's `reviewed_at` behind.
- **On work given to someone else, the giver's rail is read only.** The
  assignee sets stages 0–2 (`ASSIGNEE_STAGE_MAX`) through
  `/api/tasks/assignee`; Testing is their report, Completed the approval. Do
  not "help" by letting the giver click In progress again — the PO asked for
  exactly that to stop.
- **`disapprove_close` stays in the CHECK and the type**: old verdicts carry
  it. `reviewChoices` never offers it and `reviewChanges` refuses it.
- **The board loads every verdict the viewer can read** (`allReviews`), not
  only its own board's: the asker can take theirs back and Scores shows the
  viewer's own score elsewhere. Team and person scores still go through
  `boardReviews`.
- **A reminder sent by hand must not move the schedule.** `/api/tasks/remind`
  bumps `alerts_sent` and `assignee_alerts_sent` / `assignee_last_alert_at`
  and nothing else. `last_alert_at` is what `next_alert_at` is derived from;
  writing it there without recomputing leaves the scheduler out of step, and
  `assignee_overdue_alerts` is the automatic cap's, not the reviewer's. Its
  history row (`tt_task_events` kind `reminded`) is written by the route,
  not the trigger — the counters are not columns the trigger watches.

<!-- BEGIN:nextjs-agent-rules -->

## Found 2026-10-09: points written down for good

- **A score entry can never be deleted, so a verdict can no longer be
  "inserted, then deleted on a lost race".** `decide()` and `undoVerdict()`
  call `tt_give_verdict` / `tt_undo_verdict`: the task row is locked, checked
  against what the reviewer saw, changed, and the verdict and its points
  written — one transaction. Do not go back to three PostgREST calls; the
  third one (the delete) is exactly what the history forbids.
- **`tt_apply_verdict_changes` refuses a key it does not list.** It is
  `VERDICT_FIELDS` (lib/review.ts) plus the schedule and the actor. Add a
  field to one and not the other and every verdict fails loudly — which is
  the point; a silent drop would leave the task half-changed.
- **The tracker never overrides a person.** `tt_settle_scores` leaves alone
  any chain whose latest entry is a `by_hand` correction — even when the
  verdict behind it is later undone or dismissed. Do not "fix" that: a
  correction Lucky35 made by hand is the final word on that point.
- **A non-Lucky35 reviewer cannot READ the history of the person they
  reviewed** (RLS: own, or admin). So the task's activity corrects by verdict
  (`tt_correct_score(null, review_id, note)`), which finds the chain itself
  and only corrects a point that still counts; putting a point back is done
  entry by entry on `/scores`.
- **`select (f()).*` calls `f` once per column.** On a function that
  inserts, that is N inserts — the second correction was refused as "already
  corrected" and aborted a test. Write `select * from f()`.
- **A backfill into an append-only table is forever.** `20261009_01` was run
  first inside one transaction with every scenario (verdict, undo, five on
  time, dismissal, deletion, RLS, corrections) and rolled back; only then
  applied. Do the same for any migration that writes entries.
- **Proof outlives its task now** (`tt_task_proofs` lost its foreign key) so
  an entry can still open its proof; the proof policy also lets Lucky35, and
  the person an entry is about, read it.
- **+0.5 is pooled per person across every board** — "your five approved on
  time" — where the old derived score counted per board.
- **A score someone may not read is hidden, never 0.** Team, a person's page
  and Monthly show other people's points only to Lucky35 (`scoreAdmin`);
  for anyone else RLS returns no entries, and a 0 would read as a clean
  record.
- **A disapproval with no note must not stall the sweep.** The table
  requires one, and the code asks for it — but the build deployed before it
  wrote verdicts without, and one such row made `tt_settle_scores` raise for
  EVERY person, every minute (reproduced in a dry run). Since `20261009_02`
  its −1 counts with "No reason was recorded with this disapproval." Never
  let a check on one entry stop the settling of everyone else's.
- **Headless Edge here, for screenshots:** a window narrower than ~500px is
  silently widened, so render a phone inside a 390px `<iframe>`; launch one
  Edge per command (a loop writes only the last file); and give `file:///`
  the long path — `CHUYEN~1.DOT` in the URL writes nothing.

## Found 2026-10-11: the Developers list, kept by someone without a bot

- **`/api/members?owner=` reads members with ANOTHER account's bot.** The
  keeper of a Developers list (Naukhaiz) has no bot, so "pick from the
  server" found nobody. The route now uses the owner's bot when the caller
  keeps that owner's list — asked as `tt_keeps_dev_list(owner)` on the
  CALLER's session, never trusted from the request — and returns ids and
  names only, as before. Do not widen it to any other use of the owner's
  bot: it is the one place an account acts through someone else's.
- **Rows written without a session show no "by".** `tt_stamp_developer`
  reads `auth.uid()`; a row inserted from the SQL editor or the service role
  says "Updated … ago" with no name until a person changes it. That is
  correct — do not fill a name in for them.

## Found 2026-10-12: ClickUp feeds the Developers list

- **The ClickUp token is the one app-level credential, and it is fenced.**
  `CLICKUP_API_KEY` reads ONE workspace (`CLICKUP_WORKSPACE_ID`) for ONE
  owner's list (`CLICKUP_DEVELOPERS_OWNER`); `clickUpConfig` returns nothing
  unless all three are set. Never let another account's rows be fed by it,
  and never send it to a browser — what the page gets is task names,
  statuses and member names (no emails).
- **A member listed in a workspace is not always a token that can read it.**
  The first token pasted belonged to "Automated", listed among LOOKUP
  MEDIA's members, yet `GET /team` showed only its own workspace and every
  read answered `401 Workspace not authorized (OAUTH_192)`. `workspaceOf`
  says so in plain words on the page; the cure is a token of a full member.
- **`include_closed=false` still returns "done" statuses.** ClickUp's kinds
  are open / unstarted / custom / done / closed, and "live" and "code
  merged" are `done`. `devTasksFor` drops done and closed itself.
- **"to do" is not one kind.** It is `open` in one list and `unstarted` in
  another. Order and filter by the KIND and the status's place in its list,
  never by a status name.
- **The sync must not look like a person.** `tt_stamp_developer` keeps
  `updated_at` / `updated_by_name` when only `clickup_tasks` moved, and
  refuses `clickup_tasks` from anyone with a session. The worker writes a row
  only when what ClickUp says changed (`sameDevTasks`), so Realtime carries
  news, not a write a minute per developer.
- **The sync adds developers; it never takes one away.** Anyone assigned
  unfinished work gets a row (`peopleWithOpenWork` → `newDevelopers`,
  upserted on the plain unique index `(owner_id, clickup_user_id)`), and a
  hidden row still counts as a row. So a linked row must be HIDDEN, never
  deleted — a deleted one is back within a minute. A hand-added row that is
  not yet linked to its ClickUp person gets a twin the first time the sync
  runs: link it before, or hide the twin.
- **A developer reads their tasks, never their row.** The policy on
  `tt_clickup_tasks` asks `tt_my_clickup_ids(owner)`, a security definer
  function, because a policy's subquery runs under the caller's RLS — and
  the caller may not read `tt_developers`, where the managers' notes about
  them live. Do not "simplify" it into a policy on `tt_developers`.
- **Emails are matched, never kept.** ClickUp members' emails exist only in
  the worker's memory during a members read; Discord emails come from
  `tt_tracker_identities()` (service role, VERIFIED only). A link is made
  only when the email is held once on each side (`linksByEmail`); anything
  else waits for a manager's "Signs in as…".
- **Done tasks are kept; gone ones are dropped only after a WHOLE read.**
  Every `FULL_EVERY_MS` the worker reads every task (`include_closed=true`)
  and deletes the stored ones ClickUp no longer returns; in between it reads
  `date_updated_gt` the last read. A read cut short by `MAX_PAGES` drops
  nothing.
- **Only a person moves "who changed it, and when".** Since `20261012_03`
  every write without a session (the worker's links, an SQL-editor fix)
  keeps the stamp a person left.

## Found 2026-10-13: the tick has no room left

- **The tick already runs at 45–55 s of its 60.** Its own budget is 50 s,
  but a stage started just before the budget runs on past it, so ticks end
  at 51–55 s on an ordinary minute. The ClickUp read (every task, done ones
  too) inside the tick added a few seconds and Vercel began killing ticks:
  "Task timed out after 60 seconds", 504, two in four minutes. It now runs
  on its own cron (`/api/cron/clickup`, `vercel.json`). Do not put new work
  into `runTick` without measuring what the tick already spends — give it a
  function of its own, as here.

## Found 2026-10-13: "Ask" — did I already give someone a task about X

- **Claude names tasks by NUMBER, the database describes them.** The list
  goes out as `[n] title — for … — open, in progress — given …` lines
  (`askLines`), and only numbers that are on it come back as tasks
  (`matchesOf`). Showing a title, a person or a date from the model's text
  is how an AI answer invents a task that was never given; the short
  `answer` sentence is the only free text shown, and it is told to use only
  what the list says.
- **The list is cached, the question is not.** The task lines are the first
  user block with `cache_control`; the question comes after it, so asking
  twice about the same board pays for the list once. Put nothing that
  changes per question (the time, the question) before that block.
- **It runs on the owner's credential, so on THEIR model.** An OAuth
  subscription token reaches Haiku 4.5 only (see Anthropic credentials):
  no adaptive thinking or effort there (`supportsAdaptiveThinking`). Do not
  add an app-level key to make it "smarter".
- **The short answer can miscount; the list cannot.** Live on Haiku 4.5
  (2026-10-13), four questions matched the right tasks, but one answer said
  "two remain open" over three open tasks. The task list under it comes from
  the database and is right — keep it the thing people act on; the figures
  line under the answer (`tally`) is counted from it, not from the sentence.
- **People are asked about by the names people use.** Tasks carry Discord
  usernames ("thuan2172001", "jiaismybaby"); the team says "Leo", "Cenri".
  `peopleLegend` sends the other names each person goes by — their display
  name from the messages they tagged the bot with, their ClickUp name off
  the Developers list, `tt_people.display_name`. Without it "what did I give
  Cenri?" answered "nobody by that name".
- **Haiku finds topics, not long lists.** Measured 2026-10-13 against the
  database: "what did I give Cenri last week?" (28 tasks) — Sonnet 5 found
  28/28, Haiku 4.5 found 5. Topic questions (appeals, Spotify, Trello,
  typos, unaccented Vietnamese) were right on both, and 600 decoy tasks did
  not move them. An OAuth subscription credential can only reach Haiku.

## Found 2026-10-13: read-only viewers of a board

- **A viewer's access is SELECT policies only** (`tt_views_board`), on
  `tt_tasks`, `tt_task_reviews` and `tt_task_proofs`; the activity follows
  the tasks by itself. Never add a write policy for viewers — their board
  holds the rows as someone else's (`isShared`) and offers no write, and the
  database must agree.
- **Granting is a permission change, not a data fix.** The rows in
  `tt_board_viewers`, `tt_dev_editors` and `tt_score_admins` widen who reads
  what. Tooling here refuses to write them on its own ("Permission Grant");
  the person granting runs that SQL themselves.

## Found 2026-10-16: "I cannot see the server" — Luka, after a transfer

- **"Your servers" is read with the person's OWN Discord token, which
  expires.** Supabase hands `provider_token` over once, at sign-in
  (`auth/callback`); Discord expires it after about a week. Luka had not
  signed in since 1 October, so the list stopped on 5 October and every
  "Refresh my servers" failed — a server transferred to him on 16 October
  was nowhere, and the page showed the old list as if it were current.
  Settings now says when the list is from and when the sign-in ran out
  (`serverListState`), with "Sign in again" (`/auth/signout` with `next`).
  Renewing it by itself needs the Discord OAuth client id and secret, which
  only Supabase holds today; `discord_user_refresh_cipher` is already kept.
- **Check ownership with a bot that is IN the server**, not by asking:
  `GET /guilds/{id}` gives `owner_id`, and the member's roles give the rest.
  Luka was the owner, with Administrator — Discord was not the problem.
- **Administrator does not set the Manage Server bit.** `/users/@me/guilds`
  sends the permissions WITHOUT implicit ones, so an admin's integer may lack
  `MANAGE_GUILD` (Luka's did). `can_invite` is true for the owner
  (`guild.owner`); `canInviteBot` alone would have said "Ask an admin".
- **An invite link passed around in chat can be another bot.** The one posted
  in #task-tracker named client `1556973292043112488` — no bot of any account
  here — and asked for 134144 (View, Send, Mention @everyone: no Add
  Reactions, no Read Message History). Point people at Settings' own invite
  (`botInviteUrl`), which is their bot with `BOT_PERMISSIONS`.

## Found 2026-10-20: tagged to be told, not to do it

- **"Everyone tagged gets a card" gave a card to someone only copied in.**
  "@jfabbs … please share it here with @umer so he can import it" made umer
  a card, four reminders and an overdue countdown. The asker could not close
  it (it was on the owner's board), so umer was told to "reply done" — and
  an on-time approval he never earned went into his score history. Now a
  person tagged only after "cc" / "fyi" gets no card (`splitCc`), and a card
  given by mistake is closed with `/api/tasks/not-for` — never by having its
  person report work they did not do.
- **The words decide who is copied in, not the model.** The user turned down
  letting Claude judge "this person only receives the result": a model that
  drops a real assignee is a silent miss. Cenri's own message, with no "cc",
  still gives both people a card — that is the rule, not a bug.
- **A cc list never crosses a new line, and "cc" never takes a doer off.**
  `JOIN` allows commas, "&", "+", "and" / "và" and spaces only, so "cc @a" on
  one line cannot swallow "@b do it" on the next; and a person tagged anywhere
  outside a cc list is still a doer.
- **Write regexes into this repo from a file, not from a template string in a
  shell script.** `\b` inside a JavaScript template literal is a BACKSPACE,
  and `\d` loses its backslash: the first version of `CC_CLAUSE` was written
  that way and `file` called the result "with overstriking".
- **`/api/tasks/not-for` dismisses through the trigger that already corrects
  points.** It sets `last_actor_*` so the correction is credited to whoever
  took them off, and is guarded on the status and review state the caller
  saw. `tt_clear_dismiss_reason` drops the reason whenever the card is not
  dismissed, so a Restore needs no extra write.

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
