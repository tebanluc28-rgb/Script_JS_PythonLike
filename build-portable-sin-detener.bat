@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0"
set "DIST_DIR=%ROOT%dist"
set "STAMP=%DATE:~-4,4%-%DATE:~3,2%-%DATE:~0,2%_%TIME:~0,2%%TIME:~3,2%"
set "STAMP=%STAMP: =0%"
set "OUT_DIR=%DIST_DIR%\AnimeBBG-Portable-Snapshot-%STAMP%"
set "ZIP_PATH=%DIST_DIR%\AnimeBBG-Portable-Snapshot-%STAMP%.zip"

set "NODE_PORTABLE_DIR=%ROOT%nodejs-portable"
set "NODE_EXE=%NODE_PORTABLE_DIR%\node.exe"
set "PW_DIR=%ROOT%pw-browsers"
set "NPM_MODULES=%ROOT%node_modules"
set "STORAGE_DIR=%ROOT%storage"
set "LOGS_DIR=%ROOT%logs"

echo ==============================================
echo  AnimeBBG portable sin detener ejecucion
echo ==============================================
echo.
echo Este proceso NO modifica tu instalacion actual.
echo Solo crea un snapshot portable para compartir.
echo.

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

echo [1/8] Verificando runtime local...
if not exist "%NODE_EXE%" (
  echo [ERROR] Falta Node portable: %NODE_EXE%
  echo         Recomendado: ejecutar primero build-portable-full.bat una sola vez.
  exit /b 1
)
if not exist "%NPM_MODULES%" (
  echo [ERROR] Falta node_modules. No se puede crear snapshot autocontenido.
  exit /b 1
)
if not exist "%PW_DIR%" (
  echo [ERROR] Falta carpeta pw-browsers.
  echo         Ejecuta una vez: npx playwright install chromium
  exit /b 1
)
echo [OK] Runtime encontrado.

echo [2/8] Preparando carpeta destino...
if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
mkdir "%OUT_DIR%"
mkdir "%OUT_DIR%\storage"
mkdir "%OUT_DIR%\storage\incoming"
mkdir "%OUT_DIR%\storage\incoming\obras"
mkdir "%OUT_DIR%\logs"

echo [3/8] Copiando archivos de aplicacion...
for %%F in (
  "package.json"
  "package-lock.json"
  "web_server.js"
  "uploader_xf_animebbg2.js"
  "notification_publisher.js"
  "notification_preview.js"
  "drive_download.js"
  "README.md"
  ".env"
  ".env.example"
  "secrets.json"
  "cookies.json"
  "queue_state.json"
) do (
  if exist "%ROOT%%%~F" copy "%ROOT%%%~F" "%OUT_DIR%\" >nul
)

if not exist "%OUT_DIR%\.env" (
  if exist "%OUT_DIR%\.env.example" (
    copy "%OUT_DIR%\.env.example" "%OUT_DIR%\.env" >nul
  ) else (
    (
      echo BASE_URL=https://animebbg.net
      echo SITE_USERNAME=
      echo SITE_PASSWORD=
      echo PORT=3000
      echo LISTEN_HOST=127.0.0.1
      echo HEADLESS=true
      echo LOCALE=es-ES
      echo TIMEOUT_MS=45000
      echo PLAYWRIGHT_BROWSERS_PATH=./pw-browsers
    ) > "%OUT_DIR%\.env"
  )
)

echo [4/8] Copiando public/...
robocopy "%ROOT%public" "%OUT_DIR%\public" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo [ERROR] Fallo copiando public/
  exit /b 1
)

echo [5/8] Copiando runtimes (puede tardar)...
robocopy "%NODE_PORTABLE_DIR%" "%OUT_DIR%\nodejs-portable" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo [ERROR] Fallo copiando nodejs-portable/
  exit /b 1
)
robocopy "%NPM_MODULES%" "%OUT_DIR%\node_modules" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo [ERROR] Fallo copiando node_modules/
  exit /b 1
)
robocopy "%PW_DIR%" "%OUT_DIR%\pw-browsers" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo [ERROR] Fallo copiando pw-browsers/
  exit /b 1
)

