@echo off
setlocal

rem ===========================================================
rem  Fuguang - Clean Build Cache
rem
rem  This is the "build leftover" folder you may be worried about.
rem
rem  src-tauri\target\ holds Rust build intermediates. In dev mode
rem  it grows past 6 GB, which is hundreds of times larger than
rem  the app itself.
rem
rem  It never goes into git and never ships to users. It only eats
rem  your own disk. After deleting it, the next dev-mode or rebuild
rem  run has to recompile everything (10+ minutes for the first
rem  time), then it is incremental again.
rem
rem  Advice: keep it while you are actively coding. Clean it when
rem  you are short on disk space.
rem
rem  ---------------------------------------------------------
rem  IMPORTANT FOR CONTRIBUTORS
rem  ASCII-only + CRLF on purpose. See the dev-mode script
rem  header for the full reason.
rem  ---------------------------------------------------------
rem ===========================================================

cd /d "%~dp0"

echo ===========================================================
echo  Fuguang - Build Cache Cleanup
echo ===========================================================
echo.
echo  Measuring folders, this may take a few seconds...
echo.

powershell -NoProfile -Command "$t=0; if(Test-Path 'src-tauri\target'){$t=(Get-ChildItem 'src-tauri\target' -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; Write-Host ('   src-tauri\target\   : {0} MB' -f [math]::Round($t/1MB,0))}else{Write-Host '   src-tauri\target\   : not present'}; if(Test-Path 'node_modules'){$n=(Get-ChildItem 'node_modules' -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; Write-Host ('   node_modules\       : {0} MB' -f [math]::Round($n/1MB,0))}else{Write-Host '   node_modules\       : not present'}"

echo.
echo ===========================================================
echo  What do you want to remove?
echo ===========================================================
echo.
echo   [1] target\ only            - biggest win, recommended
echo   [2] target\ and node_modules\ - most thorough, needs npm install next time
echo   [3] nothing, just exit
echo.
choice /c 123 /m "  Your choice"

if errorlevel 3 goto :done
if errorlevel 2 goto :clean_all
if errorlevel 1 goto :clean_target

:clean_target
echo.
echo  Removing src-tauri\target\ ...
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
echo  Done. It will be regenerated on the next build.
goto :done

:clean_all
echo.
echo  Removing src-tauri\target\ ...
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
echo  Removing node_modules\ ...
if exist "node_modules" rmdir /s /q "node_modules"
echo  Done. Run the dev-mode script next, it reinstalls deps.
goto :done

:done
echo.
pause
