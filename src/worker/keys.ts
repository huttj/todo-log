// BYOK vault: per-user provider API keys, AES-GCM encrypted in D1. The
// wrapping key derives from KEY_VAULT_SECRET (falls back to SESSION_SECRET so
// existing deployments work without a new secret). Decrypt happens per
// request — WebCrypto AES-GCM is sub-millisecond, a rounding error next to
// the LLM call it unlocks.
import type { Env } from "./types";
import type { ProviderId } from "./catalog";
import { now } from "./db";

export interface ProviderKeyRow {
  id: number;
  user_id: number;
  provider: string;
  ciphertext: string;
  iv: string;
  tail: string;
  created_at: number;
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function vaultKey(env: Env): Promise<CryptoKey> {
  const secret = env.KEY_VAULT_SECRET ?? env.SESSION_SECRET;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function saveProviderKey(
  env: Env,
  userId: number,
  provider: ProviderId,
  plaintext: string,
): Promise<ProviderKeyRow> {
  const key = await vaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const row = await env.DB.prepare(
    `INSERT INTO provider_keys (user_id, provider, ciphertext, iv, tail, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id, provider) DO UPDATE
       SET ciphertext = ?3, iv = ?4, tail = ?5, created_at = ?6
     RETURNING *`,
  )
    .bind(userId, provider, b64(ciphertext), b64(iv.buffer), plaintext.slice(-4), now())
    .first<ProviderKeyRow>();
  if (!row) throw new Error("key save returned no row");
  return row;
}

/** Decrypted key, or null when the user hasn't added one (or it won't decrypt
 * — e.g. the vault secret rotated; treated as absent, the UI re-prompts). */
export async function getProviderKey(
  env: Env,
  userId: number,
  provider: ProviderId,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM provider_keys WHERE user_id = ? AND provider = ?`,
  )
    .bind(userId, provider)
    .first<ProviderKeyRow>();
  if (!row) return null;
  try {
    const key = await vaultKey(env);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(row.iv) },
      key,
      unb64(row.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch (err) {
    console.error(`keys: decrypt failed for user ${userId} provider ${provider}:`, err);
    return null;
  }
}

export async function deleteProviderKey(env: Env, userId: number, provider: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM provider_keys WHERE user_id = ? AND provider = ?`)
    .bind(userId, provider)
    .run();
}

export async function listProviderKeys(env: Env, userId: number): Promise<ProviderKeyRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM provider_keys WHERE user_id = ?`)
    .bind(userId)
    .all<ProviderKeyRow>();
  return r.results;
}
