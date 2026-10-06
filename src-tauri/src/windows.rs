//! 窗口管理。
//!
//! 设计决策：小球 / 主面板 / 提醒弹窗是三个独立窗口，各自可以单独显示、隐藏、置顶。
//! 好处是提醒弹窗不会把主面板一起拽出来，隐藏主面板也不会影响小球。
//!
//! # 主面板可以有多个
//!
//! 面板不再是一个单例：第一个叫 `panel`，之后依次是 `panel-2`、`panel-3`……
//! 用户可以并排开两个面板停在不同文件夹（见 [`new_panel`]）。
//! 新增窗口时要**同时**改三处，漏一处的表现都是"窗口能出来但完全不能用"：
//!
//! 1. `capabilities/default.json` 的 `windows` 列表 —— 它现在是 `panel*` 通配，
//!    少写这一条的话新 label 匹配不到任何 capability，**前端所有 invoke 全部失败**；
//! 2. `lib.rs` 的 `on_window_event` —— 关闭请求要按前缀拦下来（否则 Alt+F4 会真销毁窗口，
//!    而窗口里那份前端状态连同未落盘的改动一起丢）；
//! 3. 这里创建窗口时的**标题**，见 [`PANEL_TITLE`]。
//!
//! # 全局热键只唤出第一个面板
//!
//! 这是**刻意**的，不是遗漏：`hotkey.rs` 只有一个 `HOTKEY_ID`，
//! 要支持"每组热键对应一个面板"得把注册模型改成"id → 组合键"的映射。
//! 本轮不做，所以热键、托盘、悬浮球菜单里的「打开主面板」都只操作 `panel`，
//! 只有「新建窗口」会开新面板。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::storage;

/// 悬浮球窗口标签。
pub const BALL: &str = "ball";
/// 第一个主面板的窗口标签。
pub const PANEL: &str = "panel";
/// 主面板标签前缀：`panel`、`panel-2`、`panel-3`……
pub const PANEL_PREFIX: &str = "panel";
/// 提醒弹窗窗口标签。
///
/// 提醒弹窗在第一版里还没有调用方（计时器与备忘录都在下一个版本），
/// 但窗口骨架和创建逻辑先放好，后续功能直接调用即可。
/// 这里显式放行 dead_code，避免后来者看到警告顺手删掉这段已经写好的代码。
pub const ALERT: &str = "alert";

/// 悬浮球窗口标题。
pub const BALL_TITLE: &str = "浮光·球";
/// 主面板窗口标题。**所有**面板（`panel` / `panel-2` / …）共用这一个字面量。
///
/// # ⚠️ 不许给新面板改名成「浮光·主面板 2」
///
/// [`crate::platform::OUR_WINDOW_TITLES`] 是一张**精确标题**白名单，
/// 前台跟踪线程靠它把浮光自己的窗口排除在「粘贴目标」之外。
/// 一旦新面板的标题不在白名单里：
///
/// 1. 用户在新面板上点一下，跟踪线程就把这个面板记成"用户上一次真正在用的窗口"；
/// 2. 之后点任意片段/图片的「键入到当前光标」，焦点被还给浮光自己的面板，
///    Ctrl+V 打回浮光身上 —— 用户看到的是"点了没反应"，
///    而日志里一切正常。
///
/// 所以标题必须与白名单里那一项**逐字相同**。`windows.rs` 的
/// `面板标题必须与平台白名单一致` 测试钉着这条依赖，改名会直接让它变红。
pub const PANEL_TITLE: &str = "浮光·主面板";
/// 提醒弹窗窗口标题。
pub const ALERT_TITLE: &str = "浮光·提醒";

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

    /// 每个面板窗口记住的位置（逻辑像素），键是窗口 label。
    ///
    /// # 为什么必须有它
    ///
    /// 原来面板的位置是"每次显示都重新算一遍，摆到小球左边"。单面板时没问题，
    /// 多面板就完全不行：`panel` 和 `panel-2` 会被算到**同一个坐标**上，
    /// 用户看到的是"点了新建窗口但什么都没发生"（其实新窗口正好压在旧窗口下面）。
    ///
    /// # 向后兼容是硬性要求
    ///
    /// `#[serde(default)]` 不是可选项：老版本写出来的 `window.json` 里没有这个字段，
    /// 少了它整个文件会解析失败 —— 而 [`storage::read_json`] 对解析失败的处理是
    /// **把文件改名隔离并回退默认值**，用户会发现"小球位置也一起被忘了"。
    /// 反过来，老版本读新文件是安全的：`WindowState` 没有 `deny_unknown_fields`，
    /// 多出来的 `panels` 键会被忽略。
    #[serde(default)]
    pub panels: HashMap<String, PanelPos>,
}

