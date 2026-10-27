import { describe, expect, it } from "vitest";

import {
  amountOf,
  canCorrect,
  correctionsOf,
  csvCell,
  entriesOfSign,
  lateLine,
  csvFileName,
  formatPoints,
  historyCsv,
  parseDay,
  parsePeriod,
  periodLabel,
  periodRange,
  reasonLabel,
  scoreBy,
  shiftPeriod,
  tallyFor,
  todayIn,
  totalsCsv,
  totalsFor,
} from "./score-history";
import type { ScoreEntry } from "./types/database";

const HCM = "Asia/Ho_Chi_Minh";
const LUKA = "219473743288729600";
const MINH = "222222222222222222";
const BAO = "333333333333333333";

let seq = 0;
function entry(overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  seq += 1;
  const id = overrides.id ?? `e${seq}`;
  return {
    id,
    seq,
    root_id: overrides.corrects ? "root" : id,
    corrects: null,
    user_id: "user-1",
    person_discord_id: MINH,
    person_name: "Minh",
    amount: "-1.0",
    reason: "approved_late",
    correction_cause: null,
    note: null,
    task_ids: ["t1"],
    task_titles: ["Cut the trailer"],
    review_ids: ["r1"],
    miss_id: null,
    decided_at: "2026-10-08T03:00:00.000Z",
    decided_by_discord_id: LUKA,
    decided_by_name: "Luka",
    recorded_at: "2026-10-08T03:00:00.000Z",
    backfilled: false,
    ...overrides,
  };
}

describe("amounts", () => {
  it("reads Postgres numeric strings and numbers alike", () => {
    expect(amountOf({ amount: "-1.0" })).toBe(-1);
    expect(amountOf({ amount: "0.5" })).toBe(0.5);
    expect(amountOf({ amount: 1 })).toBe(1);
    expect(amountOf({ amount: "nonsense" })).toBe(0);
  });

  it("writes a real minus sign, a plus, and a plain 0", () => {
    expect(formatPoints(-1)).toBe("−1");
    expect(formatPoints(0.5)).toBe("+0.5");
    expect(formatPoints(0)).toBe("0");
    expect(Object.is(tallyFor([entry({ amount: -1 }), entry({ amount: 1 })], MINH).score, 0)).toBe(true);
  });
});

describe("periods are the viewer's own", () => {
  it("a day runs midnight to midnight in Ho Chi Minh City (UTC+7)", () => {
    expect(periodRange({ kind: "day", day: "2026-10-09" }, HCM)).toEqual({
      start: "2026-10-08T17:00:00.000Z",
      end: "2026-10-09T17:00:00.000Z",
    });
  });

  it("a week runs Monday to Sunday, whichever day names it", () => {
    // 2026-10-09 is a Friday; its week began Monday the 5th.
    const range = periodRange({ kind: "week", day: "2026-10-09" }, HCM);
    expect(range).toEqual({ start: "2026-10-04T17:00:00.000Z", end: "2026-10-11T17:00:00.000Z" });
    expect(periodRange({ kind: "week", day: "2026-10-05" }, HCM)).toEqual(range);
    expect(periodRange({ kind: "week", day: "2026-10-11" }, HCM)).toEqual(range);
  });

  it("a month runs from the 1st to the 1st", () => {
    expect(periodRange({ kind: "month", day: "2026-10-31" }, HCM)).toEqual({
      start: "2026-09-30T17:00:00.000Z",
      end: "2026-10-31T17:00:00.000Z",
    });
  });

  it("steps back and forward across months and years", () => {
    expect(shiftPeriod({ kind: "day", day: "2026-11-01" }, -1)).toEqual({ kind: "day", day: "2026-10-31" });
    expect(shiftPeriod({ kind: "week", day: "2026-10-09" }, 1)).toEqual({ kind: "week", day: "2026-10-12" });
    expect(shiftPeriod({ kind: "month", day: "2026-12-15" }, 1)).toEqual({ kind: "month", day: "2027-01-01" });
    expect(shiftPeriod({ kind: "month", day: "2026-03-31" }, -1)).toEqual({ kind: "month", day: "2026-02-01" });
  });

  it("names each period in words, never through toLocaleString", () => {
    expect(periodLabel({ kind: "day", day: "2026-10-09" })).toBe("Fri 9 Oct 2026");
    expect(periodLabel({ kind: "week", day: "2026-10-09" })).toBe("5 – 11 Oct 2026");
    expect(periodLabel({ kind: "week", day: "2026-09-30" })).toBe("28 Sep – 4 Oct 2026");
    expect(periodLabel({ kind: "week", day: "2026-12-30" })).toBe("28 Dec 2026 – 3 Jan 2027");
    expect(periodLabel({ kind: "month", day: "2026-10-09" })).toBe("October 2026");
  });

  it("reads the address bar defensively: a month, today, by default", () => {
    const now = new Date("2026-10-08T18:30:00.000Z"); // already the 9th in HCM
    expect(todayIn(now, HCM)).toBe("2026-10-09");
    expect(parsePeriod(null, null, now, HCM)).toEqual({ kind: "month", day: "2026-10-09" });
    expect(parsePeriod("week", "2026-02-30", now, HCM)).toEqual({ kind: "week", day: "2026-10-09" });
    expect(parsePeriod("year", "2026-10-01", now, HCM)).toEqual({ kind: "month", day: "2026-10-01" });
    expect(parseDay("2026-13-01")).toBeNull();
  });
});

