@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Stage 3: Add Accounts to sub2api
color 0A

set "ROOT=%~dp0"
set "SRC=%ROOT%src\"

echo.
echo  ===========================================================
echo.
echo    Stage 3: Add Accounts to sub2api
echo.
echo  ===========================================================
echo.

:: ==== Check Node.js ====
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Run run.bat first to install.
    pause
    exit /b 1
)

:: ==== Check dependencies ====
if not exist "%SRC%node_modules\puppeteer-core" (
    echo  Installing dependencies...
    cd /d "%SRC%"
    call npm install --no-fund --no-audit 2>&1
    cd /d "%ROOT%"
)

:: ==== Run Stage 3 ====
cd /d "%SRC%"
node 3_add_sub2api.js %*

echo.
echo  ===========================================================
echo    Stage 3 finished.
echo  ===========================================================
echo.
cd /d "%ROOT%"
pause
