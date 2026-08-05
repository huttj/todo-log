# Todo Log

A todo list that doubles as a journal. See [DESIGN.md](DESIGN.md) for the full design.

## Setup

```sh
npm install
npx wrangler d1 create todolog        # paste the id into wrangler.jsonc
npm run db:migrate:local
npm run dev                           # http://localhost:5173
```

Secrets go in `.dev.vars` locally (and `wrangler secret put` for prod):

```
ANTHROPIC_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...
```

## Layout

- `src/worker/` — Cloudflare Worker: API (Hono), transcription, cron sweep
- `src/app/` — React SPA (Vite)
- `migrations/` — D1 schema
- `Reference code/cyborgy/` — prior art: proven transcription/extraction patterns
