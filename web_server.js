import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_DIR = process.env.WEB_STORAGE_DIR || path.join(process.cwd(), "storage");
const PUBLIC_DIR = path.join(process.cwd(), "public");
const COOKIE_SECURE = (process.env.COOKIE_SECURE || "0") === "1";
const SECRETS_FILE = process.env.SECRETS_FILE || path.join(process.cwd(), "secrets.json");

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

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/status", (req, res) => {
  const sid = getSessionId(req, res);
  const job = jobs.get(sid);
  if (!job) {
    return res.json({ status: "idle", logs: [], next: 0 });
  }
  const from = Math.max(0, parseInt(req.query.from || "0", 10));
  const slice = job.logs.slice(from);
  return res.json({
    status: job.status,
    logs: slice,
    next: from + slice.length,
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
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
  const {
    username,
    password,
    resourceUrl,
    chaptersUrl,
    rootDir,
    rangeStart,
    rangeEnd,
    apiKey,
    apiUser,
  } = req.body || {};

  if (!username || !password || !resourceUrl || !rootDir) {
    return res.status(400).json({ error: "Faltan datos obligatorios." });
  }
  if (!fs.existsSync(rootDir)) {
    return res.status(400).json({ error: "La ruta raiz no existe en el servidor." });
  }
  const startNum = toNumberMaybe(rangeStart);
  const endNum = toNumberMaybe(rangeEnd);
  if ((rangeStart && startNum === null) || (rangeEnd && endNum === null)) {
    return res.status(400).json({ error: "Rango invalido. Usa numeros como 106 o 112.5." });
  }

  const existing = jobs.get(sid);
  if (existing && existing.status === "running") {
    return res.status(409).json({ error: "Ya hay una subida en progreso." });
  }

  ensureDir(STORAGE_DIR);
  const storagePath = path.join(STORAGE_DIR, `storage_${sid}.json`);
  const pauseFile = path.join(STORAGE_DIR, `pause_${sid}.flag`);

  const env = {
    ...process.env,
    SITE_USERNAME: username,
    SITE_PASSWORD: password,
    RESOURCE_URL: resourceUrl,
    CHAPTERS_LIST_URL: chaptersUrl || "",
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
  if (chaptersUrl) {
    args.push("--chapters-url", chaptersUrl);
  }
  if (startNum !== null) args.push("--start", String(startNum));
  if (endNum !== null) args.push("--end", String(endNum));

  const job = {
    status: "running",
    logs: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    proc: null,
    pauseFile,
  };
  jobs.set(sid, job);
  if (startNum !== null || endNum !== null) {
    pushLog(job, `[INFO] Rango solicitado: ${startNum ?? "-"} -> ${endNum ?? "-"}`);
  }

  const proc = spawn("node", args, { cwd: process.cwd(), env });
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
    if (job.status !== "stopped") {
      job.status = code === 0 ? "done" : "error";
    }
    job.endedAt = new Date().toISOString();
    pushLog(job, `Proceso finalizado con codigo ${code}`);
  });

  return res.json({ ok: true });
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

app.listen(PORT, () => {
  ensureDir(STORAGE_DIR);
  console.log(`[WEB] Servidor listo en http://localhost:${PORT}`);
});
