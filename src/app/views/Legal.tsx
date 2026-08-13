// Terms of Use and Privacy Policy — public pages (reachable signed-out).
// Positions that matter: content is never used to train models (opt-in only
// if that ever changes), human access is consent- or cause-gated, deletion
// and full export are rights, not favors.
import { Link } from "react-router-dom";

const EFFECTIVE = "August 12, 2026";

function LegalShell(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="legal">
      <header className="legal-head">
        <Link to="/" className="legal-brand">
          Todo Log
        </Link>
        <nav>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
      </header>
      <h1>{props.title}</h1>
      <p className="legal-date">Effective {EFFECTIVE}</p>
      {props.children}
      <footer className="legal-foot">
        <span>Todo Log is operated by Hutt LLC.</span>
        <span>
          Questions? Use the in-app support chat, or email{" "}
          <a href="mailto:beta@todolo.gg">beta@todolo.gg</a>.
        </span>
      </footer>
    </div>
  );
}

export function Terms() {
  return (
    <LegalShell title="Terms of Use">
      <h2>1. Who we are, and your agreement</h2>
      <p>
        Todo Log ("the Service") is operated by Hutt LLC ("we", "us"), a Washington limited
        liability company. By creating an account or using the Service you agree to these Terms
        and to the <Link to="/privacy">Privacy Policy</Link>. If you don't agree, don't use the
        Service.
      </p>

      <h2>2. Eligibility</h2>
      <p>
        You must be at least 18 years old to use Todo Log. The Service records and analyzes deeply
        personal content, and it is built for adults.
      </p>

      <h2>3. Beta status</h2>
      <p>
        Todo Log is in beta. Features may change or disappear, behavior may be imperfect, and
        despite real care on our part, bugs could cause data to be lost. We work to prevent that —
        recordings upload as you speak and changes are journaled — but you accept beta software
        for what it is.
      </p>

      <h2>4. Your content is yours</h2>
      <p>
        Everything you put into Todo Log — recordings, transcripts, journal entries, todos,
        projects, messages — belongs to you. You grant us only the limited license needed to
        operate the Service for you: storing your content, transcribing it, processing it with AI
        models to file and summarize it, and displaying it back to you. That license ends when
        your content is deleted. We claim no other rights, ever.
      </p>

      <h2>5. AI, honestly</h2>
      <p>
        Todo Log's agent uses large language models. It can misunderstand, mis-file, or state
        things that aren't true. Every change it makes is shown and undoable, but you are
        responsible for reviewing what matters. Todo Log is not medical, psychological, legal, or
        financial advice, and it is not a crisis service. If you are in crisis, contact a
        professional or an emergency service.
      </p>

      <h2>6. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the Service for anything unlawful;</li>
        <li>attempt to access another person's account or data;</li>
        <li>probe, overload, or disrupt the Service's infrastructure;</li>
        <li>abuse the support channel or other humans behind the Service;</li>
        <li>resell or white-label the Service without our written agreement.</li>
      </ul>

      <h2>7. Pricing</h2>
      <p>
        Todo Log is free during the beta. Paid plans are planned; if that affects your account we
        will tell you clearly and in advance, and you'll be able to export everything and leave
        instead if you prefer.
      </p>

      <h2>8. Ending things</h2>
      <p>
        You can stop using Todo Log at any time and delete your account and data (see the Privacy
        Policy for how deletion works). We may suspend or terminate accounts that violate these
        Terms, with notice unless the violation makes notice impractical. If we ever discontinue
        the Service, we'll give you reasonable notice and a way to export your data first.
      </p>

      <h2>9. Disclaimers and liability</h2>
      <p>
        The Service is provided "as is" and "as available", without warranties of any kind, to
        the maximum extent permitted by law. To the same extent, Hutt LLC's total liability for
        any claims arising out of or relating to the Service is limited to the greater of $100 or
        the amount you paid us in the twelve months before the claim.
      </p>

      <h2>10. Governing law</h2>
      <p>
        These Terms are governed by the laws of the State of Washington, USA, and disputes will be
        resolved in the state or federal courts located in Washington.
      </p>

      <h2>11. Changes</h2>
      <p>
        If we change these Terms in a way that matters, we'll notify you in the app or by email
        before the change takes effect. Continuing to use the Service after that means you accept
        the updated Terms.
      </p>
    </LegalShell>
  );
}

