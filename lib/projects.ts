/**
 * Project channels, split into two Discord categories — pure, so it is
 * testable.
 *
 * Lucky35, 2026-10-04: the server had one flat list of project channels, and
 * finished projects cluttered the active ones. The tracker keeps two
 * categories per server, "Active projects" and "Done projects", and moves a
 * channel between them when the owner says so in Settings
 * (`/api/channels/project`). Nothing moves on its own: a channel with no open
 * task is not necessarily a finished project.
 *
 * A Discord category holds at most 50 channels, and finished projects only
 * pile up — so a full "Done projects" overflows into "Done projects 2", and so
 * on, rather than failing the move.
 *
 * Imported by a client component: no network, no database.
 */

export type ProjectState = "active" | "done";

export const PROJECT_CATEGORY_NAMES: Record<ProjectState, string> = {
  active: "Active projects",
  done: "Done projects",
};

/** Discord's cap on channels in one category. */
export const CATEGORY_LIMIT = 50;

/** A channel as Discord lists it — only what choosing a category reads. */
export type ListedChannel = { id: string; name: string; type: number; parent_id?: string | null };

const CATEGORY_TYPE = 4;

/**
 * Which of the two a category name is, and its overflow number: "Done
 * projects" is 1, "Done projects 2" is 2. Null for any other name. Case and
 * spacing are forgiven — someone may have retyped it in Discord.
 */
export function categoryNumber(name: string | null | undefined, state: ProjectState): number | null {
  const base = PROJECT_CATEGORY_NAMES[state].toLowerCase();
  const text = (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (text === base) return 1;
  const match = text.startsWith(`${base} `) ? /^(\d+)$/.exec(text.slice(base.length + 1)) : null;
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n >= 2 ? n : null;
}

/**
 * The category a channel should move into for `state`: the one already used
 * while it exists and has room, else the first of that name with room, else
 * one to create — named after the highest of them, plus one.
 */
export function chooseCategory(
  listing: readonly ListedChannel[],
  state: ProjectState,
  storedId: string | null,
): { id: string; name: string } | { create: string } {
  const categories = listing.filter((channel) => channel.type === CATEGORY_TYPE);
  const children = (id: string) => listing.filter((channel) => channel.parent_id === id).length;
  const hasRoom = (id: string) => children(id) < CATEGORY_LIMIT;

  const stored = storedId ? categories.find((category) => category.id === storedId) : undefined;
  if (stored && hasRoom(stored.id)) return { id: stored.id, name: stored.name };

  const named = categories
    .map((category) => ({ category, n: categoryNumber(category.name, state) }))
    .filter((entry): entry is { category: ListedChannel; n: number } => entry.n !== null)
    .sort((a, b) => a.n - b.n);
  const roomy = named.find((entry) => hasRoom(entry.category.id));
  if (roomy) return { id: roomy.category.id, name: roomy.category.name };

  const base = PROJECT_CATEGORY_NAMES[state];
  const highest = named.length > 0 ? named[named.length - 1].n : 0;
  return { create: highest === 0 ? base : `${base} ${highest + 1}` };
}

/**
 * Where a channel stands, from the category it sits in: one of the two — or
 * an overflow of one — or neither.
 */
export function projectStateOf(
  channel: { parent_id: string | null; parent_name: string | null },
  categories: { active_category_id: string | null; done_category_id: string | null } | null,
): ProjectState | null {
  if (channel.parent_id && channel.parent_id === categories?.done_category_id) return "done";
  if (channel.parent_id && channel.parent_id === categories?.active_category_id) return "active";
  if (categoryNumber(channel.parent_name, "done") !== null) return "done";
  if (categoryNumber(channel.parent_name, "active") !== null) return "active";
  return null;
}

/** A server's channels by where they stand, each list in name order. */
export function groupProjectChannels<T extends { parent_id: string | null; parent_name: string | null; channel_name: string | null }>(
  channels: readonly T[],
  categories: { active_category_id: string | null; done_category_id: string | null } | null,
): Record<ProjectState | "other", T[]> {
  const groups: Record<ProjectState | "other", T[]> = { active: [], done: [], other: [] };
  for (const channel of channels) groups[projectStateOf(channel, categories) ?? "other"].push(channel);
  const byName = (a: T, b: T) => (a.channel_name ?? "").localeCompare(b.channel_name ?? "");
  return { active: groups.active.sort(byName), done: groups.done.sort(byName), other: groups.other.sort(byName) };
}
