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

const TOAST_ERROR_TEXTS = [
  "Oops! Nos hemos encontrado con algunos problemas",
  "El servidor no responde en tiempo",
  "inténtalo otra vez",
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
  } catch (e) { dbg(`Error obteniendo capítulos vía API: ${e}`); return []; }
}

async function getChapterDetailsViaApi(chapterId) {
  try { return await apiRequest(`resource-manager/resource-updates/${chapterId}`); }
  catch (e) { dbg(`Error obteniendo detalles de capítulo vía API: ${e}`); return null; }
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
  } catch (e) { dbg(`Error verificando imágenes vía API: ${e}`); return -1; }
}

// ===== helpers =====
async function go(page, url, fast=true) {
  await page.goto(url, { waitUntil: fast ? "domcontentloaded" : "load" });
}

const CAP_ANY = /(\d+(?:[.,]\d+)?)/g;

function chapterNumberFromText(text) {
  let m = null, last = null;
  while ((m = CAP_ANY.exec(text)) !== null) last = m;
  if (!last) return null;
  const raw = last[1].replace(",", ".");
  const f = Number(raw);
  if (!Number.isNaN(f)) {
    if (Number.isInteger(f)) return String(parseInt(f,10));
    return String(f).replace(/0+$/,"").replace(/\.$/,"");
  }
  return raw;
}

function chapterNumberFromFolderName(name) {
  const original = String(name || "").trim();
  const normalized = normalizeTextLoose(original);

  // Prioridad: "Capitulo 34", "Cap 34", etc.
  const byCap = normalized.match(/\bcap(?:itulo)?\s*([0-9]+(?:[.,][0-9]+)?)\b/i);
  if (byCap) return normalizeChapterNumber(byCap[1]);

  // Si no hay prefijo de capítulo, usar el primer número del nombre.
  const firstNum = original.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (firstNum) return normalizeChapterNumber(firstNum[1]);

  return null;
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
    if (String(num).includes(".")) return `Capítulo ${Number(num).toFixed(2)}`;
    return `Capítulo ${Number.parseInt(num,10).toFixed(2)}`;
  } catch { return `Capítulo ${num}`; }
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
  if (await form.count() === 0) throw new Error("No encontré el formulario de login.");

  const user = form.locator("input[name=login], #login, input[type=text]").first();
  const pw = form.locator("input[name=password], #password, input[type=password]").first();
  if ((await user.count()) === 0 || (await pw.count()) === 0) throw new Error("No encontré campos de login/password.");

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

  if (!(await isLogged())) throw new Error("Sigo en login tras enviar (¿captcha/Cloudflare?).");

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
  const t0 = Date.now();
  const stepText = normalizeTextLoose(`paso ${stepNum}`);
  while (Date.now() - t0 < timeoutMs) {
    try {
      const body = normalizeTextLoose(await page.locator("body").innerText());
      if (body.includes(stepText)) return true;
      if (stepNum === 3 && body.includes("carga de paginas")) return true;
      if (stepNum === 4 && body.includes("confirmacion")) return true;
    } catch {}
    await page.waitForTimeout(250);
  }
  return false;
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

async function fillOverlayCreateChapter(page, chapterNumber) {
  const chapterValue = String(chapterNumber).trim();
  if (!(await isStepperWizardPage(page))) {
    throw new Error("No se detecto el stepper de capitulos.");
  }

  const inStep1 = await waitForStepperStep(page, 1, 10000);
  if (!inStep1) throw new Error("No se detecto Paso 1 (Contexto) en el Stepper.");

  await fillStepperChapterNumber(page, chapterValue);
  await page.waitForTimeout(250);

  const next1 = await clickVisibleButtonByText(page, /^\s*Siguiente\s*$/i, 10000);
  if (!next1) throw new Error("No se pudo avanzar de Paso 1 a Paso 2 en Stepper.");

  const inStep2 = await waitForStepperStep(page, 2, 15000);
  if (!inStep2) throw new Error("No se detecto Paso 2 (Programacion) en Stepper.");

  const next2 = await clickVisibleButtonByText(page, /^\s*Siguiente\s*$/i, 10000);
  if (!next2) throw new Error("No se pudo avanzar de Paso 2 a Paso 3 en Stepper.");

  const inStep3 = await waitForStepperStep(page, 3, 15000);
  if (!inStep3) throw new Error("No se detecto Paso 3 (Paginas) en Stepper.");

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
    report(`[DEBUG] Buscando '${chapterText}' entre ${total} cap�tulos en la p�gina`);
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

  // Fallback universal: si cambi� el layout/clases, revisar todos los enlaces candidatos.
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
  } catch {}
  return false;
}



