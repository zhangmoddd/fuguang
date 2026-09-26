@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  浮光 · 清理编译缓存
rem
rem  这就是你担心的「编译残留」。
rem  src-tauri\target\ 是 Rust 的编译中间产物，开发模式（带调试信息）
rem  下实测会涨到 6 GB 以上，比软件本体大几百倍。
rem
rem  它不会进 Git、不会发给用户，纯粹占你自己硬盘。
rem  删掉之后：下次「1-开发模式.bat」或「2-重新编译.bat」会重新编译，
rem  首次大约十几分钟；之后又恢复增量编译的几秒钟。
rem
rem  建议：硬盘紧张时清理。平时留着，编译更快。
rem ============================================================

cd /d "%~dp0"

echo ============================================================
echo  浮光 · 编译缓存清理
echo ============================================================
echo.
echo  正在统计占用（大文件夹可能要几秒）...
echo.

rem 用 PowerShell 精确统计两个目录的大小
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command ^
  "$t='src-tauri\target'; $n='node_modules';" ^
  "function S($p){ if(Test-Path $p){ [math]::Round((Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB,0) } else { -1 } }" ^
  "$a=S $t; $b=S $n;" ^
  "if($a -lt 0){'target: 不存在'}else{'target: ' + $a + ' MB'};" ^
  "if($b -lt 0){'node_modules: 不存在'}else{'node_modules: ' + $b + ' MB'}"`) do echo   %%S

echo.
echo  ============================================================
echo   请选择要清理的内容
echo  ============================================================
echo.
echo    [1] 只清理 Rust 编译缓存 target\   —— 回收空间最多，推荐
echo    [2] 清理 target\ 和 node_modules\  —— 最彻底，下次要重新装依赖
echo    [3] 什么都不做，退出
echo.
choice /c 123 /m "  你的选择"

if errorlevel 3 goto :done
if errorlevel 2 goto :clean_all
if errorlevel 1 goto :clean_target

:clean_target
echo.
echo  正在删除 src-tauri\target\ ...
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
echo  完成。下次编译会重新生成。
goto :done

:clean_all
echo.
echo  正在删除 src-tauri\target\ ...
if exist "src-tauri\target" rmdir /s /q "src-tauri\target"
echo  正在删除 node_modules\ ...
if exist "node_modules" rmdir /s /q "node_modules"
echo  完成。下次请先跑「1-开发模式.bat」，它会自动重新安装依赖。
goto :done

:done
echo.
pause
