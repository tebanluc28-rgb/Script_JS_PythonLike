import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";
import multer from "multer";
import dotenv from "dotenv";
import { downloadDriveFolder, extractFolderId } from "./drive_download.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ override: false });

const app = express();
const PORT = process.env.PORT || 3200;
const APP_ROOT = process.env.APP_ROOT || process.cwd();
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const STORAGE_DIR = process.env.WEB_STORAGE_DIR || path.join(DATA_DIR, "storage");
const UPLOAD_BASE_DIR = process.env.UPLOAD_BASE_DIR || path.join(STORAGE_DIR, "incoming", "obras");
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "2048", 10);
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const COOKIE_SECURE = (process.env.COOKIE_SECURE || "0") === "1";
const SECRETS_FILE = process.env.SECRETS_FILE || path.join(DATA_DIR, "secrets.json");
const QUEUE_STATE_FILE = process.env.QUEUE_STATE_FILE || path.join(DATA_DIR, "queue_state.json");
const UPLOAD_PROGRESS_FILE = process.env.UPLOAD_PROGRESS_FILE || path.join(DATA_DIR, "upload_progress.json");

const NODE_EXE = fs.existsSync(path.join(__dirname, "nodejs-portable", "node.exe"))
  ? path.join(__dirname, "nodejs-portable", "node.exe")
  : "node";

const PW_BROWSERS_DIR = path.join(__dirname, "pw-browsers");

const jobs = new Map();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function buildPlaywrightEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  try {
    const hasLocalBrowsers =
      fs.existsSync(PW_BROWSERS_DIR) &&
      fs.readdirSync(PW_BROWSERS_DIR).some((entry) => /^chromium/i.test(entry));

    if (hasLocalBrowsers) {
      env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS_DIR;
    } else {
      delete env.PLAYWRIGHT_BROWSERS_PATH;
    }
  } catch {
    delete env.PLAYWRIGHT_BROWSERS_PATH;
  }
  return env;
}

function safeJoin(base, target) {
  const cleaned = String(target || "").replace(/^[\\/]+/, "");
  const full = path.normalize(path.join(base, cleaned));
  if (!full.startsWith(path.normalize(base))) return base;
  return full;
}

function readSecrets() {
  let secrets = {};
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const raw = fs.readFileSync(SECRETS_FILE, "utf8");
      secrets = JSON.parse(raw) || {};
    }
  } catch {
    secrets = {};
  }
  // Fallback a variables de entorno para reanudación si no hay secrets.json
  if (!secrets.username) secrets.username = process.env.SITE_USERNAME || process.env.USERNAME || "";
  if (!secrets.password) secrets.password = process.env.SITE_PASSWORD || process.env.PASSWORD || "";
  if (!secrets.apiKey) secrets.apiKey = process.env.XENFORO_API_KEY || "";
  if (!secrets.apiUser) secrets.apiUser = process.env.XENFORO_API_USER || "";
  return secrets;
}

function writeSecrets(data) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2), "utf8");
}



