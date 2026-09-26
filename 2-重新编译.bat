@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  浮光 · 重新编译
rem
rem  只有这两种情况才需要跑它：
rem   1. 你想把 exe 发给别人 / 传到 GitHub Release
rem   2. 你想用「直接启动.bat」跑一个不依赖开发环境的正式版
rem
rem  日常改代码请用「1-开发模式.bat」，不要用这个。
rem
rem  产物位置：src-tauri\target\release\fuguang.exe
rem  安装包位置：src-tauri\target\release\bundle\nsis\
rem ============================================================

cd /d "%~dp0"

echo ============================================================
echo  正在编译浮光的正式版
echo.
echo  第一次编译要下载并编译全部 Rust 依赖，可能十几分钟。
echo  之后是增量编译，通常一两分钟。
echo  编译期间不要关这个窗口。
echo ============================================================
echo.

if not exist "node_modules" (
    echo [准备] 安装前端依赖...
    call npm install
    if errorlevel 1 goto :fail
)

call npm run desktop:build
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo  编译完成
echo.
echo  exe 位置：
echo    %~dp0src-tauri\target\release\fuguang.exe
echo  安装包位置：
echo    %~dp0src-tauri\target\release\bundle\nsis\
echo ============================================================
echo.
echo 是否现在打开 exe 所在文件夹？
choice /c YN /m "打开文件夹"
if errorlevel 2 goto :done
start "" "%~dp0src-tauri\target\release"
goto :done

:fail
echo.
echo [错误] 编译失败，请把上面最后几行错误信息发给开发者。
pause
exit /b 1

:done
pause
