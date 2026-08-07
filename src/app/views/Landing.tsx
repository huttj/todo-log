// Public landing page for signed-out visitors. Positioning: the invisible
// half of getting things done — tasks stall on unprocessed uncertainty and
// emotion, not laziness. Two pillars: (1) talk through what's making it hard,
// (2) a long-running feedback loop on your own efforts. Mockups are CSS-drawn
// (no real user data); the beta form posts to the public /prospects endpoint.
import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMicrophone, faPlay } from "@fortawesome/free-solid-svg-icons";
import { post } from "../api";

export default function Landing() {
  return (
    <div className="landing">
      <header className="landing-head">
        <h1>Todo Log</h1>
        <a className="google-btn slim" href="/api/auth/google">
          Sign in
        </a>
      </header>

      <section className="hero">
        <h2>For everything between “to&nbsp;do” and “done.”</h2>
        <p>
          Tasks don't stall because you're lazy. They stall on uncertainty, doubts, and decisions
          you haven't talked yourself through. Todo Log is a to-do list you can talk to — it files
          the plan, catches the feelings, and learns with you as you go.
        </p>
        <div className="hero-cta">
          <a className="google-btn" href="#beta">
            Sign up for the beta
          </a>
        </div>
        <CaptureMockup />
      </section>

      <section className="problem">
        <h3>The invisible half of getting things done</h3>
        <p>
          Every task carries a second task nobody writes down: <em>figure out what's actually in
          the way</em>. When that half gets ignored, things sit untouched for weeks — until you
          finally push through on sheer willpower. Todo Log gives the second half somewhere to go,
          so the first half stops requiring a Herculean effort.
        </p>
      </section>

      <section className="showcase">
        <div className="showcase-row">
          <JournalMockup />
          <div className="showcase-copy">
            <h3>Talk through the hard part</h3>
            <p>
              Stuck is information. Rant about what's making something difficult and it's captured
              — the fears, the open questions, the missing pieces land on the task itself, and the
              gaps fill in over time. Most blockers start dissolving the moment they're said out
              loud.
            </p>
          </div>
        </div>
        <div className="showcase-row reverse">
          <ReflectionMockup />
          <div className="showcase-copy">
            <h3>Learn from every attempt</h3>
            <p>
              While you work, you're generating feedback — what worked, what turned out to be a
              dumb idea, which efforts actually paid off. Todo Log asks how it went, keeps your
              reflections next to the work they're about, and builds a long-running feedback loop
              on your own judgment. A to-do list that makes you smarter about what to do next.
            </p>
          </div>
        </div>
        <div className="showcase-row">
          <ProjectsMockup />
          <div className="showcase-copy">
            <h3>Underneath: a real system, maintained for you</h3>
            <p>
              Projects, todos, actions on a calendar, a journal in your exact words — all filed
              immediately by an agent you correct just by talking. Every change is shown in a
              feed, and every change is undoable. No filing, no gardening, no productivity-system
              maintenance.
            </p>
          </div>
        </div>
      </section>

      <section className="walkthrough">
        <div className="step">
          <span className="step-num">1</span>
          <div>
            <h3>Talk it out</h3>
            <p>
              Hold the mic and ramble like you would to a coworker — what you need to do, what
              you're avoiding, how it's going. Typing works too.
            </p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">2</span>
          <div>
            <h3>It's filed before you're done</h3>
            <p>
              Todos created, actions logged, feelings journaled — and one good question back when
              it helps: what's blocking you, or how did it go?
            </p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">3</span>
          <div>
            <h3>It compounds</h3>
            <p>
              Months later you don't just see what got done — you see what it cost, what it
              taught you, and you can press play and hear yourself figure it out.
            </p>
          </div>
        </div>
      </section>

      <BetaForm />

      {/* div, not <footer> — the app shell styles bare `footer` as a fixed,
          pointer-events-none overlay for the Talk button. */}
      <div className="landing-foot">
        <span>Todo Log — in private beta</span>
        <a href="/api/auth/google">Sign in</a>
      </div>
    </div>
  );
}

// -- Stylized app mockups (illustrative, not screenshots) --------------------

