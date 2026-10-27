@echo off
setlocal enabledelayedexpansion
title Connect Claude to Task Tracker
color 0B

echo.
echo   ========================================================
echo     Task Tracker  -  connect your Claude subscription
echo   ========================================================
echo.
echo   This uses the Claude plan you already pay for.
echo   It does NOT create an API key and does NOT cost extra.
echo.
echo   What this does, in order:
echo.
echo     1. Installs Claude Code, if you do not already have it
echo     2. Opens your browser so you can sign in to Claude
echo     3. Copies your connection token to your clipboard
echo.
echo   Nothing is sent anywhere by this script. The token is
echo   shown here and copied to your clipboard. You paste it
echo   into Task Tracker yourself.
echo.
echo   --------------------------------------------------------
echo.
pause
echo.

REM ---- 1. Is Claude Code already here? ---------------------------------
set "CLAUDE_BIN="
where claude >nul 2>nul && set "CLAUDE_BIN=claude"

if not defined CLAUDE_BIN (
  if exist "%USERPROFILE%\.local\bin\claude.exe" set "CLAUDE_BIN=%USERPROFILE%\.local\bin\claude.exe"
)

if not defined CLAUDE_BIN (
  echo   Claude Code is not installed yet. Installing it now...
  echo   ^(this takes about a minute^)
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { irm https://claude.ai/install.ps1 | iex } catch { Write-Host $_.Exception.Message }"
  echo.

  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
  where claude >nul 2>nul && set "CLAUDE_BIN=claude"
  if not defined CLAUDE_BIN (
    if exist "%USERPROFILE%\.local\bin\claude.exe" set "CLAUDE_BIN=%USERPROFILE%\.local\bin\claude.exe"
  )
)

if not defined CLAUDE_BIN (
  echo.
  echo   ^>^> Could not install Claude Code automatically.
  echo.
  echo   Install it by hand with this one command, then run
  echo   this file again:
  echo.
  echo       winget install Anthropic.ClaudeCode
  echo.
  pause
  exit /b 1
)

echo   Claude Code is ready.
echo.
echo   --------------------------------------------------------
echo   Your browser is about to open. Sign in and approve.
echo   --------------------------------------------------------
echo.

REM ---- 2. Mint the token, showing output and capturing it --------------
REM Tee-Object so the user still sees the interactive flow while we keep a
REM copy to pull the token out of. The token is printed once and saved
REM nowhere by Claude Code itself, so capturing it here is the difference
REM between this working and the user losing it to a scrolled terminal.
set "TT_CAPTURE=%TEMP%\tt-claude-token.txt"
if exist "%TT_CAPTURE%" del /f /q "%TT_CAPTURE%" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& { & '%CLAUDE_BIN%' setup-token 2>&1 | Tee-Object -FilePath '%TT_CAPTURE%' }"

echo.

REM ---- 3. Pull the token out and put it on the clipboard ---------------
set "TT_TOKEN="
for /f "usebackq delims=" %%T in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%TT_CAPTURE%'; if(Test-Path $p){ $m=[regex]::Match((Get-Content $p -Raw), 'sk-ant-oat[A-Za-z0-9_\-]+'); if($m.Success){ $m.Value } }"`) do set "TT_TOKEN=%%T"

if exist "%TT_CAPTURE%" del /f /q "%TT_CAPTURE%" >nul 2>nul

echo   ========================================================
if defined TT_TOKEN (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Clipboard -Value '%TT_TOKEN%'"
  echo     Done. Your token is COPIED TO YOUR CLIPBOARD.
  echo   ========================================================
  echo.
  echo     Now go back to Task Tracker Settings, click the
  echo     "Your Claude" box, and press Ctrl+V, then Connect.
  echo.
  echo     Starts with: !TT_TOKEN:~0,14!...
) else (
  echo     Could not read the token automatically.
  echo   ========================================================
  echo.
  echo     Look just above for a line starting with  sk-ant-oat
  echo     Select it with your mouse, press Enter to copy,
  echo     then paste it into Task Tracker Settings.
)
echo.
echo   Keep this token private - it works like a password for
echo   your Claude account. Task Tracker encrypts it before
echo   storing it, and never shows it again.
echo.
pause
