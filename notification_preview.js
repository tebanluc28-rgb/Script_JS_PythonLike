import { chromium } from 'playwright-core';
import fs from 'fs';

const args = process.argv.slice(2);
const url = args[0];
const chapterStartRaw = String(args[1] ?? "").trim().replace(',', '.');
const chapterEndRaw = String(args[2] ?? "").trim().replace(',', '.');
const useCustomImage = args[3] === 'true';
const customImagePath = args[4];

function parseChapterToken(raw) {
  const txt = String(raw || "").trim().replace(",", ".");
  const m = txt.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  const dec = m[2] || "";
  const value = Number(txt);
  let part = null;
  if (dec && !/^0+$/.test(dec)) {
    part = parseInt(dec, 10);
    while (part % 10 === 0) part = Math.floor(part / 10);
    if (!Number.isFinite(part) || part <= 0) part = null;
  }
  return { raw: txt, base, dec, value, part };
}

function formatChapterLabel(token) {
  if (!token) return "";
  if (token.part !== null) return `Capítulo ${token.base} Parte ${token.part}`;
  return `Capítulo ${token.raw}`;
}

function formatChapterRangeLabel(startToken, endToken) {
  if (!startToken || !endToken) return "";
  if (startToken.raw === endToken.raw) return formatChapterLabel(startToken);
  const left = formatChapterLabel(startToken);
  const right = formatChapterLabel(endToken).replace(/^Capítulo\s+/i, "");
  return `${left} al ${right}`;
}

function matchesChapterText(text, token, href = "") {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!token) return false;
  const chapterNumber = token.part !== null ? token.base : token.raw;
  const numberText = String(chapterNumber).replace(".", "[.,]");
  return new RegExp(`\\bcap(?:[ií]tulo|\\.?)\\s*0*${numberText}(?:[.,]0+)?\\b`, "i").test(t);
}

