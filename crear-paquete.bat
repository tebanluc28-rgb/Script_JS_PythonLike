@echo off
chcp 65001 >nul
echo ========================================
echo  Empaquetador AnimeBBG Uploader
echo ========================================
echo.

REM Crear carpeta de distribución
set DIST_DIR=AnimeBBG-Uploader-Pack
if exist "%DIST_DIR%" (
    echo Eliminando paquete anterior...
    rmdir /s /q "%DIST_DIR%"
)

echo Creando estructura de directorios...
mkdir "%DIST_DIR%"
mkdir "%DIST_DIR%\storage"
mkdir "%DIST_DIR%\storage\incoming"
mkdir "%DIST_DIR%\storage\incoming\obras"

REM Copiar archivos esenciales
echo Copiando archivos del proyecto...
copy "package.json" "%DIST_DIR%\" >nul
copy "package-lock.json" "%DIST_DIR%\" >nul 2>nul
copy "web_server.js" "%DIST_DIR%\" >nul
copy "uploader_xf_animebbg2.js" "%DIST_DIR%\" >nul
copy "notification_publisher.js" "%DIST_DIR%\" >nul
copy "notification_preview.js" "%DIST_DIR%\" >nul
copy "drive_download.js" "%DIST_DIR%\" >nul
copy "README.md" "%DIST_DIR%\" >nul

REM Copiar carpeta public
echo Copiando interfaz web...
xcopy /E /I /Y "public" "%DIST_DIR%\public" >nul

REM Crear archivo .env de ejemplo
echo Creando archivo de configuración...
(
echo # Configuracion AnimeBBG Uploader
echo.
echo # Puerto del servidor web
echo PORT=3000
echo.
echo # Host ^(0.0.0.0 permite acceso desde otras computadoras^)
echo LISTEN_HOST=0.0.0.0
echo.
echo # Tamano maximo de subida en MB
echo MAX_UPLOAD_MB=2048
echo.
echo # Credenciales ^(opcional - tambien se configuran en la interfaz^)
echo # SITE_USERNAME=tu_usuario
echo # SITE_PASSWORD=tu_contraseña
) > "%DIST_DIR%\.env"

REM Crear archivo de instrucciones
echo Creando instrucciones...
(
echo =====================================
echo  AnimeBBG Uploader - Instrucciones
echo =====================================
echo.
echo INSTALACION:
echo.
echo 1. Instalar Node.js 18 o superior
echo    Descargar de: https://nodejs.org/
echo.
echo 2. Abrir terminal/CMD en esta carpeta
echo.
echo 3. Ejecutar:
echo    npm install
echo.
echo 4. Iniciar el servidor:
echo    node web_server.js
echo.
echo 5. Abrir navegador en:
echo    http://localhost:3000
echo.
echo =====================================
echo  USO:
echo =====================================
echo.
echo 1. Coloca tus carpetas de manga en:
echo    storage/incoming/obras/
echo.
echo 2. Estructura requerida:
echo    MiManga/
echo      Capitulo 1/
echo        001.jpg
echo        002.jpg
echo      Capitulo 2/
echo        001.jpg
echo.
echo 3. Abre la interfaz web y configura:
echo    - Usuario y contraseña de AnimeBBG
echo    - URL de la obra
echo    - Ruta a la carpeta
echo    - Rango de capitulos ^(opcional^)
echo.
echo 4. Click en "Iniciar Subida"
echo.
echo =====================================
echo  NOTAS:
echo =====================================
echo.
echo - Las credenciales se guardan automaticamente
echo - Puedes encolar multiples obras
echo - El sistema verifica automaticamente las subidas
echo - Las notificaciones se pueden publicar automaticamente
echo.
echo =====================================
) > "%DIST_DIR%\INSTRUCCIONES.txt"

REM Crear script de instalación
echo Creando script de instalacion...
(
echo @echo off
echo chcp 65001 ^>nul
echo echo ========================================
echo echo  Instalando AnimeBBG Uploader
echo echo ========================================
echo echo.
echo echo Instalando dependencias...
echo npm install
echo echo.
echo echo Instalando Chromium...
echo npx playwright install chromium
echo echo.
echo echo ========================================
echo echo  Instalacion completada!
echo echo ========================================
echo echo.
echo echo Para iniciar el servidor ejecuta:
echo echo   node web_server.js
echo echo.
echo echo O simplemente ejecuta:
echo echo   INICIAR.bat
echo echo.
echo pause
) > "%DIST_DIR%\INSTALAR.bat"

REM Crear script de inicio rápido
echo Creando script de inicio...
(
echo @echo off
echo chcp 65001 ^>nul
echo echo ========================================
echo echo  Iniciando AnimeBBG Uploader
echo echo ========================================
echo echo.
echo echo Servidor iniciando en http://localhost:3000
echo echo.
echo echo Presiona Ctrl+C para detener el servidor
echo echo ========================================
echo echo.
echo node web_server.js
) > "%DIST_DIR%\INICIAR.bat"

REM Crear .gitignore para el paquete
(
echo node_modules/
echo storage/*
echo !storage/incoming/
echo !storage/incoming/obras/
echo !storage/incoming/obras/.gitkeep
echo secrets.json
echo cookies.json
echo storage_*.json
echo *.png
echo .env.local
) > "%DIST_DIR%\.gitignore"

REM Crear .gitkeep en obras
echo. > "%DIST_DIR%\storage\incoming\obras\.gitkeep"

echo.
echo ========================================
echo  Paquete creado exitosamente!
echo ========================================
echo.
echo Ubicacion: %DIST_DIR%\
echo.
echo Para compartir:
echo 1. Comprime la carpeta "%DIST_DIR%"
echo 2. Comparte el archivo ZIP
echo.
echo El usuario solo necesita:
echo 1. Descomprimir
echo 2. Ejecutar INSTALAR.bat
echo 3. Ejecutar INICIAR.bat
echo.
pause
