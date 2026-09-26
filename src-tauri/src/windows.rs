//! 窗口管理。
//!
//! 设计决策：小球 / 主面板 / 提醒弹窗是三个独立窗口，各自可以单独显示、隐藏、置顶。
//! 好处是提醒弹窗不会把主面板一起拽出来，隐藏主面板也不会影响小球。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 悬浮球窗口标签。
pub const BALL: &str = "ball";
/// 主面板窗口标签。
pub const PANEL: &str = "panel";
/// 提醒弹窗窗口标签。
///
/// 提醒弹窗在第一版里还没有调用方（计时器与备忘录都在下一个版本），
/// 但窗口骨架和创建逻辑先放好，后续功能直接调用即可。
/// 这里显式放行 dead_code，避免后来者看到警告顺手删掉这段已经写好的代码。
pub const ALERT: &str = "alert";

/// 小球窗口尺寸（逻辑像素）。圆形，所以宽高一致。
pub const BALL_SIZE: f64 = 56.0;

/// 小球圆形本体在 CSS 里的直径（逻辑像素）。
///
/// ⚠️ 必须与 `src/styles.css` 里 `.ball` 的 `width`/`height` 保持一致。
/// 窗口比球体大（实测外框宽 136 而球只有 52），球体在窗口内居中，
/// 所以定位时要按「球体边缘」而不是「窗口边缘」来算，
/// 否则球会离屏幕边缘比预期远出一大截。
const BALL_DIAMETER: f64 = 52.0;

/// 主面板尺寸。
pub const PANEL_WIDTH: f64 = 420.0;
pub const PANEL_HEIGHT: f64 = 640.0;

/// 小球默认吸附在屏幕右侧时，距离屏幕右边缘的间距。
const BALL_MARGIN_RIGHT: f64 = 24.0;
/// 小球垂直位置比例（0.38 约在屏幕上方三分之一处，避免遮挡任务栏和常见按钮）。
const BALL_Y_RATIO: f64 = 0.38;

/// 创建悬浮球窗口。
///
/// 关键属性：
/// - `decorations(false)`：无边框，才能画成圆形。
/// - `transparent(true)`：让圆形以外的区域透明。
/// - `always_on_top(true)`：始终悬浮在其他窗口之上。
/// - `skip_taskbar(true)`：不占用任务栏，符合「小工具」定位。
///
/// 定位分三步（隐藏创建 → 读真实尺寸 → 摆正 → 显示）：
/// Windows 给无边框窗口套的外框可能比 `inner_size` 宽出几十像素。
/// 若直接按设定尺寸算坐标，窗口会有一部分跑到屏幕外，实测小球会被切掉一角。
/// 先拿到真实外框尺寸再定位，就不依赖「外框等于内容尺寸」这个不可靠的假设。
pub fn create_ball(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, BALL, WebviewUrl::App("index.html#/ball".into()))
        .title("浮光·球")
        .inner_size(BALL_SIZE, BALL_SIZE)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;

    place_ball_at_default(app, &win);
    win.show()?;
    Ok(win)
}

/// 把小球摆到屏幕右侧的默认位置，保证整个窗口都在屏幕内。
fn place_ball_at_default(app: &AppHandle, ball: &WebviewWindow) {
    let Ok(size) = ball.outer_size() else {
        return;
    };
    let scale = ball.scale_factor().unwrap_or(1.0);
    let (screen_w, screen_h) = screen_logical_size(app);

    // 用真实外框尺寸反推坐标，而不是用 BALL_SIZE 常量
    let win_w = size.width as f64 / scale;
    let win_h = size.height as f64 / scale;

    // 球体在窗口内居中，所以球体右边缘 = win_x + (win_w + BALL_DIAMETER) / 2。
    // 让它等于 screen_w - margin，反推出 win_x。
    let x = screen_w - BALL_MARGIN_RIGHT - (win_w + BALL_DIAMETER) / 2.0;
    let y = (screen_h * BALL_Y_RATIO).clamp(0.0, (screen_h - win_h).max(0.0));

    let _ = ball.set_position(tauri::LogicalPosition::new(x.max(0.0), y));
}

/// 取主显示器的逻辑尺寸；失败时退回保守默认值，保证窗口仍能创建。
fn screen_logical_size(app: &AppHandle) -> (f64, f64) {
    match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            (size.width as f64 / scale, size.height as f64 / scale)
        }
        _ => (1920.0, 1080.0),
    }
}

