@echo off
setlocal

rem ===========================================================
rem  Fuguang - Development Mode
rem
rem  This is the one you use every day.
rem
rem  It runs the REAL desktop app (real floating window, real
rem  global input), but the frontend hot-reloads: save a file
rem  under src\ and the window updates by itself. No exe build.
rem
rem  Only changes under src-tauri\src\ (Rust) trigger a rebuild,
rem  and that is incremental - seconds, not the first-time minutes.
rem
rem  ---------------------------------------------------------
rem  IMPORTANT FOR CONTRIBUTORS
rem  This file is deliberately ASCII-only and uses CRLF line
rem  endings. Batch files on Chinese Windows get garbled or hang
rem  when they mix UTF-8 text with chcp, and LF-only endings break
rem  if-blocks and goto labels. Keep both properties when editing.
rem  ---------------------------------------------------------
rem ===========================================================

cd /d "%~dp0"

rem -----------------------------------------------------------
rem  Turn off the console's "QuickEdit mode".
rem
rem  With QuickEdit on (the Windows default), a single click inside
rem  this window starts a text selection, and Windows then SUSPENDS
rem  whatever process is writing to the console. The build just stops
rem  mid-way with no further output -- it looks exactly like a hang.
rem  Pressing Enter releases it.
rem
rem  Since compiling takes minutes, users WILL click this window.
rem  Turning it off removes the trap. Copying still works through the
rem  right-click "Mark" menu.
rem
rem  Failures are ignored: the worst case is the old behaviour.
rem -----------------------------------------------------------
if exist "tools\console-quiet.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "tools\console-quiet.ps1" >nul 2>nul
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js first:
    echo         https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/2] First run: installing frontend dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo ===========================================================
echo  Starting Fuguang in DEVELOPMENT mode
echo.
echo   edit  src\          -^> saved = applied instantly
echo   edit  src-tauri\src -^> triggers an incremental rebuild
echo   close this window   -^> quits Fuguang
echo ===========================================================
echo.

call npm run desktop:dev

echo.
echo Fuguang has exited.
pause
