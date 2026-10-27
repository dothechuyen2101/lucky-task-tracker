"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

import { botInviteUrl } from "@/lib/discord-links";
import { PROJECT_CATEGORY_NAMES, type ProjectState, groupProjectChannels } from "@/lib/projects";
import type { Channel, ProjectCategories } from "@/lib/types/database";

/**
 * Settings' "Project channels": each server's channels, sorted by the
 * category they sit in — Active projects, Done projects, or neither — with one
 * press to move a channel between the two (Lucky35, 2026-10-04: finished
 * project channels cluttered the active list).
 *
 * The move is the user's bot acting in Discord, so it goes to
 * `/api/channels/project`. It needs Manage Channels, which the ordinary invite
 * does not ask for; the invite here does, and a refusal says so with it.
 */

type Props = {
  channels: Channel[];
  categories: ProjectCategories[];
  botUserId: string | null;
  discordOn: boolean;
  /** A channel moved: the form's own list follows, so the watch list stays in step. */
  onMoved: (channelId: string, parentId: string, parentName: string) => void;
};

type Failure = { text: string; invite: string | null };

export function ProjectChannels({ channels, categories, botUserId, discordOn, onMoved }: Props) {
  const [stored, setStored] = useState(categories);
  const [seen, setSeen] = useState(categories);
  if (seen !== categories) {
    setSeen(categories);
    setStored(categories);
  }
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const servers = useMemo(() => {
    const map = new Map<string, { name: string; channels: Channel[] }>();
    for (const channel of channels) {
      const entry = map.get(channel.guild_id) ?? { name: channel.guild_name ?? channel.guild_id, channels: [] };
      entry.channels.push(channel);
      map.set(channel.guild_id, entry);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [channels]);

  async function move(channel: Channel, to: ProjectState) {
    setBusy(channel.channel_id);
    setFailure(null);
    try {
      const response = await fetch("/api/channels/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.channel_id, to }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        invite?: string | null;
        parent_id?: string;
        parent_name?: string;
      };
      if (!response.ok || !payload.parent_id) {
        setFailure({ text: payload.error ?? `${response.status} ${response.statusText}`, invite: payload.invite ?? null });
        return;
      }
      const parentId = payload.parent_id;
      onMoved(channel.channel_id, parentId, payload.parent_name ?? PROJECT_CATEGORY_NAMES[to]);
      setStored((current) => {
        const column = to === "done" ? "done_category_id" : "active_category_id";
        const existing = current.find((row) => row.guild_id === channel.guild_id);
        if (existing) return current.map((row) => (row === existing ? { ...row, [column]: parentId } : row));
        return [
          ...current,
          {
            id: `pending:${channel.guild_id}`,
            user_id: channel.user_id,
            guild_id: channel.guild_id,
            active_category_id: null,
            done_category_id: null,
            updated_at: new Date().toISOString(),
            [column]: parentId,
          },
        ];
      });
    } catch (caught) {
      setFailure({ text: caught instanceof Error ? caught.message : String(caught), invite: null });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Project channels</h2>
      </div>

      <p className="lede">
        Keep finished projects out of the way: your bot moves a channel into <b>{PROJECT_CATEGORY_NAMES.done}</b> in
        your Discord server, or back into <b>{PROJECT_CATEGORY_NAMES.active}</b>. The two categories are made the first
        time you use them. A channel keeps its own permissions wherever it goes, and is still watched if it was. This
        needs <b>Manage Channels</b>, which the ordinary invite does not ask for — use <b>Allow moving channels</b> on
        the server first.
      </p>

      {failure ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Not moved</strong>
          <p style={{ margin: failure.invite ? "0 0 10px" : 0 }}>{failure.text}</p>
          {failure.invite ? (
            <a className="btn btn-sm btn-primary" href={failure.invite} target="_blank" rel="noreferrer">
              <ExternalLink /> Allow moving channels
            </a>
          ) : null}
        </div>
      ) : null}

      {servers.length === 0 ? (
        <p className="empty">No channels yet. Invite your bot to a server, then press Refresh from Discord above.</p>
      ) : (
        servers.map(([guildId, server]) => {
          const groups = groupProjectChannels(server.channels, stored.find((row) => row.guild_id === guildId) ?? null);
          const sorted = groups.active.length + groups.done.length;
          const chip = (channel: Channel, actions: Array<{ to: ProjectState; label: string }>) => (
            <span className="chan project-chan" key={channel.id}>
              <span className="chan-hash">#</span>
              {channel.channel_name ?? channel.channel_id}
              {actions.map((action) => (
                <button
                  key={action.to}
                  className="project-move"
                  disabled={!discordOn || busy !== null}
                  onClick={() => move(channel, action.to)}
                  title={`Move to ${PROJECT_CATEGORY_NAMES[action.to]}`}
                >
                  {busy === channel.channel_id ? "…" : action.label}
                </button>
              ))}
            </span>
          );

          return (
            <div className="guild" key={guildId}>
              <div className="guild-head">
                <span className="guild-name">{server.name}</span>
                <span className="spacer" />
                {botUserId ? (
                  <a
                    className="btn btn-sm"
                    href={botInviteUrl(botUserId, guildId, { manageChannels: true })}
                    target="_blank"
                    rel="noreferrer"
                    title="Invite your bot again, asking for Manage Channels"
                  >
                    <ExternalLink /> Allow moving channels
                  </a>
                ) : null}
              </div>

              <p className="project-group-k">
                {PROJECT_CATEGORY_NAMES.active} <span className="skipped-count">{groups.active.length}</span>
              </p>
              <div className="channels">
                {groups.active.length > 0 ? (
                  groups.active.map((channel) => chip(channel, [{ to: "done", label: "Done →" }]))
                ) : (
                  <span className="lede project-none">None yet.</span>
                )}
              </div>

              <p className="project-group-k">
                {PROJECT_CATEGORY_NAMES.done} <span className="skipped-count">{groups.done.length}</span>
              </p>
              <div className="channels">
                {groups.done.length > 0 ? (
                  groups.done.map((channel) => chip(channel, [{ to: "active", label: "← Active" }]))
                ) : (
                  <span className="lede project-none">None yet.</span>
                )}
              </div>

              {groups.other.length > 0 ? (
                <details className="project-other" open={sorted === 0}>
                  <summary>
                    In neither <span className="skipped-count">{groups.other.length}</span>
                  </summary>
                  <div className="channels">
                    {groups.other.map((channel) =>
                      chip(channel, [
                        { to: "active", label: "Active" },
                        { to: "done", label: "Done" },
                      ]),
                    )}
                  </div>
                </details>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
