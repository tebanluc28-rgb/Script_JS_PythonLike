@echo off
setlocal EnableExtensions
chcp 65001 >nul

echo ========================================
echo  Construyendo portable 1-03-26 (sin Node)
echo ========================================
echo.

set "ROOT=%~dp0"
set "DIST_DIR=%ROOT%dist"
set "OUT_DIR=%DIST_DIR%\AnimeBBG-Portable-1-03-26"
set "PW_PATH=%ROOT%pw-browsers"
set "NODE_PORTABLE_DIR=%ROOT%nodejs-portable"
set "NODE_LOCAL=%NODE_PORTABLE_DIR%\node.exe"
set "NODE_PORTABLE_VERSION=20.19.0"

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

echo [1/8] Verificando Node portable...
if not exist "%NODE_LOCAL%" (
  echo [INFO] Node portable no existe. Descargando v%NODE_PORTABLE_VERSION%...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$v='%NODE_PORTABLE_VERSION%';" ^
    "$root='%ROOT%';" ^
    "$zip=Join-Path $root ('node-v'+$v+'-win-x64.zip');" ^
    "$url='https://nodejs.org/dist/v'+$v+'/node-v'+$v+'-win-x64.zip';" ^
    "Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip;" ^
    "$tmp=Join-Path $root 'dist\node-portable-tmp';" ^
    "if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp };" ^
    "Expand-Archive -Path $zip -DestinationPath $tmp -Force;" ^
    "$src=Join-Path $tmp ('node-v'+$v+'-win-x64');" ^
    "$dst=Join-Path $root 'nodejs-portable';" ^
    "if (Test-Path $dst) { Remove-Item -Recurse -Force $dst };" ^
    "Move-Item -Path $src -Destination $dst;" ^
    "Remove-Item -Force $zip;" ^
    "Remove-Item -Recurse -Force $tmp;"
  if errorlevel 1 (
    echo [ERROR] No se pudo descargar/preparar Node portable.
    exit /b 1
  )
)
if not exist "%NODE_LOCAL%" (
  echo [ERROR] node.exe portable no encontrado.
  exit /b 1
)
echo [OK] Node portable listo: %NODE_LOCAL%

echo [2/8] Instalando dependencias runtime...
if not exist "%NODE_PORTABLE_DIR%\node_modules\npm\bin\npm-cli.js" (
  echo [ERROR] npm-cli.js no encontrado en Node portable.
  exit /b 1
)
if exist "%ROOT%package-lock.json" (
  call "%NODE_LOCAL%" "%NODE_PORTABLE_DIR%\node_modules\npm\bin\npm-cli.js" ci --omit=dev
) else (
  call "%NODE_LOCAL%" "%NODE_PORTABLE_DIR%\node_modules\npm\bin\npm-cli.js" install --omit=dev
)
if errorlevel 1 (
  echo [ERROR] Fallo instalacion de dependencias.
  exit /b 1
)

echo [3/8] Instalando Chromium de Playwright local...
set "PLAYWRIGHT_BROWSERS_PATH=%PW_PATH%"
if not exist "%PW_PATH%" mkdir "%PW_PATH%"
call "%NODE_LOCAL%" "%ROOT%node_modules\playwright\cli.js" install chromium
if errorlevel 1 (
  echo [ERROR] Fallo instalacion de Chromium.
  exit /b 1
)
echo [OK] Chromium listo en %PW_PATH%

echo [4/8] Preparando carpeta de salida...
if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
mkdir "%OUT_DIR%"
mkdir "%OUT_DIR%\storage"
mkdir "%OUT_DIR%\storage\incoming"
mkdir "%OUT_DIR%\storage\incoming\obras"

echo [5/8] Copiando archivos del proyecto...
copy "%ROOT%package.json" "%OUT_DIR%\" >nul
if exist "%ROOT%package-lock.json" copy "%ROOT%package-lock.json" "%OUT_DIR%\" >nul

