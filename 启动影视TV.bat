@echo off
setlocal
cd /d "%~dp0"

set "ELECTRON=node_modules\electron\dist\electron.exe"

if exist "%ELECTRON%" goto :launch

echo First run: installing desktop runtime (1-2 minutes)...
call npm install --no-fund --no-audit
if exist "%ELECTRON%" goto :launch

echo Trying local electron cache...
powershell -NoProfile -Command "Expand-Archive -Force -Path \"$env:LOCALAPPDATA\electron\Cache\503bc5800d2c74b70eecdd0422ba25b13b1670c4c9b7ef85a9a997f7c9c28c4a\electron-v33.4.11-win32-x64.zip\" -DestinationPath 'node_modules\electron\dist'" 2>nul
echo electron.exe> node_modules\electron\path.txt
if exist "%ELECTRON%" goto :launch

echo.
echo [ERROR] Electron runtime not found. Run: npm install
pause
exit /b 1

:launch
start "" "%ELECTRON%" .
exit /b 0
