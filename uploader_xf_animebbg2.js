/**
 * uploader_xf_animebbg2.js (Node.js)
 * Port "python-like": reads creds/config from .env; prompts only for dynamic inputs (resource/root) if missing;
 * reuses cookies via Playwright storageState; creates missing chapters; uploads images in batches; uploads only missing.
 *
 * Requires: Node 18+ (for fetch), Playwright.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import os from "os";
import { spawnSync } from "child_process";
import { AsyncLocalStorage } from "async_hooks";
import { chromium } from "playwright";
import dotenv from "dotenv";
import chalk from "chalk";
import { downloadDriveFolder as downloadDriveFolderJS, extractFolderId as extractFolderIdJS } from "./drive_download.js";

dotenv.config({ override: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== ENV / Defaults =====
const BASE_URL = process.env.BASE_URL || "https://animebbg.net";
const LOGIN_URL = `${BASE_URL.replace(/\/$/, "")}/login/`;

const USERNAME = process.env.SITE_USERNAME || process.env.USERNAME || "";
const PASSWORD = process.env.SITE_PASSWORD || process.env.PASSWORD || "";

const PROJECT_BASE_DIR = process.env.PROJECT_BASE_DIR || "";

const MAX_PER_CHAPTER = parseInt(process.env.MAX_PER_CHAPTER || "30", 10);

const BATCH_UPLOAD_SIZE = parseInt(process.env.BATCH_UPLOAD_SIZE || "15", 10);
const SLEEP_BETWEEN_BATCH_MS = parseInt(process.env.SLEEP_BETWEEN_BATCH_MS || "400", 10);
const QUEUE_UPLOADS = (process.env.QUEUE_UPLOADS || "0").toLowerCase() === "1"
  || (process.env.QUEUE_UPLOADS || "0").toLowerCase() === "true";

const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() === "true";
const SLOW_MO_MS = parseInt(process.env.SLOW_MO_MS || "0", 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "30000", 10);
const STORAGE_STATE = process.env.STORAGE_STATE || "cookies.json";
const LEGACY_CHROME_PATH = process.env.LEGACY_CHROME_PATH || "";
const PAUSE_FILE = process.env.PAUSE_FILE || "";
const USER_AGENT = process.env.USER_AGENT || "";
const LOCALE = process.env.LOCALE || "";
const DRIVE_TMP_DIR = process.env.DRIVE_TMP_DIR || path.join(process.cwd(), "storage", "drive");
const DRIVE_CMD = process.env.DRIVE_CMD || "";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), "logs");
const LOG_CONSOLE_NOTIFY = (process.env.LOG_CONSOLE_NOTIFY || "0").toLowerCase() === "1"
  || (process.env.LOG_CONSOLE_NOTIFY || "0").toLowerCase() === "true";

const XENFORO_API_KEY = process.env.XENFORO_API_KEY || "";
const XENFORO_API_USER = process.env.XENFORO_API_USER || "";

const DEBUG = (process.env.DEBUG || "0") === "1";
const DEFAULT_PARALLEL = parseInt(process.env.PARALLEL || "3", 10);

const SAVE_MAX_RETRIES = parseInt(process.env.SAVE_MAX_RETRIES || "3", 10);
const SAVE_MAX_WINDOW_S = parseInt(process.env.SAVE_MAX_WINDOW_S || "120", 10);

const VERIFY_RETRIES = parseInt(process.env.VERIFY_RETRIES || "1", 10);
const MAX_IMAGE_HEIGHT = parseInt(process.env.MAX_IMAGE_HEIGHT || "10000", 10);


const RE_NEXT_BUTTON = /^\s*(?:siguiente|next|continuar|continue)\s*$/i;
const RE_UPLOAD_NOW_BUTTON = /(?:subir\s+ahora|upload\s+now|start\s+upload)/i;
const RE_CONFIRM_PUBLISH_BUTTON = /(?:confirmar\s+y\s+publicar|confirm\s+and\s+publish)/i;

// ===== stale-draft detection =====
// Rastrea que container_id fue asignado a cada capitulo en esta sesion.
// Si un capitulo nuevo recibe el mismo container_id que un capitulo DIFERENTE ya procesado,
// el servidor reutilizo el borrador anterior (draft obsoleto \u2192 riesgo de corrupcion de datos).
const _containerChapterMap = new Map(); // containerId (string) \u2192 chapterNumber

const TOAST_ERROR_TEXTS = [
  "Oops! Nos hemos encontrado con algunos problemas",
  "El servidor no responde en tiempo",
  "int\u00e9ntalo otra vez",
];

const CHAPTER_ANCHOR = [
  ".structItem--resourceAlbum .structItem-title a[href*='/comics/capitulo/link/']",
  ".structItem-title a[href*='/comics/capitulo/link/']",
  ".structItem-title a[href*='/comics/capitulos/']",
  ".structItem-title a[href*='/comics/capitulo/']",
  ".structItem-title a[href*='/capitulo/']",
  ".structItem-title a[href*='/capitulos/']",
  ".structItem-title a",
  ".contentRow-title a",
  "a[href*='/comics/capitulo/link/']",
  "a[href*='/comics/capitulos/']",
  "a[href*='/comics/capitulo/']",
].join(", ");

const CHAPTER_ROW = [
  ".structItem--resourceAlbum",
  ".structItem",
  ".contentRow",
  ".block-row",
  "li",
  "article",
].join(", ");

// ===== small cli parser (no deps) =====
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function dbg(msg) { if (DEBUG) report(`[DEBUG] ${msg}`, LOG_TYPES.SYSTEM); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function isUrl(val) {
  return typeof val === "string" && /^https?:\/\//i.test(val.trim());
}

function extractDriveFolderId(url) {
  const m = String(url).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const m2 = String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m2 ? m2[1] : null;
}

function buildDriveCommand(url, destDir) {
  if (DRIVE_CMD) {
    return DRIVE_CMD.replace(/\{url\}/g, `"${url}"`).replace(/\{dest\}/g, `"${destDir}"`);
  }
  return `python -m gdown --folder "${url}" -O "${destDir}"`;
}

async function downloadDriveFolder(url) {
  const folderId = extractFolderIdJS(url) || extractDriveFolderId(url);
  if (!folderId) throw new Error("No se pudo extraer el ID de la carpeta de Drive.");
  const destDir = path.join(DRIVE_TMP_DIR, folderId);
  ensureDir(destDir);

  // Intentar primero con el modulo JS nativo (sin Python)
  console.log("[INFO] Descargando desde Drive con modulo JS nativo...");
  try {
    await downloadDriveFolderJS(url, destDir, {
      onProgress: (msg) => console.log(`  [DRIVE] ${msg}`),
      recursive: true,
    });
    console.log("[INFO] Descarga finalizada (JS nativo). Continuando con la subida a la web...");
    return destDir;
  } catch (e) {
    console.log(`[WARN] Modulo JS fallo: ${e.message}. Intentando con gdown/DRIVE_CMD...`);
  }

  // Fallback a gdown/DRIVE_CMD
  const cmd = buildDriveCommand(url, destDir);
  const res = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (res.status !== 0) {
    throw new Error("Fallo la descarga desde Drive. Ni JS nativo ni gdown funcionaron.");
  }
  console.log("[INFO] Descarga finalizada (gdown). Continuando con la subida a la web...");
  return destDir;
}
function isLegacyWindows() {
  if (process.platform !== "win32") return false;
  const rel = os.release(); // 6.1 = Win7, 6.2/6.3 = Win8/8.1
  return rel.startsWith("6.1");
}

function findLegacyChromePath() {
  if (LEGACY_CHROME_PATH && fs.existsSync(LEGACY_CHROME_PATH)) return LEGACY_CHROME_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Chromium\\chrome.exe",
    "C:\\Chrome\\chrome.exe",
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "";
}

function getChromiumLaunchOptions() {
  const options = {
    headless: HEADLESS,
    slowMo: SLOW_MO_MS,
    args: [
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-features=TranslateUI",
    ],
  };
  if (isLegacyWindows()) {
    const legacyPath = findLegacyChromePath();
    if (legacyPath) {
      options.executablePath = legacyPath;
      console.log(`[INFO] Win7 detectado. Usando Chromium/Chrome externo: ${legacyPath}`);
    } else {
      console.log("[WARN] Win7 detectado y no se encontro Chrome/Chromium. Es probable que falle.");
    }
  }
  return options;
}

async function snap(page, name) {
  if (!DEBUG) return;
  try {
    const d = path.join(process.cwd(), "_debug");
    ensureDir(d);
    const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    const filename = `${Date.now()}_${safe}.png`;
    await page.screenshot({ path: path.join(d, filename), fullPage: true });
  } catch {}
}

// Sistema de logging severo: canales separados y trazabilidad con timestamp+secuencia
const LOG_TYPES = {
  SYSTEM: "system",
  CHAPTER: "chapter",
  NOTIFY: "notify",
};

const LOG_FILES = {
  system: path.join(LOG_DIR, "system.log"),
  chapter: path.join(LOG_DIR, "upload.log"),
  notify: path.join(LOG_DIR, "notify.log"),
  all: path.join(LOG_DIR, "all.log"),
};

let logSeq = 0;
const LOG_CONTEXT = new AsyncLocalStorage();

function withLogContext(ctx, fn) {
  const current = LOG_CONTEXT.getStore() || {};
  return LOG_CONTEXT.run({ ...current, ...ctx }, fn);
}

function buildLogPrefix() {
  const ctx = LOG_CONTEXT.getStore();
  if (!ctx) return "";
  const parts = [];
  if (ctx.worker !== undefined && ctx.worker !== null && ctx.worker !== "") parts.push(`worker:${ctx.worker}`);
  if (ctx.chapter !== undefined && ctx.chapter !== null && ctx.chapter !== "") parts.push(`cap:${ctx.chapter}`);
  if (ctx.phase) parts.push(`phase:${ctx.phase}`);
  return parts.length ? `[${parts.join("][")}] ` : "";
}

function nowStamp() {
  return new Date().toISOString();
}

function nextLogSeq() {
  logSeq += 1;
  return String(logSeq).padStart(6, "0");
}

function tintByTag(msg) {
  if (msg.includes("[ERROR]")) return chalk.red(msg);
  if (msg.includes("[WARN]") || msg.includes("[ADVERTENCIA]") || msg.includes("[AVISO]")) return chalk.yellow(msg);
  if (msg.includes("[OK]") || msg.includes("[CONFIRMADO]")) return chalk.green(msg);
  if (msg.includes("[INFO]")) return chalk.cyan(msg);
  if (msg.includes("[DEBUG]")) return chalk.gray(msg);
  if (msg.includes("[NUEVO]") || msg.includes("[CREANDO]")) return chalk.magenta(msg);
  if (msg.includes("[SUBIENDO]")) return chalk.blue(msg);
  if (msg.includes("[OMITIDO]") || msg.includes("[SALTO]")) return chalk.dim(msg);
  if (msg.includes("[API")) return chalk.blueBright(msg);
  if (msg.includes("[WEB")) return chalk.cyanBright(msg);
  if (msg.includes("[REINTENTO]")) return chalk.yellow(msg);
  return msg;
}

function writeLogLine(type, msg) {
  try {
    ensureDir(LOG_DIR);
    const seq = nextLogSeq();
    const line = `${nowStamp()} | ${seq} | ${type.toUpperCase()} | ${msg}`;
    fs.appendFileSync(LOG_FILES.all, `${line}\n`, "utf8");
    if (LOG_FILES[type]) fs.appendFileSync(LOG_FILES[type], `${line}\n`, "utf8");
  } catch {}
}

function report(msg, type = LOG_TYPES.CHAPTER) {
  const prefixed = `${buildLogPrefix()}${msg}`;
  writeLogLine(type, prefixed);
  if (type === LOG_TYPES.SYSTEM) {
    console.log(chalk.bold("[SISTEMA]"), tintByTag(prefixed));
    return;
  }
  if (type === LOG_TYPES.NOTIFY) {
    if (LOG_CONSOLE_NOTIFY) console.log(chalk.bold("[NOTIFY]"), tintByTag(prefixed));
    return;
  }
  console.log(chalk.bold("[CAPITULO]"), tintByTag(prefixed));
}

function logSystem(msg) {
  report(msg, LOG_TYPES.SYSTEM);
}

function logChapter(msg) {
  report(msg, LOG_TYPES.CHAPTER);
}

async function notify(msg) {
  // No mezcla con progreso: canal separado (archivo notify.log + Telegram)
  report(msg, LOG_TYPES.NOTIFY);
  if (TG_TOKEN && TG_CHAT) {
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ chat_id: TG_CHAT, text: msg }).toString(),
      });
    } catch {}
  }
}

let pauseNotified = false;
async function waitIfPaused() {
  if (!PAUSE_FILE) return;
  while (true) {
    try {
      if (!fs.existsSync(PAUSE_FILE)) {
        if (pauseNotified) {
          report("[INFO] Reanudado.");
          pauseNotified = false;
        }
        return;
      }
      if (!pauseNotified) {
        report("[INFO] Pausado. Esperando reanudacion...");
        pauseNotified = true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
}

function rlQuestion(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ===== XenForo API =====
async function apiRequest(endpoint, method="GET", data=null, maxRetries=3) {
  if (!XENFORO_API_KEY) return null;
  const url = `${BASE_URL.replace(/\/$/, "")}/api/${endpoint.replace(/^\//, "")}`;
  const headers = {
    "XF-Api-Key": XENFORO_API_KEY,
    "Content-Type": "application/json",
  };
  if (XENFORO_API_USER) headers["XF-Api-User"] = XENFORO_API_USER;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: (method === "GET" || method === "HEAD") ? undefined : JSON.stringify(data || {}),
      });

      if (resp.status === 200) return await resp.json();
      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get("Retry-After") || "60", 10);
        report(`[API] Rate limit, esperando ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      const txt = await resp.text();
      dbg(`API error ${resp.status}: ${txt.slice(0,200)}`);
      return null;
    } catch (e) {
      dbg(`API request error (intento ${attempt}/${maxRetries}): ${e}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, (2 ** attempt) * 1000));
    }
  }
  return null;
}

function extractResourceIdFromUrl(url) {
  const m = url.match(/\/comics\/[^/]+\.(\d+)\/?/);
  return m ? m[1] : null;
}

async function getResourceChaptersViaApi(resourceId) {
  try {
    const r = await apiRequest(`resource-manager/resources/${resourceId}/updates`);
    return (r && r.updates) ? r.updates : [];
  } catch (e) { dbg(`Error obteniendo cap\u00edtulos v\u00eda API: ${e}`); return []; }
}

async function getChapterDetailsViaApi(chapterId) {
  try { return await apiRequest(`resource-manager/resource-updates/${chapterId}`); }
  catch (e) { dbg(`Error obteniendo detalles de cap\u00edtulo v\u00eda API: ${e}`); return null; }
}

async function verifyChapterImagesViaApi(chapterId) {
  try {
    const details = await getChapterDetailsViaApi(chapterId);
    if (details && details.update) {
      const att = details.update.Attachments ?? details.update.attachments;
      if (Array.isArray(att)) return att.length;
      if (att && typeof att === "object") return Object.keys(att).length;
    }
    return -1;
  } catch (e) { dbg(`Error verificando im\u00e1genes v\u00eda API: ${e}`); return -1; }
}

// ===== helpers =====
async function go(page, url, fast=true) {
  await page.goto(url, { waitUntil: fast ? "domcontentloaded" : "load" });
}

function normalizeChapterTokenKeepDecimals(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const m = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const intPart = String(parseInt(m[1], 10));
  const decPart = m[2];
  if (decPart !== undefined) return `${intPart}.${decPart}`;
  return intPart;
}

function normalizeSiteComparableChapterToken(value) {
  const token = normalizeChapterTokenKeepDecimals(value);
  if (!token) return null;
  const [intPart, decPart = ""] = token.split(".");
  if (!decPart) return intPart;
  const trimmed = decPart.replace(/0+$/g, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

function buildSiteAlternateChapterToken(baseToken) {
  const normalizedBase = normalizeSiteComparableChapterToken(baseToken);
  if (!normalizedBase) return null;
  const [intPart, decPart = ""] = normalizedBase.split(".");
  if (!decPart) return `${intPart}.55`;
  return `${intPart}.${decPart}5`;
}

function assignSiteUploadNumbers(chapters, publishedNumbers = new Set()) {
  const sortedChapters = [...chapters].sort((a, b) => compareChapterTokens(a.number, b.number));
  const groups = new Map();
  for (const chapter of sortedChapters) {
    const groupKey = normalizeSiteComparableChapterToken(chapter.number) || chapter.number;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(chapter);
  }

  const usedUploadNumbers = new Set(Array.from(publishedNumbers).filter(Boolean));
  const orderedGroupKeys = Array.from(groups.keys()).sort(compareChapterTokens);

  for (const groupKey of orderedGroupKeys) {
    const groupItems = groups.get(groupKey) || [];
    groupItems.sort((a, b) => compareChapterTokens(a.number, b.number));
    const baseUploadNumber = normalizeSiteComparableChapterToken(groupKey) || groupKey;
    const alternateUploadNumber = buildSiteAlternateChapterToken(groupKey);
    const isFiveCollisionGroup = /\.5$/.test(baseUploadNumber);

    groupItems.forEach((chapter, idx) => {
      chapter.skipBecauseSiteNumberConflict = false;
      chapter.skipReason = "";

      const preferredUpload = baseUploadNumber;
      const preferredNormalized = normalizeChapterNumber(preferredUpload);
      const alternateNormalized = normalizeChapterNumber(alternateUploadNumber);

      // Regla normal: un solo capitulo usa su numero base; si ya existe en la web, se omite.
      if (!isFiveCollisionGroup) {
        if (preferredNormalized && !usedUploadNumbers.has(preferredNormalized)) {
          chapter.uploadNumber = preferredUpload || chapter.number;
          usedUploadNumbers.add(preferredNormalized);
          return;
        }
        chapter.uploadNumber = null;
        chapter.skipBecauseSiteNumberConflict = true;
        chapter.skipReason = `El capitulo ${preferredUpload} ya existe en la web.`;
        return;
      }

      // Regla especial del sitio para familias X.5 / X.50:
      // el primero usa X.5 y el segundo X.55; no se generan mas variantes.
      if (idx === 0 && preferredNormalized && !usedUploadNumbers.has(preferredNormalized)) {
        chapter.uploadNumber = preferredUpload || chapter.number;
        usedUploadNumbers.add(preferredNormalized);
        return;
      }

      if (idx === 1 && alternateNormalized && !usedUploadNumbers.has(alternateNormalized)) {
        chapter.uploadNumber = alternateUploadNumber || chapter.number;
        usedUploadNumbers.add(alternateNormalized);
        return;
      }

      chapter.uploadNumber = null;
      chapter.skipBecauseSiteNumberConflict = true;
      chapter.skipReason = `El sitio ya no admite otro duplicado para ${baseUploadNumber}; ${alternateUploadNumber} ya existe o esta reservado.`;
    });
  }

  return chapters;
}

function compareChapterTokens(a, b) {
  const tokenA = normalizeChapterTokenKeepDecimals(a);
  const tokenB = normalizeChapterTokenKeepDecimals(b);
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

function extractChapterTokenFromString(text) {
  const original = String(text || "").trim();
  if (!original) return null;

  const normalized = normalizeTextLoose(original);
  const byCap = normalized.match(/\b(?:cap(?:itulo)?|chapter)\s*([0-9]+(?:[.,][0-9]+)?)/i);
  if (byCap) return normalizeChapterTokenKeepDecimals(byCap[1]);

  const firstNum = original.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (firstNum) return normalizeChapterTokenKeepDecimals(firstNum[1]);

  return null;
}

function findChapterTokenSpan(name) {
  const original = String(name || "");
  if (!original.trim()) return null;

  const withPrefix = /\b(?:cap(?:[i\u00edt]tulo)?|chapter)\s*[._-]*\s*[0-9]+(?:[.,][0-9]+)?/i.exec(original);
  if (withPrefix) {
    const start = withPrefix.index ?? 0;
    return { start, end: start + withPrefix[0].length };
  }

  const firstNum = /[0-9]+(?:[.,][0-9]+)?/.exec(original);
  if (!firstNum) return null;
  const start = firstNum.index ?? 0;
  return { start, end: start + firstNum[0].length };
}

function deriveChapterStep1Fields(chapterNumber, chapterExtra = "") {
  const normalized = normalizeChapterTokenKeepDecimals(chapterNumber);
  return {
    numberValue: normalized || String(chapterNumber || "").trim(),
    extraValue: String(chapterExtra || "").trim(),
  };
}

function chapterNumberFromText(text) {
  return extractChapterTokenFromString(text);
}

function chapterNumberFromFolderName(name) {
  return extractChapterTokenFromString(name);
}

function extractChapterExtraFromFolderName(name) {
  const original = String(name || "").trim();
  if (!original) return "";

  const span = findChapterTokenSpan(original);
  const withoutNumber = span ? original.slice(span.end) : original;

  let extra = withoutNumber.replace(/^[\s\-â€“â€”_:|.]+/, "").trim();
  extra = extra.replace(/^\d+(?:[.,]\d+)?\b/, "").replace(/^[\s\-â€“â€”_:|.]+/, "").trim();
  return extra;
}

function normalizeChapterNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(",", ".").trim());
  if (Number.isNaN(n)) return null;
  if (Number.isInteger(n)) return String(parseInt(String(n), 10));
  return String(n).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeTextLoose(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toNumberMaybe(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(String(val).replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function displayTextFor(num) {
  const normalized = normalizeChapterTokenKeepDecimals(num);
  return `Cap\u00edtulo ${normalized || num}`;
}

function naturalKey(name) {
  return name.split(/(\d+)/).map(t => /^\d+$/.test(t) ? parseInt(t,10) : t.toLowerCase());
}

function listImages(dirPath) {
  const ok = new Set([".jpg",".jpeg",".png",".webp"]);
  const files = fs.readdirSync(dirPath).map(f => path.join(dirPath, f)).filter(p => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && ok.has(path.extname(p).toLowerCase()) && st.size > 0;
    } catch { return false; }
  });
  files.sort((a,b) => {
    const ka = naturalKey(path.basename(a));
    const kb = naturalKey(path.basename(b));
    for (let i=0; i<Math.max(ka.length,kb.length); i++){
      if (ka[i] === undefined) return -1;
      if (kb[i] === undefined) return 1;
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
  return files;
}

function calculateChapterSizeMB(files) {
  try {
    let total = 0;
    for (const f of files) total += fs.statSync(f).size;
    return total / (1024*1024);
  } catch { return 0; }
}

function calculateSaveTimeout(sizeMB) {
  if (sizeMB <= 10) return 45;
  if (sizeMB <= 15) return 60;
  if (sizeMB <= 20) return 80;
  if (sizeMB <= 25) return 110;
  return Math.floor(110 + (sizeMB - 25) * 4);
}

// ===== Toast detection =====
async function hasTimeoutToast(page) {
  const selectors = [
    "div.flashMessage", "div.blockMessage", "div.notice", "div.toast",
    "div[role='alert']", "div[aria-live='polite']"
  ];
  try {
    for (const sel of selectors) {
      const loc = page.locator(sel);
      const c = await loc.count();
      if (c) {
        const texts = await loc.allInnerTexts();
        const txt = texts.join(" ").trim().toLowerCase();
        if (TOAST_ERROR_TEXTS.some(t => txt.includes(t.toLowerCase()))) return true;
      }
    }
  } catch {}
  return false;
}

async function dismissToastIfAny(page) {
  try {
    await page.locator(".flashMessage .close, .notice .close, .toast .close, .js-dismiss, button[aria-label='Cerrar'], button[aria-label='Close']").first().click({ timeout: 500 });
  } catch {}
}

// ===== Login (cookie reuse) =====
async function ensureLogin(page, context) {
  page.setDefaultTimeout(TIMEOUT_MS);

  const isLogged = async () => (await page.locator(".p-navgroup-link--user, .p-navgroup-link--account").count()) > 0;

  if (await isLogged()) return true;

  if (!page.url().toLowerCase().includes("login")) {
    await go(page, LOGIN_URL);
    await page.waitForTimeout(1000);
  }

  if (await isLogged()) return true;

  await snap(page, "00_login_page");

  const form = page.locator("form[action*='/login']").first();
  if (await form.count() === 0) throw new Error("No encontr\u00e9 el formulario de login.");

  const user = form.locator("input[name=login], #login, input[type=text]").first();
  const pw = form.locator("input[name=password], #password, input[type=password]").first();
  if ((await user.count()) === 0 || (await pw.count()) === 0) throw new Error("No encontr\u00e9 campos de login/password.");

  await user.fill(USERNAME);
  await pw.fill(PASSWORD);

  const remember = form.locator("input[name=remember], #remember, input[type=checkbox][name=remember]").first();
  try {
    if ((await remember.count()) && !(await remember.isChecked())) await remember.check();
  } catch {}

  let btn = form.getByRole("button", { name: /Iniciar sesi/i });
  if ((await btn.count()) === 0) btn = form.locator("button[type=submit], input[type=submit]").first();
  try {
    await btn.first().click({ timeout: 3000 });
  } catch {
    await pw.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded");
  await snap(page, "01_after_login_submit");

  if ((await page.locator(".blockMessage.blockMessage--error, .formRow--error, .is-error").count()) > 0) {
    const err = await page.locator(".blockMessage.blockMessage--error, .formRow--error, .is-error").allInnerTexts();
    throw new Error(`Error de login: ${err.join(" | ")}`);
  }

  if (!(await isLogged())) throw new Error("Sigo en login tras enviar (\u00bfcaptcha/Cloudflare?).");

  // save storage state (only caller decides when)
  try {
    await context.storageState({ path: STORAGE_STATE });
  } catch {}

  return true;
}

function storageStatePathIfExists() {
  const p = path.isAbsolute(STORAGE_STATE) ? STORAGE_STATE : path.join(process.cwd(), STORAGE_STATE);
  return fs.existsSync(p) ? p : null;
}

function getContextOptions(storagePath) {
  const opts = {};
  if (storagePath) opts.storageState = storagePath;
  if (USER_AGENT) opts.userAgent = USER_AGENT;
  if (LOCALE) opts.locale = LOCALE;
  return opts;
}

// ===== Overlay chapter creation =====
async function getOverlayOrRoot(page) {
  const candidates = [
    ".overlay[role='dialog']",
    ".overlay",
    "[data-overlay]",
    ".xFOverlay",
    ".modal, .dialog, .xfOverlay",
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) && (await loc.isVisible())) return loc;
    } catch {}
  }
  return page;
}

async function openAddChapterOverlay(page, chaptersListUrl, resourceUrl) {
  await go(page, chaptersListUrl);
  await page.waitForLoadState("domcontentloaded");
  await snap(page, "10_chapters_list");

  let btn = page.locator("a,button").filter({ hasText: /Agregar\s+cap/i });
  if ((await btn.count()) === 0) {
    btn = page.locator("a,button").filter({ hasText: /^\s*\+?\s*cap/i });
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if ((await btn.count()) > 0) {
        try { await btn.first().scrollIntoViewIfNeeded(); } catch {}
        await btn.first().click({ timeout: 3000 });
        await page.waitForLoadState("domcontentloaded");
        if (await isStepperWizardPage(page)) {
          await snap(page, `11_stepper_by_button_try${attempt}`);
          return;
        }
      }
    } catch (e) {
      dbg(`[stepper] intento ${attempt} sin exito: ${e}`);
    }
    await page.waitForTimeout(700);
  }

  const addUrl = resourceUrl.replace(/\/$/, "") + "/capitulos/add";
  await go(page, addUrl);
  await page.waitForLoadState("domcontentloaded");
  if (!(await isStepperWizardPage(page))) {
    throw new Error("No se pudo abrir el stepper de capitulos.");
  }
  await snap(page, "12_stepper_by_url");
}

async function isStepperWizardPage(page) {
  try {
    const u = String(page.url() || "").toLowerCase();
    if (u.includes("/capitulos/add")) return true;
    const hasBatchPanels = await page.locator(".js-bbgPanel[data-step], .bbgBatchPanel[data-step]").count().catch(() => 0);
    if (hasBatchPanels > 0) return true;
    const hasBatchUi = await page.locator(".bbgBatchStepper, .js-bbgSummary, .bbgMangaUploader, .js-bbgDropzone").count().catch(() => 0);
    if (hasBatchUi > 0) return true;
    const body = normalizeTextLoose(await page.locator("body").innerText());
    if (body.includes("stepper de capitulos en lote")) return true;
    if (body.includes("paso 1") || body.includes("paso 2") || body.includes("paso 3") || body.includes("paso 4")) return true;
  } catch {}
  return false;
}

async function waitForStepperStep(page, stepNum, timeoutMs = 20000) {
  async function detectActiveStepFromDom() {
    return page.evaluate(() => {
      const norm = (x) => String(x || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      const activeHint = (el) => {
        if (!el) return false;
        const cls = norm(el.className || "");
        const ariaCurrent = norm(el.getAttribute?.("aria-current") || "");
        const dataState = norm(el.getAttribute?.("data-state") || "");
        const dataStatus = norm(el.getAttribute?.("data-status") || "");
        const dataActive = norm(el.getAttribute?.("data-active") || "");
        return (
          cls.includes("active")
          || cls.includes("current")
          || cls.includes("selected")
          || cls.includes("is-active")
          || cls.includes("iscurrent")
          || ariaCurrent === "step"
          || ariaCurrent === "true"
          || dataState === "active"
          || dataStatus === "active"
          || dataActive === "true"
        );
      };
      const textToStep = (txt) => {
        const t = norm(txt);
        const m = t.match(/\bpaso\s*(\d+)\b/);
        if (m) return parseInt(m[1], 10);
        if (t.includes("step")) {
          const em = t.match(/\bstep\s*(\d+)\b/);
          if (em) return parseInt(em[1], 10);
        }
        if (t.includes("contexto") || t.includes("context")) return 1;
        if (t.includes("programacion") || t.includes("programar") || t.includes("schedule") || t.includes("fecha de publicacion") || t.includes("fecha de pub") || t.includes("fecha pub") || t.includes("programada") || t.includes("agendar")) return 2;
        if (t.includes("carga de paginas") || t.includes("paginas") || t.includes("gestionar paginas") || t.includes("pages")) return 3;
        if (t.includes("confirmacion") || t.includes("confirmar y publicar") || t.includes("confirmation") || t.includes("confirm and publish")) return 4;
        return null;
      };

      const activePanel = document.querySelector(".js-bbgPanel.is-active[data-step], .bbgBatchPanel.is-active[data-step]");
      if (activePanel) {
        const rawStep = activePanel.getAttribute("data-step");
        const parsedStep = parseInt(rawStep || "", 10);
        if (!Number.isNaN(parsedStep)) return parsedStep;
      }

      const nodes = Array.from(document.querySelectorAll("li, button, a, div, span, h1, h2, h3"));
      for (const el of nodes) {
        if (!activeHint(el)) continue;
        const step = textToStep(el.textContent || "");
        if (step) return step;
      }

      // Paso 3: verificar señales estructurales PRIMERO
      if (
        document.querySelector(".bbgMangaUploader, .js-bbgDropzone, .js-bbgFileInput[type='file'], .js-bbgStatus, .js-bbgGlobalProgressText")
      ) return 3;

      // Fallback por el título del panel activo ("Paso X:").
      const activePanelText = norm(activePanel?.innerText || activePanel?.textContent || "");
      if (activePanelText.includes("paso 1") || activePanelText.includes("step 1") || activePanelText.includes("numero de capitulo") || activePanelText.includes("numero capitulo")) return 1;
      if (activePanelText.includes("paso 2") || activePanelText.includes("step 2") || activePanelText.includes("programacion") || activePanelText.includes("programar") || activePanelText.includes("fecha de publicacion") || activePanelText.includes("programada")) return 2;
      if (activePanelText.includes("paso 3") || activePanelText.includes("step 3") || activePanelText.includes("carga de paginas") || activePanelText.includes("gestiona la carga")) return 3;
      if (activePanelText.includes("paso 4") || activePanelText.includes("step 4") || activePanelText.includes("confirmar y publicar") || activePanelText.includes("confirm and publish") || activePanelText.includes("confirmacion") || activePanelText.includes("confirmation")) return 4;
      return null;
    });
  }

  const t0 = Date.now();
  const stepText = normalizeTextLoose(`paso ${stepNum}`);
  while (Date.now() - t0 < timeoutMs) {
    try {
      const activeStep = await detectActiveStepFromDom();
      if (activeStep === stepNum) return true;

      const activePanelText = await page.evaluate(() => {
        const panel = document.querySelector(".js-bbgPanel.is-active[data-step], .bbgBatchPanel.is-active[data-step]");
        return panel ? (panel.innerText || panel.textContent || "") : "";
      }).catch(() => "");
      const panelText = normalizeTextLoose(activePanelText);
      if (panelText.includes(stepText)) return true;
      if (stepNum === 1 && (panelText.includes("numero de capitulo") || panelText.includes("numero capitulo"))) return true;
      if (stepNum === 2 && (panelText.includes("paso 2") || panelText.includes("step 2"))) return true;
      if (stepNum === 3) {
        const hasUploadUi = await page.locator(".bbgMangaUploader, .js-bbgDropzone, .js-bbgFileInput[type='file'], .js-bbgStatus, .js-bbgGlobalProgressText").count().catch(() => 0);
        if (hasUploadUi > 0) return true;
      }
      if (stepNum === 4) {
        const hasSummary = await page.locator(".js-bbgSummary, .bbgBatchSummaryHead, .dataList").count().catch(() => 0);
        if (hasSummary > 0 && panelText.includes("confirmacion")) return true;
      }
    } catch {}
    await page.waitForTimeout(250);
  }
  return false;
}

async function hasStepperChapterNumberField(page) {
  return page.evaluate(() => {
    const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const activePanel = document.querySelector(".js-bbgPanel.is-active[data-step='1'], .bbgBatchPanel.is-active[data-step='1']");
    if (activePanel) {
      const panelInputs = Array.from(activePanel.querySelectorAll("input[type='text'], input[type='number'], input:not([type]), textarea"));
      for (const input of panelInputs) {
        const placeholder = norm(input.getAttribute("placeholder") || "");
        const name = norm(input.getAttribute("name") || "");
        const cls = norm(input.className || "");
        if (
          placeholder.includes("capitulo")
          || placeholder.includes("chapter")
          || name.includes("chapter")
          || name.includes("capitulo")
          || cls.includes("chapter")
          || cls.includes("capitulo")
        ) return true;
      }
    }

    const labels = Array.from(document.querySelectorAll("label, .formRow-label, .inputLabel"));
    for (const lab of labels) {
      const t = norm(lab.textContent || "");
      if (!t.includes("numero de capitulo") && !t.includes("numero capitulo") && !t.includes("capitulo") && !t.includes("chapter")) continue;

      const forId = lab.getAttribute("for");
      let input = null;
      if (forId) input = document.getElementById(forId);
      if (!input) input = lab.closest(".formRow, .inputGroup, .field, .block-row, section, div")?.querySelector("input");
      if (!input) {
        let n = lab.nextElementSibling;
        while (n && !input) {
          input = n.matches?.("input") ? n : n.querySelector?.("input");
          n = n.nextElementSibling;
        }
      }
      if (input) return true;
    }
    return false;
  });
}

async function hasStepperUploadSurface(page) {
  return page.evaluate(() => {
    // Senales directas del uploader (evitar heuristica por texto global).
    const directSelectors = [
      "input.js-bbgFileInput[type='file']",
      "input[type='file']",
      ".js-bbgDropzone",
      ".bbgMangaUploader",
      ".js-bbgStatus",
      ".js-bbgGlobalProgressText",
      ".js-bbgGlobalProgressFill",
      "input.js-bbgPolicyConfirm[type='checkbox']",
      "label.bbgMangaUploader-policyToggle",
    ];
    for (const sel of directSelectors) {
      if (document.querySelector(sel)) return true;
    }

    return false;
  });
}

async function clickVisibleButtonByText(page, re, timeoutMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const loc = page.locator("button, a, input[type='button'], input[type='submit']").filter({ hasText: re });
    const c = await loc.count();
    for (let i = 0; i < c; i++) {
      const b = loc.nth(i);
      try {
        if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
        await b.scrollIntoViewIfNeeded();
        await b.click({ timeout: 2000 });
        return true;
      } catch {}
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function fillStepperChapterNumber(page, chapterValue) {
  const ok = await page.evaluate((val) => {
    const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const activePanel = document.querySelector(".js-bbgPanel.is-active[data-step='1'], .bbgBatchPanel.is-active[data-step='1']");
    if (activePanel) {
      const candidates = Array.from(activePanel.querySelectorAll("input[type='text'], input[type='number'], input:not([type])"));
      for (const input of candidates) {
        const placeholder = norm(input.getAttribute("placeholder") || "");
        const name = norm(input.getAttribute("name") || "");
        const cls = norm(input.className || "");
        const looksLikeChapterField = (
          placeholder.includes("capitulo")
          || placeholder.includes("chapter")
          || name.includes("chapter")
          || name.includes("capitulo")
          || cls.includes("chapter")
          || cls.includes("capitulo")
        );
        if (!looksLikeChapterField) continue;
        input.disabled = false;
        input.readOnly = false;
        input.removeAttribute("disabled");
        input.removeAttribute("readonly");
        input.focus();
        input.value = String(val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    const labels = Array.from(document.querySelectorAll("label, .formRow-label, .inputLabel"));

    for (const lab of labels) {
      const t = norm(lab.textContent || "");
      if (!t.includes("numero de capitulo") && !t.includes("numero capitulo") && !t.includes("capitulo") && !t.includes("chapter")) continue;

      const forId = lab.getAttribute("for");
      let input = null;
      if (forId) input = document.getElementById(forId);
      if (!input) input = lab.closest(".formRow, .inputGroup, .field, .block-row, section, div")?.querySelector("input");
      if (!input) {
        let n = lab.nextElementSibling;
        while (n && !input) {
          input = n.matches?.("input") ? n : n.querySelector?.("input");
          n = n.nextElementSibling;
        }
      }
      if (!input) continue;
      input.disabled = false;
      input.readOnly = false;
      input.removeAttribute("disabled");
      input.removeAttribute("readonly");
      input.focus();
      input.value = String(val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }, chapterValue);

  if (!ok) throw new Error("No se pudo escribir el numero de capitulo en Stepper (Paso 1).");
}

async function fillStepperChapterTitleOptional(page, titleValue) {
  if (!titleValue) return false;
  const ok = await page.evaluate((val) => {
    const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const labels = Array.from(document.querySelectorAll("label, .formRow-label, .inputLabel"));

    for (const lab of labels) {
      const t = norm(lab.textContent || "");
      if (
        !t.includes("titulo") &&
        !t.includes("nombre del capitulo") &&
        !t.includes("nombre de capitulo")
      ) continue;

      const forId = lab.getAttribute("for");
      let input = null;
      if (forId) input = document.getElementById(forId);
      if (!input) input = lab.closest(".formRow, .inputGroup, .field, .block-row, section, div")?.querySelector("input, textarea");
      if (!input) {
        let n = lab.nextElementSibling;
        while (n && !input) {
          input = n.matches?.("input, textarea") ? n : n.querySelector?.("input, textarea");
          n = n.nextElementSibling;
        }
      }
      if (!input) continue;
      input.disabled = false;
      input.readOnly = false;
      input.removeAttribute("disabled");
      input.removeAttribute("readonly");
      input.focus();
      input.value = String(val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }, titleValue);
  return ok;
}

async function fillOverlayCreateChapter(page, chapterNumber, chapterExtra = "") {
  const derived = deriveChapterStep1Fields(chapterNumber, chapterExtra);
  const chapterValue = derived.numberValue;
  const chapterExtraValue = derived.extraValue;
  if (!(await isStepperWizardPage(page))) {
    throw new Error("No se detecto el stepper de capitulos.");
  }

  const inStep1 = await waitForStepperStep(page, 1, 10000);
  if (!inStep1) {
    const hasChapterInput = await hasStepperChapterNumberField(page);
    if (!hasChapterInput) throw new Error("No se detecto Paso 1 (Contexto) en el Stepper.");
    report("[INFO] Paso 1 no visible por texto; se detecto campo de numero de capitulo y se continua.");
  }

  await fillStepperChapterNumber(page, chapterValue);
  // Opcional: en algunas obras se necesita texto adicional (ej. "Parte 2").
  if (chapterExtraValue) {
    const wroteTitle = await fillStepperChapterTitleOptional(page, chapterExtraValue);
    if (wroteTitle) report(`[INFO] Titulo adicional aplicado: ${chapterExtraValue}`);
  }
  await page.waitForTimeout(250);

  const next1 = await clickVisibleButtonByText(page, /^\s*Siguiente\s*$/i, 10000);
  if (!next1) throw new Error("No se pudo avanzar de Paso 1 a Paso 2 en Stepper.");

  // Esperar Paso 2 o Paso 3 (la web a veces salta el Paso 2) con timeout combinado.
  let inStep2 = false;
  let skippedToStep3 = false;
  {
    const t0 = Date.now();
    const combinedTimeoutMs = 45000;
    while (Date.now() - t0 < combinedTimeoutMs) {
      const [s2, s3] = await Promise.all([
        waitForStepperStep(page, 2, 300).catch(() => false),
        waitForStepperStep(page, 3, 300).catch(() => false),
      ]);
      if (s2) { inStep2 = true; break; }
      if (s3) { skippedToStep3 = true; break; }
      await page.waitForTimeout(300);
    }
  }
  if (skippedToStep3) {
    report("[INFO] Paso 2 no se mostro explicitamente; la web avanzo directo a Paso 3 y se continua.");
    await snap(page, "20_stepper_step3_after_context_skip_step2");
    return;
  }
  if (!inStep2) {
    throw new Error("No se detecto Paso 2 (Programacion) en Stepper.");
  }

  const next2 = await clickVisibleButtonByText(page, /^\s*Siguiente\s*$/i, 10000);
  if (!next2) throw new Error("No se pudo avanzar de Paso 2 a Paso 3 en Stepper.");

  // Dar tiempo minimo a que la transicion al paso 3 se inicie.
  await page.waitForTimeout(400);

  const inStep3 = await waitForStepperStep(page, 3, 20000);
  if (!inStep3) {
    const hasUploadUi = await hasStepperUploadSurface(page);
    if (!hasUploadUi) throw new Error("No se detecto Paso 3 (Paginas) en Stepper.");
    report("[INFO] Paso 3 no visible por texto; se detecto UI de carga y se continua.");
  }

  await snap(page, "20_stepper_step3_after_context_and_program");
}

async function getLastPageNumberFast(page) {
  try {
    const txt = (await page.locator(".pageNavSimple-el--current").first().innerText()).trim();
    const m = txt.match(/(\d+)\s+de\s+(\d+)/);
    if (m) return parseInt(m[2],10);
  } catch {}
  try {
    const nums = await page.locator(".pageNav-main a").allInnerTexts();
    const ints = nums.map(x => x.trim()).filter(x => /^\d+$/.test(x)).map(x => parseInt(x,10));
    if (ints.length) return Math.max(...ints);
  } catch {}
  return 1;
}

function withPageParam(url, pageNum) {
  try {
    const u = new URL(url);
    if (pageNum <= 1) {
      u.searchParams.delete("page");
      return u.toString();
    }
    u.searchParams.set("page", String(pageNum));
    return u.toString();
  } catch {
    if (pageNum <= 1) return url;
    return `${url}${url.includes("?") ? "&" : "?"}page=${pageNum}`;
  }
}

async function isDescendingChapterOrder(page) {
  try {
    const descCtl = page.locator("button, a, .menuTrigger").filter({ hasText: /Descendente/i }).first();
    if ((await descCtl.count()) > 0) return true;
  } catch {}

  try {
    const items = page.locator(CHAPTER_ANCHOR);
    const total = Math.min(await items.count(), 5);
    const nums = [];
    for (let i = 0; i < total; i++) {
      const t = (await items.nth(i).innerText()).trim();
      const n = toNumberMaybe(parseChapterNumberFromAnchorText(t) || chapterNumberFromText(t));
      if (n !== null) nums.push(n);
      if (nums.length >= 2) break;
    }
    if (nums.length >= 2) return nums[0] >= nums[1];
  } catch {}

  return null;
}

function parseChapterNumberFromAnchorText(text) {
  const norm = normalizeTextLoose(text);
  const byCap = norm.match(/\b(?:cap(?:itulo)?|chapter)\s*([0-9]+(?:[.,][0-9]+)?)/i);
  if (byCap) return normalizeChapterTokenKeepDecimals(byCap[1]);
  const firstNum = text.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (firstNum) return normalizeChapterTokenKeepDecimals(firstNum[1]);
  return null;
}

function isLikelyChapterHref(href) {
  if (!href) return false;
  return href.includes("/capitulo/") || href.includes("/view/") || href.includes("/link/");
}

function textLooksLikeTargetChapter(text, targetNorm, targetNum) {
  const t = normalizeTextLoose(text);
  if (targetNorm && t === targetNorm) return true;
  if (targetNum !== null) {
    const n = normalizeChapterNumber(parseChapterNumberFromAnchorText(text) || chapterNumberFromText(text));
    if (n === targetNum) return true;
  }
  return false;
}

async function findChapterLinkInPage(page, chapterText) {
  const items = page.locator(CHAPTER_ANCHOR);
  const total = await items.count();
  const targetText = normalizeTextLoose(chapterText);
  const targetNum = normalizeChapterNumber(chapterNumberFromText(chapterText));

  if (DEBUG && total > 0 && total <= 10) {
    report(`[DEBUG] Buscando '${chapterText}' entre ${total} capitulos en la pagina`);
    for (let i=0; i<total; i++) {
      const t = (await items.nth(i).innerText()).trim();
      report(`[DEBUG]   [${i}] '${t}'`);
    }
  }

  for (let i=0; i<total; i++) {
    const t = (await items.nth(i).innerText()).trim();
    if (textLooksLikeTargetChapter(t, targetText, targetNum)) return items.nth(i);
  }

  // Fallback nuevo layout: el titulo puede no ser enlace clickeable.
  try {
    const rows = page.locator(CHAPTER_ROW);
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      let matched = false;
      const candidateTexts = [];
      try {
        const texts = await row.locator(".structItem-title, .contentRow-title, h1, h2, h3, a[href]").allInnerTexts();
        candidateTexts.push(...texts.map(x => String(x || "").trim()).filter(Boolean));
      } catch {}
      try {
        const rowText = (await row.innerText()).trim();
        if (rowText) candidateTexts.push(rowText);
      } catch {}

      for (const txt of candidateTexts) {
        if (textLooksLikeTargetChapter(txt, targetText, targetNum)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;

      const selectors = [
        "a[href*='/comics/capitulo/link/']",
        "a[href*='/comics/capitulos/']",
        "a[href*='/comics/capitulo/']",
        "a[href*='/capitulo/']",
        "a[href*='/edit']",
      ];
      for (const sel of selectors) {
        const link = row.locator(sel).first();
        if ((await link.count()) > 0) return link;
      }

      const anyLink = row.locator("a").first();
      if ((await anyLink.count()) > 0) return anyLink;
    }
  } catch {}

  // Fallback universal: si cambio el layout/clases, revisar todos los enlaces candidatos.
  try {
    const links = page.locator("a[href]");
    const linkCount = await links.count();
    for (let i = 0; i < linkCount; i++) {
      const link = links.nth(i);
      const href = (await link.getAttribute("href")) || "";
      if (!isLikelyChapterHref(href)) continue;

      const t = (await link.innerText()).trim();
      if (textLooksLikeTargetChapter(t, targetText, targetNum)) return link;
      if (targetNum !== null) {
        const hrefNum = normalizeChapterNumber(chapterNumberFromText(href));
        if (hrefNum !== null && hrefNum === targetNum) return link;
      }
    }
  } catch {}

  return null;
}


async function openChapterFromTopListIfMatches(page, expectedNumber) {
  const target = normalizeChapterNumber(expectedNumber);
  if (target === null) return { ok: false, chapterId: null };

  try {
    const rows = page.locator(".structItem--resourceAlbum, .structItem");
    const rowCount = Math.min(await rows.count(), 8);
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const rowText = (await row.innerText()).trim();
      const rowNum = normalizeChapterNumber(parseChapterNumberFromAnchorText(rowText) || chapterNumberFromText(rowText));
      if (rowNum !== target) continue;

      const link = row.locator("a[href*='/comics/capitulo/link/'], a[href*='/capitulo/'], a[href*='/edit'], a").first();
      if ((await link.count()) === 0) continue;

      let hrefAbs = null;
      try {
        const href = await link.getAttribute("href");
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          hrefAbs = new URL(href, BASE_URL).toString();
          await go(page, hrefAbs);
        } else {
          await link.click();
          await page.waitForLoadState("domcontentloaded");
        }
      } catch {
        await link.click();
        await page.waitForLoadState("domcontentloaded");
      }

      await page.waitForTimeout(350);
      const chapterId = getCurrentChapterIdFromUrl(page.url()) || (hrefAbs ? getCurrentChapterIdFromUrl(hrefAbs) : null);
      if (chapterId) {
        const directOk = await navigateToChapterById(page, chapterId);
        if (directOk) return { ok: true, chapterId };
      }
      return { ok: true, chapterId };
    }
  } catch {}

  return { ok: false, chapterId: null };
}

function getCurrentChapterIdFromUrl(url) {
  const m = url.match(/\/comics\/capitulo\/link\/(\d+)\/?/);
  if (m) return m[1];

  const mAdd = url.match(/\/capitulo-[^/]*\.(\d+)(?:\/add)?\/?/i);
  if (mAdd) return mAdd[1];

  const mGeneric = url.match(/\/capitulo-[^/]*\.(\d+)\/?/i);
  if (mGeneric) return mGeneric[1];

  const mNumerical = url.match(/\/(\d+)\/?(?:edit)?$/);
  return mNumerical ? mNumerical[1] : null;
}

async function navigateToChapterById(page, chapterId) {
  if (!chapterId) return false;
  const directUrl = `${BASE_URL.replace(/\/$/, "")}/comics/capitulo/link/${chapterId}/edit`;
  await go(page, directUrl);
  await page.waitForLoadState("domcontentloaded");
  if (page.url().includes("/login")) {
    await ensureLogin(page, page.context());
    await go(page, directUrl);
  }
  return page.url().includes(`/${chapterId}`) || page.url().includes(".id") || page.url().includes("/edit");
}

async function openChapterFromList(page, chaptersListUrl, chapterText) {
  await go(page, chaptersListUrl);
  await page.waitForLoadState("domcontentloaded");
  await snap(page, "30_list_page_initial");

  const targetNum = normalizeChapterNumber(chapterNumberFromText(chapterText));
  if (targetNum) {
    const topResult = await openChapterFromTopListIfMatches(page, targetNum);
    if (topResult.ok) return true;
  }

  const lastPage = await getLastPageNumberFast(page);
  const isDesc = await isDescendingChapterOrder(page);

  let pageRange = [];
  for (let i = 1; i <= lastPage; i++) pageRange.push(i);

  if (targetNum !== null && isDesc !== null) {
    const firstItems = page.locator(CHAPTER_ANCHOR);
    if ((await firstItems.count()) > 0) {
      const firstText = (await firstItems.first().innerText()).trim();
      const firstNum = normalizeChapterNumber(parseChapterNumberFromAnchorText(firstText) || chapterNumberFromText(firstText));
      if (firstNum !== null) {
        if (isDesc && toNumberMaybe(targetNum) > toNumberMaybe(firstNum)) {
          report(`[INFO] Buscando capitulo ${targetNum} (es mayor que el primero de la lista ${firstNum} en orden desc).`);
        } else if (!isDesc && toNumberMaybe(targetNum) < toNumberMaybe(firstNum)) {
          report(`[INFO] Buscando capitulo ${targetNum} (es menor que el primero de la lista ${firstNum} en orden asc).`);
        }
      }
    }
  }

  for (const p of pageRange) {
    if (p > 1) {
      await go(page, withPageParam(chaptersListUrl, p));
      await page.waitForLoadState("domcontentloaded");
    }
    const link = await findChapterLinkInPage(page, chapterText);
    if (link) {
      await link.click();
      await page.waitForLoadState("domcontentloaded");
      return true;
    }
  }
  return false;
}

async function chapterExistsInList(context, chaptersListUrl, chapterText) {
  const probe = await context.newPage();
  try {
    const found = await openChapterFromList(probe, chaptersListUrl, chapterText);
    return found;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => null);
  }
}

async function prepareFileSystemChapter(chapterDir) {
  const images = listImages(chapterDir);
  if (!images.length) return null;
  return {
    dir: chapterDir,
    images,
    number: chapterNumberFromFolderName(path.basename(chapterDir)),
    uploadNumber: chapterNumberFromFolderName(path.basename(chapterDir)),
    name: path.basename(chapterDir),
  };
}

// Preprocesamiento de imagenes para evitar errores de redimensionamiento/memoria en el servidor
async function preprocessImages(images) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    dbg("Modulo 'sharp' no disponible. Usando imagenes originales.");
    return images;
  }

  if (!images.length) return images;

  // Primera pasada: leer metadata de todas las imagenes y detectar si alguna supera MAX_IMAGE_HEIGHT
  const metadatas = [];
  let needsSlicing = false;
  for (const src of images) {
    try {
      const meta = await sharp(src).metadata();
      metadatas.push(meta);
      const exifSwap = meta.orientation >= 5 && meta.orientation <= 8;
      const effectiveHeight = exifSwap ? meta.width : meta.height;
      if (effectiveHeight > MAX_IMAGE_HEIGHT) needsSlicing = true;
    } catch {
      metadatas.push(null);
    }
  }

  // Si hay imagenes altas: guardar todo en subcarpeta persistente dentro del capitulo
  // (el set completo queda disponible para resubida manual si algo falla)
  // Si no: usar carpeta temporal como antes
  let processedDir;
  if (needsSlicing) {
    const chapterDir = path.dirname(images[0]);
    const chapterName = path.basename(chapterDir);
    processedDir = path.join(chapterDir, chapterName);
    ensureDir(processedDir);
    report(`[INFO] Imagenes altas detectadas. Set procesado guardado en: ${processedDir}`);
  } else {
    processedDir = path.join(os.tmpdir(), `xf_upload_${Date.now()}`);
    ensureDir(processedDir);
  }

  const results = [];
  let fileCounter = 0;

  report(`[INFO] Preprocesando ${images.length} imagenes...`);
  for (let i = 0; i < images.length; i++) {
    const src = images[i];
    const ext = path.extname(src).toLowerCase();
    const meta = metadatas[i];

    try {
      if (!meta) throw new Error("metadata no disponible");

      // Determinar dimensiones efectivas tras correccion EXIF (orientaciones 5-8 intercambian ancho/alto)
      const exifSwap = meta.orientation >= 5 && meta.orientation <= 8;
      const effectiveWidth = exifSwap ? meta.height : meta.width;
      const effectiveHeight = exifSwap ? meta.width : meta.height;

      if (effectiveHeight > MAX_IMAGE_HEIGHT) {
        // Cortar en franjas de MAX_IMAGE_HEIGHT
        let y = 0;
        let partIndex = 0;
        report(`[INFO] ${path.basename(src)} (${effectiveHeight}px) — dividiendo en partes de ${MAX_IMAGE_HEIGHT}px`);
        while (y < effectiveHeight) {
          const h = Math.min(MAX_IMAGE_HEIGHT, effectiveHeight - y);
          const sliceDest = path.join(processedDir, `${String(fileCounter).padStart(4, "0")}${ext === ".webp" ? ".webp" : ".jpg"}`);
          let slicePipeline = sharp(src)
            .rotate()
            .extract({ left: 0, top: y, width: effectiveWidth, height: h });
          if (effectiveWidth > 3000) {
            slicePipeline = slicePipeline.resize(3000, null, { withoutEnlargement: true });
          }
          if (ext === ".webp") {
            await slicePipeline.webp({ quality: 82 }).toFile(sliceDest);
          } else {
            await slicePipeline.jpeg({ quality: 85, progressive: true, mozjpeg: true }).toFile(sliceDest);
          }
          results.push(sliceDest);
          fileCounter++;
          y += h;
          partIndex++;
        }
        dbg(`${path.basename(src)}: ${partIndex} corte(s) generado(s)`);
      } else {
        const dest = path.join(processedDir, `${String(fileCounter).padStart(4, "0")}${ext === ".webp" ? ".webp" : ".jpg"}`);
        let pipeline = sharp(src).rotate(); // Corregir orientacion EXIF
        if (effectiveWidth > 3000) {
          pipeline = pipeline.resize(3000, null, { withoutEnlargement: true });
        }
        if (ext === ".webp") {
          await pipeline.webp({ quality: 82 }).toFile(dest);
        } else {
          await pipeline.jpeg({ quality: 85, progressive: true, mozjpeg: true }).toFile(dest);
        }
        results.push(dest);
        fileCounter++;
      }
    } catch (e) {
      dbg(`Error preprocesando ${path.basename(src)}: ${e.message}. Usando original.`);
      results.push(src);
    }
  }
  return results;
}

async function getChapterImageCount(page) {
  return page.evaluate(() => {
    try {
      const container = document.querySelector(".js-bbgStatus, .bbgMangaUploader-status");
      if (container) {
        const text = container.innerText || "";
        const m = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
      const items = document.querySelectorAll(".js-bbgItem, .bbgMangaUploader-item");
      if (items.length > 0) return items.length;
    } catch {}
    return 0;
  });
}

async function getVisibleQueuedImageCount(page) {
  return page.evaluate(() => {
    try {
      const items = document.querySelectorAll(".js-bbgQueue > li, .js-bbgItem, .bbgMangaUploader-item");
      return items.length;
    } catch {
      return 0;
    }
  });
}

async function tryClearResidualUploadQueue(page) {
  return page.evaluate(() => {
    const norm = (x) => String(x || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    const clearCandidates = Array.from(document.querySelectorAll("button, a, [role='button']")).filter((el) => {
      const txt = norm(el.textContent || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "");
      const cls = norm(el.className || "");
      return (
        txt.includes("eliminar")
        || txt.includes("quitar")
        || txt.includes("borrar")
        || txt.includes("remove")
        || txt.includes("delete")
        || txt.includes("clear")
        || txt.includes("vaciar")
        || cls.includes("remove")
        || cls.includes("delete")
        || cls.includes("trash")
      );
    });

    let clicked = 0;
    for (const el of clearCandidates) {
      try {
        el.click();
        clicked += 1;
      } catch {}
    }
    return clicked;
  });
}

async function ensureEmptyUploadQueue(page, timeoutMs = 12000) {
  const t0 = Date.now();
  let lastSeen = null;
  let cleanupTriggered = false;

  while (Date.now() - t0 < timeoutMs) {
    const queuedCount = await getVisibleQueuedImageCount(page);
    if (queuedCount !== lastSeen) {
      report(`[INFO] Verificando cola previa del panel: ${queuedCount} elementos.`);
      lastSeen = queuedCount;
    }
    if (queuedCount === 0) return true;

    if (!cleanupTriggered) {
      cleanupTriggered = true;
      report(`[WARN] Se detectaron ${queuedCount} elementos residuales. Intentando limpiar la cola anterior...`);
      const clicked = await tryClearResidualUploadQueue(page).catch(() => 0);
      if (clicked > 0) {
        report(`[INFO] Intento de limpieza ejecutado sobre ${clicked} controles del panel.`);
      } else {
        report("[WARN] No se encontraron controles claros para limpiar la cola residual.");
      }
    }

    await page.waitForTimeout(500);
  }

  const stuckCount = await getVisibleQueuedImageCount(page);
  if (stuckCount > 0) {
    await snap(page, `ERROR_queue_residual_${stuckCount}`);
    throw new Error(`La zona de carga conserva ${stuckCount} elementos del capitulo anterior. Se aborta para evitar mezclar imagenes.`);
  }
  return true;
}

async function waitUploadsComplete(page, expectedCount, timeoutMs = 600000) {
  const t0 = Date.now();
  let lastProgressStr = null;
  let stableIterations = 0;

  report(`[SUBIENDO] Esperando confirmacion de carga de ${expectedCount} imagenes...`);

  while (Date.now() - t0 < timeoutMs) {
    const progStr = await page.evaluate(() => {
      try {
        const textNode = document.querySelector(".js-bbgGlobalProgressText");
        return textNode ? textNode.innerText.trim() : null;
      } catch { return null; }
    });

    if (progStr !== null && progStr !== lastProgressStr) {
      report(`[SUBIENDO] Reporte de la web: ${progStr}`);
      lastProgressStr = progStr;
      stableIterations = 0;
    } else {
      stableIterations++;
    }

    // Solo confiar en el conteo exacto, no en "100%" que puede aparecer antes de que todas las imagenes finalicen
    const isComplete = progStr ? progStr.includes(`${expectedCount}/${expectedCount}`) : false;

    if (isComplete) {
       await page.waitForTimeout(2000);
       return true;
    }

    const errorCount = await page.locator(".js-bbgItemError:visible, .is-error:visible").count();
    if (errorCount > 0) {
       report(`[WARN] Se detectaron ${errorCount} posibles errores visibles de subida. Intentando continuar de todas formas...`);
    }

    await page.waitForTimeout(2000);

    if (stableIterations > 60) {
       report(`[WARN] La subida parece estancada en: ${lastProgressStr || "0"}. Abortando espera.`);
       return false;
    }
  }
  return false;
}

async function waitQueueItemsReady(page, expectedCount, timeoutMs = 30000) {
  const t0 = Date.now();
  let lastSeen = null;

  while (Date.now() - t0 < timeoutMs) {
    const queuedCount = await getVisibleQueuedImageCount(page);

    if (queuedCount !== lastSeen) {
      report(`[SUBIENDO] Cola detectada en la web: ${queuedCount}/${expectedCount}`);
      lastSeen = queuedCount;
    }

    if (queuedCount === expectedCount) return true;
    if (queuedCount > expectedCount) {
      throw new Error(`La cola visible contiene ${queuedCount} imagenes y se esperaban ${expectedCount}. Hay archivos residuales del capitulo anterior.`);
    }
    await page.waitForTimeout(500);
  }

  report(`[WARN] La cola visible no alcanzo ${expectedCount} elementos antes del timeout.`);
  return false;
}

async function clickSubirAhora(page, timeoutMs = 120000) {
  const btn = page.locator("button.js-bbgPublish").first();
  try {
    await btn.waitFor({ state: "attached", timeout: 10000 }).catch(() => null);
    
    if (await btn.count() === 0) {
       report("[ERROR] No existe el boton .js-bbgPublish en el DOM.");
       return false;
    }

    let isDisabled = await btn.evaluate(node => node.hasAttribute("disabled") || node.classList.contains("disabled") || node.classList.contains("is-disabled"));
    let waited = 0;
    
    if (isDisabled) {
      report(`[DEBUG] Boton 'Subir ahora' esta deshabilitado, esperando...`);
    }

    while (isDisabled && waited < timeoutMs) {
      await page.waitForTimeout(2000);
      waited += 2000;
      isDisabled = await btn.evaluate(node => node.hasAttribute("disabled") || node.classList.contains("disabled") || node.classList.contains("is-disabled"));
      if (waited % 20000 === 0) report(`[DEBUG] Esperando que se habilite 'Subir ahora'... (${waited/1000}s)`);
    }

    if (isDisabled) {
      report(`[WARN] Botón 'Subir ahora' sigue deshabilitado tras espera. Forzando click JavaScript.`);
      
      try {
         const html = await page.content();
         const dumpFile = path.join(process.cwd(), "_debug", `subida_fallo_${Date.now()}.html`);
         fs.writeFileSync(dumpFile, html, "utf-8");
         report(`[DEBUG] Se guardó volcado HTML de la página en: ${dumpFile}`);
      } catch(e) {}

      await btn.evaluate(node => { node.removeAttribute("disabled"); node.click(); });
    } else {
      await btn.click({ timeout: 5000 });
    }
    return true;
  } catch (e) {
    report(`[ERROR] Error al intentar clickear 'Subir ahora': ${e.message}`);
    return false;
  }
}

async function openManageUploadPanelIfNeeded(page) {
  let input = page.locator("input.js-bbgFileInput, input[type='file'], .js-bbgDropzone input").first();

  if (await input.count() === 0) {
    const manageBtn = page.locator("button, a, .button").filter({ hasText: /gestionar/i }).first();
    if (await manageBtn.count() > 0 && await manageBtn.isVisible()) {
      report("[INFO] Pulsando boton 'Gestionar' para mostrar zona de carga...");
      await manageBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  const t0 = Date.now();
  while (await input.count() === 0 && Date.now() - t0 < 15000) {
    await page.waitForTimeout(1000);
    input = page.locator("input.js-bbgFileInput, input[type='file'], .js-bbgDropzone input").first();
  }

  return input;
}

async function ensureUploadConfirmationChecked(page) {
  try {
    const cb = page.locator("input.js-bbgPolicyConfirm").first();
    if (await cb.count() > 0) {
      const isChecked = await cb.isChecked();
      if (!isChecked) {
        report("[INFO] Confirmando política de subida (checkbox)...");
        await cb.check({ force: true });
        await page.waitForTimeout(800);
      }
      return true;
    }
    // Si no encontro el checkbox por selector exacto, buscar el label
    const label = page.locator("label.bbgMangaUploader-policyToggle, label:has-text('política'), label:has-text('Acepto')").first();
    if (await label.count() > 0) {
      report("[INFO] Confirmando política de subida (label)...");
      await label.click();
      await page.waitForTimeout(800);
      return true;
    }
  } catch (e) {
    dbg(`Error confirmando politica: ${e.message}`);
  }
  return false;
}

async function uploadImagesInBatches(page, images) {
  let input = await openManageUploadPanelIfNeeded(page);
  
  if (await input.count() === 0) {
    // Intentar buscar botón de Gestionar si el input no es visible de entrada
    const manageBtn = page.locator("button, a, .button").filter({ hasText: /gestionar/i }).first();
    if (await manageBtn.count() > 0 && await manageBtn.isVisible()) {
      report("[INFO] Pulsando boton 'Gestionar' para mostrar zona de carga...");
      await manageBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  // Espera activa con reintentos para el input
  const t0 = Date.now();
  while (await input.count() === 0 && Date.now() - t0 < 15000) {
     await page.waitForTimeout(1000);
     input = page.locator("input.js-bbgFileInput, input[type='file'], .js-bbgDropzone input").first();
  }

  if (await input.count() === 0) {
    await snap(page, "ERROR_input_no_encontrado");
    throw new Error("No se encontro el input de archivos (buscado por .js-bbgFileInput e input[type='file']). Verifica si la web cambio.");
  }

  await ensureEmptyUploadQueue(page);

  input = await openManageUploadPanelIfNeeded(page);
  if (await input.count() === 0) {
    await snap(page, "ERROR_input_no_encontrado_post_cleanup");
    throw new Error("No se encontro el input de archivos tras limpiar la cola residual. Verifica el panel de carga.");
  }

  report(`[SUBIENDO] Cargando ${images.length} imagenes en el panel...`);
  await input.setInputFiles(images);
  await waitQueueItemsReady(page, images.length);
  
  // Cerrar overlay de gestión si sigue abierto (algunas versiones lo requieren)
  try {
    const saveBtn = page.locator("button:has-text('Guardar'), button:has-text('Finalizar'), button:has-text('Cerrar')").filter({ visible: true }).first();
    if (await saveBtn.count() > 0) {
      report("[INFO] Cerrando panel de gestión de archivos...");
      await saveBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  return true;
}

async function startUploadFromStepper(page) {
  const inStep3 = await waitForStepperStep(page, 3, 20000);
  if (!inStep3) throw new Error("No se pudo confirmar Paso 3 antes de iniciar la subida.");

  report("[INFO] Iniciando subida manual desde el paso 3...");
  await ensureUploadConfirmationChecked(page);

  const clicked = await clickSubirAhora(page, 120000);
  if (!clicked) {
    await snap(page, "ERROR_subir_ahora_falla");
    throw new Error("No se pudo habilitar ni pulsar 'Subir ahora'.");
  }

  report("[INFO] Boton 'Subir ahora' pulsado. Esperando avance de la subida...");
  return true;
}

async function getStep4SummaryPageCount(page) {
  return page.evaluate(() => {
    try {
      const root = document.querySelector(".js-bbgSummary");
      if (!root) return null;

      const readInt = (text) => {
        const m = String(text || "").match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
      };

      const headDivs = Array.from(root.querySelectorAll(".bbgBatchSummaryHead div"));
      for (const div of headDivs) {
        const text = (div.textContent || "").trim();
        if (/paginas|pages/i.test(text)) {
          const strong = div.querySelector("strong");
          return readInt(strong ? strong.textContent : text);
        }
      }

      const rows = Array.from(root.querySelectorAll("tbody tr"));
      if (rows.length === 1) {
        const cells = rows[0].querySelectorAll("td");
        if (cells.length >= 3) return readInt(cells[2].textContent);
      }
    } catch {}
    return null;
  });
}

async function waitForPublishCompletion(page, chaptersListUrl, chapterText, timeoutMs = 900000) {
  const t0 = Date.now();
  let lastLoggedBucket = -1;
  let lastPresenceCheckAt = 0;
  let lastPublishedSeenAt = 0;

  while (Date.now() - t0 < timeoutMs) {
    const currentUrl = String(page.url());
    if (/\/capitulos(?:[/?#]|$)/i.test(currentUrl) && !/\/capitulos\/add(?:[/?#]|$)/i.test(currentUrl)) {
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      return true;
    }

    if (await hasTimeoutToast(page)) {
      throw new Error("Se detecto un error (toast) mientras se esperaba la confirmacion final.");
    }

    const stillInStep4 = await waitForStepperStep(page, 4, 500).catch(() => false);
    const stillInWizard = await isStepperWizardPage(page).catch(() => false);
    if (!stillInStep4 && !stillInWizard) {
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      return true;
    }

    const elapsed = Date.now() - t0;
    const queuedCount = await getVisibleQueuedImageCount(page).catch(() => 0);
    if (chaptersListUrl && chapterText && elapsed - lastPresenceCheckAt >= 15000) {
      lastPresenceCheckAt = elapsed;
      const publishedInList = await chapterExistsInList(page.context(), chaptersListUrl, chapterText).catch(() => false);
      if (publishedInList) {
        if (lastPublishedSeenAt === 0) lastPublishedSeenAt = elapsed;
        if (queuedCount === 0) {
          report(`[OK] Publicacion confirmada por aparicion del capitulo ${chapterText} en /capitulos y cola vacia en batch.`);
          return true;
        }
        const visibleFor = elapsed - lastPublishedSeenAt;
        if (visibleFor >= 30000) {
          report(`[OK] Publicacion confirmada. El capitulo ${chapterText} lleva ${Math.floor(visibleFor / 1000)}s visible en /capitulos (batch con ${queuedCount} elementos pendientes, se ignora).`);
          return true;
        }
        report(`[INFO] El capitulo ${chapterText} ya aparece en /capitulos, pero el batch aun conserva ${queuedCount} elementos. Esperando liberacion final...`);
      }
    }

    const elapsedBucket = Math.floor(elapsed / 30000);
    if (elapsedBucket !== lastLoggedBucket) {
      const elapsedSec = Math.floor(elapsed / 1000);
      const publishHint = lastPublishedSeenAt > 0 ? `, ya visible en /capitulos` : "";
      report(`[INFO] Esperando confirmacion final de publicacion... (${elapsedSec}s, URL actual: ${currentUrl}, cola batch: ${queuedCount}${publishHint})`);
      lastLoggedBucket = elapsedBucket;
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(`No se confirmo la publicacion final. Se agoto la espera con URL actual: ${page.url()}`);
}

async function waitForPreviews(page, draftId, timeoutMs = 300000) {
  if (!draftId) {
    report("[WARN] No se capturo draft_id; se omite espera de previews.");
    return;
  }
  const url = `${BASE_URL.replace(/\/$/, "")}/libreria/manga-uploader/batch-page-status?draft_id=${encodeURIComponent(draftId)}&_xfResponseType=json`;
  const t0 = Date.now();
  let lastLogged = -1;

  report(`[INFO] Verificando previews (draft_id: ${draftId})...`);
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "include" });
        return r.ok ? r.json() : null;
      }, url);

      if (res && res.chapters && res.chapters[0]) {
        const ch = res.chapters[0];
        const total = ch.session_total_count || 0;
        const ready = ch.session_ready_count || 0;
        const elapsed = Math.floor((Date.now() - t0) / 1000);
        const bucket = Math.floor(elapsed / 5);
        if (bucket !== lastLogged) {
          report(`[INFO] Previews: ${ready}/${total} listos (${elapsed}s)`);
          lastLogged = bucket;
        }
        if (total > 0 && ready >= total) {
          report(`[OK] Previews generados: ${ready}/${total}.`);
          return;
        }
      }
    } catch (e) {
      dbg(`waitForPreviews error: ${e.message}`);
    }
    await page.waitForTimeout(5000);
  }
  report(`[WARN] Timeout esperando previews. Continuando de todas formas.`);
}

async function finalizePublishFromStepper(page, expectedCount, chaptersListUrl, chapterText) {
  report("[INFO] Verificando confirmacion final de publicacion...");
  let inStep4 = await waitForStepperStep(page, 4, 5000);
  if (!inStep4) {
    report("[INFO] Avanzando de Paso 3 al resumen final...");
    const nextBtn = await clickVisibleButtonByText(page, RE_NEXT_BUTTON, 10000);
    if (!nextBtn) {
      throw new Error("No se pudo avanzar con 'Siguiente' hacia el Paso 4.");
    }
    inStep4 = await waitForStepperStep(page, 4, 30000);
  }

  if (!inStep4) {
    if (await hasTimeoutToast(page)) {
      throw new Error("Se detecto un error (toast) al intentar abrir el Paso 4.");
    }
    throw new Error("No se detecto el Paso 4 de confirmacion.");
  }

  let summaryCount = await getStep4SummaryPageCount(page);
  if (summaryCount === null) {
    throw new Error("No se pudo leer el resumen del Paso 4.");
  }

  // Si el conteo no coincide, reintentar hasta 3 veces con pausa (el servidor puede tardar en registrar la ultima imagen)
  for (let retry = 0; retry < 3 && summaryCount !== expectedCount; retry++) {
    report(`[INFO] Resumen Paso 4: ${summaryCount}/${expectedCount} paginas. Esperando que el servidor finalice... (intento ${retry + 1}/3)`);
    await page.waitForTimeout(5000);
    summaryCount = await getStep4SummaryPageCount(page) ?? summaryCount;
  }

  report(`[INFO] Resumen Paso 4: ${summaryCount}/${expectedCount} paginas.`);
  if (summaryCount !== expectedCount) {
    throw new Error(`El resumen final reporta ${summaryCount} paginas y se esperaban ${expectedCount}.`);
  }

  const publishBtn = page.locator("button").filter({ hasText: RE_CONFIRM_PUBLISH_BUTTON }).first();
  if (await publishBtn.count() > 0 && await publishBtn.isVisible()) {
    report("[INFO] Pulsando 'Confirmar y publicar'...");
    await publishBtn.click({ timeout: 5000 });
    await waitForPublishCompletion(page, chaptersListUrl, chapterText);
    report("[OK] Publicacion confirmada.");
  } else {
    throw new Error("No aparecio el boton de confirmacion final en el Paso 4.");
  }

  await page.waitForTimeout(1500);
  return true;
}

async function publishFromStepper(page, expectedCount) {
  // Asegurar que estamos en el paso 3 (pesta\u00f1a de paginas)
  const inStep3 = await waitForStepperStep(page, 3, 20000);
  if (!inStep3) throw new Error("No se pudo confirmar Paso 3 antes de publicar.");

  report("[INFO] Iniciando proceso de publicacion...");
  await ensureUploadConfirmationChecked(page);

  // clickSubirAhora ahora internamente maneja la espera activa
  const clicked = await clickSubirAhora(page, 120000);
  if (!clicked) {
    await snap(page, "ERROR_subir_ahora_falla");
    throw new Error("No se pudo habilitar ni pulsar 'Subir ahora'.");
  }

  report("[INFO] Boton 'Subir ahora' pulsado. Esperando confirmacion final...");
  const inStep4 = await waitForStepperStep(page, 4, 30000);
  if (!inStep4) {
    // A veces se salta el paso 4 visual y va directo a la lista o hay un error modal
    if (await hasTimeoutToast(page)) {
       throw new Error("Se detecto un error (toast) tras intentar publicar.");
    }
    report("[WARN] No se detecto Paso 4 explicitamente; verificando si cambio la URL.");
  }

  const publishBtn = page.locator("button").filter({ hasText: RE_CONFIRM_PUBLISH_BUTTON }).first();
  if (await publishBtn.count() > 0 && await publishBtn.isVisible()) {
    await publishBtn.click({ timeout: 5000 });
    report("[OK] Publicacion confirmada.");
  } else {
    report("[INFO] No se requirio boton de confirmacion final (Paso 4).");
  }

  // Esperar a que la pagina cambie (no estemos mas en el add)
  await page.waitForTimeout(2000);
  return true;
}

async function processOneChapter(page, chaptersListUrl, resourceUrl, chapter) {
  return withLogContext({ chapter: chapter.number, phase: "init" }, async () => {
    if (chapter.uploadNumber && chapter.uploadNumber !== chapter.number) {
      report(`[INFO] Procesando Cap ${chapter.number} (se publicara como ${chapter.uploadNumber})...`);
    } else {
      report(`[INFO] Procesando Cap ${chapter.number}...`);
    }

    let capturedDraftId = null;
    const onResponse = async (response) => {
      try {
        if (!response.url().includes("batch-save-step")) return;
        const json = await response.json().catch(() => null);
        if (json && json.draft_id && !capturedDraftId) {
          capturedDraftId = json.draft_id;
          dbg(`draft_id capturado: ${capturedDraftId}`);
        }
      } catch {}
    };
    page.on("response", onResponse);

    try {
      await openAddChapterOverlay(page, chaptersListUrl, resourceUrl);
      await fillOverlayCreateChapter(page, chapter.uploadNumber || chapter.number, chapter.extra || "");

      const processedImages = await preprocessImages(chapter.images);
      await uploadImagesInBatches(page, processedImages);
      await startUploadFromStepper(page);

      const success = await waitUploadsComplete(page, processedImages.length);
      if (!success) {
        throw new Error(`La subida no se completo para el cap ${chapter.number}`);
      }

      await finalizePublishFromStepper(page, processedImages.length, chaptersListUrl, chapter.uploadNumber || chapter.number);
      page.off("response", onResponse);
      await waitForPreviews(page, capturedDraftId);
      report(`[OK] Cap ${chapter.number} subido con exito.`);
      return true;
    } catch (e) {
      page.off("response", onResponse);
      report(`[ERROR] Fallo Cap ${chapter.number}: ${e.message}`);
      await snap(page, `FAIL_cap_${chapter.number}`);
      return false;
    }
  });
}

function checkArgumentsCorrectness(args) {
  if (args.help || args.h) {
    console.log(`
Uso: node uploader_xf_animebbg2.js [opciones]
Opciones:
  --resource <url>   URL del recurso (obligatorio si no hay prompt)
  --root <path>      Carpeta raiz con capitulos o URL de Drive
  --chapters <list>  Lista de capitulos a subir (ej: 1,2,5-10)
  --start <num>      Empezar desde este capitulo (inclusive)
  --end <num>        Terminar en este capitulo (inclusive)
  --headless <bool>  Cerrar navegador (def: true)
  --parallel <num>   Hilos simultaneos (def: 1 para Stepper)
  --debug            Habilitar capturas y logs detallados
    `);
    process.exit(0);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  checkArgumentsCorrectness(args);

  let resourceUrl = args.resource || "";
  let rootPath = args.root || "";

  if (!resourceUrl) resourceUrl = await rlQuestion("URL del recurso: ");
  if (!rootPath) rootPath = await rlQuestion("Ruta local o URL de Drive: ");

  if (!isUrl(resourceUrl)) throw new Error("URL de recurso invalida.");

  if (isUrl(rootPath)) {
    report(`[INFO] Detectada URL de Drive: ${rootPath}`);
    rootPath = await downloadDriveFolder(rootPath);
  }

  const resourceId = extractResourceIdFromUrl(resourceUrl);
  if (!resourceId) throw new Error("No se pudo extraer el ID del recurso.");

  const chaptersListUrl = `${resourceUrl.replace(/\/$/, "")}/capitulos`;

  // Listar carpetas locales
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(rootPath, e.name));

  const allLocal = [];
  for (const e of entries) {
    const info = await prepareFileSystemChapter(e);
    if (info) allLocal.push(info);
  }
  assignSiteUploadNumbers(allLocal);
  allLocal.sort((a, b) => compareChapterTokens(a.number, b.number));

  if (allLocal.length === 0) {
    report("[WARN] No se encontraron capitulos validos en la ruta especificada.");
    process.exit(0);
  }

  report(`[INFO] Encontrados ${allLocal.length} capitulos locales.`);

  // 1. Filtrar por rango (start/end)
  const startTokenArg = normalizeChapterTokenKeepDecimals(args.start);
  const endTokenArg = normalizeChapterTokenKeepDecimals(args.end);
  let filtered = allLocal;

  if (startTokenArg !== null || endTokenArg !== null) {
    filtered = filtered.filter(ch => {
      const token = normalizeChapterTokenKeepDecimals(ch.number);
      if (token === null) return true; // Si no hay numero, incluirlo
      if (startTokenArg !== null && compareChapterTokens(token, startTokenArg) < 0) return false;
      if (endTokenArg !== null && compareChapterTokens(token, endTokenArg) > 0) return false;
      return true;
    });
    report(`[INFO] Tras filtrar por rango (${startTokenArg ?? "-"} -> ${endTokenArg ?? "-"}), quedan ${filtered.length} capitulos.`);
  }

  // Lanzar Playwright para Scrape-Check o para subir
  const browser = await chromium.launch(getChromiumLaunchOptions());
  const storagePath = storageStatePathIfExists();
  const context = await browser.newContext(getContextOptions(storagePath));
  const page = await context.newPage();

  try {
    await ensureLogin(page, context);

    // 2. Scrape-Check (Ver qué hay en la web para no repetir)
    const publishedNumbers = new Set();
    report("[INFO] Realizando Scrape-Check en la web...");
    try {
      await go(page, chaptersListUrl);
      await page.waitForLoadState("domcontentloaded");
      
      const lastPageNum = await getLastPageNumberFast(page);
      // Revisar hasta 5 páginas para estar seguros de no perder capítulos antiguos o recientes
      const pagesToCheck = Math.min(lastPageNum, 5);
      
      for (let p = 1; p <= pagesToCheck; p++) {
        if (p > 1) {
          await go(page, withPageParam(chaptersListUrl, p));
          await page.waitForLoadState("domcontentloaded");
        }
        const items = page.locator(CHAPTER_ANCHOR);
        const count = await items.count();
        for (let i = 0; i < count; i++) {
          const txt = (await items.nth(i).innerText()).trim();
          const num = normalizeChapterNumber(parseChapterNumberFromAnchorText(txt) || chapterNumberFromText(txt));
          if (num !== null) {
            publishedNumbers.add(num);
            if (DEBUG) report(`[DEBUG] Scrape-Check detectó Cap ${num} en la web.`);
          }
        }
      }
      const pubArray = Array.from(publishedNumbers).sort(compareChapterTokens);
      report(`[INFO] Scrape-Check: detectados ${publishedNumbers.size} capítulos en la web: ${pubArray.join(", ")}`);
    } catch (err) {
      report(`[WARN] No se pudo completar el Scrape-Check: ${err.message}. Se procederá solo con el rango.`);
    }

    const highestPublishedToken = publishedNumbers.size
      ? Array.from(publishedNumbers).sort(compareChapterTokens)[publishedNumbers.size - 1]
      : null;

    if (startTokenArg === null && highestPublishedToken !== null) {
      const beforeAutoContinue = filtered.length;
      filtered = filtered.filter((ch) => {
        const token = normalizeChapterTokenKeepDecimals(ch.number);
        if (token === null) return true;
        return compareChapterTokens(token, highestPublishedToken) > 0;
      });
      report(`[INFO] Continuacion automatica activada: la web ya llega hasta ${highestPublishedToken}. Se omiten ${beforeAutoContinue - filtered.length} capitulos previos o iguales.`);
    }

    assignSiteUploadNumbers(filtered, publishedNumbers);

    // 3. Filtrado final: Rango Y Scrape-Check
    const finalQueue = filtered.filter(ch => {
      if (ch.skipBecauseSiteNumberConflict) {
        report(`[OMITIDO] Cap ${ch.number}: ${ch.skipReason}`);
        return false;
      }
      const nStr = normalizeChapterNumber(ch.uploadNumber || ch.number);
      if (nStr === null) return true;
      if (publishedNumbers.has(nStr)) {
        report(`[OMITIDO] Cap ${ch.number} ya existe en la web como ${ch.uploadNumber || ch.number} (detectado por scrape).`);
        return false;
      }
      return true;
    });

    if (finalQueue.length === 0) {
      report("[OK] No hay capítulos nuevos para subir.");
      return;
    }

    let abortedByChapterFailure = false;
    for (const chapter of finalQueue) {
      await waitIfPaused();
      // Ya estamos logueados y en la página correcta si Scrape-Check funcionó
      const ok = await processOneChapter(page, chaptersListUrl, resourceUrl, chapter);
      if (!ok) {
         report(`[ERROR] No se pudo subir el cap ${chapter.number}. Se detiene la cola para evitar reutilizar un borrador incompleto.`);
         abortedByChapterFailure = true;
         break;
      }
    }

    if (abortedByChapterFailure) {
      throw new Error("La cola se detuvo porque un capitulo no termino de publicarse correctamente.");
    }

  } finally {
    await browser.close();
    report("[INFO] Proceso finalizado.");
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("uploader_xf_animebbg2.js")) {
  main().catch(e => {
    console.error(chalk.red.bold("\n[CRITICAL ERROR]"), e);
    process.exit(1);
  });
}
