/**
 * prueba
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

const RE_NEXT_BUTTON = /^\s*(?:siguiente|next|continuar|continue)\s*$/i;
const RE_UPLOAD_NOW_BUTTON = /(?:subir\s+ahora|upload\s+now|start\s+upload)/i;
const RE_CONFIRM_PUBLISH_BUTTON = /(?:confirmar\s+y\s+publicar|confirm\s+and\s+publish)/i;

// ===== stale-draft detection =====
// Rastrea que container_id fue asignado a cada capitulo en esta sesion.
// Si un capitulo nuevo recibe el mismo container_id que un capitulo DIFERENTE ya procesado,
// el servidor reutilizo el borrador anterior (draft obsoleto → riesgo de corrupcion de datos).
const _containerChapterMap = new Map(); // containerId (string) → chapterNumber

const TOAST_ERROR_TEXTS = [
  "Oops! Nos hemos encontrado con algunos problemas",
  "El servidor no responde en tiempo",
  "intÃ©ntalo otra vez",
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
  } catch (e) { dbg(`Error obteniendo capÃ­tulos vÃ­a API: ${e}`); return []; }
}

async function getChapterDetailsViaApi(chapterId) {
  try { return await apiRequest(`resource-manager/resource-updates/${chapterId}`); }
  catch (e) { dbg(`Error obteniendo detalles de capÃ­tulo vÃ­a API: ${e}`); return null; }
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
  } catch (e) { dbg(`Error verificando imÃ¡genes vÃ­a API: ${e}`); return -1; }
}

// ===== helpers =====
async function go(page, url, fast=true) {
  await page.goto(url, { waitUntil: fast ? "domcontentloaded" : "load" });
}

const CAP_ANY = /(\d+(?:[.,]\d+)?)/g;

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

function inferPartFromChapterToken(token) {
  const m = String(token || "").trim().match(/^(\d+)\.(\d+)$/);
  if (!m) return null;
  let part = parseInt(m[2], 10);
  if (!Number.isFinite(part) || part <= 0) return null;
  while (part % 10 === 0) part = Math.floor(part / 10);
  return part > 0 ? part : null;
}

function deriveChapterStep1Fields(chapterNumber, chapterExtra = "") {
  const normalized = normalizeChapterTokenKeepDecimals(chapterNumber);
  let numberValue = normalized || String(chapterNumber || "").trim();
  let extraValue = String(chapterExtra || "").trim();

  // Regla para variantes tipo 22.10/22.20/22.30 => Capitulo 22 + Parte 1/2/3
  if (!extraValue) {
    const m = String(numberValue).match(/^(\d+)\.(\d+)$/);
    if (m) {
      const part = inferPartFromChapterToken(numberValue);
      if (part !== null) {
        numberValue = String(parseInt(m[1], 10));
        extraValue = `Parte ${part}`;
      }
    }
  }

  return { numberValue, extraValue };
}

function chapterNumberFromText(text) {
  let m = null, last = null;
  while ((m = CAP_ANY.exec(text)) !== null) last = m;
  if (!last) return null;
  return normalizeChapterTokenKeepDecimals(last[1]);
}

function chapterNumberFromFolderName(name) {
  const original = String(name || "").trim();
  const normalized = normalizeTextLoose(original);

  // Prioridad: "Capitulo 34", "Cap 34", etc.
  const byCap = normalized.match(/\bcap(?:itulo)?\s*([0-9]+(?:[.,][0-9]+)?)\b/i);
  if (byCap) return normalizeChapterTokenKeepDecimals(byCap[1]);

  // Si no hay prefijo de capÃ­tulo, usar el primer nÃºmero del nombre.
  const firstNum = original.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (firstNum) return normalizeChapterTokenKeepDecimals(firstNum[1]);

  return null;
}

function extractChapterExtraFromFolderName(name) {
  const original = String(name || "").trim();
  if (!original) return "";

  // Quita prefijo tipico: "Capitulo 22.30", "Cap 22", "Chapter 22", etc.
  const withoutPrefix = original.replace(
    /^\s*(?:cap(?:itulo)?|chapter)\s*[._-]*\s*\d+(?:[.,]\d+)?\s*/i,
    "",
  );

  // Limpia separadores iniciales comunes.
  const extra = withoutPrefix.replace(/^[\s\-â€“â€”_:|.]+/, "").trim();
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
  try {
    if (String(num).includes(".")) return `CapÃ­tulo ${Number(num).toFixed(2)}`;
    return `CapÃ­tulo ${Number.parseInt(num,10).toFixed(2)}`;
  } catch { return `CapÃ­tulo ${num}`; }
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
  if (await form.count() === 0) throw new Error("No encontrÃ© el formulario de login.");

  const user = form.locator("input[name=login], #login, input[type=text]").first();
  const pw = form.locator("input[name=password], #password, input[type=password]").first();
  if ((await user.count()) === 0 || (await pw.count()) === 0) throw new Error("No encontrÃ© campos de login/password.");

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

  if (!(await isLogged())) throw new Error("Sigo en login tras enviar (Â¿captcha/Cloudflare?).");

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
    const body = normalizeTextLoose(await page.locator("body").innerText());
    if (body.includes("stepper de capitulos en lote")) return true;
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
        if (t.includes("programacion") || t.includes("schedule")) return 2;
        if (t.includes("carga de paginas") || t.includes("paginas") || t.includes("gestionar paginas") || t.includes("pages")) return 3;
        if (t.includes("confirmacion") || t.includes("confirmar y publicar") || t.includes("confirmation") || t.includes("confirm and publish")) return 4;
        return null;
      };

      const nodes = Array.from(document.querySelectorAll("li, button, a, div, span"));
      for (const el of nodes) {
        if (!activeHint(el)) continue;
        const step = textToStep(el.textContent || "");
        if (step) return step;
      }

      // Paso 3: verificar senales estructurales PRIMERO (el nav del stepper siempre
      // muestra todos los pasos, asi que "programacion" aparece en el body incluso
      // cuando ya estamos en el paso 3, lo que causaria un falso positivo si se
      // comprueba el texto antes que los selectores estructurales).
      if (
        document.querySelector(".bbgMangaUploader, .js-bbgDropzone, .js-bbgFileInput[type='file'], .js-bbgStatus, .js-bbgGlobalProgressText")
      ) return 3;

      // Fallback por el titulo del panel activo ("Paso X:").
      // NO usar labels del nav ("programacion", "paginas"...) que son visibles en TODOS los pasos.
      const bodyText = norm(document.body?.innerText || "");
      if (bodyText.includes("paso 1") || bodyText.includes("step 1") || bodyText.includes("numero de capitulo") || bodyText.includes("numero capitulo")) return 1;
      if (bodyText.includes("paso 2") || bodyText.includes("step 2")) return 2;
      if (bodyText.includes("paso 4") || bodyText.includes("step 4") || bodyText.includes("confirmar y publicar") || bodyText.includes("confirm and publish") || bodyText.includes("confirmacion") || bodyText.includes("confirmation")) return 4;
      return null;
    });
  }

  const t0 = Date.now();
  const stepText = normalizeTextLoose(`paso ${stepNum}`);
  while (Date.now() - t0 < timeoutMs) {
    try {
      const activeStep = await detectActiveStepFromDom();
      if (activeStep === stepNum) return true;

      const body = normalizeTextLoose(await page.locator("body").innerText());
      if (body.includes(stepText)) return true;
      if (stepNum === 1 && (body.includes("numero de capitulo") || body.includes("numero capitulo"))) return true;
      if (stepNum === 2 && (body.includes("paso 2") || body.includes("step 2"))) return true;
      if (stepNum === 3) {
        const hasUploadUi = await page.locator(".bbgMangaUploader, .js-bbgDropzone, .js-bbgFileInput[type='file'], .js-bbgStatus, .js-bbgGlobalProgressText").count().catch(() => 0);
        if (hasUploadUi > 0) return true;
      }
      if (stepNum === 4 && body.includes("confirmacion")) return true;
    } catch {}
    await page.waitForTimeout(250);
  }
  return false;
}