/// 在独立线程上显示主面板。
///
/// 供托盘菜单、右键菜单这类**在主线程上执行的回调**使用。
/// 这些回调里直接调 [`show_panel`] 会有两个问题：
/// 1. Windows 上在主线程创建 Webview 窗口会死锁（Webview2 已知问题）；
/// 2. 即使不死锁，创建窗口的耗时会卡住整个界面。
/// 丢到独立线程后两者都避免。
pub fn spawn_show_panel(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = show_panel(&handle);
    });
}

/// 在独立线程上切换主面板显隐。理由同 [`spawn_show_panel`]。
pub fn spawn_toggle_panel(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = toggle_panel(&handle);
    });
}

/// 创建或显示主面板。
///
/// 面板会跟随小球位置，出现在小球左侧，避免挡住小球。
pub fn show_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(PANEL) {
        position_panel_near_ball(app, &win);
        win.show()?;
        win.set_focus()?;
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html#/panel".into()))
        .title("浮光·主面板")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .visible(false)
        .build()?;

    position_panel_near_ball(app, &win);
    win.show()?;
    win.set_focus()?;
    Ok(win)
}

/// 让主面板出现在小球旁边，并保证不超出屏幕。
fn position_panel_near_ball(app: &AppHandle, panel: &WebviewWindow) {
    // 小球不存在时（理论上不会）就直接不定位，面板用系统默认位置出现
    let Some(ball) = app.get_webview_window(BALL) else {
        return;
    };
    let Ok(ball_pos) = ball.outer_position() else {
        return;
    };
    let Ok(ball_size) = ball.outer_size() else {
        return;
    };
    let scale = ball.scale_factor().unwrap_or(1.0);

    // 小球位置是物理像素，窗口定位 API 也吃物理像素，这里统一用物理像素计算
    let gap = (8.0 * scale) as i32;
    let panel_w = (PANEL_WIDTH * scale) as i32;
    let panel_h = (PANEL_HEIGHT * scale) as i32;

    let screen_w = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().width as i32)
        .unwrap_or(1920);

    // 优先放小球左侧；左边放不下就放右侧
    let mut x = ball_pos.x - panel_w - gap;
    if x < 0 {
        x = ball_pos.x + ball_size.width as i32 + gap;
    }
    // 左右都放不下时贴边
    x = x.clamp(0, (screen_w - panel_w).max(0));

    // 垂直方向与小球对齐，但不超出屏幕
    let screen_h = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as i32)
        .unwrap_or(1080);
    let y = ball_pos.y.clamp(0, (screen_h - panel_h).max(0));

    let _ = panel.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 切换主面板显隐。右键菜单与左键点击都走这里。
pub fn toggle_panel(app: &AppHandle) -> tauri::Result<()> {
    match app.get_webview_window(PANEL) {
        Some(win) if win.is_visible().unwrap_or(false) => {
            win.hide()?;
        }
        _ => {
            show_panel(app)?;
        }
    }
    Ok(())
}

/// 弹出提醒窗。
///
/// # 内容怎么传
///
/// 窗口已存在时**不能**只调 `show()` —— 那样会显示上一条提醒的旧文字。
/// 这里走事件推送：前端监听 `alert:content`，收到就换掉内容。
///
/// 首次创建时同时把内容塞进 URL query，作为兜底：
/// 万一事件在前端挂载完成之前就发出去了（首次弹窗存在这个竞态），
/// 前端仍能从 query 里读到正确内容。
pub fn show_alert(app: &AppHandle, title: &str, body: &str) -> tauri::Result<()> {
    use tauri::Emitter;

    let url = format!(
        "index.html#/alert?title={}&body={}",
        urlencode(title),
        urlencode(body)
    );

    if let Some(win) = app.get_webview_window(ALERT) {
        // 先推内容再显示，避免用户看到旧内容闪一下
        let _ = win.emit(
            "alert:content",
            serde_json::json!({ "title": title, "body": body }),
        );
        win.show()?;
        win.set_focus()?;
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, ALERT, WebviewUrl::App(url.into()))
        .title("浮光·提醒")
        // 尺寸按"错过提醒汇总"这种最长内容来定：列表最多列 8 条，
        // 再高就靠弹窗内部滚动，而不是把窗口撑到屏幕上放不下。
        .inner_size(420.0, 300.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(false)
        .focused(true)
        .center()
        .build()?;
    win.show()?;
    Ok(())
}

/// 极简 URL 编码：只处理会破坏 query 结构的字符。
/// 不引入额外依赖，因为只需要支持中英文与常见符号。
#[allow(dead_code)]
fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
