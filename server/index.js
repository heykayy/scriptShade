// server/index.js
// Backend proxy for scriptShade. Holds all API keys server-side (via .env).
// The browser never sees a real API key — it only ever talks to this server.

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import { dbGet, dbAll, dbRun, initDb, EMPTY_STORE } from "./db.js";
import { getGoogleAuthURL, getGithubAuthURL, getGoogleUser, getGithubUser } from "./oauth.js";

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
// Developer Mode — no signup required. It coexists with (doesn't replace) any other access.
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

// ── A small per-IP rate limiter for login attempts ──────────────────────────
// Used for developer login and 2FA attempts (to prevent brute force).
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

// ── Auth helpers ─────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, isAdmin: !!user.is_admin },
    EFFECTIVE_JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function signTempToken(user) {
  // Temporary token valid only for 2FA verification
  return jwt.sign(
    { uid: user.id, email: user.email, isAdmin: !!user.is_admin, temp: true },
    EFFECTIVE_JWT_SECRET,
    { expiresIn: "5m" }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    // If it's a temp token, reject it for protected routes
    if (payload.temp) {
      return res.status(403).json({ error: "2FA verification required. Please complete two-factor authentication." });
    }
    req.userId = payload.uid;
    req.userEmail = payload.email;
    req.isAdmin = !!payload.isAdmin;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session. Please log in again." });
  }
}

// Middleware for endpoints that accept a temporary token (2FA completion)
function requireTempAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (!payload.temp) {
      return res.status(400).json({ error: "This endpoint requires a temporary token." });
    }
    req.userId = payload.uid;
    req.userEmail = payload.email;
    req.isAdmin = !!payload.isAdmin;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired temporary token." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: "Admin access required." });
  next();
}

// ── OAuth endpoints ──────────────────────────────────────────────────────────

// Initiate Google OAuth
app.get("/api/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).json({ error: "Google OAuth not configured." });
  }
  res.redirect(getGoogleAuthURL());
});

// Initiate GitHub OAuth
app.get("/api/auth/github", (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID) {
    return res.status(400).json({ error: "GitHub OAuth not configured." });
  }
  res.redirect(getGithubAuthURL());
});

// Google callback
app.get("/api/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");
  try {
    const userInfo = await getGoogleUser(code);
    const result = await handleOAuthUser("google", userInfo.id, userInfo.email);
    const redirectUrl = `${process.env.FRONTEND_URL}/oauth-callback?token=${result.token}&needs2fa=${result.needs2fa}&totp=${!!result.hasTotp}&backup=${!!result.hasBackupCodes}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send("Authentication failed");
  }
});

// GitHub callback
app.get("/api/auth/github/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");
  try {
    const userInfo = await getGithubUser(code);
    const result = await handleOAuthUser("github", userInfo.id, userInfo.email);
    const redirectUrl = `${process.env.FRONTEND_URL}/oauth-callback?token=${result.token}&needs2fa=${result.needs2fa}&totp=${!!result.hasTotp}&backup=${!!result.hasBackupCodes}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send("Authentication failed");
  }
});

