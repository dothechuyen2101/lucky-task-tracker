# Task Tracker — User guide

**English** · [Tiếng Việt](user-guide.vi.md)

This guide is for the people who use the tracker. That means whoever hands out work on Discord, and whoever
receives it. The technical setup (Supabase, Vercel, environment variables) is in the [README](../README.md).

---

## 1. What it does, in one minute

1. In a Discord channel the tracker watches, you **tag your bot**, **@-mention the person**, and say **what**
   and **by when**:

   > `@YourBot @minh redo the thumbnail, deadline is 24 hours`

2. The message becomes a **card** on your board with Minh's name on it, a deadline and a **live countdown**.
3. Your bot DMs **Minh and you** as the deadline approaches, and keeps doing so until the task is done.
4. The bot answers every tag on Discord so nobody has to wonder whether it was read: **✅** filed, **👀** read
   but not filed, or a **DM** when a reaction would go unseen.

You can also **DM your bot** the same thing — no tag needed — and everyone you give work to sees it all in
one place: **My tasks**.

Only messages that tag your bot, or DMs sent to it, are read. Everything else in the channel is ignored.

---

## 2. Setting up (once, about 10 minutes)

Everything below happens on the **Settings** page.

### 2.1 Sign in

Open the tracker and press **Sign in with Discord**. The tracker only learns who you are and which servers
you belong to. Signing in cannot read any of your messages.

### 2.2 Create your own bot — *Your Discord bot*

Every person runs their own bot; nothing is shared.

1. Create an application in the Discord developer portal (**New application**). You can give it any name.
2. On its **Bot** tab, press **Reset Token** and copy the token. Discord shows it only once.
3. On the same tab, switch on **Message Content Intent**. Without it every task arrives with empty text.
   Switch on **Server Members Intent** too: with it, "Given to" on the board lists everyone in your servers.
   Without it you can still find anyone by typing their name.
4. Paste the token into the box and press **Connect bot**.

### 2.3 Connect Claude — *Your Claude*

Claude is what reads each tagged message and turns it into a card. Pick one of two ways:

- **Your Claude subscription (no extra cost).**
  - Windows: download the helper, sign in to Claude in the browser window it opens, come back, press
    **Ctrl+V** in the box and press **Connect Claude**.
  - Mac: copy the one-line command shown on the page into Terminal.
  - On a subscription, only **Claude Haiku 4.5** is available.
- **An API key** (`sk-ant-api…`). Paste it in the same box. It is billed per use and unlocks every model.

Until Claude is connected, nothing is filed. Tagged messages are not lost: they wait and are processed once
Claude is connected.

### 2.4 Invite the bot to your servers — *Your servers*

1. Press **Refresh my servers**.
2. Press **Invite bot** next to each server where tasks are given. You need the *Manage Server* permission
   there; otherwise an admin has to invite it (**Ask an admin**).
3. The bot asks to see and read channels, send messages and add reactions — nothing else.
4. If you invited the bot a long time ago with an older link, invite it again. Without the *Add Reactions*
   permission it cannot put ✅ / 👀 on messages.

**A server missing from the list** — one you just joined, or were made owner of:

- The list is read with your Discord sign-in, which Discord lets this page use for about a week. When it has
  run out, the section says so in red, and **Refresh my servers** cannot bring in anything new: press **Sign
  in again**, then **Refresh my servers**.
- Or press **Invite your bot from Discord's own list** under the list: Discord shows every server you own or
  manage right now. If the server is not there either, look at the name at the top of Discord's page — it is
  the account your *browser* is signed in to, which may not be the one in the Discord app.
- Invite with the button on this page, not a link someone pastes: a link made by hand can name another bot,
  or ask for the wrong permissions.

### 2.5 Choose channels — *Channels to watch*

1. Press **Refresh from Discord**.
2. Click each channel to watch, or use **Select all** for a whole server.
3. Watching starts **from that moment**. To pick up tags written earlier, press **Backfill past tasks**.
   Running it again never files anything twice.
4. **New servers and channels are found by themselves** within five minutes and watched from when they
   appeared — a tag written there before they were found is still read, and its writer is answered by DM.
   Switch off any you do not want; it stays off.
5. Threads, forum posts and text chat in voice channels are **not** read. Tag the bot in an ordinary channel.

### 2.6 Where reminders arrive, and your time zone

