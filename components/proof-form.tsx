"use client";

import { useRef, useState } from "react";
import { Check, Paperclip, X } from "lucide-react";

import { PROOF_BUCKET, PROOF_FILES_MAX, PROOF_FILE_MAX_BYTES, type UploadedFile } from "@/lib/proof";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Report a task done — with proof, which is required (Lucky35's PO,
 * 2026-10-07): a few words, a link, or files. Files go straight from the
 * browser into the private `task-proofs` bucket, each on a one-time upload the
 * server grants for this task only (`/api/tasks/proof-upload`); the report is
 * sent once they have all landed, and the server checks they did.
 */

export type ProofDraft = { text: string; files: UploadedFile[] };

type ProofFormProps = {
  taskId: string;
  title: string;
  /** Who reviews it, for the line under the button. */
  reviewerName: string | null;
  busy: boolean;
  /** Resolves true when the report went through, so the form can close. */
  onSubmit: (proof: ProofDraft) => Promise<boolean>;
  onCancel: () => void;
};

export function ProofForm({ taskId, title, reviewerName, busy, onSubmit, onCancel }: ProofFormProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const ready = text.trim() !== "" || files.length > 0;

  function add(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (file.size > PROOF_FILE_MAX_BYTES) {
        setError(`${file.name} is larger than 50 MB — share it as a link instead.`);
        continue;
      }
      if (next.length >= PROOF_FILES_MAX) {
        setError(`At most ${PROOF_FILES_MAX} files.`);
        break;
      }
      next.push(file);
    }
    setFiles(next);
  }

  async function upload(file: File): Promise<UploadedFile> {
    const response = await fetch("/api/tasks/proof-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, fileName: file.name, size: file.size }),
    });
    const granted = (await response.json().catch(() => ({}))) as { path?: string; token?: string; error?: string };
    if (!response.ok || !granted.path || !granted.token) throw new Error(granted.error ?? `Upload refused (${response.status}).`);
    const { error: storageError } = await createSupabaseBrowserClient()
      .storage.from(PROOF_BUCKET)
      .uploadToSignedUrl(granted.path, granted.token, file, { contentType: file.type || undefined });
    if (storageError) throw new Error(storageError.message);
    return { path: granted.path, name: file.name, type: file.type || null, size: file.size };
  }

  async function send() {
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      const uploaded: UploadedFile[] = [];
      for (const file of files) uploaded.push(await upload(file));
      const ok = await onSubmit({ text, files: uploaded });
      if (ok) {
        setText("");
        setFiles([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="proof-form" aria-label={`Report ${title} done`}>
      <p className="sub-title">Proof that it is done</p>
      <textarea
        className="note-edit"
        value={text}
        rows={3}
        autoFocus
        maxLength={4000}
        placeholder="What you did, and where it is — a link, a few words…"
        aria-label="Proof — words or a link"
        onChange={(event) => setText(event.target.value)}
      />
      {files.length > 0 ? (
        <ul className="proof-files">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <Paperclip aria-hidden="true" />
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input ref={picker} type="file" multiple hidden onChange={(event) => add(event.target.files)} />
      {error ? <p className="err proof-err">{error}</p> : null}
      <div className="row-actions">
        <button className="btn btn-sm btn-primary" disabled={!ready || busy || sending} onClick={send}>
          <Check /> {sending ? "Sending…" : "Report done"}
        </button>
        <button className="btn btn-sm" type="button" disabled={sending} onClick={() => picker.current?.click()}>
          <Paperclip /> Add files
        </button>
        <button className="btn btn-sm" type="button" disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="detail-hint">
        Required: words, a link or a file (up to 50 MB each). {reviewerName ?? "Whoever gave it to you"} reviews it next — it
        is not done until they approve it.
      </p>
    </section>
  );
}
