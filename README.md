# Task Tracker

Everything you said you'd do, with a deadline on it.

**User guide:** [English](docs/user-guide.en.md) · [Tiếng Việt](docs/user-guide.vi.md). This README is the
technical setup.

It watches the Discord channels you choose. When you **tag your bot** in a
message — `@YourBot @minh redo the thumbnail, deadline is 24 hours` — that
message becomes a task card with Minh's name on it. When the message names a
time — "24 hours", "36h", "by Tuesday", a date — the deadline is set for you,
counted from when the message was sent, in your own time zone, and a live
countdown starts. You can change it whenever you like. Then your bot DMs you
**and Minh** about it as the deadline approaches, until it's done.

Nothing you write without tagging the bot is ever a task, however task-like it
reads. And every tag gets an answer on the message itself, within a minute:

- **✅** — it's on the board. Tagging the same words again while that task is
  open also gets ✅, and files nothing new.
- **👀** — the bot read it and did not file it: a thanks, chatter, a question to
  the bot, or a command it could not apply. It's on the board's **Not filed**
  list, one click from becoming a task if that was the wrong call, and it stays
  there until someone decides — nothing ages off.
- **No reaction** — the bot never read it: it isn't in that channel, the channel
  isn't watched, or it wasn't really a tag. The one exception is a channel where
  the bot is not *allowed* to react — the board says so at the top, by name.
  Anywhere else, fix it before the deadline, not after.
- **A DM** — for any tag a reaction would not reach: one read **late** (more
  than ten minutes after it was written — a slow read, a tag added by editing
  the message, anything **Backfill** finds) or one the bot could not react to.
  Discord tells nobody when a reaction lands on an old message, so whoever
  tagged gets a DM saying what became of it and that it needs no second tag —
  one DM per person, at most one every ten minutes, with the rest counted in.
  If they cannot be DMed (an integration, or DMs closed), you are told instead.

Tags arrive more ways than a new message, and all of them count: a message
**edited** to add `@YourBot`, a **forwarded** message that carries the tag, and
a post by an **integration** (a bot or a webhook relaying work in). An edit is
seen while the message is among the channel's newest hundred; further back,
**Backfill** finds it.

Multi-user from the first migration: every person signs in with their own
Discord, connects their own bot and their own Anthropic key, and picks their own
channels. Nobody can see anybody else's anything.

Stack: Next.js 16 (App Router, Turbopack) · Supabase · Tailwind 4 · pnpm ·
Vercel. Design language inherited from
[`vdm-project-manager`](../vdm-project-manager) — see [`DESIGN.md`](DESIGN.md).
Conventions: [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).

---

## What it does, precisely

| Step | Where | How often |
|---|---|---|
| DM the reminders that are due — first, for every account, before anything is read | your bot → Discord | every minute |
| Poll watched channels for messages that **tag your bot** — or the bot's own role, which Discord offers right beside it — ones you wrote, and ones someone else wrote that also @-mention you | `relevanceOf` in `lib/relevance.ts`, `lib/worker.ts` → Discord REST | every minute |
| Read the bot's **DMs** — with you, and with everyone you give work to or keep notes on; a conversation once opened is read for good (hourly when quiet). Your DM to the bot is a task like a tag, no tag needed; a name typed as `@minh` is assigned only when it is exactly one person you have worked with — otherwise the bot lists who it might be and nobody gets it until you pick | `pollDms` in `lib/worker.ts`, `lib/dm.ts` | every minute |
| Someone else's DM to your bot: `done` / `stop` in reply to a reminder applies it (and tells you), `my tasks` gets their list, a request reaches you only after its sender replies `yes` to "send this as a task?", small talk gets 👀 and goes nowhere | `runDirectMessages` in `lib/worker.ts` | every minute |
| DM the person a task is for when nobody else told them — given by DM, made by hand, or moved to them (a channel tag already @-mentioned them) | `tellAssignees` in `lib/worker.ts` | every minute |
| A **teammate** — anyone who has signed in to the tracker — tags your bot to give work to someone else, or to themselves: filed on **your** board as asked by them; they see it under "I asked for" on theirs, read only | `relevanceOf` (`team`), `requested_by_discord_id` | every minute |
| Someone who never signed in tags your bot about work for a **third person**: nothing is stored and no card is made, but it is answered — 👀 and a fixed reply saying whose tasks this bot takes and how to join (by DM when it was read late) | `foreignTagReply` in `lib/triage.ts` | every minute |
| DM whoever tagged, for every tag read late or left without a reaction — what became of it, and that it needs no second tag | `sendOwedAnswers` in `lib/tag-answers.ts` | every minute, at most one DM per person per 10 min |
| Run `@bot …` commands sent as a **reply** to the message that created a task, and answer in the channel | `runCommands` in `lib/worker.ts` | every minute |
| Ask your Claude to sort each tagged message — a task, or thanks / chatter / a question / a command — and write the card for a task: title, detail, who it went to, the deadline in the message's words | `lib/claude.ts` → Messages API | every minute, batched 20 at a time |
| A task: create the row, carrying the **assignee** — the person @-mentioned in the message; **everyone** @-mentioned gets their own card — and react ✅. No recognisable person or deadline still makes a task, marked on the board as missing it | `tt_tasks`, `lib/tagged.ts` | as classified |
| Not a task: react 👀, reply with a fixed line for a question or a command, and list it under **Not filed** | `lib/triage.ts` | as classified |
| Set the deadline when the message named a time, with a daily reminder cadence. If the model misses it, the message's own words ("deadline is 24 hours", "…, 36 hours", "by Tuesday", "by Oct 3") are read directly — only words that say "deadline", never a bare day name or "in 5 minutes". "next Tuesday" is the nearest Tuesday, same as "Tuesday" | `pickDeadlinePhrase` + `decideAutoDeadline` in `lib/deadlines.ts` | as classified, in your zone |
| A message Claude cannot read — a refusal, an unusable answer — is retried on its own, and after three tries filed as a card from its own words, so it never holds up the tags behind it | `classify_attempts`, `lib/worker.ts` | every minute |
| **You** override that deadline, set who it's for, the frequency and the stage | the board | whenever you like |
| DM the reminder to **the assignee and to you** — a day before, an hour before, when it falls due, and at your cadence after. Yours says how the assignee's are going. **No reminder** switches off yours only | your bot → Discord | `lib/reminders.ts` |
| The assignee answers — done, or stop reminding me — and you are DMed at once | `/api/tasks/assignee` | whenever they do |

