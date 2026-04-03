@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Antigravity Auth Tool v10
color 0A

set "ROOT=%~dp0"
set "SRC=%ROOT%src\"
set "ACCOUNTS="

echo.
echo  ===========================================================
echo.
echo    Antigravity Batch Auth Tool v10
echo    Environment Auto-Setup
echo.
echo  ===========================================================
echo.

:: ==== Step 0: Detect network environment ====
set "IS_CHINA=0"
set "NODE_URL=https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
set "NPM_MIRROR="
echo  [0/4] Detecting network environment ...
ping -n 1 -w 1500 baidu.com >nul 2>&1
set "BAIDU_OK=%errorlevel%"
ping -n 1 -w 1500 google.com >nul 2>&1
set "GOOGLE_OK=%errorlevel%"
if "!BAIDU_OK!"=="0" if "!GOOGLE_OK!" neq "0" (
    set "IS_CHINA=1"
    set "NODE_URL=https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-x64.msi"
    set "NPM_MIRROR=https://registry.npmmirror.com"
    echo         Detected: China network ^(using npmmirror.com^)
) else (
    echo         Detected: International network ^(using nodejs.org^)
)
echo.

:: ==== Step 1: Check Node.js ====
echo  [1/4] Checking Node.js ...
where node >nul 2>&1
if %errorlevel% neq 0 goto :install_node
for /f "tokens=*" %%v in ('node -v 2^>nul') do echo         OK - Node.js %%v
goto :step2

:install_node
echo         Node.js not found. Trying auto-install ...
echo.

:: ---- Method 1: winget (30s timeout) ----
echo         Method 1: winget (30s timeout) ...
where winget >nul 2>&1
if %errorlevel% neq 0 (
    echo         winget not available, skipping.
    goto :method2
)
start "winget_node" /B winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements >nul 2>&1
set /a WAITED=0
:winget_wait
timeout /t 5 /nobreak >nul 2>&1
set /a WAITED+=5
tasklist /FI "IMAGENAME eq winget.exe" 2>nul | find /i "winget.exe" >nul 2>&1
if !errorlevel! neq 0 (
    echo         winget finished.
    where node >nul 2>&1
    if !errorlevel! equ 0 goto :node_installed_restart
    set "PATH=%PATH%;C:\Program Files\nodejs"
    where node >nul 2>&1
    if !errorlevel! equ 0 goto :node_installed_restart
    echo         winget completed but node not found, trying next method ...
    goto :method2
)
echo         ... waiting for winget (%WAITED%s / 30s)
if %WAITED% lss 30 goto :winget_wait
echo         winget timed out (30s). Killing and switching to Method 2 ...
taskkill /F /IM winget.exe >nul 2>&1

:: ---- Method 2: Direct download with progress bar ----
:method2
echo.
echo         Method 2: Downloading installer with progress ...
if "!IS_CHINA!"=="1" (
    echo         Mirror: npmmirror.com
) else (
    echo         Source: nodejs.org
)
echo         URL: !NODE_URL!
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$ErrorActionPreference='Stop';^
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;^
$url='!NODE_URL!';^
$out='%TEMP%\node_setup.msi';^
try{^
  $uri=New-Object System.Uri($url);^
  $req=[System.Net.HttpWebRequest]::Create($uri);^
  $req.Timeout=15000;^
  $resp=$req.GetResponse();^
  $total=$resp.ContentLength;^
  $stream=$resp.GetResponseStream();^
  $fs=New-Object System.IO.FileStream($out,[System.IO.FileMode]::Create);^
  $buf=New-Object byte[] 65536;^
  $downloaded=0;$lastTime=[DateTime]::Now;$lastBytes=0;$speedStr='-- MB/s';^
  while(($n=$stream.Read($buf,0,$buf.Length)) -gt 0){^
    $fs.Write($buf,0,$n);^
    $downloaded+=$n;^
    $now=[DateTime]::Now;^
    $elapsed=($now-$lastTime).TotalSeconds;^
    if($elapsed -ge 1){^
      $speed=($downloaded-$lastBytes)/$elapsed;^
      $lastTime=$now;$lastBytes=$downloaded;^
      if($speed -ge 1MB){$speedStr='{0:F1} MB/s' -f ($speed/1MB)}^
      else{$speedStr='{0:F0} KB/s' -f ($speed/1KB)}^
    };^
    if($total -gt 0){^
      $pct=[int]($downloaded*100/$total);^
      $done=[int]($pct/2);^
      $left=50-$done;^
      $bar='=' * $done;^
      if($done -lt 50){$bar+='>'};^
      $spc=' ' * [Math]::Max(0,$left-1);^
      $dlMB='{0:F1}' -f ($downloaded/1MB);^
      $totMB='{0:F1}' -f ($total/1MB);^
      Write-Host \"`r         [$bar$spc] $pct%% | $speedStr | $dlMB/$totMB MB\" -NoNewline^
    }^
  };^
  $fs.Close();$stream.Close();$resp.Close();^
  Write-Host '';^
  Write-Host '         Download complete.';^
  exit 0^
}catch{^
  Write-Host '';^
  Write-Host \"         Download failed: $_\";^
  exit 1^
}"