// ===== Persistencia de la cola entre reinicios del servidor =====
function saveQueueState() {
  try {
    const state = {};
    for (const [sid, job] of jobs) {
      const queue = Array.isArray(job.queue) ? job.queue : [];
      const current = job.currentPayload || null;
      if (queue.length > 0 || current) {
        state[sid] = { queue, current };
      }
    }
    fs.writeFileSync(QUEUE_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[WARN] No se pudo guardar estado de cola:", e.message);
  }
}

function loadQueueState() {
  try {
    if (!fs.existsSync(QUEUE_STATE_FILE)) return {};
    const raw = fs.readFileSync(QUEUE_STATE_FILE, "utf8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

const _savedQueues = loadQueueState();

function normalizeProgressChapterList(values) {
  const unique = new Set();
  for (const val of Array.isArray(values) ? values : []) {
    const token = normalizeChapterTokenForProgress(val);
    if (token) unique.add(token);
  }
  return Array.from(unique).sort(compareChapterTokens);
}

function compareChapterTokens(a, b) {
  const tokenA = normalizeChapterTokenForProgress(a);
  const tokenB = normalizeChapterTokenForProgress(b);
  if (!tokenA && !tokenB) return 0;
  if (!tokenA) return 1;
  if (!tokenB) return -1;

  const [intA, decA = ""] = tokenA.split(".");
  const [intB, decB = ""] = tokenB.split(".");
  const intDiff = parseInt(intA, 10) - parseInt(intB, 10);
  if (intDiff !== 0) return intDiff;

  if (decA === decB) return 0;
  if (!decA) return -1;
  if (!decB) return 1;

  const numericDecDiff = parseInt(decA, 10) - parseInt(decB, 10);
  if (numericDecDiff !== 0) return numericDecDiff;
  if (decA.length !== decB.length) return decA.length - decB.length;
  return decA.localeCompare(decB);
}

function normalizeProgressEntry(key, entry = {}) {
  const completedChapters = normalizeProgressChapterList(entry.completedChapters);
  const lastAttemptedChapter = normalizeChapterTokenForProgress(entry.lastAttemptedChapter);
  const lastFailedChapter = normalizeChapterTokenForProgress(entry.lastFailedChapter);
  return {
    key,
    resourceUrl: String(entry.resourceUrl || ""),
    rootDir: String(entry.rootDir || ""),
    rangeStart: entry.rangeStart === undefined || entry.rangeStart === null ? "" : String(entry.rangeStart),
    rangeEnd: entry.rangeEnd === undefined || entry.rangeEnd === null ? "" : String(entry.rangeEnd),
    status: String(entry.status || "idle"),
    completedChapters,
    minChapter: completedChapters.length ? completedChapters[0] : null,
    maxChapter: completedChapters.length ? completedChapters[completedChapters.length - 1] : null,
    lastCompletedChapter: completedChapters.length ? completedChapters[completedChapters.length - 1] : null,
    lastAttemptedChapter,
    lastFailedChapter,
    startedAt: entry.startedAt || null,
    updatedAt: entry.updatedAt || null,
    lastRunStartedAt: entry.lastRunStartedAt || null,
    lastRunEndedAt: entry.lastRunEndedAt || null,
    lastSid: entry.lastSid || null,
    notifiedAt: entry.notifiedAt || null,
  };
}

function saveUploadProgressState() {
  try {
    const state = {};
    for (const [key, entry] of Object.entries(_uploadProgressState)) {
      state[key] = normalizeProgressEntry(key, entry);
    }
    fs.writeFileSync(UPLOAD_PROGRESS_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[WARN] No se pudo guardar progreso de subida:", e.message);
  }
}

function loadUploadProgressState() {
  try {
    if (!fs.existsSync(UPLOAD_PROGRESS_FILE)) return {};
    const raw = fs.readFileSync(UPLOAD_PROGRESS_FILE, "utf8");
    const parsed = JSON.parse(raw) || {};
    const out = {};
    for (const [key, entry] of Object.entries(parsed)) {
      const normalized = normalizeProgressEntry(key, entry);
      if (normalized.status === "running" || normalized.status === "paused") {
        normalized.status = "interrupted";
      }
      out[key] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

const _uploadProgressState = loadUploadProgressState();
saveUploadProgressState();

function buildUploadProgressKey(payload = {}) {
  const seed = JSON.stringify({
    resourceUrl: String(payload.resourceUrl || "").trim(),
    rootDir: String(payload.rootDir || "").trim(),
    rangeStart: payload.rangeStart === undefined || payload.rangeStart === null ? "" : String(payload.rangeStart).trim(),
    rangeEnd: payload.rangeEnd === undefined || payload.rangeEnd === null ? "" : String(payload.rangeEnd).trim(),
  });
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 20);
}

function getOrCreateUploadProgress(payload = {}, sid = null) {
  const key = buildUploadProgressKey(payload);
  const now = new Date().toISOString();
  const existing = _uploadProgressState[key];
  const shouldResumeExisting = existing && ["running", "paused", "interrupted", "error"].includes(existing.status);

  const entry = shouldResumeExisting
    ? normalizeProgressEntry(key, existing)
    : normalizeProgressEntry(key, {
      resourceUrl: payload.resourceUrl,
      rootDir: payload.rootDir,
      rangeStart: payload.rangeStart,
      rangeEnd: payload.rangeEnd,
      completedChapters: [],
    });

  if (!entry.startedAt || !shouldResumeExisting) entry.startedAt = now;
  entry.resourceUrl = String(payload.resourceUrl || entry.resourceUrl || "");
  entry.rootDir = String(payload.rootDir || entry.rootDir || "");
  entry.rangeStart = payload.rangeStart === undefined || payload.rangeStart === null ? "" : String(payload.rangeStart);
  entry.rangeEnd = payload.rangeEnd === undefined || payload.rangeEnd === null ? "" : String(payload.rangeEnd);
  entry.status = "running";
  entry.updatedAt = now;
  entry.lastRunStartedAt = now;
  entry.lastSid = sid || entry.lastSid || null;
  _uploadProgressState[key] = entry;
  saveUploadProgressState();
  return entry;
}

function updateUploadProgressStatus(key, status, extra = {}) {
  if (!key || !_uploadProgressState[key]) return;
  const now = new Date().toISOString();
  const entry = normalizeProgressEntry(key, { ..._uploadProgressState[key], ...extra, status, updatedAt: now });
  if (["done", "error", "stopped", "interrupted", "notified"].includes(status)) {
    entry.lastRunEndedAt = now;
  }
  if (status === "notified") {
    entry.notifiedAt = now;
  }
  _uploadProgressState[key] = entry;
  saveUploadProgressState();
}

function recordCompletedChapterInProgress(key, rawChapter) {
  if (!key || !_uploadProgressState[key]) return;
  const entry = _uploadProgressState[key];
  const token = normalizeChapterTokenForProgress(rawChapter);
  if (!token) return;
  const chapters = normalizeProgressChapterList([...(entry.completedChapters || []), token]);
  entry.completedChapters = chapters;
  entry.minChapter = chapters.length ? chapters[0] : null;
  entry.maxChapter = chapters.length ? chapters[chapters.length - 1] : null;
  entry.lastCompletedChapter = chapters.length ? chapters[chapters.length - 1] : null;
  entry.lastAttemptedChapter = token;
  if (entry.lastFailedChapter === token) entry.lastFailedChapter = null;
  entry.updatedAt = new Date().toISOString();
  _uploadProgressState[key] = entry;
  saveUploadProgressState();
}

function recordAttemptedChapterInProgress(key, rawChapter, status = "attempt") {
  if (!key || !_uploadProgressState[key]) return;
  const entry = _uploadProgressState[key];
  const token = normalizeChapterTokenForProgress(rawChapter);
  if (!token) return;
  entry.lastAttemptedChapter = token;
  if (status === "failed") {
    entry.lastFailedChapter = token;
  } else if (status === "completed" && entry.lastFailedChapter === token) {
    entry.lastFailedChapter = null;
  }
  entry.updatedAt = new Date().toISOString();
  _uploadProgressState[key] = entry;
  saveUploadProgressState();
}

function resolveProgressChapter(key, chapter, action = "manual") {
  if (!key || !_uploadProgressState[key]) return null;
  const entry = normalizeProgressEntry(key, _uploadProgressState[key]);
  const token = normalizeChapterTokenForProgress(chapter);
  if (!token) return null;
  const completedChapters = normalizeProgressChapterList([...(entry.completedChapters || []), token]);
  entry.completedChapters = completedChapters;
  entry.minChapter = completedChapters.length ? completedChapters[0] : null;
  entry.maxChapter = completedChapters.length ? completedChapters[completedChapters.length - 1] : null;
  entry.lastCompletedChapter = completedChapters.length ? completedChapters[completedChapters.length - 1] : null;
  entry.status = action === "skip" ? "skipped-forward" : "manual-fixed";
  entry.updatedAt = new Date().toISOString();
  _uploadProgressState[key] = entry;
  saveUploadProgressState();
  return {
    ...entry,
    nextPendingChapter: computeNextPendingChapter(entry),
  };
}

function clearEnvCredentialKeys() {
  const envPath = path.join(APP_ROOT, ".env");
  if (!fs.existsSync(envPath)) return { ok: true, envFound: false };

  const keys = ["SITE_USERNAME", "SITE_PASSWORD", "USERNAME", "PASSWORD"];
  const raw = fs.readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = lines.map((line) => {
    for (const key of keys) {
      const re = new RegExp(`^\\s*${key}\\s*=`);
      if (re.test(line)) return `${key}=`;
    }
    return line;
  });
  fs.writeFileSync(envPath, out.join("\n"), "utf8");
  return { ok: true, envFound: true };
}

function toNumberMaybe(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(String(val).replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function normalizeChapterTokenForProgress(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const m = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const intPart = String(parseInt(m[1], 10));
  return m[2] !== undefined ? `${intPart}.${m[2]}` : intPart;
}

function extractChapterTokenForProgress(text) {
  const original = String(text || "").trim();
  if (!original) return null;
  const normalized = original
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const byCap = normalized.match(/\b(?:cap(?:itulo)?|chapter)\s*([0-9]+(?:[.,][0-9]+)?)/i);
  if (byCap) return normalizeChapterTokenForProgress(byCap[1]);
  const firstNum = original.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (firstNum) return normalizeChapterTokenForProgress(firstNum[1]);
  return null;
}

function resolveRootDirPath(rootDir) {
  if (!rootDir) return "";
  if (fs.existsSync(rootDir)) return rootDir;
  const incomingPath = safeJoin(UPLOAD_BASE_DIR, rootDir);
  return fs.existsSync(incomingPath) ? incomingPath : rootDir;
}

function listChapterNumbersFromRoot(rootDir) {
  const resolvedRoot = resolveRootDirPath(rootDir);
  if (!resolvedRoot || !fs.existsSync(resolvedRoot)) return [];
  const out = [];
  for (const ent of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const token = extractChapterTokenForProgress(ent.name);
    if (token) out.push(token);
  }
  return Array.from(new Set(out)).sort(compareChapterTokens);
}

function computeNextPendingChapter(entry) {
  if (!entry) return null;
  const chapterNumbers = listChapterNumbersFromRoot(entry.rootDir);
  if (!chapterNumbers.length) return null;

  const completedList = normalizeProgressChapterList(entry.completedChapters);
  const completed = new Set(completedList);
  const min = toNumberMaybe(entry.rangeStart);
  const max = toNumberMaybe(entry.rangeEnd);
  const lastCompleted = completedList.length ? completedList[completedList.length - 1] : null;
  const lastAttempted = normalizeChapterTokenForProgress(entry.lastAttemptedChapter);
  const lastFailed = normalizeChapterTokenForProgress(entry.lastFailedChapter);

  // Si hay un capitulo fallido que no está completado, reintentarlo primero.
  if (lastFailed && !completed.has(lastFailed)) {
    const num = toNumberMaybe(lastFailed);
    const minOk = min === null || num === null || num >= min;
    const maxOk = max === null || num === null || num <= max;
    if (minOk && maxOk) return lastFailed;
  }

  const anchorToken = [lastAttempted, lastCompleted]
    .filter(Boolean)
    .sort(compareChapterTokens)
    .slice(-1)[0] || null;

  // En recuperación manual o interrumpida, continuar después del punto más avanzado
  // conocido (intentado o confirmado), no desde el primer faltante global.
  if (anchorToken) {
    for (const token of chapterNumbers) {
      const num = toNumberMaybe(token);
      if (num === null) continue;
      if (min !== null && num < min) continue;
      if (max !== null && num > max) continue;
      if (compareChapterTokens(token, anchorToken) <= 0) continue;
      if (!completed.has(token)) return token;
    }
  }

  for (const token of chapterNumbers) {
    const num = toNumberMaybe(token);
    if (num === null) continue;
    if (min !== null && num < min) continue;
    if (max !== null && num > max) continue;
    if (!completed.has(token)) return token;
  }
  return null;
}

function getResolvableUploadProgressEntries() {
  return Object.values(_uploadProgressState)
    .map((entry) => {
      const normalized = normalizeProgressEntry(entry.key || buildUploadProgressKey(entry), entry);
      return {
        ...normalized,
        nextPendingChapter: computeNextPendingChapter(normalized),
      };
    })
    .filter((entry) => ["paused", "error", "interrupted", "stopped", "manual-fixed", "skipped-forward"].includes(entry.status) && entry.nextPendingChapter !== null);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function getSessionId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies.sid;
  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    const flags = [
      `sid=${encodeURIComponent(sid)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      COOKIE_SECURE ? "Secure" : null,
    ].filter(Boolean).join("; ");
    res.setHeader("Set-Cookie", flags);
  }
  return sid;
}

function ensureSession(req, res, next) {
  req.sid = getSessionId(req, res);
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const sid = req.sid || "anon";
      const target = (req.body && req.body.target) ? String(req.body.target) : sid;
      const base = safeJoin(UPLOAD_BASE_DIR, target);
      const rel = file.originalname ? path.dirname(file.originalname) : "";
      const dest = safeJoin(base, rel);
      ensureDir(dest);
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const name = path.basename(file.originalname || file.fieldname);
      cb(null, name);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

function pushLog(job, line) {
  const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
  job.logs.push(clean);
  if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
}

function createNotifyChapterTracker() {
  return {
    seen: new Set(),
    min: null,
    max: null,
    count: 0,
  };
}

function resetNotifyChapterTracker(job) {
  job.notifyChapterTracker = createNotifyChapterTracker();
  job.completedChaptersForNotify = [];
}

function recordCompletedChapterForNotify(job, rawChapter) {
  const num = Number(String(rawChapter || "").replace(",", "."));
  if (!Number.isFinite(num) || num <= 0) return;

  if (!job.notifyChapterTracker) resetNotifyChapterTracker(job);
  const tracker = job.notifyChapterTracker;
  if (tracker.seen.has(num)) return;

  tracker.seen.add(num);
  tracker.count += 1;
  tracker.min = tracker.min === null ? num : Math.min(tracker.min, num);
  tracker.max = tracker.max === null ? num : Math.max(tracker.max, num);
  job.completedChaptersForNotify.push(num);
}

function seedNotifyTrackerFromProgress(job, progressEntry) {
  resetNotifyChapterTracker(job);
  const chapters = normalizeProgressChapterList(progressEntry && progressEntry.completedChapters);
  for (const num of chapters) {
    recordCompletedChapterForNotify(job, num);
  }
}

function getJobState(sid) {
  if (jobs.has(sid)) return jobs.get(sid);
  // Restaurar cola persistida si existe para esta sesion
  const saved = _savedQueues[sid] || {};
  const restoredQueue = Array.isArray(saved.queue) ? saved.queue.slice() : [];
  if (saved.current) restoredQueue.unshift(saved.current);
  const job = {
    status: "idle",
    logs: [],
    queueLogs: [],
    notifyPaused: false,
    completedChaptersForNotify: [],
    notifyChapterTracker: createNotifyChapterTracker(),
    startedAt: null,
    endedAt: null,
    proc: null,
    pauseFile: null,
    queue: restoredQueue,
    current: null,
    currentPayload: null,
    currentProgressKey: null,
    uploads: [],
    totalChapters: 0,
    pageProgress: null,
  };
  if (job.queue.length > 0) {
    console.log(`[INFO] Cola restaurada para sesion ${sid.slice(0, 8)}...: ${job.queue.length} trabajos`);
  }
  jobs.set(sid, job);
  return job;
}

function buildTask(payload, sid) {
  const {
    username,
    password,
    resourceUrl,
    rootDir,
    rangeStart,
    rangeEnd,
    resumeFromChapter,
    apiKey,
    apiUser,
  } = payload || {};

  if (!username || !password || !resourceUrl || !rootDir) {
    return { error: "Faltan datos obligatorios." };
  }
  const isUrl = /^https?:\/\//i.test(String(rootDir || ""));
  if (!isUrl && !fs.existsSync(rootDir)) {
    // Tambien verificar si es una carpeta dentro de incoming
    const incomingPath = safeJoin(UPLOAD_BASE_DIR, rootDir);
    if (!fs.existsSync(incomingPath)) {
      return { error: "La ruta raiz no existe en el servidor." };
    }
  }
  const startToken = normalizeChapterTokenForProgress(rangeStart);
  const endToken = normalizeChapterTokenForProgress(rangeEnd);
  const resumeToken = normalizeChapterTokenForProgress(resumeFromChapter);
  if ((rangeStart && startToken === null) || (rangeEnd && endToken === null)) {
    return { error: "Rango invalido. Usa numeros como 106 o 112.5." };
  }

  ensureDir(STORAGE_DIR);
  const storagePath = path.join(STORAGE_DIR, `storage_${sid}.json`);
  const pauseFile = path.join(STORAGE_DIR, `pause_${sid}.flag`);

  const env = {
    ...buildPlaywrightEnv(process.env),
    SITE_USERNAME: username,
    SITE_PASSWORD: password,
    RESOURCE_URL: resourceUrl,
    PROJECT_BASE_DIR: rootDir,
    STORAGE_STATE: storagePath,
    QUEUE_UPLOADS: "1",
    RANGE_START: rangeStart || "",
    RANGE_END: rangeEnd || "",
    PAUSE_FILE: pauseFile,
  };
  const storedSecrets = readSecrets();
  const finalApiKey = apiKey || storedSecrets.apiKey || "";
  const finalApiUser = apiUser || storedSecrets.apiUser || "";
  if (finalApiKey) env.XENFORO_API_KEY = finalApiKey;
  if (finalApiUser) env.XENFORO_API_USER = finalApiUser;

  const args = [
    "uploader_xf_animebbg2.js",
    "--resource", resourceUrl,
    "--root", rootDir,
    "--parallel", "3",
    "--queue",
  ];
  const progressKey = buildUploadProgressKey(payload || {});
  const progressEntry = _uploadProgressState[progressKey] || null;
  const resumeFrom = computeNextPendingChapter(progressEntry);

  // PRIORIDAD: Si el usuario especifica un rango de inicio manualmente, respetarlo.
  // Si NO especifica nada, intentar reanudar desde donde quedo.
  const effectiveStart = startToken || resumeToken || resumeFrom;

  if (effectiveStart !== null) args.push("--start", String(effectiveStart));
  if (endToken !== null) args.push("--end", String(endToken));

  return {
    env,
    args,
    pauseFile,
    label: resourceUrl,
    rangeLabel: (effectiveStart !== null || endToken !== null) ? `${effectiveStart ?? "-"} -> ${endToken ?? "-"}` : null,
    effectiveStart,
    progressEntry,
  };
}

async function publishAutoNotification(resourceUrl, job) {
  const secrets = readSecrets();
  const username = secrets.username || "";
  const password = secrets.password || "";

  if (!username || !password) {
    throw new Error("Faltan credenciales de usuario.");
  }

  if (!resourceUrl) {
    throw new Error("No hay URL de recurso.");
  }

  let chapterStart = null;
  let chapterEnd = null;
  const tracker = job.notifyChapterTracker;

  if (tracker && tracker.count > 0 && tracker.min !== null && tracker.max !== null) {
    chapterStart = tracker.min;
    chapterEnd = tracker.max;
    if (chapterStart === chapterEnd) {
      pushLog(job, `[INFO] Detectado capÃ­tulo ${chapterStart} (rastreado en tiempo real)`);
    } else {
      pushLog(job, `[INFO] Detectados caps ${chapterStart} al ${chapterEnd} (${tracker.count} caps rastreados)`);
    }
  }

  // Preferir capítulos rastreados en tiempo real (no contaminados por logs de cola)
  if (!(tracker && tracker.count > 0) && job.completedChaptersForNotify && job.completedChaptersForNotify.length > 0) {
    const sorted = [...job.completedChaptersForNotify].sort((a, b) => a - b);
    chapterStart = sorted[0];
    chapterEnd = sorted[sorted.length - 1];
    if (chapterStart === chapterEnd) {
      pushLog(job, `[INFO] Detectado capítulo ${chapterStart} (rastreado en tiempo real)`);
    } else {
      pushLog(job, `[INFO] Detectados caps ${chapterStart} al ${chapterEnd} (${sorted.length} caps rastreados)`);
    }
  } else if (!(tracker && tracker.count > 0)) {
    // Fallback: parsear logs de la subida actual
    const startIndex = job.currentUploadStartLogIndex || 0;
    const currentUploadLogs = job.logs.slice(startIndex);
    const chapterNumbersSet = new Set();

    for (const log of currentUploadLogs) {
      const isOk = /\[(OK|CONFIRMADO)\]/i.test(log);
      if (!isOk) continue;

      const isUploadPhase = /\[phase:upload\]/i.test(log);
      const isCompleted = /\bCompletado\b/i.test(log) || /\bpublicado\b/i.test(log);

      if (isUploadPhase && isCompleted) {
        let capRaw = null;
        const capFromPrefix = log.match(/\[cap:(\d+(?:[.,]\d+)?)\]/i);
        if (capFromPrefix) {
          capRaw = capFromPrefix[1];
        } else {
          const capFromText = log.match(/\bCap(?:[i\u00ed]tulo)?\s*(\d+(?:[.,]\d+)?)/i);
          if (capFromText) capRaw = capFromText[1];
        }
        if (capRaw) {
          const num = Number(String(capRaw).replace(',', '.'));
          if (Number.isFinite(num) && num > 0) chapterNumbersSet.add(num);
        }
        continue;
      }

      const legacyCompleted = log.match(/\[OK\][^\n\r]*\bCap(?:[i\u00ed]tulo)?\s*(\d+(?:[.,]\d+)?)[^\n\r]*\b(completado|publicado)\b/i);
      if (legacyCompleted) {
        const num = Number(String(legacyCompleted[1]).replace(',', '.'));
        if (Number.isFinite(num) && num > 0) chapterNumbersSet.add(num);
      }
    }

    const chapterNumbers = Array.from(chapterNumbersSet).sort((a, b) => a - b);
    if (chapterNumbers.length > 0) {
      chapterStart = chapterNumbers[0];
      chapterEnd = chapterNumbers[chapterNumbers.length - 1];
      if (chapterStart === chapterEnd) {
        pushLog(job, `[INFO] Detectado capitulo ${chapterStart} (por logs)`);
      } else {
        pushLog(job, `[INFO] Detectados capitulos ${chapterStart} al ${chapterEnd} (por logs)`);
      }
    } else {
      pushLog(job, "[INFO] No se detectaron capitulos nuevos subidos en esta ejecucion. Notificacion automatica omitida.");
      return;
    }
  }

  const notificationScriptPath = path.join(APP_ROOT, "notification_publisher.js");
  const notificationArgs = [
    resourceUrl,
    chapterStart.toString(),
    chapterEnd.toString(),
    username,
    password,
    "false",
    ""
  ];

  return new Promise((resolve, reject) => {
    const notifProc = spawn(NODE_EXE, [notificationScriptPath, ...notificationArgs], {
      cwd: APP_ROOT,
      env: { ...process.env }
    });

    notifProc.stdout.on("data", (data) => {
      pushLog(job, data.toString().trim());
    });

    notifProc.stderr.on("data", (data) => {
      pushLog(job, data.toString().trim());
    });

    notifProc.on("close", (code) => {
      if (code === 0) {
        pushLog(job, `[INFO] Notificacion publicada correctamente`);
        resolve();
      } else {
        reject(new Error(`Proceso de notificacion termino con codigo ${code}`));
      }
    });

    notifProc.on("error", (err) => {
      reject(err);
    });
  });
}

function startNext(job) {
  if (job.proc || job.status === "running" || job.status === "paused") return;
  while (job.queue.length) {
    const payload = job.queue.shift();
    job.currentPayload = payload;
    saveQueueState(); // Persistir cola + trabajo activo para recuperacion tras reinicio
    const task = buildTask(payload, job.sid);
    if (task.error) {
      job.currentPayload = null;
      saveQueueState();
      pushLog(job, `[ERR] Cola invalida: ${task.error}`);
      continue;
    }
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.endedAt = null;
    job.pauseFile = task.pauseFile;
    job.current = task.label;
    // Evitar pausa fantasma por bandera residual de ejecuciones previas.
    try {
      if (job.pauseFile && fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile);
    } catch {}

    // Copiar autoNotify del payload al job
    if (typeof payload.autoNotify !== 'undefined') {
      job.autoNotify = Boolean(payload.autoNotify);
    }

    // Resetear capítulos rastreados para esta nueva subida
    job.totalChapters = 0;
    job.pageProgress = null;
    job.currentChapterNum = null;
    job.currentChapterIndex = 0;
    job.chaptersPublished = 0;
    const progressEntry = getOrCreateUploadProgress(payload, job.sid);
    job.currentProgressKey = progressEntry.key;
    seedNotifyTrackerFromProgress(job, progressEntry);

    // Marcar el inicio de esta subida para poder filtrar logs después
    job.currentUploadStartLogIndex = job.logs.length;

    // Separador visual para nueva subida
    pushLog(job, "");
    pushLog(job, "========================================");
    pushLog(job, `INICIANDO SUBIDA: ${task.label}`);
    if (task.rangeLabel) pushLog(job, `Rango solicitado: ${task.rangeLabel}`);
    pushLog(job, "========================================");

    // Keep child processes anchored to the app folder so portable launches
    // still work even if the shortcut/start-in directory changes.
    const proc = spawn(NODE_EXE, task.args, { cwd: APP_ROOT, env: task.env });
    job.proc = proc;


    proc.stdout.on("data", (buf) => {
      const lines = String(buf).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        pushLog(job, line);
        const processingMatch = line.match(/\[cap:(\d+(?:[.,]\d+)?)\][^\n\r]*\[\s*INFO\s*\][^\n\r]*\bProcesando\s+Cap\b/i);
        if (processingMatch) {
          recordAttemptedChapterInProgress(job.currentProgressKey, processingMatch[1], "attempt");
        }
        const failedMatch = line.match(/\[cap:(\d+(?:[.,]\d+)?)\][^\n\r]*\[\s*ERROR\s*\][^\n\r]*\bFallo\s+Cap\b/i);
        if (failedMatch) {
          recordAttemptedChapterInProgress(job.currentProgressKey, failedMatch[1], "failed");
        }
        // Rastrear capítulos completados en tiempo real para notificación
        const isOk = /\[(OK|CONFIRMADO)\]/i.test(line);
        const hasChapterTag = /\[cap:(\d+(?:[.,]\d+)?)\]/i.test(line);
        const indicatesCompletedChapter =
          /\b(Completado|publicado)\b/i.test(line) ||
          /\bsubido con exito\b/i.test(line);
        if (isOk && hasChapterTag && indicatesCompletedChapter) {
          const capMatch = line.match(/\[cap:(\d+(?:[.,]\d+)?)\]/i);
          if (capMatch) {
            recordCompletedChapterForNotify(job, capMatch[1]);
            recordCompletedChapterInProgress(job.currentProgressKey, capMatch[1]);
            recordAttemptedChapterInProgress(job.currentProgressKey, capMatch[1], "completed");
          }
          job.pageProgress = null;
        }
        // Detectar publicación confirmada (antes de waitForPreviews) para actualizar barra de progreso
        const isPublished = isOk && hasChapterTag && /Publicacion confirmada/i.test(line);
        if (isPublished) {
          job.chaptersPublished += 1;
          // Marcar páginas como 100% completadas
          if (job.pageProgress && job.pageProgress.total > 0) {
            job.pageProgress = { uploaded: job.pageProgress.total, total: job.pageProgress.total };
          }
        }
        // Progreso de barras: capítulo actual (prefijo [cap:X] en cualquier posición)
        const capTagMatch = line.match(/\[cap:(\d+(?:[.,]\d+)?)\]/i);
        if (capTagMatch && capTagMatch[1] !== job.currentChapterNum) {
          job.currentChapterNum = capTagMatch[1];
          job.currentChapterIndex = (job.chaptersPublished || 0) + 1;
        }
        // Progreso de barras: total de capítulos
        const totalCapMatch = line.match(/quedan\s+(\d+)\s+cap[ií]tulos/i);
        if (totalCapMatch && job.totalChapters === 0) {
          job.totalChapters = parseInt(totalCapMatch[1], 10);
        }
        // Progreso de barras: total de páginas del capítulo actual
        const pagesTotalMatch = line.match(/\[SUBIENDO\].*?confirmaci[oó]n de carga de\s+(\d+)\s+im[aá]genes/i);
        if (pagesTotalMatch) {
          job.pageProgress = { uploaded: 0, total: parseInt(pagesTotalMatch[1], 10) };
        }
        // Progreso de barras: páginas subidas actualmente
        const pagesProgressMatch = line.match(/\[SUBIENDO\].*?Reporte de la web:\s*(\d+)\/(\d+)/i);
        if (pagesProgressMatch) {
          job.pageProgress = { uploaded: parseInt(pagesProgressMatch[1], 10), total: parseInt(pagesProgressMatch[2], 10) };
        }
      }
    });
    proc.stderr.on("data", (buf) => {
      const lines = String(buf).split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) pushLog(job, `[ERR] ${line}`);
      }
    });
    proc.on("close", async (code) => {
      job.proc = null;
      if (job.status !== "stopped") {
        job.status = code === 0 ? "done" : "error";
      }
      job.endedAt = new Date().toISOString();
      updateUploadProgressStatus(
        job.currentProgressKey,
        job.status === "stopped" ? "stopped" : (code === 0 ? "done" : "interrupted"),
      );

      // Separador visual para fin de subida
      pushLog(job, "");
      pushLog(job, "----------------------------------------");
      pushLog(job, `SUBIDA FINALIZADA - Codigo: ${code} - Estado: ${code === 0 ? "EXITOSO" : "ERROR"}`);
      pushLog(job, "----------------------------------------");

      // Publicar notificación automática si está habilitado, no pausado, y subida exitosa
      if (code === 0 && job.autoNotify && !job.notifyPaused && job.current) {
        pushLog(job, "");
        pushLog(job, ">>> PUBLICANDO NOTIFICACION AUTOMATICA...");
        try {
          await publishAutoNotification(job.current, job);
          updateUploadProgressStatus(job.currentProgressKey, "notified");
          pushLog(job, ">>> NOTIFICACION PUBLICADA EXITOSAMENTE");
        } catch (err) {
          pushLog(job, `>>> ERROR EN NOTIFICACION: ${err.message}`);
        }
        pushLog(job, "");
      }

      if (job.status === "done" || job.status === "error" || job.status === "stopped") {
        job.currentProgressKey = null;
      }
      job.currentPayload = null;
      saveQueueState();
      if (job.status !== "stopped") startNext(job);
    });
    return;
  }
  if (!job.queue.length) {
    job.status = "idle";
    job.current = null;
    job.currentPayload = null;
    saveQueueState();
    return;
  }
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

// Deshabilitar caché para archivos estáticos en desarrollo
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.use(express.static(PUBLIC_DIR));


app.get("/api/status", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  const from = Math.max(0, parseInt(req.query.from || "0", 10));
  const queueFrom = Math.max(0, parseInt(req.query.queueFrom || "0", 10));
  const slice = job.logs.slice(from);
  const queueSlice = (job.queueLogs || []).slice(queueFrom);
  return res.json({
    status: job.status,
    logs: slice,
    next: from + slice.length,
    queueLogs: queueSlice,
    queueNext: queueFrom + queueSlice.length,
    notifyPaused: job.notifyPaused || false,
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
    queue: job.queue.length,
    current: job.current,
    totalChapters: job.totalChapters || 0,
    chaptersDone: job.chaptersPublished || 0,
    currentChapterNum: job.currentChapterNum || null,
    currentChapterIndex: job.currentChapterIndex || 0,
    pageProgress: job.pageProgress || null,
    queueItems: job.queue.map((q, idx) => ({
      index: idx,
      resourceUrl: q.resourceUrl || "",
      rootDir: q.rootDir || "",
      rangeStart: q.rangeStart || "",
      rangeEnd: q.rangeEnd || "",
      resumeFromChapter: q.resumeFromChapter || "",
    })),
    unresolvedProgress: getResolvableUploadProgressEntries(),
  });
});

app.post("/api/logs/clear", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  const target = req.body && req.body.target;
  if (!target || target === 'all') {
    job.logs = [];
    job.queueLogs = [];
    job.currentUploadStartLogIndex = 0;
    return res.json({ ok: true, next: 0, queueNext: 0 });
  }
  if (target === 'uploader') {
    job.logs = [];
    job.currentUploadStartLogIndex = 0;
    return res.json({ ok: true, next: 0 });
  }
  if (target === 'queue') {
    job.queueLogs = [];
    return res.json({ ok: true, queueNext: 0 });
  }
  return res.json({ ok: true });
});


app.get("/api/secrets", (req, res) => {
  const s = readSecrets();
  res.json({
    hasApi: Boolean(s.apiKey && s.apiUser),
    username: String(s.username || ""),
    password: String(s.password || ""),
    apiUser: String(s.apiUser || ""),
    apiKey: String(s.apiKey || ""),
  });
});

app.post("/api/secrets", (req, res) => {
  const body = req.body || {};

  // Leer secrets existentes para no sobrescribir
  const existingSecrets = readSecrets();

  // Actualizar solo los campos que se proporcionan
  const newSecrets = { ...existingSecrets };

  // Guardar si la clave existe en el body, incluso si está vacía
  if ('apiKey' in body) newSecrets.apiKey = String(body.apiKey || "");
  if ('apiUser' in body) newSecrets.apiUser = String(body.apiUser || "");
  if ('username' in body) newSecrets.username = String(body.username || "");
  if ('password' in body) newSecrets.password = String(body.password || "");

  writeSecrets(newSecrets);
  console.log("[CONFIG] Credenciales guardadas:", Object.keys(newSecrets));
  return res.json({ ok: true });
});

app.post("/api/credentials/clear", (req, res) => {
  const existingSecrets = readSecrets();
  const newSecrets = {
    ...existingSecrets,
    username: "",
    password: "",
    apiUser: "",
    apiKey: "",
  };
  writeSecrets(newSecrets);

  let envResult = { ok: false, envFound: false };
  try {
    envResult = clearEnvCredentialKeys();
  } catch (e) {
    console.warn("[CONFIG] No se pudo limpiar .env:", e.message);
  }

  return res.json({ ok: true, env: envResult });
});

app.post("/api/start", (req, res) => {
  const sid = getSessionId(req, res);
  const enqueueOnly = Boolean(req.body && req.body.enqueueOnly);
  const job = getJobState(sid);
  job.sid = sid;

  // Guardar la configuración de auto-notificación
  if (req.body && typeof req.body.autoNotify !== 'undefined') {
    job.autoNotify = Boolean(req.body.autoNotify);
  }

  const startQueueOnly = Boolean(req.body && req.body.startQueueOnly);
  if (startQueueOnly) {
    if (!job.queue.length) {
      return res.status(400).json({ error: "La cola esta vacia." });
    }
    if (job.status === "running" || job.status === "paused") {
      return res.status(400).json({ error: "Ya hay un proceso activo." });
    }
    startNext(job);
    return res.json({ ok: true, queued: job.queue.length });
  }
  const taskCheck = buildTask(req.body || {}, sid);
  if (taskCheck.error) {
    return res.status(400).json({ error: taskCheck.error });
  }
  job.queue.push(req.body || {});
  saveQueueState(); // Persistir nueva entrada en cola
  const queueMsg = `[COLA] En cola (${job.queue.length}): ${req.body.resourceUrl || ""}`;
  job.queueLogs.push(queueMsg);
  if (job.queueLogs.length > 500) job.queueLogs.splice(0, job.queueLogs.length - 500);
  if (!enqueueOnly) startNext(job);
  return res.json({ ok: true, queued: job.queue.length });
});

app.post("/api/upload", ensureSession, upload.any(), (req, res) => {
  const sid = req.sid || "anon";
  const target = (req.body && req.body.target) ? String(req.body.target) : sid;
  const rootDir = safeJoin(UPLOAD_BASE_DIR, target);
  const filesCount = Array.isArray(req.files) ? req.files.length : 0;
  const job = getJobState(sid);
  if (!job.uploads.includes(rootDir)) {
    job.uploads.unshift(rootDir);
    if (job.uploads.length > 12) job.uploads.splice(12);
  }
  return res.json({ ok: true, files: filesCount, rootDir });
});

app.get("/api/uploads", ensureSession, (req, res) => {
  const sid = req.sid || "anon";
  const job = getJobState(sid);
  return res.json({ uploads: job.uploads || [] });
});

// Listar todas las carpetas subidas disponibles en incoming/
app.get("/api/uploaded-dirs", (req, res) => {
  try {
    ensureDir(UPLOAD_BASE_DIR);
    const entries = fs.readdirSync(UPLOAD_BASE_DIR);
    const dirs = [];
    for (const name of entries) {
      const full = path.join(UPLOAD_BASE_DIR, name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
        // Contar subcarpetas (capitulos) e imagenes
        const subs = fs.readdirSync(full);
        let chapters = 0;
        let totalImages = 0;
        for (const sub of subs) {
          const subFull = path.join(full, sub);
          try {
            if (!fs.statSync(subFull).isDirectory()) continue;
            chapters++;
            const imgs = fs.readdirSync(subFull).filter(f =>
              /\.(jpg|jpeg|png|webp)$/i.test(f)
            );
            totalImages += imgs.length;
          } catch { }
        }
        dirs.push({ name, path: full, chapters, totalImages });
      } catch { }
    }
    return res.json({ dirs });
  } catch (e) {
    return res.json({ dirs: [], error: e.message });
  }
});

// Descargar carpeta de Google Drive al servidor (sin Python/gdown)
// SSE stream para progreso en tiempo real
const driveDownloads = new Map(); // sid -> { status, logs, destDir }

app.post("/api/drive-download", ensureSession, async (req, res) => {
  const sid = req.sid || "anon";
  const { driveUrl, folderName } = req.body || {};

  if (!driveUrl) {
    return res.status(400).json({ error: "Falta la URL de Google Drive." });
  }

  const folderId = extractFolderId(driveUrl);
  if (!folderId) {
    return res.status(400).json({ error: "No se pudo extraer el ID de la carpeta. Revisa la URL." });
  }

  // Si ya hay una descarga en progreso para este sid, rechazar
  const existing = driveDownloads.get(sid);
  if (existing && existing.status === "downloading") {
    return res.status(409).json({ error: "Ya hay una descarga en progreso." });
  }

  const targetName = folderName || folderId;
  const destDir = safeJoin(UPLOAD_BASE_DIR, targetName);
  ensureDir(destDir);

  const state = { status: "downloading", logs: [], destDir, error: null };
  driveDownloads.set(sid, state);

  // Registrar en uploads del job
  const job = getJobState(sid);
  if (!job.uploads.includes(destDir)) {
    job.uploads.unshift(destDir);
    if (job.uploads.length > 12) job.uploads.splice(12);
  }

  res.json({ ok: true, destDir, folderId });

  // Descargar en background
  try {
    await downloadDriveFolder(driveUrl, destDir, {
      onProgress: (msg) => {
        state.logs.push(msg);
        if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
      },
      recursive: true,
    });
    state.status = "done";
  } catch (e) {
    state.status = "error";
    state.error = e.message;
    state.logs.push(`[ERROR] ${e.message}`);
  }
});

// Polling de progreso de descarga de Drive
app.get("/api/drive-download/status", ensureSession, (req, res) => {
  const sid = req.sid || "anon";
  const state = driveDownloads.get(sid);
  if (!state) {
    return res.json({ status: "idle", logs: [], destDir: null });
  }
  const from = Math.max(0, parseInt(req.query.from || "0", 10));
  const slice = state.logs.slice(from);
  return res.json({
    status: state.status,
    logs: slice,
    next: from + slice.length,
    destDir: state.destDir,
    error: state.error,
  });
});

app.post("/api/stop", (req, res) => {
  const sid = getSessionId(req, res);
  const job = jobs.get(sid);
  if (!job || !job.proc) {
    return res.status(404).json({ error: "No hay proceso activo." });
  }
  job.status = "stopped";
  job.endedAt = new Date().toISOString();
  pushLog(job, "Proceso detenido por el usuario.");
  updateUploadProgressStatus(job.currentProgressKey, "stopped");
  try { if (job.pauseFile && fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile); } catch { }
  try { job.proc.kill("SIGTERM"); } catch { }
  job.currentPayload = null;
  saveQueueState();
  return res.json({ ok: true });
});

app.post("/api/queue/update", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  const index = parseInt(req.body && req.body.index, 10);
  if (!Number.isFinite(index) || index < 0 || index >= job.queue.length) {
    return res.status(400).json({ error: "Indice invalido." });
  }
  const payload = req.body && req.body.payload ? req.body.payload : null;
  if (!payload) {
    return res.status(400).json({ error: "Payload invalido." });
  }
  const check = buildTask(payload, sid);
  if (check.error) {
    return res.status(400).json({ error: check.error });
  }
  job.queue[index] = payload;
  saveQueueState(); // Persistir cambio en elemento de cola
  return res.json({ ok: true });
});

app.post("/api/queue/delete", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  const index = parseInt(req.body && req.body.index, 10);
  if (!Number.isFinite(index) || index < 0 || index >= job.queue.length) {
    return res.status(400).json({ error: "Indice invalido." });
  }
  job.queue.splice(index, 1);
  saveQueueState(); // Persistir eliminacion de elemento
  return res.json({ ok: true });
});

app.post("/api/queue/move", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  const index = parseInt(req.body && req.body.index, 10);
  const direction = req.body && req.body.direction;
  if (!Number.isFinite(index) || index < 0 || index >= job.queue.length) {
    return res.status(400).json({ error: "Indice invalido." });
  }
  const newIndex = direction === "up" ? index - 1 : index + 1;
  if (newIndex < 0 || newIndex >= job.queue.length) {
    return res.status(400).json({ error: "Movimiento invalido." });
  }
  const item = job.queue.splice(index, 1)[0];
  job.queue.splice(newIndex, 0, item);
  saveQueueState(); // Persistir reorden de cola
  return res.json({ ok: true });
});

app.post("/api/progress/resolve", (req, res) => {
  const { key, chapter, action } = req.body || {};
  if (!key) return res.status(400).json({ error: "Falta key." });
  const chapterToken = normalizeChapterTokenForProgress(chapter);
  if (!chapterToken) return res.status(400).json({ error: "Capitulo invalido." });
  const mode = action === "skip" ? "skip" : "manual";
  const resolved = resolveProgressChapter(key, chapterToken, mode);
  if (!resolved) return res.status(404).json({ error: "Progreso no encontrado." });
  return res.json({ ok: true, progress: resolved });
});

app.post("/api/progress/delete", (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "Falta key." });
  if (!_uploadProgressState[key]) return res.status(404).json({ error: "Progreso no encontrado." });
  
  delete _uploadProgressState[key];
  saveUploadProgressState();
  return res.json({ ok: true, message: "Registro de progreso eliminado." });
});

app.post("/api/progress/resume", (req, res) => {
  const sid = getSessionId(req, res);
  const { key } = req.body || {};
  if (!key || !_uploadProgressState[key]) {
    return res.status(404).json({ error: "Progreso no encontrado." });
  }

  const entry = _uploadProgressState[key];
  const mode = (req.body && req.body.mode) === "back" ? "back" : "front";
  const job = getJobState(sid);
  job.sid = sid;

  // Si hay un proceso pausado activo, reanudarlo directamente en vez de encolar otro trabajo.
  if (job.proc && job.status === "paused") {
    try {
      if (job.pauseFile && fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile);
    } catch {}
    job.status = "running";
    pushLog(job, "Proceso reanudado desde panel de recuperacion.");
    job.queueLogs.push(`[COLA] Proceso reanudado (panel de recuperacion): ${entry.resourceUrl}`);
    if (job.queueLogs.length > 500) job.queueLogs.splice(0, job.queueLogs.length - 500);
    return res.json({ ok: true, resumed: true });
  }

  // Si el proceso aún está corriendo (no pausado), no se puede encolar encima.
  if (job.proc) {
    return res.status(409).json({ error: "Hay un proceso activo. Detén el proceso actual antes de reanudar desde el panel de recuperación." });
  }

  // Re-encolar el trabajo con los datos originales
  const secrets = readSecrets();
  const payload = {
    username: secrets.username || "",
    password: secrets.password || "",
    resourceUrl: entry.resourceUrl,
    rootDir: entry.rootDir,
    rangeStart: entry.rangeStart,
    rangeEnd: entry.rangeEnd,
    resumeFromChapter: computeNextPendingChapter(entry),
  };

  if (!payload.username || !payload.password) {
    return res.status(400).json({ error: "Faltan credenciales guardadas en el servidor para reanudar. Por favor, guárdalas primero." });
  }

  // front = al frente (Reanudar primero), back = al final (Encolar al final)
  if (mode === "back") {
    job.queue.push(payload);
  } else {
    job.queue.unshift(payload);
  }
  saveQueueState();

  job.queueLogs.push(`[COLA] Reanudacion solicitada: ${entry.resourceUrl} -> desde ${payload.resumeFromChapter || "auto"}`);
  if (job.queueLogs.length > 500) job.queueLogs.splice(0, job.queueLogs.length - 500);

  // Si el job estaba en estado de error, interrumpido, detenido o PAUSADO, permitir que se inicie
  if (job.status === "error" || job.status === "interrupted" || job.status === "stopped" || job.status === "paused") {
    job.status = "idle";
  }

  startNext(job);
  return res.json({ ok: true, queued: job.queue.length });
});

app.post("/api/pause", (req, res) => {
  const sid = getSessionId(req, res);
  const job = jobs.get(sid);
  if (!job) return res.status(404).json({ error: "No se encontro el estado del trabajo." });

  if (!job.proc) {
    // Si no hay proceso corriendo, pero hay cola o algo pendiente, permitir pausar el "loop"
    job.status = "paused";
    return res.json({ ok: true, message: "Cola pausada (sin proceso activo)." });
  }

  try {
    fs.writeFileSync(job.pauseFile, "1");
  } catch {
    return res.status(500).json({ error: "No se pudo crear el archivo de pausa." });
  }
  job.status = "paused";
  pushLog(job, "Proceso en pausa.");
  updateUploadProgressStatus(job.currentProgressKey, "paused");
  return res.json({ ok: true });
});

app.post("/api/notify-pause", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  job.notifyPaused = !job.notifyPaused;
  const msg = job.notifyPaused
    ? "[COLA] Notificación automática PAUSADA. No se publicará al terminar la subida."
    : "[COLA] Notificación automática REANUDADA.";
  job.queueLogs.push(msg);
  if (job.queueLogs.length > 500) job.queueLogs.splice(0, job.queueLogs.length - 500);
  return res.json({ ok: true, notifyPaused: job.notifyPaused });
});

app.post("/api/resume", (req, res) => {
  const sid = getSessionId(req, res);
  const job = jobs.get(sid);
  if (!job) return res.status(404).json({ error: "No se encontro el estado del trabajo." });

  if (!job.proc) {
    // Si no hay proceso, pero el estado es pausado, simplemente despausar y arrancar
    if (job.status === "paused") {
       job.status = "idle";
       startNext(job);
       return res.json({ ok: true, message: "Cola reanudada." });
    }
    return res.status(404).json({ error: "No hay proceso activo para reanudar." });
  }

  try {
    if (fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile);
  } catch {
    return res.status(500).json({ error: "No se pudo eliminar el archivo de pausa." });
  }
  job.status = "running";
  pushLog(job, "Proceso reanudado.");
  updateUploadProgressStatus(job.currentProgressKey, "running");
  return res.json({ ok: true });
});

// === ENDPOINTS DE NOTIFICACIONES ===
const notificationStorage = multer.memoryStorage();
const notificationUpload = multer({
  storage: notificationStorage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Mapa temporal para almacenar notificaciones generadas
const pendingNotifications = new Map();

app.post("/api/notification/generate", notificationUpload.single("customImage"), async (req, res) => {
  try {
    const { url, chapterStart, chapterEnd, useCustomImage, username, password } = req.body;
    const customImage = req.file;

    if (!url || !chapterStart || !chapterEnd) {
      return res.status(400).json({ error: "Faltan parámetros requeridos." });
    }

    if (!username || !password) {
      return res.status(400).json({ error: "Faltan credenciales de usuario." });
    }

    const startRaw = String(chapterStart).trim().replace(",", ".");
    const endRaw = String(chapterEnd).trim().replace(",", ".");
    const start = Number(startRaw);
    const end = Number(endRaw);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      return res.status(400).json({ error: "Rango de capítulos inválido." });
    }

    // Generar ID único para esta notificación
    const notificationId = crypto.randomBytes(16).toString("hex");

    // Preparar ruta de imagen personalizada si existe
    let customImagePath = null;
    const isCustomImage = useCustomImage === "true";
    if (isCustomImage && customImage) {
      customImagePath = path.join(DATA_DIR, `temp_custom_preview_${notificationId}.jpg`);
      fs.writeFileSync(customImagePath, customImage.buffer);
    }

    // Ejecutar script de vista previa (usando promesa)
    const previewScriptPath = path.join(APP_ROOT, "notification_preview.js");
    const previewArgs = [
      url,
      startRaw,
      endRaw,
      isCustomImage.toString(),
      customImagePath || ""
    ];

    const executePreview = () => new Promise((resolve, reject) => {
      const previewProc = spawn(NODE_EXE, [previewScriptPath, ...previewArgs], {
        cwd: APP_ROOT,
        env: buildPlaywrightEnv(process.env)
      });


      let previewOutput = "";
      let errorOutput = "";

      previewProc.stdout.on("data", (data) => {
        previewOutput += data.toString();
      });

      previewProc.stderr.on("data", (data) => {
        errorOutput += data.toString();
        console.error("[PREVIEW ERROR]", data.toString());
      });

      previewProc.on("close", (code) => {
        if (code !== 0) {
          return reject(new Error(`Preview process exited with code ${code}: ${errorOutput}`));
        }

        try {
          const previewData = JSON.parse(previewOutput.trim());
          if (!previewData.success) {
            return reject(new Error(previewData.error || "Error al generar vista previa"));
          }
          resolve(previewData);
        } catch (parseErr) {
          reject(new Error("Error al parsear respuesta: " + parseErr.message));
        }
      });

      previewProc.on("error", (err) => {
        reject(err);
      });
    });

    const previewData = await executePreview();

    // Preparar datos para el proceso de publicación
    const notificationData = {
      url,
      chapterStart: startRaw,
      chapterEnd: endRaw,
      useCustomImage: isCustomImage,
      customImage: customImage ? customImage.buffer : null,
      notificationId,
      timestamp: Date.now(),
      previewData,
      username,  // Guardar credenciales
      password   // Guardar credenciales
    };

    // Guardar en mapa temporal
    pendingNotifications.set(notificationId, notificationData);
    console.log("[GENERATE] Notificación guardada con ID:", notificationId);
    console.log("[GENERATE] Total notificaciones en mapa:", pendingNotifications.size);
    console.log("[GENERATE] Claves en mapa:", Array.from(pendingNotifications.keys()));

    // Limpiar imagen temporal de preview si existe
    if (customImagePath) {
      try {
        fs.unlinkSync(customImagePath);
      } catch { }
    }

    // Devolver vista previa
    res.json({
      notificationId,
      title: previewData.title,
      message: previewData.message,
      imageBase64: previewData.imageBase64,
      type: previewData.type,
      chapterRange: previewData.chapterRange
    });

  } catch (err) {
    console.error("[NOTIFICATION] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notification/publish", async (req, res) => {
  try {
    console.log("[PUBLISH] req.body recibido:", req.body);
    console.log("[PUBLISH] req.headers:", req.headers);
    const { notificationId, customMessageOverride } = req.body;
    console.log("[PUBLISH] notificationId extraído:", notificationId);

    if (!notificationId) {
      console.log("[PUBLISH] ERROR: notificationId está vacío o undefined");
      return res.status(400).json({ error: "Falta notificationId." });
    }

    console.log("[PUBLISH] Buscando notificationId en mapa:", notificationId);
    console.log("[PUBLISH] Total notificaciones en mapa:", pendingNotifications.size);
    console.log("[PUBLISH] Claves en mapa:", Array.from(pendingNotifications.keys()));

    const notificationData = pendingNotifications.get(notificationId);
    console.log("[PUBLISH] notificationData encontrado:", notificationData ? "SÍ" : "NO");

    if (!notificationData) {
      return res.status(404).json({ error: "Notificación no encontrada o expirada." });
    }

    // Obtener credenciales de los datos guardados
    const username = notificationData.username || "";
    const password = notificationData.password || "";

    if (!username || !password) {
      return res.status(400).json({ error: "Faltan credenciales. La notificación no tiene credenciales guardadas." });
    }

    // Obtener el job state de la sesión para agregar logs
    const sid = getSessionId(req, res);
    const job = getJobState(sid);

    // Preparar ruta de imagen personalizada si existe
    let customImagePath = null;
    if (notificationData.useCustomImage && notificationData.customImage) {
      customImagePath = path.join(DATA_DIR, `temp_custom_${notificationId}.jpg`);
      fs.writeFileSync(customImagePath, notificationData.customImage);
    }

    // Ejecutar script de publicación
    const scriptPath = path.join(APP_ROOT, "notification_publisher.js");
    const args = [
      notificationData.url,
      notificationData.chapterStart.toString(),
      notificationData.chapterEnd.toString(),
      username,
      password,
      notificationData.useCustomImage.toString(),
      customImagePath || "",
      String(customMessageOverride || "")
    ];

    console.log("[PUBLISH] Ejecutando script:", scriptPath);
    console.log("[PUBLISH] Argumentos:", args);
    pushLog(job, "[NOTIFICATION] 🔔 Publicando notificación...");

    const proc = spawn(NODE_EXE, [scriptPath, ...args], {
      cwd: APP_ROOT,
      env: buildPlaywrightEnv(process.env)
    });

    console.log("[PUBLISH] Proceso iniciado con PID:", proc.pid);

    let output = "";
    proc.stdout.on("data", (data) => {
      const text = data.toString().trim();
      output += text + "\n";
      console.log("[NOTIFICATION]", text);
      // Agregar al log del job para que aparezca en la UI
      pushLog(job, text);
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString().trim();
      output += text + "\n";
      console.error("[NOTIFICATION ERROR]", text);
      // Agregar errores también al log
      pushLog(job, `[ERROR] ${text}`);
    });

    proc.on("close", (code) => {
      console.log("[PUBLISH] Proceso terminado con código:", code);
      console.log("[PUBLISH] Output completo:", output);

      if (code === 0) {
        pushLog(job, "[NOTIFICATION] ✅ Notificación publicada correctamente!");
      } else {
        pushLog(job, `[NOTIFICATION] ❌ Error al publicar (código: ${code})`);
      }

      // Limpiar imagen temporal si existe
      if (customImagePath) {
        try {
          fs.unlinkSync(customImagePath);
        } catch { }
      }

      // Limpiar notificación del mapa
      pendingNotifications.delete(notificationId);

      if (code !== 0) {
        console.error("[NOTIFICATION] Proceso terminó con código:", code);
      }
    });

    // Responder inmediatamente (el proceso corre en segundo plano)
    res.json({ ok: true, message: "Notificación publicándose..." });

  } catch (err) {
    console.error("[NOTIFICATION] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";

let serverInstance = null;
export function startServer({ port, host } = {}) {
  if (serverInstance) return serverInstance;
  const listenPort = port || PORT;
  const listenHost = host || LISTEN_HOST;
  ensureDir(STORAGE_DIR);
  const server = app.listen(listenPort, listenHost, () => {
    console.log(`[WEB] Servidor listo en http://${listenHost}:${listenPort}`);
    if (listenHost === "0.0.0.0") {
      // Mostrar IPs locales para compartir
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === "IPv4" && !net.internal) {
            console.log(`[WEB] Acceso remoto: http://${net.address}:${listenPort}`);
          }
        }
      }
    }
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`[WEB] El puerto ${listenPort} ya esta en uso.`);
      console.error(`[WEB] Si ya habias abierto el programa, usa esa misma ventana o abre http://127.0.0.1:${listenPort}`);
      console.error("[WEB] Si es otro programa, cierra ese proceso o cambia PORT en .env.");
      process.exitCode = 0;
      return;
    }
    console.error("[WEB] No se pudo iniciar el servidor:", err && err.message ? err.message : err);
    process.exitCode = 1;
  });
  serverInstance = server;
  return serverInstance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

