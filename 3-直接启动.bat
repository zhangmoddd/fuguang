@echo off
setlocal

rem ===========================================================
rem  Fuguang - Run Release Build
rem
rem  Starts the already-compiled release exe. No dev server, no
rem  compilation, fastest startup.
rem
rem  Requires that you ran the rebuild script (script 2) at least
rem  once before.
rem
rem  ---------------------------------------------------------
rem  IMPORTANT FOR CONTRIBUTORS
rem  ASCII-only + CRLF on purpose. See the dev-mode script
rem  header for the full reason.
rem  ---------------------------------------------------------
rem ===========================================================

cd /d "%~dp0"

set "EXE=%~dp0src-tauri\target\release\fuguang.exe"

if not exist "%EXE%" (
    echo ===========================================================
    echo  No release build found yet.
    echo.
    echo  Please run the rebuild script once to compile it,
    echo  then come back here for instant startup.
    echo.
    echo  If you only want to code and see changes live,
    echo  run the dev-mode script instead.
    echo ===========================================================
    pause
    exit /b 1
)

echo Starting Fuguang...
start "" "%EXE%"
exit /b 0
