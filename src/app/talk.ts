// Tiny app-wide channel for "open the Talk dock with this context" so deeply
// nested components (log cards, the Today view) don't need callback threading.
import type { CaptureContext } from "./Capture";

export const TALK_EVENT = "todolog:talk";

export interface TalkRequest {
  context: CaptureContext | null;
  /** 'plan' opens a day-planning session. */
  mode?: "plan";
  /** Set when replying to a notification — becomes the session's context. */
  replyTo?: { id: number; title: string; body?: string | null };
  /** Briefing text to open the chat about (shown as an agent bubble). */
  seed?: string;
  /** Open an existing chat in the dock, history loaded, ready to continue. */
  resume?: { id: number; label: string };
  /** Start recording immediately (hold/drag-up gesture). */
  autoStart?: boolean;
}

export function requestTalk(
  ctx: CaptureContext | null,
  opts?: {
    mode?: "plan";
    replyTo?: { id: number; title: string; body?: string | null };
    seed?: string;
    resume?: { id: number; label: string };
    autoStart?: boolean;
  },
) {
  const detail: TalkRequest = {
    context: ctx,
    mode: opts?.mode,
    replyTo: opts?.replyTo,
    seed: opts?.seed,
    resume: opts?.resume,
    autoStart: opts?.autoStart,
  };
  window.dispatchEvent(new CustomEvent(TALK_EVENT, { detail }));
}
