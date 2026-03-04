# AnimeBBG Uploader

Sistema de subida automatizada de capitulos a AnimeBBG.

## Opcion recomendada: Portable 1-03-26 (sin instalar Node)

### Para crear el paquete distribuible (recomendado)

Ejecuta:

```bat
build-portable-full.bat
```

Salida esperada:

- `dist\AnimeBBG-Portable-1-03-26\`
- `dist\AnimeBBG-Portable-1-03-26.zip`

El paquete incluye:

- Node.js portable
- `node_modules` (runtime)
- Chromium de Playwright en `pw-browsers`
- lanzador `INICIAR-ANIMEBBG.bat`
- lanzador de diagnostico `INICIAR-ANIMEBBG-DEBUG.bat`
- `.env` portable con defaults estables para compartir

### Para el usuario final

1. Descomprimir `AnimeBBG-Portable-1-03-26.zip`
2. Ejecutar `INICIAR-ANIMEBBG.bat`
3. Usar el panel en `http://localhost:3000`

No necesita instalar Node.js, npm ni Playwright.

Si en otra PC aparece un error de automatizacion, ejecutar `INICIAR-ANIMEBBG-DEBUG.bat` y revisar `logs/` y `_debug/`.

## Opcion secundaria: entorno de desarrollo con Node

Requisitos:

- Node.js 18+

Instalacion:

```bat
npm install
npx playwright install chromium
```

Ejecucion:

```bat
npm start
```

## Estructura de archivos para subir

Coloca tus obras en:

`storage\incoming\obras\`

Ejemplo:

```text
storage/incoming/obras/ruri-dragon/capitulo 1/001.jpg
storage/incoming/obras/ruri-dragon/capitulo 1/002.jpg
storage/incoming/obras/ruri-dragon/capitulo 2/001.jpg
```

## Compartir con otros

1. Ejecuta `build-portable-full.bat`
2. Comparte `dist\AnimeBBG-Portable-1-03-26.zip`
3. El receptor solo ejecuta `INICIAR-ANIMEBBG.bat`

## Scripts npm

- `npm run build` -> crea portable 1-03-26 (flujo oficial)
- `npm run build:portable` -> igual que `build`
- `npm run build:exe` -> legado con `pkg` (no recomendado)
