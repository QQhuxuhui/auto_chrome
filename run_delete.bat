@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Delete Family Members
color 0C

set "ROOT=%~dp0"
set "SRC=%ROOT%src\"

echo.
echo  ===========================================================
echo.
echo    Delete Family Members
echo    Logs in as each host and clears every non-manager member
echo    (real members AND pending invitations)
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

for /f %%v in ('node -p "process.versions.node.split(String.fromCharCode(46))[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 18 (
    echo  ERROR: Node.js ^>= 18 required ^(found v%NODE_MAJOR%^).
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

:: ==== Run ====
cd /d "%SRC%"
node delete_members.js %*
set "EXITCODE=%errorlevel%"
cd /d "%ROOT%"

echo.
echo  ===========================================================
echo    Finished (exit %EXITCODE%).
echo  ===========================================================
echo.
pause
exit /b %EXITCODE%
