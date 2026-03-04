@echo off
setlocal
chcp 65001 >nul

echo ========================================
echo  build-portable.bat
echo ========================================
echo Este script ahora usa el empaquetado 1-03-26.
echo.

call "%~dp0build-portable-full.bat"
set "ERR=%ERRORLEVEL%"

if not "%ERR%"=="0" (
  echo.
echo [ERROR] El empaquetado 1-03-26 fallo con codigo %ERR%.
  exit /b %ERR%
)

echo.
echo [OK] Empaquetado terminado.
endlocal
