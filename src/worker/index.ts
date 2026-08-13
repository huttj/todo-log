import { Hono } from "hono";
import type { Env } from "./types";
import type { AppContext } from "./auth";
import { authStart, authCallback, requireUser } from "./auth";
import { insertProspect } from "./db";
import { crud } from "./crud";
import { capture } from "./capture";
import { runSweep } from "./sweep";
import { notifyOwnerOfSignup, sendWelcomeEmail, isAdmin } from "./signup";
import { support } from "./support";

const app = new Hono<AppContext>();

app.get("/api/health", (c) => c.json({ ok: true }));

// -- Auth -------------------------------------------------------------------
app.get("/api/auth/google", authStart);
app.get("/api/auth/google/callback", authCallback);
app.get("/api/me", requireUser, (c) => {
  const { id, email, name, enabled } = c.get("user");
  return c.json({ id, email, name, enabled: !!enabled, is_admin: isAdmin(c.env, email) });
});
app.post("/api/auth/signout", (c) => {
  c.header("set-cookie", "session=; Path=/; Max-Age=0; HttpOnly");
  return c.json({ ok: true });
});

// -- Waitlist ("beta call" / "notify me") -----------------------------------
app.post("/api/prospects", async (c) => {
  const body = await c.req.json<{
    email?: string;
    name?: string;
    note?: string;
    wantsBetaCall?: boolean;
  }>();
  if (!body.email?.includes("@")) return c.json({ error: "valid email required" }, 400);
  const prospect = {
    email: body.email.trim(),
    name: body.name?.trim() || null,
    note: body.note?.trim() || null,
    wantsBetaCall: !!body.wantsBetaCall,
  };
  const { created } = await insertProspect(c.env, prospect);
  c.executionCtx.waitUntil(notifyOwnerOfSignup(c.env, prospect));
  // First-time signups get the welcome + booking email (resubmits don't).
  if (created) c.executionCtx.waitUntil(sendWelcomeEmail(c.env, prospect));
  return c.json({ ok: true });
});

// -- App data + capture (both gated on allowlist) ---------------------------
app.route("/api", crud);
app.route("/api", capture);
app.route("/api", support);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runSweep(env));
  },
} satisfies ExportedHandler<Env>;
