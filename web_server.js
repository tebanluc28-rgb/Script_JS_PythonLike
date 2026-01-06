import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const APP_ROOT = process.env.APP_ROOT || process.cwd();
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const STORAGE_DIR = process.env.WEB_STORAGE_DIR || path.join(DATA_DIR, "storage");
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const COOKIE_SECURE = (process.env.COOKIE_SECURE || "0") === "1";
const SECRETS_FILE = process.env.SECRETS_FILE || path.join(DATA_DIR, "secrets.json");

const jobs = new Map();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
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

function pushLog(job, line) {
  const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
  job.logs.push(clean);
  if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
}

function getJobState(sid) {
  if (jobs.has(sid)) return jobs.get(sid);
  const job = {
    status: "idle",
    logs: [],
    startedAt: null,
    endedAt: null,
    proc: null,
    pauseFile: null,
    queue: [],
    current: null,
  };
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
  if (!fs.existsSync(rootDir)) {
    return { error: "La ruta raiz no existe en el servidor." };
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
    ...process.env,
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

function startNext(job) {
  if (job.proc || job.status === "running" || job.status === "paused") return;
  while (job.queue.length) {
    const payload = job.queue.shift();
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
    if (task.rangeLabel) pushLog(job, `[INFO] Rango solicitado: ${task.rangeLabel}`);
    pushLog(job, `[INFO] Iniciando serie: ${task.label}`);

    const proc = spawn("node", task.args, { cwd: process.cwd(), env: task.env });
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
    proc.on("close", (code) => {
      job.proc = null;
      if (job.status !== "stopped") {
        job.status = code === 0 ? "done" : "error";
      }
      job.endedAt = new Date().toISOString();
      pushLog(job, `Proceso finalizado con codigo ${code}`);
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


app.get("/api/secrets", (req, res) => {
  const s = readSecrets();
  res.json({ hasApi: Boolean(s.apiKey && s.apiUser) });
});

app.post("/api/secrets", (req, res) => {
  const { apiKey, apiUser } = req.body || {};
  if (!apiKey || !apiUser) {
    return res.status(400).json({ error: "Faltan datos de API." });
  }
  writeSecrets({ apiKey: String(apiKey), apiUser: String(apiUser) });
  return res.json({ ok: true });
});

app.post("/api/start", (req, res) => {
  const sid = getSessionId(req, res);
  const enqueueOnly = Boolean(req.body && req.body.enqueueOnly);
  const job = getJobState(sid);
  job.sid = sid;
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
  pushLog(job, `[INFO] En cola: ${req.body.resourceUrl || ""}`);
  if (!enqueueOnly) startNext(job);
  return res.json({ ok: true, queued: job.queue.length });
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
  try { if (job.pauseFile && fs.existsSync(job.pauseFile)) fs.unlinkSync(job.pauseFile); } catch {}
  try { job.proc.kill("SIGTERM"); } catch {}
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

let serverInstance = null;
export function startServer({ port } = {}) {
  if (serverInstance) return serverInstance;
  const listenPort = port || PORT;
  ensureDir(STORAGE_DIR);
  serverInstance = app.listen(listenPort, () => {
    console.log(`[WEB] Servidor listo en http://localhost:${listenPort}`);
  });
  return serverInstance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