function CaptureMockup() {
  return (
    <div className="mock mock-capture" aria-hidden="true">
      <div className="mock-chip">General</div>
      <div className="mock-bubble user">
        I keep putting off calling the contractor. Honestly I think I'm nervous the quote comes
        back huge and the whole kitchen plan falls apart… and then what was the point of all the
        drawings.
      </div>
      <div className="mock-bubble assistant">
        <p>
          Filed — the worry lives on the task now, not just in your head. What would make the
          call feel doable?
        </p>
        <ul className="mock-feed">
          <li>
            <span>Created todo “Call the contractor” (idea)</span>
            <em>undo</em>
          </li>
          <li>
            <span>Logged reflection: nervous the quote sinks the plan</span>
            <em>undo</em>
          </li>
        </ul>
      </div>
      <div className="mock-composer">
        <span>Talk or type…</span>
        <span className="mock-mic">
          <FontAwesomeIcon icon={faMicrophone} />
        </span>
      </div>
    </div>
  );
}

function JournalMockup() {
  return (
    <div className="mock mock-journal" aria-hidden="true">
      <div className="mock-log">
        <div className="mock-log-head">
          <span>Todo · Call the contractor</span>
          <span className="mock-tag">details</span>
        </div>
        <p>
          Blocked on: fear the quote blows the budget. Missing: rough number for cabinets;
          whether phased work is possible.
        </p>
        <div className="mock-quote">
          <span className="mock-play">
            <FontAwesomeIcon icon={faPlay} />
          </span>
          “If it's over 30k I need a plan B, not a meltdown. Maybe I just ask for a ballpark
          first.”
        </div>
      </div>
    </div>
  );
}

function ReflectionMockup() {
  return (
    <div className="mock mock-journal" aria-hidden="true">
      <div className="mock-log">
        <div className="mock-log-head">
          <span>Tue, May 12</span>
          <span className="mock-tag">reflection</span>
        </div>
        <p>Wrapped the first month of the newsletter experiment.</p>
        <div className="mock-quote">
          <span className="mock-play">
            <FontAwesomeIcon icon={faPlay} />
          </span>
          “The writing is fun but the growth just isn't there. I don't think this is the lever —
          glad I know that after four weeks, not a year.”
        </div>
      </div>
    </div>
  );
}

function ProjectsMockup() {
  return (
    <div className="mock mock-projects" aria-hidden="true">
      <div className="mock-card">
        <strong>Kitchen renovation</strong>
        <div className="mock-meta">
          <span className="mock-tag">bounded</span>
          <span>3 open</span>
        </div>
      </div>
      <div className="mock-card">
        <strong>Learn piano</strong>
        <div className="mock-meta">
          <span className="mock-tag">ongoing</span>
          <span>1 open</span>
        </div>
      </div>
      <div className="mock-inbox">
        <h4>Inbox</h4>
        <div className="mock-todo">
          <span>Call the contractor</span>
          <span className="mock-status">idea</span>
        </div>
        <div className="mock-todo">
          <span>Pack for the trip</span>
          <span className="mock-status">in progress</span>
        </div>
      </div>
    </div>
  );
}

// -- Beta signup -------------------------------------------------------------

function BetaForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [wantsCall, setWantsCall] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      await post("/prospects", { email, name, note, wantsBetaCall: wantsCall });
      setState("done");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <section id="beta" className="beta">
        <h3>You're on the list 🎉</h3>
        <p>We'll be in touch at {email} when your spot opens up.</p>
      </section>
    );
  }

  return (
    <section id="beta" className="beta">
      <h3>Sign up for the beta</h3>
      <p>
        Todo Log is in private beta. If you've got a project that keeps stalling — or a graveyard
        of abandoned to-do apps — you're exactly who this is for.
      </p>
      <form onSubmit={submit}>
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          placeholder="What keeps stalling for you? (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <label className="beta-call">
          <input type="checkbox" checked={wantsCall} onChange={(e) => setWantsCall(e.target.checked)} />
          I'm up for a beta user call
        </label>
        <button type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Notify me"}
        </button>
        {state === "error" && <p className="error">Something went wrong — try again?</p>}
      </form>
    </section>
  );
}