// Helper to create/update user after OAuth
async function handleOAuthUser(provider, providerId, email) {
  let user = await dbGet(
    `SELECT * FROM users WHERE email = ? OR ${provider}_id = ?`,
    [email, providerId]
  );
  if (user) {
    // Link provider if not already linked
    if (!user[`${provider}_id`]) {
      await dbRun(`UPDATE users SET ${provider}_id = ? WHERE id = ?`, [providerId, user.id]);
      user = await dbGet("SELECT * FROM users WHERE id = ?", [user.id]);
    }
    // If TOTP is enabled, issue a temporary token; otherwise final token.
    const backupCodes = JSON.parse(user.backup_codes_hash || "[]");
    const hasTotp = !!user.totp_enabled;
    const hasBackupCodes = backupCodes.length > 0;
    if (user.two_factor_enabled && (hasTotp || hasBackupCodes)) {
      const tempToken = signTempToken({ ...user, is_admin: user.is_admin });
      return { token: tempToken, needs2fa: true, hasTotp, hasBackupCodes };
    } else {
      const token = signToken({ ...user, is_admin: user.is_admin });
      return { token, needs2fa: false, hasTotp: false, hasBackupCodes: false };
    }
  } else {
    // New user – no 2FA by default
    const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    const info = await dbRun(
      `INSERT INTO users (email, password_hash, ${provider}_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [email, unusablePasswordHash, providerId, Date.now()]
    );
    const newUser = await dbGet("SELECT * FROM users WHERE id = ?", [info.lastInsertRowid]);
    const token = signToken({ ...newUser, is_admin: 0 });
    return { token, needs2fa: false, hasTotp: false, hasBackupCodes: false };
  }
}

// ── 2FA completion endpoint ──────────────────────────────────────────────────
// After the user provides a valid TOTP code or backup code, we issue the final JWT.
app.post("/api/auth/complete-2fa", requireTempAuth, async (req, res) => {
  const { totpCode, backupCode } = req.body;
  if (!totpCode && !backupCode) {
    return res.status(400).json({ error: "Provide either TOTP code or a backup code." });
  }
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many attempts. Please wait a while and try again." });
  }

  const user = await dbGet("SELECT * FROM users WHERE id = ?", [req.userId]);
  if (!user) return res.status(401).json({ error: "User not found." });

  let valid = false;
  if (totpCode) {
    if (!user.totp_enabled || !user.totp_secret) {
      return res.status(400).json({ error: "TOTP not enabled for this account." });
    }
    valid = authenticator.check(totpCode, user.totp_secret);
    if (!valid) {
      recordFailedLogin(req.ip);
      return res.status(401).json({ error: "Invalid TOTP code." });
    }
  } else if (backupCode) {
    // Check against stored backup code hashes
    const backupHashes = JSON.parse(user.backup_codes_hash || "[]");
    let matchedHash = null;
    for (const hash of backupHashes) {
      if (await bcrypt.compare(backupCode.trim(), hash)) {
        matchedHash = hash;
        valid = true;
        break;
      }
    }
    if (!valid) {
      recordFailedLogin(req.ip);
      return res.status(401).json({ error: "Invalid backup code." });
    }
    // Remove the used backup code
    const newHashes = backupHashes.filter(h => h !== matchedHash);
    await dbRun("UPDATE users SET backup_codes_hash = ? WHERE id = ?", [JSON.stringify(newHashes), user.id]);
  }

  // Issue final token
  const finalToken = signToken({ ...user, is_admin: user.is_admin });
  res.json({ token: finalToken, user: { id: user.id, email: user.email, isAdmin: !!user.is_admin } });
});

// ── TOTP management endpoints ──────────────────────────────────────────────

// Generate TOTP secret (does not enable until verified)
app.post("/api/auth/totp/setup", requireAuth, async (req, res) => {
  const user = await dbGet("SELECT totp_enabled FROM users WHERE id = ?", [req.userId]);
  if (user?.totp_enabled) {
    return res.status(400).json({ error: "TOTP already enabled." });
  }
  const secret = authenticator.generateSecret();
  await dbRun("UPDATE users SET totp_secret = ? WHERE id = ?", [secret, req.userId]);
  const otpauth = authenticator.keyuri(req.userEmail, "scriptShade", secret);
  res.json({ secret, otpauth });
});

// Verify TOTP code and enable TOTP
app.post("/api/auth/totp/verify", requireAuth, async (req, res) => {
  const { code } = req.body;
  const user = await dbGet("SELECT totp_secret FROM users WHERE id = ?", [req.userId]);
  if (!user?.totp_secret) {
    return res.status(400).json({ error: "TOTP not set up." });
  }
  const verified = authenticator.check(code, user.totp_secret);
  if (!verified) {
    return res.status(400).json({ error: "Invalid code." });
  }
  await dbRun("UPDATE users SET totp_enabled = 1, two_factor_enabled = 1 WHERE id = ?", [req.userId]);
  res.json({ ok: true });
});

// Disable TOTP (and delete secret)
app.post("/api/auth/totp/disable", requireAuth, async (req, res) => {
  const user = await dbGet("SELECT backup_codes_hash FROM users WHERE id = ?", [req.userId]);
  const hasBackupCodes = JSON.parse(user?.backup_codes_hash || "[]").length > 0;
  await dbRun("UPDATE users SET totp_enabled = 0, totp_secret = NULL, two_factor_enabled = ? WHERE id = ?", [hasBackupCodes ? 1 : 0, req.userId]);
  res.json({ ok: true });
});

// ── Backup codes management ─────────────────────────────────────────────────

// Generate 10 new backup codes (only when TOTP is enabled)
app.post("/api/auth/backup-codes/generate", requireAuth, async (req, res) => {
  // Generate 10 random codes
  const codes = [];
  const hashes = [];
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(6).toString("hex").toUpperCase(); // 12 chars, e.g., "A1B2C3D4E5F6"
    codes.push(code);
    const hash = await bcrypt.hash(code, 12);
    hashes.push(hash);
  }
  await dbRun("UPDATE users SET backup_codes_hash = ?, two_factor_enabled = 1 WHERE id = ?", [JSON.stringify(hashes), req.userId]);
  res.json({ codes }); // return the plain codes to be shown once
});

app.post("/api/auth/2fa/toggle", requireAuth, async (req, res) => {
  const enabled = !!req.body?.enabled;
  if (enabled) {
    const user = await dbGet("SELECT totp_enabled, backup_codes_hash FROM users WHERE id = ?", [req.userId]);
    const hasBackupCodes = JSON.parse(user?.backup_codes_hash || "[]").length > 0;
    if (!user?.totp_enabled && !hasBackupCodes) {
      return res.status(400).json({ error: "Set up TOTP or generate backup codes before enabling 2FA." });
    }
    await dbRun("UPDATE users SET two_factor_enabled = 1 WHERE id = ?", [req.userId]);
    return res.json({ enabled: true, totpEnabled: !!user.totp_enabled, hasBackupCodes });
  }
  await dbRun(
    "UPDATE users SET two_factor_enabled = 0, totp_enabled = 0, totp_secret = NULL, backup_codes_hash = NULL WHERE id = ?",
    [req.userId]
  );
  res.json({ enabled: false, totpEnabled: false, hasBackupCodes: false });
});

// ── /api/auth/me ─────────────────────────────────────────────────────────────
app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await dbGet("SELECT id, email, is_admin, totp_enabled, two_factor_enabled, backup_codes_hash FROM users WHERE id = ?", [req.userId]);
  if (!user) return res.status(401).json({ error: "User not found." });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      isAdmin: !!user.is_admin,
      totpEnabled: !!user.totp_enabled,
      twoFactorEnabled: !!user.two_factor_enabled,
      hasBackupCodes: JSON.parse(user.backup_codes_hash || "[]").length > 0,
    },
  });
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

// ── Admin endpoints ──────────────────────────────────────────────────────────

// List all accounts with a quick usage summary.
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT u.id, u.email, u.created_at, u.totp_enabled,
             s.data, s.updated_at
      FROM users u LEFT JOIN user_store s ON s.user_id = u.id
      ORDER BY u.created_at DESC
    `);
    const users = rows.map(r => {
      let summary = { topics: 0, xp: 0, streak: 0, sessions: 0 };
      try {
        const d = JSON.parse(r.data || "{}");
        summary = { topics: (d.topics || []).length, xp: d.xp || 0, streak: d.streak?.count || 0, sessions: (d.sessions || []).length };
      } catch {}
      return {
        id: r.id,
        email: r.email,
        isProtected: !!(ADMIN_EMAIL_ENV && r.email === ADMIN_EMAIL_ENV),
        createdAt: r.created_at,
        lastActive: r.updated_at,
        totpEnabled: !!r.totp_enabled,
        ...summary,
      };
    });
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load accounts." });
  }
});