- **Where reminders arrive:** by DM from your bot (the default). If your Discord privacy settings refuse DMs
  from bots, pick a channel instead.
- **Your time zone:** set from your browser the first time you open the board, and changeable here. It
  decides what "Tuesday", "tonight" and "5pm" mean, and every time shown on the board.

### 2.7 Project channels (optional) — *Project channels*

Keeps finished projects out of the way in your Discord server. Each server's channels are listed by where
they sit: **Active projects**, **Done projects**, or neither.

- **Done →** moves a channel into the "Done projects" category; **← Active** moves it back.
- The two categories are made the first time you use them. A category holds 50 channels at most; when "Done
  projects" is full, the bot makes "Done projects 2".
- A channel keeps its own permissions wherever it goes, and stays watched.
- Nothing moves on its own.
- **The bot needs the Manage Channels permission** for this. The ordinary invite does not ask for it, so press
  **Allow moving channels** on the server once and invite the bot again.

---

## 3. Giving a task on Discord

**The pattern:** `@YourBot @person what to do, when`

| You write | You get |
|---|---|
| `@YourBot @minh redo the thumbnail, deadline is 24 hours` | A task for Minh, due 24 hours after the message was sent |
| `@YourBot @minh cut the teaser, 36 hours` | Due 36 hours later |
| `@YourBot @lan send the invoice by Tuesday` | Due on the coming Tuesday at 17:00 |
| `@YourBot @lan update the pricing page by Oct 3` | Due 3 October at 17:00 |
| `@YourBot @rea @cenri send the cost breakdown, deadline 48 hours` | One card for Rea and one for Cenri, the same words and deadline on each |
| `@YourBot fix the login page` | A task with **No assignee** and **No deadline**, to fill in on the board |

**Good to know**

- **Pick the names from Discord's @ list** so they turn blue. A name typed as plain text is not a mention.
- **Tagging the bot, or the role with the bot's name**, counts the same. Discord shows both in the @ list.
- **Everyone you @-mention is given the task — each on their own card**, with their own reminders, their own
  "done" and their own score. The cards say who else has it ("Also given to"). It does not matter whether you
  have given them anything before. A reply to the message ("push it to Friday") changes every card it made.