async function navigateToChapterById(page, chapterId) {
  try {
    const url = `${BASE_URL.replace(/\/$/, "")}/comics/capitulo/link/${chapterId}/`;
    dbg(`Navegando directo a cap�tulo ID ${chapterId}: ${url}`);
    await go(page, url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    return true;
  } catch (e) {
    dbg(`Error navegando a cap�tulo ID ${chapterId}: ${e}`);
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
    dbg(`Fallback API para abrir cap�tulo fall�: ${e}`);
  }

  return { ok: false, chapterId: null };
}
async function verifyChapterNumberOnPage(page, expectedNumber) {
  const target = normalizeChapterNumber(expectedNumber);
  if (target === null) return false;

  const expectedText = normalizeTextLoose(`Cap�tulo ${Number(target).toFixed(2)}`);
  const capWord = /cap(?:i|�)tulo/i;

  try {
    const currentUrl = String(page.url() || "");
    if (currentUrl.includes("/comics/capitulo/link/")) {
      // Estamos dentro de una vista de cap�tulo; validamos por contenido de p�gina.
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
    const rx = new RegExp(`cap(?:i|�)tulo\\s*${targetEscaped}(?:\\.00)?`, "i");
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

    // Sitio actual: el cap�tulo m�s reciente aparece primero en /capitulos (p�gina 1).
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
            report(`  [WARN] Validaci�n por texto fall�, pero se detect� ID ${chapterId}. Forzando navegaci�n directa...`);
            const directOk = await navigateToChapterById(page, chapterId);
            if (directOk) {
              await page.waitForTimeout(400);
              await snap(page, "22_opened_chapter_by_id_fallback");
              return { ok: true, chapterId };
            }
            report(`  [WARN] No se pudo navegar por ID ${chapterId}; contin�o con ese ID para no perder el flujo.`);
            return { ok: true, chapterId };
          }
          dbg(`ADVERTENCIA: Abrimos un cap�tulo pero no coincide con ${expectedNumber}`);
          continue;
        }

        await snap(page, "22_opened_chapter_by_text");
        if (pageNum !== 1) report(`  [INFO] Encontrado en p�gina ${pageNum}`);
        return { ok: true, chapterId };
      }
    }
  }

  report(`[ERROR] No se pudo encontrar ${chapterText} despu�s de ${maxRetries} intentos`);
  return { ok: false, chapterId: null };
}
// ===== count images =====
async function countUploadedImages(page) {
  try {
    let count = 0;
    const cardsByState = page.locator("text=/\b(En cola|Listo|Subiendo|Optimizado|Optimizando)\b/i");
    count = Math.max(count, await cardsByState.count());

    const filesByName = page.locator("text=/\.(webp|jpg|jpeg|png)\b/i");
    count = Math.max(count, await filesByName.count());

    const progress = await readUploadProgress(page);
    if (progress.total > 0) count = Math.max(count, progress.total);
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
    dbg(`Imágenes ya guardadas detectadas (unique): ${unique.size}`);
    return unique.size;
  } catch (e) {
    dbg(`Error contando imágenes guardadas: ${e}`);
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
      dbg(`Verificación API ${chapterText}: ${apiCount} imágenes (esperadas: ${expectedCount})`);
      if (apiCount === 0) { report(`[API-ERROR] ${chapterText} NO TIENE IMÁGENES según API!`); return false; }
      if (apiCount < expectedCount * 0.8) { report(`[API-WARN] ${chapterText} tiene solo ${apiCount}/${expectedCount} imágenes según API`); return false; }
      report(`[API-OK] ${chapterText} verificado vía API: ${apiCount} imágenes`);
      return true;
    }
  }

  try {
    const { ok } = await openChapterFromList(page, chaptersListUrl, chapterText, null, 2);
    if (!ok) return false;
    await page.waitForTimeout(1000);
    const count = await countSavedImagesAccurate(page, { scroll: true });
    dbg(`Verificación web ${chapterText}: encontradas ${count} imágenes (esperadas: ${expectedCount})`);
    if (count === 0) { report(`[WEB-ERROR] ${chapterText} NO TIENE IMÁGENES después de guardar!`); return false; }
    if (count < expectedCount * 0.8) { report(`[WEB-WARN] ${chapterText} tiene solo ${count} imágenes (esperadas: ${expectedCount})`); return false; }
    report(`[WEB-OK] ${chapterText} verificado vía web: ${count} imágenes`);
    return true;
  } catch (e) {
    dbg(`Error verificando ${chapterText}: ${e}`);
    return false;
  }
}

