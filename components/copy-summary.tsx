"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * The month's summary as plain text, onto the clipboard — ready to paste into
 * Discord. The text is written on the server (`summaryText`); this only hands
 * it over and says whether that worked. A refusal (an insecure origin, a
 * browser that says no) is said on the button, never swallowed.
 */
export function CopySummary({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  function copy() {
    // `navigator.clipboard` is undefined outside a secure context, which throws
    // before any promise exists; starting from a resolved one catches that too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setState("copied"),
        () => setState("failed"),
      );
  }

  return (
    <button className="btn btn-sm" type="button" onClick={copy} title="The list as plain text, ready to paste into Discord">
      {state === "copied" ? <Check /> : <Copy />}
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy as text"}
    </button>
  );
}
