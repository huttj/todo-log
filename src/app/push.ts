// Shared push plumbing: platform detection, subscribe flow, and the Android
// install prompt (captured at boot; iOS has no programmatic equivalent).
import { api, post } from "./api";

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}

function urlB64ToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Runs the whole subscribe flow. Call from a user gesture. */
export async function enablePush(): Promise<"on" | "denied" | "unsupported" | "error"> {
  if (!pushSupported()) return "unsupported";
  try {
    const { key } = await api<{ key: string | null }>("/push/key");
    if (!key) return "error";
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return perm === "denied" ? "denied" : "error";
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToBytes(key) as BufferSource,
    });
    await post("/push/subscribe", sub.toJSON());
    return "on";
  } catch {
    return "error";
  }
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}

// Android/Chrome offers a real install prompt — capture it for our button.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}
let deferredInstall: BeforeInstallPromptEvent | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e as BeforeInstallPromptEvent;
});

export function canPromptInstall(): boolean {
  return deferredInstall !== null;
}

export async function promptInstall(): Promise<void> {
  await deferredInstall?.prompt();
  deferredInstall = null;
}