- **Only telling someone? Write "cc" before them.** Anyone tagged after **cc**, **cc:**, **/cc** or **fyi** —
  "@jfabbs put the CTAs in one Excel, cc @umer" — gets no card and no reminders; the task names them under
  **CC**. Someone tagged anywhere else in the message still gets a card. If a card went to someone who was only
  copied in, open it and press **Take … off this** (the board's owner, or whoever asked for it): their card
  closes, nothing counts for or against them, and they get a DM saying so. Do not ask them to reply "done" —
  that records an approval on work that was never theirs.
- **Nothing is dropped.** A tag without a person or a deadline still becomes a card, marked **No assignee**
  or **No deadline**.
- **Deadlines count from when the message was sent, in your time zone.**
  - "Tuesday", "by Tuesday" and "**next Tuesday**" all mean the nearest Tuesday still ahead. Said on a
    Tuesday, they mean the following week.
  - "today" and "by EOD" mean 17:00 today. "tonight" means 21:00. "tomorrow" means 17:00 tomorrow.
  - A date with no time means 17:00 on that day.
  - "ASAP", "soon", "the Monday meeting" or "it shows up in 5 minutes" are not deadlines.
  - Other languages work too, because Claude reads them. The English phrasings in the table are the safest:
    the tracker reads those itself even when Claude misses the deadline.
- **Tags that arrive another way count as well:**
  - a message **edited** to add `@YourBot`;
  - a **forwarded** message that tagged the bot;
  - a post by an **integration** (a bot or webhook, e.g. from Trello) that tags your bot.
- **Someone else tags your bot and @-mentions you:** that is a task **for you** ("X asked you").
- **A teammate tags your bot to give work to someone else (or to themselves):** if they have signed in to the
  tracker once, it is filed **on your board**, marked "X asked". Your bot reminds, and you review it when it is
  finished. They see everything they asked for — of you, or of anyone through your bot — under **I asked for**
  on their own board, read only.
- **Someone who never signed in tags your bot to give work to a third person:** nothing is saved. The bot answers
  👀 and replies that it only takes tasks from your team, and how to join (sign in once).

### 3.1 By DM to your bot

You can give tasks in a private message to **your bot** instead of a channel. It works the same way, and the
bot answers you in the DM.

1. Open a DM with your bot: Settings → *Direct messages to your bot* → **Open your bot's profile** →
   **Message**. You must share a server with the bot.
2. Write the task as you would in a channel, **without tagging the bot**:

   > `@minh redo the thumbnail, 36 hours`

3. In a DM, Discord's @ list offers nobody else, so **type the name as words** (`@minh`).
   - If the name is **exactly** the name of one person you have given work to (or keep notes on), the task
     goes to them, and the bot replies with who it went to and when it is due.
   - Otherwise — two people with that name, a name that only looks similar, someone the tracker has only
     found in one of your servers — **nobody gets it yet**. The bot lists who it might be: "Who is "bob"?
     1. Bob Tran (@bob_t) · Server A  2. @bobby · Server B". Reply to that message with the number, or pick on
     the board. Until you do, nobody is told anything.
4. The person it goes to gets a **DM from your bot** saying you gave them a task. (A task given in a channel
   doesn't need this: the @-mention already notified them.)

In the same DM you can also:

- **Reply** to the bot's message about a task with `done`, `dismiss`, `deadline friday 5pm`, `6 more hours` or `remind me daily`;
- ask `what's open?` to get your list.

**What the bot cannot do:** read your DMs with Minh. A bot only ever sees messages sent **to the bot**.

---

## 4. How the bot answers a tag

| You see | It means |
|---|---|
| **✅** on the message | Filed. The same request — same words, same person — tagged again while the first is still open also gets ✅, and no second card. |
| **👀** on the message | Read, deliberately not filed: a thanks, chatter, a question to the bot, or a command it could not apply. It sits on the board's **Not filed** list, one click from becoming a card. A question or a failed command also gets a short reply that pings nobody. |
| **A DM from the bot** | Sent to whoever tagged, when a reaction would not be noticed. That covers a tag read **late** (more than 10 minutes after it was written — added by an edit, found by Backfill, or the tracker was down) and a tag in a channel where the bot **cannot react**. It lists what became of each tag and says it needs no second tag. At most one DM per person every 10 minutes. If that person cannot be DMed, you get it instead. |
| **Nothing at all** after a few minutes | The bot never saw it. The channel is not watched, the bot is not in it, or the name was not a real mention. |

**Do not tag again for the same thing.** If you are unsure, look at the board.

---

## 5. Changing a task from Discord

**Reply** to the message that created the task and tag the bot:

| Reply | Result |
|---|---|
| `@YourBot done` | Your own task: marked done. Work you gave someone else: **approved** — on time or late, as the facts say (see 6.6) |
| `@YourBot ignore that` / `dismiss` | Dismissed |
| `@YourBot deadline friday 5pm` | New deadline, in your time zone. It counts as set by hand, so the machine never changes it again. |
| `@YourBot give her 6 more hours` / `2 extra days` / `push it back a day` | **More time:** the deadline moves that much later than it is now (from now, if it is long gone). The old deadline does not count against the person. |
| `@YourBot remind me daily` / `every 3 hours` | New reminder frequency |
| `@YourBot also do the footer` | Adds work, so it becomes a new task |

When someone reports a task you gave them done, your bot DMs you **with their proof and a link to the task**.
**Reply to that DM**:

| Reply | Result |
|---|---|
| `approve` | Approved — on time or late, as the facts say. `approve late` / `approve on time` to choose. |
| `extend 2 days` | More time, no penalty: it opens again on the new deadline. |
| `disapprove: the footer is missing` | Disapproved: −1, and it reopens on the time they had left. **The reason is required** — `disapprove` alone gets asked for it. |

A command that worked gets **✅** and a short reply. One the bot could not apply gets **👀**, the reason, and
a row on **Not filed**.

---

## 6. The board

### 6.1 Top of the page

- **Team** — who is working on what, live (see 6.7).
- **My tasks** — everything given to you, from everyone (see section 8).
- **Figures:** Open · Overdue · Due today · Need a deadline · Need an assignee · On you · To review · Messages
  read · Channels watched.
- **Search:** searches titles, message text and names.
- **Filters:**
  - **All** — every open task.
  - **Assigned to me** — work on you.
  - **I asked for** — work you handed out, including what you asked of others through *their* bot (read
    only; it lives on their board).
  - **To review** — work reported done, with its proof, waiting for your verdict (see 6.6).
  - **Done & dismissed** — finished, failed and dismissed work; the 300 most recently closed are loaded.
- **Sort and filter** (under the filters): sort by **priority**, **deadline** or **date created**, either way
  round; show only some **priorities**; show only deadlines **between two dates**. They work with every filter
  above and with the search, and stay as you left them when you switch filters or reload. **Clear** undoes
  them.
- **Notices:**
  - **Not tracking yet** — setup is not finished.
  - **The bot cannot react everywhere** — names the channels where it may not add ✅ / 👀, with an
    **Invite again** button.

### 6.2 The track and the card in focus

- Cards slide left and right. Swipe, scroll, press the arrows, or use ← / → on the keyboard.
- The card in the middle is shown in full beside the track (under it on a phone).
- Each card shows:
  - the **countdown** — rose **Overdue** once the deadline has passed, amber when due today;
  - the **task**;
  - the **person**;
  - **All tasks**, which shows everything that person was given.

### 6.3 Editing a task (in the detail area)

| Part | What you can do |
|---|---|
| **Title** | Click to edit. Enter saves, Esc cancels. |
| **Description** | Right under the title: what the work is — steps, links, what done looks like. The box grows with what you write, so a long description is read whole; drag its corner to make it taller. Saved when you leave the box, and sent in every reminder. The person you gave it to sees it on their card. |
| **Deadline** | Saved when you **leave the field** or press Enter; Esc undoes. The time is in your time zone. **Use <date>** appears when the message named a different time. **+1h / +6h / +1 day** under it give more time in one press. Only the final deadline counts: moving it — before or after it passed — takes back a miss of the old one. |
| **Priority** | High, Medium or Low. Medium unless the message said "urgent" or "low priority", or you changed it. High and Low show on the card. |
| **Reminder frequency** | Every 15 minutes up to weekly, or **No reminder**. It is disabled until the task has a deadline. |
| **Reminds / Next reminder / Sent so far** | Who the next reminder goes to, when, and how many have gone out. |
| **Assignee's reminders** | A line on how theirs are going (reminded 2×, turned off, DM refused, limit reached), with **Stop reminding <name>** / **Remind <name> again**. |
| **Remind now** | Beside **Stop reminding**: DMs the person the task is on **right away**, without waiting for the next reminder. Type a message in the box above it and they get exactly that (under one line naming the task); leave it empty and they get the usual reminder. It only ever goes to the assignee, counts in **Sent so far**, and appears in the **Activity** with who sent it; under the button, **Last reminded by hand by … · when**. Greyed out while nobody is on the task. At most once every 2 minutes per task. |
| **Given to** | Choose or change the person: nobody, yourself, someone you have given work to, or **anyone in your servers** — type to find them. The new person's reminders start fresh. When the message tagged others too, **Also given to** opens their cards. |
| **Stage** | Started → In progress → Testing → Completed → Closed. Click the current stage to step back. On your own task, Completed or Closed marks it done. On work given to someone else, Completed is reached only by **approving** it (6.6) — reaching for it opens the review. Work reported done waits at Testing. |
| **The message** | The original Discord message, with **Open in Discord**. |
| **Colour** | The card's colour. |
| **Mark done / Approve or disapprove…, Reopen, Dismiss / Restore, Delete** | On your own task, **Mark done**. On work given to someone else, **Approve or disapprove…** opens the review (6.6). Approved and failed work is final. **Dismiss** keeps the card under "Done & dismissed". **Delete** cannot be undone. |
| **Proof and reviews** | Everything the person sent to show it is done — words, links, pictures, files — and every verdict, oldest first. A reopened task keeps all of it. |

**Add a task by hand:** use the box under the track, with its priority beside it.

### 6.4 Not filed

The folded list under the track holds everything the bot read and did not file.

- **Make it a task** (or **File it anyway** for a repeat) turns a row into a card.
- **Not a task** agrees with the bot and removes the row. **None of these are tasks** does that for every row
  shown.
- Rows never disappear on their own. **Show older** and the search box reach every one.

### 6.5 A person

Click a name to see their open and finished tasks, and how many times work was **disapproved**. Their
**score** (this month and in all) and its latest entries are there for **Lucky35**, and for the person
themselves — with a link to every entry (6.6.2). **Send a note** sends them a DM from your bot,
so say who you are. Your notes and your 1–5 grade are folded at the bottom — the grade is yours alone and the
score never changes it.

### 6.6 Reviewing finished work

Nothing given to someone else finishes on its own. When they report it done — **always with proof**: words, a
link, a picture or a file — it waits for **your review**:

- **who reviews:** whoever created the task. When a teammate gave it out through your bot, it is them; you can
  always review it too, as the board's owner;
- the card says **Finished by <name> · to review**, stays at **Testing**, and the **To review** filter and
  figure count it. It is not Completed until approved;
- your bot DMs the reviewer with the proof and a link straight to the task; the proof is in the task, under
  **Activity**;
- in the detail, choose one of four:

| Choice | Means | Score |
|---|---|---|
| **Approve — on time** | Done by the deadline | Counts towards **+0.5 for every 5** |
| **Approve — late** | Done after the deadline | **−1** |
| **Disapprove…** | Not done | **−1**, and it **reopens**: back to In progress on a new deadline (filled in for you, changeable), so they can finish it. **A note is required** — what was wrong or missing; it is kept with the −1 |
| **Extend deadline…** | More time | **No penalty**; back to In progress on the new deadline |

- the tool marks the approval the facts point to as **suggested** (when they reported it, against the
  deadline); you choose;
- the score moves the moment you choose — written into their score history for good (6.6.2) — and they get a
  DM with your verdict and any note;
- until you decide, the reviewer is reminded **once a day**. Nothing is ever approved on its own.

**The clock stops while it waits for you:** a slow review never makes them late. The reopen and extend forms
start from the time they had left when they reported it, given back from now.

You can also close work given to someone else yourself, without a report: **Approve or disapprove…** on the
open task.

**Clicked by mistake?** The newest verdict on a task has **Undo this verdict** in its **Activity** — as long as
nothing has happened since. The task goes back exactly as it was, the verdict stays listed as *taken back*, its
points get a **correction** in their score history, and the person is told. On Discord you can reply `disapprove: what is missing` to the bot's DM;
it reopens the task the same way.

**Right about the task, wrong about the point?** On a verdict that cost −1, **Correct the −1…** in its
**Activity** adds a +1 correction with your note, and leaves the task as it is. Lucky35 can do it on any
verdict, and so can whoever gave it.

**How far along it is belongs to the person doing it.** On work you gave someone, the stage rail is theirs:
they set **Not started / Started / In progress** (and back), and **Testing** is them reporting it done. You
review; Completed is your approval. If they report it done by mistake, they can **Take my report back** before
you review it.

### 6.6.1 Activity — what has happened on a task

Every task shows its **Activity**, newest first, with the **latest** thing a person did on top:

- who created it and where, and every change to it — stage, deadline (from → to), who has it, priority — with
  **who** made the change;
- every report with its proof, and every verdict (with what it cost, and any taken back);
- every reminder the bot sent the assignee — "reminded Rea — 3 times since …" — and any that did **not** arrive;
- every reminder sent by hand with **Remind now** — who sent it, and their message;
- what people replied to the bot about it.

To ping the assignee right away, use **Remind now** under **Reminders** (the table in 6.3).

### 6.6.2 Scores — the score history

Press **Scores** at the top (`/scores`). Every point anyone gained or lost is an **entry**, kept for good:

- **who**, **how much** (−1 or +0.5), **why** — approved late, disapproved, or 5 tasks approved on time — the
  **task** (for a +0.5, the five), **when**, and **who decided**; a disapproval carries its note;
- choose **Day**, **Week** (Monday to Sunday) or **Month**, and step back and forward with **‹ ›**; times are
  in your time zone. For each person: their **minus** and **plus** points in that period, the period's total,
  and their **score to date**, with the entries underneath. A score is always the sum of its entries;
- **click a minus** (or a plus) number to see just the entries it counted. Each minus says, without another
  click, what it was for: the deadline and when the work was reported done ("due 10 Oct · reported done 12 Oct
  · 2 days late"), the reviewer's note on a disapproval, and **Open task**. On one person's page, the **Minus**
  and **Plus** figures do the same; **Show everything** brings the whole list back;
- **open an entry** for its reason, its note, who decided and when, the task (**Open task**) and its
  **proof**;
- **entries are never edited or deleted** — not by anyone — and they stay even if the task is deleted. A
  mistake is put right by a **correction**: open the entry, **Correct…**, and say why (required). A new entry
  of the opposite amount is added beside it — for example +1, "correction, disapproved by mistake" — and both
  stay listed. Undoing a verdict, or dismissing the task, adds the correction by itself (restoring the task
  counts it again). If one of the five tasks behind a +0.5 stops counting, the +0.5 is taken back and the
  other four count towards the next one;
- an entry counts in the period it was decided in — a correction in the period it was made, so a month
  already closed never changes.

**Who sees what:** each person sees only their own history. **Lucky35** sees everyone's, chooses a person (or
**Everyone**), and can **export** exactly what is on screen — **History CSV** (one line per entry, with task
links) and **Totals CSV** (one line per person) — for raise and bonus reviews. A link to someone else's
history shows nothing to anyone but Lucky35. A correction can be added by Lucky35, and by whoever made the
decision.

### 6.7 Team — who is working on what

Press **Team** at the top. One panel per person you give work to:

- **what they are working on now** — tasks at In progress or Testing, with how long they have been there and
  the countdown;
- **Up next** — open tasks not started yet;
- **waiting for your review** — with a **Review** button that opens the To review filter;
- their **score**, for **this month** and **in all** — shown to Lucky35 only; see below.

People with nothing open show as **Free**. The page is **live**: when someone presses Start or Done, or a
deadline is missed, it changes within a second, without Refresh. The pill in the header says **Live**; if it
says **Not live**, press Refresh.

**The score** is each person's score history added up (6.6.2), and comes from each review (6.6):

- **−1** for work **approved late**, and for work **disapproved** (it reopens).
- **+0.5** for every **5** tasks **approved on time**, counted up — they need not be in a row.
- **Extending** the deadline on review costs nothing.
- A deadline passing does **not** cost anything by itself — the review does. The overdue task stays rose and
  keeps reminding; if they never report it, you can disapprove it.
- Deadlines missed before reviews began (7 October 2026) still count −1 each.
- Each person is scored on their own card, so when one message gave the task to several people, each is
  judged on their own.
- **This month** counts the verdicts given this month, in your time zone; **in all** counts everything.
  Monthly summary shows each person's score for any month.
- Dismissing a task gives its points back, with a correction. Any other mistake is corrected in **Scores**.
- Only Lucky35 sees other people's scores here; everyone sees their own in **Scores**.

**Links:** the address bar follows the card in focus, so a copied link opens the same card. Every reminder
DM links straight to its card, and after signing in you land on it.

### 6.8 Monthly summary

Press **Monthly** at the top. It lists everything **finished** in one month — your own work (including what
others gave you) and the work of each person you gave tasks to — with the day each was finished.

- **‹ ›** move a month back or forward; **This month** comes back. Any past month can be opened, and a link
  to it (`/summary?month=2026-09`) opens the same month.
- The figures: **Finished**, **On time**, **Late** (finished after its deadline), **Added** (tasks that came in
  that month) and **Still open** (how many of those are not finished yet).
- A task counts in the month it was marked done, by your time zone. Work its assignee reported done counts at
  once, and says **waiting for your review** until you review it.
- For Lucky35, each person has their **score for that month** beside their name; it opens their history for
  that month.
- **Copy as text** copies the list, ready to paste into Discord.
- Press a title to open that task on the board.

### 6.9 Developers — who is on what, kept by hand

Press **Developers** at the top. One row per developer: **what they are working on** and their **status** —
Working, Blocked, In review, Idle or Off. It is for work that lives outside the tracker (in ClickUp, say), kept
by hand until ClickUp is connected.

- **Add a developer** by name, or pick them from your server.
- Change the status from its menu; type what they are on and press Enter (or click away) to save.
- Each row says **who changed it last, and when**.
- **Who keeps this list:** pick someone (Naukhaiz, say) under the list. They sign in to the tracker with their
  own Discord, see **Developers** in the header, and can change your list. They see nothing else of yours.
- The page is **live**: a change anyone saves shows on everyone's screen within a second, without reloading.
- **From ClickUp:** when the tracker is connected to the team's ClickUp, each row can be linked to the
  developer's ClickUp person (the **ClickUp** menu on the row), or added straight from **…or add from ClickUp**.
  Under their name you then see every task open on them in ClickUp, with **ClickUp's own status** (dev in
  progress, code review, blocked, to do…) — what is being worked on first, finished work left out — each a link
  to the task. It is read every minute. The typed line and the status menu stay yours to edit. If ClickUp cannot
  be read, the list says so, and why.
- **Found by itself:** everyone who has unfinished work in ClickUp is added to the list automatically ("Added
  from ClickUp"). Nobody is ever taken off by it — to drop someone, press **Hide** on their row; they stay
  hidden even while ClickUp gives them work, and **Hidden (n)** at the bottom shows them again.
- **What a status means:** hover over any ClickUp status to read what it means (blocked = waiting on something or
  someone; code review = the code is finished and waiting for someone to check it…), or open **What these statuses
  mean** at the top of the list.
- **Filter by status:** the buttons at the top (e.g. **blocked · 7**) show only the developers with tasks in that
  status, and only those tasks. Pick several to combine them; **Show everyone** clears it. The choice is kept in
  your browser.
- **Note:** the box marked **Note** on each row is a hand-written note on top of ClickUp — what ClickUp doesn't say.
  Press Enter to save; the row says who wrote it and when.
- **Every task, done ones too:** each row lists what is open first, then **Done (n)** — click to see the finished
  ones, newest first. Filtering by a done status (live, code merged…) shows those too.
- **Developers see their own:** a developer who signs in to the tracker with their Discord sees **Your ClickUp
  tasks** on this page — every task assigned to them, open and done — and nobody else's. They never see the notes
  or the status you keep about them. The tracker knows who they are when their Discord email is exactly their
  ClickUp email; otherwise pick it under **Signs in as…** on their row.

### 6.10 Ask — "did I already give someone a task about…?"

Press **Ask** at the top of the board (it is there once your Discord bot and your Anthropic key are connected) and
type a question in plain words — "Did I give anyone a task about the GPU server?", "who has the thumbnail work?",
or in Vietnamese. Claude reads every task you have given, open and finished, and matches by meaning, not only the
exact words. You get a short answer and the matching tasks — who has each, where it stands, when you gave it and
its deadline; click one to open it. When nothing matches, it says so. It runs on your own Anthropic key and reads
only your own tasks.

---

## 7. Reminders

- **Only tasks with a deadline** and still open are reminded.
- **When:**
  - a day before, an hour before, and when it falls due;
  - on top of that, at the frequency you chose;
  - after the deadline your reminders continue, and stop 30 days past it.
- **To whom:** the assignee (by DM from your bot) and you. Your copy includes a line on how the assignee's
  reminders are going.
- **"No reminder" silences only YOUR copy.** The assignee still gets the day-before, hour-before and when-due
  reminders, plus up to 3 after the deadline (daily).
- **The assignee gets at most 3 reminders after the deadline.** The third says it is the last, and your own
  reminder tells you to follow up yourself.
- **Moving the deadline resets that count.** Changing the person starts their reminders from scratch.
- **Downtime:** if the tracker was down, you get one reminder when it comes back, not a burst of catch-ups.

---

## 8. If you were given a task

### 8.1 My tasks — everything on you, in one place

Sign in at the tracker with Discord. You need no bot and no key of your own. If you have no bot, you land on
**My tasks**; if you have one, press **My tasks** at the top of the board. The page shows:

- **every task given to you by anyone using the tracker**, whether they tagged their bot in a channel or DMed
  it, from any account;
- **everything on you in your own account**;
- the tasks **grouped by urgency**: Overdue · Due today · This week · Later · No deadline · Finished in the
  last 14 days;
- for each task: who gave it, where it came from, its stage, and a live countdown;
- buttons: **Start** (tells them you are on it), **Report done…**, and **Stop reminding me** / **Remind me
  again**.

**Given something that was never yours** — you were only copied in? Open it and press **Not mine**: whoever gave it
to you is told and can take you off it. Do not report it done; that would count it as your work.

**Report done…** asks for **proof** — a few words on what you did, a link, or files (up to 50 MB each; share
bigger ones as a link). It is required. The task then shows **Finished · awaiting review** until whoever gave it
to you decides: approved (on time, or late: −1), disapproved (−1, open again on a new deadline, with the
reason), or more time (no penalty). Their bot DMs you the verdict. Every point is in **Scores**, with its reason
and who decided — only you, and Lucky35, can see yours.

**Moved off you** lists tasks the giver gave to someone else (or took off you) in the last 14 days. Their bot DMs
you when it happens, the task leaves this page at once, and you get no more reminders about it.

Every DM the bot sends you ends with the link to this page.

### 8.2 Answering in Discord

- **When someone gives you a task by DM to their bot**, or picks you on their board, their bot DMs you:
  "**Luka** gave you a task". (A task given in a channel @-mentions you instead.)
- **Reminders** come as DMs from the giver's bot. They show the task, the deadline in *your* time zone, and
  links. For the DMs to arrive, you must share a server with that bot and allow DMs from server members.
- **Reply to any of those DMs** with `start` (you are working on it), `stop` (stops its reminders), or the
  **proof** that it is done — a screenshot, a file, a link, or a few words on what you did. `done` with
  nothing else is not enough: the bot asks for the proof, and your reply to that question is it.
- **In a channel,** tag the bot with the proof — best as a reply to the message that gave you the task. Not a
  reply: if only one task from that person is open on you, it goes on that one; if several are, the bot lists
  them and you reply with the number.
- **If it is reopened or extended,** their bot DMs you why and the new deadline. Reply to that DM with the
  proof when it is finished.
- **DM the bot `my tasks`** for the list of what that person gave you.
- **To ask the bot's owner for something**, DM it the request. The bot asks you first: "Send this to **Luka** as
  a task? Reply `yes`". Only your `yes` (in reply to that question) puts it on their board; `no` drops it. A
  plain "ok, thanks" or small talk just gets 👀 and goes nowhere.
- **Old threads still work.** A `done` in reply to a reminder from weeks ago is read and answered — within the
  hour at most. If that task was already closed, or moved to someone else, the bot says so.

**Everything else belongs to the giver.** They are told what you did. If you stop and resume reminders within
a few minutes, they hear once, about where it ended up — never nothing, never a stream of notes.

---

## 9. Limits (Discord's rules, not settings)

- **No bot can read a DM between two people.** Your bot reads only DMs sent **to it**: from you, and from the
  people you have given work to or keep notes on. Once it has read a conversation it keeps reading it — every
  minute while there is work in it, at least hourly after. Discord does not let a bot find a conversation
  someone else opened, so a stranger who DMs your bot first is not heard.
- **The bot only sees servers it was invited to**, and channels it may read.
- **Messages appear within about a minute**, because the tracker checks every minute.
- **Edits:** a tag added by editing is noticed while the message is among the channel's newest 100. Further
  back, Backfill finds it. Deleted messages are not noticed.
- **Watching a channel starts from the moment you switch it on.** Earlier messages need **Backfill past
  tasks**.

---

## 10. Troubleshooting

| Problem | What to do |
|---|---|
| The **Not tracking yet** banner | Finish Settings: bot, Claude, at least one channel. |
| Cards arrive with empty text | Switch on **Message Content Intent** on the bot's Bot tab. |
| No ✅ in one channel, and a **cannot react** notice | Press **Invite again** for that server. Tags there are still filed, and answered by DM. |
| "Claude reported … only Haiku …" | You are on a subscription. Choose **Claude Haiku 4.5**. |
| Deadlines are hours off | Check **Your time zone** in Settings. |
| The bot misjudged a message | Open **Not filed** and press **Make it a task**. |
| A card you did not want | **Dismiss** (kept under Done & dismissed) or **Delete**. |
| A card reads "Filed from the message's own words — Claude could not read it" | Claude would not read that message. Check the title and the details. |
| The assignee is not being reminded | Read the line under the deadline. Their DMs may be refused, they may have switched reminders off, or the limit after the deadline may be reached. |
| **History to read again** in Settings | Press **Backfill past tasks**. |
| Backfill skipped a channel | The message says why, usually a missing *Read Message History* permission. Fix it and press again. |

---

## 11. Privacy

- **Your own bot, your own Claude.** Nobody's messages are read with anyone else's credentials.
- **Only messages that tag your bot are stored.**
- **Tokens and keys are encrypted** and never sent to the browser.
- **Nobody sees another person's board**, except the tasks given to them.
