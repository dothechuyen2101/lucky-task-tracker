# DESIGN — task-tracker

preset:   high-end
audience: Luka, on his phone and his desk, several times a day — then everyone else on his team
palette:  #08080F #0F1020 #14162A #F3F4FA #9AA2BE #7C5CFF #22D3EE #34D399 #FBBF24 #FB7185
type:     Space Grotesk / Inter / JetBrains Mono (figures)
density:  comfortable — one task per card, and the card in focus shown whole beside the track
motion:   restrained but present — 140–280ms, nothing that delays a click
avoid:    the industrial/terminal look — flat near-black, hairline grey rules, all-mono body text, square corners, zero depth

## The read

This is the same console language as **`vdm-project-manager`**, which took it
from **`impressions`**, which is the look Erik asked for by name ("match the
aesthetic I have in Luka's programs"). Erik's ruling on 2026-08-22 — *"that
shitty industrial look — something more modern and gamey"* — applies here too.

The tokens, surfaces, buttons, fields, figures strip and expand-a-row behaviour
are carried over **unchanged and on purpose**. Luka already reads the project
manager; he should not have to learn a second interface to read this one. If you
find yourself improving a shared component here, improve it in both.

## What is different here: colour means TIME

The project manager spends its whole colour budget on progress — a run of
filled pips in the project's own hue. There are five stages here too
(`lib/stages.ts`) and a rail in the task detail that sets them, but they are
not what the page is about, and they are not where the budget goes. The
question this product answers is **how soon**, so that is what carries the
colour. The rail wears the task's own identity hue.

- **Overdue is rose.** **Due today is amber.** Everything further out is neutral,
  wearing the task's own hue only on its identity dot.
- That tint lands on **the countdown and the deadline field** — the actual data
  — never on a card's frame. Same rule the project manager settled on when
  `impeccable`'s detector flagged its leading-edge stripe: colour goes on the
  data, never on chrome that merely repeats it. An overdue task says so in
  words, on a rose pill, beside a figure counting up.
- What a task arrived **without** — a person, a deadline — is shown where that
  data would be, as a dashed, colourless pill. A gap is not a time, so it takes
  none of the time colours.

**Violet is still never data.** `--accent` #7C5CFF is buttons, focus rings and
the active state — the things you press. It appears in the task palette only as
one of sixteen hues, which is the one concession, and a task wearing it still
never renders as a control.

**Cyan is "on".** A watched channel chip, an armed reminder cadence, and the
"next reminder" figure are all `--accent-2`. There are exactly two live states in
this product — *this channel is being read* and *this task will ping you* — and
they are the two most consequential things on their pages, so they share one
colour and nothing else uses it.

## The track and the card in focus

Lucky35's ruling, 2026-09-28: every task is its own card, carrying the name of
the person it was given to; the cards run along a **track** that slides left and
right; the card in focus is shown **in full beside it**. It replaced a table
1268px wide that scrolled sideways and made it impossible to look at one person.

- **A card shows; the detail acts.** A card carries the countdown, the task and
  the person — and exactly three things you can press: the task (focus it), the
  name (open the person), and **All tasks** (everything they were given, as
  smaller cards). Everything that changes a task lives in the detail area.
- **The detail always matches the track.** Focus is one value, held by the
  board and handed to both. Scrolling the track moves it; so do the arrows,
  ← / →, and pressing a card's title.
- **Focus is violet**, because focus is the interface's active state. It never
  says how soon.
- The **deadline field** is still a plain `datetime-local`, and the **frequency
  dropdown** is still visibly disabled until a deadline exists — the rule "no
  deadline, no reminders" is enforced in `lib/reminders.ts`, and disabling the
  control is how the user learns it before they discover it.
- A task **somebody else gave you** is shown whole, with a lock and who it came
  from, and offers exactly the assignee's two answers — **Mark done** and **Stop
  reminding me** — and nothing the database would refuse.
- **One clock says "overdue".** The seconds figure counts; the board decides.
  The board ticks at the exact instant a deadline passes, so the word on the
  card, the Overdue count and the order of the track change together — a card
  never says Overdue while the number beside it says otherwise. Finished work
  shows how it ended ("Done by minh"), never a countdown.
- **Closing a card keeps your place.** Done, Dismiss or Delete moves focus to
  the next card (the one before, at the end of the track), never back to the
  first; the rest of a double-click that lands on the card sliding in is
  ignored; keyboard focus follows into the new detail.
- **Times are the person's.** Every date and the deadline field read in their
  own zone (`tt_profiles.timezone`); the field saves when you leave it, not per
  keystroke, and says which zone it is in.
- **The description comes first.** Cenri, 2026-10-05: people add tasks for
  themselves and need to see what to do at a glance. The description sits
  directly under the title, in ink body text — not a faint hint — and its field
  is as tall as what is written, so a description of ten lines is read whole,
  with no scrollbar; past a cap it scrolls, and its corner drags. The assignee
  reads the same words as plain text in the same place.

## Answering a tag

Every tagged message gets a reaction on Discord within a minute: **✅** filed
(or already on the board), **👀** read and not filed. The absence of either is
itself the signal — the bot never saw it — with one exception the board owns
up to: where the bot is not allowed to react, a notice at the top names the
channel and offers the re-invite, so a missing ✅ there is never read as
"unread" and tagged again. That notice uses the same rose frame as "Not
tracking yet": it is the product telling you part of it is not working.

A reaction is only an answer while someone is looking at the message. A tag
read late — added by an edit, found by Backfill, or simply read after the
tagger had moved on — gets its reaction AND a DM to whoever tagged, saying what
became of it and that it needs no second tag. That DM is batched per person and
spaced, so a Backfill of a busy year is two or three messages, not a flood.

Someone tagging your bot about work for a third person gets the same 👀 and a
one-line reply saying whose tasks this bot tracks — nothing of theirs is kept.
A tag found in history is never replied to under a months-old message; its
answer is the DM.

What was read and not filed sits folded under the track as **Not filed**,
colourless (it is not about time), each row one press from becoming a card or
from being agreed "not a task". It is folded because it is the exception; a
board that led with its own misses would read as broken. It never ages rows
off — the count in its header is how a growing pile stays visible while
folded — and a count is never where a row ends up: past the first page, **Show
older** and the search box reach every one.

## My tasks

Lucky35's ruling, 2026-10-02: the people who work closely with Luka need one
place to see what is on them, not a hunt through DMs and channels. **My tasks**
is that place — every task given to the person looking, by anyone, from any
account, as rows grouped by how soon (Overdue · Due today · This week · Later ·
No deadline · recently finished). It is a list, not a track: the person reading
it wants the whole of their week at once, not one card at a time.

- The same time colours as everywhere: rose overdue, amber today, on the
  countdown only; the row wears the task's hue on its swatch alone.
- Each row says who it came from and where ("from Luka · by DM"), and offers
  exactly the assignee's answers — **Mark done**, **Stop reminding me** — beside
  it. Pressing the title opens the card on the board.
- Someone with no bot of their own lands here; the board is one press away for
  everyone else (**My tasks** in the header).
- A task given by DM never offers "Open in Discord" to its assignee: only the
  giver can open their DM with their bot.

## Team, review, and the score

Lucky35, 2026-10-04: Luka wanted to see who is on what, and a missed deadline
to count. **Team** is a list of people, not of tasks — one panel per person,
their working tasks as the same rows My tasks uses, what waits behind folded
under it, and a one-line "waiting for your review" with a button to the
**To review** filter.

- The **score** is a figure: mono, tabular, on a pill. Down is rose, because a
  missed deadline is an overdue that happened; zero is neutral, never green —
  not missing deadlines is the expectation, not an achievement to colour. Up
  (+0.5 for every 5 on time, Lucky35's PO 2026-10-05) is neutral for the same
  reason. Two pills side by side — **Month** and **All** — with what makes each
  up in its tooltip ("+0.5 from 1 · −2 from 2"), one press from the person's
  history. Only Lucky35 sees other people's pills; for anyone else they are
  not there at all — an empty pill would read as a clean 0.
- **Everyone tagged has a card.** A message that tagged Cenri and Rea makes two
  cards in one hue — they read as one request — each naming its person; the
  detail says who else has it ("Also given to"), one press from their card.
  The message under a card reads with names, never a snowflake.
- **"Given to" is anyone in the servers**, picked from a list that opens in
  place under the field (the detail column scrolls inside itself; a floating
  list there is clipped), searchable, with where each person was found.
- **Waiting for review** is amber words on the status ("Finished by Minh · to
  review"), never a frame round the card — colour on the data, as everywhere.
  It is not struck through and the rail stays at Testing: it is not finished
  until approved. The review sits at the top of the detail while it waits.
- **The review is four buttons, each saying what it costs** — Approve on time
  (+), Approve late (−1), Disapprove… (−1), Extend deadline… (0), the figure in
  mono beside the words. The one the facts point to carries a small uppercase
  **Suggested** tag and is the primary button; the reviewer may press any.
  Disapprove opens its reason and the new deadline; its button is rose
  (`btn-danger-solid`), because it costs the person, and stays disabled —
  with a rose line saying why — until a note is written. Reopen and Extend
  show the new deadline field, warning in rose if it is not in the future.
- **Proof and reviews** is a plain timeline under the detail: words as text,
  links as links, pictures as thumbnails, files by name and size, and each
  verdict with who gave it and its −1 ("not counted" when excused).
- **The score history** (`/scores`, PO 2026-10-09) is a ledger, and looks
  like one: per person a row of mono figures — minus (rose), plus, the
  period's total and the score to date, each count small and faint beside
  its sum — and under it the entries, newest first: the points in mono, the
  reason in ink, the task muted, the date in mono. Plus is ink, never green.
  Day / Week / Month is a segmented control (violet when on: it is a
  control); the period steps with the same ‹ › as Monthly.
- **An entry opens in place**: a definition list (Reason, Note, Decided,
  Reverses / Corrected), the tasks with **Open task**, and the proof as the
  task's Activity shows it. A correction is an entry like any other, with its
  own sign, linked both ways — never a strike-through: nothing in the history
  was unwritten. **Correct…** is a plain button that opens a required note.
- **A history that is not yours** is a plain panel saying so — no empty table
  that could pass for "no points".
- "Live" is the green status pill in Team's header; when the connection drops
  it turns rose and says to press Refresh, rather than going stale in silence.
- Project channels in Settings reuse the channel chips, each carrying its move
  ("Done →", "← Active"). They are not cyan: being sorted into a category is
  not one of the two "on" states.

## Priority, sort and filter

The PO's task, 2026-10-07: High, Medium, Low on every task, and the board
sorted and filtered by it. Priority is not time, so it takes **no colour**.

- On a card, **High** is an outlined pill in ink and **Low** a dashed, faint
  one; Medium, the default, shows nothing — a board where every card says
  "Medium" says nothing at all.
- In the detail it is a three-way segmented control; the active segment is
  violet, because it is a control. The assignee reads it as a pill.
- The **view bar** sits under the tabs: small uppercase labels, a Sort select,
  the priority toggles, two mono date fields for the deadline range, and
  **Clear** only when something is set. It wraps on a phone; nothing in it
  scrolls sideways. An empty track with a filter on says so, with Clear.

## Monthly summary

Cenri, 2026-10-05: a page that says what got done in a month, for any month.
**Monthly** in the header opens it; it is a page of its own (`/summary`), not
a screen of the board, because the board only carries recent closed work.

- One month at a time, with **‹ ›** beside its name and nothing past the
  current month. A month is the person's calendar, in their zone.
- The figures strip (Finished · On time · Late · Added · Still open), then My
  tasks' rows grouped by who did the work — the viewer first — each with the
  day it was finished, in mono, where the countdown would be.
- Colour stays on the data: **late by 2 days** is rose, because a late finish
  is an overdue that happened; **waiting for your review** is amber words.
  On time is neutral, never green — the same reason the score's zero is.
- **Copy as text** is the report: the same list as plain text, ready to paste
  into Discord, with the viewer named, not "You".

## Developers

Lucky35's PO, 2026-10-05: which developer is on what, live, for work that
lives in ClickUp. A page of its own (`/developers`), kept by hand by the owner
and the people they name; the header offers it to both.

- One row per developer: the name and a **status pill** on the first line, a
  plain field for what they are on under it, "updated 10 minutes ago by
  Naukhaiz" under that. Typed in place, saved on Enter or leaving the field.
- The status is the one coloured thing on a row: **Working** green like the
  Live pill, **Blocked** rose like everything that needs someone, **In review**
  amber like "to review"; Idle and Off stay neutral.
- "Who keeps this list" sits under the owner's list as chips with a ×, and the
  same person picker as "Given to". An editor sees the lists they keep and
  nothing else.
- Live like Team: the same green pill, and every change on screen within a
  second.

## Rules that hold

- The track scrolls **inside** itself; the page body never scrolls sideways. On
  a phone the detail drops under the track, the four filters go two by two, the
  header's buttons wrap, and a button carrying a server's name wraps too.
- Figures — counts and countdowns — are JetBrains Mono with `tabular-nums`. A
  seconds counter without them reflows its own width every second.
- The countdown ticks in its own leaf (`components/clock.ts`), never in board
  state, so a second passing re-renders nothing but the figures.
- `prefers-reduced-motion` kills every transition, and the track jumps instead
  of gliding.
- Single-theme dark by design (`color-scheme: only dark`), every colour painted
  explicitly, so it holds whatever ground the host paints behind it.
- Empty states say what to do next, never just "no data". A tracker with nothing
  in it is the normal first experience, not an error — the empty track shows the
  exact message to type.
