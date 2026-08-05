// Cron sweep (Cyborgy pattern): heal untranscribed audio segments, then
// distill pending corrections into each user's learnings doc.
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./types";
import {
  now,
  stuckSegments,
  setSegmentTranscript,
  pendingCorrections,
  markCorrectionsProcessed,
  getLearnings,
  setLearnings,
} from "./db";
import { transcribe } from "./transcribe";

const DISTILL_MODEL = "claude-opus-5";

export async function runSweep(env: Env): Promise<void> {
  await healSegments(env);
  await distillCorrections(env);
}

async function healSegments(env: Env): Promise<void> {
  const stuck = await stuckSegments(env, now() - 60);
  for (const seg of stuck) {
    try {
      const object = await env.MEDIA.get(seg.r2_key);
      if (!object) continue;
      const { text, words } = await transcribe(env, await object.arrayBuffer());
      await setSegmentTranscript(env, seg.id, text, words);
    } catch (err) {
      console.error(`sweep: segment ${seg.id} still failing:`, err);
    }
  }
}

async function distillCorrections(env: Env): Promise<void> {
  const pending = await pendingCorrections(env);
  if (pending.length === 0) return;

  const byUser = new Map<number, { id: number; description: string }[]>();
  for (const p of pending) {
    const list = byUser.get(p.user_id) ?? [];
    list.push(p);
    byUser.set(p.user_id, list);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  for (const [userId, corrections] of byUser) {
    try {
      const current = await getLearnings(env, userId);
      const response = await client.messages.create({
        model: DISTILL_MODEL,
        max_tokens: 4096,
        system:
          "You maintain a concise 'learnings' document for a personal todo/journal agent: durable guidance " +
          "distilled from times the user corrected the agent. Merge the new corrections into the current " +
          "document. Rules: generalize each correction into a reusable instruction; merge duplicates; keep " +
          "it under ~30 short bullet points, most broadly-useful first; drop anything one-off or ephemeral. " +
          "Output ONLY the updated document as markdown bullets, no preamble.",
        messages: [
          {
            role: "user",
            content: `Current document:\n${current || "(empty)"}\n\nNew corrections:\n${corrections
              .map((x) => `- ${x.description}`)
              .join("\n")}`,
          },
        ],
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      if (text) {
        await setLearnings(env, userId, text);
        await markCorrectionsProcessed(
          env,
          corrections.map((x) => x.id),
        );
      }
    } catch (err) {
      console.error(`sweep: distilling corrections for user ${userId} failed:`, err);
    }
  }
}
