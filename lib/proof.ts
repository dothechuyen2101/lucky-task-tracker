/**
 * Proof that work is done — pure, so it is testable.
 *
 * Lucky35's PO, 2026-10-07 (task.md): "done" is not believed without proof.
 * The assignee sends an image, a file, a link or a few words — on the board,
 * or on Discord tagging the bot — and it is kept on the task for good
 * (`tt_task_proofs`), through every round of review.
 *
 * On Discord the bot attaches it to a task in this order: the task the message
 * replies to; the sender's only open task; otherwise it asks which, with a
 * numbered list (`pickListText`, `pickNumber`).
 *
 * Imported by client components: no network, no database, no clock.
 */

import { stripMentions } from "@/lib/relevance";
import type { DiscordAttachment, TaskProof } from "@/lib/types/database";

/** The longest proof text kept. */
export const PROOF_TEXT_MAX = 4000;

/** Files one report may carry. */
export const PROOF_FILES_MAX = 10;

/** The `task-proofs` bucket's own limit (`20261007_01`): 50 MB a file. */
export const PROOF_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** The private bucket board uploads go into. */
export const PROOF_BUCKET = "task-proofs";

/** One piece of proof, before it is stored. */
export type ProofItem = {
  kind: "text" | "link" | "file";
  body?: string | null;
  file_path?: string | null;
  file_name?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  discord_url?: string | null;
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/gi;

/** The links in a piece of text, once each, in order. */
export function urlsIn(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of (text ?? "").matchAll(URL_PATTERN)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Text with its links taken out and its whitespace tidied. */
function withoutLinks(text: string): string {
  return (text ?? "").replace(URL_PATTERN, " ").replace(/<\s*>/g, " ").replace(/\s+/g, " ").trim();
}

function bounded(text: string): string {
  return text.length > PROOF_TEXT_MAX ? `${text.slice(0, PROOF_TEXT_MAX - 1)}…` : text;
}

/**
 * Words that only say it is done — "done", "xong rồi", "finished!" — and are
 * no proof of anything on their own.
 */
const ONLY_DONE = /^(?:(?:it'?s|its|all|is|đã|da|rồi|roi|em|anh|chị|chi|bro|sir|boss|now|ok|okay|oke|yes|yep|xong|done|finished|finish|complete|completed|hoàn thành|hoan thanh|the task|task|this|that|one|here|đây|day)[\s,.!?:;-]*)+$/i;

/** Words that are proof: something said about the work beyond "it is done". */
export function proofWords(text: string | null | undefined): string {
  const words = withoutLinks(stripMentions(text ?? ""));
  if (!/[\p{L}\p{N}]/u.test(words) || ONLY_DONE.test(words)) return "";
  return bounded(words);
}

/**
 * What a Discord message carries as proof: its files, its links, and the words
 * in it. `words` is what describes the work — on a report Claude read, the
 * part it picked out (`readDirectMessage`'s `proof`); on a reply to the bot's
 * "send the proof" question, the whole text, since that was the question.
 */
export function proofFromDiscord({
  content,
  attachments,
  words,
}: {
  content: string;
  attachments: readonly DiscordAttachment[] | null | undefined;
  words: string | null | undefined;
}): ProofItem[] {
  const items: ProofItem[] = [];
  for (const file of (attachments ?? []).slice(0, PROOF_FILES_MAX)) {
    if (!file?.url) continue;
    items.push({
      kind: "file",
      discord_url: file.url,
      file_name: file.filename || "file",
      content_type: file.content_type ?? null,
      size_bytes: typeof file.size === "number" ? file.size : null,
    });
  }
  for (const url of urlsIn(content)) items.push({ kind: "link", body: url });
  const text = proofWords(words);
  if (text) items.push({ kind: "text", body: text });
  return items;
}

/** A file uploaded on the board, as the browser reports it after the upload. */
export type UploadedFile = { path: string; name: string; type?: string | null; size?: number | null };

/**
 * What the board's "Report done" form sent, checked: the words (links in
 * them become links), and files that were uploaded into THIS task's folder
 * (`taskId/…`) — a path anywhere else is refused, so nobody attaches another
 * task's file. Empty is an error: proof is required.
 */
export function proofFromBoard(
  input: { text?: unknown; files?: unknown },
  taskId: string,
): { ok: true; items: ProofItem[] } | { ok: false; error: string } {
  const text = typeof input.text === "string" ? input.text : "";
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length > PROOF_FILES_MAX) return { ok: false, error: `At most ${PROOF_FILES_MAX} files.` };

  const items: ProofItem[] = [];
  for (const raw of files) {
    const file = raw as Partial<UploadedFile> | null;
    const path = typeof file?.path === "string" ? file.path : "";
    if (!path.startsWith(`${taskId}/`) || path.includes("..") || path.split("/").length !== 2) {
      return { ok: false, error: "That file was not uploaded for this task." };
    }
    const size = typeof file?.size === "number" ? file.size : null;
    if (size !== null && size > PROOF_FILE_MAX_BYTES) return { ok: false, error: "A file is larger than 50 MB." };
    items.push({
      kind: "file",
      file_path: path,
      file_name: typeof file?.name === "string" && file.name.trim() ? file.name.trim().slice(0, 200) : "file",
      content_type: typeof file?.type === "string" && file.type ? file.type.slice(0, 120) : null,
      size_bytes: size,
    });
  }
  for (const url of urlsIn(text)) items.push({ kind: "link", body: url });
  const words = withoutLinks(text);
  if (words) items.push({ kind: "text", body: bounded(words) });

  if (items.length === 0) return { ok: false, error: "Add proof first — a few words, a link or a file." };
  return { ok: true, items };
}

/** Where a board upload goes: the task's own folder, a unique, safe name. */
export function proofPath(taskId: string, fileName: string, unique: string): string {
  const base = (fileName || "file")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
  return `${taskId}/${unique}-${base || "file"}`;
}

/** Shown as a picture rather than a file. */
export function isImage(proof: Pick<TaskProof, "content_type" | "file_name">): boolean {
  if (proof.content_type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(proof.file_name ?? "");
}

/** The proof in a few lines, for the reviewer's DM. */
export function proofLines(proofs: ReadonlyArray<Pick<TaskProof, "kind" | "body" | "file_name">>, max = 5): string[] {
  const lines = proofs.slice(0, max).map((proof) => {
    if (proof.kind === "file") return `📎 ${proof.file_name ?? "a file"}`;
    if (proof.kind === "link") return `🔗 <${proof.body ?? ""}>`;
    const text = (proof.body ?? "").replace(/\s+/g, " ");
    return `📝 ${text.length > 200 ? `${text.slice(0, 199)}…` : text}`;
  });
  if (proofs.length > max) lines.push(`…and ${proofs.length - max} more on the board`);
  return lines;
}

/** The bot's question when a report of done came without proof. */
export function proofRequestText(title: string): string {
  return [
    `Before **${title}** goes for review, I need proof that it is done.`,
    "Reply to this message with a screenshot, a file, a link, or a few words on what you did.",
  ].join("\n");
}

/** The bot's question when the sender has several open tasks and did not reply to one. */
export function pickListText(titles: readonly string[]): string {
  return [
    "Which task is this for? Reply to this message with its number:",
    ...titles.map((title, index) => `${index + 1}. ${title}`),
  ].join("\n");
}

/** The number a reply picks from that list (1-based), or null. */
export function pickNumber(content: string, count: number): number | null {
  const match = /(?:^|\s|#)(\d{1,2})(?:\b|$)/.exec(stripMentions(content ?? ""));
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= count ? n : null;
}

/** The reply once proof is attached and the task is up for review. */
export function proofTakenReply(title: string, reviewerName: string | null, items: number): string {
  return `📎 Got it — ${items === 1 ? "1 piece" : `${items} pieces`} of proof on **${title}**. It is waiting for ${reviewerName ?? "the reviewer"}'s review now.`;
}
