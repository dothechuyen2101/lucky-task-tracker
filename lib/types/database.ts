/**
 * Hand-written to match `supabase/migrations/20260902_01_task_tracker_core.sql`.
 * Regenerate once the schema settles:  Supabase MCP -> generate_typescript_types
 */

export type Profile = {
  id: string;
  discord_user_id: string | null;
  discord_username: string | null;
  avatar_url: string | null;
  timezone: string;
  reminder_channel_id: string | null;
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The view, not the table. `tt_connections` itself is unreadable from the
 * browser by design; this is everything the UI is allowed to know.
 */
export type ConnectionStatus = {
  user_id: string;
  discord_connected: boolean;
  discord_bot_user_id: string | null;
  discord_bot_username: string | null;
  discord_connected_at: string | null;
  discord_last_error: string | null;
  discord_user_linked: boolean;
  discord_user_token_expires: string | null;
  anthropic_connected: boolean;
  anthropic_key_hint: string | null;
  anthropic_model: string;
  anthropic_credential_kind: "api_key" | "oauth" | null;
  anthropic_connected_at: string | null;
  anthropic_last_error: string | null;
};

export type Guild = {
  id: string;
  user_id: string;
  guild_id: string;
  guild_name: string | null;
  icon: string | null;
  bot_present: boolean;
  can_invite: boolean;
  refreshed_at: string;
};

export type Channel = {
  id: string;
  user_id: string;
  guild_id: string;
  guild_name: string | null;
  channel_id: string;
  channel_name: string | null;
  watching: boolean;
  last_message_id: string | null;
  backfill_before_id: string | null;
  backfill_done: boolean;
  backfill_messages: number;
  backfilled_at: string | null;
  last_polled_at: string | null;
  last_error: string | null;
  /**
   * Why the bot could not answer a tag here — no Add Reactions in this channel
   * (`20260929_02`). While it is set, no ✅ here does NOT mean "unread", and the
   * board says so. Cleared by the next reaction that goes through.
   */
  react_error: string | null;
  react_error_at: string | null;
  /**
   * Set when this channel's history was read before the bot's role in its
   * server was known, so tags of the role in that history were passed over.
   * Backfill reads it again and clears this.
   */
  rescan_reason: string | null;
  /** The Discord category the channel sits in, as of the last Refresh or move (`20261004_01`). */
  parent_id: string | null;
  parent_name: string | null;
  created_at: string;
};

/**
 * The two categories the tracker moves a server's project channels between
 * (`20261004_01`). Null until the first move creates or finds them.
 */
export type ProjectCategories = {
  id: string;
  user_id: string;
  guild_id: string;
  active_category_id: string | null;
  done_category_id: string | null;
  updated_at: string;
};

/** A channel where the bot could not react — what the board's warning lists. */
export type BlockedChannel = Pick<Channel, "channel_id" | "channel_name" | "guild_id" | "guild_name" | "react_error">;

export type Message = {
  id: string;
  user_id: string;
  guild_id: string | null;
  channel_id: string;
  channel_name: string | null;
  message_id: string;
  content: string;
  jump_url: string | null;
  sent_at: string;
  author_id: string | null;
  author_name: string | null;
  /**
   * `dm_in` (`20261002_01`): a DM to the bot from someone other than its owner,
   * not read yet. It becomes an answer about their own tasks, or a `received`
   * task for the owner.
   */
  direction: "sent" | "received" | "command" | "dm_in" | "report";
  /** The files the message carried, as Discord sent them (`20261007_01`) — a report's proof. */
  attachments?: DiscordAttachment[];
  /** The bot's "which task is this for?" list, when the sender had several open (`20261007_01`). */
  proof_pick_message_id?: string | null;
  /** The task ids that list offered, in its order. */
  proof_task_ids?: string[] | null;
  /**
   * Users @-mentioned in the message, excluding the tracker bot, in the order
   * Discord returned them. Defaults to `[]` in the database, never null.
   * Only messages ingested after `20260907_01` carry these — both upserts run
   * with `ignoreDuplicates`, so a re-poll skips an existing row, it does not
   * merge into it.
   */
  mentions: Array<{ id: string; name: string }>;
  reply_to_message_id: string | null;
  command_target_task: string | null;
  command_result: string | null;
  classified_at: string | null;
  is_task: boolean | null;
  classification_reason: string | null;
  classification_error: string | null;
  /**
   * Set when a TAGGED message was read and deliberately not filed as a task —
   * thanks, chatter, a question to the bot, a command it could not apply, or a
   * repeat of a request already on the board. `20260929_01`/`_02`. Null on
   * everything else, including the untagged rows the old read-everything rule
   * stored. These are the board's "Not filed" list.
   */
  skip_category: SkipCategory | null;
  /**
   * When a person looked at a "Not filed" row and agreed it is not a task.
   * Rows stay on the list until then — they never age off it (`20260929_02`).
   */
  skip_reviewed_at: string | null;
  /** Found by Backfill rather than read live (`20260930_01`). History is never replied to in public; it is answered by DM (`answer_owed`). */
  backfilled: boolean;
  /**
   * Answers from Claude that could not be used for this message (`20260930_02`).
   * Above zero it is classified alone; at `MAX_CLASSIFY_ATTEMPTS` it is filed
   * from its own words rather than holding up the queue.
   */
  classify_attempts: number;
  /**
   * Why the tagger is owed an answer by DM (`20260930_03`): 'late' — read well
   * after it was written, or found by Backfill, where a reaction is seen by
   * nobody — or 'unmarked' — no ✅ / 👀 could be put on it. Null when the
   * reaction was answer enough.
   */
  answer_owed: "late" | "unmarked" | null;
  /** When the DM answering it went out, or was given up on. */
  answered_at: string | null;
  /** Whose Discord that DM went to: the tagger, or the owner in their place. */
  answered_to: string | null;
  /** Written by a bot or a webhook — an integration — not a person. */
  from_app: boolean;
  /** The bot's "send this as a task?" DM, for a request from someone other than the owner (`20261003_01`). */
  confirm_message_id: string | null;
  /** When that sender said yes. A confirmed request is filed even if read as small talk. */
  confirmed_at: string | null;
  /**
   * Sent to the bot in a private message rather than tagged in a channel
   * (`20261002_01`). Counts as a tag, and is answered in the DM itself.
   */
  via_dm: boolean;
  created_at: string;
};

export type SkipCategory = "thanks" | "chatter" | "question" | "command" | "duplicate";

/** A tagged message the tracker read and did not file — what the board's "Not filed" list holds. */
export type SkippedMessage = Pick<
  Message,
  | "id"
  | "content"
  | "jump_url"
  | "sent_at"
  | "channel_name"
  | "author_name"
  | "direction"
  | "mentions"
  | "classification_reason"
  | "via_dm"
  | "author_id"
> & { skip_category: SkipCategory };

/** One file on a Discord message, as stored on `tt_messages.attachments`. */
export type DiscordAttachment = {
  id: string;
  filename: string;
  url: string;
  content_type?: string | null;
  size?: number | null;
};

/** 'failed' (`20261007_01`): disapproved and closed — it ends there. */
export type TaskStatus = "open" | "done" | "dismissed" | "failed";

/** `tt_tasks.priority` (`20261007_01`): medium unless somebody said otherwise. */
export type Priority = "high" | "medium" | "low";

/** One person a name typed in a DM might mean: shown to the owner to pick from. */
export type AssigneeCandidate = {
  id: string;
  /** The name stored as `assignee_name` when picked: their username, or the name the board knows. */
  name: string;
  /** "Bob Tran (@bob_t)". */
  label: string;
  /** Where they were found: "worked with before", or a server's name. */
  where: string | null;
};

export type TaskDirection = "given" | "received";

export type ReviewState = "pending" | "accepted" | "rejected" | "extended";

/** A reviewer's verdict (`20261007_01`) — what each one does to the score is in `lib/review.ts`. */
export type ReviewDecision = "approve_on_time" | "approve_late" | "disapprove_close" | "disapprove_reopen" | "extend";

/**
 * One verdict on a task (`tt_task_reviews`, `20261007_01`). The history a
 * reopened task keeps. Written only through `tt_give_verdict` /
 * `tt_undo_verdict` (`20261009_01`), which write its points to the permanent
 * score history (`ScoreEntry`) in the same transaction; nobody edits it from
 * the board any more.
 */
export type TaskReview = {
  id: string;
  /** The board the task is on. */
  user_id: string;
  task_id: string;
  reviewer_discord_id: string | null;
  reviewer_name: string | null;
  /** Whose score it moves. */
  assignee_discord_id: string | null;
  assignee_name: string | null;
  task_title: string;
  decision: ReviewDecision;
  note: string | null;
  /** The deadline it was judged against, and the one it was given after. */
  deadline: string | null;
  new_deadline: string | null;
  /** When the assignee reported it done; null when it never was. */
  finished_at: string | null;
  decided_at: string;
  excused_at: string | null;
  /** 'undone': the reviewer took the verdict back (`20261007_02`); it is kept, and counts nothing. */
  excused_reason: "by_hand" | "dismissed" | "undone" | null;
  /** What the task was before this verdict, so it can be taken back. Null on verdicts from before undo existed. */
  before?: Partial<Task> | null;
  /** What it made of the task: undo is allowed only while the task still stands so. */
  after?: Partial<Task> | null;
};

/**
 * One change to a task, and who made it (`tt_task_events`, `20261007_02`),
 * written only by the database. `changes` is `{field: [before, after]}`; on
 * 'created', what the task started with. No actor: the tracker itself.
 */
export type TaskEvent = {
  id: string;
  user_id: string;
  task_id: string;
  at: string;
  actor_discord_id: string | null;
  actor_name: string | null;
  /** 'reminded': a reminder sent by hand (`/api/tasks/remind`) — changes {to, message, ok, error}. */
  /** 'not_mine': the assignee said it is not theirs, and whoever reviews it was told (`20261020_01`). */
  kind: "created" | "changed" | "reminded" | "not_mine";
  changes: Record<string, unknown>;
};

/** What the assignee sent to show it is done (`tt_task_proofs`, `20261007_01`). */
export type TaskProof = {
  id: string;
  user_id: string;
  task_id: string;
  submitted_by_discord_id: string | null;
  submitted_by_name: string | null;
  source: "board" | "discord";
  kind: "text" | "link" | "file";
  body: string | null;
  file_path: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  discord_url: string | null;
  message_url: string | null;
  created_at: string;
};

/**
 * A task's assignee changed (`20261004_02`), written by a trigger. The person
 * it was taken from can read it — so their board drops the task and says why
 * — and the worker DMs them once (`told_at`).
 */
export type TaskHandoff = {
  id: string;
  /** The giver. */
  user_id: string;
  task_id: string;
  task_title: string;
  /** The giver's name, as the task carried it. */
  owner_name: string | null;
  from_discord_id: string;
  from_name: string | null;
  /** Null: taken off them and given to nobody. */
  to_discord_id: string | null;
  to_name: string | null;
  moved_at: string;
  /** Whether they had been told the task was theirs. */
  from_was_told: boolean;
  task_open: boolean;
  told_at: string | null;
};

/**
 * One deadline a task's assignee missed, from before reviews decided the score
 * (`20261004_01`). Nothing records new ones (`20261007_01`); those that
 * counted are entries of the score history (`20261009_01`), and a dismissal
 * still corrects them there. Nobody edits a miss from the board any more.
 */
export type DeadlineMiss = {
  id: string;
  /** The giver — whose board this score is on. */
  user_id: string;
  task_id: string;
  assignee_discord_id: string;
  assignee_name: string | null;
  task_title: string;
  deadline: string;
  recorded_at: string;
  excused_at: string | null;
  /**
   * 'assigned_late': already past when it was given to them (`20261005_01`).
   * 'redated': the deadline was moved after it passed — only the last one
   * counts (`20261005_02`).
   */
  excused_reason: "by_hand" | "dismissed" | "before_tracking" | "assigned_late" | "redated" | null;
};

/** Why a point moved (`tt_score_entries.reason`, `20261009_01`). */
export type ScoreReason = "approved_late" | "disapproved" | "on_time_bonus" | "missed_deadline" | "correction";

/**
 * Why a correction was written. 'by_hand': Lucky35 or whoever decided it,
 * with a note. The rest the database writes itself: a verdict taken back, a
 * task dismissed (or restored), one of a +0.5's five no longer counting —
 * and, from before the history existed, an excuse or a moved deadline.
 */
export type CorrectionCause =
  | "by_hand"
  | "verdict_undone"
  | "task_dismissed"
  | "task_restored"
  | "bonus_member_lost"
  | "excused"
  | "deadline_moved";

/**
 * One point a person gained or lost (`tt_score_entries`, `20261009_01`).
 * Permanent: never updated, never deleted — a mistake is reversed by a
 * correction (`corrects`), and both stay. A person's score is the sum of
 * their entries. Readable by the person it is about, and by Lucky35
 * (`tt_score_admins`).
 */
export type ScoreEntry = {
  id: string;
  /** Write order — what "the latest in a chain" means. */
  seq: number;
  /** The original this chain began with; an original's own id. */
  root_id: string;
  /** The entry this one reverses, on a correction. */
  corrects: string | null;
  /** The board it was earned on. */
  user_id: string | null;
  person_discord_id: string;
  person_name: string | null;
  /** −1, +0.5, or a correction's +1 / −0.5. Postgres `numeric` arrives as a string. */
  amount: number | string;
  reason: ScoreReason;
  correction_cause: CorrectionCause | null;
  note: string | null;
  /** One task, or the five of a +0.5 — titles as they were then. */
  task_ids: string[];
  task_titles: string[];
  review_ids: string[];
  miss_id: string | null;
  decided_at: string;
  decided_by_discord_id: string | null;
  decided_by_name: string | null;
  recorded_at: string;
  backfilled: boolean;
};

export type Task = {
  id: string;
  /**
   * Who owns the row: the person who gave the task. NOT always the viewer —
   * since `20260928_01` the assignee can read a task given to them, so a board
   * holds rows owned by other accounts. Compare with the viewer's own id before
   * offering any control that writes.
   */
  user_id: string;
  /** The owner's Discord name when the row was written. A label for the assignee's view, never a key. */
  owner_name: string | null;
  message_id: string | null;
  direction: TaskDirection;
  counterparty: string | null;
  /** Discord snowflake of the person the work was handed to. The grouping key. */
  assignee_discord_id: string | null;
  /** Mutable display label only — null is normal even when the id is set. */
  assignee_name: string | null;
  /** 0 not started · 1 Started · 2 In progress · 3 Testing · 4 Completed · 5 Closed */
  stage: number;
  stage_at: Record<string, string>;
  title: string;
  detail: string;
  source_excerpt: string | null;
  source_url: string | null;
  color: string;
  status: TaskStatus;
  deadline: string | null;
  suggested_deadline: string | null;
  /** Who set `deadline`: the classifier ("auto") or a person ("manual"). A machine pass never overwrites "manual". */
  deadline_source: "auto" | "manual";
  alert_every_minutes: number | null;
  next_alert_at: string | null;
  last_alert_at: string | null;
  alerts_sent: number;
  /**
   * The assignee's own reminder stream (`20260929_01`), kept apart from the
   * giver's `alerts_sent` so the giver can see whether the person they handed
   * the work to is actually being reminded.
   */
  assignee_alerts_sent: number;
  assignee_last_alert_at: string | null;
  /** Why the last DM to the assignee failed — usually their DMs are closed. Null after a success. */
  assignee_last_error: string | null;
  /** DMs sent to the assignee after the deadline passed. Capped; reset when the deadline moves. */
  assignee_overdue_alerts: number;
  /** When reminders to the assignee were switched off, and by whom. The giver's own keep going. */
  assignee_muted_at: string | null;
  assignee_muted_by: "owner" | "assignee" | null;
  /** Who closed it: the owner (null on older rows) or the assignee from their side. */
  completed_by: "owner" | "assignee" | null;
  /**
   * When the assignee was told the task exists — by the @-mention that created
   * it, or by a DM from the bot (`20261002_01`). Null: they are owed that DM.
   * Reset when the assignee changes (`FRESH_ASSIGNEE_STREAM`).
   */
  assignee_told_at: string | null;
  /**
   * Who a name typed in a DM might mean, when it matched nobody exactly
   * (`20261003_01`). No assignee until the owner picks one; cleared then.
   */
  assignee_candidates: AssigneeCandidate[] | null;
  /** What the giver last heard about the assignee's reminders. Null reads as on. */
  assignee_mute_told: "muted" | "unmuted" | null;
  assignee_mute_told_at: string | null;
  /** A switch inside the quiet window, owed to the giver once it passes. */
  assignee_mute_notice_due: boolean;
  /**
   * Review of work the assignee says is finished (`20261004_01`). 'pending':
   * they marked it done and the giver has not looked yet. 'accepted': the
   * giver agreed. 'rejected': the giver sent it back, and it is open again.
   * Null: never through review.
   */
  review_state: ReviewState | null;
  reviewed_at: string | null;
  /** What the giver said was missing, the last time they sent it back. */
  review_note: string | null;
  /** How many times it was sent back. */
  review_rejections: number;
  /** When the giver is next reminded that it waits for their review (`20261004_02`). */
  review_nudge_at: string | null;
  /** How many of those reminders went out. */
  review_nudges: number;
  /**
   * Who asked for it, when that was not the board's owner (`20261006_02`): the
   * author of the message that tagged the owner's bot — asking the owner, or
   * handing it to someone through the owner's bot. They can READ the row
   * ("tasks I asked for readable"), and see it under "I asked for".
   */
  requested_by_discord_id: string | null;
  requested_by_name: string | null;
  /**
   * Who the SERVER last changed this task for, and when (`20261007_02`): the
   * activity trigger credits a write to them only when `last_actor_at` moved
   * in that same write. The board's writes are credited from the sign-in.
   */
  last_actor_discord_id?: string | null;
  last_actor_name?: string | null;
  last_actor_at?: string | null;
  /**
   * High, medium or low (`20261007_01`). Optional only because a board can
   * load before the migration: read it through `priorityOf`, which says medium.
   */
  priority?: Priority;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /**
   * Everyone a message tags gets their own card (`20261005_01`): the message
   * every card it filed came from. `message_id` is set on the first card only.
   * Optional because a board can load before the migration is applied.
   */
  source_message_id?: string | null;
  /** This card's place among them: 0 for the first person named. */
  message_part?: number;
  /** Who the message @-mentioned — the people its cards went to — for reading it back with names. */
  source_mentions?: Array<{ id: string; name: string | null }>;
  /** Filed before everyone tagged got a card: the worker gives each person theirs, once. */
  split_pending?: boolean;
  /**
   * Who the message only copied in — tagged after "cc" / "fyi" (`splitCc`,
   * `20261020_01`), or taken off a card as "only cc'd". No card, no reminders;
   * named on the task. A name typed as words in a DM has no id.
   */
  cc?: Array<{ id: string | null; name: string | null }>;
  /** Why it was dismissed, when it says: 'only_cc' — its person was only copied in. Cleared on restore. */
  dismiss_reason?: "only_cc" | null;
};

/**
 * A person you hand work to — the owner's own notes and hand-set grade for
 * them. `supabase/migrations/20260907_02_people.sql`.
 *
 * Rows are created lazily by the person panel's upsert, so a person who has
 * tasks but no `tt_people` row is the normal first state; reads use
 * `.maybeSingle()`, never `.single()`.
 *
 * `discord_user_id` is the same snowflake as `Task.assignee_discord_id` and is
 * the whole join. `display_name` is a mutable label, never a key, and
 * `avatar_url` is read from whatever filled it — nothing here fetches Discord.
 * `grade` is set by a human and by nothing else; the database enforces 1–5.
 */
export type Person = {
  id: string;
  user_id: string;
  discord_user_id: string;
  display_name: string;
  avatar_url: string | null;
  notes: string;
  grade: number | null;
  created_at: string;
  updated_at: string;
};

/** How a developer's work is going (`20261005_03`). */
export type DeveloperStatus = "working" | "blocked" | "review" | "idle" | "off";

/**
 * One developer on an owner's Developers list: what they are on and how it is
 * going, kept by hand by the owner and the editors they name (`20261005_03`).
 * `updated_at` and `updated_by_name` are written by the database.
 */
export type Developer = {
  id: string;
  owner_id: string;
  name: string;
  discord_user_id: string | null;
  working_on: string;
  status: DeveloperStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
  /** The ClickUp person this developer is (`20261012_01`); null when not linked. */
  clickup_user_id?: string | null;
  /** The Discord person they sign in as — matched by email, or set by a manager (`20261012_03`). */
  discord_name?: string | null;
  /** What is open on them in ClickUp, written by the worker alone (`lib/clickup-sync.ts`). */
  clickup_tasks?: ClickUpTaskSummary[];
  /** Hidden by whoever keeps the list (`20261012_02`); ClickUp never adds them again while the row exists. */
  hidden_at?: string | null;
  /** "clickup": added by the worker because they have unfinished work there. */
  added_from?: "hand" | "clickup";
};

/** Every task of the ClickUp workspace feeding a list (`tt_clickup_tasks`, `20261012_03`), done ones too. */
export type ClickUpTask = {
  owner_id: string;
  id: string;
  name: string;
  url: string;
  /** ClickUp's own status name (lower case) and colour, as the team set them. */
  status: string;
  color: string | null;
  /** ClickUp's kind of status: custom (being worked on), unstarted, open, done, closed. */
  type: string;
  /** The status's place in its list — further along is higher. */
  orderindex: number;
  list: string | null;
  assignee_ids: string[];
  assignee_names: string[];
  created_at: string | null;
  updated_at: string | null;
  /** When it was finished; null while it is not. */
  done_at: string | null;
  due_at: string | null;
  synced_at: string;
};

/** One task open on a developer in ClickUp, as the Developers list kept it before `20261012_03` (unused since). */
export type ClickUpTaskSummary = {
  id: string;
  name: string;
  url: string;
  /** ClickUp's own status name and colour, as the team set them. */
  status: string;
  color: string | null;
  /** ClickUp's kind of status: "custom" is being worked on, "unstarted" / "open" not yet. */
  type: string;
  list: string | null;
  updated_at: string | null;
  due_at: string | null;
};

/** Someone in the ClickUp workspace — names only, for picking who a developer is. */
export type ClickUpMember = { id: string; name: string; initials: string | null; color: string | null };

/** The ClickUp workspace feeding one owner's Developers list (`tt_clickup_state`). */
export type ClickUpState = {
  owner_id: string;
  workspace_id: string;
  workspace_name: string | null;
  members: ClickUpMember[];
  members_at: string | null;
  synced_at: string | null;
  error: string | null;
  error_at: string | null;
  /** The last full read of every task, and the last read at all (`20261012_03`). */
  tasks_full_at?: string | null;
  tasks_synced_at?: string | null;
};

/** Someone an owner lets keep their Developers list, by Discord id. */
export type DevEditor = {
  id: string;
  owner_id: string;
  discord_user_id: string;
  name: string | null;
  /** Whose list it is, from the owner's Discord identity — written by the database. */
  owner_name: string | null;
  created_at: string;
};

export type Alert = {
  id: string;
  user_id: string;
  task_id: string | null;
  kind: string;
  target: string | null;
  ok: boolean;
  error: string | null;
  sent_at: string;
};

/** What `app/page.tsx` hands the client component. */
export type TrackerData = {
  profile: Profile;
  connections: ConnectionStatus | null;
  /**
   * Every OPEN task this user owns, plus every open task other people gave
   * them — all of them, paged past PostgREST's row cap — and the most recent
   * closed ones (`closedShown`).
   */
  tasks: Task[];
  /** How many closed tasks `tasks` carries; the board says when older ones are not loaded. */
  closedShown: number;
  /** When the server rendered the page. The board's clock starts here, so the server and the browser render the same text. */
  renderedAt: string;
  /** Every `tt_people` row this user owns. Empty until they write their first note or grade. */
  people: Person[];
  /**
   * Every review verdict this user can read (their board's, and about them or
   * by them elsewhere), however long ago — the task activity and Undo. Not the
   * score: that is `scoreEntries`.
   */
  reviews: TaskReview[];
  /**
   * Every score entry this user may read (`20261009_01`): their own — and,
   * for Lucky35, everyone's. The scores on Team, a person and Monthly are
   * sums of these.
   */
  scoreEntries: ScoreEntry[];
  /** This user is Lucky35 (`tt_is_score_admin()`): reads everyone's history, exports it. */
  scoreAdmin: boolean;
  /** How many other people's Developers lists this user was named to keep — the header's way there. */
  devListsKept: number;
  /** How many ClickUp tasks this user may read (`20261012_03`) — a developer's own are a way there too. */
  clickupTasks?: number;
  /** Tasks recently taken off this user (or moved on their board): My tasks' "Moved off you". */
  handoffs: TaskHandoff[];
  /** Tagged messages read and not filed that nobody has reviewed yet, newest first. Never ages out. */
  skipped: SkippedMessage[];
  /** How many there are in all — `skipped` holds at most the newest hundred. */
  skippedTotal: number;
  /** Watched channels where the bot is not allowed to react. */
  reactionBlocked: BlockedChannel[];
  watchedChannels: number;
  messagesTracked: number;
  lastMessageAt: string | null;
};
