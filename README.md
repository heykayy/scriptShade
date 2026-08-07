# scriptShade

AI-powered flashcard quiz app. Paste a topic, pick a provider, get a quiz. Tracks XP, streaks, spaced repetition, and session history — all tied to a real account.

---

## Features

- **Multi-provider AI generation** — Anthropic, OpenAI, or Google Gemini. Keys live on the server, never in the browser.
- **Demo Mode** — generates a small sample deck with no account and no API key. Good for showing someone the app before they set anything up.
- **Accounts** — email/password signup, JWT sessions (30-day expiry), account recovery codes. Data syncs to the backend and is cached in localStorage for instant loads.
- **Spaced repetition** — 5-box Leitner system. A "Review Due" item appears in the nav whenever cards are scheduled. Review state is isolated from the quiz state so they never conflict.
- **Gamification** — XP per quiz (10 per correct answer + score bonus), daily streak, visible in the nav.
- **Export** — CSV, Anki (.txt tab-separated, importable directly into Anki as Basic cards), and PDF (print dialog → Save as PDF).
- **Developer console** — a separate `/developer` login for the site owner. Shows all accounts, aggregate stats, and lets you delete accounts. Completely inaccessible from the regular login flow.
- **Persistent storage** — user data stored in [Turso](https://turso.tech) (hosted libSQL / SQLite-compatible). Survives redeploys, restarts, and free-tier sleep cycles.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, Vite |
| Backend | Node 20, Express |
| Database | Turso (libSQL) via `@libsql/client` |
| Auth | bcrypt (12 rounds) + JWT |
| AI | Anthropic / OpenAI / Gemini (server-side proxy) |
| Deploy | Vercel (frontend) + Render (backend) |

---

## Project structure

```
/                         ← frontend (Vite + React)
  src/
    flashcard-quiz-app.jsx
    main.jsx
    style.css
  index.html
  vite.config.js
  package.json

/server/                  ← backend (Express)
  index.js
  db.js
  package.json
  .env.example
  Dockerfile
```

---

## Local development

### 1. Backend

```bash
cd server
npm install
cp .env.example .env    # fill in at minimum JWT_SECRET
npm run dev             # runs on :8787 with --watch
```

If `TURSO_DATABASE_URL` is not set, the server falls back to a local `db.sqlite` file with a console warning — fine for local dev.

### 2. Frontend

```bash
npm install
npm run dev             # runs on :5173, proxies /api/* to :8787
```

---

## Environment variables

All of these go in `server/.env` for local dev, or in Render's Environment tab for production.

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Sign login tokens. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `TURSO_DATABASE_URL` | ✅ (prod) | Your Turso database URL (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | ✅ (prod) | Long-lived Turso auth token |
| `CORS_ORIGIN` | ✅ (prod) | Comma-separated list of allowed frontend origins e.g. `https://your-app.vercel.app` |
| `ADMIN_EMAIL` | ✅ | Reserved developer email — blocked from regular signup/login |
| `ADMIN_PASSWORD` | ✅ | Password for the `/developer` login page |
| `ANTHROPIC_API_KEY` | optional | Enables Anthropic as a provider |
| `ANTHROPIC_MODEL` | optional | Defaults to `claude-sonnet-4-5-20250929` |
| `OPENAI_API_KEY` | optional | Enables OpenAI as a provider |
| `OPENAI_MODEL` | optional | Defaults to `gpt-4o-mini` |
| `GEMINI_API_KEY` | optional | Enables Google Gemini as a provider |
| `GEMINI_MODEL` | optional | Defaults to `gemini-2.0-flash` |

At least one provider key is needed for real generation. Demo Mode works without any.

---

## Developer login

The `ADMIN_EMAIL` / `ADMIN_PASSWORD` pair you set in `.env` is completely separate from regular user accounts:

- That email is **blocked** from the regular `/` signup and login forms — attempting it returns *"This email or username is not allowed or available for use."*
- The only way in is the `/developer` login page, which issues a special JWT granting developer access.
- The developer console shows all accounts, totals, and account management. It is protected server-side — not just hidden in the UI.

---

## Auth routes

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/signup` | Create account |
| POST | `/api/auth/login` | Regular user login |
| POST | `/api/auth/developer-login` | Developer-only login |
| POST | `/api/auth/forgot-password` | Reset password with recovery code |
| GET | `/api/auth/me` | Verify token, return user info |
| GET | `/api/store` | Load signed-in user's app data |
| PUT | `/api/store` | Save signed-in user's app data |
| GET | `/api/admin/users` | List all accounts (developer only) |
| GET | `/api/admin/stats` | Aggregate totals (developer only) |
| DELETE | `/api/admin/users/:id` | Delete an account (developer only) |

---

## Docker (optional, for self-hosting)

```bash
cd server && cp .env.example .env   # fill in vars
cd ..
docker compose up --build
```

Serves on `http://localhost:8080`. nginx proxies `/api/*` to the backend container over the internal Docker network.

Note: the Docker setup uses a local SQLite volume (`scriptshade-data`). For self-hosted production use this is fine since you control the disk. For Render/Vercel deployment, use Turso instead.

---

## Author

Creator of **scriptShade** : **heykayy**