// Aggregate stats across the whole install.
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

// Delete an account entirely (cascades to their user_store row via hand-coded delete).
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await dbGet("SELECT email FROM users WHERE id = ?", [targetId]);
    if (target && ADMIN_EMAIL_ENV && target.email === ADMIN_EMAIL_ENV) {
      return res.status(400).json({ error: "This account matches ADMIN_EMAIL and can't be deleted from the dashboard." });
    }
    // Delete the store row explicitly first — Turso's remote connection doesn't
    // reliably honor ON DELETE CASCADE the way a local better-sqlite3 file did.
    await dbRun("DELETE FROM user_store WHERE user_id = ?", [targetId]);
    const info = await dbRun("DELETE FROM users WHERE id = ?", [targetId]);
    if (info.changes === 0) return res.status(404).json({ error: "User not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete account." });
  }
});

// Delete the signed-in account and every account-owned record.
app.delete("/api/account", requireAuth, async (req, res) => {
  try {
    if (req.userId === -1) return res.status(400).json({ error: "The developer account cannot be deleted here." });
    await dbRun("DELETE FROM user_store WHERE user_id = ?", [req.userId]);
    const info = await dbRun("DELETE FROM users WHERE id = ?", [req.userId]);
    if (info.changes === 0) return res.status(404).json({ error: "Account not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete account." });
  }
});

// ── Store endpoints ──────────────────────────────────────────────────────────

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

// ── Providers & generation endpoints ────────────────────────────────────────

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

// ── Server startup ──────────────────────────────────────────────────────────

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