describe("what each entry says", () => {
  it("names the reason, and a correction's cause", () => {
    expect(reasonLabel(entry({ reason: "approved_late" }))).toBe("Approved late");
    expect(reasonLabel(entry({ reason: "on_time_bonus" }))).toBe("5 tasks approved on time");
    expect(reasonLabel(entry({ reason: "correction", correction_cause: "by_hand" }))).toBe("Correction — corrected by hand");
    expect(reasonLabel(entry({ reason: "correction", correction_cause: "bonus_member_lost" }))).toBe(
      "Correction — one of the five no longer counts",
    );
  });

  it("offers a correction to Lucky35, or whoever decided it — once", () => {
    const original = entry({ id: "o1", decided_by_discord_id: BAO });
    const none = correctionsOf([original]);
    expect(canCorrect(original, none, { discordId: LUKA, admin: true })).toBe(true);
    expect(canCorrect(original, none, { discordId: BAO, admin: false })).toBe(true);
    expect(canCorrect(original, none, { discordId: MINH, admin: false })).toBe(false);
    const fix = entry({ id: "c1", corrects: "o1", amount: 1, reason: "correction", correction_cause: "by_hand" });
    const corrected = correctionsOf([original, fix]);
    expect(canCorrect(original, corrected, { discordId: LUKA, admin: true })).toBe(false);
    // ... and the correction itself can be corrected, to put the point back.
    expect(canCorrect(fix, corrected, { discordId: LUKA, admin: true })).toBe(true);
  });
});

describe("totals per person", () => {
  // Minh, in October (HCM): −1 on the 2nd, −1 on the 8th, +0.5 on the 8th,
  // and on the 9th the first −1 corrected (+1). Bao: nothing in October.
  const history = [
    entry({ id: "a", decided_at: "2026-10-02T05:00:00.000Z" }),
    entry({ id: "b", decided_at: "2026-10-08T05:00:00.000Z", reason: "disapproved", note: "Footer missing" }),
    entry({ id: "c", decided_at: "2026-10-08T06:00:00.000Z", amount: "0.5", reason: "on_time_bonus", task_ids: ["1", "2", "3", "4", "5"] }),
    entry({ id: "d", decided_at: "2026-10-09T02:00:00.000Z", amount: "1.0", reason: "correction", corrects: "a", correction_cause: "by_hand", note: "approved late by mistake" }),
    entry({ id: "z", decided_at: "2026-09-20T05:00:00.000Z", person_discord_id: BAO, person_name: "Bao" }),
  ];

  it("adds up to the score — the sum of every entry", () => {
    expect(scoreBy(history, MINH)).toBe(-0.5);
    expect(scoreBy(history, BAO)).toBe(-1);
  });

  it("counts minus and plus separately for a month, a week and a day", () => {
    const month = totalsFor(history, periodRange({ kind: "month", day: "2026-10-09" }, HCM), { people: [MINH, BAO] });
    const minh = month.find((t) => t.person === MINH)!;
    expect(minh).toMatchObject({ minus: -2, minusCount: 2, plus: 1.5, plusCount: 2, score: -0.5, scoreToDate: -0.5 });
    expect(minh.entries.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);

    const week = totalsFor(history, periodRange({ kind: "week", day: "2026-10-09" }, HCM), { people: [MINH] })[0];
    expect(week).toMatchObject({ minus: -1, minusCount: 1, plus: 1.5, plusCount: 2, score: 0.5 });

    const day = totalsFor(history, periodRange({ kind: "day", day: "2026-10-08" }, HCM), { people: [MINH] })[0];
    expect(day).toMatchObject({ minus: -1, plus: 0.5, score: -0.5, scoreToDate: -1.5 });
  });

  it("a correction counts in the period it was made, so a closed month never moves", () => {
    const september = totalsFor(history, periodRange({ kind: "month", day: "2026-09-01" }, HCM), { people: [MINH] })[0];
    expect(september.entries).toEqual([]);
    expect(september.score).toBe(0);
  });

  it("gives a line to someone quiet in the period", () => {
    const month = totalsFor(history, periodRange({ kind: "month", day: "2026-10-09" }, HCM), { people: [MINH, BAO] });
    const bao = month.find((t) => t.person === BAO)!;
    expect(bao).toMatchObject({ score: 0, minusCount: 0, plusCount: 0, scoreToDate: -1, name: "Bao" });
  });
});

