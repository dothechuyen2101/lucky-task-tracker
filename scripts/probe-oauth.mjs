#!/usr/bin/env node
/**
 * Does a `claude setup-token` OAuth token work directly against /v1/messages,
 * with no Claude Code binary in the picture?
 *
 * This is the whole architecture question for the "link your Claude account"
 * path. The VO tool (Voice-Over-Automation) answers it by spawning the `claude`
 * CLI, which Vercel cannot do — no binary, ephemeral filesystem, 60s ceiling.
 * If the token works as a plain bearer credential, the CLI is unnecessary and
 * the whole thing fits serverless. If it does not, the classifier has to move
 * to a box that has the binary.
 *
 * Reads CLAUDE_OAUTH_TOKEN from .env.local. Prints nothing sensitive: the token
 * is only ever reported by length and prefix.
 *
 *   pnpm probe:oauth
 */

import { readFileSync } from "node:fs";

const MODEL = process.argv[2] ?? "claude-opus-5";

function fromEnvLocal(name) {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : null;
  } catch {
    return null;
  }
}

const token = process.env.CLAUDE_OAUTH_TOKEN ?? fromEnvLocal("CLAUDE_OAUTH_TOKEN");

if (!token) {
  console.error("CLAUDE_OAUTH_TOKEN is not set in .env.local (or the environment).");
  console.error("Mint one with:  claude setup-token");
  process.exit(1);
}

console.log(`token: ${token.slice(0, 11)}… (${token.length} chars)`);
console.log(`model: ${MODEL}\n`);

const body = {
  model: MODEL,
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
};

/**
 * Three attempts, because the failure mode tells us which scheme the token
 * belongs to:
 *   - Bearer + beta header succeeding means the serverless path is viable.
 *   - Bearer alone succeeding means the beta header is not required here.
 *   - x-api-key succeeding would mean it is really an API key after all.
 */
const attempts = [
  {
    name: "Authorization: Bearer + anthropic-beta: oauth-2025-04-20",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  },
  {
    name: "Authorization: Bearer (no beta header)",
    headers: { authorization: `Bearer ${token}` },
  },
  {
    name: "x-api-key (the scheme the settings page currently uses)",
    headers: { "x-api-key": token },
  },
];

let anyWorked = false;

for (const attempt of attempts) {
  process.stdout.write(`→ ${attempt.name}\n`);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...attempt.headers,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();

    if (response.ok) {
      anyWorked = true;
      let said = "";
      try {
        said = (JSON.parse(text).content ?? []).find((b) => b.type === "text")?.text ?? "";
      } catch {}
      console.log(`   ${response.status} OK — model said: ${JSON.stringify(said.trim())}\n`);
    } else {
      console.log(`   ${response.status} — ${text.slice(0, 260)}\n`);
    }
  } catch (error) {
    console.log(`   network error — ${error.message}\n`);
  }
}

console.log(
  anyWorked
    ? "RESULT: the token authenticates over plain HTTP. No CLI needed; this fits Vercel."
    : "RESULT: no scheme worked. The token is CLI-only, so the classifier needs a box with the binary.",
);
