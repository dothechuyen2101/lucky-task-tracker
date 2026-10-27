/**
 * The people a task can be given to — pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-05: "Given to" offered only the people already given
 * something, so a teammate never handed work before (Rea) could not be picked.
 * It now offers every member of the servers the owner's bot is in
 * (`/api/members`), with the people already worked with first. Imported by
 * client components: no network, no database, no clock.
 */

/** One person the picker offers. `name` is what is stored as `assignee_name`. */
export type PickablePerson = {
  id: string;
  /** Their username — the label `assignee_name` keeps, as a tag would. */
  name: string;
  /** "Rea (@rea031999)" — what the list shows. */
  label: string;
  /** "worked with before", or the server they were found in. */
  where: string | null;
};

/** What `/api/members` answers. */
export type MembersAnswer = {
  /**
   * "full": every member of every server the bot is in. "search": the bot may
   * not list members (Server Members Intent is off), so names are looked up as
   * they are typed. "no_bot": nothing to look in.
   */
  listing: "full" | "search" | "no_bot";
  members: PickablePerson[];
};

function folded(text: string): string {
  // "Đ" is a letter of its own, not a D with a mark: NFD leaves it whole.
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d").trim();
}

/** The name a person goes by, from their label: "Rea (@rea031999)" → "Rea", "@tom" → "tom". */
export function displayNameOf(label: string): string {
  return label.replace(/\s*\(@[^)]*\)\s*$/, "").replace(/^@/, "").trim();
}

/** Everyone once, the first source to name them winning — the people worked with go first. */
export function mergePeople(...lists: ReadonlyArray<readonly PickablePerson[]>): PickablePerson[] {
  const byId = new Map<string, PickablePerson>();
  for (const list of lists) for (const person of list) if (!byId.has(person.id)) byId.set(person.id, person);
  return [...byId.values()];
}

/**
 * The people whose name or label holds what was typed — case and accents
 * aside — those whose name STARTS with it first, then alphabetical. Nothing
 * typed: everyone, alphabetical.
 */
export function filterPeople(people: readonly PickablePerson[], query: string): PickablePerson[] {
  const needle = folded(query.replace(/^@/, ""));
  const scored = people
    .map((person) => {
      const words = [folded(person.label), folded(person.name)];
      const starts = words.some((w) => w.startsWith(needle) || w.split(/[\s(@]+/).some((part) => part.startsWith(needle)));
      const holds = starts || words.some((w) => w.includes(needle));
      return { person, rank: needle === "" ? 0 : starts ? 0 : holds ? 1 : 2 };
    })
    .filter((entry) => entry.rank < 2);
  return scored
    .sort((a, b) => a.rank - b.rank || a.person.label.localeCompare(b.person.label))
    .map((entry) => entry.person);
}
