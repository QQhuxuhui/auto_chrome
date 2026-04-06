@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Gemini Family Pipeline
color 0A

set "ROOT=%~dp0"
set "SRC=%ROOT%src\"

echo.
echo  ===========================================================
echo.
echo    Gemini Family Group Pipeline
echo    2-Stage Automation (Invite + Accept)
echo.
echo  ===========================================================
echo.

:: ==== Parse arguments ====
set "STAGE="
set "EXTRA_ARGS="
set "RUN_ALL=1"

:parse_args
if "%~1"=="" goto :done_parse
if "%~1"=="--stage" (
    set "STAGE=%~2"
    set "RUN_ALL=0"
    shift
    shift
    goto :parse_args
)
set "EXTRA_ARGS=!EXTRA_ARGS! %~1"
shift
goto :parse_args
:done_parse

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

:: ==== Run stages ====
cd /d "%SRC%"

if "%RUN_ALL%"=="1" (
    echo  Running all 2 stages...
    echo.
    echo  ---- Stage 1: Send Family Invitations ----
    node 1_invite.js %EXTRA_ARGS%
    if %errorlevel% neq 0 echo  WARNING: Stage 1 had errors
    echo.
    echo  ---- Stage 2: Accept Family Invitations ----
    node 2_accept.js %EXTRA_ARGS%
    if %errorlevel% neq 0 echo  WARNING: Stage 2 had errors
) else (
    for %%s in (%STAGE%) do (
        echo  ---- Running Stage %%s ----
        if "%%s"=="1" node 1_invite.js %EXTRA_ARGS%
        if "%%s"=="2" node 2_accept.js %EXTRA_ARGS%
        echo.
    )
)

echo.
echo  ===========================================================
echo    Pipeline finished.
echo  ===========================================================
echo.
cd /d "%ROOT%"
pause
