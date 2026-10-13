@echo off
REM ---------------------------------------------------------------------------
REM  Starts the Plateau app and opens it in your browser.
REM
REM  Double-click this file, or run it from a terminal:
REM      start.cmd
REM
REM  Node is located in this order:
REM    1. a `node` already on your PATH
REM    2. the Node runtime bundled with DeepSeek Harness
REM ---------------------------------------------------------------------------

setlocal enabledelayedexpansion
cd /d "%~dp0"

if not defined PORT set "PORT=5180"
if not defined HOST set "HOST=127.0.0.1"

REM --- locate Node ---------------------------------------------------------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)

if not defined NODE_EXE (
  REM Common install locations, newest major first. Each candidate is tested
  REM separately because a parenthesised block containing an environment
  REM reference with parentheses in its name (ProgramFiles(x86)) parses badly.
  if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
  if not defined NODE_EXE if exist "%APPDATA%\nvm\current\node.exe" set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
  if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
)

if not defined NODE_EXE (
  REM The runtime bundled with DeepSeek Harness. USERPROFILE may be unset in
  REM some shells, so fall back to the standard location.
  set "DSHROOT=%USERPROFILE%"
  if not defined DSHROOT set "DSHROOT=%SystemDrive%\Users\%USERNAME%"
  if exist "!DSHROOT!\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=!DSHROOT!\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo   ERROR: Node.js was not found.
  echo.
  echo   Install Node 20 or newer from https://nodejs.org, then run this file again.
  echo.
  pause
  exit /b 1
)

echo   Using Node: %NODE_EXE%
"%NODE_EXE%" --version

REM --- first run: the sample dataset ---------------------------------------
if not exist "data\superstore.csv" (
  echo   Generating the sample dataset...
  "%NODE_EXE%" scripts\run.mjs scripts\generate-superstore.ts
  if errorlevel 1 (
    echo   ERROR: could not generate the sample dataset.
    pause
    exit /b 1
  )
)

if not exist "dist\web\index.html" (
  echo.
  echo   ERROR: no built UI found at dist\web\index.html
  echo.
  echo   Build it first:            pnpm run build
  echo   Or run live-reload dev:    pnpm run dev
  echo.
  pause
  exit /b 1
)

REM --- launch --------------------------------------------------------------
echo.
echo   Plateau is starting on http://%HOST%:%PORT%
echo   Keep this window open. Press Ctrl+C to stop the server.
echo.

REM Open the browser shortly after the server binds. `ping` is used as the delay
REM because `timeout` fails when input is redirected.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://%HOST%:%PORT%/"

"%NODE_EXE%" scripts\run.mjs src\server\index.ts --serve-static

echo.
echo   Server stopped.
pause
endlocal