async function hasStepperChapterNumberField(page) {
  return page.evaluate(() => {
    const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const labels = Array.from(document.querySelectorAll("label, .formRow-label, .inputLabel"));
    for (const lab of labels) {
      const t = norm(lab.textContent || "");
      if (!t.includes("numero de capitulo") && !t.includes("numero capitulo")) continue;

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
    const labels = Array.from(document.querySelectorAll("label, .formRow-label, .inputLabel"));

    for (const lab of labels) {
      const t = norm(lab.textContent || "");
      if (!t.includes("numero de capitulo") && !t.includes("numero capitulo")) continue;

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

  const inStep2 = await waitForStepperStep(page, 2, 15000);
  if (!inStep2) throw new Error("No se detecto Paso 2 (Programacion) en Stepper.");

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

async function findChapterLinkInPage(page, chapterText) {
  const items = page.locator(CHAPTER_ANCHOR);
  const total = await items.count();
  const targetText = normalizeTextLoose(chapterText);
  const targetNum = normalizeChapterNumber(chapterNumberFromText(chapterText));

  if (DEBUG && total > 0 && total <= 10) {
    report(`[DEBUG] Buscando '${chapterText}' entre ${total} capï¿½tulos en la pï¿½gina`);
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

  // Fallback universal: si cambiï¿½ el layout/clases, revisar todos los enlaces candidatos.
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
  // Solo aceptar IDs numericos validos despues de /link/
  const m = url.match(/\/comics\/capitulo\/link\/(\d+)\/?/);
  if (m) return m[1];

  // Nuevo flujo: /libreria/caps/capitulo-20.12309/add
  // Tomar la parte final numerica como posible ID de update.
  const mAdd = url.match(/\/capitulo-[^/]*\.(\d+)(?:\/add)?\/?/i);
  if (mAdd) return mAdd[1];

  // Fallback para URLs alternativas con ID numerico
  const m2 = url.match(/\/capitulo[s]?\/(\d+)/);
  return m2 ? m2[1] : null;
}

async function isChapterUploadFormPage(page) {
  const u = String(page.url() || "").toLowerCase();
  if (u.includes("/capitulos/add")) return true;

  try {
    const body = normalizeTextLoose(await page.locator("body").innerText());
    if (body.includes("stepper de capitulos en lote")) return true;
    if (body.includes("paso 3") && body.includes("paginas")) return true;
    if (body.includes("gestionar paginas")) return true;
    if (body.includes("manage pages")) return true;
  } catch {}
  try {
    if (await hasStepperUploadSurface(page)) return true;
  } catch {}
  return false;
}



async function navigateToChapterById(page, chapterId) {
  try {
    const url = `${BASE_URL.replace(/\/$/, "")}/comics/capitulo/link/${chapterId}/`;
    dbg(`Navegando directo a capï¿½tulo ID ${chapterId}: ${url}`);
    await go(page, url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    return true;
  } catch (e) {
    dbg(`Error navegando a capï¿½tulo ID ${chapterId}: ${e}`);
    return false;
  }
}

function extractChapterIdFromApiUpdate(update) {
  if (!update || typeof update !== "object") return null;
  const raw = update.resource_update_id ?? update.resourceUpdateId ?? update.update_id ?? update.id ?? null;
  if (raw === null || raw === undefined) return null;
  const id = String(raw).trim();
  return /^\d+$/.test(id) ? id : null;
}

function extractChapterTitleFromApiUpdate(update) {
  if (!update || typeof update !== "object") return "";
  return String(
    update.title
    ?? update.Title
    ?? update.resource_update_title
    ?? update.resourceUpdateTitle
    ?? update.message_title
    ?? update.messageTitle
    ?? ""
  ).trim();
}

async function openChapterByApiIfAvailable(page, chaptersListUrl, chapterText, expectedNumber) {
  if (!XENFORO_API_KEY || expectedNumber === null || expectedNumber === undefined) {
    return { ok: false, chapterId: null };
  }

  try {
    const resourceId = extractResourceIdFromUrl(chaptersListUrl);
    if (!resourceId) return { ok: false, chapterId: null };

    const targetNum = normalizeChapterNumber(expectedNumber);
    const targetText = normalizeTextLoose(chapterText);
    const updates = await getResourceChaptersViaApi(resourceId);
    if (!Array.isArray(updates) || updates.length === 0) return { ok: false, chapterId: null };

    for (const u of updates) {
      const title = extractChapterTitleFromApiUpdate(u);
      if (!title) continue;

      const normalizedTitle = normalizeTextLoose(title);
      const num = normalizeChapterNumber(parseChapterNumberFromAnchorText(title) || chapterNumberFromText(title));
      const textMatch = normalizedTitle === targetText || normalizedTitle.includes(targetText) || targetText.includes(normalizedTitle);
      const numMatch = targetNum !== null && num !== null && num === targetNum;
      if (!textMatch && !numMatch) continue;

      const chapterId = extractChapterIdFromApiUpdate(u);
      if (!chapterId) continue;

      const ok = await navigateToChapterById(page, chapterId);
      if (ok) {
        report(`  [INFO] ${chapterText} encontrado por API (ID ${chapterId})`);
        return { ok: true, chapterId };
      }
    }
  } catch (e) {
    dbg(`Fallback API para abrir capï¿½tulo fallï¿½: ${e}`);
  }

  return { ok: false, chapterId: null };
}
async function verifyChapterNumberOnPage(page, expectedNumber) {
  const target = normalizeChapterNumber(expectedNumber);
  if (target === null) return false;

  const expectedText = normalizeTextLoose(`Capï¿½tulo ${Number(target).toFixed(2)}`);
  const capWord = /cap(?:i|ï¿½)tulo/i;

  try {
    const currentUrl = String(page.url() || "");
    if (currentUrl.includes("/comics/capitulo/link/")) {
      // Estamos dentro de una vista de capï¿½tulo; validamos por contenido de pï¿½gina.
    }
  } catch {}

  const candidates = [];
  const selectors = [
    "h1",
    ".p-title-value",
    ".resourceBody-title",
    ".message-title",
    "input[name='title']",
    "input[name='resource_update_title']",
    "textarea[name='title']",
    "textarea[name='resource_update_title']",
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      const max = Math.min(count, 5);
      for (let i = 0; i < max; i++) {
        const el = loc.nth(i);
        const v1 = (await el.getAttribute("value")) || "";
        const v2 = (await el.innerText()) || "";
        const txt = String(v1 || v2 || "").trim();
        if (txt) candidates.push(txt);
      }
    } catch {}
  }

  try {
    const bodyText = await page.locator("body").innerText();
    if (bodyText) candidates.push(String(bodyText).slice(0, 6000));
  } catch {}

  for (const text of candidates) {
    const normalized = normalizeTextLoose(text);
    if (!normalized) continue;

    if (normalized.includes(expectedText)) return true;

    const parsed = normalizeChapterNumber(chapterNumberFromText(text));
    if (parsed !== null && parsed === target && capWord.test(text)) return true;

    const targetEscaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`cap(?:i|ï¿½)tulo\\s*${targetEscaped}(?:\\.00)?`, "i");
    if (rx.test(text)) return true;
  }

  return false;
}
async function openChapterFromList(page, chaptersListUrl, chapterText, expectedNumber=null, maxRetries=3) {
  for (let attempt=0; attempt<maxRetries; attempt++) {
    if (attempt > 0) {
      report(`  [REINTENTO ${attempt}/${maxRetries-1}] Buscando ${chapterText}...`);
      await page.waitForTimeout(2000);
    }

    await go(page, chaptersListUrl);

    // Primero intenta resolver por API para evitar fragilidad ante cambios de layout.
    if (expectedNumber !== null) {
      const apiHit = await openChapterByApiIfAvailable(page, chaptersListUrl, chapterText, expectedNumber);
      if (apiHit.ok) {
        await snap(page, "22_opened_chapter_from_api");
        return apiHit;
      }
    }

    // Sitio actual: el capï¿½tulo mï¿½s reciente aparece primero en /capitulos (pï¿½gina 1).
    if (expectedNumber !== null) {
      const topHit = await openChapterFromTopListIfMatches(page, expectedNumber);
      if (topHit.ok) {
        await snap(page, "22_opened_chapter_from_top_list");
        return topHit;
      }
    }

    const lastPage = await getLastPageNumberFast(page);
    const desc = await isDescendingChapterOrder(page);

    const firstPass = (desc === false)
      ? Array.from({ length: lastPage }, (_, i) => lastPage - i)
      : Array.from({ length: lastPage }, (_, i) => i + 1);
    const secondPass = (desc === false)
      ? Array.from({ length: lastPage }, (_, i) => i + 1)
      : Array.from({ length: lastPage }, (_, i) => lastPage - i);

    const triedPages = new Set();
    const passes = [firstPass, secondPass];
    for (let passIdx = 0; passIdx < passes.length; passIdx++) {
      if (passIdx === 1 && lastPage > 1) {
        report("  [INFO] No encontrado en el orden principal, probando orden inverso...");
      }
      for (const pageNum of passes[passIdx]) {
        if (triedPages.has(pageNum)) continue;
        triedPages.add(pageNum);

        const url = withPageParam(chaptersListUrl, pageNum);
        await go(page, url);
        if (pageNum === 1 || pageNum === lastPage) {
          await snap(page, `21_list_page_${pageNum}_attempt_${attempt}`);
        }

        const link = await findChapterLinkInPage(page, chapterText);
        if (!link) continue;

        let opened = false;
        let hrefAbs = null;
        try {
          const href = await link.getAttribute("href");
          if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
            hrefAbs = new URL(href, BASE_URL).toString();
            await go(page, hrefAbs);
            opened = true;
          }
        } catch {}
        if (!opened) {
          await link.click();
          await page.waitForLoadState("domcontentloaded");
        }

        await page.waitForTimeout(500);
        const chapterId = getCurrentChapterIdFromUrl(page.url()) || (hrefAbs ? getCurrentChapterIdFromUrl(hrefAbs) : null);

        if (expectedNumber && !(await verifyChapterNumberOnPage(page, expectedNumber))) {
          if (chapterId) {
            report(`  [WARN] Validaciï¿½n por texto fallï¿½, pero se detectï¿½ ID ${chapterId}. Forzando navegaciï¿½n directa...`);
            const directOk = await navigateToChapterById(page, chapterId);
            if (directOk) {
              await page.waitForTimeout(400);
              await snap(page, "22_opened_chapter_by_id_fallback");
              return { ok: true, chapterId };
            }
            report(`  [WARN] No se pudo navegar por ID ${chapterId}; continï¿½o con ese ID para no perder el flujo.`);
            return { ok: true, chapterId };
          }
          dbg(`ADVERTENCIA: Abrimos un capï¿½tulo pero no coincide con ${expectedNumber}`);
          continue;
        }

        await snap(page, "22_opened_chapter_by_text");
        if (pageNum !== 1) report(`  [INFO] Encontrado en pï¿½gina ${pageNum}`);
        return { ok: true, chapterId };
      }
    }
  }

  report(`[ERROR] No se pudo encontrar ${chapterText} despuï¿½s de ${maxRetries} intentos`);
  return { ok: false, chapterId: null };
}
// ===== count images =====
async function countUploadedImages(page) {
  // IMPORTANTE: solo contar imagenes que ya terminaron de subirse al servidor.
  // "En cola" = pendiente (no subido). "Subiendo" = en progreso (no terminado).
  // Solo "Listo" y "Optimizado" indican carga completa en servidor.
  try {
    let count = 0;

    // Estados finales: solo "Listo" y "Optimizado".
    // NO incluir "En cola" (pendiente), "Subiendo" (en progreso), "Optimizando" (aun procesando).
    const doneCards = page.locator("text=/\\b(Listo|Optimizado)\\b/i");
    count = Math.max(count, await doneCards.count().catch(() => 0));

    // El ratio done/total del uploader es la fuente mas confiable.
    // IMPORTANTE: usar progress.done (completados) NO progress.total (esperados).
    const progress = await readUploadProgress(page);
    if (progress.done > 0) count = Math.max(count, progress.done);

    return count;
  } catch { return 0; }
}

async function countSavedImages(page) {
  try {
    await page.waitForTimeout(500);
    const loc = page.locator("img[src*='/attachments/'], img[data-src*='/attachments/'], .js-lbImage img");
    // dedupe
    const urls = await loc.evaluateAll(els =>
      els.map(e => (e.getAttribute("data-src") || e.getAttribute("src") || "").split("?")[0]).filter(Boolean)
    );
    const unique = new Set(urls);
    dbg(`ImÃ¡genes ya guardadas detectadas (unique): ${unique.size}`);
    return unique.size;
  } catch (e) {
    dbg(`Error contando imÃ¡genes guardadas: ${e}`);
    return 0;
  }
}

async function countSavedImagesAccurate(page, opts = {}) {
  const shouldScroll = opts.scroll !== false;
  const maxRounds = Number.isFinite(opts.maxRounds) ? opts.maxRounds : 12;
  try {
    await page.waitForTimeout(500);
    const loc = page.locator("img[src*='/attachments/'], img[data-src*='/attachments/'], .js-lbImage img");
    const readUniqueCount = async () => {
      const urls = await loc.evaluateAll(els =>
        els.map(e => (e.getAttribute("data-src") || e.getAttribute("src") || "").split("?")[0]).filter(Boolean)
      );
      return new Set(urls).size;
    };

    let best = await readUniqueCount();
    if (shouldScroll) {
      let stable = 0;
      for (let i = 0; i < maxRounds; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(450);
        const cur = await readUniqueCount();
        if (cur <= best) stable += 1;
        else { best = cur; stable = 0; }
        if (stable >= 2) break;
      }
    }

    dbg(`Imagenes guardadas detectadas (unique): ${best}`);
    return best;
  } catch (e) {
    dbg(`Error contando imagenes guardadas: ${e}`);
    return 0;
  }
}

async function verifyChapterImages(page, chaptersListUrl, chapterText, expectedCount, chapterId) {
  if (XENFORO_API_KEY && chapterId) {
    const apiCount = await verifyChapterImagesViaApi(chapterId);
    if (apiCount >= 0) {
      dbg(`VerificaciÃ³n API ${chapterText}: ${apiCount} imÃ¡genes (esperadas: ${expectedCount})`);
      if (apiCount === 0) { report(`[API-ERROR] ${chapterText} NO TIENE IMÃGENES segÃºn API!`); return false; }
      if (apiCount < expectedCount * 0.8) { report(`[API-WARN] ${chapterText} tiene solo ${apiCount}/${expectedCount} imÃ¡genes segÃºn API`); return false; }
      report(`[API-OK] ${chapterText} verificado vÃ­a API: ${apiCount} imÃ¡genes`);
      return true;
    }
  }

  try {
    const { ok } = await openChapterFromList(page, chaptersListUrl, chapterText, null, 2);
    if (!ok) return false;
    await page.waitForTimeout(1000);
    const count = await countSavedImagesAccurate(page, { scroll: true });
    dbg(`VerificaciÃ³n web ${chapterText}: encontradas ${count} imÃ¡genes (esperadas: ${expectedCount})`);
    if (count === 0) { report(`[WEB-ERROR] ${chapterText} NO TIENE IMÃGENES despuÃ©s de guardar!`); return false; }
    if (count < expectedCount * 0.8) { report(`[WEB-WARN] ${chapterText} tiene solo ${count} imÃ¡genes (esperadas: ${expectedCount})`); return false; }
    report(`[WEB-OK] ${chapterText} verificado vÃ­a web: ${count} imÃ¡genes`);
    return true;
  } catch (e) {
    dbg(`Error verificando ${chapterText}: ${e}`);
    return false;
  }
}

// ===== container-id helpers =====
// Lee el container_id del data-manage-url del widget "Gestionar paginas".
// Devuelve el ID como string o null si no se puede leer.
async function extractContainerIdFromPage(page) {
  try {
    return await page.evaluate(() => {
      const els = document.querySelectorAll("[data-manage-url]");
      for (const el of els) {
        const url = el.getAttribute("data-manage-url") || "";
        const m = url.match(/[?&]container_id=(\d+)/);
        if (m) return m[1];
      }
      return null;
    });
  } catch { return null; }
}

// ===== upload =====
async function clickSubirImagenes(page) {
  await snap(page, "30_pre_upload_button");
  // Si el input ya esta disponible, no hay nada que hacer.
  try {
    const readyInput = page.locator("input[type='file']").first();
    if ((await readyInput.count()) > 0) return true;
  } catch {}

  // "Gestionar paginas" carga la seccion del uploader en la MISMA pagina via collapse/AJAX.
  // IMPORTANTE: usar el click NATIVO de Playwright (no el.click() sintetico via evaluate)
  // para que XenForo reciba los eventos de raton completos (mousemove, mousedown, mouseup, click)
  // y dispare correctamente sus event handlers que abren el collapse.
  const manageBtn = page
    .locator("a, button, [role='button']")
    .filter({ hasText: /Gestionar p[aá]ginas/i })
    .first();
  const manageBtnCount = await manageBtn.count().catch(() => 0);

  if (manageBtnCount > 0) {
    // Obtener info diagnostica sin hacer clic via evaluate
    const manageInfo = await manageBtn.evaluate((el) => ({
      tag: el.tagName,
      href: el.href || el.getAttribute("href") || "(none)",
      cls: el.className || "(none)",
      dataAttrs: Array.from(el.attributes)
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => `${a.name}=${a.value}`)
        .slice(0, 6)
        .join(", ") || "(none)",
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    })).catch(() => ({ tag: "?", href: "?", cls: "?", dataAttrs: "?", visible: "?" }));

    report(`  [INFO] Gestionar paginas (nativo): tag=${manageInfo.tag} href=${manageInfo.href} cls=${manageInfo.cls}`);
    report(`  [INFO] data-attrs=[${manageInfo.dataAttrs}] visible=${manageInfo.visible}`);

    await manageBtn.scrollIntoViewIfNeeded().catch(() => {});
    // Click nativo de Playwright => dispara eventos reales del raton que XenForo necesita
    await manageBtn.click({ force: true, timeout: 5000 }).catch(async () => {
      await manageBtn.click({ timeout: 5000 });
    });

    const found = await page
      .waitForSelector(
        ".bbgMangaUploader, .js-bbgDropzone, input.js-bbgFileInput[type='file'], input[type='file']",
        { state: "attached", timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false);
    report(found ? "  [INFO] Widget detectado tras click nativo." : `  [WARN] Widget no aparecio tras 30s. URL=${page.url()}`);
    return true;
  }

  // Fallback: texto mas amplio por si el boton tiene texto ligeramente diferente
  const fallbackBtn = page
    .locator("a, button, div, span, label, [role='button']")
    .filter({ hasText: /gestionar|manage pages|cargar gestor|agregar p[áa]ginas/i })
    .first();
  if ((await fallbackBtn.count().catch(() => 0)) > 0) {
    report("  [INFO] Usando fallback para Gestionar paginas...");
    await fallbackBtn.scrollIntoViewIfNeeded().catch(() => {});
    await fallbackBtn.click({ force: true, timeout: 5000 }).catch(async () => {
      await fallbackBtn.click({ timeout: 5000 });
    });
    const found = await page
      .waitForSelector(
        ".bbgMangaUploader, .js-bbgDropzone, input.js-bbgFileInput[type='file'], input[type='file']",
        { state: "attached", timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false);
    report(found ? "  [INFO] Widget detectado (fallback)." : `  [WARN] Widget no aparecio (fallback) tras 30s. URL=${page.url()}`);
    return true;
  }

  report("  [WARN] No se encontro boton Gestionar paginas.");
  return false;
}

async function openUploadArea(page) {
  try {
    await page.waitForSelector("input.js-bbgFileInput[type='file'], input[type='file']", { state: "attached", timeout: 15000 });
    return true;
  } catch {}

  const trigger = page
    .locator("a,button,div,span,label,[role='button'],input[type='button'],input[type='submit']")
    .filter({ hasText: /Gestionar p[a\u00e1]ginas|Cargar gestor|Suelta\s+im[a\u00e1]genes\s+aqu[i\u00ed]|Drop\s+images\s+here|click\s+to\s+browse/i });

  const count = await trigger.count().catch(() => 0);
  const max = Math.min(count, 8);
  for (let i = 0; i < max; i++) {
    const t = trigger.nth(i);
    try {
      await t.scrollIntoViewIfNeeded().catch(() => {});
      await t.click({ force: true, timeout: 2500 }).catch(async () => {
        await t.click({ timeout: 2500 });
      });
      await page.waitForSelector("input.js-bbgFileInput[type='file'], input[type='file']", { state: "attached", timeout: 2500 });
      return true;
    } catch {}
  }

  // Selector especifico del uploader real (HTML provisto por usuario).
  try {
    const dz = page.locator(".bbgMangaUploader-dropzone.js-bbgDropzone").first();
    if ((await dz.count()) > 0) {
      await dz.scrollIntoViewIfNeeded().catch(() => {});
      await dz.click({ force: true, timeout: 3000 }).catch(async () => {
        await dz.click({ timeout: 3000 });
      });
      await page.waitForSelector("input.js-bbgFileInput[type='file']", { state: "attached", timeout: 3000 });
      return true;
    }
  } catch {}

  await snap(page, "31_upload_area_not_found");
  return false;
}

async function locateFileInput(page) {
  const candidates = [
    "input.js-bbgFileInput[type=file]",
    ".bbgMangaUploader-dropzone input.js-bbgFileInput[type=file]",
    "input[type=file][multiple]",
    "input[type=file][name=upload]",
    "input[type=file][name='files[]']",
    "input[type=file]",
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return sel;
  }
  throw new Error("No se encontro input[type=file] para subir imagenes.");
}

async function logUploadDiagnostics(page, stage = "") {
  try {
    const info = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return {
        bbgInput: q("input.js-bbgFileInput[type='file']"),
        anyInput: q("input[type='file']"),
        dropzone: q(".bbgMangaUploader-dropzone.js-bbgDropzone"),
        uploader: q(".bbgMangaUploader"),
        status: q(".js-bbgStatus, .js-bbgGlobalProgressText"),
      };
    });
    const frames = page.frames().length;
    report(`  [DEBUG-UP] ${stage} main: bbgInput=${info.bbgInput}, inputFile=${info.anyInput}, dropzone=${info.dropzone}, uploader=${info.uploader}, status=${info.status}, frames=${frames}`);
  } catch (e) {
    report(`  [DEBUG-UP] ${stage} error leyendo diagnostico: ${e?.message || e}`);
  }
}

async function setFilesDirectInAnyFrame(page, files) {
  const sels = [
    "input.js-bbgFileInput[type='file']",
    ".bbgMangaUploader-dropzone input.js-bbgFileInput[type='file']",
    "input[type='file']",
  ];
  const tryCtx = async (ctx) => {
    for (const sel of sels) {
      const loc = ctx.locator(sel).first();
      const c = await loc.count().catch(() => 0);
      if (!c) continue;
      try {
        await loc.evaluate((el) => {
          el.removeAttribute("hidden");
          el.style.display = "block";
          el.style.visibility = "visible";
          el.disabled = false;
        }).catch(() => {});
        await loc.setInputFiles(files);
        return true;
      } catch {}
    }
    return false;
  };
  if (await tryCtx(page)) return true;
  for (const fr of page.frames()) {
    if (await tryCtx(fr)) return true;
  }
  return false;
}

async function setInputFilesAnyFrame(page, files) {
  const candidates = [
    "input[type=file][multiple]",
    "input[type=file][name=upload]",
    "input[type=file][name='files[]']",
    "input[type=file]",
  ];

  const trySetInContext = async (ctx) => {
    for (const sel of candidates) {
      const loc = ctx.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      try {
        await loc.evaluate((el) => {
          el.removeAttribute("hidden");
          el.style.display = "block";
          el.style.visibility = "visible";
          el.classList?.remove?.("is-hidden");
        }).catch(() => {});
      } catch {}
      try {
        await loc.setInputFiles(files);
        return true;
      } catch {}
    }
    return false;
  };

  if (await trySetInContext(page)) return true;
  for (const fr of page.frames()) {
    if (await trySetInContext(fr)) return true;
  }
  return false;
}

async function uploadViaFileChooserFallback(page, files, timeoutMs = 12000) {
  const tryAttachFromLocator = async (loc) => {
    const count = await loc.count().catch(() => 0);
    if (!count) return false;
    const max = Math.min(count, 25);
    for (let i = 0; i < max; i++) {
      const el = loc.nth(i);
      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        const chooser = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 3500 }),
          el.click({ force: true, timeout: 2500 }).catch(async () => {
            await el.click({ timeout: 2500 });
          }),
        ]).then((arr) => arr[0]).catch(() => null);
        if (!chooser) continue;
        await chooser.setFiles(files);
        return true;
      } catch {}
    }
    return false;
  };

  const triggerLocators = [
    page.locator("a,button,div,label,span,[role='button'],input[type='button'],input[type='submit']").filter({ hasText: /Suelta\s+im[a\u00e1]genes\s+aqu[i\u00ed]|Drop\s+images\s+here|haz\s+clic\s+para\s+buscar|click\s+to\s+browse/i }),
    page.locator("a,button,div,label,span,[role='button'],input[type='button'],input[type='submit']").filter({ hasText: /Gestionar\s+p[a\u00e1]ginas|Cargar\s+gestor|Manage\s+pages|Upload\s+manager|Ocultar\s+gestor|Hide\s+manager/i }),
  ];
  for (const loc of triggerLocators) {
    if (await tryAttachFromLocator(loc)) return true;
  }

  // Ultimo fallback: click semantico por texto/atributos y esperar filechooser.
  for (let k = 0; k < 3; k++) {
    const chooser = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 3000 }),
      page.evaluate(() => {
        const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
        const isHit = (t) =>
          t.includes("gestionar paginas")
          || t.includes("cargar gestor")
          || t.includes("manage pages")
          || t.includes("upload manager")
          || t.includes("ocultar gestor")
          || t.includes("hide manager")
          || t.includes("suelta imagenes aqui")
          || t.includes("drop images here")
          || t.includes("haz clic para buscar")
          || t.includes("click to browse");
        const nodes = Array.from(document.querySelectorAll("a,button,div,label,span,[role='button'],input[type='button'],input[type='submit']"));
        for (const el of nodes) {
          const txt = norm(`${el.textContent || ""} ${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""} ${(el.value || "")}`);
          if (!isHit(txt)) continue;
          try {
            el.scrollIntoView({ block: "center", inline: "center" });
            el.click();
            break;
          } catch {}
        }
      }).catch(() => {}),
    ]).then((arr) => arr[0]).catch(() => null);
    if (!chooser) continue;
    await chooser.setFiles(files);
    return true;
  }
  return false;
}

