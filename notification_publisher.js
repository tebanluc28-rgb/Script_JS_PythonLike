import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const url = args[0];
const chapterStartRaw = String(args[1] ?? "").trim().replace(',', '.');
const chapterEndRaw = String(args[2] ?? "").trim().replace(',', '.');
const username = args[3];
const password = args[4];
const useCustomImage = args[5] === 'true';
const customImagePath = args[6];

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

async function publishNotification() {
  const browser = await chromium.launch({
    headless: true  // No abrir ventana del navegador
  });

  // NO usar cookies guardadas, siempre hacer login con las credenciales proporcionadas
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Extraer ID de la obra desde la URL
    const match = url.match(/\.([0-9]+)\/?$/);
    if (!match) {
      throw new Error("No se pudo extraer el ID de la obra desde la URL.");
    }
    const workId = match[1];

    // Construir URL de post-update
    const urlParts = url.split('/comics/')[1];
    const workSlug = urlParts.split('/')[0].replace(/\.\d+$/, ''); // Remover .ID si ya existe
    const postUpdateUrl = `https://animebbg.net/comics/${workSlug}.${workId}/post-update`;

    // Login robusto (maneja redireccion a / y sesion ya activa)
    console.log("[NOTIF] Iniciando sesion...");
    const isLogged = async () => {
      return (await page.locator(".p-navgroup-link--user, .p-navgroup-link--account, a[href*='/logout']").count()) > 0;
    };

    await page.goto("https://animebbg.net/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);

    if (!(await isLogged())) {
      await page.goto("https://animebbg.net/login/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);

      if (!(await isLogged())) {
        const form = page.locator("form[action*='/login']").first();
        if (await form.count() === 0) {
          throw new Error("No encontre el formulario de login.");
        }

        const userInput = form.locator("input[name=login], input[name=username], #login, input[type=text]").first();
        const passInput = form.locator("input[name=password], #password, input[type=password]").first();

        if ((await userInput.count()) === 0 || (await passInput.count()) === 0) {
          throw new Error("No encontre campos de login/password.");
        }

        await userInput.fill(username);
        await passInput.fill(password);

        const remember = form.locator("input[name=remember], #remember, input[type=checkbox][name=remember]").first();
        try {
          if ((await remember.count()) && !(await remember.isChecked())) {
            await remember.check();
          }
        } catch {}

        let btn = form.getByRole("button", { name: /Iniciar sesi/i });
        if ((await btn.count()) === 0) {
          btn = form.locator("button[type=submit], input[type=submit]").first();
        }

        try {
          if ((await btn.count()) > 0) {
            await btn.first().click({ timeout: 3000 });
          } else {
            await passInput.press("Enter");
          }
        } catch {
          if ((await passInput.count()) > 0) {
            await passInput.press("Enter");
          }
        }

        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(1200);
      }
    }

    if ((await page.locator(".blockMessage.blockMessage--error, .formRow--error, .is-error").count()) > 0) {
      const err = await page.locator(".blockMessage.blockMessage--error, .formRow--error, .is-error").allInnerTexts();
      throw new Error(`Error de login: ${err.join(" | ")}`);
    }

    if (!(await isLogged())) {
      throw new Error("No se pudo confirmar sesion iniciada.");
    }

    console.log("[NOTIF] Login exitoso");

    // Navegar a la pÃ¡gina de la obra para extraer datos
    await page.goto(url);
    await page.waitForTimeout(2000);

    // Extraer tÃ­tulo y limpiar espacios/saltos de lÃ­nea
    const titleRaw = await page.locator('h1.p-title-value').textContent().catch(() => "");
    const title = titleRaw.replace(/\s+/g, ' ').trim();
    const cleanTitle = title
      .replace(/^(manga|manhwa|manhua)\s*[-:|]?\s*/i, '')
      .replace(/[.。]+$/g, '')
      .trim();

    // Extraer tipo (manga/manhwa/manhua) desde badge/tags/titulo
    let type = "manga";
    const tags = await page.locator('.tagItem a').allTextContents().catch(() => []);
    const badgeText = await page.locator('.label, .label--green, .label--primary').first().textContent().catch(() => "");
    const titleLower = title.toLowerCase();
    const badgeLower = String(badgeText || "").toLowerCase();

    if (badgeLower.includes("manhwa")) {
      type = "manhwa";
    } else if (badgeLower.includes("manhua")) {
      type = "manhua";
    } else if (tags.some(t => t.toLowerCase().includes("manhwa"))) {
      type = "manhwa";
    } else if (tags.some(t => t.toLowerCase().includes("manhua"))) {
      type = "manhua";
    } else if (titleLower.includes("manhwa")) {
      type = "manhwa";
    } else if (titleLower.includes("manhua")) {
      type = "manhua";
    }

    // Extraer imagen de portada
    let coverUrl = null;
    if (!useCustomImage) {
      try {
        const bannerCount = await page.locator('img[src*="resource_banner"]').count();
        if (bannerCount > 0) {
          coverUrl = await page.locator('img[src*="resource_banner"]').first().getAttribute('src');
        } else {
          const iconCount = await page.locator('img[src*="resource_icons"]').count();
          if (iconCount > 0) {
            coverUrl = await page.locator('img[src*="resource_icons"]').first().getAttribute('src');
          }
        }
      } catch (e) {
        // Ignorar error de imagen
      }
    }

    // Generar rango de capÃ­tulos
    const chapterStartToken = parseChapterToken(chapterStartRaw);
    const chapterEndToken = parseChapterToken(chapterEndRaw);
    if (!chapterStartToken || !chapterEndToken) {
      throw new Error("Capítulo inicial/final inválido.");
    }
    const chapterRange = formatChapterRangeLabel(chapterStartToken, chapterEndToken);


    // Navegar a la lista de capÃ­tulos para obtener la URL
    const chaptersUrl = url.endsWith('/') ? url + 'capitulos' : url + '/capitulos';
    const siteOrigin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return 'https://animebbg.net';
      }
    })();

    const findChapterLinkByToken = async (targetToken, maxPages = 8) => {
      console.log('[NOTIF] Buscando capítulo', formatChapterLabel(targetToken), 'desde página 1 (orden descendente por defecto).');

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const targetUrl = pageNum === 1 ? chaptersUrl : `${chaptersUrl}?page=${pageNum}`;
        console.log('[NOTIF] Buscando en pÃ¡gina', pageNum, ':', targetUrl);

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);

        const chapterElements = await page.locator('a[href*="/comics/capitulo/link/"], a[href*="/capitulo/link/"], a[href*="/comics/capitulo/"], a[href*="/capitulo/"]').all();
        console.log('[NOTIF] Enlaces encontrados en pÃ¡gina', pageNum, ':', chapterElements.length);

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
          console.log(`[NOTIF] Coincidencia ${formatChapterLabel(targetToken)} en página ${pageNum}: "${cleanText}" -> ${fullHref}`);
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
      console.log('[NOTIF] Buscando', formatChapterLabel(chapterStartToken), 'en páginas:', pagesToSearch);

      for (const pageNum of pagesToSearch) {
        if (chapterLink) break;
        const targetUrl = pageNum === 1 ? chaptersUrl : `${chaptersUrl}?page=${pageNum}`;
        console.log('[NOTIF] Buscando en pÃ¡gina', pageNum, ':', targetUrl);

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);

        const chapterElements = await page.locator('a[href*="/comics/capitulo/link/"], a[href*="/capitulo/link/"], a[href*="/comics/capitulo/"], a[href*="/capitulo/"]').all();
        console.log('[NOTIF] Enlaces encontrados en pÃ¡gina', pageNum, ':', chapterElements.length);

        for (const elem of chapterElements) {
          const text = await elem.textContent();
          const href = await elem.getAttribute('href');
          if (!href) continue;

          const cleanText = text ? text.replace(/\s+/g, ' ').trim() : '';
          if (!matchesChapterText(cleanText, chapterStartToken, href)) continue;

          chapterLink = href.startsWith('http') ? href : new URL(href, siteOrigin).toString();
          console.log('[NOTIF] Coincidencia capÃ­tulo Ãºnico:', chapterLink);
          break;
        }
      }

      if (!chapterLink) {
        console.log('[NOTIF] âš ï¸ No se encontrÃ³ el capÃ­tulo, usando pÃ¡gina de capÃ­tulos');
        chapterLink = chaptersUrl;
      }
    } else {
      // Para rangos/mÃºltiples capÃ­tulos, usar siempre la lista de capÃ­tulos.
      chapterLink = chaptersUrl;
      console.log('[NOTIF] Rango detectado, usando enlace general de capÃ­tulos:', chapterLink);
    }

    // Si no encontrÃ³ enlace, usar la pÃ¡gina de capÃ­tulos sin pÃ¡gina especÃ­fica
    if (!chapterLink) {
      chapterLink = chaptersUrl;
    }

    // Mensaje en texto plano (sin BBCode).
    const message = `${chapterRange} del ${type} "${cleanTitle}" ya esta disponible y traducido al español, leer ahora: ${chapterLink}.`;
    console.log("[NOTIF] Generando mensaje: " + chapterRange);

    // Navegar a post-update
    await page.goto(postUpdateUrl);
    await page.waitForTimeout(2000);

    // Llenar "Actualizar tÃ­tulo" con el rango de capÃ­tulos
    await page.waitForSelector('input[name="update_title"]', { timeout: 10000 });
    await page.fill('input[name="update_title"]', chapterRange);

    // Llenar mensaje con texto plano y crear hipervÃ­nculo
    const textBeforeLink = `${chapterRange} del ${type} "${cleanTitle}" ya esta disponible y traducido al espa\u00f1ol, `;
    const linkText = "leer ahora";
    const textAfter = ".";

    await page.waitForSelector('div.fr-element[contenteditable="true"], textarea[name="message"]', { timeout: 10000 });

    const editorCount = await page.locator('div.fr-element[contenteditable="true"]').count();

    if (editorCount > 0) {
      const editor = page.locator('div.fr-element[contenteditable="true"]').first();

      await editor.click();
      await page.waitForTimeout(300);

      const fullText = textBeforeLink + linkText + textAfter;
      await editor.fill('');
      await editor.type(fullText, { delay: 10 });
      await page.waitForTimeout(500);

        // Seleccionar "Capitulo X..." al inicio y aplicar negrita
        await page.evaluate((chapterRangeText) => {
          const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
          if (!editorDiv) return;

          const walker = document.createTreeWalker(editorDiv, NodeFilter.SHOW_TEXT, null);
          let node;

          while (node = walker.nextNode()) {
            const text = node.textContent || '';
            const index = text.indexOf(chapterRangeText);
            if (index === -1) continue;

            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + chapterRangeText.length);

            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return;
          }
        }, chapterRange);

      await page.waitForTimeout(250);
      await page.click('button[data-cmd="bold"], .fr-command[data-cmd="bold"]');
      await page.waitForTimeout(250);

        // Ahora seleccionar solo "leer ahora" usando triple-click y luego ajustar la selecciÃ³n
        await page.evaluate((linkText) => {
          const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
          if (!editorDiv) return;

          // Crear un TreeWalker para encontrar todos los nodos de texto
          const walker = document.createTreeWalker(
            editorDiv,
            NodeFilter.SHOW_TEXT,
            null
          );

          let node;
          let found = false;

          // Buscar el nodo de texto que contiene "leer ahora"
          while (node = walker.nextNode()) {
            const text = node.textContent;
            const index = text.indexOf(linkText);

            if (index !== -1) {
              // Crear un rango para seleccionar solo "leer ahora"
              const range = document.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + linkText.length);

              // Aplicar la selecciÃ³n
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              found = true;
              break;
            }
          }

          return found;
      }, linkText);

      await page.waitForTimeout(500);

      // Aplicar negrita
      await page.click('button[data-cmd="bold"], .fr-command[data-cmd="bold"]');
      await page.waitForTimeout(300);

      // Volver a seleccionar el texto
      await page.evaluate((linkText) => {
        const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
        if (!editorDiv) return;

        const walker = document.createTreeWalker(editorDiv, NodeFilter.SHOW_TEXT, null);
        let node;

        while (node = walker.nextNode()) {
          const text = node.textContent;
          const index = text.indexOf(linkText);

          if (index !== -1) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + linkText.length);

            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            break;
          }
        }
      }, linkText);

      await page.waitForTimeout(300);

      // Hacer clic en el botÃ³n de enlace
      await page.click('button[data-cmd="insertLink"], .fr-command[data-cmd="insertLink"]');
      await page.waitForTimeout(800);

      // Llenar el campo URL
      const urlInput = page.locator('input[placeholder*="URL"], .fr-link-insert-layer input[type="text"]').first();
      await urlInput.fill(chapterLink);
      await page.waitForTimeout(300);

      // Hacer clic en "Insertar"
      await page.click('button.fr-command[data-cmd="linkInsert"]');
      await page.waitForTimeout(800);

      // Volver a seleccionar el enlace para aplicar color naranja
      await page.evaluate((linkText) => {
        const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
        if (!editorDiv) return;

        // Buscar el enlace <a> que contiene "leer ahora"
        const links = editorDiv.querySelectorAll('a');
        for (const link of links) {
          if (link.textContent.includes(linkText)) {
            const range = document.createRange();
            range.selectNode(link);

            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            break;
          }
        }
      }, linkText);

      await page.waitForTimeout(300);

      // Aplicar color naranja #F37934 directamente
      await page.evaluate(() => {
        const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
        if (!editorDiv) return;

        const links = editorDiv.querySelectorAll('a');
        for (const link of links) {
          if (link.textContent.includes('leer ahora')) {
            link.style.color = '#F37934';
            break;
          }
        }
      });

      await page.waitForTimeout(300);

    } else {
      const textarea = page.locator('textarea[name="message"]').first();
      const fullMessage = message;
      await textarea.fill(fullMessage);
    }

    await page.waitForTimeout(500);

    // Procesar e insertar imagen
    if (!useCustomImage && coverUrl) {
      if (coverUrl.startsWith('//')) {
        coverUrl = 'https:' + coverUrl;
      } else if (coverUrl.startsWith('/')) {
        coverUrl = 'https://animebbg.net' + coverUrl;
      }

      // Insertar imagen directamente en el editor y centrarla
      await page.evaluate((imageUrl) => {
        const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
        if (!editorDiv) return;

        // Crear elemento de imagen centrado
        const imgContainer = document.createElement('div');
        imgContainer.style.textAlign = 'center';

        const img = document.createElement('img');
        img.src = imageUrl;
        img.style.maxWidth = '250px';
        img.style.display = 'inline-block';

        imgContainer.appendChild(img);

        // Insertar la imagen al final del contenido
        editorDiv.appendChild(document.createElement('br'));
        editorDiv.appendChild(imgContainer);

        // Disparar eventos
        editorDiv.dispatchEvent(new Event('input', { bubbles: true }));
      }, coverUrl);

      await page.waitForTimeout(1000);
    } else if (useCustomImage && customImagePath && fs.existsSync(customImagePath)) {
      // Para imagen personalizada, convertir a base64 e insertar
      const imageBuffer = fs.readFileSync(customImagePath);
      const imageBase64 = imageBuffer.toString('base64');

      await page.evaluate((base64) => {
        const editorDiv = document.querySelector('div.fr-element[contenteditable="true"]');
        if (!editorDiv) return;

        const imgContainer = document.createElement('div');
        imgContainer.style.textAlign = 'center';

        const img = document.createElement('img');
        img.src = `data:image/jpeg;base64,${base64}`;
        img.style.maxWidth = '250px';
        img.style.display = 'inline-block';

        imgContainer.appendChild(img);

        editorDiv.appendChild(document.createElement('br'));
        editorDiv.appendChild(imgContainer);

        editorDiv.dispatchEvent(new Event('input', { bubbles: true }));
      }, imageBase64);

      await page.waitForTimeout(1000);
    }

    // Publicar
    console.log("[NOTIF] Enviando...");

    const saveButton = page.locator('button.button--icon--save, button:has-text("Guardar")').first();
    const buttonCount = await saveButton.count();

    if (buttonCount > 0) {
      await saveButton.click();
    } else {
      const submitRow = page.locator('.formSubmitRow-controls button[type="submit"]').first();
      await submitRow.click();
    }

    await page.waitForTimeout(4000);
    console.log("[NOTIF] Publicacion exitosa");

  } catch (err) {
    console.error("[NOTIF] Error:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

publishNotification().catch(err => {
  console.error(err);
  process.exit(1);
});
