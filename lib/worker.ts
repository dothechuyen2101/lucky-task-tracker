import type { SupabaseClient } from "@supabase/supabase-js";

import { BATCH_SIZE, type Command, type Verdict, classifyBatch, parseCommand, readDirectMessage } from "@/lib/claude";
import { applyAssigneeAnswer, settleToggleNotice } from "@/lib/assignee-server";
import { handoffDecision, handoffNotice } from "@/lib/handoffs";
import {
  awaitsReview,
  cleanNote,
  durationText,
  nextReviewNudge,
  restoredDeadline,
  reviewNudgeText,
  reviewedWork,
  suggestedApproval,
  verdictReply,
} from "@/lib/review";
import { decide } from "@/lib/review-server";
import { pickListText, pickNumber, proofFromDiscord, proofRequestText, proofTakenReply, proofWords } from "@/lib/proof";
import type { ReviewDecision } from "@/lib/types/database";
import { TOGGLE_QUIET_MS } from "@/lib/assignee";
import { colorForKey } from "@/lib/colors";
import { tryOpen } from "@/lib/crypto";
import { decideAutoDeadline, extendDeadline, pickDeadlinePhrase, resolveSuggestedDeadline } from "@/lib/deadlines";
import { ensureBotRole } from "@/lib/bot-roles";
import { syncDue } from "@/lib/channel-sync";
import { syncChannels } from "@/lib/channel-sync-server";
import {
  DiscordError,
  type DiscordMessage,
  dateToSnowflake,
  getMessagesAfter,
  getNewestMessages,
  jumpUrl,
  openDmChannel,
  replyTo,
  searchGuildMembers,
  sendDm,
  sendReminderMessage,
} from "@/lib/discord";
import {
  type DmAction,
  DM_FIRST_READ_MS,
  DM_PEOPLE_WINDOW_DAYS,
  alreadyFiledReply,
  assignedNotice,
  type PersonOption,
  assigneeAnswerReply,
  byUrgency,
  candidatesFor,
  exactKnown,
  filedReply,
  givenToReply,
  guestDmHelp,
  isNo,
  isYes,
  knownOptions,
  memberOptions,
  ownerDmHelp,
  passedOnReply,
  pickCandidate,
  pickNumbered,
  plainHandles,
  requestConfirmQuestion,
  taskListText,
} from "@/lib/dm";
import {
  FRESH_ASSIGNEE_STREAM,
  assigneeStatusLine,
  isLastAssigneeReminder,
  isOverdue,
  nextAlertFor,
  reminderText,
  remindsGiver,
  shouldRemindAssignee,
} from "@/lib/reminders";
import {
  type Mentioned,
  assigneesOf,
  authorName,
  isApp,
  markRuns,
  readableMessage,
  fallbackDirection,
  relevanceOf,
  type Reporting,
  requesterOf,
  repliesTo,
  roleIdsFromContent,
  stripMentions,
  tagsBot,
} from "@/lib/relevance";
import { mineUrl, siteUrl, taskUrl } from "@/lib/site";
import { type CcPerson, type TaggedPerson, cardFields, ccMentions, namesText, peopleOnCards, splitCc, withoutCc } from "@/lib/tagged";
import { isDmLink } from "@/lib/discord-links";
import { acknowledge, answerForeignTags, noteReaction, sendOwedAnswers } from "@/lib/tag-answers";
import {
  DUPLICATE_WINDOW_DAYS,
  FILED_REACTION,
  MAX_CLASSIFY_ATTEMPTS,
  SKIPPED_REACTION,
  UNREAD_FILED_NOTE,
  duplicateReason,
  foreignTagReply,
  isSkip,
  lateAnswer,
  requestKey,
  skipReply,
  taskFromMessage,
} from "@/lib/triage";
import { DONE_FROM_STAGE, stampStages } from "@/lib/stages";
import type { AssigneeCandidate, Channel, DiscordAttachment, SkippedMessage, Task, TaskHandoff } from "@/lib/types/database";

/**
 * One tick: poll, classify, remind. Called once a minute by Vercel Cron, and by
 * `pnpm tick` for a manual run.
 *
 * It has a wall clock and it respects it. A serverless function that overruns
 * is killed mid-write, so every stage checks the deadline before starting more
 * work and simply leaves the rest for the next minute — the cursors and the
 * `classified_at is null` predicate mean nothing is lost by stopping early.
 *
 * Ordering matters. Reminders go FIRST, for every account, before anything is
 * read: they are the one stage with a clock on it, and a backlog of history to
 * classify for one account must never make another account's "due in an hour"
 * arrive late (2026-09-30 audit). A task filed this minute loses nothing by
 * it — its first reminder is always strictly in the future. Then, per account,
 * poll before classify, so a message caught this minute becomes a task this
 * minute; and the account that goes first rotates every minute, so none is
 * always last in line for the budget.
 *
 * Per account: poll the watched channels, then the bot's DMs (`pollDms`), then
 * answer DMs from people other than the owner (`runDirectMessages`), apply
 * commands, classify, tell new assignees about their work (`tellAssignees`),
 * and DM whatever answers are owed.
 */

export type TickLimits = {
  /** Hard wall clock. The tick returns whatever it finished by then. */
  budgetMs: number;
  /** Channels polled per user per tick, least-recently-polled first. */
  channelsPerUser: number;
  /** Of that budget, how many slots go to channels that last errored. */
  channelsRetryingErrors: number;
  /** Channels fetched from Discord at once. Discord's global cap is ~50/s. */
  concurrency: number;
  /** Pages of 100 messages pulled from one channel in one tick. */
  pagesPerChannel: number;
  /** Messages graded per user per tick. */
  classifyPerUser: number;
  /** Reminders sent per user per tick. */
  alertsPerUser: number;
};

export const DEFAULT_LIMITS: TickLimits = {
  budgetMs: 50_000,
  // Sized against a real account: one user watching 854 channels. At 25 per
  // tick that is a 34-minute lap, which makes "appears within a minute" a lie.
  // 250 with 10 in flight laps the same account in about four minutes and stays
  // well inside Discord's ~50 requests/second per token.
  channelsPerUser: 250,
  channelsRetryingErrors: 15,
  concurrency: 10,
  pagesPerChannel: 5,
  classifyPerUser: BATCH_SIZE * 3,
  alertsPerUser: 25,
};

export type TickSummary = {
  run_id: string | null;
  users_seen: number;
  channels_polled: number;
  messages_ingested: number;
  messages_classified: number;
  tasks_created: number;
  alerts_sent: number;
  /** Missed deadlines recorded by this tick's sweep (`tt_record_missed_deadlines`). */
  deadlines_missed: number;
  /** Score entries the history's sweep had to write (`tt_settle_scores`) — 0 when every verdict already wrote its own. */
  scores_settled: number;
  /** Channels found by `discoverChannels` this tick, and now watched. */
  channels_found: number;
  errors: string[];
  duration_ms: number;
  truncated: boolean;
};

type ConnectionRow = {
  user_id: string;
  discord_bot_token_cipher: string | null;
  discord_bot_user_id: string | null;
  /** The bot's own role in each server it is in, learned as tags arrive (`BotRoles`). */
  discord_bot_role_ids: string[] | null;
  /** When its servers and channels were last listed in full (`discoverChannels`). */
  channels_synced_at: string | null;
  anthropic_key_cipher: string | null;
  anthropic_model: string;
};

type ProfileRow = {
  id: string;
  discord_user_id: string | null;
  /** Named — never mentioned — in the reply to a stranger's tag (`foreignTagReply`). */
  discord_username: string | null;
  reminder_channel_id: string | null;
  /**
   * The user's own IANA zone, `not null default 'UTC'` on `tt_profiles`. It
   * rides into the classifier so "Tuesday" and "tonight" resolve where the
   * person is sitting rather than where Vercel is. Widening this type without
   * widening the `.select(...)` below would leave it `undefined` at runtime
   * while typechecking perfectly, so the two always change together.
   */
  timezone: string;
};

export async function runTick(
  db: SupabaseClient,
  limits: TickLimits = DEFAULT_LIMITS,
): Promise<TickSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + limits.budgetMs;
  const outOfTime = () => Date.now() > deadline;

  const summary: TickSummary = {
    run_id: null,
    users_seen: 0,
    channels_polled: 0,
    messages_ingested: 0,
    messages_classified: 0,
    tasks_created: 0,
    alerts_sent: 0,
    deadlines_missed: 0,
    scores_settled: 0,
    channels_found: 0,
    errors: [],
    duration_ms: 0,
    truncated: false,
  };

  const { data: run } = await db.from("tt_runs").insert({}).select("id").single();
  summary.run_id = run?.id ?? null;

  // Fail closed on a database behind the code. Migrations are applied by hand
  // (CLAUDE.md), and a worker running ahead of them does not fail loudly: a
  // write the old schema rejects leaves a tagged message unclassified, so it is
  // re-read — and re-sent to Claude — every minute. One cheap read of the
  // newest columns stops the whole tick instead, with the reason in the log.
  const probes = await Promise.all([
    db.from("tt_channels").select("react_error, rescan_reason").limit(1),
    db
      .from("tt_messages")
      .select("backfilled, skip_reviewed_at, classify_attempts, answer_owed, answered_at, answered_to, from_app, via_dm")
      .limit(1),
    db.from("tt_alerts").select("message_id").limit(1),
    db.from("tt_tasks").select("assignee_told_at, assignee_candidates, assignee_mute_told, assignee_mute_notice_due").limit(1),
    db.from("tt_messages").select("confirm_message_id, confirmed_at").limit(1),
    db.from("tt_dm_channels").select("id").limit(1),
    db.from("tt_tasks").select("review_state, reviewed_at, review_note, review_rejections").limit(1),
    db.from("tt_deadline_misses").select("id").limit(1),
    // `20261007_02`: the activity trigger's actor columns, verdict snapshots.
    db.from("tt_tasks").select("last_actor_discord_id, last_actor_name, last_actor_at").limit(1),
    db.from("tt_task_reviews").select("before, after").limit(1),
    db.from("tt_task_events").select("id").limit(1),
    db.from("tt_tasks").select("review_nudge_at, review_nudges").limit(1),
    db.from("tt_task_handoffs").select("id, told_at").limit(1),
    db.from("tt_connections").select("channels_synced_at").limit(1),
    db.from("tt_tasks").select("requested_by_discord_id, requested_by_name").limit(1),
    db.from("tt_tasks").select("source_message_id, message_part, source_mentions, split_pending").limit(1),
    // Review with proof, and priority (`20261007_01`).
    db.from("tt_tasks").select("priority").limit(1),
    db.from("tt_task_reviews").select("id").limit(1),
    db.from("tt_task_proofs").select("id").limit(1),
    db.from("tt_messages").select("attachments, proof_pick_message_id, proof_task_ids").limit(1),
    // The permanent score history (`20261009_01`): verdicts are given through
    // `tt_give_verdict`, which a database without it does not have.
    db.from("tt_score_entries").select("id, root_id, corrects").limit(1),
    // Copied in, not given the work; and a card closed as "only cc'd" (`20261020_01`).
    db.from("tt_tasks").select("cc, dismiss_reason").limit(1),
  ]);
  const schemaError = probes.find((probe) => probe.error)?.error ?? null;
  if (schemaError) {
    summary.errors.push(`database is behind the code — apply supabase/migrations/ (${schemaError.message})`);
    return finish(db, summary, startedAt);
  }

  // Everyone who has connected a bot. A user with no Discord token has nothing
  // to poll and nothing to remind through, so they are simply not in this list.
  const { data: connections, error: connectionsError } = await db
    .from("tt_connections")
    .select(
      "user_id, discord_bot_token_cipher, discord_bot_user_id, discord_bot_role_ids, channels_synced_at, anthropic_key_cipher, anthropic_model",
    )
    .not("discord_bot_token_cipher", "is", null)
    .order("user_id", { ascending: true });

  if (connectionsError) {
    summary.errors.push(`connections: ${connectionsError.message}`);
    return finish(db, summary, startedAt);
  }

  // 0. Missed deadlines, for every account at once — one statement in the
  // database, which holds the rule. Since `20261007_01` it records nothing
  // (the score is the review's) and returns 0; it stays so a database still
  // behind that migration keeps its old rule. A failure costs nothing.
  const { data: missed, error: missError } = await db.rpc("tt_record_missed_deadlines");
  if (missError) summary.errors.push(`missed deadlines: ${missError.message}`);
  else summary.deadlines_missed = typeof missed === "number" ? missed : 0;

  // 0a. The score history in line with the verdicts, for everyone. Every
  // verdict already writes its points in the same transaction (`decide`), and
  // a dismissal in its trigger; this is the net under them — it writes only
  // what is missing, and corrects rather than edits (`20261009_01`).
  const { data: settled, error: settleError } = await db.rpc("tt_settle_scores", {});
  if (settleError) summary.errors.push(`score history: ${settleError.message}`);
  else summary.scores_settled = typeof settled === "number" ? settled : 0;

  const accounts = await openAccounts(db, summary, (connections ?? []) as ConnectionRow[]);

  // 0b. Cards filed with nobody on them although their message tagged people
  // (`20261005_01`): each person tagged gets theirs, before reminders go out.
  await giveToEveryoneTagged(db, summary, accounts);

  // 1. Reminders, for everyone, before anything is read (see the header).
  for (const account of accounts) {
    if (outOfTime()) {
      summary.truncated = true;
      break;
    }
    try {
      await remindUser(db, summary, limits, deadline, account.connection, account.profile, account.botToken);
      await nudgeReviews(db, summary, deadline, account.connection, account.profile, account.botToken);
    } catch (error) {
      summary.errors.push(`${account.connection.user_id}: ${message(error)}`);
    }
  }

  // Who may hand out work through someone else's bot: everyone signed in to
  // the tracker (Lucky35, 2026-10-06). Read once a tick. If it cannot be
  // read, nobody is a teammate this tick — their tags are answered as a
  // stranger's would be, never filed under the wrong rule.
  const { data: teamIds, error: teamError } = await db.rpc("tt_tracker_discord_ids");
  if (teamError) summary.errors.push(`teammates: ${teamError.message}`);
  const team: ReadonlySet<string> = new Set(((teamIds ?? []) as string[]).filter(Boolean));

  // 2. Reading and filing, starting from a different account each minute.
  const first = accounts.length > 0 ? Math.floor(startedAt / 60_000) % accounts.length : 0;
  for (const { connection, profile, botToken } of [...accounts.slice(first), ...accounts.slice(0, first)]) {
    if (outOfTime()) {
      summary.truncated = true;
      break;
    }

    try {
      // A server or channel the bot joined since the last look is listed —
      // and watched — before anything is read (2026-10-06).
      await discoverChannels(db, summary, connection, botToken);
      const roles = botRolesFor(db, connection, botToken);
      await pollUser(db, summary, limits, deadline, connection, profile, botToken, roles, team);
      await pollDms(db, summary, deadline, connection, profile, botToken);
      try {
        await runDirectMessages(db, summary, deadline, connection, profile, botToken);
        await runReports(db, summary, deadline, connection, profile, botToken, team);
        await runCommands(db, summary, deadline, connection, profile, botToken);
        await classifyUser(db, summary, limits, deadline, connection, profile, botToken, roles);
        await tellAssignees(db, summary, deadline, connection, profile, botToken);
        await tellHandoffs(db, summary, deadline, connection, profile, botToken);
        await tellOwedToggles(db, summary, deadline, connection);
      } finally {
        // Every tag answered where its tagger may not have seen it — read
        // late, or left without a reaction — is told by DM now. The debt is
        // in the database, so a step that failed above loses none of it.
        await sendOwedAnswers(db, summary.errors, {
          userId: connection.user_id,
          botToken,
          ownerId: profile.discord_user_id,
          reminderChannelId: profile.reminder_channel_id,
        });
      }
    } catch (error) {
      summary.errors.push(`${connection.user_id}: ${message(error)}`);
    }
  }

  return finish(db, summary, startedAt);
}

/**
 * Keep this account's channel list in step with what its bot can see — every
 * `CHANNEL_SYNC_EVERY_MS`, not only when the owner presses Refresh. 2026-10-06:
 * a server the bot joined after the last Refresh was never read, and eight
 * tags there went unanswered with nothing anywhere saying so. A new channel
 * is watched from when it could first have been missed (`seedCursor`), so the
 * tags made before it was found are read now — late, and answered by DM.
 * A failure is logged and costs nothing but time: the next tick tries again.
 */