echo [6/8] Copiando estructura de datos minima...
if exist "%STORAGE_DIR%\incoming\obras" (
  robocopy "%STORAGE_DIR%\incoming\obras" "%OUT_DIR%\storage\incoming\obras" /E /NFL /NDL /NJH /NJS /NC /NS >nul
  if errorlevel 8 (
    echo [ERROR] Fallo copiando storage/incoming/obras
    exit /b 1
  )
)
if exist "%LOGS_DIR%" (
  robocopy "%LOGS_DIR%" "%OUT_DIR%\logs" *.log /E /NFL /NDL /NJH /NJS /NC /NS >nul
)

echo [7/8] Creando lanzadores...
(
echo @echo off
echo setlocal
echo chcp 65001 ^>nul
echo title AnimeBBG Uploader - Portable
echo set "ROOT=%%~dp0"
echo set "NODE=%%ROOT%%nodejs-portable\node.exe"
echo set "PLAYWRIGHT_BROWSERS_PATH=%%ROOT%%pw-browsers"
echo set "APP_ROOT=%%ROOT%%"
echo set "DATA_DIR=%%ROOT%%"
echo if not defined TZ set "TZ=America/Mexico_City"
echo if not defined LOCALE set "LOCALE=es-ES"
echo cd /d "%%ROOT%%"
echo start "" http://localhost:3000
echo "%%NODE%%" "%%ROOT%%web_server.js"
echo if errorlevel 1 ^(
echo   echo.
echo   echo [ERROR] El servidor termino con codigo %%errorlevel%%.
echo   pause
echo ^)
) > "%OUT_DIR%\INICIAR-ANIMEBBG.bat"

(
echo @echo off
echo setlocal
echo chcp 65001 ^>nul
echo title AnimeBBG Uploader - Portable ^(DEBUG^)
echo set "ROOT=%%~dp0"
echo set "NODE=%%ROOT%%nodejs-portable\node.exe"
echo set "PLAYWRIGHT_BROWSERS_PATH=%%ROOT%%pw-browsers"
echo set "APP_ROOT=%%ROOT%%"
echo set "DATA_DIR=%%ROOT%%"
echo set "HEADLESS=false"
echo set "DEBUG=1"
echo set "TZ=America/Mexico_City"
echo set "LOCALE=es-ES"
echo cd /d "%%ROOT%%"
echo start "" http://localhost:3000
echo "%%NODE%%" "%%ROOT%%web_server.js"
echo if errorlevel 1 pause
) > "%OUT_DIR%\INICIAR-ANIMEBBG-DEBUG.bat"

(
echo =====================================
echo AnimeBBG Uploader - Portable Snapshot
echo =====================================
echo.
echo Este paquete ya incluye:
echo - Node portable
echo - Dependencias npm
echo - Chromium de Playwright
echo - Configuracion y sesion actual
echo.
echo Uso:
echo 1. Descomprimir el ZIP completo
echo 2. Ejecutar INICIAR-ANIMEBBG.bat
echo 3. Abrir http://localhost:3000
echo.
echo No requiere instalar Node, npm, Playwright ni configurar nada.
) > "%OUT_DIR%\LEEME.txt"

echo [8/8] Generando ZIP...
if exist "%ZIP_PATH%" del /f /q "%ZIP_PATH%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Compress-Archive -Path '%OUT_DIR%' -DestinationPath '%ZIP_PATH%' -Force;"
if errorlevel 1 (
  echo [WARN] No se pudo crear ZIP. La carpeta portable si fue creada.
)

echo.
echo ==============================================
echo  Snapshot portable listo
echo ==============================================
echo Carpeta: %OUT_DIR%
echo ZIP:     %ZIP_PATH%
echo.
echo Se genero sin reinstalar nada en tu entorno activo.
echo.
endlocal
