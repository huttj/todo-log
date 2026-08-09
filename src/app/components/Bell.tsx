// Notification bell: shows the agent's living notifications (one per slot).
// Opening the panel marks them read; X dismisses; "reply" opens Talk.
import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faXmark, faReply } from "@fortawesome/free-solid-svg-icons";
import { api, post, del, type AppNotification } from "../api";
import { requestTalk } from "../talk";

export default function Bell(props: { refreshKey: number }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = () => {
    api<AppNotification[]>("/notifications").then(setItems).catch(() => {});
  };

  useEffect(load, [props.refreshKey]);
  useEffect(() => {
    const timer = window.setInterval(load, 90_000);
    return () => window.clearInterval(timer);
  }, []);

  // Close on outside tap.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const unread = items.filter((n) => !n.read).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      for (const n of items.filter((x) => !x.read)) {
        void post(`/notifications/${n.id}/read`).catch(() => {});
      }
      setItems((xs) => xs.map((x) => ({ ...x, read: 1 })));
    }
  };

  return (
    <div className="bell-wrap" ref={panelRef}>
      <button className="nav-search bell" title="Notifications" onClick={toggle}>
        <FontAwesomeIcon icon={faBell} />
        {unread > 0 && <span className="bell-badge">{unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          {items.length === 0 && <p className="empty">Nothing right now.</p>}
          {items.map((n) => (
            <div key={n.id} className="notif">
              <div className="notif-head">
                <strong>{n.title}</strong>
                <button
                  className="link trash"
                  title="Dismiss"
                  onClick={async () => {
                    await del(`/notifications/${n.id}`).catch(() => {});
                    setItems((xs) => xs.filter((x) => x.id !== n.id));
                  }}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              </div>
              {n.body && <p>{n.body}</p>}
              <div className="notif-foot">
                <span className="when">
                  {new Date(n.updated_at * 1000).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                <button
                  className="link"
                  onClick={() => {
                    setOpen(false);
                    requestTalk(null, { replyTo: { id: n.id, title: n.title } });
                  }}
                >
                  <FontAwesomeIcon icon={faReply} /> reply
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
