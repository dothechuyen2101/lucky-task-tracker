import { describe, expect, it } from "vitest";

import {
  PROOF_FILES_MAX,
  isImage,
  pickListText,
  pickNumber,
  proofFromBoard,
  proofFromDiscord,
  proofLines,
  proofPath,
  proofWords,
  urlsIn,
} from "./proof";

const TASK = "7c35a2cc-85a1-4a4e-9759-1c7cf37b6019";

describe("what counts as proof on Discord", () => {
  it("is a file, a link, or words about the work — never a bare 'done'", () => {
    const items = proofFromDiscord({
      content: "<@1556177760500711504> done, final cut here https://drive.google.com/file/d/abc",
      attachments: [{ id: "1", filename: "cut.png", url: "https://cdn.discordapp.com/x/cut.png?ex=1", content_type: "image/png", size: 2048 }],
      words: "final cut here",
    });
    expect(items).toEqual([
      { kind: "file", discord_url: "https://cdn.discordapp.com/x/cut.png?ex=1", file_name: "cut.png", content_type: "image/png", size_bytes: 2048 },
      { kind: "link", body: "https://drive.google.com/file/d/abc" },
      { kind: "text", body: "final cut here" },
    ]);
  });

  it("is nothing when the message only says it is done", () => {
    for (const words of ["done", "Done!", "xong rồi", "đã xong", "finished.", "done bro", "<@1> done"]) {
      expect(proofFromDiscord({ content: `<@1556177760500711504> ${words}`, attachments: [], words })).toEqual([]);
    }
  });

  it("takes a screenshot sent with no words", () => {
    const items = proofFromDiscord({ content: "", attachments: [{ id: "1", filename: "a.jpg", url: "https://cdn/a.jpg" }], words: "" });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("file");
  });

  it("finds links once each, trailing punctuation left off", () => {
    expect(urlsIn("see https://a.com/x. and https://a.com/x, then (https://b.io/y)")).toEqual(["https://a.com/x", "https://b.io/y"]);
    expect(proofWords("done: https://a.com/x")).toBe("");
    expect(proofWords("uploaded both exports to https://a.com/x")).toBe("uploaded both exports to");
  });
});

describe("what counts as proof on the board", () => {
  it("is the words, the links in them, and files uploaded into this task's folder", () => {
    const read = proofFromBoard(
      { text: "Rendered both cuts https://drive/x", files: [{ path: `${TASK}/u1-cut.mp4`, name: "cut.mp4", type: "video/mp4", size: 1000 }] },
      TASK,
    );
    expect(read).toEqual({
      ok: true,
      items: [
        { kind: "file", file_path: `${TASK}/u1-cut.mp4`, file_name: "cut.mp4", content_type: "video/mp4", size_bytes: 1000 },
        { kind: "link", body: "https://drive/x" },
        { kind: "text", body: "Rendered both cuts" },
      ],
    });
  });

  it("is required", () => {
    expect(proofFromBoard({ text: "   ", files: [] }, TASK)).toMatchObject({ ok: false });
    expect(proofFromBoard({}, TASK)).toMatchObject({ ok: false });
  });

  it("refuses a file from anywhere but this task's folder", () => {
    for (const path of [`other-task/u1-x.png`, `${TASK}/../other/x.png`, `${TASK}/a/b.png`, "x.png"]) {
      expect(proofFromBoard({ files: [{ path, name: "x.png" }] }, TASK)).toMatchObject({ ok: false });
    }
    const many = Array.from({ length: PROOF_FILES_MAX + 1 }, (_, i) => ({ path: `${TASK}/u${i}-x.png`, name: "x.png" }));
    expect(proofFromBoard({ files: many }, TASK)).toMatchObject({ ok: false });
  });

  it("files an upload under the task, with a safe name", () => {
    expect(proofPath(TASK, "Bản cuối (v2).mp4", "u1")).toBe(`${TASK}/u1-Ban-cuoi-v2-.mp4`);
    expect(proofPath(TASK, "", "u1")).toBe(`${TASK}/u1-file`);
  });
});

describe("telling and asking", () => {
  it("shows pictures as pictures", () => {
    expect(isImage({ content_type: "image/png", file_name: "x" })).toBe(true);
    expect(isImage({ content_type: null, file_name: "shot.JPG" })).toBe(true);
    expect(isImage({ content_type: "video/mp4", file_name: "cut.mp4" })).toBe(false);
  });

  it("sums the proof up for the reviewer's DM", () => {
    expect(
      proofLines([
        { kind: "file", body: null, file_name: "cut.png" },
        { kind: "link", body: "https://a.com", file_name: null },
        { kind: "text", body: "both exports", file_name: null },
      ]),
    ).toEqual(["📎 cut.png", "🔗 <https://a.com>", "📝 both exports"]);
    expect(proofLines(Array.from({ length: 7 }, () => ({ kind: "text" as const, body: "x", file_name: null })), 5)).toHaveLength(6);
  });

  it("asks which task, and reads the number answered", () => {
    expect(pickListText(["A", "B"])).toBe("Which task is this for? Reply to this message with its number:\n1. A\n2. B");
    expect(pickNumber("2", 3)).toBe(2);
    expect(pickNumber("<@1> #1 please", 3)).toBe(1);
    expect(pickNumber("the second one", 3)).toBeNull();
    expect(pickNumber("7", 3)).toBeNull();
  });
});
