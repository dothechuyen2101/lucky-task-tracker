import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The secret box.
 *
 * Two things go in it: each user's Discord bot token and each user's Anthropic
 * API key. Both are bearer credentials for accounts this app does not own, so
 * a database dump must not be enough to use them. AES-256-GCM, one random IV
 * per seal, authentication tag stored alongside.
 *
 * Key: APP_ENCRYPTION_KEY, 32 random bytes, base64. `pnpm keygen` prints one.
 * Rotating it does not migrate anything — every stored credential becomes
 * undecryptable and each user has to paste theirs again. That is deliberate:
 * a silent re-encrypt would need the old key, which is exactly the thing you
 * are rotating away from.
 */

const FORMAT = "v1";

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("APP_ENCRYPTION_KEY is not set. Generate one with `pnpm keygen`.");
  }

  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to 32 bytes, got ${bytes.length}. Generate one with \`pnpm keygen\`.`,
    );
  }
  return bytes;
}

export function isEncryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** Seal a secret. Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Open a sealed secret. Throws if the key is wrong or the payload was edited. */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new Error("Sealed value is not in the expected format.");
  }

  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Open without throwing. The worker runs across every user in one pass; one
 * user's unreadable credential must not take the whole tick down with it.
 */
export function tryOpen(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  try {
    return open(sealed);
  } catch {
    return null;
  }
}

/** Last four characters, for showing which key is stored without showing it. */
export function hint(secret: string): string {
  return secret.length <= 4 ? "****" : `…${secret.slice(-4)}`;
}

/**
 * Constant-time compare for the cron secret. `===` on a shared secret leaks its
 * prefix through timing, and this endpoint is public by necessity.
 */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
