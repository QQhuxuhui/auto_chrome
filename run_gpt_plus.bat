@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title GPT Plus - Register OpenAI Accounts
color 0A

set "ROOT=%~dp0"
set "SRC=%ROOT%src\"

echo.
echo  ===========================================================
echo.
echo    GPT Plus Account Registration
echo    Register OpenAI OAuth accounts in sub2api
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
    echo  Expected keys: url, api_key
    pause
    exit /b 1
)

if not exist "%ROOT%plus.txt" (
    echo  ERROR: plus.txt not found in project root.
    echo  Format per line: email----password--totp_secret
    pause
    exit /b 1
)

:: ==== Run ====
cd /d "%SRC%"
node 6_gpt_plus.js %EXTRA_ARGS%

echo.
echo  ===========================================================
echo    GPT Plus finished.
echo  ===========================================================
echo.
cd /d "%ROOT%"
pause