Only tagged messages are stored. Everything else in a watched channel is
ignored unread — a cost decision and a privacy one: watching a channel must not
mean harvesting conversations you are not part of.

**The bot or its role — either counts.** Typing `@YourBot` in Discord offers
both the bot and a role with the same name, and people pick either. The tracker
learns that role for every server when you press **Refresh from Discord**,
before Backfill reads any history, and the first time someone tags it live —
and if Discord will not say, it stops and tries again rather than read past
it. Any other role mention is not a tag. History read before the role was
known is flagged in Settings as **History to read again**; Backfill redoes it
without filing anything twice.

### What it cannot do

State these to anyone using it, because they are Discord's rules and no
architecture gets around them:

- **It cannot read DMs between two people.** A bot only sees channels it has
  been invited to, and DMs sent to the bot itself. Your DMs with Luka are
  invisible to it, and always will be. It reads its own DMs with you and with
  the people you work with — Discord does not let a bot discover a
  conversation a stranger opened, so a DM from someone you have never given
  work to is not read.
- **It only sees channels your bot is in.** Inviting the bot is a per-server
  action taken by someone with Manage Server on that server.
- **It polls, it does not stream.** Vercel holds no websocket between requests,
  so there is no gateway connection. A message appears within a minute of being
  sent. Messages edited or deleted after that minute are recorded as they were
  first seen.
- **A reminder DM can be refused.** The assignee gets reminders as DMs from
  your bot. Discord only delivers them if they share a server with it and allow
  DMs from server members; a refusal is logged, your own reminder says "tell
  them yourself", and the schedule carries on.
- **A bot invited with the old link may not be allowed to react or reply.** It
  used to ask only to see and read channels. The first time a reaction is
  refused, the board names that channel at the top with an **Invite again**
  button, and the answers go out by DM instead of as ✅ / 👀 — tasks there are
  filed all the same.

---

## Setup

### 1. Supabase

Create a project called **Task Tracker** in the LookUp Media organization, then
run every file in [`supabase/migrations/`](supabase/migrations/), oldest first,
in Dashboard → SQL Editor → New query.

The first, `20260902_01_task_tracker_core.sql`, creates the `tt_*` tables, the
`tt_connection_status` view, the sign-up trigger, and the RLS policies. Read the header comment before changing
anything — `tt_connections` deliberately has **no** policies, which is what
keeps everyone's bot tokens and API keys unreadable from the browser.

### 2. Discord as a sign-in provider

This is the one shared piece of configuration: a Discord application used only
for **signing in**, not for reading anything.

