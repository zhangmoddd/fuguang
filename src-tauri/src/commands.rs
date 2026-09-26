//! 暴露给前端的 Tauri 命令。
//!
//! 前端只通过这些命令与系统交互，不直接触碰 Windows API，
//! 这样以后换平台（理论上）或加新能力时，改动面都收敛在这一个文件里。
//!
//! # 为什么这里的命令几乎都是 `async`
//!
//! Tauri 把**同步命令放在主线程执行**，而主线程同时负责跑窗口消息循环。
//! 于是两类操作会出问题：
//!
//! 1. **创建窗口**：官方文档明确说明，Windows 上在同步命令里调用
//!    `WebviewWindowBuilder::new` 会死锁（Webview2 的已知问题）。
//! 2. **弹出菜单**：`menu.popup` 内部要把调用派发到主线程执行。
//!    若命令本身就在主线程上，等于主线程在等自己，菜单永远弹不出来
//!    —— 这个坑实测踩到过，右键菜单死活不出现。
//!
//! 标成 `async` 后命令改在异步运行时线程上执行，两种情况都能正常派发。
//! 代价只是每个命令多一次极小的调度开销。

use tauri::{AppHandle, Manager};

use crate::{ballmenu, platform, storage, windows};

/// 在悬浮球上弹出原生右键菜单。
///
/// 必须是 `async`：`menu.popup` 要派发到主线程，而同步命令本身就占着主线程。
#[tauri::command]
pub async fn show_ball_menu(app: AppHandle) -> Result<(), String> {
    ballmenu::popup(&app)
}

/// 切换主面板显隐。小球左键点击、托盘点击都调它。
#[tauri::command]
pub async fn toggle_panel(app: AppHandle) -> Result<(), String> {
    windows::toggle_panel(&app).map_err(|e| e.to_string())
}

/// 显示主面板。
#[tauri::command]
pub async fn show_panel(app: AppHandle) -> Result<(), String> {
    windows::show_panel(&app).map(|_| ()).map_err(|e| e.to_string())
}

/// 隐藏主面板（保留窗口实例，下次打开更快）。
#[tauri::command]
pub async fn hide_panel(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(windows::PANEL) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 隐藏悬浮球（例如用户想临时清爽一下）。
#[tauri::command]
pub async fn hide_ball(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(windows::BALL) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 重新显示悬浮球。
#[tauri::command]
pub async fn show_ball(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(windows::BALL) {
        win.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 退出软件。
///
/// 悬浮球设置了 `closable(false)`，所以前端不能靠关窗口退出，
/// 必须走这个命令显式结束进程，否则会留下无法关闭的后台进程。
#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 把文本粘贴到「上一次使用的外部窗口」的光标处。
///
/// 这是文本片段功能的核心命令，完整流程见 [`platform::paste_to_target`]。
///
/// 必须是 `async`：内部有必要的等待（等焦点切换、等粘贴完成再还原剪贴板），
/// 总共约 180ms。放在主线程上会让整个界面卡顿，并且会拖住窗口消息循环，
/// 影响焦点切换本身。
#[tauri::command]
pub async fn paste_text(text: String, restore_delay_ms: Option<u64>) -> platform::PasteOutcome {
    platform::paste_to_target(&text, restore_delay_ms.unwrap_or(120))
}

/// 只把文本放进剪贴板，不做粘贴。
/// 用于「我只要复制，不要它自己粘」的场景，以及降级兜底。
#[tauri::command]
pub async fn copy_text(text: String) -> bool {
    platform::clipboard_set_text(&text)
}

/// 读取数据文件。文件不存在时返回 `null`，由前端用默认值初始化。
#[tauri::command]
pub async fn read_data(app: AppHandle, file: String) -> Result<serde_json::Value, String> {
    // 先校验文件名，避免前端传入 ../ 之类的路径穿越
    storage::safe_data_path(&app, &file)?;
    Ok(storage::read_json::<serde_json::Value>(
        &app,
        &file,
        serde_json::Value::Null,
    ))
}

/// 写入数据文件。
#[tauri::command]
pub async fn write_data(
    app: AppHandle,
    file: String,
    value: serde_json::Value,
) -> Result<(), String> {
    storage::safe_data_path(&app, &file)?;
    storage::write_json(&app, &file, &value)
}

/// 取数据目录路径，用于在设置页展示「你的数据存在这里」。
#[tauri::command]
pub async fn data_dir_path(app: AppHandle) -> Result<String, String> {
    storage::data_dir(&app).map(|p| p.to_string_lossy().to_string())
}

/// 在资源管理器中打开数据目录。
#[tauri::command]
pub async fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = storage::reveal_data_dir(&app)?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 设置某个窗口是否置顶。设置页里的开关会用到。
#[tauri::command]
pub async fn set_always_on_top(app: AppHandle, label: String, value: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在：{label}"))?;
    win.set_always_on_top(value).map_err(|e| e.to_string())
}
