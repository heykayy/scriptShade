// server/index.js
// Backend proxy for scriptShade. Holds all API keys server-side (via .env).
// The browser never sees a real API key — it only ever talks to this server.

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Resend } from "resend";
import { dbGet, dbAll, dbRun, initDb, EMPTY_STORE } from "./db.js";

// ── Email (Resend) ────────────────────────────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || "onboarding@resend.dev";
if (!resend) console.warn("WARNING: RESEND_API_KEY not set — email verification disabled. Signups will be blocked.");

async function sendOtp(to, otp, purpose) {
  if (!resend) throw new Error("Email service not configured.");
  const subject = purpose === "signup" ? "Verify your scriptShade account" : "Reset your scriptShade password";
  const body = purpose === "signup"
    ? `<p>Your verification code is:</p><h2 style="letter-spacing:0.1em;font-family:monospace">${otp}</h2><p>This code expires in 15 minutes.</p>`
    : `<p>Your password reset code is:</p><h2 style="letter-spacing:0.1em;font-family:monospace">${otp}</h2><p>This code expires in 15 minutes. If you didn't request this, ignore this email.</p>`;
  await resend.emails.send({ from: EMAIL_FROM, to, subject, html: body });
}

// ── Allowed email domains ────────────────────────────────────────────────────
// Blocks disposable/fake addresses. Add more as needed.
const ALLOWED_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.fr", "yahoo.de", "yahoo.es",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "proton.me", "protonmail.com", "protonmail.ch",
  "icloud.com", "me.com", "mac.com",
  "aol.com",
  "zoho.com",
  "tutanota.com", "tuta.io",
  "fastmail.com", "fastmail.fm",
  "hey.com",
  "pm.me",
]);

function isAllowedEmail(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain && ALLOWED_DOMAINS.has(domain);
}

// ── In-memory OTP store ──────────────────────────────────────────────────────
// { email -> { otp, expires, purpose } }
const otpStore = new Map();
const OTP_TTL_MS = 15 * 60 * 1000; // 15 minutes

function generateOtp() {
  return String(crypto.randomInt(100000, 999999)); // 6-digit
}
function storeOtp(email, otp, purpose) {
  otpStore.set(email.toLowerCase(), { otp, expires: Date.now() + OTP_TTL_MS, purpose });
}
function verifyOtp(email, otp, purpose) {
  const entry = otpStore.get(email.toLowerCase());
  if (!entry) return false;
  if (entry.purpose !== purpose) return false;
  if (Date.now() > entry.expires) { otpStore.delete(email.toLowerCase()); return false; }
  if (entry.otp !== otp.trim()) return false;
  otpStore.delete(email.toLowerCase()); // burn after use
  return true;
}

const app = express();

// ── CORS origin is configured entirely via env var, so it can be changed on
// Render's dashboard (or wherever this is hosted) without touching code or
// redeploying from a new commit. Set CORS_ORIGIN to a comma-separated list
// of allowed frontend origins, e.g.:
//   CORS_ORIGIN=https://your-app.vercel.app,https://your-custom-domain.com
// If unset, all origins are allowed — convenient while wiring things up for
// the first time, but you should set this once you have a real frontend URL.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
if (corsOrigins.length === 0) {
  console.warn("WARNING: CORS_ORIGIN is not set — allowing all origins. Set CORS_ORIGIN in your environment once you have a real frontend URL.");
}
app.use(cors({ origin: corsOrigins.length ? corsOrigins : true }));

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn("WARNING: JWT_SECRET is not set in .env — using an insecure fallback. Set a real secret before deploying.");
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "dev-only-insecure-secret-change-me";

// ── Optional: a fixed master developer login, defined entirely in .env ──────
// If both are set, ADMIN_EMAIL + ADMIN_PASSWORD act as a standing "master key" into
// Developer Mode — no signup required, and this password is never stored or hashed
// in the database at all. It coexists with (doesn't replace) DB-promoted admin accounts.
const ADMIN_EMAIL_ENV = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase() : null;
const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD || null;
if (ADMIN_EMAIL_ENV && !ADMIN_PASSWORD_ENV) {
  console.log("ADMIN_EMAIL is set without ADMIN_PASSWORD — Developer Mode has no way in right now. Set ADMIN_PASSWORD too to enable the /developer login.");
}