async function readUploadProgress(page) {
  const parseRatio = (txt) => {
    const m = String(txt || "").match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return { done: 0, total: 0 };
    return { done: parseInt(m[1], 10) || 0, total: parseInt(m[2], 10) || 0 };
  };

  try {
    // Prioridad: footer del uploader actual.
    const statusLoc = page.locator(".js-bbgStatus").first();
    const progressTextLoc = page.locator(".js-bbgGlobalProgressText").first();
    const fillLoc = page.locator(".js-bbgGlobalProgressFill").first();

    const hasStatus = (await statusLoc.count()) > 0;
    const hasProgressText = (await progressTextLoc.count()) > 0;
    if (hasStatus || hasProgressText) {
      const statusText = hasStatus ? ((await statusLoc.innerText().catch(() => "")) || "").trim() : "";
      const progressText = hasProgressText ? ((await progressTextLoc.innerText().catch(() => "")) || "").trim() : "";
      let fillPct = 0;
      if ((await fillLoc.count()) > 0) {
        const style = ((await fillLoc.getAttribute("style").catch(() => "")) || "").toLowerCase();
        const mPct = style.match(/width\s*:\s*([0-9.]+)%/);
        if (mPct) fillPct = Number(mPct[1]) || 0;
      }

      const r1 = parseRatio(statusText);
      const r2 = parseRatio(progressText);
      const done = Math.max(r1.done, r2.done);
      const total = Math.max(r1.total, r2.total);
      const isReady = /listo/i.test(statusText) || /^100\s*%/.test(progressText) || fillPct >= 99.9;
      return { done, total, isReady, statusText, progressText, fillPct };
    }
  } catch {}

  try {
    const txt = await page.locator("body").innerText();
    const re = /(\d+)\s*\/\s*(\d+)/g;
    let m;
    let bestDone = 0;
    let bestTotal = 0;
    while ((m = re.exec(txt)) !== null) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) continue;
      if (b > bestTotal || (b === bestTotal && a > bestDone)) {
        bestDone = a;
        bestTotal = b;
      }
    }
    return { done: bestDone, total: bestTotal, isReady: bestTotal > 0 && bestDone >= bestTotal, statusText: "", progressText: "", fillPct: 0 };
  } catch {
    return { done: 0, total: 0, isReady: false, statusText: "", progressText: "", fillPct: 0 };
  }
}