/// 一个面板窗口记住的位置（逻辑像素）。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct PanelPos {
    pub x: f64,
    pub y: f64,
}

/// 面板之间错开的距离（逻辑像素）。
///
/// 28 是"一眼能看出是两个窗口，又不会把后开的那个顶出屏幕"的折中：
/// 面板宽 420，错开 28 时两个面板并排能露出大半个标题栏，
/// 用户能直接拖动被压住的那个。
const PANEL_STAGGER: f64 = 28.0;

/// `panel` → 1，`panel-N` → N，其余（含 `panel-`、`panel-abc`、`ball`）→ `None`。
///
/// 编号从 1 开始且 `panel-1` **不合法**：`panel` 本身就是 1 号，
/// 再允许 `panel-1` 会让"最小空闲号"出现两个候选，排序也会含糊。
pub fn panel_number(label: &str) -> Option<u32> {
    if label == PANEL {
        return Some(1);
    }
    let rest = label.strip_prefix(PANEL_PREFIX)?.strip_prefix('-')?;
    rest.parse::<u32>().ok().filter(|n| *n >= 2)
}

/// 这个 label 是不是一个面板窗口。
///
/// 关闭拦截、位置记忆都用它。刻意不做成 `starts_with(PANEL_PREFIX)`：
/// 那样 `panelSomething`（将来万一有人这么命名）也会被当成面板，
/// 而它的行为跟面板完全不一样。
pub fn is_panel_label(label: &str) -> bool {
    panel_number(label).is_some()
}

/// 从一堆 label 里挑出面板，并按**编号**排序。
///
/// 按编号而不是按字符串排序：字符串序下 `panel-10` 会排在 `panel-2` 前面，
/// 而"面板列表"是给用户看的，顺序必须符合直觉。
pub fn panel_labels_from<I: IntoIterator<Item = String>>(labels: I) -> Vec<String> {
    let mut numbered: Vec<(u32, String)> = labels
        .into_iter()
        .filter_map(|label| panel_number(&label).map(|n| (n, label)))
        .collect();
    numbered.sort_by_key(|(n, _)| *n);
    numbered.into_iter().map(|(_, label)| label).collect()
}

/// 下一个可用的面板 label：**最小的空闲编号**（从 2 起）。
///
/// 找最小空闲号而不是"最大号 + 1"：用户关掉 `panel-2` 之后新建窗口，
/// 应该拿回 `panel-2` 这个名字（连带拿回它记住的位置），
/// 而不是一路涨到 `panel-7`、把面板列表拉得越来越长。
pub fn next_panel_label_from(existing: &[String]) -> String {
    let used: Vec<u32> = existing.iter().filter_map(|l| panel_number(l)).collect();
    let mut n = 2u32;
    while used.contains(&n) {
        n += 1;
    }
    format!("{PANEL_PREFIX}-{n}")
}

/// 当前存在的全部面板 label（按编号排序）。
pub fn panel_labels(app: &AppHandle) -> Vec<String> {
    panel_labels_from(app.webview_windows().into_keys())
}

/// 下一个可用的面板 label。
pub fn next_panel_label(app: &AppHandle) -> String {
    next_panel_label_from(&panel_labels(app))
}