1. [discord.com/developers/applications](https://discord.com/developers/applications)
   → New Application → name it `Task Tracker Login`.
2. **OAuth2** → copy the **Client ID** and **Client Secret**.
3. **OAuth2 → Redirects** → add
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
4. Supabase Dashboard → Authentication → Providers → **Discord** → enable it,
   paste the client id and secret.
5. Supabase Dashboard → Authentication → URL Configuration → set **Site URL** to
   your Vercel domain, and add `https://<domain>/auth/callback` plus
   `http://localhost:3000/auth/callback` to **Redirect URLs**.

The app requests two scopes. `identify` gives the Discord snowflake, which is
how the poller tells your messages from everyone else's. `guilds` returns the
NAMES AND IDS of the servers you belong to, so Settings can show where your bot
is missing and offer to invite it — it cannot read a single message. Supabase
appends `email` on its own; that is not something the client can suppress.

### 3. Environment

There is no `.env.example` in the repo — `.gitignore`'s trailing `.env*`
swallows it — so create `.env.local` with the variables below.

```bash
pnpm keygen        # prints APP_ENCRYPTION_KEY
```

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required.** The worker and the credential routes are the only readers of `tt_connections`, and they use this |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64. Seals every stored bot token and API key |
| `CRON_SECRET` | Any long random string. Guards `/api/cron/tick` and `/api/cron/clickup` |
| `NEXT_PUBLIC_SITE_URL` | Only to override the auto-detected Vercel URL |
| `CLICKUP_API_KEY` | Optional. A personal ClickUp token (`pk_…`) of a full member of the workspace below. Feeds the Developers list; read on the server only |
| `CLICKUP_WORKSPACE_ID` | With the token: the ClickUp workspace to read (LOOKUP MEDIA is `1100310000014019`) |
| `CLICKUP_DEVELOPERS_OWNER` | With the token: the tracker account (its user id) whose Developers list ClickUp feeds — no other list is ever fed |

> **`APP_ENCRYPTION_KEY` does not rotate.** Changing it does not re-encrypt
> anything, it makes every stored credential undecryptable and every user has to
> paste theirs again. Generate it once, and put it somewhere you will not lose it.

```bash
pnpm dev
```

### 4. Deploy to Vercel

Import the repo at [vercel.com/new](https://vercel.com/new). Add all five server
variables above (Production, Preview and Development).

**`vercel.json` deliberately asks for a DAILY cron, not a per-minute one.**
Vercel rejects the deploy outright on a Hobby plan if the expression would run
more than once a day — not at runtime, at build time — so a per-minute entry
makes the project undeployable for anyone not on Pro. The daily entry is a
backstop; the real scheduler is one of the two below.

Move `vercel.json` back to `* * * * *` only if the hosting account is on Pro,
and then you can skip the rest of this section.

- **Supabase `pg_cron` + `pg_net`** — the database you already pay for calls the
  endpoint every minute:

  ```sql
  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  select cron.schedule('task-tracker-tick', '* * * * *', $$
    select net.http_post(
      url     := 'https://YOUR-DOMAIN/api/cron/tick',
      headers := '{"Authorization": "Bearer YOUR_CRON_SECRET"}'::jsonb
    );
  $$);
  ```

  With ClickUp connected, schedule `/api/cron/clickup` the same way, as a
  second job — it is a function of its own so it never pushes the tick past
  Vercel's 60 seconds.

- **Any uptime pinger** hitting
  `https://YOUR-DOMAIN/api/cron/tick?key=YOUR_CRON_SECRET` every minute (and
  `/api/cron/clickup?key=…` too, with ClickUp connected).

---

## Using it — what each person does themselves

Everything below happens in **Settings**, once, per person.

### Their own Discord bot

1. [discord.com/developers/applications](https://discord.com/developers/applications)
   → New Application.
2. **Bot** → Reset Token → copy it. It is shown once.
3. **Bot** → turn on **Message Content Intent**. Without it the bot sees that
   you posted but not what you wrote. Turn on **Server Members Intent** too:
   with it, "Given to" lists everyone in your servers; without it, people are
   found by typing their name (`/api/members`). (Under 100 servers these are
   toggles; no verification.)
4. Paste the token into Settings. It is checked against Discord before it is
   stored, then sealed.
5. Use the **Invite this bot to a server** button. The link asks for View
   Channels (1024) + Send Messages (2048) + Add Reactions (64) + Read Message
   History (65536) and nothing else — it answers tags with ✅ / 👀 and replies
   to commands, and it cannot manage, delete, kick, or mention `@everyone`.
   Only if you want it to sort project channels (below, **Project channels**)
   do you invite it again with the link Settings offers there, which adds
   Manage Channels (16) — 68688 in all.

### Their own Claude

Two credentials work, and the app detects which one you pasted:

| Paste | Sent as | Runs on | Models |
|---|---|---|---|
| `sk-ant-api…` from [console.anthropic.com](https://console.anthropic.com/settings/keys) | `x-api-key` | metered API credits | all |
| `sk-ant-oat…` from `claude setup-token` | `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` | your Claude subscription | **Haiku 4.5 only** |

> **A subscription token can only reach Haiku.** Opus and Sonnet return
> `429 rate_limit_error` with no rate-limit headers and the message `"Error"` —
> an entitlement boundary wearing a rate limit's clothes. Nothing is consumed,
> so account usage never moves, and waiting never clears it. The model dropdown
> only offers what your credential can actually reach, so this should never
> surface; it is documented because the error is otherwise unreadable.

The credential is verified with a one-token request before it is stored. A 429
during that check still stores it — a throttled request got through
authentication, which a wrong credential would not.

Classification runs with adaptive thinking at `effort: "low"` on models that
support it (4.6 and later). Haiku 4.5 rejects both with a hard 400, so the
request shape follows the model.

### Their own channels

**Your servers** lists every server you belong to and whether your bot is in it,
with an **Invite bot** button for the ones it is missing from. Servers where you
lack Manage Server say "ask an admin" instead, because Discord would refuse the
invite.

The worker finds new servers and channels your bot can see by itself, every
five minutes, and watches each from when it appeared — so a tag in a channel
made since nobody pressed **Refresh from Discord** is still read (late, and
answered by DM). Refresh does the same at once. A channel you switch off stays
off. Threads, forum posts and text chat in voice channels are not read.

**Refresh from Discord** then lists every text channel the bot can see. Click one
to watch it, or **Select all** for a whole server. Watching starts **from that
moment** — switching a channel off and on again resumes from where it left off,
and the gap stays a gap, on purpose.

**Backfill past tasks** walks history *backwards* from the moment each channel
was switched on, so it never collides with the forward cursor and never
re-reads. It stores messages without classifying them; the normal tick grades
them on its own schedule — tags written live always first — so backfilling a
busy year cannot exhaust your Claude limits in one burst, or keep today's tags
waiting for their ✅. History is answered quietly: ✅ / 👀 on the old message,
never a public reply under it. A channel whose history cannot be read is
skipped and named, and the rest are read anyway.

An `@bot deadline friday` found in history is never re-run months later; it is
read as the tagged message it is — filed, or put on **Not filed**.

### By DM, and My tasks

Anyone can DM their own bot instead of tagging it in a channel — `@minh redo
the thumbnail, 36 hours` — and the bot answers in the DM: who it went to, when
it is due, and that replying to its message with `done` or `deadline friday
5pm` changes the task. Discord's @ list offers nobody in a DM, so names are
typed as words. A name that is exactly one person you have given work to is
assigned at once; any other — a near match, two people sharing it, a member
found only by Discord's member search (no privileged intent) — files the task
with nobody on it and lists who it might be. Reply with the number, or pick on
the board; nobody is DMed until you do.

The person named is DMed about it, and can answer the same bot: `start`,
`done`, `stop`, or `my tasks`. **My tasks** (`/?mine`) is the one place they see
everything given to them, from everyone using the tracker, grouped by
urgency; someone with no bot of their own lands there when they sign in, and
every DM the bot sends them links to it.

---

## The board

The board is a **track of task cards** that slides left and right, with the
card in focus shown in full beside it. Scroll or swipe the track, use the
arrows, or ← / →; whichever card sits in the middle is the one the detail area
shows — they never disagree.

Each card carries the task, **the name of the person it was given to**, and a
**live countdown** to its deadline, to the second. Once the deadline passes the
card says **Overdue** in rose and counts up. A task that arrived without a
person or a deadline says **No assignee** or **No deadline** in the place the
data would be, so it can be fixed.

Three things on a card can be pressed:

- **the task** — brings it into focus, in full, beside the track;
- **the person's name** — opens that person: name, Discord handle, what they
  have open, what they have finished, and a box to message them;
- **All tasks** — everything that person was given, as smaller cards.

Everything you do to one task happens in the detail area: its title and, right
under it, its **description** — a box as tall as what is written in it, sent in
every reminder — who it is given to (pick from everyone you have handed work
to), the deadline field and how often it reminds, the five-stage rail, colour,
and **Mark done**,
**Dismiss** (for something that is not really a task) and **Delete**. An auto-set
date arrives in the same deadline field and looks no different from one you
typed — type over it and it is yours; the detail says which of you set it.

Above the track: the counts (open, overdue, due today, needing a deadline,
needing an assignee, on you), a search over titles and names, and the filters
**All · Assigned to me · I asked for · To review · Done & dismissed** — "I asked for" includes
work you asked for through a teammate's bot, which lives on their board and
which you can read but not change. Under them, **sort** (most urgent first, or
by priority, deadline or date created, either way round) and **filter** by
priority and by a range of deadline dates; they combine with every tab and the
search, and the browser keeps them across tabs and reloads. Every task has a
**priority** — High, Medium (the default) or Low — read from the message
("urgent", "low priority") or set on the card. **Add a task by
hand** sits under the track and lands in focus, ready for a deadline and a name.
Under it, folded, **Not filed**: every tagged message the tracker read and
decided was not work — or was a repeat of a task already open — each with
**Make it a task** (or **File it anyway**) and **Not a task**. A row leaves the
list only when someone presses one of those; nothing ages off, because this is
the only trace a misjudged message leaves. Every row is reachable: **Show
older** pages back through all of them, and the search box above the list looks
through all of them on the server, not only the ones loaded.

When the bot is not allowed to react in a channel, the board says so at the top,
names the channel, and offers **Invite again** for its server — so a missing ✅
there is never mistaken for "unread" and tagged a second time.

"Overdue" is decided by one clock for the whole page. The board ticks at the
exact second a deadline passes, so a card turns Overdue in the same instant the
Overdue count goes up and the track re-sorts — never one before the other.

**The person a task was given to sees it too, and can answer it.** When Minh
signs in with his own Discord, every task anybody gave him is on his board —
same deadline, same countdown — marked with who it came from. The task itself
stays the giver's, but Minh can press **Report done…** (with proof), or **Stop
reminding me** (and turn them back on). The giver is DMed the moment he does. Minh does not
need a bot or a key of his own for that, and every reminder he gets links
straight to the task. Without an account at all, the reminder DMs carry the
deadline in his own time zone and a countdown Discord keeps live.

The giver sees the assignee's side in the task's detail — how many reminders
Minh has had and when, whether he turned them off, whether Discord refused to
deliver them — and can stop or restart them from there.

`lib/board.ts` owns the rules — which filter shows what, what counts as
missing, whose task a row is, which card holds focus — and its tests pin them.

The address bar follows the board (`?task=`, `?person=`, `?tasks=`, `?mine`,
`?team`), and every reminder DM links to its task's card.

### Reported with proof, then reviewed

Nothing given to someone else finishes on its own. Minh reports a task done
**with proof** — words, a link, pictures or files. On the board that is **Report
done…** (files go into the private `task-proofs` bucket through a one-time
signed upload, up to 50 MB each); on Discord it is a reply to the bot's DM, or
a tag of the bot in a channel — on the task the message replies to, else his
only open task from that giver, else he picks from a numbered list. `done`
with nothing else gets "what shows it is done?" back, and the answer to that is
the proof. Discord files keep their link, refreshed with the owner's bot when
someone opens them (Discord's links expire within a day).

The task then waits at **Testing** — not Completed — as **Finished by Minh · to
review**, and the reviewer is DMed the proof and a link to the task. The
reviewer is whoever created it: the teammate who asked through the owner's bot,
or the owner, who can always review too. Four choices, each DMed to Minh with
any note:

- **Approve — on time** — closes it, and counts towards +0.5 for every 5;
- **Approve — late** — closes it, −1;
- **Disapprove** — −1, with a note saying why (required), and it reopens:
  In progress again on a new deadline;
- **Extend deadline** — open again on a new deadline, no penalty.

The tool marks the approval the facts point to as suggested; the reviewer
decides. Replying `approve`, `approve late`, `disapprove: what is missing` or
`extend 2 days` to the bot's DM does the same; `disapprove` with no reason is
asked for one. Until the reviewer decides, they are reminded once a
day; nothing is approved on its own. The clock stops while it waits: the reopen
and extend forms start from the time Minh had left when he reported it. The
proof and every verdict stay on the task (**Proof and reviews**), reopened or
not. Closing work given to someone else by hand is approving it; approved
work is final. Minh can also press **Start** (or reply `start`) so the
giver sees he is on it.

When a task is given to someone else, the person it was taken from is DMed
that it is no longer on them, it leaves the board they have open at once, and
their **My tasks** lists it under **Moved off you** for two weeks.

### Team

**Scores** (`/scores`) is the score history — see below. Every task's **Activity** shows who changed what and when, the
proof and verdicts, the reminders the bot sent, and the replies — with
**Undo** for a verdict given by mistake. **Remind now**, beside "Stop
reminding", DMs the assignee at once — the reviewer's own message, or the
usual reminder — counts in "Sent so far" and is listed there with who sent it.
On work given to someone, its stage is theirs to set; disapproving reopens it.

**Team** (`/?team`) answers "who is working on what" at a glance: one row per
person you give work to — what they are working on now (In progress or Testing),
what waits behind it, what they say is finished and waits for your review, and
their **score**. It is live: the board listens to the database (Supabase
Realtime), so a Start, a Done or a missed deadline shows the moment it happens,
without Refresh.

### Score history

Every point is written down for good (`tt_score_entries`, `20261009_01`): −1
for work approved late, −1 for work disapproved (with the reviewer's note), and
+0.5 for every 5 tasks approved on time — counted up, not a streak — listing
the five. Each entry says whose, how much, why, which task, when and who
decided. A score is the sum of a person's entries; extending a deadline, or a
deadline passing, costs nothing.

Nothing edits or deletes an entry — a trigger refuses it, for the service role
too — and an entry outlives its task. A mistake gets a **correction**: a new
entry of the opposite amount beside the one it reverses. Lucky35 or whoever
decided adds one by hand, with a note (`tt_correct_score`); undoing a verdict
or dismissing its task adds one by itself, and a +0.5 whose five no longer all
count is taken back. The database writes every point: a verdict is one
transaction with its points (`tt_give_verdict`), and `tt_settle_scores` is
swept each tick as a net.

**Scores** (`/scores`) shows, per person, the minus and plus points of a day,
a week or a month (in your time zone), with the entries underneath; open one
for its reason, note, task and proof. Each person sees only their own history;
Lucky35 (`tt_score_admins`) sees everyone's and exports it as CSV — the
entries, or the totals, exactly as shown. Team, a person's page and Monthly
show other people's scores to Lucky35 only. The score is separate from your
1–5 grade, which only you set.

### Everyone tagged

A message that @-mentions several people gives **each of them their own card**
(`lib/tagged.ts`), with the same words and deadline, so each has their own
reminders, "done", review and score. Only the first card keeps `message_id`
(the one-card-per-message index the earlier worker upserts on); every card
carries `source_message_id` and its `message_part`. A reply to the message
changes every card it made. Cards filed before this with nobody on them —
"No assignee" though the message tagged people — are given out once by the
worker (`split_pending`). "Given to" offers anyone in the bot's servers
(`/api/members`), and the message under a card reads with names, not ids.

### Developers

**Developers** (`/developers`) is a list kept by hand of which developer is on
what — for work that lives outside the tracker, in ClickUp, until ClickUp is
wired in. One row per developer: what they are working on and a status
(Working, Blocked, In review, Idle, Off), with who changed it last and when —
written by the database, from the editor's Discord identity. The owner names
who may keep their list (`tt_dev_editors`); those people sign in with their
own Discord and see that list and nothing else of the owner's
(`tt_keeps_dev_list`, keyed on `tt_my_discord_id()`). Every change reaches
everyone looking within a second (Supabase Realtime).

With the three `CLICKUP_*` variables set, ClickUp feeds one owner's list
(`20261012_01`, `lib/clickup-sync.ts`): each row can be linked to a ClickUp
person, and every minute the worker writes what is open on them there —
ClickUp's own status names and colours, done and closed work left out — on
the row. The hand-kept "working on" and status stay editable beside it. A
read that fails says why at the top of the list (`tt_clickup_state`).
Everyone with unfinished work in the workspace is added to the list by the
sync (`20261012_02`); nobody is taken off by it — the keeper hides a row
instead, and it stays hidden. Every task is kept, done ones too
(`tt_clickup_tasks`, `20261012_03`): the owner and the keepers see all of
them; a developer who signs in sees only their own, under "Your ClickUp
tasks". Who signs in as whom is matched by exact verified email, or set by a
manager ("Signs in as…").

### Ask — "did I already give someone a task about X?"

**Ask** in the board's header (shown once Discord and Claude are connected)
takes a question in plain words. `/api/tasks/ask` sends Claude every task the
owner has given — open and finished — on the owner's own Anthropic key, and
Claude matches by meaning, not only the exact words. The answer is a sentence
and the matching tasks, each one opening on the board; every task shown comes
from the database, never from the model's text.

### Monthly summary

**Monthly** (`/summary`, `/summary?month=2026-09`) lists everything finished in
one month — your own work, what others gave you, and each person's you gave
work to — with the day each was finished, whether it was on time or how late,
and how much came in that month and is still open. **‹ ›** step through the
months; **Copy as text** gives the list ready to paste into Discord. A month is
yours: it starts and ends at midnight in your time zone. It is its own page,
not a screen of the board, because the board loads only the most recently
closed work; this reads exactly the month asked for. `lib/summary.ts` owns the
rules and `lib/summary.test.ts` pins them.

### Project channels

Settings → **Project channels** lists each server's channels by the category
they sit in — **Active projects**, **Done projects**, or neither — with one
press to move a channel between the two. The categories are made the first time
you use them, and a full one (Discord allows 50 channels) overflows into "Done
projects 2". A channel keeps its own permissions, and stays watched. Nothing
moves on its own. Your bot needs **Manage Channels** for this: use **Allow
moving channels** on the server to invite it again with that permission.

### Reminder cadence

15m · 30m · 1h · 3h · 6h · 12h · daily · every 2 days · weekly.

On top of the cadence, a task is reminded about **a day before**, **an hour
before** and **when it falls due** — so "deadline is 24 hours" on the daily
default is not first mentioned at the moment it became late. Each reminder
goes to the person the task was given to, and to you — yours with a line on how
theirs are going.

The cadence on a task is **yours**. Setting it to **No reminder** stops your
copy only: the assignee still gets the day-before, hour-before and when-due
reminders, and up to three after the deadline, at a daily cadence. Only **Stop
reminding <name>** (or their own **Stop reminding me**) ends theirs. Giving the
task to someone else starts their reminders afresh.

Your reminders keep going after the deadline passes — a missed deadline is
exactly when you want telling — and stop `MAX_OVERDUE_DAYS` (30) past it, so a
task abandoned in October is not still pinging in December. Close it, or move
the date, to restart the clock.

The assignee's do not. After the deadline they get **three** more DMs; the
third says it is the last, and your own reminder says they have stopped and
it's yours to follow up. Moving the deadline resets that count.

If the worker was down, it does **not** fire a burst catching up on every
interval it missed. One reminder is owed, not six.

---

## Security model

Read this before changing any of it.

1. **`tt_connections` has RLS on and no policies at all.** `anon` and
   `authenticated` cannot select, insert, update or delete — not even their own
   row. Only the service role, which bypasses RLS and exists only on the server,
   can touch it. Adding a policy to that table is how you would leak everyone's
   bot tokens.
2. **The browser reads `tt_connection_status`**, a view over the same table that
   exposes booleans, the bot's name and the key's last four characters. Never add
   a ciphertext column to it.
3. **Bot tokens and API keys are AES-256-GCM sealed** with `APP_ENCRYPTION_KEY`
   before insertion (`lib/crypto.ts`). A database dump is not enough to use them.
4. **Every other table is `user_id = auth.uid()`, with exactly one read path
   across accounts:** a signed-in person can SELECT a `tt_tasks` row whose
   `assignee_discord_id` is their own Discord id
   (`20260928_01_assignee_reads_their_tasks.sql`). Read only — every write is
   still owner-only — and nothing else of the giver's is readable: not their
   messages, people notes, grades, channels or connections. The Discord id is
   taken from `auth.identities`, which only Supabase Auth writes, never from
   `tt_profiles`, which its owner can edit. No admin role anywhere. The
   assignee's two answers (done, stop / resume my reminders) are the one write
   across accounts, and they go through `/api/tasks/assignee`, which checks
   that same identity on the caller's own session before it touches the row.
5. **`/api/cron/tick` compares its secret in constant time** and refuses every
   request when `CRON_SECRET` is unset, rather than defaulting open.

---

## Tests

```bash
pnpm test
```

`lib/reminders.test.ts` covers the scheduling rules, which are the one piece of
logic with a wrong answer that would be invisible: a `next_alert_at` computed
exactly equal to `now` re-fires the reminder that just went out, and a burst
after downtime spams whoever was owed one. Both are pinned by tests.

`lib/board.test.ts` covers the other one: whose task a row is. Which filter a
task lands in, what a card says it is missing, and whose name it carries all
key on the Discord id, never a display name, and a task from another account is
only ever "on you" when you are its assignee. `lib/relevance.test.ts` pins what
counts as tagging the bot (its role included), `lib/deadlines.test.ts` pins
reading "deadline is 24 hours" out of a message, `lib/triage.test.ts` pins what
is filed and what is answered with 👀, and `lib/assignee.test.ts` pins what the
assignee's answers may change.

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint
pnpm tick        # drive one worker pass by hand against a deployment
```

---

## Where things are

| Path | What |
|---|---|
| `lib/worker.ts` | The tick: remind and nudge reviewers (every account first) → then per account poll channels → poll DMs → answer DMs → read reports and proof → commands → classify → tell new assignees. The whole backend. |
| `lib/dm.ts` | Tasks by DM: matching a typed name to a person, and every word the bot says in a DM. Pure; tested. |
| `lib/assignee-server.ts` | The assignee's answer applied, and the giver told — from the board or from a DM. |
| `lib/relevance.ts` | What counts as tagging the bot, and who a message names. Pure; tested. |
| `lib/claude.ts` | The classifier that sorts each tagged message and writes a task's card, its prompt, and its schema. |
| `lib/triage.ts` | ✅ / 👀, the fixed replies, and "Make it a task". Pure; tested. |
| `lib/assignee.ts` | What the assignee's answers change, and what the giver is told. Pure; tested. |
| `lib/review.ts` | The four verdicts on reported work — what each changes and costs — and what each side is told. Pure; tested. |
| `lib/review-server.ts` | A verdict written — the review row, the task, the DM to the assignee — from the board or a reply to the bot. |
| `lib/proof.ts` | What counts as proof, from the board or a Discord message, and the bot's words about it. Pure; tested. |
| `lib/proof-server.ts` | Proof saved, and a proof file opened through a short-lived link. |
| `lib/team.ts` | The Team view: who is on what, each person's score from their history, live row merging. Pure; tested. |
| `lib/score-history.ts` | The score history added up: day / week / month in the viewer's zone, totals per person, labels, who may correct, the CSV. Pure; tested. |
| `lib/score-entries.ts` | Reading the history on the caller's own session — RLS decides whose. |
| `lib/summary.ts` | The monthly summary: a month in the user's zone, who finished what, on time or late, the copied text. Pure; tested. |
| `lib/tagged.ts` | Everyone a message tags gets their own card; a message read back with names. Pure; tested. |
| `lib/members.ts` | Finding a person to give work to among everyone in the bot's servers. Pure; tested. |
| `lib/developers.ts` | The Developers lists: whose the viewer sees, statuses, order. Pure; tested. |
| `lib/projects.ts` | Which "Active projects" / "Done projects" category a channel goes into. Pure; tested. |
| `lib/handoffs.ts` | A task given to someone else: who is told, and what the old assignee's board shows. Pure; tested. |
| `lib/discord.ts` | Discord REST. No gateway, and the comment says why. |
| `lib/reminders.ts` | When the next reminder fires. Pure; shared with the UI. |
| `lib/deadlines.ts` | Resolving "in 24 hours" / "Tuesday" into a real instant, in the user's zone. Pure. |
| `lib/crypto.ts` | The secret box. |
| `lib/board.ts` | The board's rules: filters, sort and priority, who reviews, missing details, whose task, focus, counts. Pure; tested. |
| `lib/people.ts` | Per-person counts and completion history. Pure. |
| `components/tracker.tsx` | The board's state and its one write path; switches between the board and a person. |
| `components/task-track.tsx` | The track of cards. |
| `components/task-detail.tsx` | The task in focus, in full, and every control on it. |
| `components/review-panel.tsx` | The review choices; a disapproval needs its note. |
| `components/proof-form.tsx` | Report done: the words, links and files that prove it. |
| `components/task-history.tsx` | A task's proof and verdicts, oldest first. |
| `components/person-view.tsx` | A person, and everything they were given. |
| `components/my-tasks.tsx` | My tasks: everything on the person looking, from everyone. |
| `components/team-view.tsx` | Team: who is working on what, live, and each person's score. |
| `app/summary/page.tsx` | The monthly summary: what was finished in one month, any month. |
| `app/scores/page.tsx`, `components/score-history.tsx` | The score history: every point, by day, week or month; corrections; CSV for Lucky35. |
| `app/developers/page.tsx`, `components/developers-view.tsx` | Developers: which dev is on what, kept by hand, live. |
| `components/person-picker.tsx` | Pick a person — anyone in the bot's servers — for "Given to" and Developers. |
| `app/api/members/route.ts` | The members of the bot's servers, read with the owner's bot token. |
| `components/project-channels.tsx` | Settings' Project channels: moving channels between the two categories. |
| `components/settings-form.tsx` | Connect Discord, connect Claude, pick channels. |
| `app/api/cron/tick/route.ts` | The scheduler's only entry point. |
| `app/api/cron/clickup/route.ts` | The ClickUp read for the Developers list, on its own cron (`lib/clickup-sync.ts`). |
| `app/api/tasks/assignee/route.ts` | The assignee's answer to a task given to them, and the DM to the giver. |
| `app/api/tasks/review/route.ts` | The reviewer's verdict on reported work, and the assignee is DMed. |
| `app/api/tasks/proof-upload/route.ts` | One signed upload of a proof file into the task's folder, for its assignee. |
| `app/api/tasks/proof/[id]/route.ts` | Opens a proof file the caller may read, through a short-lived link. |
| `app/api/channels/project/route.ts` | Move a channel into "Active projects" or "Done projects". |
| `supabase/migrations/` | The schema, and the security model in its comments. |