function chapterLinkFromId(chapterId) {
  if (!chapterId) return "";
  return `${BASE_URL.replace(/\/$/, "")}/comics/capitulo/link/${chapterId}/`;
}

function sortChapterResultsByNum(items) {
  const list = items.slice();
  list.sort((a, b) => {
    const an = toNumberMaybe(a.num);
    const bn = toNumberMaybe(b.num);
    if (an !== null && bn !== null) return an - bn;
    return String(a.num).localeCompare(String(b.num), "es", { numeric: true, sensitivity: "base" });
  });
  return list;
}

function buildFinalNotifyMessage(resourceUrl, chaptersListUrl, results) {
  const uploaded = sortChapterResultsByNum(results.filter(r => r && r.status === "ok"));
  const skippedCount = results.filter(r => r && r.status === "skipped").length;
  const errorCount = results.filter(r => r && r.status === "error").length;

  if (!uploaded.length) {
    return `[FIN] Sin capitulos nuevos para subir.\nOmitidos: ${skippedCount} | Errores: ${errorCount}\n${chaptersListUrl || resourceUrl}`;
  }

  if (uploaded.length === 1) {
    const one = uploaded[0];
    const link = chapterLinkFromId(one.chapterId);
    const idPart = one.chapterId ? ` (ID: ${one.chapterId})` : "";
    const target = link || chaptersListUrl || resourceUrl;
    return `[FIN] Subido 1 capitulo: ${one.num}${idPart}\nOmitidos: ${skippedCount} | Errores: ${errorCount}\n${target}`;
  }

  const first = uploaded[0];
  const last = uploaded[uploaded.length - 1];
  return `[FIN] Subidos ${uploaded.length} capitulos: ${first.num} al ${last.num}\nOmitidos: ${skippedCount} | Errores: ${errorCount}\n${chaptersListUrl || resourceUrl}`;
}

// realPreExisting: numero de imagenes que YA estaban en el container antes de esta subida
// (0 para capitulos nuevos, N-2 para reparaciones, etc.).
// Permite calcular cuantos elementos "Listo" del DOM son reales vs. artefactos del widget.
async function waitUploadsComplete(page, expected, maxWaitMs = 180000, realPreExisting = 0) {
  const t0 = Date.now();
  let lastDone = -1;
  let lastChangeTime = Date.now();
  let lastLogTime = 0;
  const STALL_MS = 120000; // 120s sin cambio de progreso = atascado (archivos grandes necesitan mas tiempo)
  const LOG_INTERVAL = 8000; // log de diagnostico cada 8s

  // Medir el conteo inicial de elementos "Listo" antes de que empiecen las subidas.
  // El stepper siempre muestra algunos elementos que coinciden con el selector "Listo"
  // (artefactos del widget). staleOffset = elementos iniciales que NO son imagenes reales.
  const initialCount = await countUploadedImages(page).catch(() => 0);
  const staleOffset = Math.max(0, initialCount - realPreExisting);
  if (staleOffset > 0) {
    report(`  [INFO] Offset DOM: ${staleOffset} elemento(s) pre-existente(s) ignorados en conteo (inicial=${initialCount}, reales=${realPreExisting})`);
  }

  while (Date.now() - t0 < maxWaitMs) {
    const progress = await readUploadProgress(page);
    const enoughByRatio = progress.total >= expected && progress.done >= expected;
    // isReady = "Listo" / "100%" / fill>=99.9% — el uploader puede mostrar esto
    // sin mostrar el ratio "X/Y" (done=0, total=0), por eso NO exigir total > 0.
    const enoughByReady = progress.isReady;

    // Backup: contar tarjetas con estado Listo/Subido directamente en el DOM.
    // Se resta staleOffset para no contar elementos que estaban antes de la subida.
    const rawCount = await countUploadedImages(page).catch(() => 0);
    const uploadedCount = Math.max(0, rawCount - staleOffset);
    const enoughByCount = uploadedCount >= expected && expected > 0;

    if (enoughByRatio || enoughByReady || enoughByCount) {
      if (enoughByCount && !enoughByRatio && !enoughByReady) {
        report(`  [INFO] Completado via conteo directo: ${uploadedCount}/${expected} (raw=${rawCount}, offset=${staleOffset}).`);
      }
      return;
    }

    // Log diagnostico periodico para ver que devuelve readUploadProgress
    if (Date.now() - lastLogTime > LOG_INTERVAL) {
      report(`  [PROG] done=${progress.done}/${progress.total} isReady=${progress.isReady} fill=${Math.round(progress.fillPct)}% status="${progress.statusText}" counted=${uploadedCount}`);
      // Alerta especifica para archivos demasiado grandes (el servidor los rechaza)
      if (/tamano extremo|extreme size|tama[nñ]o.*grande/i.test(progress.statusText)) {
        report(`  [WARN] El servidor indica "subida directa por tamano extremo". Si el progreso no avanza, ` +
               `el archivo puede exceder el limite de subida del servidor (revisa el archivo en cola).`);
      }
      lastLogTime = Date.now();
    }

    // Deteccion de atasco: si done no cambia en STALL_MS, fallar rapido.
    // Incluye el caso done=0 (las subidas nunca arrancaron tras "Subir ahora").
    if (progress.done !== lastDone) {
      lastDone = progress.done;
      lastChangeTime = Date.now();
    } else if (Date.now() - lastChangeTime > STALL_MS) {
      throw new Error(`Subida atascada: ${progress.done}/${expected} sin cambio en ${Math.round(STALL_MS / 1000)}s. Posiblemente las subidas no arrancaron o algunas fallaron.`);
    }

    // Mantener una señal auxiliar por clases de carga, pero no por texto global.
    const activeCss = page.locator(".is-uploading, .isPending, .is-processing");
    if ((await activeCss.count()) > 0) {
      await page.waitForTimeout(350);
      continue;
    }

    await page.waitForTimeout(350);
  }
  throw new Error(`Las subidas no finalizaron a tiempo (esperaba ${expected} imagenes).`);
}

// ===== Pre-procesado automatico de imagenes (compresion + corte de imagenes altas) =====
// El servidor rechaza archivos >~900KB (modo "direct upload" falla con Playwright).
// Tambien rechaza imagenes con altura >10 000px.
// preprocessImages() maneja ambos casos antes de subir.
const COMPRESS_THRESHOLD_KB = 850;
const MAX_HEIGHT_PX = 10000; // altura maxima permitida por el servidor
let _sharpLib;
async function getSharp() {
  if (_sharpLib !== undefined) return _sharpLib;
  try { _sharpLib = (await import("sharp")).default; }
  catch { _sharpLib = null; }
  return _sharpLib;
}

// Comprime f→out intentando distintas calidades y escalas hasta quedar bajo targetKB.
// Devuelve el tamaño final en KB.
async function compressToTarget(sh, f, out, ext, targetKB) {
  // Paso 1: solo calidad (sin redimensionar)
  const qualitySteps = [75, 65, 55, 45];
  for (const q of qualitySteps) {
    let pipe = sh(f);
    if      (ext === ".webp") pipe = pipe.webp({ quality: q });
    else if (ext === ".png")  pipe = pipe.png({ compressionLevel: 9, adaptiveFiltering: true });
    else                      pipe = pipe.jpeg({ quality: q, mozjpeg: true });
    await pipe.toFile(out);
    const kb = fs.statSync(out).size / 1024;
    if (kb <= targetKB) return kb;
  }
  // Paso 2: reducir dimensiones (90%, 80%, 70%) con quality=55
  const meta = await sh(f).metadata();
  for (const scale of [0.90, 0.80, 0.70]) {
    const w = Math.round((meta.width || 1200) * scale);
    let pipe = sh(f).resize({ width: w, withoutEnlargement: true });
    if      (ext === ".webp") pipe = pipe.webp({ quality: 55 });
    else if (ext === ".png")  pipe = pipe.png({ compressionLevel: 9, adaptiveFiltering: true });
    else                      pipe = pipe.jpeg({ quality: 55, mozjpeg: true });
    await pipe.toFile(out);
    const kb = fs.statSync(out).size / 1024;
    if (kb <= targetKB) return kb;
  }
  return fs.statSync(out).size / 1024; // mejor esfuerzo
}

