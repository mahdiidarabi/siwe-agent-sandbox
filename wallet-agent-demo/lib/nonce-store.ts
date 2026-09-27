import { randomUUID } from "node:crypto";

// Single-instance, in-memory nonce store: a Map is enough for this demo
// (see README section 2, "single-instance nonce/role store" is a scope
// decision, not an oversight). Production would move this to Redis/KV.

const NONCE_TTL_MS = 5 * 60 * 1000;

const nonces = new Map<string, { expiresAt: number }>();

function sweep(now: number) {
  for (const [nonce, record] of nonces) {
    if (record.expiresAt <= now) nonces.delete(nonce);
  }
}

export function issueNonce(): string {
  const now = Date.now();
  sweep(now);

  // 32 hex chars, well above the 16-char minimum.
  const nonce = randomUUID().replaceAll("-", "");
  nonces.set(nonce, { expiresAt: now + NONCE_TTL_MS });
  return nonce;
}

// Deletes on every call, valid or not: a nonce can only ever be spent once,
// and a failed attempt should not leave it usable for a retry.
export function consumeNonce(nonce: string): boolean {
  const now = Date.now();
  sweep(now);

  const record = nonces.get(nonce);
  nonces.delete(nonce);

  if (!record) return false;
  if (record.expiresAt <= now) return false;
  return true;
}
