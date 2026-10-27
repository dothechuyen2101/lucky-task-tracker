/**
 * Per-project colour coding.
 *
 * Every project carries its own colour so a row is identifiable at a glance
 * without reading its name. These are picked to stay legible as a 2px rail and
 * as a text chip on the deep aurora ground, and to stay distinct from the
 * violet interface accent (which is never data — see DESIGN.md).
 */
export const PROJECT_COLORS = [
  "#7C5CFF", // violet
  "#22D3EE", // cyan
  "#34D399", // green
  "#FBBF24", // amber
  "#FB7185", // rose
  "#A78BFA", // lilac
  "#38BDF8", // sky
  "#4ADE80", // lime
  "#F97316", // orange
  "#F472B6", // pink
  "#2DD4BF", // teal
  "#818CF8", // indigo
  "#FACC15", // yellow
  "#E879F9", // fuchsia
  "#60A5FA", // blue
  "#C084FC", // purple
] as const;

/**
 * Deterministic colour for a project, so a project seeded by a routine and a
 * project typed in by hand get a stable colour without anyone choosing one.
 */
export function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}