// ===== upload =====
async function clickSubirImagenes(page) {
  await snap(page, "30_pre_upload_button");
  const btn = page.locator("a,button").filter({ hasText: /Gestionar p[a\u00e1]ginas|Cargar gestor/i });
  const count = await btn.count();
  for (let i = 0; i < count; i++) {
    const b = btn.nth(i);
    try {
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
      await b.scrollIntoViewIfNeeded();
      await b.click({ force: true, timeout: 3000 });
      await page.waitForTimeout(400);
      return true;
    } catch {}
  }
  throw new Error("No se encontro el boton 'Gestionar paginas'.");
}

async function openUploadArea(page) {
  try {
    await page.waitForSelector("input[type='file']", { state: "attached", timeout: 2000 });
    return;
  } catch {}

  const drop = page.locator("a,button,div,label,span").filter({ hasText: /Suelta\s+im[a\u00e1]genes\s+aqu[i\u00ed]/i });
  if ((await drop.count()) > 0) {
    try {
      await drop.first().scrollIntoViewIfNeeded();
      await drop.first().click({ force: true, timeout: 3000 });
    } catch {}
    await page.waitForSelector("input[type='file']", { state: "attached", timeout: 7000 });
    return;
  }

  throw new Error("No se encontro la zona de subida del stepper.");
}

