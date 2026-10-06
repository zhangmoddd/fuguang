//! 系统托盘。
//!
//! 托盘是「兜底入口」：如果用户把小球拖到屏幕外、或者不小心隐藏了它，
//! 托盘菜单仍然能唤回主面板并退出软件。没有这个，用户就只能去任务管理器杀进程。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::windows;

/// 创建托盘图标与右键菜单。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主面板", true, None::<&str>)?;
    // 多面板的入口之一。托盘是"兜底入口"，所以"再开一个面板"也必须有 ——
    // 否则用户把小球藏起来之后就只剩主面板那一个窗口能点了。
    let new_panel = MenuItem::with_id(app, "new_panel", "新建窗口", true, None::<&str>)?;
    let toggle_ball = MenuItem::with_id(app, "toggle_ball", "显示/隐藏悬浮球", true, None::<&str>)?;
    let open_data = MenuItem::with_id(app, "open_data", "打开数据文件夹", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出浮光", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show, &new_panel, &toggle_ball, &open_data, &sep, &quit],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("缺少应用图标，无法创建托盘".into())
        })?)
        .tooltip("浮光 · 轻量桌面工具箱")
        .menu(&menu)
        // 左键单击托盘直接开面板；右键才出菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                // 托盘回调在主线程上执行，必须丢到独立线程再创建窗口
                windows::spawn_show_panel(app);
            }
            "new_panel" => windows::spawn_new_panel(app),
            "toggle_ball" => toggle_ball_visibility(app),
            "open_data" => open_data_dir(app),
            "quit" => {
                crate::diag!("[浮光] 退出：托盘菜单");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                windows::spawn_toggle_panel(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// 切换悬浮球显隐。
///
/// 函数名刻意与菜单项 id `toggle_ball` 区分开：
/// 同名局部绑定会遮蔽这个函数，导致 `toggle_ball(app)` 被解析成对 MenuItem 的调用。
fn toggle_ball_visibility(app: &AppHandle) {
    if let Some(ball) = app.get_webview_window(windows::BALL) {
        let visible = ball.is_visible().unwrap_or(false);
        if visible {
            let _ = ball.hide();
        } else {
            let _ = ball.show();
        }
    }
}

/// 在资源管理器中打开数据文件夹，方便用户备份或手动编辑。
fn open_data_dir(app: &AppHandle) {
    if let Ok(dir) = crate::storage::reveal_data_dir(app) {
        let _ = tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>);
    }
}
