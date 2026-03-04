/**
 * drive_download.js
 * Descarga carpetas publicas de Google Drive usando Node.js puro (sin Python/gdown).
 * Soporta carpetas compartidas con "Cualquiera con el enlace puede ver".
 *
 * Uso:
 *   import { downloadDriveFolder } from "./drive_download.js";
 *   const destDir = await downloadDriveFolder("https://drive.google.com/drive/folders/FOLDER_ID", "/tmp/dest");
 */

import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// Extraer folder ID de distintos formatos de URL de Drive
export function extractFolderId(url) {
  const str = String(url || "");
  // https://drive.google.com/drive/folders/FOLDER_ID
  let m = str.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // ?id=FOLDER_ID
  m = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // Si es solo el ID directo
  if (/^[a-zA-Z0-9_-]{10,}$/.test(str.trim())) return str.trim();
  return null;
}

// Extraer file ID de URL de archivo individual
export function extractFileId(url) {
  const str = String(url || "");
  let m = str.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

// Listar archivos en una carpeta publica de Drive usando la pagina HTML
async function listFolderFiles(folderId, onProgress) {
  const files = [];
  let pageToken = null;

  // Usar la API publica de Drive (no requiere API key para carpetas publicas)
  // Fallback: scraping de la pagina de la carpeta
  const apiUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&fields=files(id,name,mimeType,size)&pageSize=1000&key=`;

  // Intentar sin API key usando el endpoint publico
  try {
    const url = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    const html = await resp.text();

    // Extraer entries del HTML embebido
    // El HTML contiene datos en formato JSON dentro de scripts
    const entries = extractEntriesFromHtml(html, folderId);
    if (entries.length > 0) {
      if (onProgress) onProgress(`Encontrados ${entries.length} archivos en la carpeta`);
      return entries;
    }
  } catch (e) {
    // fallback
  }

  // Fallback: usar la pagina normal de la carpeta
  try {
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    const html = await resp.text();
    const entries = extractEntriesFromMainPage(html);
    if (entries.length > 0) {
      if (onProgress) onProgress(`Encontrados ${entries.length} archivos en la carpeta`);
      return entries;
    }
  } catch (e) {
    // fallback
  }

  // Ultimo fallback: intentar API publica sin key (solo funciona con carpetas muy publicas)
  try {
    do {
      let url = `https://www.googleapis.com/drive/v3/files?q=%27${folderId}%27+in+parents&fields=files(id,name,mimeType,size)&pageSize=1000`;
      if (pageToken) url += `&pageToken=${pageToken}`;
      const resp = await fetch(url);
      if (!resp.ok) break;
      const data = await resp.json();
      if (data.files) {
        for (const f of data.files) {
          files.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: parseInt(f.size || "0", 10),
            isFolder: f.mimeType === "application/vnd.google-apps.folder",
          });
        }
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    if (files.length > 0) {
      if (onProgress) onProgress(`Encontrados ${files.length} archivos via API`);
      return files;
    }
  } catch (e) {
    // API sin key probablemente falle
  }

  throw new Error(
    `No se pudo listar la carpeta de Drive (ID: ${folderId}). ` +
    `Asegurate de que la carpeta sea publica (Compartir > Cualquiera con el enlace).`
  );
}

function extractEntriesFromHtml(html, folderId) {
  const entries = [];
  // Buscar patrones de archivos en el HTML embebido
  // Los IDs de archivo aparecen como data-id="..." o en URLs /file/d/ID/
  const idPattern = /\["([a-zA-Z0-9_-]{20,})",\s*"([^"]+)"/g;
  let match;
  while ((match = idPattern.exec(html)) !== null) {
    const [, id, name] = match;
    if (id !== folderId) {
      entries.push({
        id,
        name,
        mimeType: guessMimeType(name),
        size: 0,
        isFolder: false,
      });
    }
  }

  // Otro patron comun en el HTML
  if (entries.length === 0) {
    const altPattern = /data-id="([a-zA-Z0-9_-]+)"[^>]*>.*?<div[^>]*class="[^"]*flip-entry-title[^"]*"[^>]*>([^<]+)/gs;
    while ((match = altPattern.exec(html)) !== null) {
      const [, id, name] = match;
      if (id !== folderId) {
        entries.push({
          id,
          name: name.trim(),
          mimeType: guessMimeType(name.trim()),
          size: 0,
          isFolder: false,
        });
      }
    }
  }

  return entries;
}