// Preprocesa una lista de archivos antes de subir:
//   • Imagenes con altura > MAX_HEIGHT_PX → cortadas en rodajas de MAX_HEIGHT_PX px
//     Nombradas: {base}_s01.ext, {base}_s02.ext, ...
//     Cada rodaja se comprime si supera COMPRESS_THRESHOLD_KB.
//   • Imagenes normales con tamaño > COMPRESS_THRESHOLD_KB → solo comprimir.
//   • El resto pasa sin cambios.
// Devuelve una lista (posiblemente mas larga que la entrada) con las rutas a usar.
async function preprocessImages(files) {
  const sh = await getSharp();
  if (!sh) {
    report(`  [WARN] 'sharp' no esta instalado. No se puede comprimir ni cortar imagenes grandes.`);
    report(`  [WARN] Ejecuta: npm install sharp`);
    return files;
  }

  // ── Fase 1: leer metadata de todos los archivos ───────────────────────
  const metas = [];
  for (const f of files) {
    try {
      const sizeKB = fs.statSync(f).size / 1024;
      const meta   = await sh(f).metadata();
      metas.push({ f, sizeKB, height: meta.height || 0, width: meta.width || 1, ext: path.extname(f).toLowerCase() });
    } catch (e) {
      report(`  [WARN] No se pudo leer ${path.basename(f)}: ${e.message}. Usando original.`);
      metas.push({ f, sizeKB: 0, height: 0, width: 0, ext: path.extname(f).toLowerCase(), error: true });
    }
  }

  // Si ningun archivo necesita procesamiento, devolver originales sin tocar
  const needsProcessing = metas.some(m => !m.error && (m.height > MAX_HEIGHT_PX || m.sizeKB > COMPRESS_THRESHOLD_KB));
  if (!needsProcessing) return files;

  // ── Fase 2: crear _procesadas y procesar con numeracion secuencial ────
  const chapterBaseDir = files.length ? path.dirname(files[0]) : os.tmpdir();
  const outDir = path.join(chapterBaseDir, "_procesadas");
  fs.mkdirSync(outDir, { recursive: true });

  const result = [];
  let counter  = 1;

  for (const m of metas) {
    const { f, sizeKB, height, width, ext } = m;

    if (m.error) {
      // Archivo ilegible: copiar tal cual con numero secuencial
      const dest = path.join(outDir, `${String(counter).padStart(3, "0")}${ext}`);
      counter++;
      try { fs.copyFileSync(f, dest); result.push(dest); }
      catch  { result.push(f); }
      continue;
    }

    if (height > MAX_HEIGHT_PX) {
      // ── Cortar en rodajas con numeros secuenciales ─────────────────────
      const numSlices = Math.ceil(height / MAX_HEIGHT_PX);
      report(`  [SPLIT] ${path.basename(f)}: ${height}px → ${numSlices} parte(s)`);
      for (let i = 0; i < numSlices; i++) {
        const top     = i * MAX_HEIGHT_PX;
        const sliceH  = Math.min(MAX_HEIGHT_PX, height - top);
        const outName = `${String(counter).padStart(3, "0")}${ext}`;
        counter++;
        const sliceOut = path.join(outDir, outName);
        try {
          await sh(f).extract({ left: 0, top, width, height: sliceH }).toFile(sliceOut);
          let sliceKB = fs.statSync(sliceOut).size / 1024;
          if (sliceKB > COMPRESS_THRESHOLD_KB) {
            const tmp    = sliceOut + ".tmp";
            const newKB  = await compressToTarget(sh, sliceOut, tmp, ext, COMPRESS_THRESHOLD_KB);
            fs.renameSync(tmp, sliceOut);
            const tag = newKB > COMPRESS_THRESHOLD_KB ? " [AUN GRANDE]" : "";
            report(`  [SPLIT+COMPRESS] ${outName}: ${sliceKB.toFixed(0)}KB → ${newKB.toFixed(0)}KB${tag}`);
          } else {
            report(`  [SPLIT] ${outName}: ${sliceKB.toFixed(0)}KB`);
          }
          result.push(sliceOut);
        } catch (e) {
          report(`  [WARN] Error al cortar parte ${i + 1} de ${path.basename(f)}: ${e.message}. Usando original.`);
          result.push(f);
        }
      }

    } else if (sizeKB > COMPRESS_THRESHOLD_KB) {
      // ── Solo comprimir ─────────────────────────────────────────────────
      const outName = `${String(counter).padStart(3, "0")}${ext}`;
      counter++;
      const out = path.join(outDir, outName);
      try {
        const newKB = await compressToTarget(sh, f, out, ext, COMPRESS_THRESHOLD_KB);
        const tag   = newKB > COMPRESS_THRESHOLD_KB ? " [AUN GRANDE]" : "";
        report(`  [COMPRESS] ${path.basename(f)} → ${outName}: ${sizeKB.toFixed(0)}KB → ${newKB.toFixed(0)}KB${tag}`);
        result.push(out);
      } catch (e) {
        report(`  [WARN] No se pudo comprimir ${path.basename(f)}: ${e.message}. Copiando original.`);
        try { fs.copyFileSync(f, out); result.push(out); }
        catch  { result.push(f); }
      }

    } else {
      // ── Sin cambios: copiar con numero secuencial ──────────────────────
      const outName = `${String(counter).padStart(3, "0")}${ext}`;
      counter++;
      const dest = path.join(outDir, outName);
      try {
        fs.copyFileSync(f, dest);
        result.push(dest);
      } catch (e) {
        report(`  [WARN] No se pudo copiar ${path.basename(f)}: ${e.message}`);
        result.push(f);
      }
    }
  }

  report(`  [INFO] ${result.length} archivo(s) listos en: ${outDir}`);
  return result;
}
// =====================================================

// alreadyOverride: si se pasa un numero, se usa directamente en lugar de consultar countUploadedImages.
// Usar alreadyOverride=0 para capitulos recien creados (evita falsos positivos por DOM residual
// del capitulo anterior que todavia muestra elementos "Listo" antes de que el widget se reinicie).
async function uploadImagesInBatches(page, files, batchSize = BATCH_UPLOAD_SIZE, queueUploads = false, alreadyOverride = null) {
  if (!files.length) return;
  await waitIfPaused();
  const already = alreadyOverride !== null
    ? alreadyOverride
    : await countUploadedImages(page);
  const alreadySource = alreadyOverride !== null ? "forzado" : "detectado";
  report(`  [INFO] Iniciando subida de ${files.length} imagenes (ya subidas: ${already} [${alreadySource}])`);

  // Preservar archivos que ya estan en cola/subidos en el servidor.
  // El uploader guarda el estado servidor-side (edit_existing=1 en data-manage-url).
  if (already >= files.length) {
    report(`  [INFO] Todas las imagenes ya estan en cola o subidas (${already}/${files.length}). Preservando cola, sin re-subir.`);
    return;
  }
  if (already > 0) {
    report(`  [INFO] Preservando ${already} imagenes en cola; subiendo solo las ${files.length - already} restantes.`);
    files = files.slice(already);
  }

  // Log de archivos a subir (util para identificar cual falla si hay un atasco)
  const fileNames = files.map(f => path.basename(f));
  report(`  [INFO] Archivos a subir: ${fileNames.join(", ")}`);

  await openUploadArea(page);
  await logUploadDiagnostics(page, "post-openUploadArea");

  // Flujo Stepper actual: seleccionar todas las imagenes del capitulo de una sola vez.
  report(`  - Seleccionando todas las imagenes del capitulo (${files.length} archivos)`);
  let uploaded = await setFilesDirectInAnyFrame(page, files);
  if (uploaded) report("  [DEBUG-UP] setInputFiles directo OK (main/frame).");

  if (!uploaded) {
    await logUploadDiagnostics(page, "antes-locateFileInput");
  }
  try {
    if (!uploaded) {
      const finput = await locateFileInput(page);
      report(`  [DEBUG-UP] locateFileInput encontro: ${finput}`);
      try {
        await page.locator(finput).first().evaluate((el) => {
          el.removeAttribute("hidden");
          el.style.display = "block";
          el.style.visibility = "visible";
          if (el.classList) el.classList.remove("is-hidden");
        });
      } catch {}
      await page.setInputFiles(finput, files);
      uploaded = true;
      report("  [DEBUG-UP] setInputFiles por selector OK.");
    }
  } catch {}

  if (!uploaded) {
    const trigger = page
      .locator("a,button,div,span,label,[role='button'],input[type='button'],input[type='submit']")
      .filter({ hasText: /Gestionar p[a\u00e1]ginas|Suelta\s+im[a\u00e1]genes\s+aqu[i\u00ed]|Drop\s+images\s+here|click\s+to\s+browse/i })
      .first();
    try {
      const chooser = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 5000 }),
        trigger.click({ force: true, timeout: 3000 }),
      ]).then(x => x[0]).catch(() => null);
      if (chooser) {
        await chooser.setFiles(files);
        uploaded = true;
        report("  [DEBUG-UP] filechooser OK.");
      }
    } catch {}
  }

  if (!uploaded) {
    await logUploadDiagnostics(page, "fallo-final-seleccion");
    report("  [WARN] No se pudo abrir selector automaticamente. Usa 'Suelta imagenes aqui' y selecciona los archivos manualmente.");
    const manualOk = await waitForManualFileSelection(page, Math.min(files.length, 1), 180000);
    if (!manualOk) {
      throw new Error("No se pudo abrir el selector de archivos en Paso 3.");
    }
    report("  [INFO] Seleccion manual detectada, continuando...");
  }

  // Pausa minima para que el uploader procese los archivos seleccionados antes de continuar.
  await page.waitForTimeout(300);
}

async function waitForManualFileSelection(page, minCount = 1, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const progress = await readUploadProgress(page);
      if (progress.total >= minCount || progress.done >= minCount) return true;
    } catch {}
    try {
      const cards = await countUploadedImages(page);
      if (cards >= minCount) return true;
    } catch {}
    await page.waitForTimeout(400);
  }
  return false;
}

