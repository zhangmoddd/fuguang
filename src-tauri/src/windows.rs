//! 窗口管理。
//!
//! 设计决策：小球 / 主面板 / 提醒弹窗是三个独立窗口，各自可以单独显示、隐藏、置顶。
//! 好处是提醒弹窗不会把主面板一起拽出来，隐藏主面板也不会影响小球。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::storage;

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

/// 窗口几何的持久化文件。
///
/// # 为什么不塞进 `settings.json`
///
/// **窗口几何是运行时状态，不是用户偏好。** 更要紧的是：小球和主面板是两个
/// 独立窗口，都会写设置文件，而 `settings_save` 是**整份覆盖写**——
/// 设置页手里那份是它打开时读的，小球拖完存了新位置之后，
/// 用户在设置页随便改一项就会把位置冲回旧值。
/// 分开一个文件，这类互相覆盖就不可能发生。
const FILE_WINDOW: &str = "window.json";

/// 需要跨重启记住的窗口几何。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    /// 悬浮球窗口左上角（**逻辑**像素）。
    ///
    /// 存逻辑像素而不是物理像素：物理像素在不同缩放比例的屏幕上不可比，
    /// 换一台机器读回来就会跑到别的地方。
    #[serde(default)]
    pub ball_x: Option<f64>,
    /// 见 [`WindowState::ball_x`]。
    #[serde(default)]
    pub ball_y: Option<f64>,
}

/// 校验一个待保存的悬浮球位置。
///
/// 抽成独立函数是为了能直接单测——`save_ball_position` 需要 `AppHandle`，
/// 单测里造不出一个真的 Tauri 应用。
///
/// 负数**必须放行**：副屏摆主屏左边时 x 就是负的，把它当非法值会让
/// 那半边屏幕的用户永远存不下位置。
fn validate_position(x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("位置不是有效数字".into());
    }
    Ok(())
}

/// 读回持久化的窗口几何。文件不存在或损坏时返回默认值。
fn load_window_state(app: &AppHandle) -> WindowState {
    storage::read_json(app, FILE_WINDOW, WindowState::default())
}

/// 记住悬浮球当前的位置，供下次启动恢复。
pub fn save_ball_position(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
    validate_position(x, y)?;

    let mut state = load_window_state(app);
    state.ball_x = Some(x);
    state.ball_y = Some(y);
    storage::write_json(app, FILE_WINDOW, &state)
}

/// 把小球放回用户上次拖到的位置。
///
/// 返回 `false` 表示"没有可用记录"，调用方应该退回默认位置。
/// 两种情况都会返回 `false`：
/// 1. 从来没存过；
/// 2. 存的位置**现在不在任何屏幕上**——用户拔掉了那块副屏、或者改了显示器排列。
///    这种情况下硬摆过去，小球会落在屏幕外，用户根本够不着它。
fn restore_ball_position(app: &AppHandle, ball: &WebviewWindow) -> bool {
    let saved = load_window_state(app);
    let (Some(x), Some(y)) = (saved.ball_x, saved.ball_y) else {
        return false;
    };

    // 逻辑 → 物理，才能用 monitor_from_point 判断"这个点还在不在屏幕上"
    let scale = ball.scale_factor().unwrap_or(1.0);
    let px = (x * scale).round() as i32;
    let py = (y * scale).round() as i32;
    if monitor_at(app, px, py).is_none() {
        return false;
    }

    ball.set_position(tauri::LogicalPosition::new(x, y)).is_ok()
}

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

    // 优先回到用户上次拖到的位置；没有记录（或那块屏幕已经不在了）才用默认位置
    if !restore_ball_position(app, &win) {
        place_ball_at_default(app, &win);
    }
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

    // 置顶与否由**设置**决定，不再硬编码 true。
    // 硬编码的后果：用户在设置页明确关掉的「面板保持置顶」每次开机都被还原，
    // 而设置文件里还写着 false —— 界面和实际行为互相打脸。
    let always_on_top = {
        let store = app.state::<crate::state::Store>();
        let st = store.lock();
        st.settings.panel_always_on_top
    };

    let win = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("index.html#/panel".into()))
        .title("浮光·主面板")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(always_on_top)
        .skip_taskbar(true)
        .focused(true)
        .visible(false)
        .build()?;

    position_panel_near_ball(app, &win);
    win.show()?;
    win.set_focus()?;
    Ok(win)
}

/// 取包含指定物理坐标的那块显示器。
///
/// 多显示器下**不能用 `primary_monitor`**：小球被拖到副屏之后，
/// 用主屏的尺寸去夹取坐标会把面板夹回主屏——
/// 表现就是"点了小球，面板出现在另一个屏幕上"。
fn monitor_at(app: &AppHandle, x: i32, y: i32) -> Option<tauri::Monitor> {
    app.monitor_from_point(x as f64, y as f64).ok().flatten()
}