if not exist "%TEMP%\node_setup.msi" goto :node_manual
echo         Running installer (this may take a minute) ...
start /wait msiexec /i "%TEMP%\node_setup.msi" /passive
del "%TEMP%\node_setup.msi" >nul 2>&1
set "PATH=%PATH%;C:\Program Files\nodejs"
where node >nul 2>&1
if %errorlevel% equ 0 goto :node_ok
goto :node_manual

:node_installed_restart
echo.
echo         Node.js installed via winget.
echo         IMPORTANT: Please CLOSE this window and re-run the script
echo         so that PATH updates take effect.
echo.
pause
exit /b 0

:node_manual
echo.
echo  ===========================================================
echo    Node.js auto-install failed.
if "!IS_CHINA!"=="1" (
echo    Please download from: https://npmmirror.com/mirrors/node/
) else (
echo    Please install manually from: https://nodejs.org/
)
echo    Then re-run this script.
echo  ===========================================================
echo.
if "!IS_CHINA!"=="1" (
    start https://npmmirror.com/mirrors/node/
) else (
    start https://nodejs.org/
)
pause
exit /b 1

:node_ok
for /f "tokens=*" %%v in ('node -v 2^>nul') do echo         OK - Node.js %%v installed

:: ==== Step 2: Check accounts file ====
:step2
echo  [2/4] Checking accounts file ...

set "ACCOUNTS=%ROOT%accounts.txt"
if exist "%ROOT%accounts.txt" goto :accounts_found

echo         Account file not found.
echo         Creating template: accounts.txt
echo.
(
echo # Format: email:password  (one per line, lines starting with # are ignored^)
echo # Example:
echo user1@gmail.com:MyPassword123
echo user2@gmail.com:AnotherPass456
) > "%ROOT%accounts.txt"
set "ACCOUNTS=%ROOT%accounts.txt"
echo         Template created: %ACCOUNTS%
echo         Please edit the file, add your accounts, then re-run.
echo.
start notepad "%ACCOUNTS%"
pause
exit /b 0

:accounts_found
echo         OK - %ACCOUNTS%
set /a LINE_COUNT=0
for /f "usebackq eol=# tokens=*" %%a in ("%ACCOUNTS%") do set /a LINE_COUNT+=1
echo         Accounts to process: %LINE_COUNT%

:: ==== Step 3: Install npm dependencies ====
:step3
echo  [3/4] Checking npm dependencies ...
cd /d "%SRC%"
if not exist "%SRC%package.json" goto :no_package_json
if exist "%SRC%node_modules\puppeteer-core" goto :deps_ok
if defined NPM_MIRROR (
    echo         Setting npm mirror: !NPM_MIRROR!
    call npm config set registry !NPM_MIRROR! >nul 2>&1
)
echo         Installing npm packages (first run only) ...
call npm install --no-fund --no-audit 2>&1
if %errorlevel% neq 0 goto :npm_fail
echo         OK - Dependencies installed
goto :step4

:deps_ok
echo         OK - Dependencies already installed
goto :step4

:no_package_json
echo         ERROR: package.json not found in src folder.
echo         Please make sure the src folder is intact.
pause
exit /b 1

:npm_fail
echo         ERROR: npm install failed.
echo         Check your network connection and try again.
pause
exit /b 1

:: ==== Step 4: Run the script ====
:step4
echo  [4/4] Starting ...
echo.
echo  ===========================================================
echo    All checks passed. Launching auth script ...
echo    Press Ctrl+C to stop at any time
echo  ===========================================================
echo.
echo  TIP: You can add flags after run.bat:
echo    run.bat --verbose           (detailed debug logs)
echo    run.bat --concurrency 5     (5 parallel workers)
echo    run.bat --screenshot-all    (screenshot every step)
echo    run.bat --test 3            (test with first 3 accounts)
echo.
echo  -----------------------------------------------------------
echo.

cd /d "%SRC%"
node auth.js %*

echo.
echo  ===========================================================
echo    Script finished.
echo  ===========================================================
echo.
cd /d "%ROOT%"
pause