async function ensureUploadConfirmationChecked(page) {
  // Selector especÃ­fico del uploader actual.
  try {
    const cb = page.locator("input.js-bbgPolicyConfirm[type='checkbox']").first();
    if ((await cb.count()) > 0) {
      try { await cb.scrollIntoViewIfNeeded(); } catch {}
      if (!(await cb.isChecked())) {
        try {
          await page.locator("label.bbgMangaUploader-policyToggle").first().click({ force: true, timeout: 2000 });
        } catch {}
      }
      if (!(await cb.isChecked())) {
        try { await cb.check({ force: true }); } catch {}
      }
      if (!(await cb.isChecked())) {
        await cb.evaluate((el) => {
          el.checked = true;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      if (await cb.isChecked()) return true;
    }
  } catch {}

  const checked = await page.evaluate(() => {
    const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const labels = Array.from(document.querySelectorAll("label"));

    for (const lab of labels) {
      const t = norm(lab.textContent || "");
      const spanish = t.includes("al subir") && t.includes("confirmo");
      const english = (t.includes("upload") || t.includes("publishing")) && (t.includes("confirm") || t.includes("acknowledge"));
      if (!spanish && !english) continue;

      let cb = null;
      const forId = lab.getAttribute("for");
      if (forId) cb = document.getElementById(forId);
      if (!cb) cb = lab.querySelector("input[type='checkbox']");
      if (!cb) cb = lab.closest(".block-row, .formRow, .input, .contentRow, div")?.querySelector("input[type='checkbox']") || null;
      if (!cb) continue;

      if (!cb.checked) cb.click();
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("input", { bubbles: true }));
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return !!cb.checked;
    }
    return false;
  });

  return checked;
}

async function clickStepperNext(page, timeoutMs = 10000) {
  return clickVisibleButtonByText(page, RE_NEXT_BUTTON, timeoutMs);
}

async function waitSubirAhoraEnabled(page, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const btn = page.locator("button, a, input[type='button'], input[type='submit']").filter({ hasText: RE_UPLOAD_NOW_BUTTON }).first();
    if ((await btn.count()) > 0) {
      try {
        const disabledAttr = await btn.getAttribute("disabled");
        const ariaDisabled = (await btn.getAttribute("aria-disabled")) || "";
        const className = ((await btn.getAttribute("class")) || "").toLowerCase();
        const enabledByApi = await btn.isEnabled().catch(() => false);
        const looksDisabled = disabledAttr !== null || ariaDisabled === "true" || className.includes("is-disabled") || className.includes("disabled");
        if (enabledByApi && !looksDisabled) return true;
      } catch {}
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickSubirAhora(page, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const btn = page.locator("button, a, input[type='button'], input[type='submit']").filter({ hasText: RE_UPLOAD_NOW_BUTTON });
    const count = await btn.count();
    for (let i = 0; i < count; i++) {
      const b = btn.nth(i);
      try {
        if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
        await b.scrollIntoViewIfNeeded();
        await b.click({ timeout: 2500 });
        return true;
      } catch {}
    }
    await page.waitForTimeout(250);
  }
  return false;
}

// realPreExisting: imagenes ya presentes en el container antes de esta subida.
// 0 para capitulos nuevos; usar el conteo real para reparaciones/reintentos.
async function publishFromStepper(page, chaptersListUrl, expectedCount, realPreExisting = 0) {
  const progressDeadline = Math.max(TIMEOUT_MS * 8, 600000);

  report("  [INFO] Marcando casilla de confirmacion...");
  const okCheck = await ensureUploadConfirmationChecked(page);
  if (!okCheck) throw new Error("No se pudo marcar la casilla 'Al subir, confirmo que'.");

  const preProgress = await readUploadProgress(page);
  const alreadyComplete = preProgress.isReady && preProgress.total >= expectedCount && preProgress.done >= expectedCount;

  if (!alreadyComplete) {
    report("  [INFO] Esperando habilitacion de 'Subir ahora'...");
    const uploadEnabled = await waitSubirAhoraEnabled(page, 30000);
    if (!uploadEnabled) throw new Error("La casilla se marco, pero 'Subir ahora' no se habilito.");

    report("  [INFO] Pulsando 'Subir ahora'...");
    const started = await clickSubirAhora(page, 30000);
    if (!started) throw new Error("No se pudo pulsar el boton 'Subir ahora'.");
  } else {
    report(`  [INFO] Uploader ya estaba en estado completo (${preProgress.done}/${preProgress.total}).`);
  }

  report(`  [INFO] Esperando estado final de subida (${expectedCount}/${expectedCount})...`);
  await waitUploadsComplete(page, expectedCount, progressDeadline, realPreExisting);

  const next = await clickStepperNext(page, 15000);
  if (!next) throw new Error("No se pudo avanzar desde Paso 3 a Paso 4.");

  const step4 = await waitForStepperStep(page, 4, 20000);
  if (!step4) throw new Error("No se detecto Paso 4 (Confirmacion).");

  const publish = await clickVisibleButtonByText(page, RE_CONFIRM_PUBLISH_BUTTON, 15000);
  if (!publish) throw new Error("No se encontro el boton 'Confirmar y publicar'.");

  report("  [INFO] 'Confirmar y publicar' pulsado. Detectando confirmacion...");

  // Contar el boton ANTES de que el AJAX responda (referencia baseline).
  // Si el boton es un <a> (styled link), el conteo sera 0 antes tambien — en ese caso
  // solo usamos la senal de URL y success alert.
  const btnLocator = page.locator("button, a, input[type='button'], input[type='submit']")
    .filter({ hasText: /Confirmar\s+y\s+publicar/i });
  const btnCountBefore = await btnLocator.count().catch(() => 0);

  await page.waitForTimeout(1500);
  await snap(page, "40_post_confirm_publish");

  const postUrl = String(page.url() || "").toLowerCase();
  report(`  [INFO] URL tras publicar: ${page.url()}`);

  // El batch uploader puede publicar de dos formas:
  //   a) Navegacion clasica: redirige a otra URL tras confirmar.
  //   b) AJAX: URL permanece en manga-uploader/batch pero el boton desaparece/cambia.
  // Criterio de exito: URL salio del stepper O boton "Confirmar y publicar" desaparecio.
  const isOnStepper = (url) =>
    url.includes("manga-uploader") || url.includes("/capitulos/add");

  // Caso a: ya salimos del stepper por navegacion clasica
  if (!isOnStepper(postUrl)) {
    report("  [INFO] Publicado — URL salio del stepper.");
    return true;
  }

  // Caso b: publicacion AJAX — URL no cambia. Sondear DOM.
  // Timeout escalado: minimo 60s, mas 800ms por imagen (capitulos grandes necesitan mas tiempo
  // para que el servidor procese el AJAX de publicacion).
  const pollMs = Math.max(60000, (expectedCount || 0) * 800);
  report(`  [INFO] Sondeo post-publicar: ${Math.round(pollMs / 1000)}s (${expectedCount} imagenes)`);
  const pollDeadline = Date.now() + pollMs;
  while (Date.now() < pollDeadline) {
    // Senal 1: URL cambio (navegacion con retardo)
    if (!isOnStepper(String(page.url()).toLowerCase())) {
      report(`  [INFO] Publicado — URL cambio a: ${page.url()}`);
      return true;
    }

    // Senal 2: boton "Confirmar y publicar" desaparecio del DOM.
    // Solo consideramos este criterio si habia ≥1 boton antes del click (evitar falso positivo
    // cuando el boton es un <a> que no fue encontrado por el locator antes).
    if (btnCountBefore > 0) {
      const btnCountNow = await btnLocator.count().catch(() => 0);
      if (btnCountNow === 0) {
        report("  [INFO] Publicado — boton 'Confirmar y publicar' desaparecio (respuesta AJAX recibida).");
        await snap(page, "41_post_confirm_ajax_ok");
        return true;
      }
    }

    // Senal 3: alerta de exito visible en pagina (XenForo usa .alert--success, etc.)
    const hasSuccessAlert = await page
      .locator('.alert--success, .message--success, .successMessage, [class*="notice--success"], .bbgSuccess')
      .isVisible()
      .catch(() => false);
    if (hasSuccessAlert) {
      report("  [INFO] Publicado — alerta de exito detectada en pagina.");
      await snap(page, "41_post_confirm_success_alert");
      return true;
    }

    await page.waitForTimeout(600);
  }

  // Verificacion final de URL tras el sondeo
  if (!isOnStepper(String(page.url()).toLowerCase())) {
    report(`  [INFO] Publicado (final) — URL: ${page.url()}`);
    return true;
  }

  report(`  [WARN] URL post-publicar tras sondeo 25s: ${page.url()}`);
  throw new Error(`No se pudo confirmar publicacion del capitulo. URL: ${page.url()}`);
}

// ===== existing chapters scanning =====
function parseChapterNumberFromAnchorText(text) {
  const clean = String(text || "").trim();
  const m1 = clean.match(/cap(?:i|\u00ed)tulo\s*([0-9]+(?:[.,][0-9]+)?)/i);
  if (m1) return m1[1];
  const nums = clean.match(/\b([0-9]+(?:[.,][0-9]+)?)\b/g);
  return nums && nums.length ? nums[0] : null;
}

function isLikelyChapterHref(href) {
  const h = String(href || "").toLowerCase();
  return h.includes("/comics/capitulo/link/")
    || h.includes("/comics/capitulos/")
    || h.includes("/comics/capitulo/")
    || h.includes("/capitulos/")
    || h.includes("/capitulo/");
}

function textLooksLikeTargetChapter(text, targetText, targetNum) {
  const t = String(text || "").trim();
  if (!t) return false;
  const normalized = normalizeTextLoose(t);
  if (normalized === targetText || normalized.includes(targetText) || targetText.includes(normalized)) return true;
  if (targetNum !== null) {
    const itemNum = normalizeChapterNumber(parseChapterNumberFromAnchorText(t) || chapterNumberFromText(t));
    if (itemNum !== null && itemNum === targetNum) return true;
  }
  return false;
}

async function collectExistingChapters(page, chaptersListUrl) {
  const existing = new Set();
  await go(page, chaptersListUrl);
  const last = await getLastPageNumberFast(page);
  for (let p=1; p<=last; p++) {
    const url = withPageParam(chaptersListUrl, p);
    await go(page, url);
    const items = page.locator(CHAPTER_ANCHOR);
    const c = await items.count();
    for (let i=0; i<c; i++) {
      const t = (await items.nth(i).innerText()).trim();
      const raw = parseChapterNumberFromAnchorText(t) || chapterNumberFromText(t);
      const num = normalizeChapterNumber(raw);
      if (num !== null) existing.add(num);
    }

    // Fallback para layouts donde el tÃ­tulo no estÃ¡ en anchors clickeables.
    try {
      const bodyText = await page.locator("body").innerText();
      const re = /cap(?:i|\u00ed)tulo\s+([0-9]+(?:[.,][0-9]+)?)/gi;
      let m;
      while ((m = re.exec(bodyText)) !== null) {
        const num = normalizeChapterNumber(m[1]);
        if (num !== null) existing.add(num);
      }
    } catch {}
  }
  return existing;
}

// ===== build jobs =====
function buildJobsFromRoot(rootDir) {
  const candidates = [];
  for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!ent || !ent.isDirectory()) continue;
    const name = ent.name;
    const full = path.join(rootDir, name);
    const num = chapterNumberFromFolderName(name) || chapterNumberFromText(name);
    if (!num) continue;
    candidates.push([num, full]);
  }
  function numKey(numStr) {
    const s = String(numStr);
    if (s.includes(".")) {
      const [a,b] = s.split(".",2);
      return [parseInt(a,10), parseInt(b || "0",10)];
    }
    return [parseInt(s,10), 0];
  }
  candidates.sort((x,y) => {
    const ax = numKey(x[0]); const ay = numKey(y[0]);
    return ax[0]-ay[0] || ax[1]-ay[1];
  });
  return candidates;
}

async function planJobs(page, rootDir, chaptersListUrl, onlyList, existingSet = null) {
  const catalog = new Map(buildJobsFromRoot(rootDir));
  if (onlyList && onlyList.length) {
    const desired = [];
    for (const r of onlyList) {
      const num = chapterNumberFromText(r) || r;
      if (catalog.has(num)) desired.push([num, catalog.get(num)]);
      else report(`[OMITIDO] No encontrÃ© carpeta para capÃ­tulo '${r}' en ${rootDir}`);
    }
    return desired;
  }
  // OptimizaciÃ³n: consultar existentes una vez y planear solo faltantes.
  const existing = existingSet || await collectExistingChapters(page, chaptersListUrl);
  const out = [];
  for (const [n, p] of catalog.entries()) {
    const nn = normalizeChapterNumber(n);
    if (nn === null || !existing.has(nn)) out.push([n, p]);
  }
  return out;
}

let chapterCreationQueue = Promise.resolve();

function enqueueChapterCreation(task) {
  const run = chapterCreationQueue.then(task);
  chapterCreationQueue = run.catch(() => {});
  return run;
}
async function chapterExistsInSite(page, chaptersListUrl, chapterNumber) {
  try {
    const existing = await collectExistingChapters(page, chaptersListUrl);
    const target = normalizeChapterNumber(chapterNumber);
    if (target === null) return false;
    return existing.has(target);
  } catch { return false; }
}

// ===== process a chapter =====
async function processOneChapter(page, chaptersListUrl, resourceUrl, chapterNumber, chapterDir, queueUploads) {
  await waitIfPaused();
  const images = listImages(chapterDir);
  if (!images.length) {
    report(`[OMITIDO] ${path.basename(chapterDir)}: sin imagenes`);
    return;
  }

  // Pre-procesar: cortar imagenes altas (>MAX_HEIGHT_PX) y comprimir grandes (>COMPRESS_THRESHOLD_KB).
  // El array resultante puede tener MAS archivos que el original si alguna imagen fue cortada.
  const rawFiles  = images.slice();
  report(`[INFO] Procesando ${path.basename(chapterDir)}: ${rawFiles.length} imagenes (pre-procesando...)`);
  const partFiles   = await preprocessImages(rawFiles);
  const expectedTotal = partFiles.length;
  if (partFiles.length !== rawFiles.length) {
    report(`[INFO] Pre-proceso: ${rawFiles.length} imagen(es) → ${partFiles.length} archivo(s) tras cortes/compresion`);
  }

  const chapterText = displayTextFor(chapterNumber);
  const chapterExtra = extractChapterExtraFromFolderName(path.basename(chapterDir));
  let chapterId = null;

  await enqueueChapterCreation(async () => {
    report(`[NUEVO] Creando ${chapterText}...`);
    await openAddChapterOverlay(page, chaptersListUrl, resourceUrl);
    await fillOverlayCreateChapter(page, chapterNumber, chapterExtra);
    await page.waitForTimeout(200);

    if (!(await isChapterUploadFormPage(page))) {
      throw new Error(`Tras crear ${chapterText}, no quedamos en Paso 3 (Paginas).`);
    }

    chapterId = getCurrentChapterIdFromUrl(page.url());
    report(`[NUEVO] ${chapterText} creado y listo para subir (ID: ${chapterId || "N/A"})`);
  });

  report(`[SUBIENDO] ${chapterText} (ID: ${chapterId || "N/A"}): iniciando subida de ${partFiles.length} imagenes...`);

  await clickSubirImagenes(page);

  // ── Deteccion de draft obsoleto ──────────────────────────────────────────
  // Cuando un capitulo anterior falla antes de publicarse, el servidor mantiene
  // su sesion de subida abierta. El siguiente capitulo recibe el MISMO container_id,
  // mezclando imagenes de distintos capitulos (corrupcion de datos).
  // Si detectamos que el container_id ya fue asignado a otro capitulo en esta sesion,
  // paramos de inmediato para evitar corrupcion. El usuario debe resolver el draft
  // pendiente manualmente antes de continuar.
  const thisContainerId = await extractContainerIdFromPage(page).catch(() => null);
  if (thisContainerId) {
    const prevChapter = _containerChapterMap.get(thisContainerId);
    if (prevChapter !== undefined && prevChapter !== chapterNumber) {
      throw new Error(
        `DRAFT OBSOLETO: el container_id=${thisContainerId} pertenece al cap ${prevChapter} ` +
        `que no se publico correctamente. Entra manualmente al stepper del cap ${prevChapter}, ` +
        `completa o cancela esa subida, y vuelve a ejecutar el script.`
      );
    }
    _containerChapterMap.set(thisContainerId, chapterNumber);
    report(`  [INFO] container_id=${thisContainerId} asignado a cap ${chapterNumber}.`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // openUploadArea ya se llama dentro de uploadImagesInBatches; no repetir aqui.
  // Pasamos alreadyOverride=0: este capitulo acaba de ser creado, el container es nuevo.
  // Sin esto, countUploadedImages detecta DOM residual del capitulo anterior (2 items "Listo")
  // y omite las primeras 2 imagenes del capitulo, dejandolo incompleto.
  await uploadImagesInBatches(page, partFiles, BATCH_UPLOAD_SIZE, queueUploads, 0);

  // realPreExisting=0: capitulo recien creado, ningun archivo real previo en el container.
  await publishFromStepper(page, chaptersListUrl, expectedTotal, 0);
  report(`[OK] ${chapterText} (ID: ${chapterId || "N/A"}): publicado en stepper`);

  // Publicacion exitosa: liberar el container de este capitulo del mapa de seguimiento
  // (ya no debe bloquear futuros capitulos).
  if (thisContainerId) _containerChapterMap.delete(thisContainerId);

  return { chapterId };
}

// ===== verify and resubmit (simple, sequential) =====
// Repara un capitulo ya publicado que tiene imagenes faltantes.
// En lugar de recrear el capitulo, abre el stepper en modo edicion y sube
// solo los primeros (expectedTotal - currentCount) archivos que faltan.
// Util para el caso donde alreadyOverride=0 omitio las primeras N imagenes.
async function repairChapterImages(page, chaptersListUrl, chapterNumber, chapterDir, currentCount) {
  const allImages = listImages(chapterDir);
  const chapterText = displayTextFor(chapterNumber);

  // Pre-procesar las imagenes originales para saber el total real despues de cortes.
  // (Si alguna imagen fue cortada en rodajas, el total esperado aumenta.)
  report(`[REPAIR] ${chapterText}: pre-procesando ${allImages.length} imagen(es) para calcular total real...`);
  const allProcessed = await preprocessImages(allImages.slice());
  const totalExpected = allProcessed.length;
  if (allProcessed.length !== allImages.length) {
    report(`  [REPAIR] Pre-proceso: ${allImages.length} → ${allProcessed.length} archivos (cortes/compresion)`);
  }

  const missingCount = totalExpected - currentCount;
  if (missingCount <= 0) {
    report(`  [REPAIR] ${chapterText}: ya tiene ${currentCount}/${totalExpected} imagenes, nada que reparar.`);
    return;
  }

  // Las imagenes faltantes son los primeros 'missingCount' archivos del array procesado
  const missingFiles = allProcessed.slice(0, missingCount);
  report(`[REPAIR] ${chapterText}: ${currentCount}/${totalExpected} presentes → subiendo ${missingFiles.map(f => path.basename(f)).join(", ")}`);

  // Navegar al capitulo y abrir su stepper en modo edicion
  const opened = await openChapterFromList(page, chaptersListUrl, chapterText, chapterNumber, 2);
  if (!opened.ok) throw new Error(`No se pudo abrir ${chapterText} para reparar.`);

  await clickSubirImagenes(page);

  const containerId = await extractContainerIdFromPage(page).catch(() => null);
  if (containerId) report(`  [REPAIR] container_id=${containerId} (edicion: ${currentCount} imagenes ya presentes)`);

  // Subir SOLO las imagenes faltantes con alreadyOverride=0 para no saltarlas.
  // Las imagenes nuevas quedan al final (ej: pos 13,14 para 001 y 002).
  // Nota: missingFiles ya esta pre-procesado, no necesita pasar por preprocessImages de nuevo.
  await uploadImagesInBatches(page, missingFiles, BATCH_UPLOAD_SIZE, false, 0);

  // Ordenar rapidamente por nombre de archivo para que 001 vaya a pos 1, 002 a pos 2, etc.
  // Sin este paso las imagenes reparadas quedarian al final en orden incorrecto.
  report(`  [REPAIR] Ordenando imagenes por nombre de archivo...`);
  try {
    const sortBtn = page.locator("button, a").filter({ hasText: /ordenar\s+r[aá]pido/i }).first();
    if (await sortBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sortBtn.click({ timeout: 5000 });
      await page.waitForTimeout(1500); // esperar que se aplique el orden
      report(`  [REPAIR] Orden aplicado.`);
    } else {
      report(`  [REPAIR-WARN] Boton 'Ordenar rapido' no visible — revisa el orden de las imagenes manualmente.`);
    }
  } catch (e) {
    report(`  [REPAIR-WARN] No se pudo ordenar: ${e.message}`);
  }

  // Publicar; realPreExisting=currentCount para no contar como stale las imagenes ya presentes.
  await publishFromStepper(page, chaptersListUrl, totalExpected, currentCount);

  report(`[REPAIR-OK] ${chapterText}: reparado y reordenado (${currentCount} → ${totalExpected} imagenes).`);
}

// ===== Re-sube un capítulo desde cero (el capítulo ya fue eliminado manualmente de la web) =====
async function clearAndReuploadChapter(page, chaptersListUrl, resourceUrl, chapterNumber, chapterDir) {
  const chapterText = displayTextFor(chapterNumber);

  // Borrar _procesadas local para regenerar con numeración secuencial correcta
  const processedDir = path.join(chapterDir, "_procesadas");
  if (fs.existsSync(processedDir)) {
    fs.rmSync(processedDir, { recursive: true, force: true });
    report(`  [CLEAR] ${chapterText}: _procesadas eliminada, se regenerará con numeración correcta.`);
  }

  // Crear el capítulo en la web y subir todas las imágenes
  report(`[FORCE-REUPLOAD] ${chapterText}: creando y subiendo...`);
  await processOneChapter(page, chaptersListUrl, resourceUrl, chapterNumber, chapterDir, false);
  report(`[FORCE-REUPLOAD-OK] ${chapterText}: completado.`);
}

async function findMissingWork(page, chaptersListUrl, jobsList) {
  // Retorna: [num, dir, shouldRepair, currentCount]
  // shouldRepair=true  → capitulo existe pero le faltan imagenes → usar repairChapterImages
  // shouldRepair=false → capitulo no existe aun             → usar processOneChapter
  const missing = [];
  const existing = await collectExistingChapters(page, chaptersListUrl);
  for (const [num, dir] of jobsList) {
    const imgs = listImages(dir);
    if (!imgs.length) continue;
    if (!existing.has(num)) { missing.push([num, dir, false, 0]); continue; }

    // Verificacion exacta: marcar si falta CUALQUIER imagen (no solo si <80%)
    try {
      const chapterText = displayTextFor(num);
      const opened = await openChapterFromList(page, chaptersListUrl, chapterText, null, 2);
      if (!opened.ok) { missing.push([num, dir, false, 0]); continue; }
      const actual = await countSavedImagesAccurate(page, { scroll: true });
      if (actual < imgs.length) {
        report(`  [INFO] ${chapterText} tiene ${actual}/${imgs.length} imagenes → reparacion necesaria`);
        missing.push([num, dir, true, actual]); // existe, necesita reparacion
      }
    } catch { /* ignore */ }
  }
  return missing;
}

// ===== concurrency helper =====
async function runPool(items, parallel, worker) {
  const results = [];
  let idx = 0;
  const runners = new Array(parallel).fill(0).map(async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur]);
    }
  });
  await Promise.all(runners);
  return results;
}