function extractEntriesFromMainPage(html) {
  const entries = [];
  // En la pagina principal, los archivos aparecen en data-* attributes
  const pattern = /data-id="([a-zA-Z0-9_-]{15,})"/g;
  const names = {};
  let match;

  // Extraer nombres asociados
  const namePattern = /data-tooltip="([^"]+)"[^>]*data-id="([a-zA-Z0-9_-]+)"/g;
  while ((match = namePattern.exec(html)) !== null) {
    names[match[2]] = match[1];
  }

  // Tambien buscar en formato alternativo
  const altNamePattern = /data-id="([a-zA-Z0-9_-]+)"[^>]*data-tooltip="([^"]+)"/g;
  while ((match = altNamePattern.exec(html)) !== null) {
    names[match[1]] = match[2];
  }

  const ids = new Set();
  const idPattern = /data-id="([a-zA-Z0-9_-]{15,})"/g;
  while ((match = idPattern.exec(html)) !== null) {
    ids.add(match[1]);
  }

  for (const id of ids) {
    const name = names[id] || id;
    entries.push({
      id,
      name,
      mimeType: guessMimeType(name),
      size: 0,
      isFolder: !name.includes("."),
    });
  }

  return entries;
}

function guessMimeType(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return map[ext] || "application/octet-stream";
}

// Descargar un archivo individual de Drive
async function downloadFile(fileId, destPath, onProgress) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;

  let resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    redirect: "follow",
  });

  // Para archivos grandes, Drive muestra una pagina de confirmacion
  if (resp.headers.get("content-type")?.includes("text/html")) {
    const html = await resp.text();
    // Buscar el link de confirmacion
    const confirmMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/);
    if (confirmMatch) {
      const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmMatch[1]}`;
      resp = await fetch(confirmUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        redirect: "follow",
      });
    } else {
      // Intentar con confirm=t (bypass generico)
      const bypassUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
      resp = await fetch(bypassUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        redirect: "follow",
      });
    }
  }

  if (!resp.ok) {
    throw new Error(`Error descargando archivo ${fileId}: HTTP ${resp.status}`);
  }

  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(resp.body), fileStream);

  if (onProgress) onProgress(`Descargado: ${path.basename(destPath)}`);
}

/**
 * Descarga una carpeta publica de Google Drive.
 * @param {string} driveUrl - URL de la carpeta de Google Drive
 * @param {string} destDir - Directorio destino (se crea si no existe)
 * @param {object} opts - Opciones
 * @param {function} opts.onProgress - Callback de progreso: (message: string) => void
 * @param {boolean} opts.recursive - Descargar subcarpetas recursivamente (default: true)
 * @returns {string} Ruta del directorio destino
 */
export async function downloadDriveFolder(driveUrl, destDir, opts = {}) {
  const { onProgress = null, recursive = true } = opts;

  const folderId = extractFolderId(driveUrl);
  if (!folderId) {
    throw new Error("No se pudo extraer el ID de la carpeta de Drive de la URL proporcionada.");
  }

  fs.mkdirSync(destDir, { recursive: true });

  if (onProgress) onProgress(`Listando archivos en carpeta ${folderId}...`);

  const entries = await listFolderFiles(folderId, onProgress);
  if (!entries.length) {
    throw new Error("La carpeta de Drive esta vacia o no se pudo acceder.");
  }

  const folders = entries.filter(e => e.isFolder);
  const files = entries.filter(e => !e.isFolder);

  if (onProgress) onProgress(`${files.length} archivos, ${folders.length} subcarpetas`);

  // Descargar archivos
  let downloaded = 0;
  for (const file of files) {
    const destPath = path.join(destDir, file.name);

    // Si ya existe y tiene tamano similar, omitir
    try {
      const stat = fs.statSync(destPath);
      if (stat.size > 0 && (file.size === 0 || Math.abs(stat.size - file.size) < 1024)) {
        if (onProgress) onProgress(`Ya existe: ${file.name}`);
        downloaded++;
        continue;
      }
    } catch {}

    try {
      await downloadFile(file.id, destPath, onProgress);
      downloaded++;
      if (onProgress) onProgress(`[${downloaded}/${files.length}] ${file.name}`);
    } catch (e) {
      if (onProgress) onProgress(`[ERROR] ${file.name}: ${e.message}`);
    }
  }

  // Descargar subcarpetas recursivamente
  if (recursive && folders.length > 0) {
    for (const folder of folders) {
      const subDest = path.join(destDir, folder.name);
      if (onProgress) onProgress(`Entrando en subcarpeta: ${folder.name}`);
      try {
        await downloadDriveFolder(
          `https://drive.google.com/drive/folders/${folder.id}`,
          subDest,
          { onProgress, recursive }
        );
      } catch (e) {
        if (onProgress) onProgress(`[ERROR] Subcarpeta ${folder.name}: ${e.message}`);
      }
    }
  }

  if (onProgress) onProgress(`Descarga completada: ${downloaded} archivos en ${destDir}`);
  return destDir;
}

export default { downloadDriveFolder, extractFolderId };