/// 把 `None` / 空串归一成 `"panel"`。
///
/// 前端不传 label 时的语义就是"第一个面板"（托盘、悬浮球菜单、
/// 旧版本前端的调用都是这个意思）。
pub fn normalize_panel_label(label: Option<&str>) -> String {
    match label {
        Some(l) if !l.trim().is_empty() => l.trim().to_string(),
        _ => PANEL.to_string(),
    }
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

/// 待落盘的面板位置，以及"已经有一个后台线程在收尾"这个标记。
///
/// # 为什么不是"来一次写一次"
///
/// 拖动窗口时 `WindowEvent::Moved` 每秒会来几十次，每次都写盘会让磁盘一直在抖，
/// 而且写的是同一份 `window.json`（小球的位置也在这个文件里）。
///
/// # 为什么也不是简单的节流
///
/// 节流（比如"每 500ms 最多写一次"）会把**用户松手那一刻**的位置丢掉 ——
/// 而那恰好是唯一重要的那一次。所以这里攒着，等安静下来再写一次。
struct MoveFlush {
    pending: Vec<(String, (f64, f64))>,
    running: bool,
}

/// 用 `Vec` 而不是 `HashMap` 是因为它要能放进 `static`：
/// `Vec::new()` 是 `const fn`，`HashMap::new()` 不是。
static MOVE_FLUSH: Mutex<MoveFlush> = Mutex::new(MoveFlush {
    pending: Vec::new(),
    running: false,
});

/// 收到面板移动事件时记下来（由 `lib.rs` 的 `on_window_event` 调用）。
///
/// 位置记忆放在 Rust 侧而不是让前端去调 `save_panel_pos`：窗口拖动是**系统行为**，
/// 前端拿不到"用户什么时候松手"，只能靠 `resize`/`scroll` 之类的近似信号，
/// 而它已经有别的事要管了。
pub fn remember_panel_move(app: &AppHandle, label: &str, x: f64, y: f64) {
    if !is_panel_label(label) || validate_position(x, y).is_err() {
        return;
    }

    let spawn_flusher = {
        let mut state = MOVE_FLUSH.lock().unwrap_or_else(|e| e.into_inner());
        match state.pending.iter_mut().find(|(l, _)| l == label) {
            Some(slot) => slot.1 = (x, y),
            None => state.pending.push((label.to_string(), (x, y))),
        }
        if state.running {
            false
        } else {
            state.running = true;
            true
        }
    };

    if spawn_flusher {
        let handle = app.clone();
        std::thread::spawn(move || flush_panel_moves(handle));
    }
}

/// 安静下来之后把攒下的面板位置写一次盘。
///
/// 交接是严密的：`pending` 是否为空和 `running` 的复位在**同一把锁**里完成，
/// 所以不存在"新事件看到 running=true 就回去了、而那个线程刚好已经退出"的空档。
fn flush_panel_moves(app: AppHandle) {
    loop {
        std::thread::sleep(Duration::from_millis(700));

        let batch = {
            let mut state = MOVE_FLUSH.lock().unwrap_or_else(|e| e.into_inner());
            if state.pending.is_empty() {
                state.running = false;
                return;
            }
            std::mem::take(&mut state.pending)
        };

        let mut window_state = load_window_state(&app);
        for (label, (x, y)) in batch {
            window_state.panels.insert(label, PanelPos { x, y });
        }
        if let Err(err) = storage::write_json(&app, FILE_WINDOW, &window_state) {
            // 位置记不住不该弹任何东西给用户，但必须留下线索
            crate::diag!("[浮光] 面板位置保存失败：{err}");
        }
    }
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
        // 标题必须是 BALL_TITLE，理由见 PANEL_TITLE 的说明（平台标题白名单）
        .title(BALL_TITLE)
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
///
/// 丢到独立线程后两者都避免。
pub fn spawn_show_panel(app: &AppHandle) {
    spawn_show_panel_labeled(app, None);
}

/// 在独立线程上显示**指定**面板（`None` = 第一个面板）。理由同 [`spawn_show_panel`]。
pub fn spawn_show_panel_labeled(app: &AppHandle, label: Option<String>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = show_panel(&handle, label.as_deref());
    });
}

/// 在独立线程上切换主面板显隐。理由同 [`spawn_show_panel`]。
pub fn spawn_toggle_panel(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = toggle_panel(&handle, None);
    });
}

/// 在独立线程上新建一个面板窗口。理由同 [`spawn_show_panel`]。
pub fn spawn_new_panel(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = new_panel(&handle);
    });
}

/// 创建或显示指定面板。
///
/// `label` 为 `None` / 空串表示 `"panel"`（见 [`normalize_panel_label`]）。
pub fn show_panel(app: &AppHandle, label: Option<&str>) -> tauri::Result<WebviewWindow> {
    let label = normalize_panel_label(label);
    show_panel_labeled(app, &label)
}