// Lotes secuenciales: procesa "parallel" items a la vez, pero espera a que
// termine cada lote antes de iniciar el siguiente. Esto garantiza que los
// capÃ­tulos se creen en orden ascendente (lote 1â†’2â†’3, luego 4â†’5â†’6, etc.)
async function runPoolSequentialBatches(items, parallel, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += parallel) {
    const batch = items.slice(i, i + parallel);
    const batchResults = await Promise.all(batch.map((item, slot) => worker(item, slot + 1)));
    results.push(...batchResults);
  }
  return results;
}

// Lotes secuenciales con pre-creaciÃ³n por lote: pre-crea solo los capÃ­tulos del lote actual
// antes de procesarlos, minimizando la cantidad de capÃ­tulos vacÃ­os visibles a la vez.
async function runPoolSequentialBatchesWithPreCreate(items, parallel, worker, preCreateFn) {
  const results = [];
  for (let i = 0; i < items.length; i += parallel) {
    const batch = items.slice(i, i + parallel);

    // Pre-crear solo los capÃ­tulos de este lote antes de subir imÃ¡genes
    if (preCreateFn) {
      await preCreateFn(batch);
    }

    // Ahora sÃ­, subir imÃ¡genes en paralelo para este lote
    const batchResults = await Promise.all(batch.map((item, slot) => worker(item, slot + 1)));
    results.push(...batchResults);
  }
  return results;
}

// ===== worker: one chapter with its own browser/context =====
async function workerUpload(job, settings, workerId = 1) {
  const [num, chapterDir] = job;
  return withLogContext({ worker: workerId, chapter: normalizeChapterNumber(num) || num, phase: "upload" }, async () => {
    let browser = null, context = null, page = null;
    try {
      browser = await chromium.launch(getChromiumLaunchOptions());

      const storagePath = settings.storagePath;
      context = await browser.newContext(getContextOptions(storagePath));
      // optional resource blocking like python (keeps attachments/upload)
      await context.route("**/*", (route) => {
        const req = route.request();
        if (req.url().includes("attachments/upload")) return route.continue();
        const rt = req.resourceType();
        if (rt === "image" || rt === "font" || rt === "media") return route.abort();
        return route.continue();
      });

      page = await context.newPage();
      page.setDefaultTimeout(settings.TIMEOUT_MS);

      report(`[INFO] Cap ${num} - Iniciando sesion...`);
      // login only if not already authenticated by storage; if it logs in successfully, do not write storage to avoid races.
      await ensureLogin(page, context);

      const normalizedNum = normalizeChapterNumber(num) || num;
      const alreadyExists = settings.existingChapters && settings.existingChapters.has(normalizedNum);
      if (alreadyExists) {
        report(`[OMITIDO] Cap ${num} - Ya existe en el sitio. Continuando con el siguiente.`);
        await context.close(); await browser.close();
        return { num, status: "skipped" };
      }

      report(`[SUBIENDO] Cap ${num} - ${path.basename(chapterDir)}`);
      const uploadInfo = await processOneChapter(page, settings.CHAPTERS_LIST_URL, settings.RESOURCE_URL, num, chapterDir, settings.QUEUE_UPLOADS);
      if (settings.existingChapters) settings.existingChapters.add(normalizedNum);
      report(`[OK] Cap ${num} - Completado`);

      await page.waitForTimeout(1000);
      await context.close(); await browser.close();
      return { num, status: "ok", chapterId: uploadInfo && uploadInfo.chapterId ? String(uploadInfo.chapterId) : null };
    } catch (e) {
      try { if (page) await snap(page, `99_error_${num}`); } catch {}
      try { if (context) await context.close(); } catch {}
      try { if (browser) await browser.close(); } catch {}
      return { num, status: "error", info: String(e) };
    }
  });
}

