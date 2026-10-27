#!/usr/bin/env node
import { randomBytes } from "node:crypto";

/**
 * Prints an APP_ENCRYPTION_KEY. 32 random bytes, base64 — the size AES-256
 * wants, so `lib/crypto.ts` refuses anything else.
 *
 * Generate once per deployment and keep it. Changing it does not migrate the
 * stored credentials, it makes them unreadable, and every user has to paste
 * their Discord token and Anthropic key again.
 */

const key = randomBytes(32).toString("base64");

console.log(`APP_ENCRYPTION_KEY=${key}`);
console.log("");
console.log("Local:  paste that line into .env.local");
console.log("Vercel: Project Settings -> Environment Variables, all three environments");