describe("clicking a minus (Lucky35, 2026-10-18)", () => {
  it("opens exactly the entries the figure counted", () => {
    const list = [
      entry({ amount: "-1.0" }),
      entry({ amount: "0.5", reason: "on_time_bonus" }),
      entry({ amount: "-0.5", reason: "correction", correction_cause: "verdict_undone" }),
      entry({ amount: "1.0", reason: "correction", correction_cause: "verdict_undone" }),
    ];
    const tally = tallyFor(list, MINH);
    expect(entriesOfSign(list, "minus")).toHaveLength(tally.minusCount);
    expect(entriesOfSign(list, "plus")).toHaveLength(tally.plusCount);
    expect(entriesOfSign(list, "minus").map(amountOf)).toEqual([-1, -0.5]);
  });

  it("says what a late one was judged on, in the viewer's zone", () => {
    expect(lateLine("2026-10-10T10:00:00.000Z", "2026-10-12T11:00:00.000Z", HCM)).toBe("due 10 Oct · reported done 12 Oct · 2 days late");
    expect(lateLine("2026-10-10T10:00:00.000Z", "2026-10-10T13:20:00.000Z", HCM)).toBe("due 10 Oct · reported done 10 Oct · 3 h late");
    expect(lateLine("2026-10-10T10:00:00.000Z", "2026-10-10T10:20:00.000Z", HCM)).toBe("due 10 Oct · reported done 10 Oct · under an hour late");
    // A deadline at 23:00 UTC is the next day in Ho Chi Minh City.
    expect(lateLine("2026-10-09T23:00:00.000Z", "2026-10-09T22:00:00.000Z", HCM)).toBe("due 10 Oct · reported done 10 Oct");
  });

  it("a miss from before reviews has no report; nothing to say without a deadline", () => {
    expect(lateLine("2026-10-06T05:00:00.000Z", null, HCM)).toBe("due 6 Oct · missed");
    expect(lateLine(null, "2026-10-06T05:00:00.000Z", HCM)).toBeNull();
  });
});

describe("CSV export", () => {
  const history = [
    entry({ id: "a", decided_at: "2026-10-02T05:00:00.000Z", note: 'Said "done", was not' }),
    entry({ id: "d", decided_at: "2026-10-09T02:00:00.000Z", amount: "1.0", reason: "correction", corrects: "a", correction_cause: "by_hand", note: "=HYPERLINK(evil)" }),
  ];
  const taskUrl = (id: string) => `https://tracker.example/?task=${id}`;

  it("quotes what must be quoted and defuses formulas in text", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a, b")).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-1 cmd")).toBe("'-1 cmd");
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell(null)).toBe("");
  });

  it("writes one line per entry, oldest first, in the viewer's zone, CRLF", () => {
    const csv = historyCsv([...history].reverse(), { timeZone: HCM, taskUrl, corrections: correctionsOf(history) });
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Date (Asia/Ho_Chi_Minh),Person,Discord ID,Points,Reason,Note,Tasks,Task links,Decided by,Corrects entry,Corrected by entry,Entry ID",
    );
    expect(lines[1]).toBe(
      `2026-10-02 12:00,Minh,${MINH},-1,Approved late,"Said ""done"", was not",Cut the trailer,https://tracker.example/?task=t1,Luka,,d,a`,
    );
    expect(lines[2]).toContain(",1,Correction — corrected by hand,'=HYPERLINK(evil),");
    expect(lines[2].endsWith(",a,,d")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("totals match the screen's figures for the same period", () => {
    const period = { kind: "month" as const, day: "2026-10-09" };
    const totals = totalsFor(history, periodRange(period, HCM), { people: [MINH] });
    const lines = totalsCsv(totals, period, HCM).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Person,Discord ID,Period,From (Asia/Ho_Chi_Minh),To (Asia/Ho_Chi_Minh),Minus entries,Minus points,Plus entries,Plus points,Net,Score to date",
    );
    expect(lines[1]).toBe(`Minh,${MINH},October 2026,2026-10-01,2026-10-31,1,-1,1,1,0,0`);
  });

  it("names the file safely, Vietnamese names included", () => {
    expect(csvFileName("history", "Đặng Minh", { kind: "month", day: "2026-10-09" })).toBe("score-history-dang-minh-2026-10.csv");
    expect(csvFileName("totals", "", { kind: "week", day: "2026-10-09" })).toBe("score-totals-everyone-week-2026-10-05.csv");
  });
});