async function discoverChannels(db: SupabaseClient, summary: TickSummary, connection: ConnectionRow, botToken: string) {
  if (!syncDue(connection.channels_synced_at, new Date())) return;
  try {
    const result = await syncChannels(db, {
      userId: connection.user_id,
      botToken,
      botUserId: connection.discord_bot_user_id,
    });
    summary.channels_found += result.added.length;
    for (const problem of result.problems) summary.errors.push(`channel list: ${problem}`);
  } catch (error) {
    summary.errors.push(`channel list: ${message(error)}`);
  }
}

type Account = { connection: ConnectionRow; profile: ProfileRow; botToken: string };

/**
 * Every connected account this tick can act for: its bot token opened and its
 * profile read (one query for all of them). One that cannot be is said so on
 * its connection or in the run log, and left out.
 */
async function openAccounts(db: SupabaseClient, summary: TickSummary, connections: ConnectionRow[]): Promise<Account[]> {
  summary.users_seen += connections.length;
  if (connections.length === 0) return [];

  const { data: profiles, error } = await db
    .from("tt_profiles")
    .select("id, discord_user_id, discord_username, reminder_channel_id, timezone")
    .in(
      "id",
      connections.map((c) => c.user_id),
    );
  if (error) {
    summary.errors.push(`profiles: ${error.message}`);
    return [];
  }
  const byId = new Map(((profiles ?? []) as ProfileRow[]).map((p) => [p.id, p]));

  const accounts: Account[] = [];
  for (const connection of connections) {
    const botToken = tryOpen(connection.discord_bot_token_cipher);
    if (!botToken) {
      // The stored token cannot be opened with the current APP_ENCRYPTION_KEY.
      // Say so on the connection rather than failing silently every minute.
      summary.errors.push(`${connection.user_id}: stored Discord token is unreadable`);
      await db
        .from("tt_connections")
        .update({
          discord_last_error: "Stored token could not be decrypted. Paste it again in Settings.",
        })
        .eq("user_id", connection.user_id);
      continue;
    }

    const profile = byId.get(connection.user_id);
    if (!profile?.discord_user_id) {
      summary.errors.push(`${connection.user_id}: no Discord identity on profile`);
      continue;
    }
    accounts.push({ connection, profile, botToken });
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// 1. Poll — pull new messages from every watched channel
// ---------------------------------------------------------------------------

/**
 * The roles Discord created for this user's bot — one per server — which count
 * as tagging it (`tagsBot`). Known ones live on `tt_connections`; an unknown
 * role mention in a server not yet checked this tick costs one role listing,
 * shared by every channel polled concurrently in that server.
 *
 * `learn` answers false when Discord would not list the roles. The caller must
 * then NOT move past those messages: a tag of the bot's role among them would
 * otherwise be passed over for good (Lucky35, 2026-09-29).
 */
type BotRoles = {
  known: () => string[];
  learn: (guildId: string, contents: string[]) => Promise<boolean>;
};

function botRolesFor(db: SupabaseClient, connection: ConnectionRow, botToken: string): BotRoles {
  const known = new Set(connection.discord_bot_role_ids ?? []);
  const checked = new Map<string, Promise<boolean>>();
  const botId = connection.discord_bot_user_id;
  // One lookup at a time: the known list is written whole, so two servers
  // learned concurrently must not overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    known: () => [...known],
    async learn(guildId, contents) {
      if (!botId) return true;
      const unknown = contents.some((content) => roleIdsFromContent(content).some((id) => !known.has(id)));
      if (!unknown) return true;

      if (!checked.has(guildId)) {
        const lookup = queue.then(async () => {
          const result = await ensureBotRole(db, {
            userId: connection.user_id,
            botToken,
            botUserId: botId,
            guildId,
          });
          if (!result) return false;
          for (const id of result.known) known.add(id);
          return true;
        });
        queue = lookup.catch(() => undefined);
        checked.set(guildId, lookup);
      }
      return checked.get(guildId)!;
    },
  };
}

async function pollUser(
  db: SupabaseClient,
  summary: TickSummary,
  limits: TickLimits,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
  roles: BotRoles,
  team: ReadonlySet<string>,
) {
  // Two queues, because a channel the bot cannot read must not hold a slot it
  // will never use. 295 of one account's 854 watched channels are private to
  // the bot; left in the main rotation they consumed a third of every tick
  // forever. They get a small retry quota instead, so a permission fix is still
  // noticed within the hour without starving the channels that work.
  const [healthy, retrying] = await Promise.all([
    db
      .from("tt_channels")
      .select("*")
      .eq("user_id", connection.user_id)
      .eq("watching", true)
      .is("last_error", null)
      // nullsFirst: a channel just switched on jumps the queue, so the user sees
      // it start working instead of waiting behind hundreds of older channels.
      .order("last_polled_at", { ascending: true, nullsFirst: true })
      .limit(limits.channelsPerUser),
    db
      .from("tt_channels")
      .select("*")
      .eq("user_id", connection.user_id)
      .eq("watching", true)
      .not("last_error", "is", null)
      .order("last_polled_at", { ascending: true, nullsFirst: true })
      .limit(limits.channelsRetryingErrors),
  ]);

  const queue = [...((healthy.data ?? []) as Channel[]), ...((retrying.data ?? []) as Channel[])];

  // Who reports on work from this owner: the people with an open task on the
  // board, and the bot's "which task?" lists still waiting for their number
  // (Lucky35's PO, 2026-10-07). A tag from them is read as a report first.
  const reporting = await reportingFor(db, connection.user_id, profile.discord_user_id);

  // One shared cursor over the queue, drained by `concurrency` workers. Serial
  // fetching is what made a large account slow; the work is almost entirely
  // waiting on Discord.
  let next = 0;
  let rateLimited = false;

  const takeOne = async (): Promise<Channel | null> => {
    if (rateLimited || Date.now() > deadline) return null;
    const index = next++;
    return index < queue.length ? queue[index] : null;
  };

  await Promise.all(
    Array.from({ length: Math.min(limits.concurrency, queue.length) }, async () => {
      for (;;) {
        const channel = await takeOne();
        if (!channel) break;
        const stop = await pollChannel(db, summary, limits, deadline, connection, profile, botToken, roles, team, channel, reporting);
        // A 429 is per bot token, so one channel hitting it means every other
        // channel for this user would too. Stop the whole fan-out.
        if (stop) {
          rateLimited = true;
          break;
        }
      }
    }),
  );

  if (next < queue.length) summary.truncated = true;
}

/** The people with open work on this board, and the pick lists awaiting an answer — `Reporting`. */
async function reportingFor(db: SupabaseClient, userId: string, ownerId: string | null): Promise<Reporting> {
  const [{ data: open }, { data: waiting }] = await Promise.all([
    db
      .from("tt_tasks")
      .select("assignee_discord_id")
      .eq("user_id", userId)
      .eq("direction", "given")
      .eq("status", "open")
      .not("assignee_discord_id", "is", null)
      .limit(1000),
    db
      .from("tt_messages")
      .select("proof_pick_message_id")
      .eq("user_id", userId)
      .not("proof_pick_message_id", "is", null)
      .limit(500),
  ]);
  const reporters = new Set<string>();
  for (const row of (open ?? []) as Array<{ assignee_discord_id: string }>) {
    if (row.assignee_discord_id && row.assignee_discord_id !== ownerId) reporters.add(row.assignee_discord_id);
  }
  const picks = new Set(((waiting ?? []) as Array<{ proof_pick_message_id: string }>).map((row) => row.proof_pick_message_id));
  return { reporters, picks };
}

/** The files on a Discord message, as `tt_messages.attachments` keeps them. */
function attachmentsOf(message: DiscordMessage): DiscordAttachment[] {
  return (message.attachments ?? []).slice(0, 10).map((file) => ({
    id: file.id,
    filename: file.filename,
    url: file.url,
    content_type: file.content_type ?? null,
    size: typeof file.size === "number" ? file.size : null,
  }));
}

/**
 * How far before the last read an edit still counts as new — the clocks of
 * Discord and of this server are not the same clock.
 */
const EDIT_MARGIN_MS = 60_000;

const ROLES_UNKNOWN =
  "Discord would not list this server's roles, so a tag of the bot's role could not be recognised. The newest messages are read again every minute until it does; none are skipped.";

/**
 * Read a channel (or a DM) past `progress.cursor`, handing each batch to
 * `take`, which stores it and says whether the cursor may move past it.
 *
 * The newest page first. When it reaches back to the cursor — fewer than a
 * page of new messages, the usual case — it holds every new message AND the
 * recent ones edited since the last read, which is the only way a tag ADDED
 * to a message afterwards is ever seen (Lucky35, 2026-09-30: "tags added
 * late" were skipped silently). Still one request. Only when more than a page
 * arrived does it walk forward from the cursor a page at a time
 * (`getMessagesAfter`). The cursor moves over everything seen, not just what
 * was kept — other people's messages must not be re-fetched forever.
 */
async function walkChannel(
  botToken: string,
  channelId: string,
  progress: { cursor: string },
  lastPolledAt: string | null,
  pages: number,
  take: (messages: DiscordMessage[]) => Promise<boolean>,
) {
  const newest = await getNewestMessages(botToken, channelId);
  const from = BigInt(progress.cursor);
  const reachesCursor = newest.length < 100 || BigInt(newest[0].id) <= from;

  if (reachesCursor) {
    const since = lastPolledAt ? Date.parse(lastPolledAt) - EDIT_MARGIN_MS : null;
    const fresh = newest.filter(
      (m) =>
        BigInt(m.id) > from ||
        (since !== null && Boolean(m.edited_timestamp) && Date.parse(m.edited_timestamp!) > since),
    );
    const top = newest[newest.length - 1]?.id;
    if ((await take(fresh)) && top && BigInt(top) > from) progress.cursor = top;
    return;
  }

  for (let page = 0; page < pages; page += 1) {
    const batch = await getMessagesAfter(botToken, channelId, progress.cursor);
    if (batch.length === 0) break;
    if (!(await take(batch))) break;
    progress.cursor = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
}

/** Poll one channel. Returns true when the caller should stop entirely. */
async function pollChannel(
  db: SupabaseClient,
  summary: TickSummary,
  limits: TickLimits,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
  roles: BotRoles,
  team: ReadonlySet<string>,
  channel: Channel,
  reporting: Reporting = {},
): Promise<boolean> {
  {

    // No cursor means the channel was switched on outside the normal path.
    // Start from now rather than back-filling the channel's whole history.
    if (!channel.last_message_id) {
      await db
        .from("tt_channels")
        .update({ last_message_id: dateToSnowflake(new Date()), last_polled_at: new Date().toISOString() })
        .eq("id", channel.id);
      return false;
    }

    let cursor = channel.last_message_id;
    let ingested = 0;
    // Tags of this bot by someone else, about work for someone else. Answered
    // only after the cursor has been written past them, so a run that dies in
    // between never answers the same tag twice.
    const foreign: DiscordMessage[] = [];
    // Discord would not list this server's roles: the cursor stops before the
    // page it could not place, and the channel says why (Settings shows it).
    let rolesUnknown = false;

    // Store the tagged messages of one page. False when the page could not be
    // placed — a role mention Discord would not identify — in which case the
    // caller must not move the cursor past it.
    const takePage = async (messages: DiscordMessage[]): Promise<boolean> => {
      if (messages.length === 0) return true;

      // A mention of a role we have not placed may be the bot's own role in
      // this server — the tag the @ picker offers right beside the bot. If
      // Discord will not say, stop HERE, before the cursor moves: this page is
      // read again next tick instead of being passed over.
      const placed = await roles.learn(
        channel.guild_id,
        messages.map((m) => readableMessage(m).content),
      );
      if (!placed) {
        summary.errors.push(`#${channel.channel_name ?? channel.channel_id}: could not list the server's roles; retrying next tick`);
        rolesUnknown = true;
        return false;
      }

      // Both halves: what this user wrote, and what was asked of them.
      const botRoleIds = roles.known();
      const relevant = messages.flatMap((m) => {
        const verdict = relevanceOf(m, profile.discord_user_id!, connection.discord_bot_user_id, botRoleIds, team, reporting);
        if (!verdict.keep && verdict.foreign) foreign.push(m);
        return verdict.keep ? [{ message: m, direction: verdict.direction }] : [];
      });
      if (relevant.length === 0) return true;

      const { error } = await db.from("tt_messages").upsert(
        relevant.map(({ message: m, direction }) => {
          // A forward is stored as what it forwards — the words and the
          // people in it — so it is classified like the tag it carries.
          const read = readableMessage(m);
          return {
            user_id: connection.user_id,
            guild_id: channel.guild_id,
            channel_id: channel.channel_id,
            channel_name: channel.channel_name,
            message_id: m.id,
            content: read.content.slice(0, 4000),
            jump_url: jumpUrl(channel.guild_id, channel.channel_id, m.id),
            sent_at: m.timestamp,
            author_id: m.author.id,
            author_name: authorName(m),
            direction,
            // Who the message @-mentioned, minus this user and the bot. The
            // ids are what an assignee is, so they are kept at ingest rather
            // than re-derived from markup later.
            //
            // ignoreDuplicates: true below means an existing row is SKIPPED,
            // not merged, so a re-poll never fills this column in on a message
            // already stored. Only messages ingested after this shipped carry
            // mentions; older rows are repaired from their stored content
            // instead. Do not "fix" that by flipping ignoreDuplicates to false
            // — a re-poll would then overwrite the classification columns on
            // rows the worker has already processed. The backfill route upsert
            // has the same shape for the same reason.
            mentions: assigneesOf(read, profile.discord_user_id!, connection.discord_bot_user_id),
            reply_to_message_id: repliesTo(m),
            from_app: isApp(m),
            // The proof a report of done carries (`20261007_01`).
            attachments: attachmentsOf(m),
          };
        }),
        { onConflict: "user_id,message_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
      ingested += relevant.length;
      return true;
    };

    // How far the read has got — kept on the channel even if a later page fails.
    const progress = { cursor };
    try {
      await walkChannel(botToken, channel.channel_id, progress, channel.last_polled_at, limits.pagesPerChannel, takePage);
      cursor = progress.cursor;

      await db
        .from("tt_channels")
        .update({
          last_message_id: cursor,
          last_polled_at: new Date().toISOString(),
          last_error: rolesUnknown ? ROLES_UNKNOWN : null,
        })
        .eq("id", channel.id);

      summary.channels_polled += 1;
      summary.messages_ingested += ingested;
      await answerForeignTags(db, summary.errors, {
        userId: connection.user_id,
        botToken,
        channel,
        tags: foreign,
        ownerName: profile.discord_username,
        publicReply: true,
      });
      return false;
    } catch (error) {
      const note =
        error instanceof DiscordError && error.isAccess
          ? "The bot cannot read this channel. Check View Channel and Read Message History."
          : message(error);

      // Keep the cursor we reached: a channel that errors on page four should
      // not re-read pages one to three next minute.
      await db
        .from("tt_channels")
        .update({ last_message_id: progress.cursor, last_polled_at: new Date().toISOString(), last_error: note })
        .eq("id", channel.id);

      // One line per unreadable channel would drown the run log — 295 of one
      // account's channels are private to its bot. They are recorded on the
      // channel row itself, which is where the UI reads them.
      if (!(error instanceof DiscordError && error.isAccess)) {
        summary.errors.push(`#${channel.channel_name ?? channel.channel_id}: ${note}`);
      }

      // The cursor kept above has moved past these; answer them now or never.
      await answerForeignTags(db, summary.errors, {
        userId: connection.user_id,
        botToken,
        channel,
        tags: foreign,
        ownerName: profile.discord_username,
        publicReply: true,
      });

      // A rate limit applies to the whole token, so every other channel for
      // this user would hit it too. Tell the caller to stop the fan-out.
      return error instanceof DiscordError && error.status === 429;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Classify — the user's own Claude sorts every message that tagged the bot:
//    work becomes a card (✅), anything else is answered and kept on the
//    board's "Not filed" list (👀). Nothing tagged goes unanswered.
// ---------------------------------------------------------------------------

/** Why an untagged row is closed off without a task. Rows ingested before capture moved to @bot-only. */
const NOT_TAGGED_REASON = "Did not tag the tracker bot, so it is not a task.";

/** A stored tagged message, as classification reads it. */
type PendingRow = {
  id: string;
  content: string;
  sent_at: string;
  guild_id: string | null;
  channel_id: string;
  channel_name: string | null;
  message_id: string;
  jump_url: string | null;
  direction: "sent" | "received";
  author_id: string | null;
  author_name: string | null;
  mentions: Array<{ id: string; name: string }> | null;
  backfilled: boolean;
  /** Posted by a bot or a webhook: never replied to in public — an echo bot would answer the answer. */
  from_app: boolean;
  /** Written to the bot in a DM: a tag by definition, answered in the DM itself. */
  via_dm: boolean;
  /** A DM request its sender confirmed: filed even if it reads as small talk. */
  confirmed_at: string | null;
  classify_attempts: number;
};

async function classifyUser(
  db: SupabaseClient,
  summary: TickSummary,
  limits: TickLimits,
  deadline: number,
  connection: ConnectionRow,
  // The person's time zone — what lets "Tuesday" resolve against their evening
  // rather than the server's — and their Discord id, who is answered for
  // history.
  profile: ProfileRow,
  // To answer the message on Discord itself — ✅ or 👀 — so the sender knows.
  botToken: string,
  // The bot's roles, as `pollUser` left them — and able to learn one more: a
  // role-tagged row must never be closed off as untagged.
  roles: BotRoles,
) {
  const apiKey = tryOpen(connection.anthropic_key_cipher);
  if (!apiKey) return; // No key, no classification. Messages wait, they are not lost.

  // Without the bot's id nothing can be told apart as tagged. Wait rather than
  // close every pending message off as "not tagged".
  const botId = connection.discord_bot_user_id;
  if (!botId) return;

  // Live tags before history. A Backfill can queue thousands of old messages at
  // once; a tag written a minute ago must not wait behind all of them for its
  // ✅, or its sender reads the silence as "missed" and tags again (2026-09-30).
  const { data } = await db
    .from("tt_messages")
    .select(
      "id, content, sent_at, guild_id, channel_id, channel_name, message_id, jump_url, direction, author_id, author_name, mentions, backfilled, from_app, via_dm, confirmed_at, classify_attempts",
    )
    .eq("user_id", connection.user_id)
    .is("classified_at", null)
    // Commands are `runCommands`'; an unread DM from someone else is
    // `runDirectMessages'` until it turns out to be a request for the owner.
    .in("direction", ["sent", "received"])
    .order("backfilled", { ascending: true })
    .order("sent_at", { ascending: true })
    .limit(limits.classifyPerUser);
  const pending = (data ?? []) as PendingRow[];

  // A role this tick has not placed may be the bot's own, learned a moment ago
  // by a Backfill running beside this tick — whose rows are exactly the ones
  // tagged with it. Ask before closing anything off; where Discord will not
  // say, leave those rows for the next tick rather than guess "not tagged".
  const unplaced = new Set<string>();
  const byGuild = new Map<string, PendingRow[]>();
  for (const row of pending) {
    if (row.via_dm || !row.guild_id) continue;
    if (tagsBot(row.content, botId, roles.known()) || roleIdsFromContent(row.content).length === 0) continue;
    byGuild.set(row.guild_id, [...(byGuild.get(row.guild_id) ?? []), row]);
  }
  for (const [guildId, rows] of byGuild) {
    const placed = await roles.learn(
      guildId,
      rows.map((r) => r.content),
    );
    if (!placed) for (const row of rows) unplaced.add(row.id);
  }
  const botIds = [botId, ...roles.known()];

  // Only a message that tagged the bot is a task. Ingest already keeps nothing
  // else, but rows stored under the old read-everything rule are still queued
  // here, and they must be closed off without spending the user's Claude on
  // them — and without becoming tasks.
  // A DM to the bot is a tag by definition: there is nobody else to talk to.
  const untagged = pending.filter((m) => !m.via_dm && !unplaced.has(m.id) && !tagsBot(m.content, botId, roles.known()));
  if (untagged.length > 0) {
    const { error } = await db
      .from("tt_messages")
      .update({
        classified_at: new Date().toISOString(),
        is_task: false,
        classification_reason: NOT_TAGGED_REASON,
        classification_error: null,
      })
      .in(
        "id",
        untagged.map((m) => m.id),
      );
    if (error) summary.errors.push(`close untagged: ${error.message}`);
    else summary.messages_classified += untagged.length;
  }

  const rows = pending.filter((m) => m.via_dm || tagsBot(m.content, botId, roles.known()));
  if (rows.length === 0) return;

  const tag = tagContext(db, summary, botToken, connection, profile);
  const onBoard = await openRequestKeys(db, connection.user_id, botIds);
  const zone = profile.timezone || "UTC";

  // A task the owner DMs the bot names its person in words — Discord's @ list
  // offers nobody in a DM — so it is matched against the people the owner
  // works with, and then the members of the servers the bot is in.
  const namesInWords = (m: PendingRow) => m.via_dm && m.direction === "sent" && !(m.mentions ?? []).length;
  const people = rows.some(namesInWords) ? await knownPeopleOf(db, connection.user_id, profile.discord_user_id) : [];
  const naming: Naming = { known: knownOptions(people), findMembers: memberFinder(db, botToken, connection.user_id) };

  // Fresh rows go to Claude twenty at a time. A row whose batch came back
  // unusable goes alone, so one message Claude will not read cannot sink the
  // nineteen beside it again (`classify_attempts`).
  const fresh = rows.filter((r) => !r.classify_attempts);
  const batches: PendingRow[][] = [];
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) batches.push(fresh.slice(i, i + BATCH_SIZE));
  for (const row of rows) if (row.classify_attempts) batches.push([row]);

  for (const batch of batches) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }

    // markRuns tells the classifier which messages continue the one before, so
    // a request split across two tags is read as one thought.
    const result = await classifyBatch({
      apiKey,
      model: connection.anthropic_model,
      timezone: zone,
      messages: markRuns(
        batch.map((m) => ({
          id: m.id,
          content: m.content,
          sentAt: m.sent_at,
          channelName: m.channel_name,
          direction: (m.direction ?? "sent") as "sent" | "received",
          authorName: m.author_name ?? null,
          // Candidates only for messages the user wrote themselves. On a
          // received message the mentions mean something else entirely (who
          // else was looped in), so the line is withheld and the classifier
          // never sees an assignees: block it could misread.
          assignees: m.direction === "sent" ? (m.mentions ?? []) : undefined,
          viaDm: m.via_dm,
          people: namesInWords(m) ? people.slice(0, PEOPLE_IN_PROMPT) : undefined,
        })),
      ),
    });

    if (!result.ok) {
      summary.errors.push(`${connection.user_id}: ${result.error}`);

      // The key, the network or Anthropic: nothing about these messages. Leave
      // them, say so on the connection, and stop for this user until next tick.
      if (result.failure === "unavailable") {
        await db
          .from("tt_connections")
          .update({ anthropic_last_error: result.error })
          .eq("user_id", connection.user_id);
        return;
      }

      // Claude answered, unusably. Count it against every message in the batch
      // — which sends each of them alone next time — and file a message that
      // keeps failing alone from its own words: a card that reads rough beats a
      // tag nobody ever answers.
      for (const row of batch) {
        const attempts = row.classify_attempts + 1;
        if (batch.length === 1 && attempts >= MAX_CLASSIFY_ATTEMPTS) {
          await fileUnread(tag, row, zone, result.error);
          continue;
        }
        const { error } = await db
          .from("tt_messages")
          .update({ classify_attempts: attempts, classification_error: result.error.slice(0, 500) })
          .eq("id", row.id);
        if (error) summary.errors.push(`classify attempts: ${error.message}`);
      }
      continue;
    }

    await db.from("tt_connections").update({ anthropic_last_error: null }).eq("user_id", connection.user_id);

    for (const row of batch) {
      const verdict = result.verdicts.get(row.id);
      if (!verdict) continue;
      await fileVerdict(tag, row, verdict, zone, onBoard, botId, botIds, naming);
    }
  }
}

/**
 * What one verdict does: 👀 and a "Not filed" row for anything but work, ✅
 * and no second card for a repeat, ✅ and a card for a task. The row is marked
 * classified only once its outcome has landed — a failed write leaves it for
 * the next tick rather than answering a tag with something that did not happen.
 */
async function fileVerdict(
  tag: TagContext,
  row: PendingRow,
  verdict: Verdict,
  zone: string,
  onBoard: Map<string, OpenRequest>,
  botId: string,
  botIds: string[],
  naming: Naming,
) {
  const { db, summary } = tag;
  const now = new Date().toISOString();
  // A DM is answered in the DM, so it is never owed a second answer later.
  const owed = row.via_dm ? null : lateAnswer(row.sent_at, new Date());

  // Read, and not work: thanks, chatter, a question to the bot, a command it
  // cannot apply. No card — Lucky35's board filled up with these — but never
  // silence either: the message gets 👀 (and, for a question or a command, a
  // fixed reply), and it stays on the board's "Not filed" list, one click from
  // becoming a task.
  // A request its sender confirmed ("yes") is work, whatever it reads like.
  if (isSkip(verdict.category) && !row.confirmed_at) {
    const { error } = await db
      .from("tt_messages")
      .update({
        classified_at: now,
        is_task: false,
        skip_category: verdict.category,
        classification_reason: verdict.reason.slice(0, 500),
        classification_error: null,
        answer_owed: owed,
      })
      .eq("id", row.id);
    if (error) {
      summary.errors.push(`not filed: ${error.message}`);
      return;
    }
    summary.messages_classified += 1;

    // In a DM the owner's question is answered with their list, and an
    // instruction that is not a reply with how to give one. Elsewhere, history
    // is answered quietly: a public reply under a message from last spring
    // answers nobody who is waiting, and pings a channel that moved on. An
    // integration's post is never replied to: an echo bot answers back.
    if (row.via_dm) {
      await answerTag(tag, row, SKIPPED_REACTION);
      const said =
        row.direction !== "sent"
          ? null
          : verdict.category === "question"
            ? await ownerOverview(tag)
            : verdict.category === "command"
              ? ownerDmHelp()
              : null;
      if (said) await replyInDm(tag, row, said, null);
      return;
    }
    const reply = row.backfilled || row.from_app ? null : skipReply(verdict.category, botId);
    if (reply) {
      try {
        await replyTo(tag.botToken, row.channel_id, row.message_id, reply);
      } catch (error) {
        summary.errors.push(`skip reply: ${message(error)}`);
      }
    }
    await answerTag(tag, row, SKIPPED_REACTION);
    return;
  }

  // The same request tagged again while the first is still open: already on
  // the board, so answer ✅ and file nothing — the repeat is what a tag with no
  // visible answer used to produce (Lucky35, 2026-09-29). It still lands on
  // "Not filed", where "File it anyway" files it. A task made from THIS row
  // (a run that died between filing it and marking the row) is not a repeat.
  const key = requestKey(row.content, botIds);
  const already = key ? onBoard.get(key) : undefined;
  if (already && already.messageId !== row.id) {
    const { error } = await db
      .from("tt_messages")
      .update({
        classified_at: now,
        is_task: false,
        skip_category: "duplicate",
        classification_reason: duplicateReason(already.title),
        classification_error: null,
        answer_owed: owed,
      })
      .eq("id", row.id);
    if (error) {
      summary.errors.push(`duplicate: ${error.message}`);
      return;
    }
    summary.messages_classified += 1;
    await answerTag(tag, row, FILED_REACTION);
    if (row.via_dm) await replyInDm(tag, row, alreadyFiledReply(already.title, taskUrl(already.id)), already.id);
    return;
  }

  // Erik reversed the deadlines-are-manual rule in session on 2026-09-07:
  // when the model resolves a real time out of the message's own words, the
  // clock is set here rather than waiting for someone to click "Use …".
  //
  // `decidedAt` is deliberately NOT named `now`. `now` above is an ISO
  // *string* for `classified_at`, while `resolveSuggestedDeadline` and
  // `computeNextAlertAt` both take a Date.
  const decidedAt = new Date();

  // The model's reading of the deadline when it resolves, otherwise the
  // message's own words ("deadline is 24 hours") — so a deadline stated in
  // plain English never lands under "No deadline yet" because the model
  // returned nothing.
  const phrase = pickDeadlinePhrase(verdict.suggested_deadline, row.content, {
    sentAt: row.sent_at,
    timezone: zone,
    now: decidedAt,
  });

  // The whole policy — never overwrite a human, never auto-apply a date
  // already in the past, always give an auto deadline a cadence — lives in
  // this one pure function so it can be unit-tested.
  const decision = decideAutoDeadline({
    suggested: phrase,
    sentAt: row.sent_at,
    timezone: zone,
    now: decidedAt,
    // A fresh insert: the upsert below ignores duplicates, so there is never
    // an existing row for this path to merge with.
    existing: null,
  });

  // Everyone the message @-mentioned gets their own card (Lucky35's PO,
  // 2026-10-05) — the people the message itself names, never anyone the model
  // names on its own. Received messages get nobody: there, counterparty
  // already means "who asked".
  const { assignees, unknownName, candidates, cc } =
    row.direction === "sent" ? await whoIsItFor(row, verdict, naming) : { assignees: [], unknownName: null, candidates: [], cc: [] };
  const title = verdict.title.slice(0, 200) || stripMentions(row.content).slice(0, 80) || "Untitled task";

  const base: Partial<Task> = {
    title,
    detail: verdict.detail.slice(0, 500),
    // Medium unless the message itself said urgent or low priority (`20261007_01`).
    priority: verdict.priority === "high" || verdict.priority === "low" ? verdict.priority : "medium",
    // Always populated when it resolves — including when the auto-write
    // succeeded. The board's "Use <date>" button is gated on this differing
    // from `deadline`, so blanking it would kill the one path that restores a
    // suggestion the machine refused, or that the human has since edited away.
    suggested_deadline: resolveSuggestedDeadline(phrase, { sentAt: row.sent_at, timezone: zone, now: decidedAt }),
    // The clock, its provenance and its schedule, or nothing at all. When the
    // decision is no, `deadline_source` falls to the column default 'manual' —
    // never clobberable, which is the safe direction.
    ...(decision.write
      ? {
          deadline: decision.deadline,
          deadline_source: "auto" as const,
          alert_every_minutes: decision.alertEveryMinutes,
        }
      : {}),
    // A task from a message someone else wrote is one you were given; the
    // counterparty is who gave it.
    direction: row.direction === "received" ? "received" : "given",
    counterparty: row.direction === "received" ? row.author_name : null,
  };

  // One card per person, in the order they were named. Who the work went TO
  // is the id; the name is a mutable label. Told already when a channel
  // message @-mentioned them; a DM to the bot was seen by nobody else, so
  // `tellAssignees` DMs them this tick. A card that does not land leaves the
  // message unfiled, and the retry next tick files only the cards missing.
  let first: { id: string | null } | null = null;
  for (const [part, person] of peopleOnCards(assignees).entries()) {
    const created = await insertTask(tag, row, {
      ...base,
      ...cardFields(person, part, { messageId: row.id, viaDm: row.via_dm, people: assignees, toldAt: decidedAt.toISOString(), cc }),
      // A name in a DM that matched nobody exactly: the owner picks, and
      // nobody is told anything until they do.
      assignee_candidates: candidates.length > 0 ? candidates : null,
    });
    if (!created) return;
    if (part === 0) first = created;
  }
  if (!first) return;
  if (key && first.id) onBoard.set(key, { id: first.id, title, messageId: row.id });

  await markFiled(tag, row, verdict.reason.slice(0, 500), {
    title,
    taskId: first.id,
    deadline: decision.write ? decision.deadline : null,
    assigneeName: namesText(assignees.map((person) => person.name)) || null,
    unknownName,
    candidates,
  });
}

/** What the DM confirming a filed task says. */
type FiledNote = {
  title: string;
  taskId: string | null;
  deadline: string | null;
  assigneeName: string | null;
  unknownName: string | null;
  candidates?: AssigneeCandidate[];
};

/** People a DM names in words are looked for here (`whoIsItFor`). */
type Naming = { known: PersonOption[]; findMembers: (name: string) => Promise<PersonOption[]> };

/** At most this many known people are listed to the model for one DM. */
const PEOPLE_IN_PROMPT = 60;

/**
 * Who a task the owner wrote is for. Everyone the message @-mentioned — each
 * gets a card (Lucky35's PO, 2026-10-05; until then the model had to pick one
 * of several, and picked nobody). In a DM, where Discord offers nobody to
 * @-mention, the name is read from the message's own words — an "@name" typed
 * as text, or the name the model read — and assigned ONLY when it is exactly
 * one person the owner has worked with (`exactKnown`). Anything else could be
 * the wrong person (Lucky35, 2026-10-03): the task is filed with nobody on it
 * and the possible people (`candidatesFor`, known people first, then members
 * of the bot's servers) are offered to the owner to pick from.
 */
async function whoIsItFor(
  row: PendingRow,
  verdict: Verdict,
  naming: Naming,
): Promise<{ assignees: Mentioned[]; unknownName: string | null; candidates: AssigneeCandidate[]; cc: CcPerson[] }> {
  // Anyone tagged only in a "cc" / "fyi" list is copied in, not given the
  // work (Cenri, 2026-10-20): no card, named on the task (`splitCc`).
  if (!row.via_dm || (row.mentions ?? []).length > 0) {
    const { doers, cc } = splitCc(row.mentions ?? [], row.content);
    return { assignees: doers, unknownName: null, candidates: [], cc };
  }
  // A DM: names arrive as words. A handle in a cc list is never the one the
  // task is for, and the model's pick is not used when the words name a cc.
  const ccHandles = ccMentions(row.content).handles;
  const cc: CcPerson[] = ccHandles.map((name) => ({ id: null, name }));
  const picked = verdict.named.trim().replace(/^@/, "");
  const written =
    plainHandles(withoutCc(row.content))[0] || (picked && !ccHandles.includes(picked.toLowerCase()) ? picked : "") || null;
  if (!written) return { assignees: [], unknownName: null, candidates: [], cc };

  const exact = exactKnown(naming.known, written);
  if (exact) return { assignees: [exact], unknownName: null, candidates: [], cc };

  const members = await naming.findMembers(written);
  return { assignees: [], unknownName: written, candidates: candidatesFor(written, naming.known, members), cc };
}

/** The words and the clock a card carries, copied to the card of another person its message tagged. */
const CARD_CONTENT = [
  "user_id",
  "direction",
  "counterparty",
  "title",
  "detail",
  "source_excerpt",
  "source_url",
  "color",
  "status",
  "stage",
  "stage_at",
  "deadline",
  "suggested_deadline",
  "deadline_source",
  "alert_every_minutes",
  "sort_order",
  "created_at",
] as const satisfies ReadonlyArray<keyof Task>;

/**
 * Repair (`20261005_01`): cards filed with nobody on them although their
 * message tagged people — before everyone tagged got a card (Lucky35's PO,
 * 2026-10-05: "Send cutting costs breakdown" tagged Cenri and Rea and showed
 * "No assignee"). Each person gets their card now, as a fresh filing would
 * give it: the first person on this card, a new card for every other. The
 * others go in first, so a run that dies half way files none of them twice on
 * the retry; this card is taken only while it is still nobody's — a pick on
 * the board meanwhile wins — and the flag goes with that write.
 *
 * A deadline that had already passed was never theirs to miss: the miss is
 * recorded excused ('assigned_late'), so the sweep does not count it.
 */
async function giveToEveryoneTagged(db: SupabaseClient, summary: TickSummary, accounts: Account[]) {
  const { data, error } = await db.from("tt_tasks").select("*").eq("split_pending", true).limit(100);
  if (error) {
    summary.errors.push(`everyone tagged: ${error.message}`);
    return;
  }
  const owners = new Map(accounts.map((account) => [account.connection.user_id, account.profile.discord_user_id]));
  const now = new Date();

  for (const task of (data ?? []) as Task[]) {
    const ownerId = owners.get(task.user_id) ?? null;
    const people = peopleOnCards(task.source_mentions, [ownerId]).filter((person): person is TaggedPerson => person !== null);
    if (task.status !== "open" || task.assignee_discord_id || people.length === 0) {
      const { error: clearError } = await db.from("tt_tasks").update({ split_pending: false }).eq("id", task.id);
      if (clearError) summary.errors.push(`everyone tagged: ${clearError.message}`);
      continue;
    }

    const source = { messageId: task.source_message_id ?? task.message_id, viaDm: isDmLink(task.source_url), people, toldAt: task.created_at };
    const content = Object.fromEntries(CARD_CONTENT.map((column) => [column, task[column]])) as Partial<Task>;
    const scheduled = (fields: Partial<Task>) => {
      const next = nextAlertFor({ ...task, ...fields } as Task, now, ownerId);
      return { ...fields, next_alert_at: next ? next.toISOString() : null };
    };
    const lateFor: Array<{ id: string; person: TaggedPerson }> = [];

    let failed = false;
    for (const [part, person] of people.entries()) {
      if (part === 0) continue;
      const { data: inserted, error: insertError } = await db
        .from("tt_tasks")
        // A new card: nothing has been sent about it yet, to anyone.
        .upsert(scheduled({ ...content, ...cardFields(person, part, source), last_alert_at: null, alerts_sent: 0 }), {
          onConflict: "source_message_id,message_part",
          ignoreDuplicates: true,
        })
        .select("id");
      if (insertError) {
        summary.errors.push(`everyone tagged: ${insertError.message}`);
        failed = true;
        break;
      }
      const id = (inserted?.[0] as { id: string } | undefined)?.id;
      if (id) {
        summary.tasks_created += 1;
        lateFor.push({ id, person });
      }
    }
    if (failed) continue;

    const { data: taken, error: takeError } = await db
      .from("tt_tasks")
      .update({ ...scheduled(cardFields(people[0], 0, source)), message_id: task.message_id, split_pending: false })
      .eq("id", task.id)
      .is("assignee_discord_id", null)
      .select("id");
    if (takeError) {
      summary.errors.push(`everyone tagged: ${takeError.message}`);
      continue;
    }
    if ((taken ?? []).length > 0) lateFor.push({ id: task.id, person: people[0] });

    if (task.deadline && Date.parse(task.deadline) <= now.getTime() && lateFor.length > 0) {
      const { error: missError } = await db.from("tt_deadline_misses").upsert(
        lateFor.map(({ id, person }) => ({
          user_id: task.user_id,
          task_id: id,
          assignee_discord_id: person.id,
          assignee_name: person.name,
          task_title: task.title,
          deadline: task.deadline,
          excused_at: now.toISOString(),
          excused_reason: "assigned_late",
        })),
        { onConflict: "task_id,deadline", ignoreDuplicates: true },
      );
      if (missError) summary.errors.push(`everyone tagged: ${missError.message}`);
    }
  }
}

/**
 * Put the card in, BEFORE the message is marked classified. If this crashes
 * between the two writes, the message is picked up again next tick and
 * `tt_tasks_one_per_message` absorbs the second insert; the other order loses
 * the task silently. `next_alert_at` is derived here from the row as written —
 * never typed (CLAUDE.md) — and is always strictly in the future.
 *
 * Returns the card's id, or null (and says why) when it did not land.
 */
async function insertTask(tag: TagContext, row: PendingRow, fields: Partial<Task>): Promise<{ id: string | null } | null> {
  const decidedAt = new Date();
  const draft = {
    status: "open",
    direction: "given",
    alert_every_minutes: null,
    last_alert_at: null,
    deadline: null,
    assignee_discord_id: null,
    assignee_alerts_sent: 0,
    assignee_last_alert_at: null,
    assignee_last_error: null,
    assignee_overdue_alerts: 0,
    assignee_muted_at: null,
    assignee_muted_by: null,
    ...fields,
  } as Task;
  const next = nextAlertFor(draft, decidedAt, tag.ownerId);

  // The first card is THE card for its message (`tt_tasks_one_per_message`);
  // each further person's is one per (message, place) — either way a retry
  // files nothing twice (`20261005_01`).
  const part = fields.message_part ?? 0;
  const { error, data } = await tag.db
    .from("tt_tasks")
    .upsert(
      {
        user_id: tag.userId,
        message_id: row.id,
        source_message_id: row.id,
        source_excerpt: row.content.slice(0, 500),
        source_url: row.jump_url,
        // One hue for every card a message filed: they read as one request.
        color: colorForKey(row.id),
        // Asked by someone other than the owner — of the owner, or through
        // the owner's bot — they can read it (Lucky35, 2026-10-06).
        ...requesterOf(row.author_id, row.author_name, tag.ownerId),
        // Who made it, in its activity: the person whose message it was.
        last_actor_discord_id: row.author_id,
        last_actor_name: row.author_name,
        last_actor_at: decidedAt.toISOString(),
        ...fields,
        next_alert_at: next ? next.toISOString() : null,
      },
      { onConflict: part === 0 ? "message_id" : "source_message_id,message_part", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    // Leave classified_at null so the whole message retries; do not mark it
    // done when its task did not land.
    tag.summary.errors.push(`task insert: ${error.message}`);
    return null;
  }
  if (data && data.length > 0) tag.summary.tasks_created += 1;
  return { id: (data?.[0] as { id: string } | undefined)?.id ?? null };
}

/**
 * Mark a tagged row filed and answer it ✅ — only after its card exists. A
 * DM is also answered in words, in the DM: the owner reads who it went to and
 * when it is due (and can reply to change it); anyone else, that it reached
 * the owner.
 */
async function markFiled(tag: TagContext, row: PendingRow, reason: string, note: FiledNote) {
  const { error } = await tag.db
    .from("tt_messages")
    .update({
      classified_at: new Date().toISOString(),
      is_task: true,
      classification_reason: reason,
      classification_error: null,
      // Read too late for its ✅ to be seen: the tagger is told by DM. A DM is
      // answered in the DM below instead.
      answer_owed: row.via_dm ? null : lateAnswer(row.sent_at, new Date()),
    })
    .eq("id", row.id);
  if (error) {
    // The card is in; the row is read again next tick, finds it, and answers.
    tag.summary.errors.push(`mark filed: ${error.message}`);
    return;
  }
  tag.summary.messages_classified += 1;

  // Only after the card exists: ✅ must never claim a task that did not land.
  await answerTag(tag, row, FILED_REACTION);
  if (!row.via_dm) return;
  const text =
    row.direction === "sent"
      ? filedReply({
          title: note.title,
          deadline: note.deadline,
          assigneeName: note.assigneeName,
          unknownName: note.unknownName,
          candidates: note.candidates,
          link: note.taskId ? taskUrl(note.taskId) : siteUrl(),
        })
      : passedOnReply(tag.ownerName, note.title);
  await replyInDm(tag, row, text, row.direction === "sent" ? note.taskId : null);
}

/**
 * A tagged message Claude would not or could not read, alone, `MAX_CLASSIFY_ATTEMPTS`
 * times. It is filed anyway, from its own words, the way "Make it a task" files
 * one (`taskFromMessage`): tagging the bot is how people say "track this", and
 * the alternative — waiting for ever — blocks every tag behind it.
 */
async function fileUnread(tag: TagContext, row: PendingRow, zone: string, why: string) {
  const draft = taskFromMessage(
    { ...row, direction: row.direction, mentions: row.mentions ?? [], classification_reason: null, skip_category: "chatter" } satisfies SkippedMessage,
    { userId: tag.userId, timezone: zone, now: new Date(), ownerDiscordId: tag.ownerId },
  );
  // Its words and its stated deadline; the row, the message and the schedule
  // are `insertTask`'s to write — and a card for everyone it tagged.
  const fields: Partial<Task> = { ...draft };
  delete fields.user_id;
  delete fields.message_id;
  delete fields.next_alert_at;

  const { doers: people, cc } = row.direction === "sent" ? splitCc(row.mentions ?? [], row.content) : { doers: [], cc: [] };
  const toldAt = new Date().toISOString();
  let first: { id: string | null } | null = null;
  for (const [part, person] of peopleOnCards(people).entries()) {
    const created = await insertTask(tag, row, {
      ...fields,
      ...cardFields(person, part, { messageId: row.id, viaDm: row.via_dm, people, toldAt, cc }),
      detail: UNREAD_FILED_NOTE,
    });
    if (!created) return;
    if (part === 0) first = created;
  }
  if (!first) return;
  await markFiled(tag, row, `${UNREAD_FILED_NOTE} (${why})`.slice(0, 500), {
    title: fields.title ?? "Untitled task",
    taskId: first.id,
    deadline: fields.deadline ?? null,
    assigneeName: namesText(people.map((person) => person.name)) || null,
    unknownName: null,
  });
}

/** An open request already on the board, and the message that filed it. */
type OpenRequest = { id: string; title: string; messageId: string | null };

/**
 * Open requests already on the board, by `requestKey`, so a repeat tag is
 * recognised rather than filed again. Recent ones only: a request finished or
 * a fortnight old is fair to ask again.
 */
async function openRequestKeys(db: SupabaseClient, userId: string, botIds: string[]): Promise<Map<string, OpenRequest>> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data } = await db
    .from("tt_tasks")
    .select("id, title, source_excerpt, message_id")
    .eq("user_id", userId)
    .eq("status", "open")
    .gte("created_at", since)
    .not("source_excerpt", "is", null)
    .limit(1000);

  const keys = new Map<string, OpenRequest>();
  for (const task of (data ?? []) as Array<{ id: string; title: string; source_excerpt: string; message_id: string | null }>) {
    const key = requestKey(task.source_excerpt, botIds);
    if (key && !keys.has(key)) keys.set(key, { id: task.id, title: task.title, messageId: task.message_id });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Answering a tag on Discord
// ---------------------------------------------------------------------------

/** What `answerTag` needs from the stage that calls it. */
type TagContext = {
  db: SupabaseClient;
  summary: TickSummary;
  botToken: string;
  userId: string;
  /** The account owner's Discord id — for scheduling, and the one told in a tagger's place. */
  ownerId: string | null;
  /** Named — never mentioned — in what the bot says to other people. */
  ownerName: string | null;
};

function tagContext(db: SupabaseClient, summary: TickSummary, botToken: string, connection: ConnectionRow, profile: ProfileRow): TagContext {
  return {
    db,
    summary,
    botToken,
    userId: connection.user_id,
    ownerId: profile.discord_user_id,
    ownerName: profile.discord_username,
  };
}

type TaggedRow = {
  id: string;
  channel_id: string;
  channel_name: string | null;
  message_id: string;
  /** In a DM the answer is said in words too, so a failed reaction owes nothing. */
  via_dm?: boolean;
};

/**
 * Answer a tagged message on Discord itself — ✅ filed, 👀 read and not filed
 * — and never let an answer that could not be put there pass silently
 * (Lucky35, 2026-09-29 and 2026-09-30).
 *
 * A bot invited before the invite link asked for Add Reactions may not be
 * allowed to react (403); a reaction can also fail outright. The task is filed
 * either way, but a tag with no visible answer reads as unread and gets tagged
 * again. So a refusal is recorded on the channel — the board warns that no ✅
 * there does not mean unread, with the re-invite link — and the tag is owed a
 * DM (`answer_owed = 'unmarked'`), paid by `sendOwedAnswers` at the end of the
 * pass. A tag read LATE is already owed one: its classification wrote
 * `answer_owed = 'late'` (`lateAnswer`), because a reaction on an old message
 * is seen by nobody. Only a message that is gone (404) is owed nothing: there
 * is nobody left looking at it.
 */
async function answerTag(ctx: TagContext, row: TaggedRow, emoji: string) {
  const outcome = await acknowledge(ctx.summary.errors, ctx.botToken, row.channel_id, row.message_id, emoji);
  if (row.via_dm) return;
  await noteReaction(ctx.db, ctx.userId, row.channel_id, outcome);
  if (outcome === "ok") return;

  const { error } = await ctx.db
    .from("tt_messages")
    .update({ answer_owed: outcome === "gone" ? null : "unmarked" })
    .eq("id", row.id);
  if (error) ctx.summary.errors.push(`answer owed: ${error.message}`);
}

// The date resolver that used to live here is now `resolveSuggestedDeadline`
// in `lib/deadlines.ts`: module-private here, it could never be imported by a
// test, and it read a bare local time in the server's zone rather than the
// user's.

// ---------------------------------------------------------------------------
// 3. Remind — DM the deadlines that have come due, to the person who gave the
//    task AND to the person it was given to
// ---------------------------------------------------------------------------

/** `tt_alerts.kind` for the copy sent to the assignee; the giver's copy keeps the column default. */
const ASSIGNEE_ALERT_KIND = "assignee";

type SendResult = { ok: boolean; target: string | null; messageId: string | null; error: string | null };

async function remindUser(
  db: SupabaseClient,
  summary: TickSummary,
  limits: TickLimits,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const now = new Date();

  const { data: due } = await db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", connection.user_id)
    .eq("status", "open")
    .not("next_alert_at", "is", null)
    .lte("next_alert_at", now.toISOString())
    .order("next_alert_at", { ascending: true })
    .limit(limits.alertsPerUser);

  for (const task of (due ?? []) as Task[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }

    // The person the work went to — unless that is the account owner, either
    // side switched their reminders off, or the overdue cap is spent. Received
    // work has no assignee set: the owner IS the one it was asked of, and the
    // ordinary reminder already reaches them. The rules are
    // `shouldRemindAssignee` in lib/reminders.ts.
    const ownerId = profile.discord_user_id;
    const assigneeId = (task.assignee_discord_id ?? "").trim();
    const link = taskUrl(task.id);

    // The assignee goes FIRST, so the line the giver reads about them describes
    // this round, not the last one.
    //
    // DM only, from the giver's own bot — never into the giver's reminder
    // channel, which belongs to the giver (see `sendDirectMessage`). The
    // assignee reads the same deadline and countdown the giver sees on the
    // board, rendered by Discord in their own time zone, and how to answer it.
    let assignee: SendResult | null = null;
    let stream: Partial<Task> = {};
    if (shouldRemindAssignee(task, ownerId, now)) {
      const last = isLastAssigneeReminder(task, now);
      assignee = await send(summary, task, () =>
        sendDm(
          botToken,
          assigneeId,
          reminderText(task, now, { from: task.owner_name, assignee: { last }, link, mine: mineUrl() }),
        ),
      );
      // The message id is kept so that a reply to this reminder — "done",
      // "stop" — finds its task (`runDirectMessages`).
      await db.from("tt_alerts").insert({
        user_id: connection.user_id,
        task_id: task.id,
        kind: ASSIGNEE_ALERT_KIND,
        target: assignee.target,
        message_id: assignee.messageId,
        ok: assignee.ok,
        error: assignee.error,
      });
      stream = {
        assignee_alerts_sent: task.assignee_alerts_sent + (assignee.ok ? 1 : 0),
        assignee_last_alert_at: assignee.ok ? now.toISOString() : task.assignee_last_alert_at,
        assignee_last_error: assignee.error,
        // Attempts, not deliveries: DMs that Discord keeps refusing must still
        // run the cap down rather than being retried at every slot for a month.
        assignee_overdue_alerts: task.assignee_overdue_alerts + (isOverdue(task.deadline, now) ? 1 : 0),
      };
    }

    // The giver's own copy — unless they chose "No reminder", which is theirs
    // alone: the assignee's copy above still went (Lucky35, 2026-09-30).
    let giver: SendResult | null = null;
    if (remindsGiver(task.alert_every_minutes) && !caughtRateLimit(assignee?.error ?? null)) {
      const after = { ...task, ...stream };
      const assigneeStatus = assigneeStatusLine(after, task.assignee_name ?? "The person you gave it to", ownerId, now);
      giver = await send(summary, task, () =>
        sendReminderMessage(
          botToken,
          ownerId!,
          reminderText(task, now, {
            to: assigneeStatus ? (task.assignee_name ?? null) : null,
            assigneeStatus,
            link,
          }),
          profile.reminder_channel_id,
        ),
      );
      await db.from("tt_alerts").insert({
        user_id: connection.user_id,
        task_id: task.id,
        target: giver.target,
        message_id: giver.messageId,
        ok: giver.ok,
        error: giver.error,
      });
    }

    const ok = Boolean(giver?.ok) || Boolean(assignee?.ok);

    // Reschedule either way. A failed send that kept its old next_alert_at
    // would retry every single minute forever; one that cleared it would go
    // quiet on the user without telling them. Moving to the next slot does
    // neither — it retries at the cadence the user chose. Derived from the
    // row as it now stands, so an assignee who just hit the overdue cap on a
    // task whose giver chose "No reminder" ends the schedule here.
    const next = nextAlertFor({ ...task, ...stream }, now, ownerId, now);

    const { error: rescheduleError } = await db
      .from("tt_tasks")
      .update({
        next_alert_at: next ? next.toISOString() : null,
        last_alert_at: ok ? now.toISOString() : task.last_alert_at,
        alerts_sent: task.alerts_sent + (ok ? 1 : 0),
        ...stream,
      })
      .eq("id", task.id);
    if (rescheduleError) {
      // Left as it is, the row stays due and fires again next minute — say so,
      // and stop this user's round rather than repeat it for every task.
      summary.errors.push(`reschedule ${task.id}: ${rescheduleError.message}`);
      return;
    }

    if (caughtRateLimit(giver?.error ?? null) || caughtRateLimit(assignee?.error ?? null)) return;
  }
}

/** One reminder send, with the failure put into words a person can act on. */
async function send(
  summary: TickSummary,
  task: Pick<Task, "id">,
  deliver: () => Promise<{ channelId: string; messageId: string }>,
): Promise<SendResult> {
  try {
    const sent = await deliver();
    summary.alerts_sent += 1;
    return { ok: true, target: sent.channelId, messageId: sent.messageId, error: null };
  } catch (caught) {
    const error =
      caught instanceof DiscordError && caught.status === 403
        ? "Discord refused the DM. They need to allow direct messages from server members (or pick a reminder channel in Settings, for your own copy)."
        : message(caught);
    summary.errors.push(`reminder ${task.id}: ${error}`);
    return { ok: false, target: null, messageId: null, error };
  }
}

function caughtRateLimit(error: string | null): boolean {
  return Boolean(error && error.includes("Rate limited"));
}

// ---------------------------------------------------------------------------

async function finish(
  db: SupabaseClient,
  summary: TickSummary,
  startedAt: number,
): Promise<TickSummary> {
  summary.duration_ms = Date.now() - startedAt;

  if (summary.run_id) {
    await db
      .from("tt_runs")
      .update({
        finished_at: new Date().toISOString(),
        users_seen: summary.users_seen,
        channels_polled: summary.channels_polled,
        messages_ingested: summary.messages_ingested,
        messages_classified: summary.messages_classified,
        tasks_created: summary.tasks_created,
        alerts_sent: summary.alerts_sent,
        errors: summary.errors.slice(0, 50),
      })
      .eq("id", summary.run_id);
  }

  return summary;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Commands — "@tracker deadline friday 5pm", in reply to a task
//
// Tagging the bot is how a person creates a task, so a tagged message is only
// read as an instruction ABOUT a task when it is a reply to the message that
// created one and names nobody else (`relevanceOf` in lib/relevance.ts). It is
// handled BEFORE classification, so it never becomes a task about deadlines.
//
// A reply that points at no task, or that the model reads as new work, is
// handed back to classification as an ordinary tagged message — which then
// files it or answers it with 👀 in this same tick. A reply the model cannot
// make sense of is NOT filed any more (Lucky35, 2026-09-29: those were the
// junk cards): it is answered with 👀 and a fixed line saying what the bot can
// do, and it lands on the board's "Not filed" list.
//
// Every command gets a reply in Discord — including failures. A tracker that
// silently ignores you is worse than one that says it did not understand.
// ---------------------------------------------------------------------------

type CommandRow = {
  id: string;
  content: string;
  sent_at: string;
  channel_id: string;
  channel_name: string | null;
  message_id: string;
  jump_url: string | null;
  reply_to_message_id: string | null;
  author_id: string | null;
  backfilled: boolean;
  via_dm: boolean;
  classify_attempts: number;
};

async function runCommands(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const apiKey = tryOpen(connection.anthropic_key_cipher);
  if (!apiKey) return;

  const { data: pending } = await db
    .from("tt_messages")
    .select(
      "id, content, sent_at, channel_id, channel_name, message_id, jump_url, reply_to_message_id, author_id, backfilled, via_dm, classify_attempts",
    )
    .eq("user_id", connection.user_id)
    .eq("direction", "command")
    .is("classified_at", null)
    .order("sent_at", { ascending: true })
    .limit(10);

  // A command the bot could not mark is answered in the owner's digest, like
  // any other tag — its channel reply may have been refused too.
  const tag = tagContext(db, summary, botToken, connection, profile);
  const zone = profile.timezone || "UTC";

  for (const row of ((pending ?? []) as CommandRow[])) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }

    // A command found in history was answered — or not — at the time; the
    // board must not replay a months-old "deadline friday". It is read as the
    // tagged message it is instead: work, or a "Not filed" row.
    if (row.backfilled) {
      await becomeTask(db, summary, row.id);
      continue;
    }

    // Every card the replied-to message filed: a reply to "@bot @rea @cenri
    // …" is about the request, so "push it to Friday" moves both.
    const targets = await findTargetTasks(db, connection.user_id, row);
    const target = targets[0];
    if (!target) {
      await becomeTask(db, summary, row.id);
      continue;
    }

    // The bot asked who a name meant; this reply picks one — by number or by
    // name. Nobody is told about the task until this lands.
    const choices = target.assignee_discord_id || targets.length > 1 ? [] : (target.assignee_candidates ?? []);
    const chosen = choices.length > 0 ? pickCandidate(row.content, choices) : null;
    if (chosen) {
      await assignPicked(tag, row, target, chosen, profile.discord_user_id);
      continue;
    }

    const parsed = await parseCommand({
      apiKey,
      model: connection.anthropic_model,
      content: row.content,
      sentAt: row.sent_at,
      timezone: zone,
    });

    if (!parsed.ok) {
      summary.errors.push(`${connection.user_id}: ${parsed.error}`);
      // A broken key or a rate limit must not turn an instruction into
      // nothing: left unhandled, it is read again next tick. An answer Claude
      // keeps refusing, though, is answered as not understood rather than
      // retried for ever.
      if (parsed.failure === "unavailable") continue;
      const attempts = row.classify_attempts + 1;
      if (attempts < MAX_CLASSIFY_ATTEMPTS) {
        await db.from("tt_messages").update({ classify_attempts: attempts }).eq("id", row.id);
        continue;
      }
      await commandNotApplied(tag, row, commandHelp(row, connection), "Claude could not read it.");
      continue;
    }

    if (parsed.command.action === "new_task") {
      await becomeTask(db, summary, row.id);
      continue;
    }

    // Not understood: say what the bot can do, file nothing, and keep it on the
    // board's "Not filed" list in case it was work after all.
    if (parsed.command.action === "none") {
      await commandNotApplied(tag, row, commandHelp(row, connection), "A reply to a task the tracker could not apply.");
      continue;
    }

    const context = { sentAt: row.sent_at, timezone: zone, ownerId: profile.discord_user_id, ownerName: profile.discord_username, botToken };
    let applied = await applyCommand(db, target, parsed.command, context);
    for (const other of targets.slice(1)) {
      if (!applied.ok) break;
      const also = await applyCommand(db, other, parsed.command, context);
      if (!also.ok) applied = also;
    }
    if (applied.ok && targets.length > 1) {
      const names = targets.map((card) => card.assignee_name || "someone");
      applied = { ...applied, reply: `${applied.reply}\n(On all ${targets.length} cards: ${namesText(names)}.)` };
    }

    // Did not take — a date it could not read, a write that failed: 👀, not
    // ✅, and the reason in the channel. ✅ means it was done.
    if (!applied.ok) {
      await commandNotApplied(tag, row, applied.reply, applied.reply);
      continue;
    }

    // Mark handled before replying: a Discord failure must not cause the same
    // command to run again on the next tick.
    const { error } = await db
      .from("tt_messages")
      .update({
        classified_at: new Date().toISOString(),
        is_task: false,
        command_result: applied.reply,
        command_target_task: target.id,
        answer_owed: row.via_dm ? null : lateAnswer(row.sent_at, new Date()),
      })
      .eq("id", row.id);
    if (error) summary.errors.push(`command handled: ${error.message}`);

    await answerTag(tag, row, FILED_REACTION);
    if (row.via_dm) {
      // Kept, so a reply to this answer is about the same task.
      await replyInDm(tag, row, applied.reply, target.id);
      continue;
    }
    try {
      await replyTo(botToken, row.channel_id, row.message_id, applied.reply);
    } catch (caught) {
      summary.errors.push(`command reply: ${message(caught)}`);
    }
  }
}

/**
 * Give the task to the person the owner picked from the bot's question, start
 * that person's stream afresh — `tellAssignees` DMs them this tick — and say so.
 */
async function assignPicked(tag: TagContext, row: CommandRow, task: Task, chosen: AssigneeCandidate, ownerId: string | null) {
  const now = new Date();
  const changes: Partial<Task> = {
    assignee_discord_id: chosen.id,
    assignee_name: chosen.name,
    ...FRESH_ASSIGNEE_STREAM,
  };
  const next = nextAlertFor({ ...task, ...changes } as Task, now, ownerId);
  changes.next_alert_at = next ? next.toISOString() : null;

  const { error } = await tag.db
    .from("tt_tasks")
    .update(changes)
    .eq("id", task.id)
    // Only while it is still unassigned: a pick on the board meanwhile wins.
    .is("assignee_discord_id", null);
  const reply = error ? `I could not give it to ${chosen.label}: ${error.message}` : givenToReply(chosen.label, task.title);

  await tag.db
    .from("tt_messages")
    .update({ classified_at: now.toISOString(), is_task: false, command_result: reply, command_target_task: task.id })
    .eq("id", row.id);
  await answerTag(tag, row, error ? SKIPPED_REACTION : FILED_REACTION);
  if (row.via_dm) await replyInDm(tag, row, reply, task.id);
  else {
    try {
      await replyTo(tag.botToken, row.channel_id, row.message_id, reply);
    } catch (caught) {
      tag.summary.errors.push(`command reply: ${message(caught)}`);
    }
  }
}

/** How to give a command: tag-and-reply in a channel, just reply in a DM. */
function commandHelp(row: CommandRow, connection: ConnectionRow): string {
  return row.via_dm ? ownerDmHelp() : (skipReply("command", connection.discord_bot_user_id ?? "") ?? "");
}

/**
 * A command that was read and not carried out: 👀, the reason as a reply, and a
 * row on the board's "Not filed" list (`skip_category = 'command'`), one click
 * from becoming a task in case it was work after all.
 */
async function commandNotApplied(tag: TagContext, row: CommandRow, reply: string, reason: string) {
  const { error } = await tag.db
    .from("tt_messages")
    .update({
      classified_at: new Date().toISOString(),
      is_task: false,
      skip_category: "command",
      classification_reason: reason.slice(0, 500),
      command_result: reply,
      answer_owed: row.via_dm ? null : lateAnswer(row.sent_at, new Date()),
    })
    .eq("id", row.id);
  if (error) {
    // Not marked: read again next tick, and answered then.
    tag.summary.errors.push(`command not applied: ${error.message}`);
    return;
  }

  await answerTag(tag, row, SKIPPED_REACTION);
  if (!reply) return;
  try {
    await replyTo(tag.botToken, row.channel_id, row.message_id, reply);
  } catch (caught) {
    tag.summary.errors.push(`command reply: ${message(caught)}`);
  }
}

/**
 * Not a command after all: hand it to classification as the tagged message it
 * is. `classified_at` is still null, so `classifyUser` — which runs straight
 * after this stage — files it or answers it in the same tick.
 */
async function becomeTask(db: SupabaseClient, summary: TickSummary, messageId: string) {
  const { error } = await db.from("tt_messages").update({ direction: "sent" }).eq("id", messageId);
  if (error) summary.errors.push(`command to task: ${error.message}`);
}

/**
 * The tasks this message replies about: every card its replied-to message
 * filed — one per person it tagged (`20261005_01`) — or the one the bot's own
 * replied-to message was about — a reminder, or the DM confirming a task
 * (`tt_alerts.message_id`). Empty otherwise.
 */
async function findTargetTasks(db: SupabaseClient, userId: string, row: CommandRow): Promise<Task[]> {
  if (!row.reply_to_message_id) return [];

  const { data: source } = await db
    .from("tt_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("message_id", row.reply_to_message_id)
    .maybeSingle();
  if (!source) {
    const task = await taskOfBotMessage(db, userId, row.reply_to_message_id);
    return task ? [task] : [];
  }

  const { data: tasks } = await db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("source_message_id", source.id)
    .order("message_part", { ascending: true });

  return (tasks ?? []) as Task[];
}

/** The task a message the bot sent was about — a reminder, a DM reply — or null. */
async function taskOfBotMessage(db: SupabaseClient, userId: string, messageId: string | null): Promise<Task | null> {
  if (!messageId) return null;
  const { data: alert } = await db
    .from("tt_alerts")
    .select("task_id")
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .not("task_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!alert?.task_id) return null;
  const { data: task } = await db.from("tt_tasks").select("*").eq("id", alert.task_id).eq("user_id", userId).maybeSingle();
  return (task as Task | null) ?? null;
}

/** The owner, credited in the task's activity for a change they made by replying in Discord (`tt_task_events`). */
function ownerActor(context: { ownerId: string | null; ownerName: string | null }, now: Date): Partial<Task> {
  return { last_actor_discord_id: context.ownerId, last_actor_name: context.ownerName, last_actor_at: now.toISOString() };
}

/**
 * Carry out one command on its task. Every change to the deadline, the cadence
 * or the status re-derives `next_alert_at` from the row as it will stand
 * (`nextAlertFor`), never types it.
 *
 * Review (Lucky35's PO, 2026-10-07): "approve" — or "done" — on work given to
 * someone else is a verdict, and "more time" on reported work is the extend
 * verdict, through the same `decide` as the board's review panel
 * (`lib/review-server.ts`). "Disapprove" reopens it on the time they had left.
 */
async function applyCommand(
  db: SupabaseClient,
  task: Task,
  command: Command,
  context: { sentAt: string; timezone: string; ownerId: string | null; ownerName: string | null; botToken: string },
): Promise<{ ok: boolean; reply: string }> {
  const now = new Date();
  const changes: Partial<Task> = {};

  // Work given to somebody else is finished only by a verdict, which is the
  // score (Lucky35's PO, 2026-10-07): "approve" — or "done" from the owner —
  // approves it, on time or late as they say, else as the facts suggest.
  const reviewed = reviewedWork(task, context.ownerId);
  const verdict = async (decision: ReviewDecision, deadline: string | null = null) => {
    const result = await decide(db, task, { decision, note: command.note || null, deadline }, {
      now,
      botToken: context.botToken,
      reviewer: { discordId: context.ownerId, name: context.ownerName },
    });
    if (!result.ok) return { ok: false, reply: `${result.error}\n↪ **${task.title}**` };
    return {
      ok: true,
      reply: verdictReply(decision, task.title, task.assignee_name ?? "the assignee", result.told, result.review.new_deadline),
    };
  };

  if ((command.action === "accept" || command.action === "complete") && reviewed && (awaitsReview(task) || task.status === "open")) {
    const decision =
      command.timing === "late" ? "approve_late" : command.timing === "on_time" ? "approve_on_time" : suggestedApproval(task, now);
    return verdict(decision);
  }
  if (command.action === "accept") return { ok: false, reply: `Nothing on **${task.title}** is waiting for a review.` };

  if (command.action === "send_back") {
    // Disapproving reopens it (PO, 2026-10-07 — never closed as failed): −1,
    // back to In progress, on the time they had left when they reported it
    // (or a day), with the reviewer's words. Another deadline is the tool's.
    if (!reviewed || !(awaitsReview(task) || task.status === "open")) {
      return { ok: false, reply: `Nothing on **${task.title}** is waiting for a review.` };
    }
    // The −1 is kept with its reason (PO, 2026-10-09): ask for it rather than
    // record a disapproval that says nothing.
    if (!cleanNote(command.note)) {
      return {
        ok: false,
        reply: `Say why, and it is done: reply \`disapprove: what was wrong or missing\`. The reason is kept with the −1.\n↪ **${task.title}**`,
      };
    }
    return verdict("disapprove_reopen", restoredDeadline(task, now));
  }

  // More time on work waiting for review is the "extend" verdict: open again,
  // on the new deadline, with nothing counted against them.
  if (awaitsReview(task) && (command.action === "extend_deadline" || command.action === "set_deadline")) {
    const when =
      command.action === "extend_deadline"
        ? command.extend_minutes > 0
          ? extendDeadline(task.deadline, command.extend_minutes, now)
          : null
        : resolveSuggestedDeadline(command.deadline, { sentAt: context.sentAt, timezone: context.timezone, now });
    if (!when) return { ok: false, reply: "Until when? Say it like `2 more days` or `deadline friday 5pm` — nothing changed." };
    return verdict("extend", when);
  }

  if (command.action === "set_deadline") {
    // The same grammar, zone and arithmetic as a deadline read from a task
    // message: "friday" is the nearest Friday in the person's own zone, and an
    // ISO time with no offset is read in that zone, not the server's.
    const when = resolveSuggestedDeadline(command.deadline, { sentAt: context.sentAt, timezone: context.timezone, now });
    if (!when) return { ok: false, reply: `I could not read "${command.deadline}" as a date, so the deadline is unchanged.` };

    changes.deadline = when;
    // A human typing `@bot deadline friday 5pm` is a human setting the clock,
    // so this stamps 'manual' — and `decideAutoDeadline` refuses to overwrite
    // 'manual' before it checks anything else.
    changes.deadline_source = "manual";
    // A deadline with no cadence would never remind anyone, which is not what
    // "give this a deadline" means to the person asking. Default to daily.
    changes.alert_every_minutes = task.alert_every_minutes ?? 1440;
    // A new deadline is a new clock for the assignee too: the overdue cap
    // counts from the deadline they are actually late for.
    changes.assignee_overdue_alerts = 0;
  } else if (command.action === "extend_deadline") {
    // "Give her 6 more hours": later than the deadline it has, never one
    // already missed (`extendDeadline`). The score counts only the final
    // deadline, so the one it replaces costs nothing (`20261005_02`).
    if (!(command.extend_minutes > 0)) {
      return { ok: false, reply: "How much longer? Say it like `6 more hours` or `2 more days` — the deadline is unchanged." };
    }
    if (task.status !== "open") return { ok: false, reply: `**${task.title}** is closed, so there is no deadline to extend.` };
    const when = extendDeadline(task.deadline, command.extend_minutes, now);
    changes.deadline = when;
    changes.deadline_source = "manual";
    changes.alert_every_minutes = task.alert_every_minutes ?? 1440;
    changes.assignee_overdue_alerts = 0;
    const next = nextAlertFor({ ...task, ...changes }, now, context.ownerId);
    changes.next_alert_at = next ? next.toISOString() : null;
    const { error } = await db.from("tt_tasks").update({ ...changes, ...ownerActor(context, now) }).eq("id", task.id);
    if (error) return { ok: false, reply: `I could not extend it: ${error.message}` };
    const unix = Math.floor(Date.parse(when) / 1000);
    const who = task.assignee_name ? ` against ${task.assignee_name}` : "";
    return {
      ok: true,
      reply:
        `⏩ Extended by ${durationText(command.extend_minutes * 60_000)}: now due <t:${unix}:F> (<t:${unix}:R>). ` +
        `The old deadline will not count${who}.\n↪ **${task.title}**`,
    };
  } else if (command.action === "set_reminder") {
    changes.alert_every_minutes = command.every_minutes > 0 ? command.every_minutes : 1440;
  } else if (command.action === "complete") {
    // The owner's own work — nobody else's score — is simply done.
    if (task.status !== "open") return { ok: false, reply: `**${task.title}** is already closed.` };
    changes.status = "done";
    changes.completed_at = now.toISOString();
    changes.completed_by = "owner";
    // Closed by the giver themselves: there is nothing left to review.
    changes.review_state = null;
    changes.stage = Math.max(task.stage, DONE_FROM_STAGE);
    changes.stage_at = stampStages(task.stage_at, changes.stage, now.toISOString());
  } else if (command.action === "dismiss") {
    changes.status = "dismissed";
    changes.completed_at = now.toISOString();
  }

  const next = nextAlertFor({ ...task, ...changes }, now, context.ownerId);
  changes.next_alert_at = next ? next.toISOString() : null;

  const { error } = await db.from("tt_tasks").update({ ...changes, ...ownerActor(context, now) }).eq("id", task.id);
  if (error) return { ok: false, reply: `I could not update it: ${error.message}` };

  return { ok: true, reply: `${command.reply}\n↪ **${task.title}**` };
}

// ---------------------------------------------------------------------------
// Direct messages — tasks by DM, and answers from the people given them
//
// Lucky35, 2026-10-02: Luka hands out work in private messages, and the people
// who work with him need one place to see it. A bot can never read a DM
// between two people; it CAN read a DM sent to the bot. So the owner writes a
// task to their own bot as they would tag it in a channel, and the people they
// give work to answer the same bot: `done`, `stop`, "my tasks", or a request
// for the owner.
//
// Without a live connection a bot cannot discover a DM someone else opened.
// It can open one with anyone it knows and read it: its owner, and everyone
// the owner has given work to or written about lately (`dmPeople`). Each is a
// row in `tt_dm_channels` with its own cursor, read like a channel
// (`walkChannel`) — so an edit, too, is read.
// ---------------------------------------------------------------------------

/** DM conversations read per account per tick, least recently read first. */
const DMS_PER_TICK = 40;

/** New DM conversations opened per account per tick. */
const DMS_OPENED_PER_TICK = 10;

/** A conversation with nobody active in it is still read at least this often — never dropped. */
const DM_QUIET_POLL_MS = 60 * 60_000;

/** Quiet conversations read per account per tick, longest unread first. */
const DMS_QUIET_PER_TICK = 10;

/** Pages of 100 read from one DM in one tick when many arrived at once. */
const DM_PAGES = 2;

/** `tt_alerts.kind` for the bot's own words in a DM — kept so a reply to them finds the task. */
const DM_REPLY_KIND = "dm_reply";

/** `tt_alerts.kind` for the DM telling someone they were given a task. */
const ASSIGNED_ALERT_KIND = "assigned";

/** Discord message types a DM is read for: a normal message, or a reply. */
const DM_READABLE_TYPES = new Set([0, 19]);

type DmChannelRow = {
  id: string;
  user_id: string;
  recipient_id: string;
  channel_id: string;
  last_message_id: string | null;
  last_polled_at: string | null;
  last_error: string | null;
};

/**
 * Whose DMs with the bot are read every minute: the owner first, then
 * everyone with an open task from the owner — however old — everyone given
 * work in the last `DM_PEOPLE_WINDOW_DAYS` days, and everyone the owner keeps
 * notes on. Never the bot itself. (A conversation that falls out of this list
 * is still read, less often — `pollDms` never drops one.)
 */
async function dmPeople(db: SupabaseClient, userId: string, ownerId: string, botId: string): Promise<string[]> {
  const since = new Date(Date.now() - DM_PEOPLE_WINDOW_DAYS * 86_400_000).toISOString();
  const [{ data: tasks }, { data: people }] = await Promise.all([
    db
      .from("tt_tasks")
      .select("assignee_discord_id")
      .eq("user_id", userId)
      .not("assignee_discord_id", "is", null)
      .or(`status.eq.open,updated_at.gte.${since}`)
      .order("updated_at", { ascending: false })
      .limit(1000),
    db.from("tt_people").select("discord_user_id").eq("user_id", userId).limit(200),
  ]);
  const ids = [
    ownerId,
    ...((tasks ?? []) as Array<{ assignee_discord_id: string }>).map((t) => t.assignee_discord_id.trim()),
    ...((people ?? []) as Array<{ discord_user_id: string }>).map((p) => p.discord_user_id.trim()),
  ];
  return [...new Set(ids)].filter((id) => /^\d{5,25}$/.test(id) && id !== botId);
}

async function pollDms(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const botId = connection.discord_bot_user_id;
  const ownerId = profile.discord_user_id;
  if (!botId || !ownerId) return;

  const people = await dmPeople(db, connection.user_id, ownerId, botId);
  const { data: existing, error } = await db.from("tt_dm_channels").select("*").eq("user_id", connection.user_id);
  if (error) {
    summary.errors.push(`DM channels: ${error.message}`);
    return;
  }
  const rows = (existing ?? []) as DmChannelRow[];
  const known = new Set(rows.map((row) => row.recipient_id));

  // Open the conversations not read yet. Opening sends nothing; the first read
  // goes back `DM_FIRST_READ_MS`, so a DM written just before is still answered.
  let opened = 0;
  for (const recipient of people) {
    if (known.has(recipient)) continue;
    if (opened >= DMS_OPENED_PER_TICK || Date.now() > deadline) break;
    opened += 1;
    try {
      const channelId = await openDmChannel(botToken, recipient);
      const { data: added, error: addError } = await db
        .from("tt_dm_channels")
        .upsert(
          {
            user_id: connection.user_id,
            recipient_id: recipient,
            channel_id: channelId,
            last_message_id: dateToSnowflake(new Date(Date.now() - DM_FIRST_READ_MS)),
          },
          { onConflict: "user_id,recipient_id", ignoreDuplicates: true },
        )
        .select("*");
      if (addError) summary.errors.push(`open DM: ${addError.message}`);
      else rows.push(...((added ?? []) as DmChannelRow[]));
    } catch (caught) {
      if (caught instanceof DiscordError && caught.status === 429) return;
      // Someone the bot shares no server with cannot be written to; that is
      // said where it matters — on their reminders — not every minute here.
      if (!(caught instanceof DiscordError && caught.isAccess)) summary.errors.push(`open DM: ${message(caught)}`);
    }
  }

  // Active conversations every minute; every other conversation the bot has
  // ever opened at least once an hour — never dropped. A "done" sent months
  // later in reply to an old reminder is still read and answered (Lucky35,
  // 2026-10-03: older threads went unread, and the board said "open").
  const wanted = new Set(people);
  const quietBefore = Date.now() - DM_QUIET_POLL_MS;
  const byLastRead = (a: DmChannelRow, b: DmChannelRow) => (a.last_polled_at ?? "").localeCompare(b.last_polled_at ?? "");
  const active = rows.filter((row) => wanted.has(row.recipient_id)).sort(byLastRead);
  const quiet = rows
    .filter((row) => !wanted.has(row.recipient_id) && (!row.last_polled_at || Date.parse(row.last_polled_at) < quietBefore))
    .sort(byLastRead);
  const due = [...active.slice(0, DMS_PER_TICK), ...quiet.slice(0, DMS_QUIET_PER_TICK)];

  let next = 0;
  let stop = false;
  await Promise.all(
    Array.from({ length: Math.min(5, due.length) }, async () => {
      while (!stop && next < due.length && Date.now() <= deadline) {
        const row = due[next++];
        if (await pollDmChannel(db, summary, connection, ownerId, botId, botToken, row)) stop = true;
      }
    }),
  );
}

/** Read one DM. Returns true when the caller should stop (a rate limit is per bot token). */
async function pollDmChannel(
  db: SupabaseClient,
  summary: TickSummary,
  connection: ConnectionRow,
  ownerId: string,
  botId: string,
  botToken: string,
  row: DmChannelRow,
): Promise<boolean> {
  const fromOwner = row.recipient_id === ownerId;
  const progress = { cursor: row.last_message_id ?? dateToSnowflake(new Date(Date.now() - DM_FIRST_READ_MS)) };

  const take = async (messages: DiscordMessage[]): Promise<boolean> => {
    // Only what the other person wrote — never the bot's own words.
    // A screenshot sent with no words is proof, and kept like any other message.
    const theirs = messages
      .filter((m) => m.author.id === row.recipient_id && DM_READABLE_TYPES.has(m.type))
      .map((m) => ({ m, read: readableMessage(m) }))
      .filter(({ m, read }) => read.content.trim() !== "" || (m.attachments?.length ?? 0) > 0);
    if (theirs.length === 0) return true;

    const { error } = await db.from("tt_messages").upsert(
      theirs.map(({ m, read }) => ({
        user_id: connection.user_id,
        guild_id: null,
        channel_id: row.channel_id,
        channel_name: null,
        message_id: m.id,
        content: read.content.slice(0, 4000),
        jump_url: jumpUrl("@me", row.channel_id, m.id),
        sent_at: m.timestamp,
        author_id: m.author.id,
        author_name: authorName(m),
        // The owner's DM is a tag by definition: a task, or — as a reply to a
        // message about a task — a command. Anyone else's waits for
        // `runDirectMessages` to say what it is.
        direction: fromOwner ? (repliesTo(m) ? "command" : "sent") : "dm_in",
        mentions: assigneesOf(read, ownerId, botId),
        reply_to_message_id: repliesTo(m),
        from_app: false,
        via_dm: true,
        attachments: attachmentsOf(m),
      })),
      // Skipped, not merged, like every ingest path (AGENTS.md: Supabase).
      { onConflict: "user_id,message_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    summary.messages_ingested += theirs.length;
    return true;
  };

  try {
    await walkChannel(botToken, row.channel_id, progress, row.last_polled_at, DM_PAGES, take);
    await db
      .from("tt_dm_channels")
      .update({ last_message_id: progress.cursor, last_polled_at: new Date().toISOString(), last_error: null })
      .eq("id", row.id);
    return false;
  } catch (caught) {
    await db
      .from("tt_dm_channels")
      .update({ last_message_id: progress.cursor, last_polled_at: new Date().toISOString(), last_error: message(caught) })
      .eq("id", row.id);
    if (!(caught instanceof DiscordError && caught.isAccess)) summary.errors.push(`DM: ${message(caught)}`);
    return caught instanceof DiscordError && caught.status === 429;
  }
}

/**
 * A message from someone other than the owner, about their own work: a DM to
 * the bot, or a channel tag kept as a `report` (`relevanceOf`).
 */
type ReportRow = {
  id: string;
  content: string;
  sent_at: string;
  channel_id: string;
  channel_name: string | null;
  message_id: string;
  jump_url: string | null;
  author_id: string | null;
  author_name: string | null;
  reply_to_message_id: string | null;
  classify_attempts: number;
  attachments: DiscordAttachment[] | null;
  via_dm: boolean;
  backfilled: boolean;
};

const REPORT_COLUMNS =
  "id, content, sent_at, channel_id, channel_name, message_id, jump_url, author_id, author_name, reply_to_message_id, classify_attempts, attachments, via_dm, backfilled";

const DM_ACTION_OF: Record<string, DmAction | undefined> = {
  started: "start",
  done: "done",
  stop_reminders: "mute",
  resume_reminders: "unmute",
};

/** `tt_alerts.kind` for the bot's "send the proof" — a reply to it IS the proof. */
const PROOF_REQUEST_KIND = "proof_request";

/** How many tasks the "which one?" list offers. */
const PICK_LIST_MAX = 15;

/**
 * What someone other than the owner said to the owner's bot (Lucky35,
 * 2026-10-02): an answer about a task of theirs — done (with its proof),
 * started, stop, resume — applied as the board would apply it
 * (`applyAssigneeAnswer`, the reviewer told); "my tasks", answered with the
 * list; a request, handed to classification as work asked OF the owner;
 * anything else, 👀 — never silence.
 *
 * Who wrote it is Discord's word: the author of a message in the bot's DM with
 * that person. It is only ever matched against tasks given to that same id.
 */
async function runDirectMessages(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const apiKey = tryOpen(connection.anthropic_key_cipher);
  if (!apiKey) return;

  const { data } = await db
    .from("tt_messages")
    .select(REPORT_COLUMNS)
    .eq("user_id", connection.user_id)
    .eq("direction", "dm_in")
    .is("classified_at", null)
    .order("sent_at", { ascending: true })
    .limit(10);

  const tag = tagContext(db, summary, botToken, connection, profile);
  const now = new Date();

  for (const row of (data ?? []) as ReportRow[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }
    const authorId = (row.author_id ?? "").trim();
    const dm = { ...row, via_dm: true };

    // A "yes" or "no" to the bot's "send this as a task?" — read without the
    // model: only the sender's own short answer, in reply to that question,
    // turns their request into a task (Lucky35, 2026-10-03: no junk cards).
    if (row.reply_to_message_id) {
      const { data: asked } = await db
        .from("tt_messages")
        .select("id")
        .eq("user_id", connection.user_id)
        .eq("confirm_message_id", row.reply_to_message_id)
        .eq("author_id", authorId)
        .is("confirmed_at", null)
        .maybeSingle();
      if (asked && isYes(row.content)) {
        // Back to classification, as work asked OF the owner — this tick.
        const { error } = await db
          .from("tt_messages")
          .update({ direction: "received", classified_at: null, confirmed_at: now.toISOString(), command_result: null })
          .eq("id", asked.id);
        if (error) {
          summary.errors.push(`DM confirm: ${error.message}`);
          continue;
        }
        await settleDm(tag, dm, { command_result: "Confirmed: sent as a task." }, FILED_REACTION, null);
        continue;
      }
      if (asked && isNo(row.content)) {
        await db
          .from("tt_messages")
          .update({ confirm_message_id: null, command_result: "Not sent: its sender said no." })
          .eq("id", asked.id);
        await settleDm(tag, dm, { command_result: "Not sent." }, SKIPPED_REACTION, "OK — not sent.");
        continue;
      }
    }

    // A number from the bot's "which task?" list, or proof sent in reply to
    // its "send the proof" — answered without the model.
    if (await answerPickOrProof(tag, dm, profile)) continue;

    const reading = await readReport(tag, dm, profile, connection, apiKey, now);
    if (reading === "stop") return;
    if (reading === "retry") continue;
    if (reading === "unreadable") {
      // Claude will not read it: say what the bot can do — and how to ask
      // for something on purpose.
      await settleDm(tag, dm, { classification_reason: "Claude could not read it." }, SKIPPED_REACTION, guestDmHelp(profile.discord_username));
      continue;
    }
    const { action, tasks, replied, repliedTask } = reading;

    if (action === "request") {
      // Asked, not filed: their "yes" to this question is what files it.
      const question = requestConfirmQuestion(profile.discord_username, stripMentions(row.content) || row.content);
      const asked = await replyInDm(tag, row, question, null);
      if (!asked && row.classify_attempts + 1 < MAX_CLASSIFY_ATTEMPTS) {
        await db.from("tt_messages").update({ classify_attempts: row.classify_attempts + 1 }).eq("id", row.id);
        continue;
      }
      await settleDm(
        tag,
        dm,
        { command_result: question, confirm_message_id: asked, classification_reason: "A request, waiting for its sender to confirm." },
        SKIPPED_REACTION,
        null,
      );
      continue;
    }

    if (action === "list") {
      const text = taskListText(tasks, now, {
        heading: `On you from **${profile.discord_username ?? "them"}**:`,
        empty: `Nothing from ${profile.discord_username ?? "them"} is on you right now.`,
        link: mineUrl(),
        forGiver: false,
      });
      await settleDm(tag, dm, { command_result: text }, FILED_REACTION, text);
      continue;
    }

    const answer = DM_ACTION_OF[action];
    if (answer) {
      await answerAboutTask(tag, dm, profile, answer, { tasks, replied, repliedTask, number: reading.number, words: reading.proof, now });
      continue;
    }

    // Thanks, small talk, or something unclear: 👀, and help when it was
    // unclear. Not a card and not a "Not filed" row — the owner never has to
    // clear other people's chat off their board (Lucky35, 2026-10-03).
    await settleDm(
      tag,
      dm,
      { classification_reason: action === "thanks" ? "An acknowledgement by DM." : "A DM the tracker could not place." },
      SKIPPED_REACTION,
      action === "thanks" ? null : guestDmHelp(profile.discord_username),
    );
  }
}

/**
 * Channel tags kept as reports (Lucky35's PO, 2026-10-07): someone with open
 * work from this owner tagged the bot — to hand in the work with its proof,
 * to say they started, to stop their reminders. Anything else they meant is
 * handed back to what it would otherwise have been (`fallbackDirection`): work
 * asked of the owner, work a teammate hands out, or a stranger's tag,
 * answered and not stored. History found by Backfill is never read as a
 * report: a months-old "done" closes nothing.
 */
async function runReports(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
  team: ReadonlySet<string>,
) {
  const apiKey = tryOpen(connection.anthropic_key_cipher);
  const ownerId = profile.discord_user_id;
  if (!apiKey || !ownerId) return;

  const { data } = await db
    .from("tt_messages")
    .select(REPORT_COLUMNS)
    .eq("user_id", connection.user_id)
    .eq("direction", "report")
    .is("classified_at", null)
    .order("sent_at", { ascending: true })
    .limit(10);

  const tag = tagContext(db, summary, botToken, connection, profile);
  const now = new Date();

  for (const row of (data ?? []) as ReportRow[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }
    if (row.backfilled) {
      await reportFallsBack(tag, row, ownerId, team, profile);
      continue;
    }
    if (await answerPickOrProof(tag, row, profile)) continue;

    const reading = await readReport(tag, row, profile, connection, apiKey, now);
    if (reading === "stop") return;
    if (reading === "retry") continue;
    const answer = reading === "unreadable" ? undefined : DM_ACTION_OF[reading.action];
    if (reading === "unreadable" || !answer) {
      await reportFallsBack(tag, row, ownerId, team, profile);
      continue;
    }
    await answerAboutTask(tag, row, profile, answer, {
      tasks: reading.tasks,
      replied: reading.replied,
      repliedTask: reading.repliedTask,
      number: reading.number,
      words: reading.proof,
      now,
    });
  }
}

/** A channel report that turned out to be about no task of theirs: what it would otherwise have been. */
async function reportFallsBack(tag: TagContext, row: ReportRow, ownerId: string, team: ReadonlySet<string>, profile: ProfileRow) {
  const direction = fallbackDirection(row.content, (row.author_id ?? "").trim(), ownerId, team);
  if (direction === "foreign") {
    // Answered, never stored as work — a stranger's tag, as `answerForeignTags` treats it.
    await settleDm(
      tag,
      row,
      { classification_reason: "A tag about no task of theirs." },
      SKIPPED_REACTION,
      row.backfilled ? null : foreignTagReply(profile.discord_username, siteUrl()),
    );
    return;
  }
  // Classification files it this tick, exactly as if it had been read that way.
  const { error } = await tag.db.from("tt_messages").update({ direction }).eq("id", row.id);
  if (error) tag.summary.errors.push(`report: ${error.message}`);
}

type ReportReading = {
  action: string;
  number: number;
  proof: string;
  tasks: Task[];
  replied: Task | null;
  repliedTask: Task | null;
};

/**
 * Read a report with the owner's Claude, with what it needs: the sender's open
 * tasks from this owner, most urgent first, and the task it replies about.
 * "stop" — Claude is unavailable, try next tick; "retry" — counted, try again;
 * "unreadable" — given up on.
 */
async function readReport(
  tag: TagContext,
  row: ReportRow,
  profile: ProfileRow,
  connection: ConnectionRow,
  apiKey: string,
  now: Date,
): Promise<ReportReading | "stop" | "retry" | "unreadable"> {
  const authorId = (row.author_id ?? "").trim();
  const { data: theirs } = await tag.db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", tag.userId)
    .eq("direction", "given")
    .eq("status", "open")
    .eq("assignee_discord_id", authorId)
    .limit(100);
  const tasks = byUrgency((theirs ?? []) as Task[], now);
  // The task their reply is about — whoever it is on now, and however old.
  const replied = await repliedTaskOf(tag.db, tag.userId, row);
  const repliedTask = replied && replied.assignee_discord_id === authorId ? replied : null;

  const read = await readDirectMessage({
    apiKey,
    model: connection.anthropic_model,
    ownerName: profile.discord_username,
    authorName: row.author_name,
    content: row.content,
    replyingTo: replied?.title ?? null,
    tasks: tasks.map((t) => t.title),
    where: row.via_dm ? "direct message" : "server channel",
    files: (row.attachments ?? []).length,
  });

  if (!read.ok) {
    tag.summary.errors.push(`${connection.user_id}: ${read.error}`);
    if (read.failure === "unavailable") {
      await tag.db.from("tt_connections").update({ anthropic_last_error: read.error }).eq("user_id", connection.user_id);
      return "stop";
    }
    const attempts = row.classify_attempts + 1;
    if (attempts < MAX_CLASSIFY_ATTEMPTS) {
      await tag.db.from("tt_messages").update({ classify_attempts: attempts }).eq("id", row.id);
      return "retry";
    }
    return "unreadable";
  }
  return { action: read.reading.action, number: read.reading.task, proof: read.reading.proof, tasks, replied, repliedTask };
}

/**
 * The task a report replies about: the one the bot's replied-to message was
 * about (a reminder, a DM, a verdict), or — in a channel — the one the
 * replied-to message filed for this sender.
 */
async function repliedTaskOf(db: SupabaseClient, userId: string, row: ReportRow): Promise<Task | null> {
  if (!row.reply_to_message_id) return null;
  const fromBot = await taskOfBotMessage(db, userId, row.reply_to_message_id);
  if (fromBot || row.via_dm) return fromBot;

  const { data: source } = await db
    .from("tt_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("message_id", row.reply_to_message_id)
    .maybeSingle();
  if (!source) return null;
  const { data: cards } = await db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("source_message_id", source.id)
    .order("message_part", { ascending: true });
  const list = (cards ?? []) as Task[];
  return list.find((card) => card.assignee_discord_id === (row.author_id ?? "").trim()) ?? list[0] ?? null;
}

/**
 * An answer about one of the sender's tasks — done, started, stop, resume.
 * Which task (Lucky35's PO, 2026-10-07): the one the message replies about;
 * else the one their words number; else their only open task; else the bot
 * asks with a numbered list — and, for "done", keeps this message's proof
 * for the number they answer with.
 */
async function answerAboutTask(
  tag: TagContext,
  row: ReportRow,
  profile: ProfileRow,
  answer: DmAction,
  {
    tasks,
    replied,
    repliedTask,
    number,
    words,
    now,
  }: { tasks: Task[]; replied: Task | null; repliedTask: Task | null; number: number; words: string; now: Date },
) {
  const authorId = (row.author_id ?? "").trim();
  const giver = profile.discord_username ?? "them";

  // A reply about a task that is no longer theirs, or no longer open, is
  // answered as such — never a silent nothing (Lucky35, 2026-10-03).
  if (replied && !repliedTask) {
    const text = `**${replied.title}** isn't on you any more — nothing to do.`;
    await settleDm(tag, row, { command_result: text }, SKIPPED_REACTION, text);
    return;
  }
  if (repliedTask && repliedTask.status !== "open") {
    const text = awaitsReview(repliedTask)
      ? `**${repliedTask.title}** is reported done and waiting for ${repliedTask.requested_by_name ?? giver}'s review.`
      : answer === "done" || answer === "start"
        ? `**${repliedTask.title}** is already closed — nothing more to do.`
        : `**${repliedTask.title}** is closed, so it sends no more reminders.`;
    await settleDm(tag, row, { command_result: text, command_target_task: repliedTask.id }, FILED_REACTION, text, repliedTask.id);
    return;
  }

  const target = repliedTask ?? pickNumbered(tasks, number) ?? (tasks.length === 1 ? tasks[0] : null);
  if (!target) {
    if (answer === "done" && tasks.length > 1) {
      // Which task is this proof for? Kept on this message until they answer.
      const offered = tasks.slice(0, PICK_LIST_MAX);
      const text = pickListText(offered.map((task) => task.title));
      await settleDm(tag, row, { command_result: text, proof_task_ids: offered.map((task) => task.id) }, SKIPPED_REACTION, null);
      const asked = await replyInDm(tag, row, text, null);
      if (asked) await tag.db.from("tt_messages").update({ proof_pick_message_id: asked }).eq("id", row.id);
      return;
    }
    const text = taskListText(tasks, now, {
      heading: "Which one? Reply to my message about it, or say which number:",
      empty: `Nothing from ${giver} is open on you.`,
      link: mineUrl(),
      forGiver: false,
    });
    await settleDm(tag, row, { command_result: text }, SKIPPED_REACTION, text);
    return;
  }

  if (answer === "done") {
    const items = proofFromDiscord({ content: row.content, attachments: row.attachments, words });
    await reportDone(tag, row, target, items, profile, row.jump_url);
    return;
  }

  const applied = await applyAssigneeAnswer(tag.db, target, answer, authorId, now);
  const text = applied.ok ? assigneeAnswerReply(answer, target.title, profile.discord_username) : applied.error;
  await settleDm(
    tag,
    row,
    { command_result: text, command_target_task: target.id },
    applied.ok ? FILED_REACTION : SKIPPED_REACTION,
    text,
    target.id,
  );
}

/**
 * Report the task done with its proof — or, with none, ask for it: "done" is
 * never taken on someone's word (Lucky35's PO, 2026-10-07). The question's id
 * is kept (`PROOF_REQUEST_KIND`), so the reply to it is the proof.
 */
async function reportDone(
  tag: TagContext,
  row: ReportRow,
  target: Task,
  items: ReturnType<typeof proofFromDiscord>,
  profile: ProfileRow,
  messageUrl: string | null,
) {
  if (items.length === 0) {
    const text = proofRequestText(target.title);
    await settleDm(tag, row, { command_result: text, command_target_task: target.id }, SKIPPED_REACTION, null);
    await replyInDm(tag, row, text, target.id, PROOF_REQUEST_KIND);
    return;
  }
  const applied = await applyAssigneeAnswer(tag.db, target, "done", (row.author_id ?? "").trim(), new Date(), {
    items,
    source: "discord",
    byName: row.author_name,
    messageUrl,
  });
  const text = applied.ok
    ? proofTakenReply(target.title, target.requested_by_name ?? profile.discord_username, applied.proofs.length)
    : applied.error;
  await settleDm(
    tag,
    row,
    { command_result: text, command_target_task: target.id },
    applied.ok ? FILED_REACTION : SKIPPED_REACTION,
    text,
    target.id,
  );
}

/**
 * Answered without the model: a number given in reply to the bot's "which
 * task is this for?" — the proof the asking message carried goes on that
 * task — or proof sent in reply to its "send the proof". True when handled.
 */
async function answerPickOrProof(tag: TagContext, row: ReportRow, profile: ProfileRow): Promise<boolean> {
  if (!row.reply_to_message_id) return false;
  const authorId = (row.author_id ?? "").trim();

  const { data: waiting } = await tag.db
    .from("tt_messages")
    .select("id, content, attachments, jump_url, proof_task_ids")
    .eq("user_id", tag.userId)
    .eq("proof_pick_message_id", row.reply_to_message_id)
    .eq("author_id", authorId)
    .maybeSingle();
  if (waiting) {
    const asked = waiting as { id: string; content: string; attachments: DiscordAttachment[] | null; jump_url: string | null; proof_task_ids: string[] | null };
    const ids = asked.proof_task_ids ?? [];
    const n = pickNumber(row.content, ids.length);
    if (!n) {
      const text = "Reply with the number of the task, from my list.";
      await settleDm(tag, row, { command_result: text }, SKIPPED_REACTION, text);
      return true;
    }
    // Answered: the list asks nothing any more.
    await tag.db.from("tt_messages").update({ proof_pick_message_id: null }).eq("id", asked.id);
    const { data: chosen } = await tag.db.from("tt_tasks").select("*").eq("id", ids[n - 1]).maybeSingle();
    const task = chosen as Task | null;
    if (!task || task.assignee_discord_id !== authorId || task.status !== "open") {
      const text = `${task ? `**${task.title}**` : "That task"} isn't open on you any more — nothing to do.`;
      await settleDm(tag, row, { command_result: text }, SKIPPED_REACTION, text);
      return true;
    }
    const items = proofFromDiscord({ content: asked.content, attachments: asked.attachments, words: proofWords(asked.content) });
    await reportDone(tag, row, task, items, profile, asked.jump_url);
    return true;
  }

  const { data: alert } = await tag.db
    .from("tt_alerts")
    .select("task_id")
    .eq("user_id", tag.userId)
    .eq("message_id", row.reply_to_message_id)
    .eq("kind", PROOF_REQUEST_KIND)
    .not("task_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!alert?.task_id) return false;
  const { data: found } = await tag.db.from("tt_tasks").select("*").eq("id", alert.task_id).eq("user_id", tag.userId).maybeSingle();
  const task = found as Task | null;
  if (!task || task.assignee_discord_id !== authorId) return false;
  if (task.status !== "open") {
    const text = awaitsReview(task)
      ? `**${task.title}** is already reported done and waiting for review.`
      : `**${task.title}** is closed — nothing more to do.`;
    await settleDm(tag, row, { command_result: text, command_target_task: task.id }, FILED_REACTION, text, task.id);
    return true;
  }
  // They were asked for proof: every word they sent back counts as it.
  const items = proofFromDiscord({ content: row.content, attachments: row.attachments, words: row.content });
  await reportDone(tag, row, task, items, profile, row.jump_url);
  return true;
}

/** Close a DM row read by `runDirectMessages`, and answer it — reaction, and words when there are any. */
async function settleDm(
  tag: TagContext,
  row: { id: string; channel_id: string; channel_name: string | null; message_id: string; via_dm: boolean },
  fields: Record<string, unknown>,
  emoji: string,
  text: string | null,
  taskId: string | null = null,
) {
  const { error } = await tag.db
    .from("tt_messages")
    .update({ classified_at: new Date().toISOString(), is_task: false, classification_error: null, ...fields })
    .eq("id", row.id);
  if (error) {
    // Not marked: read again next tick, and answered then.
    tag.summary.errors.push(`DM answer: ${error.message}`);
    return;
  }
  tag.summary.messages_classified += 1;
  await answerTag(tag, row, emoji);
  if (text) await replyInDm(tag, row, text, taskId);
}

/**
 * Say something in a DM, as a reply to the message it answers, and remember
 * which task it was about: a reply to the bot's words ("done", "deadline
 * friday") then finds that task (`taskOfBotMessage`).
 */
async function replyInDm(
  tag: TagContext,
  row: { channel_id: string; message_id: string },
  text: string,
  taskId: string | null,
  kind: string = DM_REPLY_KIND,
): Promise<string | null> {
  try {
    const posted = await replyTo(tag.botToken, row.channel_id, row.message_id, text);
    if (taskId) {
      await tag.db.from("tt_alerts").insert({
        user_id: tag.userId,
        task_id: taskId,
        kind,
        target: row.channel_id,
        message_id: posted.id,
        ok: true,
        error: null,
      });
    }
    return posted.id;
  } catch (caught) {
    tag.summary.errors.push(`DM reply: ${message(caught)}`);
    return null;
  }
}

/** The owner's open tasks, as a DM — the answer to "what's open?" in their DM with the bot. */
async function ownerOverview(tag: TagContext): Promise<string> {
  const { data } = await tag.db
    .from("tt_tasks")
    .select("title, deadline, assignee_name, direction, counterparty")
    .eq("user_id", tag.userId)
    .eq("status", "open")
    .limit(300);
  return taskListText((data ?? []) as Task[], new Date(), {
    heading: "Open on your board:",
    empty: "Nothing is open on your board.",
    link: siteUrl(),
    forGiver: true,
  });
}

/**
 * Everyone the owner has given work to or keeps notes on, by every name the
 * board knows them by — what a name typed in a DM is matched against.
 */
async function knownPeopleOf(db: SupabaseClient, userId: string, ownerId: string | null): Promise<Mentioned[]> {
  const [{ data: tasks }, { data: notes }] = await Promise.all([
    db
      .from("tt_tasks")
      .select("assignee_discord_id, assignee_name")
      .eq("user_id", userId)
      .not("assignee_discord_id", "is", null)
      .not("assignee_name", "is", null)
      .order("updated_at", { ascending: false })
      .limit(500),
    db.from("tt_people").select("discord_user_id, display_name").eq("user_id", userId).limit(200),
  ]);
  const seen = new Set<string>();
  const out: Mentioned[] = [];
  const offer = (id: string | null, name: string | null) => {
    const key = (id ?? "").trim();
    const label = (name ?? "").trim();
    if (!key || !label || key === ownerId || seen.has(`${key}:${label.toLowerCase()}`)) return;
    seen.add(`${key}:${label.toLowerCase()}`);
    out.push({ id: key, name: label });
  };
  for (const task of (tasks ?? []) as Array<{ assignee_discord_id: string; assignee_name: string }>) offer(task.assignee_discord_id, task.assignee_name);
  for (const person of (notes ?? []) as Array<{ discord_user_id: string; display_name: string }>) offer(person.discord_user_id, person.display_name);
  return out;
}

/**
 * Look a name up among the members of the servers the bot is in — only ever to
 * OFFER people to the owner, never to assign one (`whoIsItFor`). One search
 * per name per server per tick; a server that will not answer is skipped.
 */
function memberFinder(db: SupabaseClient, botToken: string, userId: string): (name: string) => Promise<PersonOption[]> {
  let guilds: Promise<Array<{ id: string; name: string | null }>> | null = null;
  const found = new Map<string, Promise<PersonOption[]>>();

  const servers = async () => {
    const { data } = await db.from("tt_channels").select("guild_id, guild_name").eq("user_id", userId).limit(1000);
    const byId = new Map<string, string | null>();
    for (const c of (data ?? []) as Array<{ guild_id: string; guild_name: string | null }>) byId.set(c.guild_id, c.guild_name);
    return [...byId].slice(0, 10).map(([id, name]) => ({ id, name }));
  };

  return (name) => {
    const key = name.trim().toLowerCase();
    if (key.length < 2) return Promise.resolve([]);
    if (!found.has(key)) {
      found.set(
        key,
        (async () => {
          guilds ??= servers();
          const hits = [];
          for (const guild of await guilds) {
            try {
              for (const member of await searchGuildMembers(botToken, guild.id, name.trim(), 5)) {
                hits.push({ where: guild.name, member });
              }
            } catch {
              // Not fatal: fewer people are offered to pick from.
            }
          }
          return memberOptions(hits);
        })(),
      );
    }
    return found.get(key)!;
  };
}

/**
 * Tell each new assignee what they were given, once (`assignee_told_at`):
 * a task given by DM to the bot, made by hand on the board, or moved to them.
 * A task given in a channel @-mentioned them, so it was stamped told at birth.
 * A DM Discord refuses is stamped too, with the reason the giver then sees
 * ("Discord would not deliver…") — it is not retried every minute.
 */
async function tellAssignees(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const { data } = await db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", connection.user_id)
    .eq("status", "open")
    .eq("direction", "given")
    .not("assignee_discord_id", "is", null)
    .is("assignee_told_at", null)
    .order("created_at", { ascending: true })
    .limit(20);

  for (const task of (data ?? []) as Task[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }
    const now = new Date().toISOString();
    const assignee = (task.assignee_discord_id ?? "").trim();

    // Nobody else to tell: work kept for yourself, or reminders switched off.
    if (assignee === profile.discord_user_id || task.assignee_muted_at) {
      await db.from("tt_tasks").update({ assignee_told_at: now }).eq("id", task.id);
      continue;
    }

    const text = assignedNotice({
      ownerName: task.owner_name ?? profile.discord_username,
      title: task.title,
      deadline: task.deadline,
      detail: task.detail,
      sourceUrl: task.source_url,
      link: taskUrl(task.id),
      mine: mineUrl(),
    });
    const sent = await send(summary, task, () => sendDm(botToken, assignee, text));
    await db.from("tt_alerts").insert({
      user_id: connection.user_id,
      task_id: task.id,
      kind: ASSIGNED_ALERT_KIND,
      target: sent.target,
      message_id: sent.messageId,
      ok: sent.ok,
      error: sent.error,
    });
    const { error } = await db
      .from("tt_tasks")
      .update({ assignee_told_at: now, assignee_last_error: sent.error })
      .eq("id", task.id);
    if (error) summary.errors.push(`told ${task.id}: ${error.message}`);
    if (caughtRateLimit(sent.error)) return;
  }
}

// ---------------------------------------------------------------------------
// Finished work is chased; handed-on work is said so (Lucky35's PO, 2026-10-04)
// ---------------------------------------------------------------------------

/** `tt_alerts.kind` for the giver's daily "it waits for your review". */
const REVIEW_NUDGE_KIND = "review_nudge";

/** `tt_alerts.kind` for "it is no longer on you". */
const HANDOFF_ALERT_KIND = "handoff";

/**
 * Remind the giver, once a day, of finished work waiting for their review —
 * "nobody chases confirmation" was the gap. Each reminder is a DM of its own
 * whose id is kept, so a reply `approve` or `extend 2 days` is about that task.
 * Like a reminder, a failed send still moves to the next slot; it is never
 * retried every minute. Runs with the reminders, before any reading, so no
 * backlog delays it.
 */
async function nudgeReviews(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const now = new Date();
  const { data } = await db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", connection.user_id)
    .eq("status", "done")
    .eq("review_state", "pending")
    .not("review_nudge_at", "is", null)
    .lte("review_nudge_at", now.toISOString())
    .order("review_nudge_at", { ascending: true })
    .limit(20);

  for (const task of (data ?? []) as Task[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }
    // The reviewer is whoever created it: the person who asked for it through
    // this bot, else the owner (Lucky35's PO, 2026-10-07). Only the owner can
    // answer by reply; anyone else reviews on the board. Nobody to reach — the
    // owner has no Discord identity — leaves it on To review all the same.
    const asker = (task.requested_by_discord_id ?? "").trim();
    const byAsker = asker !== "" && asker !== (task.assignee_discord_id ?? "").trim();
    const text = reviewNudgeText(task.title, task.assignee_name ?? "Someone", task.completed_at, now, taskUrl(task.id), !byAsker);
    const sent = byAsker
      ? await send(summary, task, () => sendDm(botToken, asker, text))
      : profile.discord_user_id
        ? await send(summary, task, () =>
            sendReminderMessage(botToken, profile.discord_user_id as string, text, profile.reminder_channel_id),
          )
        : { ok: false, target: null, messageId: null, error: "Your profile has no Discord identity." };
    await db.from("tt_alerts").insert({
      user_id: connection.user_id,
      task_id: task.id,
      kind: REVIEW_NUDGE_KIND,
      target: sent.target,
      message_id: sent.messageId,
      ok: sent.ok,
      error: sent.error,
    });
    const { error } = await db
      .from("tt_tasks")
      .update({ review_nudge_at: nextReviewNudge(now), review_nudges: task.review_nudges + 1 })
      .eq("id", task.id)
      .eq("review_state", "pending");
    if (error) summary.errors.push(`review nudge ${task.id}: ${error.message}`);
    if (caughtRateLimit(sent.error)) return;
  }
}

/**
 * Tell each person a task was taken from that it is no longer on them — once,
 * from the giver's bot — so the reminders that stop and the card that leaves
 * their board are never a mystery. `handoffDecision` says who is told; the
 * rest are settled quietly. The DM's id is kept: a "done" sent in reply is
 * answered "isn't on you any more".
 */
async function tellHandoffs(
  db: SupabaseClient,
  summary: TickSummary,
  deadline: number,
  connection: ConnectionRow,
  profile: ProfileRow,
  botToken: string,
) {
  const { data } = await db
    .from("tt_task_handoffs")
    .select("*, task:tt_tasks(assignee_discord_id, status)")
    .eq("user_id", connection.user_id)
    .is("told_at", null)
    .order("moved_at", { ascending: true })
    .limit(20);

  type Owed = TaskHandoff & { task: Pick<Task, "assignee_discord_id" | "status"> | null };
  for (const handoff of (data ?? []) as Owed[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }
    let rateLimited = false;
    if (handoffDecision(handoff, profile.discord_user_id, handoff.task) === "dm") {
      const text = handoffNotice(
        handoff.task_title,
        profile.discord_username,
        handoff.to_discord_id ? (handoff.to_name ?? "someone else") : null,
      );
      const sent = await send(summary, { id: handoff.task_id }, () => sendDm(botToken, handoff.from_discord_id, text));
      await db.from("tt_alerts").insert({
        user_id: connection.user_id,
        task_id: handoff.task_id,
        kind: HANDOFF_ALERT_KIND,
        target: sent.target,
        message_id: sent.messageId,
        ok: sent.ok,
        error: sent.error,
      });
      rateLimited = caughtRateLimit(sent.error);
    }
    const { error } = await db.from("tt_task_handoffs").update({ told_at: new Date().toISOString() }).eq("id", handoff.id);
    if (error) summary.errors.push(`handoff ${handoff.id}: ${error.message}`);
    if (rateLimited) return;
  }
}

/**
 * What the giver is owed about the assignee's reminders: a stop or resume made
 * inside the quiet window, sent once it has passed — if the reminders still
 * stand differently from what the giver was last told (`settleToggleNotice`).
 * Lucky35, 2026-10-03: a stop then a resume used to tell nobody, and the giver
 * believed the reminders were still off.
 */
async function tellOwedToggles(db: SupabaseClient, summary: TickSummary, deadline: number, connection: ConnectionRow) {
  const { data } = await db
    .from("tt_tasks")
    .select("*")
    .eq("user_id", connection.user_id)
    .eq("assignee_mute_notice_due", true)
    .lte("assignee_mute_told_at", new Date(Date.now() - TOGGLE_QUIET_MS).toISOString())
    .limit(20);
  for (const task of (data ?? []) as Task[]) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      return;
    }
    await settleToggleNotice(db, task);
  }
}