async function locateFileInput(page) {
  const candidates = [
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

async function waitUploadsComplete(page, expected, maxWaitMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const progress = await readUploadProgress(page);
    const enoughByRatio = progress.total >= expected && progress.done >= expected;
    // En el stepper nuevo, puede reportar "Listo/100%" aunque el ratio no
    // coincida exactamente con expected (por filtros/procesamiento interno).
    const enoughByReady = progress.isReady && (progress.total > 0 || progress.done > 0);
    if (enoughByRatio || enoughByReady) return;

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

async function uploadImagesInBatches(page, files, batchSize = BATCH_UPLOAD_SIZE, queueUploads = false) {
  if (!files.length) return;
  await waitIfPaused();
  const already = await countUploadedImages(page);
  report(`  [INFO] Iniciando subida de ${files.length} imagenes (ya subidas: ${already})`);

  const finput = await locateFileInput(page);
  try {
    await page.locator(finput).first().evaluate((el) => {
      el.removeAttribute("hidden");
      el.style.display = "block";
      el.style.visibility = "visible";
      el.classList.remove("is-hidden");
    });
  } catch {}

  // Flujo Stepper actual: seleccionar todas las imágenes del capítulo de una sola vez.
  report(`  - Seleccionando todas las imagenes del capitulo (${files.length} archivos)`);
  await page.setInputFiles(finput, files);

  // En este uploader el total puede no reflejarse hasta marcar politica/subir ahora.
  await page.waitForTimeout(1200);
}

async function ensureUploadConfirmationChecked(page) {
  // Selector específico del uploader actual.
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
      if (!t.includes("al subir") || !t.includes("confirmo")) continue;

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
  return clickVisibleButtonByText(page, /^\s*Siguiente\s*$/i, timeoutMs);
}

async function waitSubirAhoraEnabled(page, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const btn = page.locator("button, a, input[type='button'], input[type='submit']").filter({ hasText: /Subir\s+ahora/i }).first();
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
    const btn = page.locator("button, a, input[type='button'], input[type='submit']").filter({ hasText: /Subir\s+ahora/i });
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

async function publishFromStepper(page, chaptersListUrl, expectedCount) {
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
  await waitUploadsComplete(page, expectedCount, progressDeadline);

  const next = await clickStepperNext(page, 15000);
  if (!next) throw new Error("No se pudo avanzar desde Paso 3 a Paso 4.");

  const step4 = await waitForStepperStep(page, 4, 20000);
  if (!step4) throw new Error("No se detecto Paso 4 (Confirmacion).");

  const publish = await clickVisibleButtonByText(page, /Confirmar\s+y\s+publicar/i, 15000);
  if (!publish) throw new Error("No se encontro el boton 'Confirmar y publicar'.");

  await page.waitForLoadState("domcontentloaded");
  try {
    await page.waitForURL(/\/capitulos\/?(?:\?|$)/i, { timeout: progressDeadline });
  } catch {
    const t0 = Date.now();
    while (Date.now() - t0 < progressDeadline) {
      const cur = String(page.url() || "").toLowerCase();
      if (cur.includes("/capitulos")) return true;
      await page.waitForTimeout(500);
    }
    throw new Error("No regreso a /capitulos tras 'Confirmar y publicar'.");
  }

  return true;
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

    // Fallback para layouts donde el título no está en anchors clickeables.
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
      else report(`[OMITIDO] No encontré carpeta para capítulo '${r}' en ${rootDir}`);
    }
    return desired;
  }
  // Optimización: consultar existentes una vez y planear solo faltantes.
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

  const partFiles = images.slice();
  const expectedTotal = partFiles.length;
  report(`[INFO] Procesando ${path.basename(chapterDir)}: ${expectedTotal} imagenes`);

  const chapterText = displayTextFor(chapterNumber);
  let chapterId = null;

  await enqueueChapterCreation(async () => {
    report(`[NUEVO] Creando ${chapterText}...`);
    await openAddChapterOverlay(page, chaptersListUrl, resourceUrl);
    await fillOverlayCreateChapter(page, chapterNumber);
    await page.waitForTimeout(800);

    if (!(await isChapterUploadFormPage(page))) {
      throw new Error(`Tras crear ${chapterText}, no quedamos en Paso 3 (Paginas).`);
    }

    chapterId = getCurrentChapterIdFromUrl(page.url());
    report(`[NUEVO] ${chapterText} creado y listo para subir (ID: ${chapterId || "N/A"})`);
  });

  report(`[SUBIENDO] ${chapterText} (ID: ${chapterId || "N/A"}): iniciando subida de ${partFiles.length} imagenes...`);
  await clickSubirImagenes(page);
  await openUploadArea(page);
  await uploadImagesInBatches(page, partFiles, BATCH_UPLOAD_SIZE, queueUploads);

  await publishFromStepper(page, chaptersListUrl, expectedTotal);
  report(`[OK] ${chapterText} (ID: ${chapterId || "N/A"}): publicado en stepper`);
  return { chapterId };
}

// ===== verify and resubmit (simple, sequential) =====
async function findMissingWork(page, chaptersListUrl, jobsList) {
  const missing = [];
  const existing = await collectExistingChapters(page, chaptersListUrl);
  for (const [num, dir] of jobsList) {
    const imgs = listImages(dir);
    if (!imgs.length) continue;
    if (!existing.has(num)) { missing.push([num, dir]); continue; }

    // verify count heuristic: open chapter and count; if <80% expected, mark
    try {
      const chapterText = displayTextFor(num);
      const opened = await openChapterFromList(page, chaptersListUrl, chapterText, null, 2);
      if (!opened.ok) { missing.push([num, dir]); continue; }
      const actual = await countSavedImagesAccurate(page, { scroll: true });
      if (actual < imgs.length * 0.8) {
        report(`  [INFO] ${chapterText} tiene ${actual}/${imgs.length} imágenes, marcando para re-subida`);
        missing.push([num, dir]);
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
// capítulos se creen en orden ascendente (lote 1→2→3, luego 4→5→6, etc.)
async function runPoolSequentialBatches(items, parallel, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += parallel) {
    const batch = items.slice(i, i + parallel);
    const batchResults = await Promise.all(batch.map((item, slot) => worker(item, slot + 1)));
    results.push(...batchResults);
  }
  return results;
}

// Lotes secuenciales con pre-creación por lote: pre-crea solo los capítulos del lote actual
// antes de procesarlos, minimizando la cantidad de capítulos vacíos visibles a la vez.
async function runPoolSequentialBatchesWithPreCreate(items, parallel, worker, preCreateFn) {
  const results = [];
  for (let i = 0; i < items.length; i += parallel) {
    const batch = items.slice(i, i + parallel);

    // Pre-crear solo los capítulos de este lote antes de subir imágenes
    if (preCreateFn) {
      await preCreateFn(batch);
    }

    // Ahora sí, subir imágenes en paralelo para este lote
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
    rootDir = await rlQuestion("Ruta local raíz con subcarpetas de capítulos: ");
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

  console.log(chalk.bold.cyan("\n=== Parámetros efectivos ==="));
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

  logSystem(`[INFO] Capitulos a procesar: ${jobsList.length}`);
  if (!jobsList.length) {
    logSystem("[WARN] No hay trabajo que hacer.");
    await context.close(); await browser.close();
    return;
  }

  // Función helper para pre-crear un lote de capítulos
  async function preCreateBatch(batch) {
    const b = await chromium.launch(getChromiumLaunchOptions());
    const c = await b.newContext(getContextOptions(storageStatePathIfExists()));
    const p = await c.newPage();
    p.setDefaultTimeout(TIMEOUT_MS);

    try {
      await ensureLogin(p, c);
      const existing = await collectExistingChapters(p, chaptersListUrl);

      for (const [num] of batch) {
        await withLogContext({ worker: "pre", chapter: normalizeChapterNumber(num) || num, phase: "precreate" }, async () => {
          if (existing.has(normalizeChapterNumber(num) || num)) {
            report(`[OMITIDO] Cap ${num} - Ya existe`);
            return;
          }
          try {
            const chapterText = displayTextFor(num);
            report(`[CREANDO] ${chapterText}...`);
            await openAddChapterOverlay(p, chaptersListUrl, resourceUrl);
            await fillOverlayCreateChapter(p, num);
            await p.waitForTimeout(1500);
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
    if (res.status === "error") logSystem(`[ERROR] Capítulo ${res.num}: ${res.info}`);
    if (res.status === "skipped") logSystem(`[OMITIDO] Capítulo ${res.num}: ya existía.`);
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
    for (const [num, dir] of missing) {
      await withLogContext({ worker: "verify", chapter: normalizeChapterNumber(num) || num, phase: "verify" }, async () => {
        try {
          report(`[REINTENTO] Re-subiendo cap ${num}: ${path.basename(dir)}`);
          await processOneChapter(p, chaptersListUrl, resourceUrl, num, dir, queueUploads);
        } catch (e) {
          report(`[ERROR] Re-subiendo cap ${num}: ${e}`);
        }
      });
    }
    await c.close(); await b.close();
  }

  logSystem("\n[INFO] Proceso finalizado");
  await notify(buildFinalNotifyMessage(resourceUrl, chaptersListUrl, runResults));
}

main().catch(async (e) => {
  const errMsg = `[ERROR] Excepci�n no controlada: ${e && e.message ? e.message : String(e)}`;
  logSystem(errMsg);
  await notify(errMsg);
  process.exit(1);
});

























