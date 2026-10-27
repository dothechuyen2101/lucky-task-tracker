"use client";

import { type FormEvent, useState } from "react";
import { MessageCircleQuestion, X } from "lucide-react";

import { ASK_MAX_QUESTION, type AskMatch, dayIn, standing, tally } from "@/lib/ask";

/**
 * "Did I already give someone a task about X?" (Lucky35, 2026-10-12: "I will
 * be giving many tasks to many people, I will forget"). The owner asks in
 * plain words; `/api/tasks/ask` has Claude read every task they have given —
 * open and finished — on their own Anthropic key, and answers with the tasks
 * themselves, each one a way to open it.
 */

type Answer = { answer: string; matches: AskMatch[]; more: number; searched: number };

type Props = {
  zone: string;
  /** Tasks already on the board: these open in place; any other through its link. */
  knownIds: ReadonlySet<string>;
  onOpenTask: (id: string) => void;
  onClose: () => void;
};

export function AskPanel({ zone, knownIds, onOpenTask, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (asking || question.trim().length < 3) return;
    setAsking(true);
    setError(null);
    try {
      const response = await fetch("/api/tasks/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<Answer> & { error?: string };
      if (!response.ok || typeof payload.answer !== "string") {
        setError(payload.error ?? `${response.status} ${response.statusText}`);
        setAnswer(null);
      } else {
        setAnswer({ answer: payload.answer, matches: payload.matches ?? [], more: payload.more ?? 0, searched: payload.searched ?? 0 });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAsking(false);
    }
  }

  return (
    <section className="panel ask-panel" aria-label="Ask about the tasks you gave">
      <div className="ask-head">
        <p className="sub-title">
          <MessageCircleQuestion aria-hidden="true" /> Ask about the tasks you gave
        </p>
        <button className="btn btn-sm" onClick={onClose} aria-label="Close" title="Close">
          <X />
        </button>
      </div>
      <form className="ask-form" onSubmit={ask}>
        <input
          className="field"
          value={question}
          maxLength={ASK_MAX_QUESTION}
          placeholder="Did I give anyone a task about the GPU server?"
          aria-label="Your question"
          onChange={(event) => setQuestion(event.target.value)}
          autoFocus
        />
        <button className="btn btn-sm btn-primary" type="submit" disabled={asking || question.trim().length < 3}>
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>
      <p className="detail-hint">
        Claude reads every task you have given — open and finished — on your own Anthropic key, and matches by meaning,
        not only the exact words.
      </p>
      {error ? <p className="err">{error}</p> : null}
      {answer ? (
        <div className="ask-result" role="status">
          <p className="ask-answer">{answer.answer}</p>
          {answer.matches.length > 0 ? <Figures matches={answer.matches} more={answer.more} /> : null}
          {answer.matches.length > 0 ? (
            <ul className="ask-matches">
              {answer.matches.map(({ task, why }) => (
                <li key={task.id} className="ask-match">
                  <div className="ask-match-title">
                    {knownIds.has(task.id) ? (
                      <button className="tc-name" onClick={() => onOpenTask(task.id)} title="Open this task">
                        {task.title}
                      </button>
                    ) : (
                      <a className="tc-name" href={`/?task=${encodeURIComponent(task.id)}`} title="Open this task">
                        {task.title}
                      </a>
                    )}
                  </div>
                  <p className="ask-match-meta">
                    for {task.assignee_name || "nobody yet"} · {standing(task)} · given {dayIn(task.created_at, zone) ?? "?"}
                    {task.deadline ? ` · due ${dayIn(task.deadline, zone)}` : ""}
                    {task.requested_by_name ? ` · asked by ${task.requested_by_name}` : ""}
                  </p>
                  {why ? <p className="detail-hint">{why}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {answer.more > 0 ? (
            <p className="detail-hint">…and {answer.more} more — ask more narrowly to see them.</p>
          ) : null}
          <p className="detail-hint">Looked through {answer.searched} tasks you gave.</p>
        </div>
      ) : null}
    </section>
  );
}

/** The figures, counted from the tasks shown — the sentence above is Claude's, these are the database's. */
function Figures({ matches, more }: { matches: readonly AskMatch[]; more: number }) {
  const counts = tally(matches);
  const parts = [
    `${matches.length + more} task${matches.length + more === 1 ? "" : "s"}`,
    counts.open ? `${counts.open} open` : null,
    counts.waiting ? `${counts.waiting} waiting for review` : null,
    counts.done ? `${counts.done} done` : null,
    counts.other ? `${counts.other} dismissed or failed` : null,
  ].filter(Boolean);
  return <p className="ask-figures">{parts.join(" · ")}{more > 0 ? " (counted on those shown)" : ""}</p>;
}
