# AnimeBBG XenForo Uploader (Node.js)

Este proyecto es un port del script Python a Node.js con Playwright.

## Qué mantiene del Python
- Lee credenciales y configuración de `.env` (usuario/contraseña obligatorios).
- Pide por consola SOLO inputs dinámicos si faltan: `RESOURCE_URL` (obra) y `PROJECT_BASE_DIR` (root).
- `CHAPTERS_LIST_URL` se deriva como `<RESOURCE_URL>/capitulos` si no se especifica.
- Reusa sesión con `STORAGE_STATE` (default `cookies.json`) para no iniciar sesión cada corrida.
- Sube imágenes por lotes (`BATCH_UPLOAD_SIZE`) con espera entre lotes.
- Antes de subir, cuenta imágenes guardadas y sube solo las faltantes.
- Reintenta Guardar ante toasts/Cloudflare.
- Verificación opcional via XenForo API si configuras `XENFORO_API_KEY`.

## Instalación
```bash
npm install
npx playwright install chromium
```

## Uso
```bash
npm start
```

Opciones:
- `--resource <url>`
- `--chapters-url <url>`
- `--root <ruta>`
- `--chapters "12,12.5,13"`
- `--parallel 3`
- `--save-retries 3`
- `--save-window 120`
- `--verify-retries 1`

## .env mínimo
Ver `.env.example`.