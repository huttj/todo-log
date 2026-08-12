// Beta-signup fanout: the owner hears about every prospect three ways —
// bell notification, web push, and (when the NOTIFY email binding is
// configured) an email via Cloudflare Email Routing.
import { createMimeMessage } from "mimetext";
import type { Env, UserRow } from "./types";
import { setNotification } from "./db";
import { pushToUser } from "./push";

interface Prospect {
  email: string;
  name: string | null;
  note: string | null;
  wantsBetaCall: boolean;
}

export async function notifyOwnerOfSignup(env: Env, p: Prospect): Promise<void> {
  const owner = await env.DB.prepare(`SELECT * FROM users WHERE enabled = 1 ORDER BY id LIMIT 1`)
    .first<UserRow>();
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

  if (!env.NOTIFY) return;
  try {
    const { EmailMessage } = await import("cloudflare:email");
    const msg = createMimeMessage();
    msg.setSender({ addr: "beta@todolo.gg", name: "Todo Log" });
    msg.setRecipient(owner.email);
    msg.setSubject(title);
    msg.addMessage({
      contentType: "text/plain",
      data: [`New beta signup on todolo.gg`, ``, `Email: ${p.email}`, ...details].join("\n"),
    });
    await env.NOTIFY.send(new EmailMessage("beta@todolo.gg", owner.email, msg.asRaw()));
  } catch (err) {
    console.error("signup: email failed:", err);
  }
}