// Timing-safe comparison — a plain `===` on a secret leaks information via response
// time (how many leading characters matched before it returned false). Hashing both
// sides to a fixed-length digest first also sidesteps timingSafeEqual's requirement
// that both buffers be the same length.
function safeEqual(a, b) {
  const ah = crypto.createHash("sha256").update(String(a)).digest();
  const bh = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// A one-time account-recovery code — shown to the user exactly once (at signup, and
// again each time it's used to reset a password, since using it burns it). This is
// what makes "forgot password" possible without any email server: possession of this
// code (not just knowledge of your email) is what proves it's really you.
function generateRecoveryCode() {
  const raw = crypto.randomBytes(10).toString("hex").toUpperCase(); // 20 hex chars, 80 bits of entropy
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}`;
}

// A small per-IP limiter on login attempts, since /api/auth/login is now guarding
// two things: real user passwords, and (optionally) the master developer password.
const loginAttempts = new Map(); // ip -> [timestamps of failed attempts]
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
function loginRateLimited(ip) {
  const now = Date.now();
  const hits = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  return hits.length >= LOGIN_MAX_ATTEMPTS;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const hits = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  hits.push(now);
  loginAttempts.set(ip, hits);
}

// NOTE: there is deliberately no DB-based admin promotion here. Developer Mode
// access comes exclusively from POST /api/auth/developer-login (the fixed
// ADMIN_EMAIL/ADMIN_PASSWORD in .env) — a regular signed-up account can never
// carry isAdmin:true in its token, no matter what's in the database.

// ── Config: which providers are usable, based on what's in .env ────────────
const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
  },
  openai: {
    label: "OpenAI",
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },
  gemini: {
    label: "Google Gemini",
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
  },
};

// ── Very small in-memory rate limiter for demo mode (per IP) ────────────────
const demoHits = new Map(); // ip -> [timestamps]
const DEMO_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEMO_MAX_PER_WINDOW = 8;

function demoRateLimited(ip) {
  const now = Date.now();
  const hits = (demoHits.get(ip) || []).filter(t => now - t < DEMO_WINDOW_MS);
  hits.push(now);
  demoHits.set(ip, hits);
  return hits.length > DEMO_MAX_PER_WINDOW;
}

// ── Curated demo deck (no API key / no network call needed) ────────────────
// Used when demo:true is requested, so anyone can try the app with zero setup.
const DEMO_DECKS = {
  default: [
    { id: "d1", question: "What does CPU stand for?", answer: "Central Processing Unit", explanation: "The CPU is the primary component that executes instructions.", hint: "Think 'brain of the computer'." },
    { id: "d2", question: "What is the time complexity of binary search?", answer: "O(log n)", explanation: "Binary search halves the search space each step.", hint: "It's logarithmic." },
    { id: "d3", question: "What year did World War II end?", answer: "1945", explanation: "The war ended with Japan's surrender in September 1945.", hint: "Mid-1940s." },
    { id: "d4", question: "What is the powerhouse of the cell?", answer: "Mitochondria", explanation: "Mitochondria generate most of the cell's ATP energy supply.", hint: "Two words, starts with 'M'." },
    { id: "d5", question: "What does HTML stand for?", answer: "HyperText Markup Language", explanation: "HTML structures content on the web.", hint: "It's a markup language." },
  ],
};

function buildPrompt({ topic, difficulty, cardCount, quizType }) {
  const system = "You are an expert educator creating high-quality quiz flashcards. Return ONLY valid JSON, no markdown, no explanation.";
  const user = `Create ${cardCount} unique flashcard quiz questions about "${topic}" at ${difficulty} difficulty.
Quiz type: ${quizType === "mcq" ? "multiple choice (4 options, mark correct)" : quizType === "truefalse" ? "true/false questions" : "open-ended flashcards (question + answer)"}.

Return JSON:
{
  "cards": [
    ${quizType === "mcq"
      ? `{ "id":"1", "question":"...", "options":["A) ...","B) ...","C) ...","D) ..."], "answer":"A) ...", "explanation":"...", "hint":"..." }`
      : quizType === "truefalse"
      ? `{ "id":"1", "question":"...", "answer":"True", "explanation":"...", "hint":"..." }`
      : `{ "id":"1", "question":"...", "answer":"...", "explanation":"...", "hint":"..." }`
    }
  ]
}

Make questions ${difficulty === "easy" ? "clear and fundamental, testing basic recall and definitions" : difficulty === "medium" ? "moderately challenging, testing understanding and application" : "advanced, testing analysis, synthesis and edge cases"}.
Ensure diversity — cover different aspects of the topic.`;
  return { system, user };
}

function extractJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function callAnthropic({ system, user }) {
  const cfg = PROVIDERS.anthropic;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: cfg.model, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.content?.find(c => c.type === "text")?.text || "";
  return extractJson(raw);
}

async function callOpenAI({ system, user }) {
  const cfg = PROVIDERS.openai;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  return extractJson(raw);
}

async function callGemini({ system, user }) {
  const cfg = PROVIDERS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return extractJson(raw);
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini };

// ── Auth ─────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email, isAdmin: !!user.is_admin }, EFFECTIVE_JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.userId = payload.uid;
    req.userEmail = payload.email;
    req.isAdmin = !!payload.isAdmin;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: "Admin access required." });
  next();
}

// Step 1 — send OTP to email before creating the account
app.post("/api/auth/signup/send-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    const normalizedEmail = email.toLowerCase();
    if (!isAllowedEmail(normalizedEmail)) return res.status(400).json({ error: "Please use a real email address (Gmail, Yahoo, Outlook, Proton, iCloud, etc.)." });
    if (ADMIN_EMAIL_ENV && normalizedEmail === ADMIN_EMAIL_ENV) return res.status(403).json({ error: "This email or username is not allowed or available for use." });
    const existing = await dbGet("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (existing) return res.status(409).json({ error: "An account with that email already exists." });
    const otp = generateOtp();
    storeOtp(normalizedEmail, otp, "signup");
    await sendOtp(normalizedEmail, otp, "signup");
    res.json({ ok: true, message: "Verification code sent. Check your inbox." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send verification email. Please try again." });
  }
});

// Step 2 — verify OTP and create the account
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, otp } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (!otp) return res.status(400).json({ error: "Verification code is required." });

    const normalizedEmail = email.toLowerCase();
    if (ADMIN_EMAIL_ENV && normalizedEmail === ADMIN_EMAIL_ENV) return res.status(403).json({ error: "This email or username is not allowed or available for use." });
    if (!verifyOtp(normalizedEmail, otp, "signup")) return res.status(400).json({ error: "Invalid or expired verification code." });

    const existing = await dbGet("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (existing) return res.status(409).json({ error: "An account with that email already exists." });

    const hash = await bcrypt.hash(password, 12);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(recoveryCode, 12);
    const info = await dbRun(
      "INSERT INTO users (email, password_hash, recovery_code_hash, created_at) VALUES (?, ?, ?, ?)",
      [normalizedEmail, hash, recoveryCodeHash, Date.now()]
    );
    await dbRun("INSERT INTO user_store (user_id, data, updated_at) VALUES (?, ?, ?)", [info.lastInsertRowid, EMPTY_STORE, Date.now()]);
    const row = await dbGet("SELECT * FROM users WHERE id = ?", [info.lastInsertRowid]);
    res.json({ token: signToken({ ...row, is_admin: 0 }), user: { id: row.id, email: row.email, isAdmin: false }, recoveryCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed. Please try again." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    if (loginRateLimited(req.ip)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait a while and try again." });
    }

    const normalizedEmail = email.toLowerCase();

    // The ADMIN_EMAIL is reserved for the master developer login only. Even if a
    // regular account somehow exists with this email (e.g. was created before
    // ADMIN_EMAIL was set, or in a database migrated from elsewhere), the normal
    // login endpoint must never authenticate it — that would let it slip in
    // without isAdmin:true, or, worse, invite confusion about which door grants
    // developer access. It's rejected outright and pointed at /developer instead.
    if (ADMIN_EMAIL_ENV && normalizedEmail === ADMIN_EMAIL_ENV) {
      recordFailedLogin(req.ip);
      return res.status(403).json({ error: "This email or username is not allowed or available for use." });
    }

    const row = await dbGet("SELECT * FROM users WHERE email = ?", [normalizedEmail]);
    if (!row) { recordFailedLogin(req.ip); return res.status(401).json({ error: "Incorrect email or password." }); }

    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) { recordFailedLogin(req.ip); return res.status(401).json({ error: "Incorrect email or password." }); }

    const user = { id: row.id, email: row.email, isAdmin: false }; // regular accounts never carry admin, by design
    res.json({ token: signToken({ ...row, is_admin: 0 }), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: { id: req.userId, email: req.userEmail, isAdmin: req.isAdmin } });
});

// ── Developer login — completely separate from the regular users table ─────
// This is the ONLY way in through /developer. It never signs anyone up, never
// looks at the users table, and never falls back to checking a real account's
// password — it's exclusively the fixed ADMIN_EMAIL / ADMIN_PASSWORD from .env.
app.post("/api/auth/developer-login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many attempts. Please wait a while and try again." });
  }
  if (!ADMIN_EMAIL_ENV || !ADMIN_PASSWORD_ENV) {
    return res.status(503).json({ error: "Developer login isn't configured on this server." });
  }

  const normalizedEmail = email.toLowerCase();
  const emailOk = safeEqual(normalizedEmail, ADMIN_EMAIL_ENV);
  const passwordOk = safeEqual(password, ADMIN_PASSWORD_ENV);
  if (!emailOk || !passwordOk) {
    recordFailedLogin(req.ip);
    return res.status(401).json({ error: "Invalid developer credentials." });
  }

  const masterUser = { id: -1, email: ADMIN_EMAIL_ENV, isAdmin: true };
  res.json({ token: signToken({ id: -1, email: ADMIN_EMAIL_ENV, is_admin: 1 }), user: masterUser });
});

// ── Forgot password ──────────────────────────────────────────────────────────
// Primary: email OTP  |  Secondary: recovery code (offline fallback)

// Step 1 — send OTP to email
app.post("/api/auth/forgot-password/send-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (loginRateLimited(req.ip)) return res.status(429).json({ error: "Too many attempts. Please wait a while and try again." });
    const normalizedEmail = email.toLowerCase();
    const row = await dbGet("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (row) {
      const otp = generateOtp();
      storeOtp(normalizedEmail, otp, "reset");
      await sendOtp(normalizedEmail, otp, "reset").catch(err => console.error("Email send failed:", err));
    }
    // Always respond ok — don't reveal whether the account exists
    res.json({ ok: true, message: "If an account exists with that email, a reset code has been sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send reset email. Please try again." });
  }
});

// Step 2 — reset with OTP (primary) or recovery code (secondary)
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email, otp, recoveryCode, newPassword } = req.body || {};
    if (!email || !newPassword) return res.status(400).json({ error: "Email and new password are required." });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    if (!otp && !recoveryCode) return res.status(400).json({ error: "A verification code or recovery code is required." });
    if (loginRateLimited(req.ip)) return res.status(429).json({ error: "Too many attempts. Please wait a while and try again." });

    const normalizedEmail = email.toLowerCase();
    const row = await dbGet("SELECT * FROM users WHERE email = ?", [normalizedEmail]);

    if (otp) {
      // Primary: email OTP
      if (!verifyOtp(normalizedEmail, otp, "reset")) {
        recordFailedLogin(req.ip);
        return res.status(400).json({ error: "Invalid or expired verification code." });
      }
    } else {
      // Secondary: recovery code
      if (!row || !row.recovery_code_hash) { recordFailedLogin(req.ip); return res.status(401).json({ error: "Incorrect email or recovery code." }); }
      const codeOk = await bcrypt.compare(recoveryCode.trim().toUpperCase(), row.recovery_code_hash);
      if (!codeOk) { recordFailedLogin(req.ip); return res.status(401).json({ error: "Incorrect email or recovery code." }); }
    }

    if (!row) { recordFailedLogin(req.ip); return res.status(401).json({ error: "Account not found." }); }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryCodeHash = await bcrypt.hash(newRecoveryCode, 12);
    await dbRun("UPDATE users SET password_hash = ?, recovery_code_hash = ? WHERE id = ?", [newPasswordHash, newRecoveryCodeHash, row.id]);
    res.json({ token: signToken({ ...row, is_admin: 0 }), user: { id: row.id, email: row.email, isAdmin: false }, recoveryCode: newRecoveryCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

// ── Admin ────────────────────────────────────────────────────────────────
// List all accounts with a quick usage summary (no password hashes ever leave this file).
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT u.id, u.email, u.created_at, s.data, s.updated_at
      FROM users u LEFT JOIN user_store s ON s.user_id = u.id
      ORDER BY u.created_at DESC
    `);
    const users = rows.map(r => {
      let summary = { topics: 0, xp: 0, streak: 0, sessions: 0 };
      try {
        const d = JSON.parse(r.data || "{}");
        summary = { topics: (d.topics || []).length, xp: d.xp || 0, streak: d.streak?.count || 0, sessions: (d.sessions || []).length };
      } catch {}
      return { id: r.id, email: r.email, isProtected: !!(ADMIN_EMAIL_ENV && r.email === ADMIN_EMAIL_ENV), createdAt: r.created_at, lastActive: r.updated_at, ...summary };
    });
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load accounts." });
  }
});