(
  echo BASE_URL=https://animebbg.net
  echo.
  echo # Credenciales del sitio ^(rellenar en el panel^)
  echo SITE_USERNAME=
  echo SITE_PASSWORD=
  echo.
  echo # Ejecucion estable para entornos compartidos
  echo HEADLESS=true
  echo LOCALE=es-ES
  echo TIMEOUT_MS=45000
  echo SLOW_MO_MS=0
  echo PARALLEL=1
  echo QUEUE_UPLOADS=1
  echo BATCH_UPLOAD_SIZE=15
  echo SLEEP_BETWEEN_BATCH_MS=400
  echo MAX_PER_CHAPTER=90
  echo SAVE_MAX_RETRIES=3
  echo SAVE_MAX_WINDOW_S=120
  echo VERIFY_RETRIES=1
  echo STORAGE_STATE=cookies.json
  echo.
  echo # Web server
  echo PORT=3000
  echo LISTEN_HOST=127.0.0.1
  echo WEB_STORAGE_DIR=storage
  echo COOKIE_SECURE=0
  echo MAX_UPLOAD_MB=2048
  echo.
  echo # XenForo API ^(opcional^)
  echo XENFORO_API_KEY=
  echo XENFORO_API_USER=
) > "%OUT_DIR%\.env"

copy "%ROOT%web_server.js" "%OUT_DIR%\" >nul
copy "%ROOT%uploader_xf_animebbg2.js" "%OUT_DIR%\" >nul
copy "%ROOT%notification_publisher.js" "%OUT_DIR%\" >nul
copy "%ROOT%notification_preview.js" "%OUT_DIR%\" >nul
copy "%ROOT%drive_download.js" "%OUT_DIR%\" >nul

xcopy "%ROOT%public" "%OUT_DIR%\public\" /E /I /Y >nul
xcopy "%ROOT%node_modules" "%OUT_DIR%\node_modules\" /E /I /Y >nul
xcopy "%ROOT%pw-browsers" "%OUT_DIR%\pw-browsers\" /E /I /Y >nul
xcopy "%ROOT%nodejs-portable" "%OUT_DIR%\nodejs-portable\" /E /I /Y >nul

echo [6/8] Creando lanzadores...
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
echo if not defined LOCALE set "LOCALE=es-ES"
echo if not defined TZ set "TZ=America/Mexico_City"
echo if not defined HEADLESS set "HEADLESS=true"
echo cd /d "%%ROOT%%"
echo start "" http://localhost:3000
echo "%%NODE%%" "%%ROOT%%web_server.js"
echo if errorlevel 1 ^(
echo   echo.
echo   echo [ERROR] El servidor termino con error %%errorlevel%%.
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
echo set "LOCALE=es-ES"
echo set "TZ=America/Mexico_City"
echo set "HEADLESS=false"
echo set "DEBUG=1"
echo cd /d "%%ROOT%%"
echo start "" http://localhost:3000
echo "%%NODE%%" "%%ROOT%%web_server.js"
echo if errorlevel 1 pause
) > "%OUT_DIR%\INICIAR-ANIMEBBG-DEBUG.bat"

(
echo @echo off
echo start "" "http://localhost:3000"
) > "%OUT_DIR%\ABRIR-PANEL.bat"

echo [7/8] Escribiendo guia de uso...
(
echo =====================================
echo AnimeBBG Uploader - Portable 1-03-26
echo =====================================
echo.
echo Esta version ya incluye todo:
echo - Node.js portable
echo - Dependencias npm
echo - Chromium de Playwright
echo.
echo USO PARA EL USUARIO FINAL:
echo 1. Descomprimir esta carpeta
echo 2. Ejecutar INICIAR-ANIMEBBG.bat
echo 3. Usar el panel en http://localhost:3000
echo 4. Si falla en otra PC, usar INICIAR-ANIMEBBG-DEBUG.bat y compartir logs/
echo.
echo No necesita instalar Node.js ni ejecutar npm.
echo.
echo Carpeta para capitulos:
echo storage\incoming\obras\
) > "%OUT_DIR%\LEEME.txt"

echo [8/8] Creando ZIP distribuible...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$out='%OUT_DIR%';" ^
  "$parent=Split-Path $out -Parent;" ^
  "$zip='%DIST_DIR%\AnimeBBG-Portable-1-03-26.zip';" ^
  "if (Test-Path $zip) { Remove-Item -Force $zip };" ^
  "Compress-Archive -Path $out -DestinationPath $zip -Force;"
if errorlevel 1 (
  echo [WARN] No se pudo crear ZIP automatico. La carpeta portable si fue creada.
)

echo.
echo ========================================
echo  PORTABLE 1-03-26 LISTO
echo ========================================
echo Carpeta: %OUT_DIR%
echo ZIP:     %DIST_DIR%\AnimeBBG-Portable-1-03-26.zip
echo.
echo Comparte el ZIP y el usuario solo ejecuta INICIAR-ANIMEBBG.bat
echo.
endlocal
