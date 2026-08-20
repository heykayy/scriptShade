// src/flashcard-quiz-app.jsx
import React, { useState, useEffect, useRef, useCallback } from "react";

const DIFFICULTIES = {
  easy: { label: "Easy", color: "#22c55e", bg: "#dcfce7", desc: "Broad concepts, definitions" },
  medium: { label: "Medium", color: "#f59e0b", bg: "#fef3c7", desc: "Applied knowledge, comparisons" },
  hard: { label: "Hard", color: "#ef4444", bg: "#fee2e2", desc: "Deep analysis, edge cases" },
};

const CARD_COUNTS = [5, 10, 15, 20];
const STORAGE_KEY = "flashcard_app_v3";
const PROVIDER_STORAGE = "flashcard_app_provider_v1";
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

function loadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { topics: [], sessions: [], stats: {}, srs: {}, xp: 0, streak: { count: 0, lastDay: null } };
  } catch { return { topics: [], sessions: [], stats: {}, srs: {}, xp: 0, streak: { count: 0, lastDay: null } }; }
}
function saveStorage(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}
function loadProviderPref() {
  try { return localStorage.getItem(PROVIDER_STORAGE) || ""; } catch { return ""; }
}
function saveProviderPref(id) {
  try { localStorage.setItem(PROVIDER_STORAGE, id); } catch {}
}

const TOKEN_STORAGE = "flashcard_app_token_v1";

function isDeveloperRoute() {
  try { return /^\/(developer|dev)\/?$/.test(window.location.pathname); } catch { return false; }
}
function goToDeveloperRoute() { window.location.pathname = "/developer"; }
function goToRegularRoute() { window.location.pathname = "/"; }

function loadToken() {
  try { return localStorage.getItem(TOKEN_STORAGE) || ""; } catch { return ""; }
}
function saveToken(token) {
  try { token ? localStorage.setItem(TOKEN_STORAGE, token) : localStorage.removeItem(TOKEN_STORAGE); } catch {}
}

// ── Auth API helpers ─────────────────────────────────────────────────────────
async function apiMe(token) {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Session expired.");
  return data.user;
}

async function apiGetStore(token) {
  const res = await fetch(`${API_BASE}/api/store`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not load your data.");
  return data.store;
}

async function apiPutStore(token, store) {
  const res = await fetch(`${API_BASE}/api/store`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ store }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Could not save your data.");
  }
}

