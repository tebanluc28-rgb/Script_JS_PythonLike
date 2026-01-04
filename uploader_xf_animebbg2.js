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
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config({ override: true });

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

const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() === "true";
const SLOW_MO_MS = parseInt(process.env.SLOW_MO_MS || "0", 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "30000", 10);
const STORAGE_STATE = process.env.STORAGE_STATE || "cookies.json";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

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

const CHAPTER_ANCHOR = ".structItem--resourceAlbum .structItem-title a[href*='/comics/capitulo/link/']";

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

function dbg(msg) { if (DEBUG) console.log(`[DEBUG] ${msg}`); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

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

async function notify(msg) {
  console.log(msg);
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
        await notify(`[API] Rate limit, esperando ${wait}s...`);
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

  let btn = page.locator("a.button.button--cta:has-text('+ Capítulo')");
  if ((await btn.count()) === 0) {
    btn = page.locator("a,button").filter({ hasText: /^\s*\+\s*Cap[íi]tulo\s*$/i });
  }

  for (let attempt=1; attempt<=3; attempt++) {
    try {
      if ((await btn.count()) > 0) {
        try { await btn.first().scrollIntoViewIfNeeded(); } catch {}
        await btn.first().click({ timeout: 3000 });
        await page.waitForSelector(".overlay, .overlay[role='dialog'], .modal, .dialog", { timeout: 12000, state: "visible" });
        await snap(page, `11_overlay_by_button_try${attempt}`);
        return;
      }
    } catch (e) { dbg(`[overlay] intento ${attempt} sin éxito: ${e}`); }
    await page.waitForTimeout(600);
  }

  const addUrl = resourceUrl.replace(/\/$/, "") + "/capitulos/add";
  await go(page, addUrl);
  await page.waitForLoadState("domcontentloaded");
  try {
    await page.waitForSelector(".overlay, .overlay[role='dialog'], .modal, .dialog", { timeout: 6000, state: "visible" });
    await snap(page, "12_overlay_by_url");
  } catch {
    await snap(page, "12_no_overlay_fullpage");
  }
}

async function detectCategoryFromBreadcrumb(page) {
  try {
    const txts = await page.locator(".p-breadcrumbs, .breadcrumb, .p-breadcrumbs--parent").allInnerTexts();
    const txt = txts.join(" ");
    for (const cat of ["Manhwa","Manga","Manhua"]) {
      if (new RegExp(`\\b${cat}\\b`, "i").test(txt)) return cat;
    }
  } catch {}
  return "Manhwa";
}

async function fillOverlayCreateChapter(page, chapterNumber) {
  const root = await getOverlayOrRoot(page);

  try {
    await root.evaluate((rootEl) => {
      const ra = rootEl.querySelector("input[type=radio][name='ozzmodz_xfrmra_action'][value='create']");
      if (ra) { ra.checked = true; ra.dispatchEvent(new Event("change", { bubbles: true })); }
      const dep = rootEl.querySelector(".inputChoices-dependencies");
      if (dep) dep.classList?.remove?.("is-disabled");
      const sel = rootEl.querySelector("select[name='ozzmodz_xfrmra_category_id']");
      const cap = rootEl.querySelector("input[name='ozzmodz_xfrmrac_chapter'], input[name='chapter'], input[name='ozzmodz_xfrmrac_chapter_number']");
      if (sel) sel.disabled = false;
      if (cap) cap.disabled = false;
    });
  } catch {}

  const catSel = root.locator("select[name=ozzmodz_xfrmra_category_id]").first();
  const chapInput = root.locator("input[name='ozzmodz_xfrmrac_chapter'], input[name='chapter'], input[name='ozzmodz_xfrmrac_chapter_number']").first();

  if ((await chapInput.count()) === 0) throw new Error("No se encontró el campo del número de capítulo.");

  try {
    if ((await catSel.count()) > 0) {
      const catLabel = await detectCategoryFromBreadcrumb(page);
      try { await catSel.selectOption({ label: catLabel }); } catch {}
    }
  } catch {}

  await chapInput.fill(String(chapterNumber).trim());

  const confirmBtn = root.locator("button:has-text('Confirmar'), input[type=submit][value='Confirmar']").first();
  if ((await confirmBtn.count()) > 0) {
    try { await confirmBtn.click({ force: true }); }
    catch { await chapInput.press("Enter"); }
  } else {
    await chapInput.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded");
  await snap(page, "20_after_confirmar_overlay_or_page");

  try {
    const overlay = page.locator(".overlay[role='dialog'], .overlay, .modal, .dialog").first();
    if ((await overlay.count()) > 0) {
      await overlay.locator(".js-overlayClose, .overlay-close, [aria-label='Cerrar']").first().click({ timeout: 800 });
    }
  } catch {}
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

async function findChapterLinkInPage(page, chapterText) {
  const items = page.locator(CHAPTER_ANCHOR);
  const total = await items.count();

  if (DEBUG && total > 0 && total <= 10) {
    await notify(`[DEBUG] Buscando '${chapterText}' entre ${total} capítulos en la página`);
    for (let i=0; i<total; i++) {
      const t = (await items.nth(i).innerText()).trim();
      await notify(`[DEBUG]   [${i}] '${t}'`);
    }
  }

  for (let i=0; i<total; i++) {
    const t = (await items.nth(i).innerText()).trim();
    if (t === chapterText) return items.nth(i);
  }
  for (let i=0; i<total; i++) {
    const t = (await items.nth(i).innerText()).trim();
    if (t.includes(chapterText)) return items.nth(i);
  }
  return null;
}

function getCurrentChapterIdFromUrl(url) {
  const m = url.match(/\/comics\/capitulo\/link\/(\d+)\//);
  if (m) return m[1];
  const m2 = url.match(/\/capitulo[s]?\/(\d+)/);
  return m2 ? m2[1] : null;
}

async function verifyChapterNumberOnPage(page, expectedNumber) {
  try {
    const title = (await page.title()).toLowerCase();
    const expectedText = displayTextFor(expectedNumber).toLowerCase();
    if (title.includes(expectedText)) return true;

    const headers = await page.locator("h1, h2, .p-title, .p-breadcrumbs").allInnerTexts();
    if (headers.some(h => h.toLowerCase().includes(expectedText))) return true;

    const content = page.locator(".message-body, .block-body, .p-body-content").first();
    if ((await content.count()) > 0) {
      const txt = (await content.innerText()).toLowerCase();
      if (txt.slice(0,200).includes(expectedText)) return true;
    }
  } catch (e) { dbg(`Error verificando número de capítulo: ${e}`); }
  return false;
}

async function navigateToChapterById(page, chapterId) {
  try {
    const url = `${BASE_URL.replace(/\/$/, "")}/comics/capitulo/link/${chapterId}/`;
    dbg(`Navegando directo a capítulo ID ${chapterId}: ${url}`);
    await go(page, url);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    return true;
  } catch (e) { dbg(`Error navegando a capítulo ID ${chapterId}: ${e}`); return false; }
}

async function openChapterFromList(page, chaptersListUrl, chapterText, expectedNumber=null, maxRetries=3) {
  for (let attempt=0; attempt<maxRetries; attempt++) {
    if (attempt > 0) {
      await notify(`  [REINTENTO ${attempt}/${maxRetries-1}] Buscando ${chapterText}...`);
      await page.waitForTimeout(2000);
    }
    await go(page, chaptersListUrl);
    const lastPage = await getLastPageNumberFast(page);
    const url = (lastPage === 1) ? chaptersListUrl : `${chaptersListUrl}?page=${lastPage}`;
    await go(page, url);
    await snap(page, `21_list_last_${lastPage}_attempt_${attempt}`);

    let link = await findChapterLinkInPage(page, chapterText);
    if (link) {
      await link.click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(500);
      const chapterId = getCurrentChapterIdFromUrl(page.url());
      if (expectedNumber && !(await verifyChapterNumberOnPage(page, expectedNumber))) {
        dbg(`ADVERTENCIA: Abrimos un capítulo pero no coincide con ${expectedNumber}`);
      } else {
        await snap(page, "22_opened_chapter_by_text");
        return { ok: true, chapterId };
      }
    }

    if (lastPage > 1) {
      await notify("  [INFO] No encontrado en última página, buscando en páginas anteriores...");
      for (let pageNum = lastPage-1; pageNum >= 1; pageNum--) {
        const u = `${chaptersListUrl}?page=${pageNum}`;
        await go(page, u);
        link = await findChapterLinkInPage(page, chapterText);
        if (link) {
          await link.click();
          await page.waitForLoadState("domcontentloaded");
          await page.waitForTimeout(500);
          const chapterId = getCurrentChapterIdFromUrl(page.url());
          if (expectedNumber && !(await verifyChapterNumberOnPage(page, expectedNumber))) {
            dbg(`ADVERTENCIA: Abrimos un capítulo pero no coincide con ${expectedNumber}`);
            break;
          }
          await snap(page, "22_opened_chapter_by_text");
          await notify(`  [INFO] Encontrado en página ${pageNum}`);
          return { ok: true, chapterId };
        }
      }
    }
  }
  await notify(`[ERROR] No se pudo encontrar ${chapterText} después de ${maxRetries} intentos`);
  return { ok: false, chapterId: null };
}

// ===== count images =====
async function countUploadedImages(page) {
  try {
    const deletes = page.locator("button:has-text('Eliminar')");
    return await deletes.count();
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

async function verifyChapterImages(page, chaptersListUrl, chapterText, expectedCount, chapterId) {
  if (XENFORO_API_KEY && chapterId) {
    const apiCount = await verifyChapterImagesViaApi(chapterId);
    if (apiCount >= 0) {
      dbg(`Verificación API ${chapterText}: ${apiCount} imágenes (esperadas: ${expectedCount})`);
      if (apiCount === 0) { await notify(`[API-ERROR] ${chapterText} NO TIENE IMÁGENES según API!`); return false; }
      if (apiCount < expectedCount * 0.8) { await notify(`[API-WARN] ${chapterText} tiene solo ${apiCount}/${expectedCount} imágenes según API`); return false; }
      await notify(`[API-OK] ${chapterText} verificado vía API: ${apiCount} imágenes`);
      return true;
    }
  }

  try {
    const { ok } = await openChapterFromList(page, chaptersListUrl, chapterText, null, 2);
    if (!ok) return false;
    await page.waitForTimeout(1000);
    const count = await countSavedImages(page);
    dbg(`Verificación web ${chapterText}: encontradas ${count} imágenes (esperadas: ${expectedCount})`);
    if (count === 0) { await notify(`[WEB-ERROR] ${chapterText} NO TIENE IMÁGENES después de guardar!`); return false; }
    if (count < expectedCount * 0.8) { await notify(`[WEB-WARN] ${chapterText} tiene solo ${count} imágenes (esperadas: ${expectedCount})`); return false; }
    await notify(`[WEB-OK] ${chapterText} verificado vía web: ${count} imágenes`);
    return true;
  } catch (e) {
    dbg(`Error verificando ${chapterText}: ${e}`);
    return false;
  }
}

// ===== upload =====
async function clickSubirImagenes(page) {
  await snap(page, "30_pre_upload_button");
  let btn = page.locator("a.button, button.button").filter({ hasText: /Subir imágenes|Subir imagenes/i });
  if ((await btn.count()) === 0) {
    btn = page.getByRole("button", { name: /Subir imágenes|Subir imagenes/i });
  }
  if ((await btn.count()) > 0) {
    try { await btn.first().scrollIntoViewIfNeeded(); } catch {}
    try {
      await btn.first().click({ force: true, timeout: 3000 });
      await page.waitForLoadState("domcontentloaded");
      return true;
    } catch {}
  }
  return true; // fallback like python
}

async function openUploadArea(page) {
  try {
    await page.waitForSelector("input[type='file']", { state: "attached", timeout: 2000 });
    return;
  } catch {}

  const up = page.locator("a,button,label,div").filter({ hasText: /Upload file/i });
  if ((await up.count()) > 0) {
    try { await up.first().scrollIntoViewIfNeeded(); } catch {}
    try {
      await up.first().click({ force: true });
      await page.waitForSelector("input[type='file']", { state: "attached", timeout: 6000 });
      return;
    } catch {}
  }

  const link = page.locator("a[href*='attachments/upload']");
  if ((await link.count()) > 0) {
    let href = await link.first().getAttribute("href");
    if (href) {
      if (!href.startsWith("http")) href = BASE_URL.replace(/\/$/, "") + href;
      await go(page, href);
      await page.waitForSelector("input[type='file']", { state: "attached", timeout: 6000 });
      return;
    }
  }

  await page.waitForSelector("input[type='file']", { state: "attached", timeout: 8000 });
  await snap(page, "31_upload_area");
}

async function locateFileInput(page) {
  const candidates = [
    "input[type=file][multiple]",
    "input[type=file][name=upload]",
    "input[type=file][name='files[]']",
    "input[type=file]",
  ];
  for (const s of candidates) {
    try {
      if ((await page.locator(s).first().count()) > 0) return s;
    } catch {}
  }
  throw new Error("No se encontró input[type=file] para subir imágenes.");
}

async function waitUploadsComplete(page, expected, maxWaitMs=180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const active = page.locator(".is-uploading, .isPending, .is-processing");
      if ((await active.count()) > 0) { await page.waitForTimeout(300); continue; }

      const deletes = page.locator("button:has-text('Eliminar')");
      if ((await deletes.count()) >= expected) return;
    } catch {}
    await page.waitForTimeout(300);
  }
  throw new Error(`Las subidas no finalizaron a tiempo (esperaba ${expected} imágenes).`);
}

async function uploadImagesInBatches(page, files, batchSize=BATCH_UPLOAD_SIZE) {
  if (!files.length) return;
  const already = await countUploadedImages(page);
  await notify(`  [INFO] Iniciando subida de ${files.length} imágenes (ya subidas: ${already})`);

  const finput = await locateFileInput(page);
  try {
    await page.locator(finput).first().evaluate(el => {
      el.removeAttribute("hidden");
      el.style.display = "block";
      el.style.visibility = "visible";
      el.classList.remove("is-hidden");
    });
  } catch {}

  let done = already;
  const totalBatches = Math.ceil(files.length / batchSize);
  for (let i=0; i<files.length; i += batchSize) {
    const batch = files.slice(i, i+batchSize);
    await notify(`  · Subiendo lote ${Math.floor(i/batchSize)+1}/${totalBatches} (${batch.length} archivos)`);
    await page.setInputFiles(finput, batch);
    await waitUploadsComplete(page, done + batch.length, Math.max(180000, TIMEOUT_MS));
    done += batch.length;
    await page.waitForTimeout(SLEEP_BETWEEN_BATCH_MS);
  }
}

async function clickGuardar(page) {
  await snap(page, "33_before_guardar");
  let save = page.locator("button.button--primary:has-text('Guardar')");
  if ((await save.count()) === 0) save = page.locator("button:has-text('Guardar'), input[type=submit][value='Guardar']").first();
  await save.first().click();

  try {
    await page.waitForURL(/\/libreria\//, { timeout: TIMEOUT_MS });
  } catch {
    await page.waitForLoadState("domcontentloaded");
  }
  try { await page.waitForSelector("img", { state: "attached", timeout: 10000 }); } catch {}
  await snap(page, "34_after_guardar");
}

async function guardarWithRetry(page, maxAttempts, maxTotalWaitS) {
  const t0 = Date.now();
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    dbg(`Guardar intento ${attempt}/${maxAttempts}`);
    try { await clickGuardar(page); }
    catch (e) { dbg(`click_guardar lanzó excepción: ${e}`); }

    await page.waitForTimeout(1500);

    if (page.url().includes("/libreria/")) {
      dbg("Guardar exitoso: navegó a /libreria/");
      return true;
    }

    // Success message
    try {
      const okMsg = page.locator("div.flashMessage--success, div.blockMessage--success");
      if ((await okMsg.count()) > 0) return true;
    } catch {}

    if (await hasTimeoutToast(page)) {
      await notify(`[AVISO] Guardar falló (timeout/Cloudflare). Reintentando… (${attempt}/${maxAttempts})`);
      await dismissToastIfAny(page);

      const elapsedS = (Date.now() - t0) / 1000;
      if (elapsedS >= maxTotalWaitS) return false;

      const backoff = Math.min(8, Math.max(1, 2 ** attempt));
      await page.waitForTimeout(backoff * 1000);
      continue;
    }

    // If not clearly success nor clear toast, treat as uncertain and retry within window
    const elapsedS = (Date.now() - t0) / 1000;
    if (elapsedS >= maxTotalWaitS) return false;
    await page.waitForTimeout(Math.min(8000, 1000 * (2 ** attempt)));
  }
  return false;
}

// ===== existing chapters scanning =====
function parseChapterNumberFromAnchorText(text) {
  const m = text.match(/Cap[ií]tulo\s+(\d+(?:\.\d+)?)/i);
  return m ? m[1] : null;
}

async function collectExistingChapters(page, chaptersListUrl) {
  const existing = new Set();
  await go(page, chaptersListUrl);
  const last = await getLastPageNumberFast(page);
  for (let p=1; p<=last; p++) {
    const url = (p===1) ? chaptersListUrl : `${chaptersListUrl}?page=${p}`;
    await go(page, url);
    const items = page.locator(CHAPTER_ANCHOR);
    const c = await items.count();
    for (let i=0; i<c; i++) {
      const t = (await items.nth(i).innerText()).trim();
      let num = parseChapterNumberFromAnchorText(t);
      if (num) {
        const f = Number(num);
        if (!Number.isNaN(f)) {
          num = Number.isInteger(f) ? String(parseInt(f,10)) : String(f).replace(/0+$/,"").replace(/\.$/,"");
        }
        existing.add(num);
      }
    }
  }
  return existing;
}

// ===== build jobs =====
function buildJobsFromRoot(rootDir) {
  const candidates = [];
  for (const name of fs.readdirSync(rootDir)) {
    const full = path.join(rootDir, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch { continue; }
    const num = chapterNumberFromText(name);
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

async function planJobs(page, rootDir, chaptersListUrl, onlyList) {
  const catalog = new Map(buildJobsFromRoot(rootDir));
  if (onlyList && onlyList.length) {
    const desired = [];
    for (const r of onlyList) {
      const num = chapterNumberFromText(r) || r;
      if (catalog.has(num)) desired.push([num, catalog.get(num)]);
      else await notify(`[OMITIDO] No encontré carpeta para capítulo '${r}' en ${rootDir}`);
    }
    return desired;
  }
  const existing = await collectExistingChapters(page, chaptersListUrl);
  const out = [];
  for (const [n,p] of catalog.entries()) if (!existing.has(n)) out.push([n,p]);
  return out;
}

async function chapterExistsInSite(page, chaptersListUrl, chapterNumber) {
  try {
    const existing = await collectExistingChapters(page, chaptersListUrl);
    return existing.has(chapterNumber);
  } catch { return false; }
}

// ===== process a chapter =====
async function processOneChapter(page, chaptersListUrl, resourceUrl, chapterNumber, chapterDir) {
  const images = listImages(chapterDir);
  if (!images.length) { await notify(`[OMITIDO] ${path.basename(chapterDir)}: sin imágenes`); return; }

  const sizeMB = calculateChapterSizeMB(images);
  const saveTimeoutS = calculateSaveTimeout(sizeMB);

  let partFiles = images.slice();
  const expectedTotal = partFiles.length;

  await notify(`[INFO] Procesando ${path.basename(chapterDir)}: ${expectedTotal} imágenes, ${sizeMB.toFixed(1)} MB (timeout guardado: ${saveTimeoutS}s)`);

  const chapterText = displayTextFor(chapterNumber);
  let chapterId = null;

  const alreadyExists = await chapterExistsInSite(page, chaptersListUrl, chapterNumber);

  if (alreadyExists) {
    await notify(`[INFO] ${chapterText} ya existe, abriendo para verificar imágenes...`);
    const opened = await openChapterFromList(page, chaptersListUrl, chapterText, chapterNumber);
    if (!opened.ok) throw new Error(`No se pudo abrir ${chapterText} existente`);
    chapterId = opened.chapterId;
    await notify(`[INFO] ${chapterText} abierto → ID: ${chapterId}`);
  } else {
    await notify(`[NUEVO] Creando ${chapterText}...`);
    await openAddChapterOverlay(page, chaptersListUrl, resourceUrl);
    await fillOverlayCreateChapter(page, chapterNumber);
    await page.waitForTimeout(2000);

    const opened = await openChapterFromList(page, chaptersListUrl, chapterText, chapterNumber);
    if (!opened.ok) throw new Error(`No pude abrir el capítulo recién creado (${chapterText}).`);
    chapterId = opened.chapterId;
    await notify(`[NUEVO] ${chapterText} creado → ID: ${chapterId}`);
  }

  if (!(await verifyChapterNumberOnPage(page, chapterNumber))) {
    await notify(`[ADVERTENCIA] No estamos en ${chapterText}, intentando navegar directamente...`);
    if (chapterId) {
      const ok = await navigateToChapterById(page, chapterId);
      if (!ok || !(await verifyChapterNumberOnPage(page, chapterNumber))) {
        throw new Error(`No se pudo verificar que estamos en ${chapterText}`);
      }
      await notify(`[OK] Navegación directa exitosa a ${chapterText} (ID: ${chapterId})`);
    } else {
      throw new Error(`Sin ID de capítulo y no se pudo verificar ${chapterText}`);
    }
  }

  if (!chapterId) chapterId = getCurrentChapterIdFromUrl(page.url());

  await notify(`[CONFIRMADO] En ${chapterText} (ID: ${chapterId}) - Verificando imágenes...`);

  const alreadySaved = await countSavedImages(page);
  if (alreadySaved >= expectedTotal) {
    await notify(`[OK] ${chapterText} (ID: ${chapterId}): ya tiene ${alreadySaved} imágenes (esperadas: ${expectedTotal}), omitiendo subida`);
    return;
  } else if (alreadySaved > 0) {
    await notify(`[INFO] ${chapterText} (ID: ${chapterId}): tiene ${alreadySaved}/${expectedTotal} imágenes, subiendo solo las ${expectedTotal - alreadySaved} faltantes`);
    partFiles = partFiles.slice(alreadySaved);
  }

  await notify(`[SUBIENDO] ${chapterText} (ID: ${chapterId}): iniciando subida de ${partFiles.length} imágenes...`);

  const okBtn = await clickSubirImagenes(page);
  if (!okBtn) throw new Error("No se encontró botón 'Subir imágenes'.");
  await openUploadArea(page);

  await uploadImagesInBatches(page, partFiles, BATCH_UPLOAD_SIZE);

  const saved = await guardarWithRetry(page, SAVE_MAX_RETRIES, SAVE_MAX_WINDOW_S);
  if (saved) {
    await notify(`[INFO] Esperando ${saveTimeoutS}s para que el servidor procese las imágenes (${sizeMB.toFixed(1)} MB)...`);
    await new Promise(r => setTimeout(r, saveTimeoutS * 1000));
    const verified = await verifyChapterImages(page, chaptersListUrl, chapterText, expectedTotal, chapterId);
    if (verified) await notify(`[OK] ${chapterText} (ID: ${chapterId}): subido y verificado (${expectedTotal} imágenes)`);
    else await notify(`[ERROR] ${chapterText} (ID: ${chapterId}): guardado pero SIN IMÁGENES o imágenes incompletas!`);
  } else {
    await notify(`[SALTO] ${chapterText} (ID: ${chapterId}): no se pudo Guardar tras ${SAVE_MAX_RETRIES} intentos/${SAVE_MAX_WINDOW_S}s. Continúo.`);
  }
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
      const actual = await countSavedImages(page);
      if (actual < imgs.length * 0.8) {
        await notify(`  [INFO] ${chapterText} tiene ${actual}/${imgs.length} imágenes, marcando para re-subida`);
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

// ===== worker: one chapter with its own browser/context =====
async function workerUpload(job, settings) {
  const [num, chapterDir] = job;
  let browser = null, context = null, page = null;
  try {
    browser = await chromium.launch({
      headless: settings.HEADLESS,
      slowMo: settings.SLOW_MO_MS,
      args: [
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-features=TranslateUI",
      ],
    });

    const storagePath = settings.storagePath;
    context = await browser.newContext(storagePath ? { storageState: storagePath } : {});
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

    console.log(`➡️  [${num}] Login…`);
    // login only if not already authenticated by storage; if it logs in successfully, do not write storage to avoid races.
    await ensureLogin(page, context);

    console.log(`➡️  [${num}] Subiendo… (${path.basename(chapterDir)})`);
    await processOneChapter(page, settings.CHAPTERS_LIST_URL, settings.RESOURCE_URL, num, chapterDir);
    console.log(`✅ [${num}] Listo (${path.basename(chapterDir)})`);

    await page.waitForTimeout(1000);
    await context.close(); await browser.close();
    return { num, status: "ok" };
  } catch (e) {
    try { if (page) await snap(page, `99_error_${num}`); } catch {}
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    return { num, status: "error", info: String(e) };
  }
}

// ===== main =====
async function main() {
  const args = parseArgs(process.argv);

  if (!USERNAME || !PASSWORD) {
    console.error("❌ Error: Falta SITE_USERNAME/SITE_PASSWORD en .env.");
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
  rootDir = path.resolve(rootDir);
  if (!fs.existsSync(rootDir)) {
    console.error(`❌ Error: No existe la ruta: ${rootDir}`);
    process.exit(1);
  }

  const onlyChapters = (args["chapters"] || "").trim();
  const onlyList = onlyChapters ? onlyChapters.split(",").map(s => s.trim()).filter(Boolean) : null;

  const parallel = Math.max(1, parseInt(args["parallel"] || String(DEFAULT_PARALLEL), 10));
  const saveRetries = parseInt(args["save-retries"] || String(SAVE_MAX_RETRIES), 10);
  const saveWindow = parseInt(args["save-window"] || String(SAVE_MAX_WINDOW_S), 10);
  const verifyRounds = parseInt(args["verify-retries"] || String(VERIFY_RETRIES), 10);

  console.log("\n=== Parámetros efectivos ===");
  console.log(`BASE_URL:          ${BASE_URL}`);
  console.log(`LOGIN_URL:         ${LOGIN_URL}`);
  console.log(`RESOURCE_URL:      ${resourceUrl}`);
  console.log(`CHAPTERS_LIST_URL: ${chaptersListUrl}`);
  console.log(`ROOT:              ${rootDir}`);
  console.log(`MAX_PER_CHAPTER:   ${MAX_PER_CHAPTER}`);
  console.log(`BATCH_UPLOAD_SIZE: ${BATCH_UPLOAD_SIZE}`);
  console.log(`SLEEP_BETWEEN_MS:  ${SLEEP_BETWEEN_BATCH_MS}`);
  console.log(`SAVE_MAX_RETRIES:  ${saveRetries}`);
  console.log(`SAVE_MAX_WINDOW_S: ${saveWindow}`);
  console.log(`USUARIO (login):   ${USERNAME}`);
  console.log(`PARALELO:          ${parallel}`);
  console.log(`VERIFY_RETRIES:    ${verifyRounds}`);
  console.log("============================\n");

  // discovery stage (single browser) + save cookies once to reduce repeated logins later
  console.log("➡️  Lanzando Chromium (descubrimiento)…");
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO_MS });
  const storagePath = storageStatePathIfExists();
  const context = await browser.newContext(storagePath ? { storageState: storagePath } : {});
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  console.log("➡️  Iniciando sesión…");
  await ensureLogin(page, context);
  console.log("✅ Sesión OK (storage guardado)");

  console.log("➡️  Resolviendo capítulos a procesar…");
  const jobsList = await planJobs(page, rootDir, chaptersListUrl, onlyList);
  console.log(`📦 Capítulos a procesar: ${jobsList.length}`);
  if (!jobsList.length) {
    console.log("No hay trabajo que hacer.");
    await context.close(); await browser.close();
    return;
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
  };

  if (parallel === 1) {
    console.log("➡️  Modo secuencial…");
    for (const job of jobsList) {
      const res = await workerUpload(job, settings);
      if (res.status === "error") console.log(`❌ [${res.num}] ${res.info}`);
    }
  } else {
    console.log(`➡️  Modo paralelo por lotes de ${parallel}…`);
    const results = await runPool(jobsList, parallel, (job) => workerUpload(job, settings));
    for (const r of results) {
      if (r.status === "ok") console.log(`✅ [${r.num}] ok`);
      else console.log(`❌ [${r.num}] ${r.info}`);
    }
  }

  // verify rounds
  for (let round = 1; round <= verifyRounds; round++) {
    await notify(`\n🔎 Verificación ronda ${round}/${verifyRounds}…`);
    const b = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO_MS });
    const c = await b.newContext(storageStatePathIfExists() ? { storageState: storageStatePathIfExists() } : {});
    const p = await c.newPage();
    p.setDefaultTimeout(TIMEOUT_MS);
    await ensureLogin(p, c);
    const missing = await findMissingWork(p, chaptersListUrl, jobsList);
    if (!missing.length) {
      await notify("✅ Todo presente. No hay que re-subir.");
      await c.close(); await b.close();
      break;
    }
    for (const [num, dir] of missing) {
      try {
        await notify(`↻ Re-subiendo faltantes: ${path.basename(dir)} (cap ${num})`);
        await processOneChapter(p, chaptersListUrl, resourceUrl, num, dir);
      } catch (e) {
        await notify(`[ERROR] Re-subiendo ${path.basename(dir)}: ${e}`);
      }
    }
    await c.close(); await b.close();
  }

  await notify("\n✅ Finalizado.");
}

main().catch((e) => {
  console.error("❌ Excepción no controlada:", e);
  process.exit(1);
});