// ===== main =====
async function main() {
  const args = parseArgs(process.argv);

  if (!USERNAME || !PASSWORD) {
    console.error(chalk.red("[ERROR] Falta SITE_USERNAME/SITE_PASSWORD en .env."));
    process.exit(1);
  }

  // dynamic inputs like python
  let resourceUrl = args["resource"] || process.env.RESOURCE_URL || "";
  if (!resourceUrl) {
    resourceUrl = await rlQuestion("URL de la obra/recurso (ej. https://animebbg.net/comics/ruri-dragon.4437/): ");
  }
  resourceUrl = resourceUrl.trim();

  let chaptersListUrl = args["chapters-url"] || process.env.CHAPTERS_LIST_URL || "";
  if (!chaptersListUrl) {
    // python derives if empty
    chaptersListUrl = resourceUrl.replace(/\/$/, "") + "/capitulos";
  }

  let rootDir = args["root"] || PROJECT_BASE_DIR || "";
  if (!rootDir) {
    rootDir = await rlQuestion("Ruta local raÃ­z con subcarpetas de capÃ­tulos: ");
  }
  if (isUrl(rootDir)) {
    console.log("[INFO] Detectado enlace. Descargando carpeta de Drive...");
    rootDir = await downloadDriveFolder(rootDir);
  }
  rootDir = path.resolve(rootDir);
  if (!fs.existsSync(rootDir)) {
    console.error(chalk.red(`[ERROR] No existe la ruta: ${rootDir}`));
    process.exit(1);
  }

  const onlyChapters = (args["chapters"] || "").trim();
  const onlyList = onlyChapters ? onlyChapters.split(",").map(s => s.trim()).filter(Boolean) : null;
  const rangeStart = toNumberMaybe(args["start"] || args["from"] || process.env.RANGE_START || "");
  const rangeEnd = toNumberMaybe(args["end"] || args["to"] || process.env.RANGE_END || "");

  const requestedParallel = Math.max(1, parseInt(args["parallel"] || String(DEFAULT_PARALLEL), 10));
  const parallel = 1; // Paralelismo inhabilitado: flujo secuencial fijo.
  const saveRetries = parseInt(args["save-retries"] || String(SAVE_MAX_RETRIES), 10);
  const saveWindow = parseInt(args["save-window"] || String(SAVE_MAX_WINDOW_S), 10);
  const verifyRounds = 0; // Verificacion desactivada por flujo solicitado
  const queueUploads = Boolean(args["queue"]) || QUEUE_UPLOADS;
  const forceReupload = args["force-reupload"] === "1" || args["force-reupload"] === "true" || process.env.FORCE_REUPLOAD === "1";

  console.log(chalk.bold.cyan("\n=== ParÃ¡metros efectivos ==="));
  console.log(chalk.gray(`BASE_URL:          ${BASE_URL}`));
  console.log(chalk.gray(`LOGIN_URL:         ${LOGIN_URL}`));
  console.log(chalk.gray(`RESOURCE_URL:      ${resourceUrl}`));
  console.log(chalk.gray(`CHAPTERS_LIST_URL: ${chaptersListUrl}`));
  console.log(chalk.gray(`ROOT:              ${rootDir}`));
  console.log(chalk.gray(`MAX_PER_CHAPTER:   ${MAX_PER_CHAPTER}`));
  console.log(chalk.gray(`BATCH_UPLOAD_SIZE: ${BATCH_UPLOAD_SIZE}`));
  console.log(chalk.gray(`SLEEP_BETWEEN_MS:  ${SLEEP_BETWEEN_BATCH_MS}`));
  console.log(chalk.gray(`QUEUE_UPLOADS:     ${queueUploads}`));
  console.log(chalk.gray(`SAVE_MAX_RETRIES:  ${saveRetries}`));
  console.log(chalk.gray(`SAVE_MAX_WINDOW_S: ${saveWindow}`));
  console.log(chalk.gray(`USUARIO (login):   ${USERNAME}`));
  console.log(chalk.gray(`PARALELO (forzado): ${parallel}`));
  if (requestedParallel !== 1) {
    console.log(chalk.yellow(`PARALELO solicitado (${requestedParallel}) ignorado: flujo secuencial.`));
  }
  console.log(chalk.gray(`VERIFY_RETRIES:    ${verifyRounds}`));
  if (rangeStart !== null || rangeEnd !== null) {
    console.log(chalk.gray(`RANGO:             ${rangeStart ?? "-"} -> ${rangeEnd ?? "-"}`));
  }
  console.log(chalk.gray(`LOG_DIR:           ${LOG_DIR}`));
  console.log(chalk.gray(`UPLOAD_LOG:        ${LOG_FILES.chapter}`));
  console.log(chalk.gray(`NOTIFY_LOG:        ${LOG_FILES.notify}`));
  console.log(chalk.gray(`SYSTEM_LOG:        ${LOG_FILES.system}`));
  console.log(chalk.bold.cyan("============================\n"));

  await notify(`[INICIO] Subida iniciada para ${resourceUrl}`);

  // discovery stage (single browser) + save cookies once to reduce repeated logins later
  logSystem("[INFO] Iniciando navegador...");
  const browser = await chromium.launch(getChromiumLaunchOptions());
  const storagePath = storageStatePathIfExists();
  const context = await browser.newContext(getContextOptions(storagePath));
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  logSystem("[INFO] Iniciando sesion...");
  await ensureLogin(page, context);
  logSystem("[OK] Sesion iniciada");

  logSystem("[INFO] Detectando capitulos...");
  logSystem("[INFO] Leyendo capitulos existentes en la web (una sola vez)...");
  const existingChapters = await collectExistingChapters(page, chaptersListUrl);
  logSystem(`[INFO] Capitulos existentes detectados en web: ${existingChapters.size}`);
  let jobsList = await planJobs(page, rootDir, chaptersListUrl, onlyList, existingChapters);
  if (rangeStart !== null || rangeEnd !== null) {
    const min = rangeStart !== null ? rangeStart : -Infinity;
    const max = rangeEnd !== null ? rangeEnd : Infinity;
    jobsList = jobsList.filter(([num]) => {
      const n = toNumberMaybe(num);
      return n !== null && n >= min && n <= max;
    });
  }
  jobsList.sort((a, b) => {
    const an = toNumberMaybe(a[0]);
    const bn = toNumberMaybe(b[0]);
    if (an !== null && bn !== null) return an - bn;
    return String(a[0]).localeCompare(String(b[0]), "es", { numeric: true, sensitivity: "base" });
  });

  // ── Modo re-subida forzada: borra páginas y re-sube todos desde cero ──
  if (forceReupload) {
    let reuploadJobs = buildJobsFromRoot(rootDir);
    if (rangeStart !== null || rangeEnd !== null) {
      const min = rangeStart !== null ? rangeStart : -Infinity;
      const max = rangeEnd !== null ? rangeEnd : Infinity;
      reuploadJobs = reuploadJobs.filter(([num]) => {
        const n = toNumberMaybe(num);
        return n !== null && n >= min && n <= max;
      });
    }
    if (onlyList && onlyList.length) {
      const desired = new Set(onlyList.map(r => String(chapterNumberFromText(r) || r)));
      reuploadJobs = reuploadJobs.filter(([num]) => desired.has(String(num)));
    }
    logSystem(`[FORCE-REUPLOAD] ${reuploadJobs.length} capítulo(s) a limpiar y re-subir.`);
    for (const [num, dir] of reuploadJobs) {
      await withLogContext({ worker: "force", chapter: normalizeChapterNumber(num) || num, phase: "reupload" }, async () => {
        try {
          await clearAndReuploadChapter(page, chaptersListUrl, resourceUrl, num, dir);
        } catch (e) {
          report(`[ERROR] Cap ${num}: ${e.message}`);
        }
      });
    }
    await context.close(); await browser.close();
    logSystem("[INFO] Re-subida forzada completada.");
    await notify(`[FIN] Re-subida forzada completada para ${resourceUrl}`);
    return;
  }

  logSystem(`[INFO] Capitulos a procesar: ${jobsList.length}`);
  if (!jobsList.length) {
    logSystem("[WARN] No hay trabajo que hacer.");
    await context.close(); await browser.close();
    return;
  }

  // FunciÃ³n helper para pre-crear un lote de capÃ­tulos
  async function preCreateBatch(batch) {
    const b = await chromium.launch(getChromiumLaunchOptions());
    const c = await b.newContext(getContextOptions(storageStatePathIfExists()));
    const p = await c.newPage();
    p.setDefaultTimeout(TIMEOUT_MS);

    try {
      await ensureLogin(p, c);
      const existing = await collectExistingChapters(p, chaptersListUrl);

      for (const [num, dir] of batch) {
        await withLogContext({ worker: "pre", chapter: normalizeChapterNumber(num) || num, phase: "precreate" }, async () => {
          if (existing.has(normalizeChapterNumber(num) || num)) {
            report(`[OMITIDO] Cap ${num} - Ya existe`);
            return;
          }
          try {
            const chapterText = displayTextFor(num);
            report(`[CREANDO] ${chapterText}...`);
            await openAddChapterOverlay(p, chaptersListUrl, resourceUrl);
            const extra = extractChapterExtraFromFolderName(path.basename(dir || ""));
            await fillOverlayCreateChapter(p, num, extra);
            await p.waitForTimeout(300);
            report(`[OK] ${chapterText} - Pre-creado`);
          } catch (e) {
            report(`[ERROR] Cap ${num} - No se pudo pre-crear: ${e.message}`);
          }
        });
      }
    } finally {
      await c.close();
      await b.close();
    }
  }

  await context.close(); await browser.close();

  // run workers
  const settings = {
    RESOURCE_URL: resourceUrl,
    CHAPTERS_LIST_URL: chaptersListUrl,
    HEADLESS,
    SLOW_MO_MS,
    TIMEOUT_MS,
    SAVE_MAX_RETRIES: saveRetries,
    SAVE_MAX_WINDOW_S: saveWindow,
    storagePath: storageStatePathIfExists(), // load, do not write in workers
    QUEUE_UPLOADS: queueUploads,
    existingChapters,
  };

  logSystem("\n[INFO] Modo secuencial (paralelismo inhabilitado)");
  if (requestedParallel !== 1) {
    logSystem(`[INFO] Se ignora valor de paralelo=${requestedParallel}.`);
  }
  const runResults = [];
  for (const job of jobsList) {
    const res = await workerUpload(job, settings);
    runResults.push(res);
    if (res.status === "error") logSystem(`[ERROR] CapÃ­tulo ${res.num}: ${res.info}`);
    if (res.status === "skipped") logSystem(`[OMITIDO] CapÃ­tulo ${res.num}: ya existÃ­a.`);
  }

  // verify rounds
  for (let round = 1; round <= verifyRounds; round++) {
    logSystem(`\n[INFO] Verificacion ronda ${round}/${verifyRounds}`);
    const b = await chromium.launch(getChromiumLaunchOptions());
    const c = await b.newContext(getContextOptions(storageStatePathIfExists()));
    const p = await c.newPage();
    p.setDefaultTimeout(TIMEOUT_MS);
    await ensureLogin(p, c);
    const missing = await findMissingWork(p, chaptersListUrl, jobsList);
    if (!missing.length) {
      logSystem("[OK] Todo verificado correctamente");
      await c.close(); await b.close();
      break;
    }
    for (const [num, dir, shouldRepair, currentCount] of missing) {
      await withLogContext({ worker: "verify", chapter: normalizeChapterNumber(num) || num, phase: "verify" }, async () => {
        try {
          if (shouldRepair) {
            report(`[REPARANDO] Cap ${num}: ${path.basename(dir)} (${currentCount} imagenes presentes)`);
            await repairChapterImages(p, chaptersListUrl, num, dir, currentCount);
          } else {
            report(`[REINTENTO] Re-subiendo cap ${num}: ${path.basename(dir)}`);
            await processOneChapter(p, chaptersListUrl, resourceUrl, num, dir, queueUploads);
          }
        } catch (e) {
          report(`[ERROR] Cap ${num}: ${e}`);
        }
      });
    }
    await c.close(); await b.close();
  }

  logSystem("\n[INFO] Proceso finalizado");
  await notify(buildFinalNotifyMessage(resourceUrl, chaptersListUrl, runResults));
}

main().catch(async (e) => {
  const errMsg = `[ERROR] Excepciï¿½n no controlada: ${e && e.message ? e.message : String(e)}`;
  logSystem(errMsg);
  await notify(errMsg);
  process.exit(1);
});


























