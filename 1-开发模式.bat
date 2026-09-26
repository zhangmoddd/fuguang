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