export function Privacy() {
  return (
    <LegalShell title="Privacy Policy">
      <p className="legal-lede">
        Todo Log exists to hold your most candid thinking. That only works if the privacy
        posture is unambiguous, so here it is in one breath: <strong>your content is never used
        to train AI models; no human looks at it without your consent or narrow, named cause;
        and you can export or delete all of it, any time.</strong> The rest of this document is
        detail.
      </p>

      <h2>1. What we collect</h2>
      <ul>
        <li>
          <strong>Account:</strong> your name and email from Google sign-in, and settings you
          choose.
        </li>
        <li>
          <strong>Your content:</strong> voice recordings and their transcripts, journal entries,
          todos, projects, priorities, chat messages with the agent, and support-chat messages.
        </li>
        <li>
          <strong>Derived data:</strong> summaries, daily overviews, and the agent's per-account
          notes about how you work. These are computed for you, from your content, and belong
          with it.
        </li>
        <li>
          <strong>Operational data:</strong> AI usage metrics (token counts and costs), error
          logs, and the technical basics any web service sees. We run no advertising and no
          third-party analytics trackers; the only cookie is your sign-in session.
        </li>
      </ul>

      <h2>2. How your content is used</h2>
      <p>
        Solely to run Todo Log for you: transcribing what you say, filing todos and journal
        entries, computing your daily overview, sending notifications you've enabled, and
        answering you in chat. Learning features (like the agent's notes about your preferences)
        are scoped to your account only.
      </p>

      <h2>3. AI processing — and the training question</h2>
      <p>
        Your content is processed by AI models to provide the Service: transcription runs on
        Cloudflare Workers AI, and the agent runs on Anthropic's Claude models via API. These
        providers act as processors for us; per Anthropic's API terms, API inputs and outputs are
        not used to train Anthropic's models.
      </p>
      <p>
        <strong>We do not use your content to train AI models — ours or anyone else's.</strong>{" "}
        If we ever want to build something that would learn from user content beyond your own
        account, it will be strictly opt-in: off by default, asked plainly, and never a condition
        of using the Service.
      </p>

      <h2>4. Human access to your data</h2>
      <p>No human reads your content, with exactly three exceptions:</p>
      <ul>
        <li>
          <strong>You ask or consent</strong> — for example, you request help in the support chat
          and diagnosing your issue requires looking at the affected data.
        </li>
        <li>
          <strong>Diagnostics</strong> — something is malfunctioning and we need to inspect the
          minimum data necessary to find and fix the fault.
        </li>
        <li>
          <strong>Cause</strong> — a reasonable suspicion that an account is being used
          maliciously or abusively, or a valid legal requirement compels us.
        </li>
      </ul>
      <p>In every case, access is limited to the minimum necessary to resolve the matter.</p>

      <h2>5. Who touches your data (subprocessors)</h2>
      <ul>
        <li>
          <strong>Cloudflare</strong> — hosting, database, file storage (recordings), and
          transcription.
        </li>
        <li>
          <strong>Anthropic</strong> — language-model processing for the agent.
        </li>
        <li>
          <strong>Google</strong> — sign-in only; we receive your name and email.
        </li>
      </ul>
      <p>We do not sell your data, and we do not share it with anyone else.</p>

      <h2>6. Retention and deletion</h2>
      <p>
        Your content is kept for as long as your account is active. When you delete your account,
        it deactivates immediately and all of your data — content, recordings, derived data — is
        permanently purged within 30 days (the window exists to cover mistakes and backup
        cycles). During those 30 days you can change your mind; after them, the data is gone.
      </p>

      <h2>7. Your rights</h2>
      <p>We offer these to everyone, not just where GDPR requires them:</p>
      <ul>
        <li>
          <strong>Export:</strong> request your data and we'll provide a complete export —
          content, recordings, everything — with a download link held for 30 days.
        </li>
        <li>
          <strong>Deletion:</strong> the right to be forgotten, as described above.
        </li>
        <li>
          <strong>Access and correction:</strong> see what we hold and fix what's wrong (most of
          it is editable directly in the app).
        </li>
      </ul>
      <p>
        To exercise any of these, use the in-app support chat or email{" "}
        <a href="mailto:beta@todolo.gg">beta@todolo.gg</a>. We respond within 30 days, usually
        much faster.
      </p>

      <h2>8. Security</h2>
      <p>
        Data is encrypted in transit, stored on Cloudflare's infrastructure, and audio is
        accessible only through authenticated requests scoped to your account. No internet
        service can promise perfection; if a breach ever affects your data, we will tell you
        promptly and plainly.
      </p>

      <h2>9. Notifications</h2>
      <p>
        Push notifications are opt-in per device and can be disabled any time in Settings or your
        browser. Signup and support emails come from todolo.gg.
      </p>

      <h2>10. Children</h2>
      <p>
        Todo Log is for adults 18 and over. We do not knowingly collect data from anyone younger;
        if we learn we have, we will delete it.
      </p>

      <h2>11. Changes</h2>
      <p>
        If this policy changes materially, we'll notify you in the app or by email before the
        change takes effect — and the training and human-access commitments above are the kind of
        thing we'd treat as material.
      </p>
    </LegalShell>
  );
}
