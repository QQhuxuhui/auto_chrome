@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Sub2API - Add Accounts & OAuth
color 0A

set "ROOT=%~dp0"
set "SRC=%ROOT%src\"

echo.
echo  ===========================================================
echo.
echo    Sub2API Account Management
echo    Add accounts and complete OAuth authorization
echo.
echo  ===========================================================
echo.

:: ==== Parse arguments ====
set "EXTRA_ARGS="

:parse_args
if "%~1"=="" goto :done_parse
set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
shift
goto :parse_args
:done_parse

:: ==== Check Node.js ====
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found.
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

:: ==== Check required files ====
if not exist "%ROOT%sub2api.txt" (
    echo  ERROR: sub2api.txt not found in project root.
    echo  Create it with email on line 1, password on line 2.
    pause
    exit /b 1
)

if not exist "%ROOT%members.txt" (
    echo  ERROR: members.txt not found in project root.
    pause
    exit /b 1
)

:: ==== Run ====
cd /d "%SRC%"
node 5_sub2api.js %EXTRA_ARGS%

echo.
echo  ===========================================================
echo    Sub2API finished.
echo  ===========================================================
echo.
cd /d "%ROOT%"
pause
