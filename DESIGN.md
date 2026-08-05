# Todo Log — Design

A todo list that doubles as a journal: define what you want to accomplish, schedule
attempts at it, and log/reflect as you go — so you can see and reflect on the journey.
The app handles collection and organization; the praxis (what you do, how you reflect)
is the user's.

## Ontology

- **Project** — an area of focus. Two kinds: `bounded` (build a shed — has an end
  state) and `ongoing` (raising a kid — never completes). Reflection prompts differ
  between them.
- **Todo** — a task: a describable intended outcome, plus freeform details
  (constraints, fears, dependencies). Optionally under a project. Statuses:
  `idea → scheduled → in_progress → done | abandoned`. **Every status change has a
  log behind it** (the `events` row links to the `log`). The agent maintains status
  automatically (scheduling an action moves an idea to `scheduled`, etc.); statuses
  are stored, not derived, so the user can override.
- **Action** — putting a todo into play: an attempt, scheduled or impromptu. One todo
  → many actions. Impromptu actions are first-class (nullable `todo_id`) and can be
  linked afterward. Statuses: `scheduled | in_progress | done | skipped | canceled`.
- **Log** — the primary journal entity. Anything the user said, timestamped,
  optionally attached to a todo / action / project. A **reflection** is a kind of
  log, not a separate entity. Logs are *paraphrases with full quotes attached*; each
  quote deep-links into the source audio via word-level timestamps. Logs also carry
  "delivery" metadata (observable speech-pattern tags — hedging, fragmented,
  flowing — from the Cyborgy pattern): a subtle internal-state signal over time.

## Agent

**Posture: silent by default.** The user rants to the app mid-task the way they'd
rant to a coworker. Default behavior is transcribe + file, nothing more. The agent
speaks only when:

1. **Directly addressed** ("what do you think?", a question) — intent routing, per
   Cyborgy's entry-vs-question classifier. There is also an explicit "ask the AI"
   button.
2. **Very high confidence an interjection helps.** Ships OFF in v1. Tone when it
   does exist: curious about intent, not judgy — "what are you hoping to get out of
   this, and does it still line up with the original goal?" (whose answer the agent
   can then write back into the todo's `outcome`). Which interjections land is
   learned per user.

**Changes are applied immediately, not proposed.** After processing an utterance the
agent shows a change feed (created/updated/completed todos, project updates, log
filings). The user corrects by talking more — repeated engagement resolves ambiguity.
Requirements this creates:

- **Audit trail**: every agent change is a discrete `events` row (entity, kind,
  before/after payload) — renders the change feed, enables cheap undo, and feeds
  learning.
- **Corrections pipeline**: when the user corrects the agent, file a `corrections`
  row. A cron job (or immediate pass) distills pending corrections into a per-user
  **learnings** document prepended to agent prompts (Cyborgy's memory pattern,
  upgraded).

**Bounded conversations.** Context windows must not grow monotonically. A chat
session starts from wherever the user is in the app (that todo/action/project/log is
the starting context), runs while they log/edit/reflect, and ends with a **Done**
button. Sessions are ephemeral; their durable residue is logs + events + corrections.

## Capture pipeline

Hold-to-talk button (drag up to lock). Release = pause, not send; tap to continue.
Send dispatches the whole utterance to the agent.

- Audio is **silently segmented** while recording (MediaRecorder segments, cut at
  pause boundaries and a max-duration cap) and each segment uploads to R2 and
  transcribes as it arrives — so transcription streams in near-live, and no single
  Workers AI call is ever long enough to time out. This was Cyborgy's timeout
  problem; segmentation removes it, no infra change needed.
- Transcription: Workers AI `whisper-large-v3-turbo`, keeping **word-level
  timestamps** (see `transcribe()` port) for quote → audio deep-links.
- Resilience: Cyborgy's idempotent stub + cron-sweep healing pattern — a message's
  `text` stays NULL until fully processed; a sweep retries stragglers. This replaces
  Workers Queues (paid plan) at $0.
- Raw transcripts and audio are never discarded; they're journal material.

## Google Calendar

The app is the **source of truth**; GCal is a projection. Dedicated "Todo Log"
calendar: **only scheduled actions** push to it; details may be enriched, but
changes made in GCal get overwritten on next sync. Impromptu/done actions stay
in-app only (decision 2026-08-05 — retroactive GCal events were considered and
shelved; may revisit). Other calendars are read-only overlay in the day view.
OAuth app stays in Google "testing" mode (≤100 test users, no verification) for
the personal phase.

## Auth & signup

Google OAuth is both sign-in and the Calendar grant. One-way door: anyone can sign
in, but only users with `enabled=1` (bootstrapped from `ALLOWLIST_EMAILS` env) get
in. Everyone else lands on a form: "beta user call" interest or "notify me" —
captured in `prospects` for follow-up.

## UI surface

1. **Tasks** — todos grouped by project, status-aware.
2. **Logs** — global stream, and filtered per task/action/project. Paraphrase with
   expandable quotes; quotes play their audio.
3. **Calendar** — day/week timeline of actions with GCal events overlaid.
4. **Capture** — the AIO hold-to-talk entry, available everywhere; the current view
   is the session's starting context. Ends with the change feed + Done.

## Models & cost

- Routing + extraction: Haiku-class (`claude-haiku-4-5`) — cents/day at personal
  volume.
- Conversation / weekly synthesis: Opus-class, low volume.
- Whisper via Workers AI free allocation; D1/R2/Workers free tiers; R2 zero egress
  (matters for audio playback). Expected total: <$10/mo single-user.

## Milestones

1. **Skeleton** (this commit): schema, worker + SPA scaffold, design doc.
2. **Auth**: Google OAuth + allowlist + prospects form.
3. **CRUD + views**: projects/todos/actions/logs, tasks & logs views.
4. **Capture**: segment recorder → R2 → transcription → agent → change feed →
   conversational correction loop.
5. **Calendar**: projection sync + day view overlay.
6. **Learnings**: corrections distillation; then the resurfacing moment (open a todo
   → see past reflections).

## Reference

`Reference code/cyborgy/` — the user's prior Telegram journal bot (CF Workers + D1 +
R2 + Workers AI + Claude). Source of the transcription, extraction, intent-routing,
memory, and sweep-healing patterns named above.
