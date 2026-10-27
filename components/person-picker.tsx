"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { type MembersAnswer, type PickablePerson, filterPeople, mergePeople } from "@/lib/members";

/**
 * Pick a person: nobody, yourself, someone you have worked with, or anyone in
 * the servers your bot is in (Lucky35's PO, 2026-10-05 — "Given to" offered
 * only people already given something, and Rea was not among them).
 *
 * Opens in place, under the field, rather than floating: the task detail is a
 * column that scrolls inside itself, and a popover there is clipped. Members
 * are read once per page load (`/api/members`) and shared by every picker —
 * per bot: a Developers list the viewer keeps for someone else is picked from
 * that owner's servers (`membersOf`).
 * When the bot may not list members (Server Members Intent off), typed names
 * are looked up instead, and the panel says how to switch the intent on.
 */

/** Everyone, per whose bot it was read with ("" is the viewer's own). */
const everyone = new Map<string, Promise<MembersAnswer>>();

/** `/api/members`, with the owner whose bot to use when it is not the viewer's. */
function membersUrl(owner: string, query?: string): string {
  const params = new URLSearchParams();
  if (owner) params.set("owner", owner);
  if (query) params.set("q", query);
  const search = params.toString();
  return search ? `/api/members?${search}` : "/api/members";
}

function loadEveryone(owner: string): Promise<MembersAnswer> {
  const known = everyone.get(owner);
  if (known) return known;
  const loading = fetch(membersUrl(owner))
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as MembersAnswer & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    })
    .catch((error: unknown) => {
      // Not cached: the next open tries again.
      everyone.delete(owner);
      throw error;
    });
  everyone.set(owner, loading);
  return loading;
}

type Choice = { id: string; name: string | null; label: string; where: string | null };

type PersonPickerProps = {
  /** The person picked now, by Discord id; "" is nobody. */
  value: string;
  /** What the closed field says. */
  valueLabel: string;
  /** The viewer's Discord id ("" when the account has none) and their name. */
  selfId: string;
  selfName: string | null;
  /** People the viewer has worked with — offered first. */
  known: PickablePerson[];
  allowNobody?: boolean;
  allowSelf?: boolean;
  /** Dashed, like every gap the board shows. */
  missing?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  /** Pick from the servers of this account's bot (a Developers list the viewer keeps for them); the viewer's own when absent. */
  membersOf?: string | null;
  /** `name` is what `assignee_name` stores; `label` is what the list showed ("Rea (@rea031999)"). */
  onPick: (id: string, name: string | null, label: string) => void;
};

export function PersonPicker({
  value,
  valueLabel,
  selfId,
  selfName,
  known,
  allowNobody = false,
  allowSelf = false,
  missing = false,
  disabled = false,
  ariaLabel,
  membersOf = null,
  onPick,
}: PersonPickerProps) {
  const owner = membersOf ?? "";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<MembersAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searched, setSearched] = useState<PickablePerson[]>([]);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);

  // Everyone, the first time the list opens.
  useEffect(() => {
    if (!open || members) return;
    let live = true;
    loadEveryone(owner).then(
      (answer) => {
        if (live) setMembers(answer);
      },
      (error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [open, members, owner]);

  // Names looked up as they are typed, when the bot may not list everyone.
  const needle = query.trim().replace(/^@/, "");
  useEffect(() => {
    if (!open || members?.listing !== "search" || needle.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      fetch(membersUrl(owner, needle))
        .then((response) => (response.ok ? (response.json() as Promise<MembersAnswer>) : { listing: "search" as const, members: [] }))
        .then(
          (answer) => {
            if (live) setSearched(answer.members);
          },
          () => {
            if (live) setSearched([]);
          },
        );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, members, needle, owner]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pool = mergePeople(known, members?.listing === "full" ? members.members : needle.length >= 2 ? searched : []);
  const lowered = needle.toLowerCase();
  const choices: Choice[] = [
    ...(allowNobody && lowered === "" ? [{ id: "", name: null, label: "Nobody yet", where: null }] : []),
    ...(allowSelf && selfId !== "" && (lowered === "" || "me".startsWith(lowered) || (selfName ?? "").toLowerCase().startsWith(lowered))
      ? [{ id: selfId, name: selfName, label: "Me", where: selfName ? `@${selfName}` : null }]
      : []),
    ...filterPeople(
      pool.filter((person) => person.id !== selfId),
      needle,
    )
      .slice(0, 200)
      .map((person) => ({ id: person.id, name: person.name, label: person.label, where: person.where })),
  ];
  const at = Math.min(active, Math.max(0, choices.length - 1));

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function pick(choice: Choice) {
    close();
    if (choice.id !== value) onPick(choice.id, choice.name, choice.label);
  }

  const note =
    loadError !== null
      ? `Could not read your servers' members: ${loadError}`
      : members === null
        ? "Reading everyone in your servers…"
        : members.listing === "no_bot"
          ? "Connect your bot in Settings to pick anyone from your servers."
          : members.listing === "search"
            ? "Type a name to find anyone in your servers. To list everyone, switch on Server Members Intent for your bot (Discord Developer Portal → Bot)."
            : null;

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="field picker-field"
        data-missing={missing}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="picker-value">{valueLabel}</span>
        <ChevronDown aria-hidden="true" />
      </button>

      {open ? (
        <div className="picker-panel">
          <input
            className="field picker-search"
            autoFocus
            value={query}
            placeholder="Find someone…"
            aria-label="Find someone"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(Math.min(at + 1, choices.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(Math.max(at - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (choices[at]) pick(choices[at]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <ul className="picker-list" role="listbox" aria-label={ariaLabel}>
            {choices.map((choice, index) => (
              <li key={choice.id || "nobody"} role="option" aria-selected={choice.id === value}>
                <button
                  type="button"
                  className="picker-option"
                  data-active={index === at}
                  data-current={choice.id === value}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(choice)}
                >
                  <span>{choice.label}</span>
                  {choice.where ? <span className="picker-where">{choice.where}</span> : null}
                </button>
              </li>
            ))}
            {choices.length === 0 ? <li className="picker-empty">Nobody by that name{members?.listing === "search" && needle.length < 2 ? " yet — type a little more" : ""}.</li> : null}
          </ul>
          {note ? <p className="picker-note">{note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