// Aggregate stats across the whole install — a quick health check for the admin dashboard.
app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  try {
    const totalUsersRow = await dbGet("SELECT COUNT(*) AS n FROM users");
    const rows = await dbAll("SELECT data FROM user_store");
    let totalSessions = 0, totalXp = 0;
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        totalSessions += (d.sessions || []).length;
        totalXp += d.xp || 0;
      } catch {}
    }
    res.json({ totalUsers: totalUsersRow.n, totalSessions, totalXp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load stats." });
  }
});

// Delete an account entirely (cascades to their user_store row via the FK).
// Note: "you" here means the master developer session (id -1) — a regular account
// can never reach this endpoint at all, since requireAdmin rejects it before this runs.
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await dbGet("SELECT email FROM users WHERE id = ?", [targetId]);
    if (target && ADMIN_EMAIL_ENV && target.email === ADMIN_EMAIL_ENV) {
      return res.status(400).json({ error: "This account matches ADMIN_EMAIL and can't be deleted from the dashboard." });
    }
    // Delete the store row explicitly first — Turso's remote connection doesn't
    // reliably honor ON DELETE CASCADE the way a local better-sqlite3 file did,
    // so this cascade is now done by hand rather than left to the schema.
    await dbRun("DELETE FROM user_store WHERE user_id = ?", [targetId]);
    const info = await dbRun("DELETE FROM users WHERE id = ?", [targetId]);
    if (info.changes === 0) return res.status(404).json({ error: "User not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete account." });
  }
});


