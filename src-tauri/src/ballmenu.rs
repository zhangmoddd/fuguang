//! 悬浮球的原生右键菜单。
//!
//! 为什么用系统原生菜单而不是在球窗口里自绘：
//! 小球窗口只有 56×56 逻辑像素，而菜单至少需要 150×120。
//! 自绘菜单会被窗口边界裁掉，除非把窗口撑大——但撑大后
//! 那一大片透明区域会挡住桌面点击，得不偿失。
//! 原生菜单不占用窗口空间，位置由系统处理，还能自动避开屏幕边缘。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::menu::ContextMenu;
use tauri::{AppHandle, Manager};

use crate::windows;

/// 菜单项 id 前缀。
///
/// 加前缀是为了和托盘菜单的 id 区分开：
/// 通过 [`tauri::Manager::on_menu_event`] 注册的处理器是全局的，
/// 会收到包括托盘在内的所有菜单事件，靠前缀才能只处理属于小球的那些。
const PREFIX: &str = "ball:";

/// 构建小球右键菜单。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, format!("{PREFIX}panel"), "打开主面板", true, None::<&str>)?;
    let data = MenuItem::with_id(app, format!("{PREFIX}data"), "打开数据文件夹", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, format!("{PREFIX}hide"), "隐藏悬浮球", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, format!("{PREFIX}quit"), "退出浮光", true, None::<&str>)?;

    Menu::with_items(app, &[&open, &data, &hide, &sep, &quit])
}

/// 在小球窗口上弹出右键菜单。
///
/// 位置不显式指定，交给系统按当前光标位置计算，
/// 这样靠近屏幕边缘时系统会自动把菜单翻转回屏幕内。
pub fn popup(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app).map_err(|e| e.to_string())?;

    // Tauri 2 的 `Manager` 没有 `get_window`，只有 `get_webview_window`。
    // 菜单弹出需要的是 `Window`，而 `WebviewWindow` 可以通过
    // `AsRef<Webview>` → `Webview::window()` 拿到它。
    let webview_window = app
        .get_webview_window(windows::BALL)
        .ok_or_else(|| "悬浮球窗口不存在".to_string())?;

    // 关键一步：原生弹出菜单要求宿主窗口处于前台，否则菜单会刚出现就被系统关掉。
    // 小球是 `focused(false)` 的后台窗口，直接 popup 实测菜单根本不显示；
    // 先把它的线程输入队列挂到前台，菜单才留得住。
    if let Ok(hwnd) = webview_window.hwnd() {
        crate::platform::force_foreground(hwnd.0 as isize);
    }

    let window = webview_window.as_ref().window();
    menu.popup(window).map_err(|e| e.to_string())
}

/// 注册全局菜单事件处理器，只响应小球菜单的 id。
///
/// 需要在 `setup` 阶段调用一次。
pub fn register_handler(app: &AppHandle) {
    let handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        let Some(action) = id.strip_prefix(PREFIX) else {
            // 不是小球菜单的事件（例如托盘菜单），交给各自的处理器
            return;
        };

        match action {
            "panel" => {
                // 菜单回调在主线程上执行，必须丢到独立线程再创建窗口
                windows::spawn_show_panel(&handle);
            }
            "data" => {
                if let Ok(dir) = crate::storage::reveal_data_dir(&handle) {
                    let _ = tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>);
                }
            }
            "hide" => {
                if let Some(ball) = handle.get_webview_window(windows::BALL) {
                    let _ = ball.hide();
                }
            }
            "quit" => handle.exit(0),
            _ => {}
        }
    });
}