/// 创建或显示一个指定 label 的面板。
fn show_panel_labeled(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(label) {
        // 有记住的位置就摆回去；没有（或那块屏幕已经拔了）才跟小球走
        position_panel(app, &win, label);
        win.show()?;
        win.set_focus()?;
        return Ok(win);
    }
    create_panel(app, label)
}

/// 新建一个面板窗口，返回它的 label。
///
/// 用**最小空闲编号**，所以关掉 `panel-2` 之后新建的窗口又叫 `panel-2`。
pub fn new_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let label = next_panel_label(app);
    create_panel(app, &label)
}

/// 真正创建面板窗口。
fn create_panel(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    // 置顶与否由**设置**决定，不再硬编码 true。
    // 硬编码的后果：用户在设置页明确关掉的「面板保持置顶」每次开机都被还原，
    // 而设置文件里还写着 false —— 界面和实际行为互相打脸。
    let always_on_top = {
        let store = app.state::<crate::state::Store>();
        let st = store.lock();
        st.settings.panel_always_on_top
    };

    let win = WebviewWindowBuilder::new(
        app,
        label,
        // 所有面板共用同一个前端路由：面板内停在哪个页签是**窗口自己的状态**，
        // 靠各自的 DOM 记住，不由 URL 决定 —— 那样才能"两个面板停在不同页签"。
        WebviewUrl::App("index.html#/panel".into()),
    )
    // ⚠️ 标题必须是 PANEL_TITLE 这一个字面量，理由见那里的说明
    .title(PANEL_TITLE)
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

    position_panel(app, &win, label);
    win.show()?;
    win.set_focus()?;
    Ok(win)
}

