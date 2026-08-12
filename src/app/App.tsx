import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faLayerGroup,
  faMicrophone,
  faBookOpen,
  faComments,
  faMagnifyingGlass,
  faGear,
} from "@fortawesome/free-solid-svg-icons";
import Search from "./components/Search";
import Bell from "./components/Bell";
import Today from "./views/Today";
import Settings from "./views/Settings";
import SearchResults from "./views/SearchResults";
import { api, post, ApiError, type Me } from "./api";
import ProjectsHome from "./views/ProjectsHome";
import ProjectView from "./views/ProjectView";
import TodoView from "./views/TodoView";
import Logs from "./views/Logs";
import LogView from "./views/LogView";
import { Sessions, SessionView } from "./views/Sessions";
import Landing from "./views/Landing";
import Capture, { type CaptureContext } from "./Capture";
import { TALK_EVENT, type TalkRequest } from "./talk";
import { trackPath } from "./nav";

type AuthState = "loading" | "signed-out" | "waitlist" | "ready";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("loading");
  const location = useLocation();
  useEffect(() => trackPath(location.pathname), [location.pathname]);

  // Cmd/Ctrl+K opens omni search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  // What the user is looking at / last touched — becomes capture context.
  const [focus, setFocus] = useState<CaptureContext | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAutoStart, setCaptureAutoStart] = useState(false);
  const [captureMode, setCaptureMode] = useState<"plan" | undefined>(undefined);
  const [captureReplyTo, setCaptureReplyTo] = useState<
    { id: number; title: string; body?: string | null } | undefined
  >(undefined);
  const [captureSeed, setCaptureSeed] = useState<string | undefined>(undefined);
  const [captureResume, setCaptureResume] = useState<{ id: number; label: string } | undefined>(
    undefined,
  );
  const [captureKey, setCaptureKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);

  // Components anywhere can request the Talk dock with a specific context
  // (e.g. a log card's reprocess button).
  useEffect(() => {
    const handler = (e: Event) => {
      const req = (e as CustomEvent).detail as TalkRequest;
      setFocus(req.context);
      setCaptureMode(req.mode);
      setCaptureReplyTo(req.replyTo);
      setCaptureSeed(req.seed);
      setCaptureResume(req.resume);
      setCaptureAutoStart(req.autoStart ?? false);
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
    setCaptureMode(undefined);
    setCaptureReplyTo(undefined);
    setCaptureSeed(undefined);
    setCaptureResume(undefined);
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
  if (auth === "signed-out") return <Landing />;
  if (auth === "waitlist") return <Waitlist email={me?.email ?? ""} />;

  const viewProps = { refreshKey, onFocus: setFocus };

  return (
    <div className={`app ${captureOpen ? "dock-open" : ""}`}>
      <header>
        <h1>
          <Link to="/">Todo Log</Link>
        </h1>
        <nav>
          <NavLink
            to="/projects"
            className={({ isActive }) => (isActive ? "active" : "")}
            title="Projects"
          >
            <FontAwesomeIcon icon={faLayerGroup} />
            <span className="nav-label">Projects</span>
          </NavLink>
          <NavLink to="/logs" className={({ isActive }) => (isActive ? "active" : "")} title="Logs">
            <FontAwesomeIcon icon={faBookOpen} />
            <span className="nav-label">Logs</span>
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
        <div className="nav-tools">
          <button className="nav-search" title="Search" onClick={() => setSearchOpen(true)}>
            <FontAwesomeIcon icon={faMagnifyingGlass} />
          </button>
          <Bell refreshKey={refreshKey} />
          <NavLink to="/settings" className="nav-search" title="Settings">
            <FontAwesomeIcon icon={faGear} />
          </NavLink>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Today {...viewProps} />} />
          <Route path="/projects" element={<ProjectsHome {...viewProps} />} />
          <Route path="/projects/:id" element={<ProjectView {...viewProps} />} />
          <Route path="/todos/:id" element={<TodoView {...viewProps} />} />
          <Route path="/logs" element={<Logs {...viewProps} />} />
          <Route path="/logs/:id" element={<LogView {...viewProps} />} />
          <Route path="/sessions" element={<Sessions {...viewProps} />} />
          <Route path="/sessions/:id" element={<SessionView {...viewProps} />} />
          <Route path="/settings" element={<Settings {...viewProps} />} />
          <Route path="/search" element={<SearchResults {...viewProps} />} />
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
            <FontAwesomeIcon icon={faMicrophone} /> Talk
          </button>
        </footer>
      )}

      {searchOpen && <Search onClose={() => setSearchOpen(false)} />}

      {captureOpen && (
        <Capture
          key={captureKey}
          context={captureMode === "plan" || captureReplyTo ? null : focus}
          mode={captureMode}
          replyTo={captureReplyTo}
          seed={captureSeed}
          resume={captureResume}
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
