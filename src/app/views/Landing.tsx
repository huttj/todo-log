// Public landing page for signed-out visitors: what the app does, stylized
// mockups (CSS-drawn, no real user data), and a beta signup form that posts
// to the public /prospects endpoint.
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
        <h2>The todo list that keeps the story.</h2>
        <p>
          Just talk — about what you need to do, what you're in the middle of, how it's going.
          Todo Log turns it into todos, actions, and a journal of the journey. No forms, no
          friction, nothing lost.
        </p>
        <div className="hero-cta">
          <a className="google-btn" href="#beta">
            Sign up for the beta
          </a>
        </div>
        <CaptureMockup />
      </section>

      <section className="walkthrough">
        <div className="step">
          <span className="step-num">1</span>
          <div>
            <h3>Talk it out</h3>
            <p>
              Hold the mic and ramble like you would to a coworker. Everything transcribes as you
              go — pause, wander, correct yourself. Typing works too.
            </p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">2</span>
          <div>
            <h3>It's filed before you're done talking</h3>
            <p>
              An agent creates the todos, schedules the actions, and journals the rest — applied
              immediately, every change shown in a feed, every change undoable. Got something
              wrong? Just say so; it fixes the record and learns your preferences.
            </p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">3</span>
          <div>
            <h3>The journey stays</h3>
            <p>
              Months later you don't just see what got done — you see how it went. Your exact
              words are kept as quotes that play back the original audio, moment for moment.
            </p>
          </div>
        </div>
      </section>

      <section className="showcase">
        <div className="showcase-row">
          <ProjectsMockup />
          <div className="showcase-copy">
            <h3>Projects, todos, and an inbox</h3>
            <p>
              Work groups itself under projects; loose tasks land in the inbox. Statuses follow
              reality — when you say you started, it's in progress.
            </p>
          </div>
        </div>
        <div className="showcase-row reverse">
          <JournalMockup />
          <div className="showcase-copy">
            <h3>A journal that writes itself</h3>
            <p>
              Every rant becomes a log attached to the thing it's about, with the sentences worth
              keeping preserved verbatim — tap one to hear yourself say it.
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
        I have to pack for the trip today — key things are the birthday card, the Lego set I got,
        clothes, my vitamins… jeez, all the little stuff I'd forget. Bathroom stuff. Snacks too,
        I've got protein bars.
      </div>
      <div className="mock-bubble assistant">
        <p>Packing todo created with everything you listed — card, Lego set, clothes, vitamins,
        bathroom stuff, snacks.</p>
        <ul className="mock-feed">
          <li>
            <span>Created todo “Pack for the trip” (in_progress)</span>
            <em>undo</em>
          </li>
          <li>
            <span>Logged: ran through the packing list</span>
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

function ProjectsMockup() {
  return (
    <div className="mock mock-projects" aria-hidden="true">
      <div className="mock-card">
        <strong>Plant the garden</strong>
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
          <span>Pack for the trip</span>
          <span className="mock-status">in progress</span>
        </div>
        <div className="mock-todo">
          <span>Call the dentist</span>
          <span className="mock-status">idea</span>
        </div>
      </div>
    </div>
  );
}

function JournalMockup() {
  return (
    <div className="mock mock-journal" aria-hidden="true">
      <div className="mock-log">
        <div className="mock-log-head">
          <span>Tue, May 12</span>
          <span className="mock-tag">reflection</span>
        </div>
        <p>Seedlings finally in the ground after two false starts with the weather.</p>
        <div className="mock-quote">
          <span className="mock-play">
            <FontAwesomeIcon icon={faPlay} />
          </span>
          “Honestly I thought I'd hate this part, but being outside all morning was the best I've
          felt all week.”
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
      <p>Todo Log is in private beta. Leave your email and we'll let you in as spots open.</p>
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
          placeholder="What would you use it for? (optional)"
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
