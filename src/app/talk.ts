// Tiny app-wide channel for "open the Talk dock with this context" so deeply
// nested components (log cards) don't need callback threading.
import type { CaptureContext } from "./Capture";

export const TALK_EVENT = "todolog:talk";

export function requestTalk(ctx: CaptureContext | null) {
  window.dispatchEvent(new CustomEvent(TALK_EVENT, { detail: ctx }));
}
