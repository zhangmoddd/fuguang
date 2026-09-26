@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  浮光 · 开发模式
rem
rem  这是你日常最常用的入口。
rem  它跑的是真正的桌面程序（真悬浮窗、真全局按键），
rem  但前端代码改动会热更新——存盘窗口自己就变，不需要重新编译 exe。
rem
rem  只有 Rust 代码（src-tauri\src 下的 .rs 文件）改了才会触发重新编译，
rem  而且是增量编译，通常几秒到几十秒，不会像第一次那样等十几分钟。
rem ============================================================

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 没有找到 npm，请先安装 Node.js：https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/2] 首次运行，正在安装前端依赖，请稍等...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败。
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo  正在启动浮光开发模式
echo.
echo  · 修改 src\ 下的前端代码：存盘即生效，不用重启
echo  · 修改 src-tauri\src\ 下的 Rust 代码：会自动重新编译
echo  · 关掉这个黑窗口就等于退出浮光
echo ============================================================
echo.

call npm run desktop:dev

echo.
echo 浮光已退出。
pause
