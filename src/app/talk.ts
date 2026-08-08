// Tiny app-wide channel for "open the Talk dock with this context" so deeply
// nested components (log cards, the Today view) don't need callback threading.
import type { CaptureContext } from "./Capture";

export const TALK_EVENT = "todolog:talk";

export interface TalkRequest {
  context: CaptureContext | null;
  /** 'plan' opens a day-planning session. */
  mode?: "plan";
}

export function requestTalk(ctx: CaptureContext | null, opts?: { mode?: "plan" }) {
  const detail: TalkRequest = { context: ctx, mode: opts?.mode };
  window.dispatchEvent(new CustomEvent(TALK_EVENT, { detail }));
}
