import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faLayerGroup,
  faBookOpen,
  faCalendarDays,
  faComments,
} from "@fortawesome/free-solid-svg-icons";
import { api, post, ApiError, type Me } from "./api";
import ProjectsHome from "./views/ProjectsHome";
import ProjectView from "./views/ProjectView";
import TodoView from "./views/TodoView";
import Logs from "./views/Logs";
import LogView from "./views/LogView";
import ActionView from "./views/ActionView";
import { Sessions, SessionView } from "./views/Sessions";
import Calendar from "./views/Calendar";
import Capture, { type CaptureContext } from "./Capture";
import { TALK_EVENT } from "./talk";

type AuthState = "loading" | "signed-out" | "waitlist" | "ready";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const [me, setMe] = useState<Me | null>(null);
  // What the user is looking at / last touched — becomes capture context.
  const [focus, setFocus] = useState<CaptureContext | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAutoStart, setCaptureAutoStart] = useState(false);
  const [captureKey, setCaptureKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // Components anywhere can request the Talk dock with a specific context
  // (e.g. a log card's reprocess button).
  useEffect(() => {
    const handler = (e: Event) => {
      const ctx = (e as CustomEvent).detail as CaptureContext | null;
      setFocus(ctx);
      setCaptureAutoStart(false);
      setCaptureKey((k) => k + 1); // fresh session bound to the new context
      setCaptureOpen(true);
    };
    window.addEventListener(TALK_EVENT, handler);
    return () => window.removeEventListener(TALK_EVENT, handler);
  }, []);

  // Talk gesture: tap = open the dock quietly; hold ≥1s OR drag up = open and
  // start recording immediately.
  const holdTimer = useRef<number | null>(null);
  const pressStartY = useRef(0);
  const gestureFired = useRef(false);
  const [talkHint, setTalkHint] = useState(false);

  const openCapture = (autoStart: boolean) => {
    setCaptureAutoStart(autoStart);
    setCaptureOpen(true);
  };

  const talkDown = (e: React.PointerEvent) => {
    gestureFired.current = false;
    pressStartY.current = e.clientY;
    setTalkHint(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      gestureFired.current = true;
      setTalkHint(false);
      openCapture(true);
    }, 1000);
  };

  const talkMove = (e: React.PointerEvent) => {
    if (gestureFired.current || holdTimer.current == null) return;
    if (pressStartY.current - e.clientY > 40) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
      gestureFired.current = true;
      setTalkHint(false);
      openCapture(true);
    }
  };

  const talkUp = () => {
    setTalkHint(false);
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (!gestureFired.current) openCapture(false);
  };

  useEffect(() => {
    api<Me>("/me")
      .then((m) => {
        setMe(m);
        setAuth(m.enabled ? "ready" : "waitlist");
      })
      .catch((e) => {
        setAuth(e instanceof ApiError && e.status === 401 ? "signed-out" : "signed-out");
      });
  }, []);

  if (auth === "loading") return <Splash text="Loading…" />;
  if (auth === "signed-out") return <SignIn />;
  if (auth === "waitlist") return <Waitlist email={me?.email ?? ""} />;

  const viewProps = { refreshKey, onFocus: setFocus };

  return (
    <div className={`app ${captureOpen ? "dock-open" : ""}`}>
      <header>
        <h1>
          <Link to="/">Todo Log</Link>
        </h1>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")} title="Projects">
            <FontAwesomeIcon icon={faLayerGroup} />
            <span className="nav-label">Projects</span>
          </NavLink>
          <NavLink to="/logs" className={({ isActive }) => (isActive ? "active" : "")} title="Logs">
            <FontAwesomeIcon icon={faBookOpen} />
            <span className="nav-label">Logs</span>
          </NavLink>
          <NavLink
            to="/calendar"
            className={({ isActive }) => (isActive ? "active" : "")}
            title="Calendar"
          >
            <FontAwesomeIcon icon={faCalendarDays} />
            <span className="nav-label">Calendar</span>
          </NavLink>
          <NavLink
            to="/sessions"
            className={({ isActive }) => (isActive ? "active" : "")}
            title="Chats"
          >
            <FontAwesomeIcon icon={faComments} />
            <span className="nav-label">Chats</span>
          </NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<ProjectsHome {...viewProps} />} />
          <Route path="/projects/:id" element={<ProjectView {...viewProps} />} />
          <Route path="/todos/:id" element={<TodoView {...viewProps} />} />
          <Route path="/logs" element={<Logs {...viewProps} />} />
          <Route path="/logs/:id" element={<LogView {...viewProps} />} />
          <Route path="/actions/:id" element={<ActionView {...viewProps} />} />
          <Route path="/sessions" element={<Sessions {...viewProps} />} />
          <Route path="/sessions/:id" element={<SessionView {...viewProps} />} />
          <Route path="/calendar" element={<Calendar {...viewProps} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {!captureOpen && (
        <footer>
          {talkHint && <span className="talk-hint">↑ drag up or hold to record</span>}
          <button
            className="capture"
            onPointerDown={talkDown}
            onPointerMove={talkMove}
            onPointerUp={talkUp}
            onContextMenu={(e) => e.preventDefault()}
            title="Tap to open · hold or drag up to record"
          >
            🎙 Talk
          </button>
        </footer>
      )}

      {captureOpen && (
        <Capture
          key={captureKey}
          context={focus}
          autoStart={captureAutoStart}
          onClose={() => setCaptureOpen(false)}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function Splash(props: { text: string }) {
  return (
    <div className="splash">
      <h1>Todo Log</h1>
      <p>{props.text}</p>
    </div>
  );
}

function SignIn() {
  return (
    <div className="splash">
      <h1>Todo Log</h1>
      <p>A todo list that doubles as a journal — see and reflect on the journey as you go.</p>
      <a className="google-btn" href="/api/auth/google">
        Sign in with Google
      </a>
    </div>
  );
}

function Waitlist(props: { email: string }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [wantsCall, setWantsCall] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit() {
    await post("/prospects", { email: props.email, name, note, wantsBetaCall: wantsCall });
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="splash">
        <h1>Todo Log</h1>
        <p>Thanks — you're on the list. We'll be in touch at {props.email}.</p>
      </div>
    );
  }

  return (
    <div className="splash waitlist">
      <h1>Todo Log</h1>
      <p>Todo Log isn't open yet. Leave your details and we'll let you know.</p>
      <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        placeholder="Anything you'd like us to know? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <label>
        <input type="checkbox" checked={wantsCall} onChange={(e) => setWantsCall(e.target.checked)} />
        I'm up for a beta user call
      </label>
      <button onClick={submit}>Notify me</button>
    </div>
  );
}
