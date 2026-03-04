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
const PORT = process.env.PORT || 3000;
const APP_ROOT = process.env.APP_ROOT || process.cwd();
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const STORAGE_DIR = process.env.WEB_STORAGE_DIR || path.join(DATA_DIR, "storage");
const UPLOAD_BASE_DIR = process.env.UPLOAD_BASE_DIR || path.join(STORAGE_DIR, "incoming", "obras");
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "2048", 10);
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const COOKIE_SECURE = (process.env.COOKIE_SECURE || "0") === "1";
const SECRETS_FILE = process.env.SECRETS_FILE || path.join(DATA_DIR, "secrets.json");
const QUEUE_STATE_FILE = process.env.QUEUE_STATE_FILE || path.join(DATA_DIR, "queue_state.json");

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
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    const raw = fs.readFileSync(SECRETS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecrets(data) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ===== Persistencia de la cola entre reinicios del servidor =====
function saveQueueState() {
  try {
    const state = {};
    for (const [sid, job] of jobs) {
      if (job.queue && job.queue.length > 0) {
        state[sid] = { queue: job.queue };
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

function getJobState(sid) {
  if (jobs.has(sid)) return jobs.get(sid);
  // Restaurar cola persistida si existe para esta sesion
  const saved = _savedQueues[sid] || {};
  const job = {
    status: "idle",
    logs: [],
    startedAt: null,
    endedAt: null,
    proc: null,
    pauseFile: null,
    queue: Array.isArray(saved.queue) ? saved.queue.slice() : [],
    current: null,
    uploads: [],
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
  const startNum = toNumberMaybe(rangeStart);
  const endNum = toNumberMaybe(rangeEnd);
  if ((rangeStart && startNum === null) || (rangeEnd && endNum === null)) {
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
  if (startNum !== null) args.push("--start", String(startNum));
  if (endNum !== null) args.push("--end", String(endNum));

  return {
    env,
    args,
    pauseFile,
    label: resourceUrl,
    rangeLabel: (startNum !== null || endNum !== null) ? `${startNum ?? "-"} -> ${endNum ?? "-"}` : null,
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

  // Obtener solo los logs de la subida actual (desde currentUploadStartLogIndex)
  const startIndex = job.currentUploadStartLogIndex || 0;
  const currentUploadLogs = job.logs.slice(startIndex);

  // Intentar detectar el rango de capitulos desde los logs de esta subida
  let chapterStart = null;
  let chapterEnd = null;

  // Buscar numeros solo de capitulos realmente subidos (fase upload + OK + completado/publicado).
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
        const capFromText = log.match(/\bCap(?:[i�]tulo)?\s*(\d+(?:[.,]\d+)?)/i);
        if (capFromText) capRaw = capFromText[1];
      }

      if (capRaw) {
        const num = Number(String(capRaw).replace(',', '.'));
        if (Number.isFinite(num) && num > 0) {
          chapterNumbersSet.add(num);
        }
      }
      continue;
    }

    // Compatibilidad con linea legado/sistema
    const legacyCompleted = log.match(/\[OK\][^\n\r]*\bCap(?:[i�]tulo)?\s*(\d+(?:[.,]\d+)?)[^\n\r]*\b(completado|publicado)\b/i);
    if (legacyCompleted) {
      const num = Number(String(legacyCompleted[1]).replace(',', '.'));
      if (Number.isFinite(num) && num > 0) {
        chapterNumbersSet.add(num);
      }
    }
  }

  const chapterNumbers = Array.from(chapterNumbersSet).sort((a, b) => a - b);
  if (chapterNumbers.length > 0) {
    chapterStart = chapterNumbers[0];
    chapterEnd = chapterNumbers[chapterNumbers.length - 1];
  } else {
    pushLog(job, "[INFO] No se detectaron capitulos nuevos subidos en esta ejecucion. Notificacion automatica omitida.");
    return;
  }

  if (chapterStart === chapterEnd) {
    pushLog(job, `[INFO] Detectado capitulo ${chapterStart}`);
  } else {
    pushLog(job, `[INFO] Detectados capitulos ${chapterStart} al ${chapterEnd}`);
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
    saveQueueState(); // Persistir que este trabajo ya salio de la cola
    const task = buildTask(payload, job.sid);
    if (task.error) {
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

    // Marcar el inicio de esta subida para poder filtrar logs después
    job.currentUploadStartLogIndex = job.logs.length;

    // Separador visual para nueva subida
    pushLog(job, "");
    pushLog(job, "========================================");
    pushLog(job, `INICIANDO SUBIDA: ${task.label}`);
    if (task.rangeLabel) pushLog(job, `Rango solicitado: ${task.rangeLabel}`);
    pushLog(job, "========================================");

    const proc = spawn(NODE_EXE, task.args, { cwd: process.cwd(), env: task.env });
    job.proc = proc;


    proc.stdout.on("data", (buf) => {
      const lines = String(buf).split(/\r?\n/);
      for (const line of lines) {
        if (line.trim()) pushLog(job, line);
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

      // Separador visual para fin de subida
      pushLog(job, "");
      pushLog(job, "----------------------------------------");
      pushLog(job, `SUBIDA FINALIZADA - Codigo: ${code} - Estado: ${code === 0 ? "EXITOSO" : "ERROR"}`);
      pushLog(job, "----------------------------------------");

      // Publicar notificación automática si está habilitado y la subida fue exitosa
      if (code === 0 && job.autoNotify && job.current) {
        pushLog(job, "");
        pushLog(job, ">>> PUBLICANDO NOTIFICACION AUTOMATICA...");
        try {
          await publishAutoNotification(job.current, job);
          pushLog(job, ">>> NOTIFICACION PUBLICADA EXITOSAMENTE");
        } catch (err) {
          pushLog(job, `>>> ERROR EN NOTIFICACION: ${err.message}`);
        }
        pushLog(job, "");
      }

      if (job.status !== "stopped") startNext(job);
    });
    return;
  }
  if (!job.queue.length) {
    job.status = "idle";
    job.current = null;
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
  const slice = job.logs.slice(from);
  return res.json({
    status: job.status,
    logs: slice,
    next: from + slice.length,
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
    queue: job.queue.length,
    current: job.current,
    queueItems: job.queue.map((q, idx) => ({
      index: idx,
      resourceUrl: q.resourceUrl || "",
      rootDir: q.rootDir || "",
      rangeStart: q.rangeStart || "",
      rangeEnd: q.rangeEnd || "",
    })),
  });
});

app.post("/api/logs/clear", (req, res) => {
  const sid = getSessionId(req, res);
  const job = getJobState(sid);
  job.logs = [];
  job.currentUploadStartLogIndex = 0;
  return res.json({ ok: true, next: 0 });
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
  pushLog(job, `[INFO] En cola: ${req.body.resourceUrl || ""}`);
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
  try { if (job.pauseFile && fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile); } catch { }
  try { job.proc.kill("SIGTERM"); } catch { }
  job.queue = [];
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

app.post("/api/pause", (req, res) => {
  const sid = getSessionId(req, res);
  const job = jobs.get(sid);
  if (!job || !job.proc) {
    return res.status(404).json({ error: "No hay proceso activo." });
  }
  try {
    fs.writeFileSync(job.pauseFile, "1");
  } catch {
    return res.status(500).json({ error: "No se pudo pausar." });
  }
  job.status = "paused";
  pushLog(job, "Proceso en pausa.");
  return res.json({ ok: true });
});

app.post("/api/resume", (req, res) => {
  const sid = getSessionId(req, res);
  const job = jobs.get(sid);
  if (!job || !job.proc) {
    return res.status(404).json({ error: "No hay proceso activo." });
  }
  try {
    if (fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile);
  } catch {
    return res.status(500).json({ error: "No se pudo reanudar." });
  }
  job.status = "running";
  pushLog(job, "Proceso reanudado.");
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
    const { notificationId } = req.body;
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
      customImagePath || ""
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
  serverInstance = app.listen(listenPort, listenHost, () => {
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
  return serverInstance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