app.get("/api/store", requireAuth, async (req, res) => {
  try {
    // The master developer login (id: -1) isn't a real account — it has no personal
    // flashcard data at all, so just hand back an empty store rather than touching the DB.
    if (req.userId === -1) return res.json({ store: JSON.parse(EMPTY_STORE) });
    const row = await dbGet("SELECT data FROM user_store WHERE user_id = ?", [req.userId]);
    res.json({ store: row ? JSON.parse(row.data) : JSON.parse(EMPTY_STORE) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your data." });
  }
});

app.put("/api/store", requireAuth, async (req, res) => {
  try {
    if (req.userId === -1) return res.json({ ok: true }); // nothing to persist for the master login
    const { store } = req.body || {};
    if (!store || typeof store !== "object") return res.status(400).json({ error: "Missing store payload." });
    await dbRun(
      `INSERT INTO user_store (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [req.userId, JSON.stringify(store), Date.now()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save your data." });
  }
});

app.get("/api/providers", (req, res) => {
  // Tells the frontend which providers are actually configured, without leaking keys.
  const available = Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, cfg]) => [id, { label: cfg.label, configured: !!cfg.key }])
  );
  res.json({ providers: available });
});

app.post("/api/generate", async (req, res) => {
  try {
    const { provider, topic, difficulty = "medium", cardCount = 10, quizType = "flashcard", demo = false } = req.body || {};

    if (demo) {
      const ip = req.ip;
      if (demoRateLimited(ip)) {
        return res.status(429).json({ error: "Demo limit reached. Please try again later, or connect an API key." });
      }
      const count = Math.min(cardCount || 3, 5);
      const deck = DEMO_DECKS.default.slice(0, count).map((c, i) => ({ ...c, id: String(i + 1) }));
      return res.json({ cards: deck, demo: true, provider: "demo" });
    }

    if (!provider || !CALLERS[provider]) {
      return res.status(400).json({ error: "Unknown or missing provider. Use one of: anthropic, openai, gemini." });
    }
    const cfg = PROVIDERS[provider];
    if (!cfg.key) {
      return res.status(400).json({ error: `${cfg.label} is not configured on the server. Add its API key to .env.` });
    }
    if (!topic) return res.status(400).json({ error: "Missing topic." });

    const { system, user } = buildPrompt({ topic, difficulty, cardCount, quizType });
    const parsed = await CALLERS[provider]({ system, user });

    if (!parsed?.cards?.length) throw new Error("Model returned no cards.");
    res.json({ cards: parsed.cards, demo: false, provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Generation failed." });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`scriptShade backend listening on http://localhost:${PORT}`);
    for (const [id, cfg] of Object.entries(PROVIDERS)) {
      console.log(`  - ${id}: ${cfg.key ? "configured" : "not configured (missing key in .env)"}`);
    }
  });
}

start().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
