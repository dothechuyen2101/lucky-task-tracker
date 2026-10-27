"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, ExternalLink, History, RotateCw } from "lucide-react";

import { CLASSIFY_MODELS, modelsFor } from "@/lib/claude";
import { detectBrowserTimeZone } from "@/lib/deadlines";
import {
  DEVELOPER_PORTAL_URL,
  NEW_APPLICATION_URL,
  botInviteUrl,
  serverListState,
  botProfileUrl,
  botTabUrl,
  guildIconUrl,
} from "@/lib/discord-links";
import { ProjectChannels } from "@/components/project-channels";
import { formatWhen } from "@/lib/board";
import { dateToSnowflake } from "@/lib/snowflake";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Channel, ConnectionStatus, Guild, Profile, ProjectCategories } from "@/lib/types/database";

type Props = {
  profile: Profile;
  connections: ConnectionStatus | null;
  channels: Channel[];
  guilds: Guild[];
  /** The "Active projects" / "Done projects" categories, per server. */
  projectCategories: ProjectCategories[];
  /** The origin this page was requested on, read by the server from the request. */
  origin: string;
  /** When the server rendered this page — "now" for anything that compares a time, so both sides agree. */
  renderedAt: string;
};

/**
 * Everything a user has to hook up themselves: their own Discord bot, their own
 * Anthropic key, and which channels get read.
 *
 * Both credentials are write-only from here. They go out over POST and never
 * come back — the page only ever learns the bot's name and the key's last four
 * characters, because that is all `tt_connection_status` exposes.
 */
/** The "go here" pill at the end of a numbered step. */
function StepLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="step-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink />
    </a>
  );
}

/**
 * A shell command with a one-click copy. Non-technical users mis-select
 * commands by hand constantly — a partial paste fails in a way that looks like
 * the tool is broken rather than like a typo, so the button is the control and
 * the text is just there to be seen.
 */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="copyline">
      <code>{text}</code>
      <button className="btn btn-sm" onClick={copy} type="button">
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/**
 * The IANA time-zone catalogue, read out of whichever runtime is asking.
 *
 * The server that renders this page is Node and the thing that hydrates it is a
 * browser; their `Intl` tables are not guaranteed to be the same length, and
 * hundreds of `<option>`s that differ is a hydration mismatch. `useSyncExternal-
 * Store` is the hook whose whole job is a value that legitimately differs
 * between the two: the server pass gets the empty list (so the select renders
 * only the stored zone and UTC, which are always right), and the browser gets
 * the full catalogue immediately after hydration. Deliberately NOT a
 * `useEffect` + `setState`, which is the cascading-render pattern the repo's
 * lint rules reject.
 *
 * Both snapshots must be REFERENTIALLY stable or the hook re-renders forever,
 * hence the module-level cache and the frozen empty array.
 */
const SERVER_ZONES: string[] = [];
let cachedBrowserZones: string[] | null = null;

const subscribeToNothing = () => () => {};
const serverZones = () => SERVER_ZONES;

function browserZones(): string[] {
  if (!cachedBrowserZones) {
    // `supportedValuesOf` is ES2022 and typed here (tsconfig `lib` has esnext),
    // but an older browser still answers `undefined` at runtime.
    const supported = Intl.supportedValuesOf?.("timeZone") ?? [];
    cachedBrowserZones = supported.length > 0 ? supported : [detectBrowserTimeZone()];
  }
  return cachedBrowserZones;
}