async function generatePreview() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navegar a la pÃ¡gina de la obra para extraer datos
    console.error('[PREVIEW] Navegando a:', url);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Extraer tÃ­tulo
    const titleRaw = await page.locator('h1.p-title-value').textContent().catch(() => "");
    const title = titleRaw.replace(/\s+/g, ' ').trim();
    const cleanTitle = title
      .replace(/^(manga|manhwa|manhua)\s*[-:|]?\s*/i, '')
      .replace(/[.。]+$/g, '')
      .trim();
    console.error('[PREVIEW] TÃ­tulo:', title);

    // Extraer tipo (manga/manhwa/manhua) desde los tags o desde el tÃ­tulo
    let type = "manga"; // default
    const tags = await page.locator('.tagItem a, .tag a, a[href*="/tags/"]').allTextContents().catch(() => []);
    const badgeText = await page.locator('.label, .label--green, .label--primary').first().textContent().catch(() => "");
    console.error('[PREVIEW] Tags encontrados:', tags.length, '- Contenido:', tags);

    // Detectar tipo desde tags
    const allTags = tags.map(t => t.toLowerCase());
    const badgeLower = String(badgeText || "").toLowerCase();
    if (badgeLower.includes("manhwa")) {
      type = "manhwa";
    } else if (badgeLower.includes("manhua")) {
      type = "manhua";
    } else if (allTags.some(t => t.includes("manhwa"))) {
      type = "manhwa";
    } else if (allTags.some(t => t.includes("manhua"))) {
      type = "manhua";
    } else if (title.toLowerCase().includes("manhwa")) {
      type = "manhwa";
    } else if (title.toLowerCase().includes("manhua")) {
      type = "manhua";
    }

    if (tags.some(t => t.toLowerCase().includes("manhwa"))) {
      type = "manhwa";
    } else if (tags.some(t => t.toLowerCase().includes("manhua"))) {
      type = "manhua";
    }
    console.error('[PREVIEW] Tipo detectado:', type);

    // Extraer imagen de portada
    let coverUrl = null;
    let imageBase64 = null;

    if (useCustomImage && customImagePath && fs.existsSync(customImagePath)) {
      // Usar imagen personalizada
      console.error('[PREVIEW] Usando imagen personalizada:', customImagePath);
      const imageBuffer = fs.readFileSync(customImagePath);
      imageBase64 = imageBuffer.toString('base64');
    } else {
      // Extraer imagen de la portada - probar mÃºltiples selectores
      console.error('[PREVIEW] Extrayendo imagen de portada...');

      // Intentar buscar imagen de banner/portada de AnimesBBG
      console.error('[PREVIEW] Buscando imagen de portada...');

      // Primero intentar con resource_banner (la portada principal)
      try {
        const bannerImg = await page.locator('img[src*="resource_banner"]').first();
        const count = await page.locator('img[src*="resource_banner"]').count();
        console.error(`[PREVIEW] ImÃ¡genes con "resource_banner": ${count}`);

        if (count > 0) {
          coverUrl = await bannerImg.getAttribute('src');
          console.error('[PREVIEW] âœ… Imagen de banner encontrada:', coverUrl);
        }
      } catch (e) {
        console.error('[PREVIEW] No se encontrÃ³ resource_banner:', e.message);
      }

      // Si no encontrÃ³ banner, intentar con resource_icons
      if (!coverUrl) {
        try {
          const iconImg = await page.locator('img[src*="resource_icons"]').first();
          const count = await page.locator('img[src*="resource_icons"]').count();
          console.error(`[PREVIEW] ImÃ¡genes con "resource_icons": ${count}`);

          if (count > 0) {
            coverUrl = await iconImg.getAttribute('src');
            console.error('[PREVIEW] âœ… Imagen de icono encontrada:', coverUrl);
          }
        } catch (e) {
          console.error('[PREVIEW] No se encontrÃ³ resource_icons:', e.message);
        }
      }

      // Fallback: buscar cualquier imagen grande que no sea el logo
      if (!coverUrl) {
        console.error('[PREVIEW] Buscando cualquier imagen grande...');
        try {
          const allImages = await page.$$eval('img', imgs =>
            imgs.map(img => ({
              src: img.src,
              width: img.width,
              height: img.height
            })).filter(img =>
              img.width > 100 &&
              img.height > 100 &&
              !img.src.includes('logo')
            ).sort((a, b) => (b.width * b.height) - (a.width * a.height))
          );

          if (allImages.length > 0) {
            coverUrl = allImages[0].src;
            console.error('[PREVIEW] âœ… Imagen mÃ¡s grande encontrada:', coverUrl, `(${allImages[0].width}x${allImages[0].height})`);
          } else {
            console.error('[PREVIEW] No se encontrÃ³ ninguna imagen adecuada');
          }
        } catch (e) {
          console.error('[PREVIEW] Error buscando imÃ¡genes:', e.message);
        }
      }

      if (coverUrl) {
        // Asegurarse de que es una URL completa
        if (coverUrl.startsWith('//')) {
          coverUrl = 'https:' + coverUrl;
        } else if (coverUrl.startsWith('/')) {
          const urlObj = new URL(url);
          coverUrl = urlObj.origin + coverUrl;
        }

        console.error('[PREVIEW] Descargando imagen desde:', coverUrl);
        const imageResponse = await page.request.get(coverUrl);
        const imageBuffer = await imageResponse.body();
        imageBase64 = imageBuffer.toString('base64');
        console.error('[PREVIEW] Imagen descargada, tamaÃ±o:', imageBuffer.length, 'bytes');
      } else {
        console.error('[PREVIEW] No se pudo encontrar la imagen de portada');
      }
    }

    // Generar mensaje con hipervÃ­nculo
    const chapterStartToken = parseChapterToken(chapterStartRaw);
    const chapterEndToken = parseChapterToken(chapterEndRaw);
    if (!chapterStartToken || !chapterEndToken) {
      throw new Error("Capítulo inicial/final inválido.");
    }
    const chapterRange = formatChapterRangeLabel(chapterStartToken, chapterEndToken);

    // Navegar a la lista de capÃ­tulos para obtener la URL real (igual que en publisher)
    console.error('[PREVIEW] Navegando a lista de capÃ­tulos...');
    const chaptersUrl = url.endsWith('/') ? url + 'capitulos' : url + '/capitulos';
    const siteOrigin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return 'https://animebbg.net';
      }
    })();

    const findChapterLinkByToken = async (targetToken, maxPages = 8) => {
      console.error('[PREVIEW] Buscando capítulo', formatChapterLabel(targetToken), 'desde página 1 (orden descendente por defecto).');

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const targetUrl = pageNum === 1 ? chaptersUrl : `${chaptersUrl}?page=${pageNum}`;
        console.error('[PREVIEW] Buscando en pÃ¡gina', pageNum, ':', targetUrl);

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);

        const chapterElements = await page.locator('a[href*="/comics/capitulo/link/"], a[href*="/capitulo/link/"], a[href*="/comics/capitulo/"], a[href*="/capitulo/"]').all();
        console.error('[PREVIEW] Enlaces encontrados en pÃ¡gina', pageNum, ':', chapterElements.length);

        if (chapterElements.length === 0 && pageNum > 1) {
          break;
        }

        for (const elem of chapterElements) {
          const text = await elem.textContent();
          const href = await elem.getAttribute('href');
          if (!href) continue;

          const cleanText = text ? text.replace(/\s+/g, ' ').trim() : '';
          if (!matchesChapterText(cleanText, targetToken, href)) continue;

          const fullHref = href.startsWith('http') ? href : new URL(href, siteOrigin).toString();
          console.error(`[PREVIEW] Coincidencia ${formatChapterLabel(targetToken)} en página ${pageNum}: "${cleanText}" -> ${fullHref}`);
          return fullHref;
        }
      }

      return null;
    };

    let chapterLink = null;

    if (chapterStartToken.raw === chapterEndToken.raw) {
      // Flujo original para un solo capÃ­tulo (se mantiene igual).
      const estimatedPage = Math.ceil(chapterStartToken.base / 10);
      const pagesToSearch = [estimatedPage, estimatedPage - 1, estimatedPage + 1, 1].filter(p => p > 0);
      console.error('[PREVIEW] Buscando', formatChapterLabel(chapterStartToken), 'en páginas:', pagesToSearch);

      for (const pageNum of pagesToSearch) {
        if (chapterLink) break;
        const targetUrl = pageNum === 1 ? chaptersUrl : `${chaptersUrl}?page=${pageNum}`;
        console.error('[PREVIEW] Buscando en pÃ¡gina', pageNum, ':', targetUrl);

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);

        const chapterElements = await page.locator('a[href*="/comics/capitulo/link/"], a[href*="/capitulo/link/"], a[href*="/comics/capitulo/"], a[href*="/capitulo/"]').all();
        console.error('[PREVIEW] Enlaces encontrados en pÃ¡gina', pageNum, ':', chapterElements.length);

        for (const elem of chapterElements) {
          const text = await elem.textContent();
          const href = await elem.getAttribute('href');
          if (!href) continue;

          const cleanText = text ? text.replace(/\s+/g, ' ').trim() : '';
          if (!matchesChapterText(cleanText, chapterStartToken, href)) continue;

          chapterLink = href.startsWith('http') ? href : new URL(href, siteOrigin).toString();
          console.error('[PREVIEW] Coincidencia capítulo único:', chapterLink);
          break;
        }
      }

      if (!chapterLink) {
        console.error('[PREVIEW] âš ï¸ No se encontrÃ³ el capÃ­tulo, usando pÃ¡gina de capÃ­tulos');
        chapterLink = chaptersUrl;
      }
    } else {
      // Para rangos/mÃºltiples capÃ­tulos, usar siempre la lista de capÃ­tulos.
      chapterLink = chaptersUrl;
      console.error('[PREVIEW] Rango detectado, usando enlace general de capÃ­tulos:', chapterLink);
    }

    // Si no encontrÃ³ enlace, usar la pÃ¡gina de capÃ­tulos sin pÃ¡gina especÃ­fica
    if (!chapterLink) {
      chapterLink = chaptersUrl;
      console.error('[PREVIEW] âš ï¸ Usando URL de capÃ­tulos por defecto:', chapterLink);
    }

    const message = `${chapterRange} del ${type} "${cleanTitle}" ya esta disponible y traducido al español, leer ahora: ${chapterLink}.`;

    // Devolver JSON con la informaciÃ³n
    const result = {
      title: cleanTitle,
      type,
      message,
      chapterRange,
      imageBase64: imageBase64 || null,
      success: true
    };

    console.error('[PREVIEW] Generando resultado final...');
    console.error('[PREVIEW] - TÃ­tulo:', cleanTitle);
    console.error('[PREVIEW] - Tipo:', type);
    console.error('[PREVIEW] - Mensaje:', message);
    console.error('[PREVIEW] - Tiene imagen:', !!imageBase64);

    // IMPORTANTE: Usar console.log para el resultado (stdout), no console.error
    console.log(JSON.stringify(result));
    console.error('[PREVIEW] âœ… Resultado enviado');

  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
  } finally {
    await browser.close();
  }
}

generatePreview().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
