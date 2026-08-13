// Google OAuth (sign-in + Calendar grant in one consent) and HMAC-signed
// session cookies. The OAuth redirect URI is derived from the request origin,
// so the same code serves localhost dev and production.
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, UserRow } from "./types";
import { now, upsertUser, saveGoogleTokens, getUser } from "./db";

export type AppContext = { Bindings: Env; Variables: { user: UserRow } };

const SESSION_TTL = 30 * 86400;
// Basic scopes only: publishing the OAuth app needs no Google review this
// way. Request the (sensitive) calendar scope incrementally if GCal sync
// ever ships.
const OAUTH_SCOPES = ["openid", "email", "profile"].join(" ");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function makeSessionCookie(env: Env, userId: number): Promise<string> {
  const payload = `${userId}.${now() + SESSION_TTL}`;
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

export async function readSessionCookie(env: Env, value: string): Promise<number | null> {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  if ((await hmac(env.SESSION_SECRET, payload)) !== parts[2]) return null;
  if (Number(parts[1]) < now()) return null;
  return Number(parts[0]);
}

function redirectUri(c: Context<AppContext>): string {
  return new URL("/api/auth/google/callback", c.req.url).toString();
}

export function authStart(c: Context<AppContext>) {
  const state = crypto.randomUUID();
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: c.req.url.startsWith("https"),
    sameSite: "Lax",
    maxAge: 600,
    path: "/",
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(c));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token: string;
}

/** Decode a JWT payload without verifying — safe here because the token came
 * straight from Google's token endpoint over TLS, not from the client. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const b64 = jwt.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}

export async function authCallback(c: Context<AppContext>) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || state !== getCookie(c, "oauth_state")) {
    return c.text("invalid oauth state", 400);
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return c.text(`token exchange failed: ${await res.text()}`, 502);
  const tokens = (await res.json()) as TokenResponse;

  const claims = decodeJwtPayload(tokens.id_token);
  const sub = String(claims.sub ?? "");
  const email = String(claims.email ?? "");
  const name = typeof claims.name === "string" ? claims.name : null;
  if (!sub || !email) return c.text("id_token missing sub/email", 502);

  const user = await upsertUser(c.env, { googleSub: sub, email, name });
  await saveGoogleTokens(c.env, user.id, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: now() + tokens.expires_in,
    scopes: tokens.scope ?? null,
  });

  setCookie(c, "session", await makeSessionCookie(c.env, user.id), {
    httpOnly: true,
    secure: c.req.url.startsWith("https"),
    sameSite: "Lax",
    maxAge: SESSION_TTL,
    path: "/",
  });
  return c.redirect("/");
}

async function loadSessionUser(c: Context<AppContext>): Promise<UserRow | null> {
  const cookie = getCookie(c, "session");
  const userId = cookie ? await readSessionCookie(c.env, cookie) : null;
  return userId ? getUser(c.env, userId) : null;
}

/** Load the signed-in user or 401. Does not require `enabled` — waitlisted
 * users still need /api/me to see their state. */
/** A pending deletion means signed out, everywhere: sessions are stateless
 * cookies, so this check is what "signs you out" — and only a fresh Google
 * sign-in (which clears delete_after) gets back in. */
function deletionPending(c: Context<AppContext>, user: { delete_after: number | null }): boolean {
  if (user.delete_after == null) return false;
  c.header("set-cookie", "session=; Path=/; Max-Age=0; HttpOnly");
  return true;
}

export async function requireUser(c: Context<AppContext>, next: Next) {
  const user = await loadSessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (deletionPending(c, user)) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}

/** Gate for app data routes: signed in AND allowlist-enabled. */
export async function requireEnabled(c: Context<AppContext>, next: Next) {
  const user = await loadSessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (deletionPending(c, user)) return c.json({ error: "unauthorized" }, 401);
  if (!user.enabled) return c.json({ error: "not enabled" }, 403);
  c.set("user", user);
  await next();
}