export function SettingsForm({ profile, connections, channels, guilds, projectCategories, origin, renderedAt }: Props) {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  // Whether "Your servers" can be trusted: it is read with the person's own
  // Discord sign-in, which runs out after about a week (2026-10-16).
  const serverList = serverListState(
    {
      linked: connections?.discord_user_linked ?? false,
      tokenExpires: connections?.discord_user_token_expires ?? null,
      refreshedAt: guilds.map((guild) => guild.refreshed_at),
    },
    new Date(renderedAt),
  );

  const [botToken, setBotToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(connections?.anthropic_model ?? CLASSIFY_MODELS[0].id);
  const [reminderChannel, setReminderChannel] = useState(profile.reminder_channel_id ?? "");
  const [timezone, setTimezone] = useState(profile.timezone || "UTC");

  // The catalogue differs between the two runtimes, so it is read through the
  // one hook that is allowed to answer differently on the server than in the
  // browser. See ZONE_CATALOG above for why this is not a `useEffect`.
  const zoneCatalog = useSyncExternalStore(subscribeToNothing, browserZones, serverZones);

  const timezoneOptions = useMemo(
    () => [...new Set(["UTC", timezone, ...zoneCatalog].filter(Boolean))].sort(),
    [timezone, zoneCatalog],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [localChannels, setLocalChannels] = useState(channels);
  // Follows the server's list after a Refresh (`router.refresh()` in `post`),
  // so new channels — and the categories they sit in — show without a reload.
  const [seenChannels, setSeenChannels] = useState(channels);
  if (seenChannels !== channels) {
    setSeenChannels(channels);
    setLocalChannels(channels);
  }

  async function post(path: string, body: unknown, method = "POST") {
    setBusy(path + method);
    setError(null);
    setNote(null);

    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? `${response.status} ${response.statusText}`);
        return null;
      }
      router.refresh();
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function connectDiscord() {
    const result = await post("/api/connections/discord", { token: botToken.trim() });
    if (result) {
      setBotToken("");
      setNote(`Connected as ${result.bot.username}. Now add it to a server and refresh channels.`);
    }
  }

  async function connectAnthropic() {
    const result = await post("/api/connections/anthropic", { key: apiKey.trim(), model });
    if (result) {
      setApiKey("");
      setNote(
        result.warning ??
          `Connected ${result.hint}. Classification runs on ${result.model}, on your own Claude.`,
      );
    }
  }

  /**
   * Ask Discord which servers this user is in, and which of those their bot
   * has been added to. Uses the user's own sign-in token, so it works before
   * a bot exists — seeing where the tracker *would* go is the point.
   */
  async function refreshGuilds() {
    const result = await post("/api/guilds", undefined);
    if (result) {
      setNote(
        `You are in ${result.total} servers. Your bot is in ${result.with_bot}` +
          (result.invitable > 0 ? `, and you can invite it to ${result.invitable} more.` : "."),
      );
      router.refresh();
    }
  }

  /**
   * Walk history backwards until every watched channel is exhausted. Each call
   * covers a bounded slice so no single request outlives the serverless limit;
   * the loop just keeps asking until the server says there is nothing left.
   */
  async function backfill() {
    setBusy("backfill");
    setError(null);
    setNote("Reading history…");

    let ingested = 0;
    let rounds = 0;
    // A channel that cannot be read is skipped for the rest of this press, not
    // retried on every round — one broken channel used to stop the whole walk.
    const skip: string[] = [];
    const failures: string[] = [];

    try {
      for (;;) {
        const response = await fetch("/api/channels/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skip }),
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          setError(payload.error ?? `${response.status} ${response.statusText}`);
          break;
        }

        if (payload.failed) {
          skip.push(payload.failed.channelId);
          failures.push(`#${payload.failed.channel ?? payload.failed.channelId}: ${payload.failed.error}`);
          setError(`Skipped — ${failures.join(" · ")}`);
        }

        ingested += payload.ingested ?? 0;
        rounds += 1;

        setNote(
          `Reading history… ${ingested} messages found so far` +
            (payload.channel ? `, currently #${payload.channel}` : "") +
            (payload.remaining ? ` — ${payload.remaining} channels to go` : ""),
        );

        if (payload.done) {
          const skipped = failures.length > 0 ? ` ${failures.length} channel(s) could not be read — see below, then press again.` : "";
          setNote(
            (ingested === 0
              ? "Nothing older found. Everything readable in these channels is already tracked."
              : `Done. Found ${ingested} older messages — they will appear as tasks as Claude works through them.`) + skipped,
          );
          break;
        }

        // A stuck server would otherwise spin this forever.
        if (rounds > 200) {
          setNote(`Stopped after ${ingested} messages. Press again to continue.`);
          break;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function refreshChannels() {
    const result = await post("/api/channels/refresh", undefined);
    if (result) {
      const added = (result.added ?? []) as Array<{ guild: string; channel: string }>;
      setNote(
        result.channels === 0
          ? (result.note ?? "No readable channels found.")
          : `Found ${result.channels} channels across ${result.guilds} servers.` +
              (added.length > 0
                ? ` ${added.length} new, now watched: ${added
                    .slice(0, 8)
                    .map((a) => `#${a.channel}`)
                    .join(", ")}${added.length > 8 ? "…" : ""}.`
                : ""),
      );
    }
  }

  /**
   * Switching a channel on seeds its poll cursor at this moment, so tracking
   * starts now instead of back-filling the channel's whole history. Switching
   * it off leaves the cursor alone, so switching it back on resumes rather than
   * replaying — the gap while it was off stays a gap, deliberately.
   */
  async function toggleChannel(channel: Channel) {
    const watching = !channel.watching;
    const patch = watching
      ? {
          watching: true,
          last_message_id: channel.last_message_id ?? dateToSnowflake(new Date()),
          last_error: null,
        }
      : { watching: false };

    setLocalChannels((current) =>
      current.map((c) => (c.id === channel.id ? { ...c, ...patch } : c)),
    );
    setError(null);

    const { error: writeError } = await supabase.from("tt_channels").update(patch).eq("id", channel.id);

    if (writeError) {
      setLocalChannels((current) =>
        current.map((c) => (c.id === channel.id ? { ...c, watching: channel.watching } : c)),
      );
      setError(writeError.message);
    }
  }

  /**
   * Switch every channel in one server on or off at once.
   *
   * A 45-channel server is 45 clicks otherwise, which is the difference between
   * someone trying this and someone giving up. Writes in a single request so a
   * partial failure cannot leave half a server watched.
   */
  async function toggleGuild(guildId: string, watching: boolean) {
    const affected = localChannels.filter((c) => c.guild_id === guildId);
    if (affected.length === 0) return;

    const snapshot = localChannels;
    const now = dateToSnowflake(new Date());

    setLocalChannels((current) =>
      current.map((c) =>
        c.guild_id === guildId
          ? {
              ...c,
              watching,
              last_message_id: watching ? (c.last_message_id ?? now) : c.last_message_id,
              last_error: watching ? null : c.last_error,
            }
          : c,
      ),
    );
    setError(null);
    setBusy(`guild:${guildId}`);

    // Channels already carrying a cursor keep it; only the untouched ones get
    // stamped at now. Two updates rather than one, so an existing cursor is
    // never overwritten and history is never re-read.
    const fresh = affected.filter((c) => !c.last_message_id).map((c) => c.id);
    const existing = affected.filter((c) => c.last_message_id).map((c) => c.id);

    const writes = [];
    if (existing.length > 0) {
      writes.push(
        supabase
          .from("tt_channels")
          .update(watching ? { watching: true, last_error: null } : { watching: false })
          .in("id", existing),
      );
    }
    if (fresh.length > 0) {
      writes.push(
        supabase
          .from("tt_channels")
          .update(
            watching
              ? { watching: true, last_message_id: now, last_error: null }
              : { watching: false },
          )
          .in("id", fresh),
      );
    }

    const results = await Promise.all(writes);
    const failure = results.find((r) => r.error);

    setBusy(null);

    if (failure?.error) {
      setLocalChannels(snapshot);
      setError(failure.error.message);
      return;
    }

    setNote(
      watching
        ? `Watching all ${affected.length} channels in this server.`
        : `Stopped watching ${affected.length} channels.`,
    );
  }

  async function saveReminderChannel(value: string) {
    setReminderChannel(value);
    const { error: writeError } = await supabase
      .from("tt_profiles")
      .update({ reminder_channel_id: value || null })
      .eq("id", profile.id);
    if (writeError) setError(writeError.message);
  }

  /**
   * The deliberate override. The board fills this in from the browser once, and
   * only while it is still the 'UTC' default; choosing one here is the value
   * that sticks, because nothing automatic writes over a non-UTC zone.
   */
  async function saveTimezone(value: string) {
    setTimezone(value);
    const { error: writeError } = await supabase
      .from("tt_profiles")
      .update({ timezone: value })
      .eq("id", profile.id);
    if (writeError) setError(writeError.message);
  }

  const channelsByGuild = useMemo(() => {
    const map = new Map<string, { name: string; channels: Channel[] }>();
    for (const channel of localChannels) {
      const entry = map.get(channel.guild_id) ?? {
        name: channel.guild_name ?? channel.guild_id,
        channels: [],
      };
      entry.channels.push(channel);
      map.set(channel.guild_id, entry);
    }
    return [...map.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [localChannels]);

  // Built from the live origin so the command works on localhost and on the
  // deployed domain without anyone editing a constant. The server reads it off
  // the request and hands it down: read from `window` here, the server printed
  // "curl -fsSL /connect-claude.sh" and the browser a full URL, and React threw
  // the server's page away on every visit (2026-09-30).
  const macCommand = `curl -fsSL ${origin}/connect-claude.sh | bash`;

  // Only offer models this credential can actually reach. A subscription token
  // is refused by Opus and Sonnet and Anthropic reports that as a 429, which is
  // indistinguishable from a real rate limit unless you already know — so the
  // fix is to never offer the choice rather than to explain the error.
  const credentialKind = connections?.anthropic_credential_kind ?? null;
  const availableModels = modelsFor(credentialKind);
  const onSubscription = credentialKind === "oauth";

  const watched = localChannels.filter((c) => c.watching);
  // Channels whose history was read before the bot's role was known there.
  const rescan = watched.filter((c) => c.rescan_reason);
  const discordOn = connections?.discord_connected ?? false;
  const claudeOn = connections?.anthropic_connected ?? false;

  return (
    <main className="main main-narrow">
      <div className="page-head">
        <h1 className="mark">
          Settings
          <span>{profile.discord_username ?? "Your account"}</span>
        </h1>
        <div className="head-actions">
          <Link className="btn btn-sm" href="/">
            <ArrowLeft /> Back to tasks
          </Link>
        </div>
      </div>

      {error ? (
        <div className="notice">
          <strong>That did not work</strong>
          {error}
        </div>
      ) : null}

      {note ? (
        <div className="notice good">
          <strong>Done</strong>
          {note}
        </div>
      ) : null}

      {/* --- 1. Discord --------------------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>Your Discord bot</h2>
          <span className="spacer" />
          <span
            className="status-pill"
            data-on={discordOn}
            data-error={Boolean(connections?.discord_last_error)}
          >
            {discordOn ? (connections?.discord_bot_username ?? "Connected") : "Not connected"}
          </span>
        </div>

        <p className="lede">
          Every person here runs their own bot, on their own Discord application. Nothing is shared:
          your bot only sees the servers you invite it to, and only this account can use its token.
        </p>

        {connections?.discord_last_error ? (
          <div className="notice" style={{ marginTop: 0 }}>
            <strong>Discord reported</strong>
            {connections.discord_last_error}
          </div>
        ) : null}

        {!discordOn ? (
          <ol className="steps">
            <li>
              Create a Discord application. Any name — this one is yours alone.
              <StepLink href={NEW_APPLICATION_URL}>New application</StepLink>
            </li>
            <li>
              Open its <b>Bot</b> tab, hit <b>Reset Token</b>, and copy the token. Discord shows it
              once and never again.
              <StepLink href={DEVELOPER_PORTAL_URL}>Your applications</StepLink>
            </li>
            <li>
              On that same Bot tab, switch on <b>Message Content Intent</b>. Without it the bot can
              see <i>that</i> you posted but not <i>what</i> you wrote, and every task comes out
              blank.
            </li>
            <li>Paste the token below. It is checked against Discord before it is stored.</li>
          </ol>
        ) : (
          <ol className="steps">
            <li>
              Need the token again, or want to rotate it?
              <StepLink href={botTabUrl(connections!.discord_bot_user_id!)}>Bot tab</StepLink>
            </li>
            <li>
              Check <b>Message Content Intent</b> is on if tasks are arriving with empty text.
              <StepLink href={botTabUrl(connections!.discord_bot_user_id!)}>Intents</StepLink>
            </li>
          </ol>
        )}

        <div className="connect-row">
          <input
            className="field field-mono"
            type="password"
            autoComplete="off"
            placeholder={discordOn ? "Paste a new token to replace it…" : "Bot token"}
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={connectDiscord}
            disabled={!botToken.trim() || busy !== null}
          >
            {discordOn ? "Replace token" : "Connect bot"}
          </button>
          {discordOn ? (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => post("/api/connections/discord", undefined, "DELETE")}
              disabled={busy !== null}
            >
              Disconnect
            </button>
          ) : null}
        </div>

        {discordOn && connections?.discord_bot_user_id ? (
          <p className="lede" style={{ margin: "14px 0 0" }}>
            <a
              className="btn btn-sm"
              href={botInviteUrl(connections.discord_bot_user_id)}
              target="_blank"
              rel="noreferrer"
            >
              Invite this bot to a server
            </a>{" "}
            <span style={{ marginLeft: 8 }}>
              It asks to see and read channels, send messages and add reactions — so it can answer
              every tag with ✅ or 👀 — and nothing else. Invited before? Invite it again to add that.
            </span>
          </p>
        ) : null}
      </section>

      {/* --- 2. Claude ---------------------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>Your Claude</h2>
          <span className="spacer" />
          <span
            className="status-pill"
            data-on={claudeOn}
            data-error={Boolean(connections?.anthropic_last_error)}
          >
            {claudeOn ? (connections?.anthropic_key_hint ?? "Connected") : "Not connected"}
          </span>
        </div>

        <p className="lede">
          This runs on the <b>Claude subscription you already pay for</b> — no API key, nothing
          extra to buy. It reads only your own messages, on your own account, and disconnecting
          stops it immediately.
        </p>

        {!claudeOn ? (
          <>
            <ol className="steps">
              <li>
                Download the helper and double-click it. It installs Claude Code if you do not have
                it, then opens your browser to sign in.
                <StepLink href="/connect-claude.cmd">Download for Windows</StepLink>
              </li>
              <li>
                Sign in to Claude in the browser window it opens, and approve. Same login you
                already use.
              </li>
              <li>
                It copies your token to the clipboard for you. Come back here, click the box below
                and press <b>Ctrl+V</b>.
              </li>
              <li>
                Press <b>Connect Claude</b>. It is checked before it is stored, and encrypted after.
              </li>
            </ol>

            <p className="lede" style={{ marginBottom: 12 }}>
              On a Mac? Open Terminal (press <b>⌘ Space</b>, type <i>Terminal</i>, hit Enter), then
              paste this one line and press Enter:
              <br />
              <CopyLine text={macCommand} />
            </p>
          </>
        ) : null}

        {connections?.anthropic_last_error ? (
          <div className="notice" style={{ marginTop: 0 }}>
            <strong>Claude reported</strong>
            {connections.anthropic_last_error}
          </div>
        ) : null}

        <div className="connect-row">
          <input
            className="field field-mono"
            type="password"
            autoComplete="off"
            placeholder={claudeOn ? "Paste a new token to replace it…" : "Paste your token here (Ctrl+V)"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <select
            className="field"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              if (claudeOn && !apiKey.trim()) {
                post("/api/connections/anthropic", { model: event.target.value }, "PATCH");
              }
            }}
          >
            {availableModels.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary btn-sm"
            onClick={connectAnthropic}
            disabled={!apiKey.trim() || busy !== null}
          >
            {claudeOn ? "Replace token" : "Connect Claude"}
          </button>
          {claudeOn ? (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => post("/api/connections/anthropic", undefined, "DELETE")}
              disabled={busy !== null}
            >
              Disconnect
            </button>
          ) : null}
        </div>

        {onSubscription ? (
          <p className="lede" style={{ marginTop: 12 }}>
            Running on your subscription, so <b>Claude Haiku 4.5</b> is the only model available —
            Anthropic refuses Opus and Sonnet on a subscription token and reports it as a rate
            limit, which is why usage never moves. An API key unlocks the others, at a cost.
          </p>
        ) : null}

        <details className="advanced">
          <summary>Prefer to do it by hand, or already have an API key?</summary>
          <p className="lede" style={{ margin: "10px 0 0" }}>
            The helper above just runs <code>claude setup-token</code> for you — install{" "}
            <a href="https://claude.ai/download" target="_blank" rel="noreferrer">
              Claude Code
            </a>{" "}
            and run it yourself if you prefer, then paste the <code>sk-ant-oat…</code> value.
            <br />
            <br />
            A console API key (<code>sk-ant-api…</code>) also works in the same box — this page
            detects which kind you pasted. It bills metered credits rather than your subscription,
            so only use one if you already have it.
          </p>
        </details>
      </section>

      {/* --- 3. Servers ---------------------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>Your servers</h2>
          <span className="spacer" />
          <span className="status-pill" data-on={guilds.some((g) => g.bot_present)}>
            {guilds.filter((g) => g.bot_present).length} of {guilds.length} have your bot
          </span>
        </div>

        <p className="lede">
          Every Discord server you belong to. Your bot can only read the ones it has been added to,
          so anywhere marked <b>not added</b> is invisible to the tracker until you invite it.
          {serverList.asOf ? <> Listed {formatWhen(serverList.asOf, profile.timezone)}.</> : null}
        </p>

        {serverList.signIn !== "ok" ? (
          <div className="notice servers-stale" role="status">
            <strong>
              {serverList.signIn === "expired"
                ? `Your Discord sign-in here ran out on ${formatWhen(serverList.expiredAt, profile.timezone)}`
                : "Your Discord sign-in did not include your servers"}
            </strong>
            {serverList.asOf
              ? `So this list is from ${formatWhen(serverList.asOf, profile.timezone)} and cannot be refreshed`
              : "So your servers cannot be listed"}{" "}
            — a server you joined, or were made owner of, since then is not on it. Sign in again, then press{" "}
            <b>Refresh my servers</b>. Discord&apos;s own invite page, below, is never out of date.
            <form action="/auth/signout" method="post" className="servers-stale-action">
              <input type="hidden" name="next" value="/settings" />
              <button className="btn btn-sm btn-primary" type="submit">
                Sign in again
              </button>
            </form>
          </div>
        ) : null}

        <div className="connect-row" style={{ marginBottom: 16 }}>
          <button className="btn btn-sm" onClick={refreshGuilds} disabled={busy !== null}>
            <RotateCw />
            {busy === "/api/guildsPOST" ? "Asking Discord…" : "Refresh my servers"}
          </button>
          {!discordOn ? (
            <span className="lede" style={{ margin: 0 }}>
              Connect a bot above first, then you can invite it from here.
            </span>
          ) : null}
        </div>

        {guilds.length === 0 ? (
          <p className="empty">
            No servers loaded yet. Press <b>Refresh my servers</b>.
          </p>
        ) : (
          <div className="servers">
            {[...guilds]
              .sort((a, b) => {
                // Somewhere to act sorts above somewhere already done, and both
                // above servers this user cannot add a bot to at all.
                const rank = (g: Guild) => (g.bot_present ? 1 : g.can_invite ? 0 : 2);
                return rank(a) - rank(b) || (a.guild_name ?? "").localeCompare(b.guild_name ?? "");
              })
              .map((guild) => {
                const icon = guildIconUrl(guild.guild_id, guild.icon);
                return (
                  <div className="server" key={guild.id} data-on={guild.bot_present}>
                    {icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="server-icon" src={icon} alt="" />
                    ) : (
                      <span className="server-icon server-icon-blank">
                        {(guild.guild_name ?? "?").slice(0, 1).toUpperCase()}
                      </span>
                    )}

                    <span className="server-name">{guild.guild_name ?? guild.guild_id}</span>

                    {guild.bot_present ? (
                      <span className="server-state on">
                        <Check /> Bot added
                      </span>
                    ) : guild.can_invite && discordOn && connections?.discord_bot_user_id ? (
                      <a
                        className="btn btn-sm btn-primary"
                        href={botInviteUrl(connections.discord_bot_user_id, guild.guild_id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Invite bot
                      </a>
                    ) : (
                      <span
                        className="server-state"
                        title={
                          guild.can_invite
                            ? "Connect your bot first."
                            : "You need Manage Server permission here, so an admin has to add it."
                        }
                      >
                        {guild.can_invite ? "Not added" : "Ask an admin"}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {discordOn && connections?.discord_bot_user_id ? (
          <p className="lede" style={{ margin: "14px 0 0" }}>
            <b>A server missing here?</b>{" "}
            <a href={botInviteUrl(connections.discord_bot_user_id)} target="_blank" rel="noreferrer">
              Invite your bot from Discord&apos;s own list
            </a>{" "}
            — it shows every server you own or manage right now, whatever this page has. It uses the Discord account
            this browser is signed in to: if the server is not there either, check the name at the top of that page.
            Use this link rather than one passed around: it is your own bot, asking for only what it needs.
          </p>
        ) : null}

        <p className="lede" style={{ margin: "14px 0 0" }}>
          After inviting, its channels are found by themselves within a few minutes — or press{" "}
          <b>Refresh from Discord</b> below to pull them in now.
        </p>
      </section>

      {/* --- 4. Channels -------------------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>Channels to watch</h2>
          <span className="spacer" />
          <span className="status-pill" data-on={watched.length > 0}>
            {watched.length} watched
          </span>
        </div>

        <p className="lede">
          Only messages that <b>tag your bot</b> — or the bot&apos;s own role, which Discord offers
          right beside it — are read here: yours, and other people&apos;s that also @-mention you.
          Everything else in the channel is ignored unread. New servers and channels your bot can see
          are found by themselves within five minutes and watched from when they appeared, so a tag
          there is never missed; switch off any you do not want. Switching a channel on by hand starts
          from that moment; use <b>Backfill</b> to go back and pick up what was said before. Threads,
          forum posts and voice-channel chat are not read. Direct messages between two people can
          never be read by any bot.
        </p>

        {/* History read before the bot's role in its server was known passed
            over every tag of that role. Say so, by channel, and point at the
            button that fixes it — never leave the history quietly incomplete
            (Lucky35, 2026-09-29). */}
        {rescan.length > 0 ? (
          <div className="notice" style={{ marginBottom: 16 }}>
            <strong>History to read again</strong>
            <p style={{ margin: 0 }}>
              {rescan.map((c) => `#${c.channel_name ?? c.channel_id}`).join(", ")}{" "}
              {rescan.length === 1 ? "was" : "were"} read before the bot&apos;s role in{" "}
              {rescan.length === 1 ? "its server" : "their servers"} was known, so messages that tagged
              the role there were passed over. Press <b>Backfill past tasks</b> to read{" "}
              {rescan.length === 1 ? "it" : "them"} again — nothing already filed is filed twice.
            </p>
          </div>
        ) : null}

        <div className="connect-row" style={{ marginBottom: 16 }}>
          <button
            className="btn btn-sm"
            onClick={refreshChannels}
            disabled={!discordOn || busy !== null}
          >
            <RotateCw /> {busy?.startsWith("/api/channels") ? "Asking Discord…" : "Refresh from Discord"}
          </button>
          <button
            className="btn btn-sm"
            onClick={backfill}
            disabled={!discordOn || watched.length === 0 || busy !== null}
            title={
              watched.length === 0
                ? "Switch on a channel first."
                : "Read what was said before you switched these channels on."
            }
          >
            <History /> {busy === "backfill" ? "Reading history…" : "Backfill past tasks"}
          </button>
          {!discordOn ? <span className="lede" style={{ margin: 0 }}>Connect a bot first.</span> : null}
        </div>

        {channelsByGuild.length === 0 ? (
          <p className="empty">
            No channels yet. Invite your bot to a server, then hit refresh.
          </p>
        ) : (
          channelsByGuild.map(([guildId, guild]) => (
            <div className="guild" key={guildId}>
              <div className="guild-head">
                <span className="guild-name">{guild.name}</span>
                <span className="guild-count">
                  {guild.channels.filter((c) => c.watching).length}/{guild.channels.length}
                </span>
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    toggleGuild(guildId, !guild.channels.every((c) => c.watching))
                  }
                >
                  {guild.channels.every((c) => c.watching) ? "Clear all" : "Select all"}
                </button>
              </div>
              <div className="channels">
                {guild.channels.map((channel) => (
                  <button
                    key={channel.id}
                    className="chan"
                    data-on={channel.watching}
                    data-error={Boolean(channel.last_error)}
                    title={channel.last_error ?? undefined}
                    onClick={() => toggleChannel(channel)}
                  >
                    {channel.watching ? (
                      <Check style={{ width: 12, height: 12 }} />
                    ) : (
                      <span className="chan-hash">#</span>
                    )}
                    {channel.channel_name ?? channel.channel_id}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      {/* --- Project channels --------------------------------------------- */}
      <ProjectChannels
        channels={localChannels}
        categories={projectCategories}
        botUserId={connections?.discord_bot_user_id ?? null}
        discordOn={discordOn}
        onMoved={(channelId, parentId, parentName) =>
          setLocalChannels((current) =>
            current.map((c) => (c.channel_id === channelId ? { ...c, parent_id: parentId, parent_name: parentName } : c)),
          )
        }
      />

      {/* --- Direct messages ----------------------------------------------- */}
      {/* Lucky35, 2026-10-02: work is handed out in private messages too. A bot
          can never read a DM between two people — but it reads DMs sent to
          IT, from its owner and the people they give work to. */}
      <section className="panel">
        <div className="panel-head">
          <h2>Direct messages to your bot</h2>
        </div>
        <p className="lede">
          You can give tasks in a private message to your bot, as you would in a channel — no need to tag it:{" "}
          <code>@minh redo the thumbnail, 36 hours</code>. Discord&apos;s @ list offers nobody else in a DM, so type the
          name. It is given straight away only when the name is exactly one person you have given work to; otherwise
          the bot lists who it might be — people you know, members of your servers — and nobody gets it until you
          reply with the number (or pick on the board). Reply to its message about a task with <code>done</code>,{" "}
          <code>deadline friday 5pm</code> or <code>remind me daily</code>; ask <code>what&apos;s open?</code> for your
          list.
        </p>
        <p className="lede" style={{ margin: "10px 0 0" }}>
          The people you give work to are DMed about it, and can answer the same bot: reply <code>done</code> or{" "}
          <code>stop</code>, or ask <code>my tasks</code>. A request they send it reaches your board only after they
          reply <code>yes</code> to the bot&apos;s &ldquo;send this as a task?&rdquo;; small talk goes nowhere. Everything on
          them, from everyone, is on their <b>My tasks</b> page when they sign in here.
        </p>
        {connections?.discord_bot_user_id ? (
          <p className="lede" style={{ margin: "10px 0 0" }}>
            <a href={botProfileUrl(connections.discord_bot_user_id)} target="_blank" rel="noreferrer">
              Open your bot&apos;s profile
            </a>{" "}
            and press <b>Message</b>. Discord only allows it when you share a server with the bot.
          </p>
        ) : null}
      </section>

      {/* --- 4. Where reminders go ---------------------------------------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>Where reminders arrive</h2>
        </div>

        <p className="lede">
          By default your bot sends you a direct message. If Discord refuses that — some privacy
          settings block DMs from bots — pick a channel instead and reminders go there.
        </p>

        <select
          className="field"
          style={{ minWidth: 280 }}
          value={reminderChannel}
          onChange={(event) => saveReminderChannel(event.target.value)}
        >
          <option value="">Direct message (default)</option>
          {localChannels.map((channel) => (
            <option key={channel.id} value={channel.channel_id}>
              {channel.guild_name} · #{channel.channel_name}
            </option>
          ))}
        </select>

        <p className="sub-title" style={{ margin: "22px 0 10px" }}>
          Your time zone
        </p>

        <p className="lede" style={{ margin: "0 0 10px" }}>
          Used to read &ldquo;Tuesday&rdquo; and &ldquo;tonight&rdquo; out of your messages.
        </p>

        <select
          className="field"
          style={{ minWidth: 280 }}
          aria-label="Your time zone"
          value={timezone}
          onChange={(event) => saveTimezone(event.target.value)}
        >
          {timezoneOptions.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </section>
    </main>
  );
}
