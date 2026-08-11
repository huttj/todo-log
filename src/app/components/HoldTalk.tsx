// A talk trigger with the main Talk button's gesture: tap opens the dock
// quietly, hold ≥1s or drag up opens it recording.
import { useRef, type ReactNode } from "react";

export default function HoldTalk(props: {
  className?: string;
  title?: string;
  onOpen: (autoStart: boolean) => void;
  children: ReactNode;
}) {
  const holdTimer = useRef<number | null>(null);
  const pressStartY = useRef(0);
  const fired = useRef(false);

  const down = (e: React.PointerEvent) => {
    fired.current = false;
    pressStartY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      fired.current = true;
      props.onOpen(true);
    }, 1000);
  };
  const move = (e: React.PointerEvent) => {
    if (fired.current || holdTimer.current == null) return;
    if (pressStartY.current - e.clientY > 40) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
      fired.current = true;
      props.onOpen(true);
    }
  };
  const up = () => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (!fired.current) props.onOpen(false);
  };

  return (
    <button
      className={props.className}
      title={props.title}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.children}
    </button>
  );
}