/// 隐藏指定面板（保留窗口实例，下次打开更快）。
pub fn hide_panel(app: &AppHandle, label: &str) -> Result<(), String> {
    let label = normalize_panel_label(Some(label));
    if let Some(win) = app.get_webview_window(&label) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 关闭一个面板窗口。
///
/// # `panel` 只藏不销毁
///
/// 第一个面板是常驻的（和悬浮球一样）：它承载用户最常用的那套页签状态，
/// 销毁重建会让搜索框内容、滚动位置、当前文件夹全部回到初始值。
///
/// # 额外面板直接销毁
///
/// 用户点「关闭这个窗口」就是明确不要它了。**代价**：那个窗口里前端的
/// 内存状态（例如正在编辑但还没落盘的片段）会一起丢。要彻底解决需要前端
/// 在关闭前主动 flush 一次（见 `src/lib/store.ts` 的写盘时机），
/// 那属于前端的改动面，这里只保证**不会**顺手把别的窗口的数据冲掉。
///
/// 用 `destroy()` 而不是 `close()`：`close()` 会走 `CloseRequested`，
/// 而那个事件已经被 [`crate::windows::is_panel_label`] 的分支拦成"只隐藏"了，
/// 于是"关闭"会变成"藏起来"、用户点了没反应。
pub fn close_panel(app: &AppHandle, label: &str) -> Result<(), String> {
    let label = normalize_panel_label(Some(label));
    if label == PANEL {
        return hide_panel(app, PANEL);
    }
    if !is_panel_label(&label) {
        return Err(format!("{label} 不是面板窗口"));
    }
    if let Some(win) = app.get_webview_window(&label) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    // 记住的位置**刻意保留**：下次新建窗口如果又拿到这个 label，
    // 它会回到用户上次放它的地方，而不是又叠回屏幕中间。
    Ok(())
}

/// 给一个面板选位置：优先用它记住的位置，没有就摆到小球旁边。
///
/// # 为什么"记住的位置"优先
///
/// 面板是**可以拖动的**（前端标题栏带 `data-tauri-drag-region`，见
/// `src/windows/PanelWindow.tsx`）。用户拖过之后，每次唤出都把它拽回小球旁边
/// 等于"用户摆的位置不算数"；多面板时更糟 —— 两个面板会被算到同一个坐标上。
///
/// 所以顺序是：记住的位置（且那块屏幕还在）→ 小球旁边（按序号错开）。
fn position_panel(app: &AppHandle, panel: &WebviewWindow, label: &str) {
    let saved = load_window_state(app).panels.get(label).copied();
    if let Some(pos) = saved {
        if place_panel_at(panel, pos) {
            return;
        }
    }
    position_panel_near_ball(app, panel, panel_number(label).unwrap_or(1));
}

/// 把面板摆到记住的逻辑坐标。返回是否真的摆成功了。
///
/// 位置**现在不在任何屏幕上**（用户拔了副屏、改了显示器排列）时必须返回 false：
/// 硬摆过去面板会落在屏幕外，用户根本够不着它 —— 而面板没有任务栏图标
/// （`skip_taskbar(true)`），连"从任务栏点回来"这条退路都没有。
fn place_panel_at(panel: &WebviewWindow, pos: PanelPos) -> bool {
    if validate_position(pos.x, pos.y).is_err() {
        return false;
    }
    // 逻辑 → 物理，才能用 monitor_from_point 判断"这个点还在不在屏幕上"
    let scale = panel.scale_factor().unwrap_or(1.0);
    let px = (pos.x * scale).round() as i32;
    let py = (pos.y * scale).round() as i32;
    if monitor_at_for(panel, px, py).is_none() {
        return false;
    }
    panel.set_position(tauri::LogicalPosition::new(pos.x, pos.y)).is_ok()
}

/// 取包含指定物理坐标的那块显示器。
///
/// 多显示器下**不能用 `primary_monitor`**：小球被拖到副屏之后，
/// 用主屏的尺寸去夹取坐标会把面板夹回主屏——
/// 表现就是"点了小球，面板出现在另一个屏幕上"。
fn monitor_at(app: &AppHandle, x: i32, y: i32) -> Option<tauri::Monitor> {
    app.monitor_from_point(x as f64, y as f64).ok().flatten()
}

/// 同 [`monitor_at`]，但调用方手里只有窗口（[`place_panel_at`] 就是这种情况）。
fn monitor_at_for(panel: &WebviewWindow, x: i32, y: i32) -> Option<tauri::Monitor> {
    panel.monitor_from_point(x as f64, y as f64).ok().flatten()
}

/// 让面板出现在小球旁边，并保证不超出**小球所在的那块屏幕**。
///
/// `number` 是面板编号（`panel` 是 1，`panel-2` 是 2……），用来**错开**位置：
/// 不错开的话每个新面板都会精确叠在上一个上面，用户以为"新建窗口没反应"。
fn position_panel_near_ball(app: &AppHandle, panel: &WebviewWindow, number: u32) {
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
    // 垂直方向与小球对齐，但不超出这块屏幕
    let mut y = ball_pos.y;

    // 按编号错开（第 1 个不偏移）。夹取放在偏移之后：
    // 先偏移再夹取，最坏情况是"偏移被夹没了"（两个面板重合），
    // 先夹取再偏移则可能把面板推出屏幕。
    let stagger = ((number.saturating_sub(1)) as f64 * PANEL_STAGGER * scale) as i32;
    x += stagger;
    y += stagger;

    let max_x = (screen_x + screen_w - panel_w).max(screen_x);
    x = x.clamp(screen_x, max_x);
    let max_y = (screen_y + screen_h - panel_h).max(screen_y);
    y = y.clamp(screen_y, max_y);

    let _ = panel.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 切换指定面板的显隐。右键菜单与左键点击都走这里。
///
/// `label` 为 `None` / 空串表示第一个面板。
pub fn toggle_panel(app: &AppHandle, label: Option<&str>) -> tauri::Result<()> {
    let label = normalize_panel_label(label);
    match app.get_webview_window(&label) {
        Some(win) if win.is_visible().unwrap_or(false) => {
            win.hide()?;
        }
        _ => {
            show_panel(app, Some(&label))?;
        }
    }
    Ok(())
}

/// 最近一次提醒的内容。前端挂载时主动拉一次（见 [`last_alert`]）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertContent {
    pub title: String,
    pub body: String,
    /// 这是不是**闹钟**。提醒窗靠它决定响多久：
    /// 闹钟按手机的逻辑"响到你处理为止"，其余几种只是一声提醒。
    pub is_alarm: bool,
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
pub fn show_alert(app: &AppHandle, title: &str, body: &str, is_alarm: bool) -> tauri::Result<()> {
    use tauri::Emitter;

    // 先记下来：无论事件能不能送达，前端挂载时都能拉到
    *last_alert_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(AlertContent {
        title: title.to_string(),
        body: body.to_string(),
        is_alarm,
    });

    let url = format!(
        "index.html#/alert?title={}&body={}&alarm={}",
        urlencode(title),
        urlencode(body),
        if is_alarm { 1 } else { 0 }
    );

    if let Some(win) = app.get_webview_window(ALERT) {
        // 先推内容再显示，避免用户看到旧内容闪一下
        let _ = win.emit(
            "alert:content",
            serde_json::json!({ "title": title, "body": body, "isAlarm": is_alarm }),
        );
        win.show()?;
        win.set_focus()?;
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, ALERT, WebviewUrl::App(url.into()))
        // 标题必须是 ALERT_TITLE，理由见 PANEL_TITLE 的说明（平台标题白名单）
        .title(ALERT_TITLE)
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
            panels: HashMap::new(),
        };
        let json = serde_json::to_string(&state).expect("序列化");
        assert!(json.contains("\"ballX\""), "实际：{json}");
        assert!(!json.contains("ball_x"), "不该出现下划线命名");

        // 老文件（或将来只存了别的窗口）缺这两个字段时不能解析失败
        let empty: WindowState = serde_json::from_str("{}").expect("必须能解析");
        assert_eq!(empty.ball_x, None);
        assert_eq!(empty.ball_y, None);
        assert!(empty.panels.is_empty());
    }

    // ===========================================================
    // 多面板
    // ===========================================================

    #[test]
    fn 面板标题必须与平台白名单一致() {
        // ⚠️ 这条测试钉的是一个**跨模块的隐式依赖**：
        // `platform::OUR_WINDOW_TITLES` 靠精确标题把浮光自己的窗口排除在
        // 「粘贴目标」之外。新面板如果叫「浮光·主面板 2」，白名单就匹配不上，
        // 粘贴会打回浮光自己身上（用户看到"点了没反应"）。
        //
        // 谁把标题改成带序号的形式，这里立刻会红。
        for title in [BALL_TITLE, PANEL_TITLE, ALERT_TITLE] {
            assert!(
                crate::platform::OUR_WINDOW_TITLES.contains(&title),
                "标题「{title}」不在平台白名单里 —— 粘贴目标识别会失效"
            );
        }
        // 白名单里也不该有没人用的死条目（改名时容易漏掉一处）
        for title in crate::platform::OUR_WINDOW_TITLES {
            assert!(
                [BALL_TITLE, PANEL_TITLE, ALERT_TITLE].contains(&title),
                "白名单里的「{title}」没有对应窗口"
            );
        }
    }

    #[test]
    fn 面板编号只认_panel_和_panel_数字() {
        assert_eq!(panel_number("panel"), Some(1));
        assert_eq!(panel_number("panel-2"), Some(2));
        assert_eq!(panel_number("panel-10"), Some(10));

        // 这些都不是面板：认错的话关闭拦截和位置记忆都会作用到别的窗口上
        for bad in [
            "ball",
            "alert",
            "panel-",
            "panel-abc",
            "panel-1",   // 1 号就是 `panel` 本身
            "panel-0",   // 编号从 2 起
            "panelx",    // 前缀相同但不是面板
            "mypanel-2", // 前缀必须从头开始
            "",
        ] {
            assert_eq!(panel_number(bad), None, "{bad:?} 不该被当成面板");
        }
    }

    #[test]
    fn 面板列表按编号排序而不是按字符串() {
        // 字符串序下 panel-10 会排在 panel-2 前面，而这是给用户看的列表
        let labels: Vec<String> = ["panel-10", "panel", "panel-3", "ball", "panel-2"]
            .iter()
            .map(|l| l.to_string())
            .collect();

        assert_eq!(
            panel_labels_from(labels),
            vec!["panel", "panel-2", "panel-3", "panel-10"]
        );
    }

    #[test]
    fn 下一个面板_label_取最小空闲编号() {
        let of = |labels: &[&str]| {
            next_panel_label_from(&labels.iter().map(|l| l.to_string()).collect::<Vec<_>>())
        };

        // 第一个额外面板是 panel-2（`panel` 已经被本体占了）
        assert_eq!(of(&["panel"]), "panel-2");
        assert_eq!(of(&["panel", "panel-2"]), "panel-3");
        assert_eq!(of(&["panel", "panel-2", "panel-3"]), "panel-4");

        // 关掉 panel-2 之后新建必须**复用** panel-2，而不是一路涨到 panel-4：
        // 否则面板列表越拉越长，而且它记住的位置也接不上
        assert_eq!(of(&["panel", "panel-3"]), "panel-2");
        assert_eq!(of(&["panel", "panel-2", "panel-4"]), "panel-3");

        // 一个面板都没有（理论上不会）也要给出合法值
        assert_eq!(of(&[]), "panel-2");
        // 非面板 label 不参与编号
        assert_eq!(of(&["ball", "alert"]), "panel-2");
    }

    #[test]
    fn 没有_label_时归一成第一个面板() {
        assert_eq!(normalize_panel_label(None), "panel");
        assert_eq!(normalize_panel_label(Some("")), "panel");
        assert_eq!(normalize_panel_label(Some("   ")), "panel");
        assert_eq!(normalize_panel_label(Some("panel-3")), "panel-3");
        assert_eq!(normalize_panel_label(Some(" panel-3 ")), "panel-3");
    }

    #[test]
    fn 旧版_window_json_没有_panels_字段也能读() {
        // **向后兼容的守门测试。**
        //
        // 老版本写的 window.json 只有两个字段。加 `panels` 时如果漏了
        // `#[serde(default)]`，整个文件会解析失败 → `storage::read_json`
        // 把它改名隔离 → 用户发现"小球位置被忘了"（还会多出一个 .corrupt 文件）。
        let old = r#"{ "ballX": 120.5, "ballY": -40.0 }"#;
        let state: WindowState = serde_json::from_str(old).expect("老文件必须能解析");

        assert_eq!(state.ball_x, Some(120.5));
        assert_eq!(state.ball_y, Some(-40.0));
        assert!(state.panels.is_empty(), "缺字段要补成空表，而不是报错");
    }

    #[test]
    fn 新版_window_json_带_panels_能往返() {
        let mut state = WindowState {
            ball_x: Some(1.0),
            ball_y: Some(2.0),
            panels: HashMap::new(),
        };
        state.panels.insert("panel".into(), PanelPos { x: 100.0, y: 200.0 });
        state.panels.insert("panel-2".into(), PanelPos { x: 128.0, y: 228.0 });

        let json = serde_json::to_string(&state).expect("序列化");
        assert!(json.contains("\"panels\""), "实际：{json}");

        let back: WindowState = serde_json::from_str(&json).expect("反序列化");
        assert_eq!(back.panels.len(), 2);
        assert_eq!(back.panels["panel-2"].x, 128.0);
        assert_eq!(back.panels["panel-2"].y, 228.0);
    }

    #[test]
    fn 新版_window_json_被老版本读到时会忽略_panels() {
        // 反向兼容：用户先装新版（写出 panels），再退回老版。
        // 老版的 WindowState 里没有这个字段，没有 `deny_unknown_fields` 就该忽略它，
        // 而不是把文件判成损坏、连带把小球位置也丢了。
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct OldWindowState {
            #[serde(default)]
            ball_x: Option<f64>,
            #[serde(default)]
            ball_y: Option<f64>,
        }

        let new_json = r#"{
            "ballX": 10.0, "ballY": 20.0,
            "panels": { "panel": { "x": 1.0, "y": 2.0 } }
        }"#;
        let old: OldWindowState = serde_json::from_str(new_json).expect("老版本必须能读新文件");
        assert_eq!(old.ball_x, Some(10.0));
        assert_eq!(old.ball_y, Some(20.0));
    }

    #[test]
    fn 面板位置缺失或损坏时给出可用的默认值() {
        // `panels` 里某一项坏掉（手改过）时，整份文件仍然要能读 ——
        // 反序列化是"要么全成、要么全败"，所以这里钉住合法的形状
        let json = r#"{ "panels": { "panel-2": { "x": 5, "y": 6 } } }"#;
        let state: WindowState = serde_json::from_str(json).expect("必须能解析");
        assert_eq!(state.panels["panel-2"].x, 5.0);
        assert_eq!(state.panels["panel-2"].y, 6.0);
    }
}
