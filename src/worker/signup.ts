// Beta-signup fanout: the owner hears about every prospect three ways —
// bell notification, web push, and (when the NOTIFY email binding is
// configured) an email via Cloudflare Email Routing.
import type { Env, UserRow } from "./types";
import { setNotification } from "./db";
import { pushToUser } from "./push";

interface Prospect {
  email: string;
  name: string | null;
  note: string | null;
  wantsBetaCall: boolean;
}

const BOOKING_URL = "https://calendar.app.google/Qx1fw2wu89dJkZSw5";

function welcomeText(p: Prospect): string {
  return [
    `Hi ${p.name?.split(" ")[0] ?? "there"},`,
    "",
    "Thanks for signing up for the Todo Log beta! I'd love to have a quick chat to understand what you want to get out of Todo Log and to get you started!",
    "",
    "Please book a time for us to chat here:",
    BOOKING_URL,
    "",
    "Best,",
    "Joshua",
  ].join("\n");
}

function welcomeHtml(p: Prospect): string {
  const first = p.name?.split(" ")[0] ?? "there";
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:34em">
<p>Hi ${first},</p>
<p>Thanks for signing up for the Todo Log beta! I'd love to have a quick chat to understand what you want to get out of Todo Log and to get you started!</p>
<p>Please book a time for us to chat here:<br>
<a href="${BOOKING_URL}">${BOOKING_URL}</a></p>
<p>Best,<br>Joshua</p>
<p style="margin-top:24px"><img src="https://todolo.gg/email-logo.png" width="120" alt="Todo Log"></p>
</div>`;
}

/** Automated welcome via Cloudflare Email Service. No-op without the binding. */
export async function sendWelcomeEmail(env: Env, p: Prospect): Promise<void> {
  if (!env.EMAIL) return;
  try {
    await env.EMAIL.send({
      to: p.email,
      from: "support@todolo.gg",
      subject: "Todo Log Beta",
      text: welcomeText(p),
      html: welcomeHtml(p),
    });
  } catch (err) {
    console.error("welcome email failed:", err);
  }
}

/** Admin = an allowlisted email (the operator). */
export function isAdmin(env: Env, email: string): boolean {
  return env.ALLOWLIST_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .includes(email.trim().toLowerCase());
}

export async function notifyOwnerOfSignup(env: Env, p: Prospect): Promise<void> {
  // Signups notify ONLY the admin — never other enabled users.
  const users = await env.DB.prepare(`SELECT * FROM users WHERE enabled = 1 ORDER BY id`)
    .all<UserRow>();
  const owner = users.results.find((u) => isAdmin(env, u.email));
  if (!owner) return;

  const title = `Beta signup: ${p.email}`;
  const details = [
    p.name ? `Name: ${p.name}` : null,
    p.note ? `Note: ${p.note}` : null,
    p.wantsBetaCall ? "Up for a beta call." : null,
  ].filter(Boolean);
  const body = details.join("\n") || null;

  await setNotification(env, owner.id, "signup", title, body).catch((err) =>
    console.error("signup: bell notification failed:", err),
  );
  await pushToUser(env, owner.id, { title, body }).catch((err) =>
    console.error("signup: push failed:", err),
  );

  if (!env.EMAIL) return;
  try {
    await env.EMAIL.send({
      to: owner.email,
      from: "support@todolo.gg",
      subject: title,
      text: [
        `New beta signup on todolo.gg`,
        ``,
        `Email: ${p.email}`,
        ...details,
        ``,
        `A welcome email with the booking link was sent automatically.`,
      ].join("\n"),
    });
  } catch (err) {
    console.error("signup: email failed:", err);
  }
}
