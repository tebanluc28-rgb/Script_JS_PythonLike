@echo off
title AnimeBBG Uploader - Instalacion Rapida
color 0A

echo.
echo  ========================================
echo    AnimeBBG Uploader - Instalador
echo  ========================================
echo.

REM Verificar Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado
    echo.
    echo Descargalo desde: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js encontrado:
node --version
echo.

REM Instalar dependencias
echo [1/2] Instalando dependencias...
call npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] No se pudieron instalar las dependencias
    pause
    exit /b 1
)

echo.
echo [2/2] Instalando Playwright Chromium...
call npx playwright install chromium

echo.
echo  ========================================
echo    INSTALACION COMPLETADA!
echo  ========================================
echo.
echo  Para iniciar el servidor:
echo    npm start
echo.
echo  Luego abre: http://localhost:3000
echo.
pause