async function apiDeleteAccount(token) {
  const res = await fetch(`${API_BASE}/api/account`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not delete your account.");
  return data;
}

// 2FA endpoints
async function apiComplete2fa(tempToken, totpCode, backupCode) {
  const res = await fetch(`${API_BASE}/api/auth/complete-2fa`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tempToken}` },
    body: JSON.stringify({ totpCode, backupCode }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "2FA verification failed.");
  return data; // { token, user }
}

async function apiTotpSetup(token) {
  const res = await fetch(`${API_BASE}/api/auth/totp/setup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to set up TOTP.");
  return data; // { secret, otpauth }
}

async function apiTotpVerify(token, code) {
  const res = await fetch(`${API_BASE}/api/auth/totp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to verify TOTP.");
  return data;
}

async function apiTotpDisable(token) {
  const res = await fetch(`${API_BASE}/api/auth/totp/disable`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to disable TOTP.");
  return data;
}

async function apiGenerateBackupCodes(token) {
  const res = await fetch(`${API_BASE}/api/auth/backup-codes/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to generate backup codes.");
  return data; // { codes: [...] }
}
async function apiToggleTwoFactor(token, enabled) {
  const res = await fetch(`${API_BASE}/api/auth/2fa/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to update 2FA.");
  return data.enabled;
}

// ── Admin API helpers ─────────────────────────────────────────────────────────
async function apiAdminGetUsers(token) {
  const res = await fetch(`${API_BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not load users.");
  return data.users;
}

async function apiAdminGetStats(token) {
  const res = await fetch(`${API_BASE}/api/admin/stats`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not load stats.");
  return data;
}

async function apiAdminDeleteUser(token, id) {
  const res = await fetch(`${API_BASE}/api/admin/users/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not delete user.");
}

// ── Backend API helpers (generation) ────────────────────────────────────────
async function fetchProviders() {
  const res = await fetch(`${API_BASE}/api/providers`);
  if (!res.ok) throw new Error("Could not reach backend server.");
  const data = await res.json();
  return data.providers;
}

async function generateCards({ provider, topic, difficulty, cardCount, quizType, demo }) {
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, topic, difficulty, cardCount, quizType, demo }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Generation failed.");
  return data;
}

// ── Themes ───────────────────────────────────────────────────────────────────
const THEME_STORAGE = "flashcard_app_theme_v1";
function loadThemePref() { try { return localStorage.getItem(THEME_STORAGE) || "night"; } catch { return "night"; } }
function saveThemePref(t) { try { localStorage.setItem(THEME_STORAGE, t); } catch {} }

const THEMES = {
  night: {
    label: "Night", icon: "🌙",
    bg: "#000000", surface: "#0d0d0d", surfaceAlt: "#0a0a0a",
    border: "#1a1a1a", borderMuted: "#222222",
    text: "#f0f0f0", textMuted: "#555555", textFaint: "#333333",
    nav: "rgba(0,0,0,0.96)", navBorder: "#111111",
    accent: "#5b8ef0", accentAlt: "#c044e8",
    gradient: "linear-gradient(135deg, #5b8ef0, #c044e8)",
  },
  day: {
    label: "Day", icon: "☀️",
    bg: "#2d104f", surface: "#262b3d", surfaceAlt: "#2a3048",
    border: "#343a52", borderMuted: "#3e4560",
    text: "#e8eaf6", textMuted: "#9099c0", textFaint: "#5a6080",
    nav: "rgba(90, 51, 124, 0.51)", navBorder: "#2c3148",
    accent: "#5b8ef0", accentAlt: "#c044e8",
    gradient: "linear-gradient(135deg, #5b8ef0, #c044e8)",
  },
  system: { label: "System", icon: "⊙" },
};

function resolveTheme(name) {
  if (name === "system") {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
    return prefersDark ? THEMES.night : THEMES.day;
  }
  return THEMES[name] || THEMES.night;
}

// ── Screens ──────────────────────────────────────────────────────────────────
const SCREENS = {
  HOME: "home",
  CREATE: "create",
  QUIZ: "quiz",
  RESULT: "result",
  HISTORY: "history",
  STATS: "stats",
  REVIEW: "review",
  ADMIN: "admin",
  SETTINGS: "settings",
};

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=JetBrains+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3a3850; border-radius: 2px; }
  .btn { cursor: pointer; border: none; outline: none; font-family: inherit; transition: all 0.18s; }
  .btn:active { transform: scale(0.97); }
  .card-flip { perspective: 1000px; }
  .card-inner { position: relative; width: 100%; height: 100%; transform-style: preserve-3d; transition: transform 0.55s cubic-bezier(0.4,0.2,0.2,1); }
  .card-inner.flipped { transform: rotateY(180deg); }
  .card-face { position: absolute; width: 100%; height: 100%; backface-visibility: hidden; -webkit-backface-visibility: hidden; }
  .card-back { transform: rotateY(180deg); }
  .fade-in { animation: fadeIn 0.35s ease; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
  .slide-up { animation: slideUp 0.4s cubic-bezier(0.16,1,0.3,1); }
  @keyframes slideUp { from { opacity:0; transform:translateY(24px) } to { opacity:1; transform:translateY(0) } }
  input, select, textarea { background: #16131f; border: 1px solid #2e2b3d; color: #e8e6f0; font-family: 'Crimson Pro', Georgia, serif; font-size: 16px; border-radius: 10px; padding: 10px 14px; width: 100%; transition: border-color 0.2s; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: #7c6fe0; }
  select option { background: #16131f; }
  .progress-bar { transition: width 0.5s cubic-bezier(0.4,0,0.2,1); }
  .nav-btn { background: transparent; border: 1px solid #2e2b3d; color: #9b97b8; padding: 7px 16px; border-radius: 20px; font-family: inherit; font-size: 13px; cursor: pointer; transition: all 0.2s; }
  .nav-btn:hover { border-color: #7c6fe0; color: #c5c2e0; background: #1a1729; }
  .tag { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-family: 'JetBrains Mono', monospace; }
  .spinner { width: 40px; height: 40px; border: 3px solid #2e2b3d; border-top-color: #7c6fe0; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg) } }
  .mono { font-family: 'JetBrains Mono', monospace !important; font-size: 13px !important; letter-spacing: 0.03em; }
`;

export default function FlashcardApp() {
  const [screen, setScreen] = useState(SCREENS.HOME);
  const [store, setStore] = useState(loadStorage);
  const [quizConfig, setQuizConfig] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [resultData, setResultData] = useState(null);
  const [toast, setToast] = useState(null);

  // ── Auth ──
  const [token, setToken] = useState(loadToken());
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [needs2fa, setNeeds2fa] = useState(false);
  const [tempToken, setTempToken] = useState(null);
  const [twoFactorMethods, setTwoFactorMethods] = useState({ hasTotp: true, hasBackup: true });
  const syncTimer = useRef(null);

  const [providers, setProviders] = useState(null);
  const [providerError, setProviderError] = useState(null);
  const [provider, setProviderState] = useState(loadProviderPref());
  const [demoMode, setDemoMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const storeLoadedForToken = useRef(null);
  const [themeName, setThemeNameState] = useState(loadThemePref);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const theme = resolveTheme(themeName);
  const setTheme = (t) => { setThemeNameState(t); saveThemePref(t); setShowThemeMenu(false); };

  // ── OAuth callback detection ──────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("token");
    const needs2faParam = params.get("needs2fa") === "true";
    const hasTotpParam = params.get("totp") === "true";
    const hasBackupParam = params.get("backup") === "true";

    if (tokenParam) {
      if (needs2faParam) {
        // Store temp token and show 2FA screen
        setTempToken(tokenParam);
        setNeeds2fa(true);
        setTwoFactorMethods({ hasTotp: hasTotpParam, hasBackup: hasBackupParam });
      } else {
        // Final token – log in directly
        saveToken(tokenParam);
        setToken(tokenParam);
      }
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // ── Verify token on load ──────────────────────────────────────────────────
  useEffect(() => {
    if (!token) { setAuthChecked(true); return; }
    storeLoadedForToken.current = null;
    apiMe(token)
      .then(u => {
        setUser(u);
        return apiGetStore(token).then(remoteStore => {
          setStore(remoteStore);
          saveStorage(remoteStore);
          storeLoadedForToken.current = token;
        });
      })
      .catch(err => {
        setAuthError(err.message);
        setToken(""); saveToken("");
      })
      .finally(() => setAuthChecked(true));
  }, [token]);

  // ── 2FA completion ────────────────────────────────────────────────────────
  const handle2faSuccess = async (finalToken, userData) => {
    saveToken(finalToken);
    setToken(finalToken);
    setUser(userData);
    setNeeds2fa(false);
    setTempToken(null);
    setAuthError(null);
    const remoteStore = await apiGetStore(finalToken);
    setStore(remoteStore);
    saveStorage(remoteStore);
    storeLoadedForToken.current = finalToken;
    if (isDeveloperRoute() && userData.isAdmin) setScreen(SCREENS.ADMIN);
  };

  const handleAuthSuccess = async ({ token: newToken, user: newUser }) => {
    setToken(newToken);
    saveToken(newToken);
    setUser(newUser);
    setAuthError(null);
    const remoteStore = await apiGetStore(newToken);
    setStore(remoteStore);
    saveStorage(remoteStore);
    storeLoadedForToken.current = newToken;
    if (isDeveloperRoute() && newUser.isAdmin) setScreen(SCREENS.ADMIN);
  };

  const handleLogout = () => {
    setToken(""); saveToken(""); setUser(null);
    storeLoadedForToken.current = null;
    setStore(loadStorage());
    setScreen(SCREENS.HOME);
    setNeeds2fa(false);
    setTempToken(null);
    showToast("Logged out.");
  };

  const handleDeleteAccount = async () => {
    if (!window.confirm("Delete your account permanently? This removes your login, flashcards, sessions, stats, XP, and security settings from the database.")) return;
    try {
      await apiDeleteAccount(token);
      setToken("");
      saveToken("");
      setUser(null);
      setStore(loadStorage());
      storeLoadedForToken.current = null;
      setShowSettings(false);
      setScreen(SCREENS.HOME);
      showToast("Account deleted.");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const updateUserSecurity = (changes) => setUser(current => current ? { ...current, ...changes } : current);

  // ── Fetch providers ──────────────────────────────────────────────────────
  useEffect(() => {
    fetchProviders()
      .then(p => {
        setProviders(p);
        setProviderState(prev => {
          if (prev && p[prev]?.configured) return prev;
          const firstConfigured = Object.keys(p).find(id => p[id].configured);
          return firstConfigured || "";
        });
      })
      .catch(err => setProviderError(err.message));
  }, []);

  const setProvider = (id) => { setProviderState(id); saveProviderPref(id); };
  const hasKey = demoMode || !!provider;

  // ── Store persistence ─────────────────────────────────────────────────────
  const persist = useCallback((updater) => {
    setStore(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveStorage(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!token || demoMode || storeLoadedForToken.current !== token) return;
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      apiPutStore(token, store).catch(() => {});
    }, 800);
    return () => clearTimeout(syncTimer.current);
  }, [store, token, demoMode]);

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3200);
  }, []);

  const handleChooseProvider = (id) => {
    setProvider(id);
    setDemoMode(false);
    setShowSettings(false);
  };

  const handleStartDemo = () => {
    setDemoMode(true);
    setShowSettings(false);
    showToast("Demo mode: try a few sample flashcards, no API key needed.");
  };

  const handleExitDemo = () => {
    setDemoMode(false);
    showToast("Exited demo mode.");
  };

  // ── Quiz flow ── (unchanged) ──────────────────────────────────────────────
  const handleQuizComplete = (session) => {
    const updatedSession = { ...session, completedAt: Date.now(), status: "completed" };
    persist(prev => {
      const sessions = prev.sessions.filter(s => s.id !== session.id);
      const stats = { ...prev.stats };
      const topic = session.topic;
      if (!stats[topic]) stats[topic] = { attempts: 0, totalScore: 0, best: 0, history: [] };
      stats[topic].attempts += 1;
      stats[topic].totalScore += session.score;
      stats[topic].best = Math.max(stats[topic].best, session.score);
      stats[topic].history = [...(stats[topic].history || []), { score: session.score, date: Date.now(), difficulty: session.difficulty }].slice(-20);

      const correctCount = Object.values(session.answers || {}).filter(a => (a.rating !== undefined ? a.rating >= 3 : a.correct)).length;
      const xpGained = correctCount * 10 + Math.round(session.score / 10);
      const xp = (prev.xp || 0) + xpGained;

      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const prevStreak = prev.streak || { count: 0, lastDay: null };
      let streak;
      if (prevStreak.lastDay === today) streak = prevStreak;
      else if (prevStreak.lastDay === yesterday) streak = { count: prevStreak.count + 1, lastDay: today };
      else streak = { count: 1, lastDay: today };

      const INTERVAL_DAYS = [0, 1, 2, 4, 7, 14];
      const srs = { ...prev.srs };
      (session.cards || []).forEach((card, i) => {
        const ans = (session.answers || {})[i];
        if (!ans) return;
        const correct = ans.rating !== undefined ? ans.rating >= 3 : !!ans.correct;
        const key = `${topic}::${card.question}`;
        const existing = srs[key];
        const box = correct ? Math.min((existing?.box || 0) + 1, 5) : 1;
        srs[key] = {
          topic, question: card.question, answer: card.answer, explanation: card.explanation, hint: card.hint,
          box,
          due: Date.now() + INTERVAL_DAYS[box] * 86400000,
          lastSeen: Date.now(),
        };
      });

      return { ...prev, sessions: [updatedSession, ...sessions], stats, xp, streak, srs };
    });
    setResultData(updatedSession);
    setScreen(SCREENS.RESULT);
  };

  const handleSaveSession = (session) => {
    persist(prev => {
      const sessions = prev.sessions.filter(s => s.id !== session.id);
      return { ...prev, sessions: [session, ...sessions] };
    });
  };

  const goHome = () => { setShowSettings(false); setScreen(SCREENS.HOME); };
  const keyDotColor = demoMode ? "#f59e0b" : provider ? "#22c55e" : "#ef4444";
  const dueCount = Object.values(store.srs || {}).filter(c => c.due <= Date.now()).length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: theme.bg, color: theme.text, fontFamily: "'Crimson Pro', 'Georgia', serif", position: "relative" }} onClick={() => showThemeMenu && setShowThemeMenu(false)}>
      <style>{GLOBAL_CSS}</style>

      <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: `1px solid ${theme.navBorder}`, position: "sticky", top: 0, background: theme.nav, backdropFilter: "blur(12px)", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={goHome}>
          <img src="/logo.png" alt="scriptShade" style={{ width: 64, height: 64, borderRadius: 4, objectFit: "contain" }} />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!needs2fa && hasKey && (
            <>
              <span className="nav-btn" style={{ cursor: "default", color: "#a78bfa" }} title="Total XP">✦ {store.xp || 0} XP</span>
              {store.streak?.count > 0 && <span className="nav-btn" style={{ cursor: "default", color: "#f59e0b" }} title="Daily streak">🔥 {store.streak.count}</span>}
            </>
          )}
          {demoMode && (
            <button className="nav-btn" onClick={handleExitDemo} title="Exit demo mode" style={{ color: "#f59e0b", borderColor: "#f59e0b44" }}>Exit Demo</button>
          )}
          {user && !demoMode && !needs2fa && (
            <span className="nav-btn" style={{ cursor: "default", color: "#6b67a0" }} title={user.email}>{user.email}</span>
          )}
          {hasKey && !needs2fa && (
            <button className="nav-btn" onClick={() => { if (!demoMode) setShowSettings(s => !s); }} style={showSettings ? { borderColor: "#7c6fe0", color: "#c5c2e0", background: "#1a1729" } : {}}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: keyDotColor, display: "inline-block", flexShrink: 0 }} />
                {demoMode ? "Demo" : provider ? providers?.[provider]?.label || provider : "Setup"}
              </span>
            </button>
          )}
          <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
            <button className="nav-btn" onClick={() => setShowThemeMenu(s => !s)} title="Change theme"
              style={showThemeMenu ? { borderColor: theme.accent, color: theme.text, background: theme.surface } : { color: theme.textMuted }}>
              {THEMES[themeName]?.icon || "🌙"} Theme
            </button>
            {showThemeMenu && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 6, zIndex: 200, minWidth: 140, boxShadow: "0 8px 32px #00000066" }}>
                {Object.entries(THEMES).map(([key, t]) => (
                  <button key={key} onClick={() => setTheme(key)} className="btn"
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 14px", borderRadius: 8, textAlign: "left", fontFamily: "inherit", fontSize: 13, color: themeName === key ? theme.accent : theme.text, background: themeName === key ? `${theme.accent}22` : "transparent" }}>
                    <span style={{ fontSize: 15 }}>{t.icon}</span>
                    {t.label}
                    {themeName === key && <span style={{ marginLeft: "auto", fontSize: 10, color: theme.accent }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!needs2fa && hasKey && !showSettings && <button className="nav-btn" onClick={() => setSidebarOpen(open => !open)} title={sidebarOpen ? "Hide navigation" : "Show navigation"} aria-label={sidebarOpen ? "Hide navigation" : "Show navigation"} style={{ width: 38, height: 38, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{"☰"}</button>}
        </div>
      </nav>

      {!needs2fa && hasKey && !showSettings && sidebarOpen && (
        <aside style={{ position: "fixed", right: 0, top: 93, bottom: 0, width: 220, padding: "22px 14px", background: theme.surface, borderLeft: `1px solid ${theme.border}`, zIndex: 90 }}>
          <div style={{ color: theme.textMuted, fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: "0.12em", padding: "0 12px 12px" }}>WORKSPACE</div>
          {[
            [SCREENS.HOME, "⌂", "Home"],
            [SCREENS.REVIEW, "↻", `Review${dueCount ? ` (${dueCount})` : ""}`],
            [SCREENS.STATS, "◒", "Stats"],
            [SCREENS.HISTORY, "▤", "Sessions"],
          ].map(([target, icon, label]) => (
            <button key={target} className="btn" onClick={() => setScreen(target)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", marginBottom: 4, borderRadius: 8, textAlign: "left", color: screen === target ? theme.text : theme.textMuted, background: screen === target ? `${theme.accent}22` : "transparent", fontSize: 15 }}>
              <span style={{ width: 20, color: screen === target ? theme.accent : theme.textMuted }}>{icon}</span>{label}
            </button>
          ))}
          <div style={{ height: 1, background: theme.border, margin: "18px 8px" }} />
          {user && !demoMode && <button className="btn" onClick={() => setShowSettings(true)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", borderRadius: 8, textAlign: "left", color: showSettings ? theme.text : theme.textMuted, background: showSettings ? `${theme.accent}22` : "transparent", fontSize: 15 }}><span style={{ width: 20 }}>⚙</span>Settings</button>}
          {user && !demoMode && <button className="btn" onClick={handleLogout} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", marginTop: 4, borderRadius: 8, textAlign: "left", color: "#f87171", background: "transparent", fontSize: 15 }}><span style={{ width: 20 }}>↪</span>Log out</button>}
        </aside>
      )}

      <main style={screen === SCREENS.ADMIN && user?.isAdmin
        ? { maxWidth: 1100, margin: "0 auto", padding: "0" }
        : { maxWidth: 780, margin: "0 auto", padding: "28px 20px" }
      }>
        {!authChecked ? (
          <div style={{ textAlign: "center", padding: "80px 0", color: "#6b67a0" }}>
            <div className="spinner" style={{ margin: "0 auto 14px" }} />
            Loading…
          </div>
        ) : needs2fa ? (
          <TwoFactorScreen
            tempToken={tempToken}
            hasTotp={twoFactorMethods.hasTotp}
            hasBackup={twoFactorMethods.hasBackup}
            onSuccess={handle2faSuccess}
            onCancel={() => { setNeeds2fa(false); setTempToken(null); setToken(""); saveToken(""); }}
            showToast={showToast}
          />
        ) : !demoMode && !token ? (
          isDeveloperRoute()
            ? <DeveloperAuthScreen onSuccess={handleAuthSuccess} authError={authError} />
            : <AuthScreen onSuccess={handleAuthSuccess} onStartDemo={handleStartDemo} authError={authError} />
        ) : showSettings ? (
          <SettingsScreen
            providers={providers}
            provider={provider}
            onChooseProvider={handleChooseProvider}
            onStartDemo={handleStartDemo}
            onClose={() => setShowSettings(false)}
            providerError={providerError}
            token={token}
            user={user}
            onUserSecurityChange={updateUserSecurity}
            showToast={showToast}
            onDeleteAccount={handleDeleteAccount}
          />
        ) : !hasKey ? (
          <OnboardingScreen
            providers={providers}
            providerError={providerError}
            onChooseProvider={handleChooseProvider}
            onStartDemo={handleStartDemo}
          />
        ) : (
          <>
            {screen === SCREENS.HOME && (
              <HomeScreen store={store} demoMode={demoMode} onStart={() => setScreen(SCREENS.CREATE)} onResume={(session) => { setActiveSession(session); setScreen(SCREENS.QUIZ); }} onReview={() => setScreen(SCREENS.REVIEW)} dueCount={dueCount} />
            )}
            {screen === SCREENS.CREATE && (
              <CreateScreen store={store} persist={persist} provider={provider} demoMode={demoMode} onGenerate={(cfg) => { setQuizConfig(cfg); setActiveSession(null); setScreen(SCREENS.QUIZ); }} onBack={() => setScreen(SCREENS.HOME)} showToast={showToast} />
            )}
            {screen === SCREENS.QUIZ && (quizConfig || activeSession) && (
              <QuizScreen key={(activeSession || quizConfig).id} config={activeSession || quizConfig} resumeSession={activeSession} onComplete={handleQuizComplete} onSave={handleSaveSession} onBack={() => { setActiveSession(null); setQuizConfig(null); setScreen(SCREENS.HOME); }} showToast={showToast} />
            )}
            {screen === SCREENS.RESULT && resultData && (
              <ResultScreen session={resultData} store={store} onNewQuiz={() => { setActiveSession(null); setQuizConfig(null); setScreen(SCREENS.CREATE); }} onHome={() => setScreen(SCREENS.HOME)} onViewStats={() => setScreen(SCREENS.STATS)} showToast={showToast} />
            )}
            {screen === SCREENS.HISTORY && (
              <HistoryScreen store={store} persist={persist} onResume={(s) => { setActiveSession(s); setScreen(SCREENS.QUIZ); }} showToast={showToast} />
            )}
            {screen === SCREENS.STATS && (
              <StatsScreen store={store} user={user} />
            )}
            {screen === SCREENS.REVIEW && (
              <ReviewScreen store={store} persist={persist} onBack={() => setScreen(SCREENS.HOME)} showToast={showToast} />
            )}
            {screen === SCREENS.ADMIN && user?.isAdmin && (
              <AdminScreen token={token} currentUserId={user.id} showToast={showToast} />
            )}
          </>
        )}
      </main>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: toast.type === "error" ? "#2a0f0f" : "#0f1a2e", border: `1px solid ${toast.type === "error" ? "#ef444488" : "#7c6fe088"}`, color: toast.type === "error" ? "#fca5a5" : "#a78bfa", padding: "10px 20px", borderRadius: 10, fontSize: 14, zIndex: 999, animation: "fadeIn 0.3s ease", maxWidth: 320 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ── Two Factor Screen ────────────────────────────────────────────────────────
function TwoFactorScreen({ tempToken, hasTotp, hasBackup, onSuccess, onCancel, showToast }) {
  const initialMethod = hasTotp ? "totp" : "backup";
  const [method, setMethod] = useState(initialMethod);
  const [totpCode, setTotpCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (method === "totp" && !totpCode.trim() || method === "backup" && !backupCode.trim()) {
      setError(`Enter a ${method === "totp" ? "TOTP" : "backup"} code.`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiComplete2fa(tempToken, method === "totp" ? totpCode.trim() : "", method === "backup" ? backupCode.trim() : "");
      onSuccess(data.token, data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: 420, margin: "40px auto 0" }}>
      <h2 style={{ fontSize: 28, fontWeight: 300, textAlign: "center", marginBottom: 16 }}>Two‑Factor Authentication</h2>
      <p style={{ color: "#6b67a0", textAlign: "center", marginBottom: 24 }}>
        {method === "totp" ? "Enter the code from your authenticator app." : "Enter one of your saved backup codes."}
      </p>
      <form onSubmit={submit} style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, padding: 22 }}>
        {error && <div style={{ background: "#2a0f0f", border: "1px solid #ef444444", borderRadius: 10, padding: "10px 14px", marginBottom: 16, color: "#f87171", fontSize: 13 }}>{error}</div>}
        <label style={{ display: "block", fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.08em", marginBottom: 8 }}>{method === "totp" ? "TOTP CODE" : "BACKUP CODE"}</label>
        {method === "totp" ? (
          <input type="text" inputMode="numeric" maxLength={6} value={totpCode} onChange={e => setTotpCode(e.target.value)} placeholder="6-digit code" style={{ width: "100%", background: "#0e0d1c", border: "1px solid #1e1b2e", borderRadius: 10, padding: "11px 14px", color: "#e8e6f0", fontFamily: "'JetBrains Mono',monospace", fontSize: 20, letterSpacing: "0.2em", marginBottom: 22, boxSizing: "border-box" }} />
        ) : (
          <input type="text" value={backupCode} onChange={e => setBackupCode(e.target.value)} placeholder="e.g., A1B2C3D4E5F6" style={{ width: "100%", background: "#0e0d1c", border: "1px solid #1e1b2e", borderRadius: 10, padding: "11px 14px", color: "#e8e6f0", fontFamily: "'JetBrains Mono',monospace", fontSize: 14, marginBottom: 22, boxSizing: "border-box" }} />
        )}
        {hasTotp && hasBackup && <button type="button" className="btn" onClick={() => { setMethod(method === "totp" ? "backup" : "totp"); setError(null); }} style={{ background: "none", border: "none", color: "#a78bfa", padding: 0, marginBottom: 18, fontFamily: "inherit", cursor: "pointer" }}>{method === "totp" ? "Use a backup code instead" : "Use an authenticator code instead"}</button>}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={onCancel} className="btn" style={{ flex: 1, background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "13px", borderRadius: 12, fontSize: 16, fontFamily: "inherit" }}>Cancel</button>
          <button type="submit" disabled={loading} className="btn" style={{ flex: 2, background: loading ? "#1e1b2e" : "linear-gradient(135deg, #7c6fe0, #a78bfa)", color: loading ? "#6b67a0" : "#fff", padding: "13px", borderRadius: 12, fontSize: 16, fontFamily: "inherit", fontWeight: 500 }}>
            {loading ? "Verifying..." : "Verify →"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({ onSuccess, onStartDemo, authError }) {
  const [error, setError] = useState(authError || null);

  const handleOAuth = (provider) => {
    window.location.href = `${API_BASE}/api/auth/${provider}`;
  };

  return (
    <div className="fade-in" style={{ maxWidth: 420, margin: "24px auto 0" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <img src="/title.png" alt="scriptShade" style={{ height: 128, objectFit: "contain", margin: "0 auto 20px", display: "block" }} />
        <p style={{ color: "#6b67a0", fontSize: 15 }}>Sign in with Google or GitHub to continue.</p>
      </div>

      <form style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, padding: 22 }}>
        {error && <div style={{ background: "#2a0f0f", border: "1px solid #ef444444", borderRadius: 10, padding: "10px 14px", marginBottom: 16, color: "#f87171", fontSize: 13 }}>{error}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button type="button" className="btn" onClick={() => handleOAuth("google")} style={{ background: "#fff", color: "#333", padding: "12px", borderRadius: 10, fontSize: 16, fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>G</span> Sign in with Google
          </button>
          <button type="button" className="btn" onClick={() => handleOAuth("github")} style={{ background: "#24292f", color: "#fff", padding: "12px", borderRadius: 10, fontSize: 16, fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 20 }}>🐙</span> Sign in with GitHub
          </button>
        </div>
      </form>

      <div style={{ textAlign: "center", marginTop: 24 }}>
        <button className="btn" onClick={onStartDemo} style={{ background: "none", border: "1px dashed #2e2b3d", color: "#f59e0b", padding: "10px 24px", borderRadius: 10, fontSize: 14, fontFamily: "inherit" }}>
          Or try Demo Mode — no account needed →
        </button>
      </div>
      <div style={{ textAlign: "center", marginTop: 28 }}>
        <button onClick={goToDeveloperRoute} style={{ background: "none", border: "none", color: "#36ff04", cursor: "pointer", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: "0.05em" }}>{"</> developer login"}</button>
      </div>
    </div>
  );
}

// ── Developer Auth Screen ────────────────────────────────────────────────────
function DeveloperAuthScreen({ onSuccess, authError }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(authError || null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/developer-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Developer login failed.");
      onSuccess(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: 400, margin: "40px auto 0", fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ width: 52, height: 52, background: "#0d1f12", border: "1px solid #22c55e", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 18px", color: "#4ade80" }}>{"</>"}</div>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: "#e2fbe9", marginBottom: 8 }}>Developer Sign-In</h1>
        <p style={{ color: "#5a8a6a", fontSize: 13, lineHeight: 1.6 }}>Master credentials only — no signup, no regular account works here.</p>
      </div>

      <form onSubmit={submit} style={{ background: "#0a1410", border: "1px solid #1a3324", borderRadius: 12, padding: 22 }}>
        {error && (
          <div style={{ background: "#1a0a0a", border: "1px solid #3d1a1a", borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: "#f87171", fontSize: 12, lineHeight: 1.5 }}>{error}</div>
        )}
        <label style={{ display: "block", fontSize: 11, color: "#5a8a6a", letterSpacing: "0.08em", marginBottom: 8 }}>EMAIL</label>
        <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="developer@example.com"
          style={{ width: "100%", background: "#06120a", border: "1px solid #1a3324", borderRadius: 8, padding: "10px 14px", color: "#d4f5df", fontFamily: "inherit", fontSize: 14, marginBottom: 16, boxSizing: "border-box" }} />

        <label style={{ display: "block", fontSize: 11, color: "#5a8a6a", letterSpacing: "0.08em", marginBottom: 8 }}>PASSWORD</label>
        <input type="password" required value={password} onChange={e => setPassword(e.target.value)}
          style={{ width: "100%", background: "#06120a", border: "1px solid #1a3324", borderRadius: 8, padding: "10px 14px", color: "#d4f5df", fontFamily: "inherit", fontSize: 14, marginBottom: 20, boxSizing: "border-box" }} />

        <button type="submit" disabled={loading} style={{ width: "100%", background: loading ? "#1a3324" : "#22c55e", color: loading ? "#5a8a6a" : "#06120a", padding: "11px", borderRadius: 8, fontSize: 14, fontFamily: "inherit", fontWeight: 600, border: "none", cursor: loading ? "default" : "pointer" }}>
          {loading ? "Verifying…" : "Sign in →"}
        </button>
      </form>

      <div style={{ textAlign: "center", marginTop: 20 }}>
        <button onClick={goToRegularRoute} style={{ background: "none", border: "none", color: "#5a8a6a", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>
          ← Back to regular sign-in
        </button>
      </div>
    </div>
  );
}

// ── Settings Screen ──────────────────────────────────────────────────────────
function SettingsScreen({ providers, provider, onChooseProvider, onStartDemo, onClose, providerError, token, user, onUserSecurityChange, showToast, onDeleteAccount }) {
  const [totpStatus, setTotpStatus] = useState(user?.totpEnabled || false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(user?.twoFactorEnabled ?? user?.totpEnabled ?? false);
  const [hasBackupCodes, setHasBackupCodes] = useState(user?.hasBackupCodes || false);
  const [twoFactorOpen, setTwoFactorOpen] = useState(true);
  const [totpSecret, setTotpSecret] = useState(null);
  const [totpQr, setTotpQr] = useState(null);
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpError, setTotpError] = useState(null);
  const [backupCodes, setBackupCodes] = useState(null);

  useEffect(() => {
    setTotpStatus(!!user?.totpEnabled);
    setTwoFactorEnabled(!!(user?.twoFactorEnabled ?? user?.totpEnabled));
    setHasBackupCodes(!!user?.hasBackupCodes);
  }, [user?.totpEnabled, user?.twoFactorEnabled, user?.hasBackupCodes]);

  const handleToggleTwoFactor = async () => {
    if (!twoFactorEnabled && !totpStatus && !hasBackupCodes) {
      setTwoFactorOpen(true);
      showToast("Set up TOTP or generate backup codes before enabling 2FA.", "error");
      return;
    }
    try {
      const enabled = await apiToggleTwoFactor(token, !twoFactorEnabled);
      setTwoFactorEnabled(enabled);
      if (!enabled) {
        setTotpStatus(false);
        setHasBackupCodes(false);
        setTotpSecret(null);
        setTotpQr(null);
        setBackupCodes(null);
      }
      onUserSecurityChange?.({ twoFactorEnabled: enabled, totpEnabled: !!enabled && totpStatus, hasBackupCodes: !!enabled && hasBackupCodes });
      showToast(enabled ? "Two-factor authentication enabled." : "Two-factor authentication disabled.");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleEnableTotp = async () => {
    setTotpLoading(true);
    setTotpError(null);
    try {
      const data = await apiTotpSetup(token);
      setTotpSecret(data.secret);
      setTotpQr(data.otpauth);
    } catch (err) {
      setTotpError(err.message);
    } finally {
      setTotpLoading(false);
    }
  };

  const handleVerifyTotp = async (code) => {
    try {
      await apiTotpVerify(token, code);
      setTotpStatus(true);
      setTwoFactorEnabled(true);
      onUserSecurityChange?.({ totpEnabled: true, twoFactorEnabled: true });
      setTotpSecret(null);
      setTotpQr(null);
      showToast("TOTP enabled!");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleDisableTotp = async () => {
    if (!window.confirm("Disable TOTP? You'll no longer have two-factor authentication.")) return;
    try {
      await apiTotpDisable(token);
      setTotpStatus(false);
      setBackupCodes(null);
      const remainsEnabled = hasBackupCodes;
      setTwoFactorEnabled(remainsEnabled);
      onUserSecurityChange?.({ totpEnabled: false, twoFactorEnabled: remainsEnabled });
      showToast("TOTP disabled.");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleGenerateBackupCodes = async () => {
    try {
      const data = await apiGenerateBackupCodes(token);
      setBackupCodes(data.codes);
      setHasBackupCodes(true);
      setTwoFactorEnabled(true);
      onUserSecurityChange?.({ hasBackupCodes: true, twoFactorEnabled: true });
      window.alert("Save these backup codes somewhere secure. They are shown only once and each code can be used only once.");
      showToast("New backup codes generated. Save them before closing this message.");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: 500, margin: "0 auto" }}>
      <button onClick={onClose} style={{ background: "none", border: "none", color: "#6b67a0", cursor: "pointer", fontSize: 14, fontFamily: "inherit", marginBottom: 24, display: "flex", alignItems: "center", gap: 6 }}>← Back</button>
      <h2 style={{ fontSize: 30, fontWeight: 300, letterSpacing: "-0.02em", marginBottom: 6 }}>Settings</h2>

      {/* Provider settings */}
      <div style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 18, fontWeight: 400, marginBottom: 12 }}>AI Provider</h3>
        <p style={{ color: "#6b67a0", fontSize: 14, marginBottom: 12 }}>API keys live in <span className="mono">server/.env</span> — never in the browser.</p>
        {providerError && (
          <div style={{ background: "#2a0f0f", border: "1px solid #ef444444", borderRadius: 14, padding: "16px 20px", marginBottom: 20, color: "#f87171", fontSize: 14 }}>
            Couldn't reach the backend server ({providerError}).
          </div>
        )}
        {providers && (
          <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, padding: "22px", marginBottom: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(providers).map(([id, p]) => (
                <button key={id} className="btn" disabled={!p.configured} onClick={() => onChooseProvider(id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: provider === id ? "#1a1729" : "#0e0d1c", border: `1px solid ${provider === id ? "#7c6fe0" : "#1e1b2e"}`, borderRadius: 10, padding: "12px 16px", fontFamily: "inherit", color: p.configured ? "#e8e6f0" : "#4a4770", opacity: p.configured ? 1 : 0.55, cursor: p.configured ? "pointer" : "not-allowed" }}>
                  <span>{p.label}</span>
                  <span style={{ fontSize: 12, color: p.configured ? "#4ade80" : "#6b67a0" }}>{provider === id ? "Active" : p.configured ? "Ready →" : "Not configured"}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <button className="btn" onClick={onStartDemo} style={{ width: "100%", background: "none", border: "1px dashed #2e2b3d", color: "#f59e0b", padding: "12px", borderRadius: 10, fontSize: 14, fontFamily: "inherit" }}>
          Switch to Demo Mode →
        </button>
      </div>

      {/* TOTP & Backup Codes */}
      {user && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h3 style={{ fontSize: 18, fontWeight: 400, margin: 0 }}>Two‑Factor Authentication</h3>
            <button className="btn" onClick={handleToggleTwoFactor} role="switch" aria-checked={twoFactorEnabled} style={{ background: twoFactorEnabled ? "#183b2a" : "#1a1729", border: `1px solid ${twoFactorEnabled ? "#22c55e" : "#2e2b3d"}`, color: twoFactorEnabled ? "#4ade80" : "#9b97b8", padding: "6px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>{twoFactorEnabled ? "On" : "Off"}</button>
          </div>
          <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, padding: "22px" }}>
            <button className="btn" onClick={() => setTwoFactorOpen(open => !open)} style={{ background: "none", border: "none", color: "#9b97b8", padding: 0, marginBottom: twoFactorOpen ? 16 : 0, fontFamily: "inherit", cursor: "pointer" }}>{twoFactorOpen ? "Hide security methods" : "Show security methods"}</button>
            {twoFactorOpen && <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <span>TOTP (Authenticator app)</span>
              <div>
                {totpStatus ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: "#4ade80", fontSize: 13 }}>Enabled</span>
                    <button className="btn" onClick={handleDisableTotp} style={{ background: "#1a0f0f", border: "1px solid #3d1515", color: "#f87171", padding: "6px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>Disable</button>
                  </span>
                ) : (
                  <button className="btn" onClick={handleEnableTotp} disabled={totpLoading} style={{ background: "#0f1a2e", border: "1px solid #7c6fe0", color: "#a78bfa", padding: "6px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                    {totpLoading ? "Loading..." : "Enable"}
                  </button>
                )}
              </div>
            </div>
            {totpError && <div style={{ color: "#f87171", fontSize: 13, marginTop: 8 }}>{totpError}</div>}
            {totpSecret && totpQr && (
              <div style={{ marginTop: 16, padding: "16px", background: "#0e0d1c", borderRadius: 12, border: "1px solid #1e1b2e" }}>
                <p style={{ fontSize: 14, marginBottom: 8 }}>Scan this QR code with your authenticator app (e.g., Google Authenticator, Authy):</p>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                  <img src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(totpQr)}`} alt="TOTP QR code" style={{ borderRadius: 8 }} />
                </div>
                <p style={{ fontSize: 13, color: "#6b67a0", marginBottom: 8 }}>Or manually enter: <span className="mono" style={{ color: "#c5c2e0" }}>{totpSecret}</span></p>
                <input type="text" placeholder="Enter the 6-digit code from your app" style={{ width: "100%", background: "#0e0d1c", border: "1px solid #1e1b2e", borderRadius: 10, padding: "10px 14px", color: "#e8e6f0", fontFamily: "inherit", fontSize: 15, marginBottom: 12 }} onKeyDown={e => {
                  if (e.key === "Enter") handleVerifyTotp(e.target.value.trim());
                }} />
                <button className="btn" onClick={() => {
                  const input = document.querySelector('input[placeholder*="Enter the 6-digit"]');
                  handleVerifyTotp(input.value.trim());
                }} style={{ width: "100%", background: "linear-gradient(135deg, #7c6fe0, #a78bfa)", color: "#fff", padding: "10px", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}>Verify</button>
              </div>
            )}

            {/* Backup codes */}
            <div style={{ marginTop: 20, borderTop: "1px solid #1e1b2e", paddingTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Backup codes</span>
                <button className="btn" onClick={handleGenerateBackupCodes} style={{ background: "#1e1b2e", border: "1px solid #7c6fe0", color: "#a78bfa", padding: "6px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                  Generate new
                </button>
              </div>
              {!totpStatus && <div style={{ color: "#6b67a0", fontSize: 13, marginTop: 6 }}>Backup codes can be used independently of an authenticator app.</div>}
              {backupCodes && (
                <div style={{ marginTop: 12, background: "#0a0a0f", borderRadius: 8, padding: "12px" }}>
                  <p style={{ color: "#f59e0b", fontSize: 13, marginBottom: 8 }}>Save these codes! They are shown only once.</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                    {backupCodes.map((code, i) => (
                      <div key={i} className="mono" style={{ color: "#c5c2e0", fontSize: 13, padding: "4px 8px", background: "#12101c", borderRadius: 4, textAlign: "center" }}>{code}</div>
                    ))}
                  </div>
                  <button className="btn" onClick={() => { setBackupCodes(null); showToast("Backup codes hidden."); }} style={{ width: "100%", marginTop: 12, background: "#183b2a", border: "1px solid #22c55e", color: "#4ade80", padding: "9px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                    Save codes
                  </button>
                </div>
              )}
            </div>
            </>}
          </div>
        </div>
      )}

      {user && (
        <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid #2e1a24" }}>
          <h3 style={{ fontSize: 18, fontWeight: 400, color: "#f87171", marginBottom: 8 }}>Danger zone</h3>
          <p style={{ color: "#8f6673", fontSize: 14, lineHeight: 1.5, marginBottom: 14 }}>Permanently remove your account and all flashcards, sessions, stats, XP, and security settings from the database.</p>
          <button className="btn" onClick={onDeleteAccount} style={{ background: "#2a0f14", border: "1px solid #7f2638", color: "#fca5a5", padding: "10px 14px", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}>Delete account permanently</button>
        </div>
      )}
    </div>
  );
}
// ── Onboarding Screen ─────────────────────────────────────────────────────────
// Keys now live server-side (see /server/.env). The user just picks which
// configured provider to use, or tries Demo Mode with zero setup.
function OnboardingScreen({ providers, providerError, onChooseProvider, onStartDemo }) {
  const loading = !providers && !providerError;
  const configuredIds = providers ? Object.keys(providers).filter(id => providers[id].configured) : [];

  return (
    <div className="fade-in" style={{ maxWidth: 520, margin: "32px auto 0" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div style={{ width: 56, height: 56, background: "linear-gradient(135deg, #7c6fe0, #a78bfa)", borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, margin: "0 auto 20px" }}>✦</div>
        <h1 style={{ fontSize: 38, fontWeight: 300, letterSpacing: "-0.03em", lineHeight: 1.15, marginBottom: 12 }}>
          Welcome to <em style={{ fontStyle: "italic", color: "#a78bfa" }}>scriptShade</em>
        </h1>
        <p style={{ color: "#6b67a0", fontSize: 16, lineHeight: 1.6 }}>
          AI-powered flashcard quizzes on any topic.<br />
          API keys are configured once on the server — nothing to type in here.
        </p>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#6b67a0" }}>
          <div className="spinner" style={{ margin: "0 auto 14px" }} />
          Checking available providers…
        </div>
      )}

      {providerError && (
        <div style={{ background: "#2a0f0f", border: "1px solid #ef444444", borderRadius: 14, padding: "18px 22px", marginBottom: 20, color: "#f87171", fontSize: 14, lineHeight: 1.6 }}>
          Couldn't reach the backend server ({providerError}). Make sure the server is running (<span className="mono">cd server && npm start</span>), or just try Demo Mode below.
        </div>
      )}

      {providers && (
        <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, padding: "22px", marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 14 }}>CHOOSE A PROVIDER</label>
          {configuredIds.length === 0 && (
            <div style={{ fontSize: 14, color: "#f59e0b", marginBottom: 14, lineHeight: 1.6 }}>
              No providers are configured on the server yet. Add a key to <span className="mono">server/.env</span> and restart the server — or try the demo below.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(providers).map(([id, p]) => (
              <button key={id} className="btn" disabled={!p.configured} onClick={() => onChooseProvider(id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0e0d1c", border: "1px solid #1e1b2e", borderRadius: 10, padding: "12px 16px", fontFamily: "inherit", color: p.configured ? "#e8e6f0" : "#4a4770", opacity: p.configured ? 1 : 0.55, cursor: p.configured ? "pointer" : "not-allowed" }}>
                <span>{p.label}</span>
                <span style={{ fontSize: 12, color: p.configured ? "#4ade80" : "#6b67a0" }}>{p.configured ? "Ready →" : "Not configured"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ textAlign: "center" }}>
        <button className="btn" onClick={onStartDemo} style={{ background: "linear-gradient(135deg, #f59e0b, #f97316)", color: "#fff", padding: "13px 32px", borderRadius: 12, fontSize: 16, fontFamily: "inherit", fontWeight: 500 }}>
          Try Demo Mode (no key needed) →
        </button>
        <div style={{ marginTop: 10, fontSize: 13, color: "#4a4770" }}>Generates a few sample flashcards so you can try the app instantly.</div>
      </div>
    </div>
  );
}

// ── Home Screen ───────────────────────────────────────────────────────────────
function HomeScreen({ store, demoMode, onStart, onResume, onReview, dueCount }) {
  const savedSessions = store.sessions.filter(s => s.status === "in-progress");
  const totalAttempts = Object.values(store.stats).reduce((a, s) => a + (s.attempts || 0), 0);
  const totalTopics = Object.keys(store.stats).length;
  const avgScore = totalAttempts > 0
    ? Math.round(Object.values(store.stats).reduce((a, s) => a + (s.totalScore || 0), 0) / totalAttempts)
    : 0;

  return (
    <div className="fade-in">
      {demoMode && (
        <div style={{ background: "#1a1420", border: "1px solid #f59e0b44", borderRadius: 12, padding: "12px 16px", marginBottom: 24, fontSize: 13, color: "#f59e0b", textAlign: "center" }}>
          You're in Demo Mode — up to 5 sample flashcards, no API key needed. Connect a provider in Settings to unlock full topics and formats.
        </div>
      )}
      {dueCount > 0 && (
        <div style={{ background: "#12101c", border: "1px solid #7c6fe044", borderRadius: 12, padding: "14px 18px", marginBottom: 24, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, color: "#c5c2e0" }}>🔁 {dueCount} card{dueCount !== 1 ? "s" : ""} due for review</span>
          <button className="btn" onClick={onReview} style={{ background: "#1e1b2e", border: "1px solid #7c6fe0", color: "#a78bfa", padding: "7px 16px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>Review now →</button>
        </div>
      )}
      <div style={{ textAlign: "center", marginBottom: 44, paddingTop: 20 }}>
        <div style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: "#6b67a0", letterSpacing: "0.12em", marginBottom: 16 }}>AI-POWERED LEARNING</div>
        <h1 style={{ fontSize: 48, fontWeight: 300, letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 12 }}>
          Master any topic<br /><em style={{ fontStyle: "italic", color: "#a78bfa" }}>through practice.</em>
        </h1>
        <p style={{ color: "#6b67a0", fontSize: 17, maxWidth: 440, margin: "0 auto 32px" }}>
          Generate intelligent flashcards on any subject, track your progress, and build lasting knowledge.
        </p>
        <button className="btn" onClick={onStart} style={{ background: "linear-gradient(135deg, #7c6fe0, #a78bfa)", color: "#fff", padding: "13px 36px", borderRadius: 12, fontSize: 17, fontFamily: "inherit", letterSpacing: "-0.01em", fontWeight: 500 }}>
          Create Quiz →
        </button>
      </div>

      {/* Stats row */}
      {totalAttempts > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 36 }}>
          {[
            { label: "Quizzes taken", value: totalAttempts, icon: "📋" },
            { label: "Topics explored", value: totalTopics, icon: "🗂️" },
            { label: "Avg score", value: `${avgScore}%`, icon: "⭐" },
          ].map(s => (
            <div key={s.label} style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 14, padding: "18px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>{s.icon}</div>
              <div style={{ fontSize: 26, fontWeight: 500, color: "#c5c2e0", marginBottom: 2 }}>{s.value}</div>
              <div style={{ fontSize: 13, color: "#6b67a0" }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* In-progress sessions */}
      {savedSessions.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 14, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 14 }}>CONTINUE WHERE YOU LEFT OFF</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {savedSessions.slice(0, 3).map(s => (
              <div key={s.id} style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 500, marginBottom: 3 }}>{s.topic}</div>
                  <div style={{ fontSize: 13, color: "#6b67a0" }}>{Object.keys(s.answers || {}).length}/{s.cards.length} cards · {DIFFICULTIES[s.difficulty]?.label} · {new Date(s.savedAt).toLocaleDateString()}</div>
                </div>
                <button className="btn" onClick={() => onResume(s)} style={{ background: "#1e1b2e", border: "1px solid #3a3850", color: "#a78bfa", padding: "7px 18px", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}>
                  Resume
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent topics */}
      {store.topics.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 14 }}>RECENT TOPICS</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {store.topics.slice(0, 10).map(t => (
              <button key={t} className="btn" onClick={onStart} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "6px 14px", borderRadius: 20, fontSize: 14, fontFamily: "inherit" }}>
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Create Screen ─────────────────────────────────────────────────────────────
function CreateScreen({ store, persist, provider, demoMode, onGenerate, onBack, showToast }) {
  const [topic, setTopic] = useState("");
  const [selectedTopic, setSelectedTopic] = useState("");
  const [difficulty, setDifficulty] = useState("medium");
  const [cardCount, setCardCount] = useState(demoMode ? 5 : 10);
  const [quizType, setQuizType] = useState("flashcard");
  const [loading, setLoading] = useState(false);
  const [addingNew, setAddingNew] = useState(!store.topics.length);

  const finalTopic = addingNew ? topic.trim() : selectedTopic;
  const effectiveCardCount = demoMode ? Math.min(cardCount, 5) : cardCount;

  const generate = async () => {
    if (!finalTopic) return showToast("Please enter or select a topic", "error");
    setLoading(true);
    try {
      const { cards } = await generateCards({
        provider,
        topic: finalTopic,
        difficulty,
        cardCount: effectiveCardCount,
        quizType: demoMode ? "flashcard" : quizType, // demo deck is flashcard-only
        demo: demoMode,
      });

      if (!cards?.length) throw new Error("No cards generated");

      const config = {
        id: `session_${Date.now()}`,
        topic: finalTopic,
        difficulty,
        cardCount: cards.length,
        quizType: demoMode ? "flashcard" : quizType,
        cards,
        currentIndex: 0,
        answers: {},
        score: 0,
        status: "in-progress",
        createdAt: Date.now(),
        savedAt: Date.now(),
      };

      // Save topic — use a functional update so we always check against the
      // latest persisted topics list rather than a possibly-stale `store` closure
      // (fixes a race where rapid-fire generates could add duplicate topics).
      persist(prev => prev.topics.includes(finalTopic) ? prev : { ...prev, topics: [finalTopic, ...prev.topics].slice(0, 30) });

      onGenerate(config);
    } catch (e) {
      showToast(e.message || "Failed to generate cards. Try again.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: 560, margin: "0 auto" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6b67a0", cursor: "pointer", fontSize: 14, fontFamily: "inherit", marginBottom: 24, display: "flex", alignItems: "center", gap: 6 }}>
        ← Back
      </button>
      <h2 style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", marginBottom: 8 }}>Configure your quiz</h2>
      <p style={{ color: "#6b67a0", marginBottom: 32, fontSize: 15 }}>Set up your study session</p>

      {demoMode && (
        <div style={{ background: "#1a1420", border: "1px solid #f59e0b44", borderRadius: 12, padding: "12px 16px", marginBottom: 24, fontSize: 13, color: "#f59e0b", lineHeight: 1.6 }}>
          Demo Mode: generates up to 5 sample flashcards, no API key required. Connect a provider in Settings for full topics, formats, and card counts.
        </div>
      )}

      {/* Topic */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: "block", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 10 }}>TOPIC</label>
        {store.topics.length > 0 && !addingNew && (
          <div style={{ marginBottom: 10 }}>
            <select value={selectedTopic} onChange={e => setSelectedTopic(e.target.value)} style={{ marginBottom: 8 }}>
              <option value="">Select a topic...</option>
              {store.topics.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="btn" onClick={() => { setAddingNew(true); setSelectedTopic(""); }} style={{ background: "none", border: "1px dashed #2e2b3d", color: "#7c6fe0", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", width: "100%", marginTop: 6 }}>
              + Add new topic
            </button>
          </div>
        )}
        {(addingNew || !store.topics.length) && (
          <div>
            <input
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Quantum Mechanics, French Revolution, JavaScript..."
              onKeyDown={e => e.key === "Enter" && generate()}
            />
            {store.topics.length > 0 && (
              <button className="btn" onClick={() => { setAddingNew(false); setTopic(""); }} style={{ background: "none", border: "none", color: "#6b67a0", fontSize: 13, fontFamily: "inherit", marginTop: 6, cursor: "pointer" }}>
                ← Choose from existing topics
              </button>
            )}
          </div>
        )}
      </div>

      {/* Quiz Type */}
      <div style={{ marginBottom: 24, opacity: demoMode ? 0.5 : 1, pointerEvents: demoMode ? "none" : "auto" }}>
        <label style={{ display: "block", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 10 }}>QUESTION FORMAT{demoMode ? " (flashcard only in demo)" : ""}</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
          {[
            { key: "flashcard", label: "Flashcard", icon: "📖", desc: "Open ended" },
            { key: "mcq", label: "Multiple Choice", icon: "🔤", desc: "4 options" },
            { key: "truefalse", label: "True / False", icon: "⚖️", desc: "Binary" },
          ].map(t => (
            <button key={t.key} className="btn" onClick={() => setQuizType(t.key)} style={{ background: (demoMode ? "flashcard" : quizType) === t.key ? "#1e1b2e" : "#12101c", border: `1px solid ${(demoMode ? "flashcard" : quizType) === t.key ? "#7c6fe0" : "#1e1b2e"}`, borderRadius: 12, padding: "12px 10px", textAlign: "center", fontFamily: "inherit", color: (demoMode ? "flashcard" : quizType) === t.key ? "#c5c2e0" : "#6b67a0" }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{t.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</div>
              <div style={{ fontSize: 11, color: "#6b67a0", marginTop: 2 }}>{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Difficulty */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: "block", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 10 }}>DIFFICULTY</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
          {Object.entries(DIFFICULTIES).map(([key, d]) => (
            <button key={key} className="btn" onClick={() => setDifficulty(key)} style={{ background: difficulty === key ? "#1e1b2e" : "#12101c", border: `1px solid ${difficulty === key ? d.color : "#1e1b2e"}`, borderRadius: 12, padding: "12px 10px", textAlign: "center", fontFamily: "inherit" }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: d.color, margin: "0 auto 6px" }} />
              <div style={{ fontSize: 13, fontWeight: 500, color: difficulty === key ? "#c5c2e0" : "#6b67a0" }}>{d.label}</div>
              <div style={{ fontSize: 11, color: "#6b67a0", marginTop: 2 }}>{d.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Card Count */}
      <div style={{ marginBottom: 32 }}>
        <label style={{ display: "block", fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em", marginBottom: 10 }}>NUMBER OF CARDS{demoMode ? " (max 5 in demo)" : ""}</label>
        <div style={{ display: "flex", gap: 8 }}>
          {CARD_COUNTS.map(n => {
            const disabled = demoMode && n > 5;
            return (
              <button key={n} className="btn" disabled={disabled} onClick={() => setCardCount(n)} style={{ flex: 1, background: cardCount === n ? "#1e1b2e" : "#12101c", border: `1px solid ${cardCount === n ? "#7c6fe0" : "#1e1b2e"}`, borderRadius: 10, padding: "10px 0", fontFamily: "inherit", color: disabled ? "#3a3850" : cardCount === n ? "#c5c2e0" : "#6b67a0", fontSize: 16, opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
                {n}
              </button>
            );
          })}
        </div>
      </div>

      <button className="btn" onClick={generate} disabled={loading || !finalTopic} style={{ width: "100%", background: loading || !finalTopic ? "#1e1b2e" : "linear-gradient(135deg, #7c6fe0, #a78bfa)", color: loading || !finalTopic ? "#6b67a0" : "#fff", padding: "14px", borderRadius: 12, fontSize: 17, fontFamily: "inherit", fontWeight: 500, letterSpacing: "-0.01em" }}>
        {loading ? (
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <div className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
            Generating {effectiveCardCount} cards…
          </span>
        ) : "Generate Quiz →"}
      </button>
    </div>
  );
}

// ── Quiz Screen ───────────────────────────────────────────────────────────────
function QuizScreen({ config, resumeSession, onComplete, onSave, onBack, showToast }) {
  const initial = resumeSession || config;
  const [currentIndex, setCurrentIndex] = useState(initial.currentIndex || 0);
  const [answers, setAnswers] = useState(initial.answers || {});
  const [flipped, setFlipped] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [userInput, setUserInput] = useState("");
  const [selfRating, setSelfRating] = useState(null); // for flashcard mode
  const [animDir, setAnimDir] = useState(null);
  const [timeElapsed, setTimeElapsed] = useState(initial.timeElapsed || 0);
  const timerRef = useRef(null);
  const cards = config.cards;
  const card = cards[currentIndex];
  const isFlashcard = config.quizType === "flashcard";
  const isMCQ = config.quizType === "mcq";
  const isTF = config.quizType === "truefalse";
  const answered = answers[currentIndex] !== undefined;
  const progress = Object.keys(answers).length;

  useEffect(() => {
    timerRef.current = setInterval(() => setTimeElapsed(t => t + 1), 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const score = Object.entries(answers).reduce((acc, [i, a]) => {
    if (config.quizType === "flashcard") return acc + (a.rating >= 3 ? 1 : 0);
    return acc + (a.correct ? 1 : 0);
  }, 0);

  const navigate = (dir) => {
    setAnimDir(dir);
    setTimeout(() => {
      setCurrentIndex(i => Math.max(0, Math.min(cards.length - 1, i + dir)));
      setFlipped(false);
      setShowHint(false);
      setUserInput("");
      setSelfRating(null);
      setAnimDir(null);
    }, 150);
  };

  const submitAnswer = (choice) => {
    const correct = choice.trim().toLowerCase() === card.answer.trim().toLowerCase() || choice === card.answer;
    setAnswers(prev => ({ ...prev, [currentIndex]: { choice, correct, timestamp: Date.now() } }));
    setFlipped(true);
  };

  const submitSelfRating = (rating) => {
    setSelfRating(rating);
    setAnswers(prev => ({ ...prev, [currentIndex]: { rating, timestamp: Date.now() } }));
  };

  const handleComplete = () => {
    clearInterval(timerRef.current);
    const finalScore = Math.round((score / cards.length) * 100);
    onComplete({ ...config, answers, score: finalScore, timeElapsed, currentIndex: cards.length, status: "completed" });
  };

  const handleSave = () => {
    clearInterval(timerRef.current);
    onSave({ ...config, answers, currentIndex, timeElapsed, status: "in-progress", savedAt: Date.now() });
    showToast("Progress saved!");
  };

  const allAnswered = Object.keys(answers).length === cards.length;

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", marginBottom: 2 }}>{config.topic}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="tag" style={{ background: DIFFICULTIES[config.difficulty]?.bg + "22", color: DIFFICULTIES[config.difficulty]?.color, border: `1px solid ${DIFFICULTIES[config.difficulty]?.color}44` }}>
              {DIFFICULTIES[config.difficulty]?.label}
            </span>
            <span style={{ fontSize: 13, color: "#6b67a0", fontFamily: "'JetBrains Mono',monospace" }}>{formatTime(timeElapsed)}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={handleSave} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "7px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>Save</button>
          <button className="btn" onClick={onBack} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "7px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>Exit</button>
        </div>
      </div>

      {/* Progress */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6b67a0", marginBottom: 8 }}>
          <span>{progress}/{cards.length} answered</span>
          <span>Score: {progress > 0 ? Math.round((score / progress) * 100) : 0}%</span>
        </div>
        <div style={{ background: "#12101c", borderRadius: 4, height: 4, overflow: "hidden" }}>
          <div className="progress-bar" style={{ height: "100%", background: "linear-gradient(90deg, #7c6fe0, #a78bfa)", width: `${(progress / cards.length) * 100}%`, borderRadius: 4 }} />
        </div>
        {/* Card dots */}
        <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap" }}>
          {cards.map((_, i) => {
            const a = answers[i];
            const isCorrect = a && (config.quizType === "flashcard" ? a.rating >= 3 : a.correct);
            const isWrong = a && (config.quizType === "flashcard" ? a.rating < 3 : !a.correct);
            return (
              <button key={i} onClick={() => { setAnimDir(null); setCurrentIndex(i); setFlipped(false); setShowHint(false); setUserInput(""); setSelfRating(null); }} style={{ width: 20, height: 20, borderRadius: 4, border: "none", cursor: "pointer", background: i === currentIndex ? "#7c6fe0" : isCorrect ? "#22c55e" : isWrong ? "#ef4444" : a ? "#f59e0b" : "#1e1b2e", transition: "all 0.2s" }} />
            );
          })}
        </div>
      </div>

      {/* Card */}
      <div style={{ opacity: animDir ? 0 : 1, transform: animDir ? `translateX(${animDir * 30}px)` : "none", transition: "all 0.15s ease" }}>
        <div style={{ fontSize: 13, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", textAlign: "center", marginBottom: 12 }}>
          Card {currentIndex + 1} of {cards.length}
        </div>

        {isFlashcard && (
          <FlashcardType card={card} flipped={flipped} setFlipped={setFlipped} showHint={showHint} setShowHint={setShowHint} answered={answered} onRate={submitSelfRating} selfRating={selfRating || (answers[currentIndex]?.rating)} />
        )}
        {isMCQ && (
          <MCQType card={card} answered={answered} selectedAnswer={answers[currentIndex]?.choice} onSelect={submitAnswer} showHint={showHint} setShowHint={setShowHint} />
        )}
        {isTF && (
          <TFType card={card} answered={answered} selectedAnswer={answers[currentIndex]?.choice} onSelect={submitAnswer} showHint={showHint} setShowHint={setShowHint} />
        )}

        {/* Explanation on answered */}
        {answered && card.explanation && (
          <div style={{ background: "#0e1a2e", border: "1px solid #1a3050", borderRadius: 12, padding: "14px 18px", marginTop: 16 }}>
            <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: "#4a7fa0", marginBottom: 6 }}>EXPLANATION</div>
            <div style={{ fontSize: 15, color: "#8ab8d8", lineHeight: 1.6 }}>{card.explanation}</div>
          </div>
        )}

        {/* Nav */}
        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <button className="btn" onClick={() => navigate(-1)} disabled={currentIndex === 0} style={{ flex: 1, background: "#12101c", border: "1px solid #1e1b2e", color: currentIndex === 0 ? "#3a3850" : "#9b97b8", padding: "11px", borderRadius: 10, fontSize: 15, fontFamily: "inherit" }}>
            ←
          </button>
          {allAnswered ? (
            <button className="btn" onClick={handleComplete} style={{ flex: 3, background: "linear-gradient(135deg, #22c55e, #16a34a)", color: "#fff", padding: "11px", borderRadius: 10, fontSize: 16, fontFamily: "inherit", fontWeight: 500 }}>
              Finish Quiz →
            </button>
          ) : currentIndex < cards.length - 1 ? (
            <button className="btn" onClick={() => navigate(1)} style={{ flex: 3, background: "#1e1b2e", border: "1px solid #2e2b3d", color: "#a78bfa", padding: "11px", borderRadius: 10, fontSize: 15, fontFamily: "inherit" }}>
              {answered ? "Next →" : "Skip →"}
            </button>
          ) : (
            <button className="btn" onClick={() => { const first = cards.findIndex((_, i) => !answers[i]); if (first >= 0) setCurrentIndex(first); }} style={{ flex: 3, background: "#1e1b2e", border: "1px solid #2e2b3d", color: "#f59e0b", padding: "11px", borderRadius: 10, fontSize: 15, fontFamily: "inherit" }}>
              {Object.keys(answers).length < cards.length ? "↩ Answer remaining" : "Review answers"}
            </button>
          )}
          <button className="btn" onClick={() => navigate(1)} disabled={currentIndex === cards.length - 1} style={{ flex: 1, background: "#12101c", border: "1px solid #1e1b2e", color: currentIndex === cards.length - 1 ? "#3a3850" : "#9b97b8", padding: "11px", borderRadius: 10, fontSize: 15, fontFamily: "inherit" }}>
            →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Flashcard Type ────────────────────────────────────────────────────────────
function FlashcardType({ card, flipped, setFlipped, showHint, setShowHint, answered, onRate, selfRating }) {
  return (
    <div>
      <div className="card-flip" style={{ height: 260 }} onClick={() => setFlipped(f => !f)}>
        <div className={`card-inner ${flipped ? "flipped" : ""}`} style={{ height: "100%" }}>
          <div className="card-face" style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 20, padding: "28px 32px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", cursor: "pointer" }}>
            <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4a4770", letterSpacing: "0.12em", marginBottom: 16 }}>QUESTION — tap to reveal</div>
            <div style={{ fontSize: 20, fontWeight: 400, textAlign: "center", lineHeight: 1.5, color: "#e8e6f0" }}>{card.question}</div>
            {card.hint && !showHint && !flipped && (
              <button className="btn" onClick={e => { e.stopPropagation(); setShowHint(true); }} style={{ marginTop: 18, background: "none", border: "1px dashed #2e2b3d", color: "#6b67a0", padding: "5px 14px", borderRadius: 20, fontSize: 13, fontFamily: "inherit" }}>
                💡 Hint
              </button>
            )}
            {showHint && card.hint && (
              <div style={{ marginTop: 14, padding: "8px 14px", background: "#1a1420", borderRadius: 8, fontSize: 14, color: "#9b7fba", textAlign: "center" }}>
                {card.hint}
              </div>
            )}
          </div>
          <div className="card-back card-face" style={{ background: "#0e0d1c", border: "1px solid #2e2b3d", borderRadius: 20, padding: "28px 32px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", cursor: "pointer" }}>
            <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4a6060", letterSpacing: "0.12em", marginBottom: 16 }}>ANSWER</div>
            <div style={{ fontSize: 20, fontWeight: 400, textAlign: "center", lineHeight: 1.5, color: "#a0e0c8" }}>{card.answer}</div>
          </div>
        </div>
      </div>
      {flipped && !selfRating && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, color: "#6b67a0", textAlign: "center", marginBottom: 12 }}>How well did you know this?</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8 }}>
            {[
              { r: 1, label: "Forgot", color: "#ef4444" },
              { r: 2, label: "Hard", color: "#f97316" },
              { r: 3, label: "Ok", color: "#f59e0b" },
              { r: 4, label: "Good", color: "#22c55e" },
              { r: 5, label: "Easy", color: "#10b981" },
            ].map(({ r, label, color }) => (
              <button key={r} className="btn" onClick={() => onRate(r)} style={{ background: "#12101c", border: `1px solid ${color}55`, borderRadius: 10, padding: "10px 6px", fontFamily: "inherit", color, fontSize: 12, textAlign: "center" }}>
                <div style={{ fontSize: 18, marginBottom: 2 }}>{"★".repeat(r)}</div>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {selfRating && (
        <div style={{ marginTop: 12, textAlign: "center", fontSize: 14, color: "#6b67a0" }}>
          Rated: {"★".repeat(selfRating)}{"☆".repeat(5 - selfRating)} — {selfRating >= 3 ? "✓ Counted as correct" : "✗ Needs more practice"}
        </div>
      )}
    </div>
  );
}

// ── MCQ Type ──────────────────────────────────────────────────────────────────
function MCQType({ card, answered, selectedAnswer, onSelect, showHint, setShowHint }) {
  return (
    <div>
      <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 20, padding: "28px 32px", marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4a4770", letterSpacing: "0.12em", marginBottom: 14 }}>QUESTION</div>
        <div style={{ fontSize: 20, fontWeight: 400, lineHeight: 1.5, color: "#e8e6f0", marginBottom: 16 }}>{card.question}</div>
        {card.hint && !showHint && !answered && (
          <button className="btn" onClick={() => setShowHint(true)} style={{ background: "none", border: "1px dashed #2e2b3d", color: "#6b67a0", padding: "5px 14px", borderRadius: 20, fontSize: 13, fontFamily: "inherit" }}>
            💡 Hint
          </button>
        )}
        {showHint && card.hint && (
          <div style={{ padding: "8px 14px", background: "#1a1420", borderRadius: 8, fontSize: 14, color: "#9b7fba" }}>{card.hint}</div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {card.options?.map((opt, i) => {
          const isSelected = selectedAnswer === opt;
          const isCorrect = opt === card.answer;
          let bg = "#12101c", border = "#1e1b2e", color = "#9b97b8";
          if (answered) {
            if (isCorrect) { bg = "#0f2a1a"; border = "#22c55e"; color = "#4ade80"; }
            else if (isSelected) { bg = "#2a0f0f"; border = "#ef4444"; color = "#f87171"; }
          } else if (isSelected) { bg = "#1a1729"; border = "#7c6fe0"; color = "#c5c2e0"; }
          return (
            <button key={i} className="btn" onClick={() => !answered && onSelect(opt)} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: "13px 18px", textAlign: "left", fontFamily: "inherit", fontSize: 15, color, transition: "all 0.2s", cursor: answered ? "default" : "pointer" }}>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, opacity: 0.6, marginRight: 10 }}>{String.fromCharCode(65 + i)}</span>
              {opt.replace(/^[A-D]\)\s*/, "")}
              {answered && isCorrect && <span style={{ float: "right" }}>✓</span>}
              {answered && isSelected && !isCorrect && <span style={{ float: "right" }}>✗</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── True/False Type ───────────────────────────────────────────────────────────
function TFType({ card, answered, selectedAnswer, onSelect, showHint, setShowHint }) {
  return (
    <div>
      <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 20, padding: "28px 32px", marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4a4770", letterSpacing: "0.12em", marginBottom: 14 }}>TRUE OR FALSE?</div>
        <div style={{ fontSize: 22, fontWeight: 400, lineHeight: 1.5, color: "#e8e6f0", marginBottom: 16 }}>{card.question}</div>
        {card.hint && !showHint && !answered && (
          <button className="btn" onClick={() => setShowHint(true)} style={{ background: "none", border: "1px dashed #2e2b3d", color: "#6b67a0", padding: "5px 14px", borderRadius: 20, fontSize: 13, fontFamily: "inherit" }}>
            💡 Hint
          </button>
        )}
        {showHint && card.hint && (
          <div style={{ padding: "8px 14px", background: "#1a1420", borderRadius: 8, fontSize: 14, color: "#9b7fba" }}>{card.hint}</div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {["True", "False"].map(opt => {
          const isSelected = selectedAnswer === opt;
          const isCorrect = opt.toLowerCase() === card.answer.toLowerCase();
          let bg = "#12101c", border = "#1e1b2e", color = "#9b97b8";
          if (answered) {
            if (isCorrect) { bg = "#0f2a1a"; border = "#22c55e"; color = "#4ade80"; }
            else if (isSelected && !isCorrect) { bg = "#2a0f0f"; border = "#ef4444"; color = "#f87171"; }
          } else if (isSelected) { bg = "#1a1729"; border = "#7c6fe0"; color = "#c5c2e0"; }
          return (
            <button key={opt} className="btn" onClick={() => !answered && onSelect(opt)} style={{ background: bg, border: `1px solid ${border}`, borderRadius: 16, padding: "22px", fontFamily: "inherit", fontSize: 20, color, transition: "all 0.2s", cursor: answered ? "default" : "pointer" }}>
              {opt === "True" ? "✓ True" : "✗ False"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Export helpers ────────────────────────────────────────────────────────────
function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV(cards, topic) {
  const rows = [["question", "answer", "explanation", "hint"]];
  cards.forEach(c => rows.push([c.question, c.answer, c.explanation || "", c.hint || ""]));
  const csv = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  downloadBlob(`${topic.replace(/\s+/g, "_")}_flashcards.csv`, csv, "text/csv;charset=utf-8");
}

// Anki's importer accepts a plain tab-separated file with one note (Front\tBack) per line.
// This is the simplest reliable path without needing a full .apkg (SQLite) builder.
function exportAnki(cards, topic) {
  const lines = cards.map(c => {
    const front = c.question.replace(/\t/g, " ").replace(/\n/g, "<br>");
    const back = [c.answer, c.explanation ? `<br><i>${c.explanation}</i>` : ""].join("").replace(/\t/g, " ").replace(/\n/g, "<br>");
    return `${front}\t${back}`;
  });
  downloadBlob(`${topic.replace(/\s+/g, "_")}_anki_import.txt`, lines.join("\n"), "text/plain;charset=utf-8");
}

function exportPDF(cards, topic) {
  const win = window.open("", "_blank");
  if (!win) return;
  const rows = cards.map((c, i) => `
    <div style="page-break-inside: avoid; margin-bottom: 18px; padding: 14px 18px; border: 1px solid #ddd; border-radius: 8px;">
      <div style="font-size: 12px; color: #888; margin-bottom: 6px;">Card ${i + 1}</div>
      <div style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">${c.question}</div>
      <div style="font-size: 14px; color: #333;"><strong>Answer:</strong> ${c.answer}</div>
      ${c.explanation ? `<div style="font-size: 13px; color: #555; margin-top: 6px;"><em>${c.explanation}</em></div>` : ""}
    </div>`).join("");
  win.document.write(`
    <html><head><title>${topic} — Flashcards</title>
    <style>body{font-family: Georgia, serif; max-width: 700px; margin: 30px auto; color: #222;} h1{font-size: 22px;}</style>
    </head><body>
    <h1>${topic} — Flashcards</h1>
    ${rows}
    <script>window.onload = () => window.print();</script>
    </body></html>`);
  win.document.close();
}

function ExportBar({ cards, topic, showToast }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 24, flexWrap: "wrap" }}>
      <button className="btn" onClick={() => { exportCSV(cards, topic); showToast?.("CSV downloaded ✓"); }} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
        ⬇ CSV
      </button>
      <button className="btn" onClick={() => { exportAnki(cards, topic); showToast?.("Anki-import file downloaded ✓"); }} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
        ⬇ Anki (.txt)
      </button>
      <button className="btn" onClick={() => exportPDF(cards, topic)} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
        ⬇ PDF
      </button>
    </div>
  );
}

// ── Result Screen ─────────────────────────────────────────────────────────────
function ResultScreen({ session, store, onNewQuiz, onHome, onViewStats, showToast }) {
  const topicStats = store.stats[session.topic];
  const isPersonalBest = session.score === (topicStats?.best);
  const emoji = session.score >= 90 ? "🏆" : session.score >= 75 ? "🎯" : session.score >= 50 ? "📚" : "💪";
  const correct = Object.values(session.answers).filter(a => session.quizType === "flashcard" ? a.rating >= 3 : a.correct).length;
  const timeMins = Math.floor((session.timeElapsed || 0) / 60);
  const timeSecs = (session.timeElapsed || 0) % 60;

  return (
    <div className="slide-up" style={{ maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>{emoji}</div>
      <h2 style={{ fontSize: 42, fontWeight: 300, letterSpacing: "-0.03em", marginBottom: 6 }}>
        {session.score >= 90 ? "Outstanding!" : session.score >= 75 ? "Great job!" : session.score >= 50 ? "Good effort!" : "Keep going!"}
      </h2>
      <div style={{ fontSize: 72, fontWeight: 300, color: session.score >= 75 ? "#a78bfa" : session.score >= 50 ? "#f59e0b" : "#ef4444", letterSpacing: "-0.04em", lineHeight: 1, marginBottom: 4 }}>
        {session.score}%
      </div>
      <div style={{ color: "#6b67a0", marginBottom: 8 }}>
        {correct}/{session.cards.length} correct · {session.topic}
      </div>
      <div style={{ color: "#a78bfa", fontSize: 14, marginBottom: 32 }}>
        ✦ +{correct * 10 + Math.round(session.score / 10)} XP earned
      </div>

      <ExportBar cards={session.cards} topic={session.topic} showToast={showToast} />

      {isPersonalBest && topicStats?.attempts > 1 && (
        <div style={{ background: "#1a1420", border: "1px solid #7c6fe044", borderRadius: 12, padding: "10px 20px", marginBottom: 20, color: "#a78bfa", fontSize: 14 }}>
          ✨ New personal best for this topic!
        </div>
      )}

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 28 }}>
        {[
          { label: "Time", value: `${timeMins}m ${timeSecs}s` },
          { label: "Difficulty", value: DIFFICULTIES[session.difficulty]?.label },
          { label: "Attempts", value: topicStats?.attempts || 1 },
        ].map(s => (
          <div key={s.label} style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 12, padding: "14px 10px" }}>
            <div style={{ fontSize: 18, fontWeight: 500, color: "#c5c2e0", marginBottom: 3 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#6b67a0", fontFamily: "'JetBrains Mono',monospace" }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* Topic history mini chart */}
      {topicStats?.history?.length > 1 && (
        <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 14, padding: "16px 20px", marginBottom: 24, textAlign: "left" }}>
          <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", marginBottom: 12 }}>SCORE HISTORY — {session.topic}</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 50 }}>
            {topicStats.history.slice(-10).map((h, i) => (
              <div key={i} style={{ flex: 1, background: i === topicStats.history.slice(-10).length - 1 ? "#7c6fe0" : "#2e2b3d", borderRadius: "3px 3px 0 0", height: `${h.score}%`, minHeight: 4, transition: "height 0.5s" }} title={`${h.score}%`} />
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn" onClick={onHome} style={{ flex: 1, background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "12px", borderRadius: 10, fontSize: 15, fontFamily: "inherit" }}>
          Home
        </button>
        <button className="btn" onClick={onViewStats} style={{ flex: 1, background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "12px", borderRadius: 10, fontSize: 15, fontFamily: "inherit" }}>
          Stats
        </button>
        <button className="btn" onClick={onNewQuiz} style={{ flex: 2, background: "linear-gradient(135deg, #7c6fe0, #a78bfa)", color: "#fff", padding: "12px", borderRadius: 10, fontSize: 15, fontFamily: "inherit", fontWeight: 500 }}>
          New Quiz →
        </button>
      </div>
    </div>
  );
}

// ── History Screen ────────────────────────────────────────────────────────────
function HistoryScreen({ store, persist, onResume, showToast }) {
  const [filter, setFilter] = useState("all");
  const sessions = store.sessions.filter(s => filter === "all" ? true : s.status === filter);

  const deleteSession = (id) => {
    persist(prev => ({ ...prev, sessions: prev.sessions.filter(s => s.id !== id) }));
    showToast("Session deleted");
  };

  return (
    <div className="fade-in">
      <h2 style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", marginBottom: 6 }}>Quiz Sessions</h2>
      <p style={{ color: "#6b67a0", marginBottom: 24, fontSize: 15 }}>{store.sessions.length} sessions saved</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {[["all", "All"], ["completed", "Completed"], ["in-progress", "In Progress"]].map(([v, l]) => (
          <button key={v} className="btn" onClick={() => setFilter(v)} style={{ background: filter === v ? "#1e1b2e" : "#12101c", border: `1px solid ${filter === v ? "#7c6fe0" : "#1e1b2e"}`, color: filter === v ? "#c5c2e0" : "#6b67a0", padding: "7px 16px", borderRadius: 20, fontSize: 13, fontFamily: "inherit" }}>
            {l}
          </button>
        ))}
      </div>

      {sessions.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#4a4770" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
          <div>No sessions found</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sessions.map(s => {
            const answered = Object.keys(s.answers || {}).length;
            return (
              <div key={s.id} style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 14, padding: "16px 20px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                      {s.topic}
                      <span className="tag" style={{ background: s.status === "completed" ? "#0f2a1a" : "#1a1420", color: s.status === "completed" ? "#4ade80" : "#f59e0b", border: `1px solid ${s.status === "completed" ? "#22c55e44" : "#f59e0b44"}`, fontSize: 11 }}>
                        {s.status === "completed" ? "✓ done" : "⟳ in progress"}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "#6b67a0", display: "flex", gap: 14, flexWrap: "wrap" }}>
                      <span>{DIFFICULTIES[s.difficulty]?.label}</span>
                      <span>{answered}/{s.cards?.length || 0} cards</span>
                      {s.status === "completed" && <span style={{ color: "#a78bfa" }}>Score: {s.score}%</span>}
                      <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {s.status === "in-progress" && (
                      <button className="btn" onClick={() => onResume(s)} style={{ background: "#1a1729", border: "1px solid #7c6fe0", color: "#a78bfa", padding: "6px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                        Resume
                      </button>
                    )}
                    {s.status === "completed" && (
                      <button className="btn" onClick={() => { exportCSV(s.cards, s.topic); showToast?.("CSV downloaded ✓"); }} title="Export as CSV" style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "6px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                        ⬇
                      </button>
                    )}
                    <button className="btn" onClick={() => deleteSession(s.id)} style={{ background: "#1a0f0f", border: "1px solid #3d1515", color: "#f87171", padding: "6px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}>
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Stats Screen ──────────────────────────────────────────────────────────────
function StatsScreen({ store, user }) {
  const [selectedTopic, setSelectedTopic] = useState(Object.keys(store.stats)[0] || null);
  const topics = Object.keys(store.stats);

  // XP / level / streak
  const xp = store.xp || 0;
  const streak = store.streak?.count || 0;
  const totalSessions = (store.sessions || []).length;
  const level = Math.floor(xp / 500) + 1;
  const xpIntoLevel = xp % 500;
  const xpPct = (xpIntoLevel / 500) * 100;

  const allStats = topics.map(t => ({
    topic: t, ...store.stats[t],
    avg: store.stats[t].attempts > 0 ? Math.round(store.stats[t].totalScore / store.stats[t].attempts) : 0,
  })).sort((a, b) => b.avg - a.avg);

  const topicStat = selectedTopic ? store.stats[selectedTopic] : null;
  const scoreTimeline = (topicStat?.history || [])
    .map((entry, index) => ({
      id: `${selectedTopic}-${entry.date || index}`,
      score: Math.max(0, Math.min(100, Number(entry.score))),
      completedAt: Number(entry.date),
    }))
    .filter(entry => Number.isFinite(entry.score) && Number.isFinite(entry.completedAt))
    .sort((a, b) => a.completedAt - b.completedAt)
    .slice(-20);
  const timelineScores = scoreTimeline.map(entry => entry.score);
  const timelinePoints = scoreTimeline.map((session, index) => {
    const x = scoreTimeline.length === 1 ? 50 : (index / (scoreTimeline.length - 1)) * 100;
    const y = 92 - (session.score / 100) * 82;
    return { session, x, y };
  });
  const timelinePath = timelinePoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");

  const StatCard = ({ label, value, color }) => (
    <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 14, padding: "16px 20px", flex: 1, minWidth: 100 }}>
      <div style={{ fontSize: 26, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 11, color: "#6b67a0", marginTop: 4, fontFamily: "'JetBrains Mono',monospace" }}>{label}</div>
    </div>
  );

  return (
    <div className="fade-in">
      <h2 style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", marginBottom: 4 }}>Stats</h2>
      <p style={{ color: "#6b67a0", marginBottom: 24, fontSize: 15 }}>
        {user ? user.email : "Your performance across all topics"}
      </p>

      {/* ── XP / level / streak row ── */}
      {user && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <StatCard label="TOTAL XP"  value={xp}             color="#a78bfa" />
            <StatCard label="LEVEL"     value={level}           color="#7c6fe0" />
            <StatCard label="STREAK"    value={`${streak} 🔥`}  color="#f59e0b" />
            <StatCard label="SESSIONS"  value={totalSessions}   color="#22c55e" />
          </div>

          {/* XP progress bar */}
          <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 14, padding: "16px 20px", marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: "#9b97b8" }}>Level {level} → Level {level + 1}</span>
              <span style={{ fontSize: 13, color: "#6b67a0", fontFamily: "'JetBrains Mono',monospace" }}>{xpIntoLevel} / 500 XP</span>
            </div>
            <div style={{ background: "#1e1b2e", borderRadius: 8, height: 10, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${xpPct}%`, background: "linear-gradient(90deg, #7c6fe0, #a78bfa)", borderRadius: 8, transition: "width 0.6s" }} />
            </div>
          </div>
        </>
      )}

      {topics.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
          <h2 style={{ fontSize: 28, fontWeight: 300, marginBottom: 10 }}>No stats yet</h2>
          <p style={{ color: "#6b67a0" }}>Complete a quiz to see your progress here.</p>
        </div>
      ) : (
        <>
          {/* ── Topic leaderboard ── */}
          <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, overflow: "hidden", marginBottom: 24 }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #1e1b2e", fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.1em" }}>
              ALL TOPICS — RANKED BY AVERAGE SCORE
            </div>
            {allStats.map((s, i) => (
              <button key={s.topic} className="btn" onClick={() => setSelectedTopic(s.topic)}
                style={{ width: "100%", background: selectedTopic === s.topic ? "#1a1729" : "transparent", borderBottom: "1px solid #1e1b2e", borderTop: "none", borderLeft: "none", borderRight: "none", padding: "14px 20px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit" }}>
                <div style={{ width: 24, textAlign: "center", fontSize: 14, color: i < 3 ? ["#f59e0b","#9b97b8","#c4743e"][i] : "#4a4770", fontFamily: "'JetBrains Mono',monospace" }}>
                  {i < 3 ? ["🥇","🥈","🥉"][i] : `${i+1}.`}
                </div>
                <div style={{ flex: 1, textAlign: "left" }}>
                  <div style={{ fontSize: 15, color: "#e8e6f0", marginBottom: 3 }}>{s.topic}</div>
                  <div style={{ fontSize: 12, color: "#6b67a0" }}>{s.attempts} attempt{s.attempts !== 1 ? "s" : ""} · Best: {s.best}%</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 20, fontWeight: 500, color: s.avg >= 75 ? "#a78bfa" : s.avg >= 50 ? "#f59e0b" : "#ef4444" }}>{s.avg}%</div>
                  <div style={{ fontSize: 11, color: "#4a4770" }}>avg</div>
                </div>
                <div style={{ width: 60 }}>
                  <div style={{ background: "#1e1b2e", borderRadius: 3, height: 6, overflow: "hidden" }}>
                    <div style={{ height: "100%", background: s.avg >= 75 ? "#7c6fe0" : s.avg >= 50 ? "#f59e0b" : "#ef4444", width: `${s.avg}%`, borderRadius: 3, transition: "width 0.8s" }} />
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* ── Topic detail ── */}
          {topicStat && selectedTopic && (
            <div style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 16, padding: "20px 24px" }}>
              <h3 style={{ fontSize: 20, fontWeight: 400, marginBottom: 18 }}>{selectedTopic}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 20 }}>
                {[
                  { label: "ATTEMPTS", value: topicStat.attempts },
                  { label: "BEST",     value: `${topicStat.best}%` },
                  { label: "AVERAGE",  value: `${topicStat.attempts > 0 ? Math.round(topicStat.totalScore / topicStat.attempts) : 0}%` },
                ].map(s => (
                  <div key={s.label} style={{ background: "#0e0d1c", borderRadius: 10, padding: "12px", textAlign: "center" }}>
                    <div style={{ fontSize: 22, fontWeight: 500, color: "#c5c2e0", marginBottom: 2 }}>{s.value}</div>
                    <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0" }}>{s.label}</div>
                  </div>
                ))}
              </div>
              {scoreTimeline.length > 0 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontFamily: "'JetBrains Mono',monospace", color: "#6b67a0", letterSpacing: "0.08em" }}>SCORE OVER TIME</div>
                    <div style={{ fontSize: 12, color: "#9b97b8" }}>Latest: <strong style={{ color: "#a78bfa" }}>{timelineScores[timelineScores.length - 1]}%</strong></div>
                  </div>
                  <div style={{ position: "relative", height: 190, padding: "8px 0 28px 30px" }}>
                    <div style={{ position: "absolute", inset: "8px 0 28px 30px", background: "repeating-linear-gradient(to bottom, #1e1b2e 0, #1e1b2e 1px, transparent 1px, transparent 25%)" }} />
                    <div style={{ position: "absolute", left: 0, top: 4, bottom: 30, display: "flex", flexDirection: "column", justifyContent: "space-between", color: "#6b67a0", fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>
                      <span>100%</span><span>50%</span><span>0%</span>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", left: 30, right: 0, top: 8, width: "calc(100% - 30px)", height: "calc(100% - 38px)", overflow: "visible" }} aria-label="Quiz score over time">
                      <path d={timelinePath} fill="none" stroke="#7c6fe0" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
                      {timelinePoints.map(({ session, x, y }, index) => <circle key={`${session.id || index}-${session.completedAt}`} cx={x} cy={y} r="2.8" fill="#f0c674" stroke="#12101c" strokeWidth="1" vectorEffect="non-scaling-stroke"><title>{`${session.score}% · ${new Date(session.completedAt || session.createdAt).toLocaleDateString()}`}</title></circle>)}
                    </svg>
                    <div style={{ position: "absolute", left: 30, right: 0, bottom: 0, display: "flex", justifyContent: "space-between", color: "#6b67a0", fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>
                      <span>{new Date(scoreTimeline[0].completedAt || scoreTimeline[0].createdAt).toLocaleDateString()}</span>
                      <span>{new Date(scoreTimeline[scoreTimeline.length - 1].completedAt || scoreTimeline[scoreTimeline.length - 1].createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ color: "#6b67a0", fontSize: 12, marginTop: 2 }}>Each point is one completed quiz, ordered by completion date. Showing the latest {scoreTimeline.length}.</div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
// ── Review Screen (Spaced Repetition) ─────────────────────────────────────────
// IMPORTANT: this screen keeps its own `reviewIndex` state, completely separate
// from any quiz-session `currentIndex`. Mixing the two up is a classic bug
// (jumping mid-review can show the wrong card) — this component never reads
// or writes any other screen's index state, only its own.
function ReviewScreen({ store, persist, onBack, showToast }) {
  const dueCards = Object.entries(store.srs || {})
    .filter(([, c]) => c.due <= Date.now())
    .map(([key, c]) => ({ key, ...c }));

  const [reviewIndex, setReviewIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  if (dueCards.length === 0) {
    return (
      <div className="fade-in" style={{ textAlign: "center", padding: "80px 20px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <h2 style={{ fontSize: 28, fontWeight: 300, marginBottom: 10 }}>All caught up!</h2>
        <p style={{ color: "#6b67a0", marginBottom: 24 }}>No cards are due for review right now.</p>
        <button className="btn" onClick={onBack} style={{ background: "#12101c", border: "1px solid #1e1b2e", color: "#9b97b8", padding: "10px 24px", borderRadius: 10, fontSize: 14, fontFamily: "inherit" }}>← Back home</button>
      </div>
    );
  }

  // Clamp defensively in case cards are rated away mid-session and the list shrinks.
  const safeIndex = Math.min(reviewIndex, dueCards.length - 1);
  const card = dueCards[safeIndex];

  const INTERVAL_DAYS = [0, 1, 2, 4, 7, 14];

  const rate = (rating) => {
    persist(prev => {
      const srs = { ...prev.srs };
      const existing = srs[card.key];
      const box = rating >= 3 ? Math.min((existing?.box || 0) + 1, 5) : 1;
      srs[card.key] = { ...existing, box, due: Date.now() + INTERVAL_DAYS[box] * 86400000, lastSeen: Date.now() };
      return { ...prev, srs };
    });
    setFlipped(false);
    setReviewIndex(i => Math.min(i, Math.max(dueCards.length - 2, 0)));
    showToast?.(rating >= 3 ? "Nice — see you next interval." : "No worries, back in the box.");
  };

  return (
    <div className="fade-in" style={{ maxWidth: 520, margin: "0 auto" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#6b67a0", cursor: "pointer", fontSize: 14, fontFamily: "inherit", marginBottom: 20 }}>← Back</button>
      <h2 style={{ fontSize: 28, fontWeight: 300, marginBottom: 6 }}>Review Due</h2>
      <p style={{ color: "#6b67a0", marginBottom: 20, fontSize: 14 }}>{dueCards.length} card{dueCards.length !== 1 ? "s" : ""} due · {card.topic}</p>

      <div className="card-flip" style={{ height: 240 }} onClick={() => setFlipped(f => !f)}>
        <div className={`card-inner ${flipped ? "flipped" : ""}`} style={{ height: "100%" }}>
          <div className="card-face" style={{ background: "#12101c", border: "1px solid #1e1b2e", borderRadius: 20, padding: "26px 30px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", cursor: "pointer" }}>
            <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4a4770", letterSpacing: "0.12em", marginBottom: 14 }}>QUESTION — tap to reveal</div>
            <div style={{ fontSize: 19, textAlign: "center", lineHeight: 1.5, color: "#e8e6f0" }}>{card.question}</div>
          </div>
          <div className="card-back card-face" style={{ background: "#0e0d1c", border: "1px solid #2e2b3d", borderRadius: 20, padding: "26px 30px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", cursor: "pointer" }}>
            <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", color: "#4a6060", letterSpacing: "0.12em", marginBottom: 14 }}>ANSWER</div>
            <div style={{ fontSize: 19, textAlign: "center", lineHeight: 1.5, color: "#a0e0c8" }}>{card.answer}</div>
          </div>
        </div>
      </div>

      {flipped && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, color: "#6b67a0", textAlign: "center", marginBottom: 12 }}>How well did you know this?</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8 }}>
            {[
              { r: 1, label: "Forgot", color: "#ef4444" },
              { r: 2, label: "Hard", color: "#f97316" },
              { r: 3, label: "Ok", color: "#f59e0b" },
              { r: 4, label: "Good", color: "#22c55e" },
              { r: 5, label: "Easy", color: "#10b981" },
            ].map(({ r, label, color }) => (
              <button key={r} className="btn" onClick={() => rate(r)} style={{ background: "#12101c", border: `1px solid ${color}55`, borderRadius: 10, padding: "10px 6px", fontFamily: "inherit", color, fontSize: 12 }}>
                <div style={{ fontSize: 18, marginBottom: 2 }}>{"★".repeat(r)}</div>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 4, marginTop: 24, flexWrap: "wrap" }}>
        {dueCards.map((_, i) => (
          <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: i === safeIndex ? "#7c6fe0" : "#1e1b2e" }} />
        ))}
      </div>
    </div>
  );
}

// ── Admin Screen ───────────────────────────────────────────────────────────────
// Only reachable if the signed-in user's JWT carries isAdmin:true (checked server-side
// on every request too — the frontend gate is just for a clean UI, not the real security boundary).
function AdminScreen({ token, currentUserId, showToast }) {
  const [users, setUsers] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    Promise.all([apiAdminGetUsers(token), apiAdminGetStats(token)])
      .then(([u, s]) => { setUsers(u); setStats(s); })
      .catch(e => setError(e.message));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (u) => {
    if (!window.confirm(`Delete ${u.email}? This removes their account and all their data permanently.`)) return;
    setBusyId(u.id);
    try {
      await apiAdminDeleteUser(token, u.id);
      showToast?.(`${u.email} deleted.`);
      load();
    } catch (e) {
      showToast?.(e.message, "error");
    } finally {
      setBusyId(null);
    }
  };

  if (error) {
    return <div style={{ color: "#f87171", textAlign: "center", padding: "60px 0" }}>{error}</div>;
  }
  if (!users) {
    return (
      <div style={{ textAlign: "center", padding: "80px 0", color: "#6b67a0" }}>
        <div className="spinner" style={{ margin: "0 auto 14px" }} />
        Loading admin data…
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ fontFamily: "'JetBrains Mono', monospace", background: "#06090a", minHeight: "calc(100vh - 65px)", padding: "0 0 40px" }}>
      {/* Distinct banner so this never looks like it's part of the normal app */}
      <div style={{ background: "#0d1f12", borderBottom: "2px solid #22c55e", padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 11, color: "#4ade80", letterSpacing: "0.15em", marginBottom: 4 }}>{"// INTERNAL TOOLING — NOT PART OF THE STUDENT-FACING APP"}</div>
          <h2 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", color: "#e2fbe9", margin: 0 }}>{"<> Developer Mode"}</h2>
        </div>
        <div style={{ fontSize: 12, color: "#6b9b7a" }}>signed in as <span style={{ color: "#4ade80" }}>{currentUserId ? "admin" : ""}</span></div>
      </div>

      <div style={{ padding: "28px 32px 0" }}>
        <p style={{ color: "#6b9b7a", fontSize: 14, marginBottom: 24 }}>Raw account + usage data for this deployment. Actions here bypass the normal app UI entirely.</p>

        {stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 28 }}>
            {[
              { label: "total_accounts", value: stats.totalUsers },
              { label: "total_quiz_sessions", value: stats.totalSessions },
              { label: "total_xp_earned", value: stats.totalXp },
            ].map(s => (
              <div key={s.label} style={{ background: "#0a1410", border: "1px solid #1a3324", borderRadius: 8, padding: "16px" }}>
                <div style={{ fontSize: 26, fontWeight: 600, color: "#4ade80" }}>{s.value}</div>
                <div style={{ fontSize: 12, color: "#5a8a6a", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: "#0a1410", border: "1px solid #1a3324", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, padding: "10px 16px", fontSize: 11, color: "#5a8a6a", letterSpacing: "0.06em", borderBottom: "1px solid #1a3324" }}>
            <span>email</span><span>topics</span><span>sessions</span><span>xp</span><span>streak</span><span></span>
          </div>
          {users.map(u => {
            return (
            <div key={u.id} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto", gap: 8, padding: "12px 16px", fontSize: 13, borderBottom: "1px solid #1a3324", alignItems: "center" }}>
              <span style={{ color: "#d4f5df", display: "flex", alignItems: "center", gap: 6 }}>
                {u.email}
                {u.isProtected && <span style={{ fontSize: 10, color: "#f59e0b" }} title="Matches ADMIN_EMAIL — protected from deletion">(your ADMIN_EMAIL account)</span>}
              </span>
              <span style={{ color: "#8ab89a" }}>{u.topics}</span>
              <span style={{ color: "#8ab89a" }}>{u.sessions}</span>
              <span style={{ color: "#8ab89a" }}>{u.xp}</span>
              <span style={{ color: "#8ab89a" }}>{u.streak}</span>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="btn" disabled={busyId === u.id || u.isProtected} onClick={() => handleDelete(u)} title={u.isProtected ? "Protected — can't be deleted" : "Delete account"}
                  style={{ background: "#1a0a0a", border: "1px solid #3d1a1a", color: "#f87171", padding: "5px 10px", borderRadius: 4, fontSize: 11, fontFamily: "inherit", opacity: u.isProtected ? 0.4 : 1 }}>
                  delete
                </button>
              </div>
            </div>
          );})}
          {users.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#5a8a6a" }}>No accounts yet.</div>}
        </div>

        <div style={{ marginTop: 20, padding: "12px 16px", background: "#0a1410", border: "1px solid #1a3324", borderRadius: 8, fontSize: 12, color: "#5a8a6a", lineHeight: 1.6 }}>
          This dashboard is reachable only through <span style={{ color: "#8ab89a" }}>/developer</span>, using the fixed <span style={{ color: "#8ab89a" }}>ADMIN_EMAIL</span> / <span style={{ color: "#8ab89a" }}>ADMIN_PASSWORD</span> in <span style={{ color: "#8ab89a" }}>server/.env</span> — no regular account, promoted or otherwise, can reach any endpoint under <span style={{ color: "#8ab89a" }}>/api/admin/*</span>. There is no promote/demote here anymore; a regular account can never carry developer access.
        </div>
      </div>
    </div>
  );
}
