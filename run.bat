@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\puppeteer-core\package.json" (
    call npm ci
    if errorlevel 1 exit /b 1
)
node src\login_only.js %*
if errorlevel 1 (
    pause
    exit /b 1
)