/// 让主面板出现在小球旁边，并保证不超出**小球所在的那块屏幕**。
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

    // 显示器**可能不在原点**：副屏摆在主屏左边时它的 x 是负数。
    // 所以四个边界都得用显示器自己的 position + size 算，不能从 0 起算。
    let (screen_x, screen_y, screen_w, screen_h) = match monitor_at(app, ball_pos.x, ball_pos.y) {
        Some(m) => (
            m.position().x,
            m.position().y,
            m.size().width as i32,
            m.size().height as i32,
        ),
        // 拿不到显示器信息时退回保守值：宁可位置不理想，也不要算出屏幕外
        None => (0, 0, 1920, 1080),
    };

    // 优先放小球左侧；左边放不下就放右侧
    let mut x = ball_pos.x - panel_w - gap;
    if x < screen_x {
        x = ball_pos.x + ball_size.width as i32 + gap;
    }
    let max_x = (screen_x + screen_w - panel_w).max(screen_x);
    x = x.clamp(screen_x, max_x);

    // 垂直方向与小球对齐，但不超出这块屏幕
    let max_y = (screen_y + screen_h - panel_h).max(screen_y);
    let y = ball_pos.y.clamp(screen_y, max_y);

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

/// 最近一次提醒的内容。前端挂载时主动拉一次（见 [`last_alert`]）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlertContent {
    pub title: String,
    pub body: String,
}

/// 最近一次提醒的内容。
///
/// # 为什么光有事件推送不够
///
/// 提醒窗口是**复用**的：内容靠 `alert:content` 事件推给前端。但事件"发了就没了"——
/// 如果那一刻前端的监听器还没注册好（两条提醒挨得很近，第二条赶在窗口刚建好、
/// 前端还没挂载完的时候到达），事件被丢弃。而调度线程**已经把 `fired_for` 落盘了**，
/// 那条提醒就再也不会补弹 —— 用户少收一条提醒，且没有任何地方能发现。
///
/// 首次创建窗口时 URL query 能兜住（见 [`show_alert`] 的说明），但"复用已有窗口"
/// 这条路原来没有兜底。所以这里留一份，前端挂载时主动拉。
static LAST_ALERT: std::sync::OnceLock<std::sync::Mutex<Option<AlertContent>>> =
    std::sync::OnceLock::new();

fn last_alert_slot() -> &'static std::sync::Mutex<Option<AlertContent>> {
    LAST_ALERT.get_or_init(|| std::sync::Mutex::new(None))
}

/// 取最近一次提醒的内容。前端挂载时拉一次，避免错过事件推送。
pub fn last_alert() -> Option<AlertContent> {
    last_alert_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
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
///
/// **复用窗口时事件同样可能丢**（监听器还没注册），所以内容还会存进
/// [`last_alert`]，前端挂载时主动拉一次兜底。
pub fn show_alert(app: &AppHandle, title: &str, body: &str) -> tauri::Result<()> {
    use tauri::Emitter;

    // 先记下来：无论事件能不能送达，前端挂载时都能拉到
    *last_alert_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(AlertContent {
        title: title.to_string(),
        body: body.to_string(),
    });

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 副屏在主屏左边时的负坐标必须被接受() {
        // 这是最容易写错的一条：把 x < 0 当成非法值，会让副屏摆在主屏左边的
        // 用户永远存不下位置——每次开机小球都跳回主屏右侧
        assert!(validate_position(-120.5, 300.0).is_ok());
        assert!(validate_position(0.0, 0.0).is_ok());
        assert!(validate_position(1920.0, 1080.0).is_ok());
    }

    #[test]
    fn 非有限的位置会被拒绝() {
        // 写进去之后下次启动会把窗口摆到屏幕外，表现是"小球不见了"，
        // 而用户没有任何办法把它找回来
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(validate_position(bad, 10.0).is_err(), "{bad} 应该被拒绝");
            assert!(validate_position(10.0, bad).is_err(), "{bad} 应该被拒绝");
        }
    }

    #[test]
    fn 窗口几何是驼峰命名且缺字段时有默认值() {
        let state = WindowState {
            ball_x: Some(-10.0),
            ball_y: Some(20.0),
        };
        let json = serde_json::to_string(&state).expect("序列化");
        assert!(json.contains("\"ballX\""), "实际：{json}");
        assert!(!json.contains("ball_x"), "不该出现下划线命名");

        // 老文件（或将来只存了别的窗口）缺这两个字段时不能解析失败
        let empty: WindowState = serde_json::from_str("{}").expect("必须能解析");
        assert_eq!(empty.ball_x, None);
        assert_eq!(empty.ball_y, None);
    }
}
