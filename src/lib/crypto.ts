/**
 * Encryption at rest for the most sensitive data the system holds: QBO OAuth
 * tokens (§16, §18). AES-256-GCM with a key from APP_ENCRYPTION_KEY (32 bytes,
 * hex or base64). The IV is random per encryption and stored alongside the
 * ciphertext + auth tag as `iv:tag:ciphertext` (all base64).
 *
 * Never log decrypted values; never send them to the frontend.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("APP_ENCRYPTION_KEY is not set — refusing to store secrets unencrypted (§16, §18).");
  }
  // Accept hex (64 chars) or base64.
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes (e.g. `openssl rand -hex 32`).");
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string): string {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext payload");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

/** Redact a secret for safe logging: keep only a short prefix hint. */
export function redact(secret: string | null | undefined): string {
  if (!secret) return "(none)";
  if (secret.length <= 6) return "***";
  return `${secret.slice(0, 3)}…(${secret.length} chars)`;
}
