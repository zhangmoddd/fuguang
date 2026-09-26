@echo off
setlocal

rem ===========================================================
rem  Fuguang - Build Release
rem
rem  You only need this in two situations:
rem    1. You want to hand the exe to someone else / upload it
rem    2. You want a release build that does not need the dev env
rem
rem  For everyday coding use the dev-mode script (script 1)
rem  instead. Do NOT use this one for the normal edit-run loop.
rem
rem  Output:
rem    src-tauri\target\release\fuguang.exe
rem    src-tauri\target\release\bundle\nsis\  (installer)
rem
rem  The FIRST build downloads and compiles every Rust dependency
rem  and can take 10+ minutes. Later builds are incremental and
rem  usually take 1-2 minutes. Do not close this window meanwhile.
rem
rem  ---------------------------------------------------------
rem  IMPORTANT FOR CONTRIBUTORS
rem  ASCII-only + CRLF on purpose. See the dev-mode script
rem  header for the full reason.
rem  ---------------------------------------------------------
rem ===========================================================

cd /d "%~dp0"

echo ===========================================================
echo  Building Fuguang RELEASE
echo ===========================================================
echo.

if not exist "node_modules" (
    echo [prep] installing frontend dependencies...
    call npm install
    if errorlevel 1 goto :fail
)

call npm run desktop:build
if errorlevel 1 goto :fail

echo.
echo ===========================================================
echo  Build finished
echo.
echo  exe:
echo    %~dp0src-tauri\target\release\fuguang.exe
echo  installer:
echo    %~dp0src-tauri\target\release\bundle\nsis\
echo ===========================================================
echo.
choice /c YN /m "Open the output folder now"
if errorlevel 2 goto :done
start "" "%~dp0src-tauri\target\release"
goto :done

:fail
echo.
echo [ERROR] Build failed. Please send the last few error lines
echo         above to the developer.
pause
exit /b 1

:done
pause
