// One-time nudge toward notifications: enable push where possible, install
// first where required (iOS). Dismiss remembers forever; Settings always
// offers the same controls.
import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faXmark } from "@fortawesome/free-solid-svg-icons";
import {
  isIOS,
  isStandalone,
  pushSupported,
  pushEnabled,
  enablePush,
  canPromptInstall,
  promptInstall,
} from "../push";

const DISMISS_KEY = "todolog.pushNudgeDismissed";

type Mode = "hidden" | "ios-install" | "android-install" | "enable" | "enabled" | "denied";

export default function PushNudge() {
  const [mode, setMode] = useState<Mode>("hidden");

  useEffect(() => {
    let alive = true;
    (async () => {
      if (localStorage.getItem(DISMISS_KEY)) return;
      if (isIOS() && !isStandalone()) {
        if (alive) setMode("ios-install");
        return;
      }
      if (!pushSupported()) return;
      if (Notification.permission === "denied") return;
      if (await pushEnabled()) return;
      if (!alive) return;
      setMode(canPromptInstall() && !isStandalone() ? "android-install" : "enable");
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (mode === "hidden") return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setMode("hidden");
  };

  return (
    <div className="push-nudge">
      <FontAwesomeIcon icon={faBell} className="nudge-ic" />
      {mode === "ios-install" && (
        <span>
          Get check-in notifications: tap <strong>Share</strong> →{" "}
          <strong>Add to Home Screen</strong>, then open Todo Log from the icon and enable push in
          Settings.
        </span>
      )}
      {mode === "android-install" && (
        <span>
          <button
            className="link"
            onClick={async () => {
              await promptInstall();
              setMode("enable");
            }}
          >
            Install Todo Log
          </button>{" "}
          to get check-in notifications.
        </span>
      )}
      {mode === "enable" && (
        <span>
          <button
            className="link"
            onClick={async () => {
              const r = await enablePush();
              if (r === "on") setMode("enabled");
              else if (r === "denied") setMode("denied");
              else dismiss();
            }}
          >
            Enable notifications
          </button>{" "}
          so check-ins reach you when the app's closed.
        </span>
      )}
      {mode === "enabled" && <span>Notifications on — check-ins will reach this device. ✓</span>}
      {mode === "denied" && <span>Notifications are blocked in your browser settings.</span>}
      <button className="nudge-close" title="Don't ask again" onClick={dismiss}>
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </div>
  );
}
