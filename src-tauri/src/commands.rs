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
//!
//! # 时间计算的归属
//!
//! 所有"下一次提醒是什么时候""还剩多少毫秒"都由**前端**算好，
//! 命令只负责存绝对值。原因见 [`crate::models`] 顶部说明。

use tauri::{AppHandle, Manager};

use crate::linkicon::IconData;
use crate::models::{Link, Memo, Settings, Timer};
use crate::state::{self, Store};
use crate::{autostart, ballmenu, hotkey, launcher, linkicon, platform, storage, windows};

// ===============================================================
// 窗口与进程
// ===============================================================

/// 在悬浮球上弹出原生右键菜单。
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

/// 隐藏悬浮球。
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

/// 设置某个窗口是否置顶。
#[tauri::command]
pub async fn set_always_on_top(app: AppHandle, label: String, value: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在：{label}"))?;
    win.set_always_on_top(value).map_err(|e| e.to_string())
}

// ===============================================================
// 剪贴板与粘贴
// ===============================================================

/// 把文本粘贴到「上一次使用的外部窗口」的光标处。
///
/// 必须是 `async`：内部有必要的等待（等焦点切换、等粘贴完成再还原剪贴板），
/// 总共约 180ms。放在主线程上会让整个界面卡顿，并且会拖住窗口消息循环，
/// 影响焦点切换本身。
#[tauri::command]
pub async fn paste_text(
    app: AppHandle,
    text: String,
    restore_delay_ms: Option<u64>,
) -> platform::PasteOutcome {
    // 没显式传延时就用设置里的值。
    //
    // 注意这里必须先 `let delay = ...` 再返回：如果直接写
    // `store.lock().settings.paste_restore_delay_ms` 作为块尾表达式，
    // MutexGuard 这个临时变量的析构会晚于局部变量 `store`，
    // 借用检查器会报 "store does not live long enough"。
    let delay = match restore_delay_ms {
        Some(d) => d,
        None => {
            let store = app.state::<Store>();
            let value = store.lock().settings.paste_restore_delay_ms;
            value
        }
    };
    platform::paste_to_target(&text, delay)
}

/// 只把文本放进剪贴板，不做粘贴。
#[tauri::command]
pub async fn copy_text(text: String) -> bool {
    platform::clipboard_set_text(&text)
}

// ===============================================================
// 通用数据文件读写（文本片段还在用）
// ===============================================================

/// 读取数据文件。文件不存在时返回 `null`，由前端用默认值初始化。
#[tauri::command]
pub async fn read_data(app: AppHandle, file: String) -> Result<serde_json::Value, String> {
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

/// 取数据目录路径。
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

// ===============================================================
// 计时器
// ===============================================================

/// 列出全部计时器。
#[tauri::command]
pub async fn timers_list(app: AppHandle) -> Vec<Timer> {
    let store = app.state::<Store>();
    // 先绑定再返回，避免 MutexGuard 临时变量活过 store（见 paste_text 的说明）
    let list = store.lock().timers.clone();
    list
}

/// 新增或更新一个计时器。
///
/// 开始、暂停、重置、计次全部由前端算好后调这一个命令，
/// 因为"现在几点"前端和 Rust 拿到的是同一个时钟，
/// 而"还剩多少"这种计算放前端能直接复用 JS 的日期能力。
#[tauri::command]
pub async fn timer_save(app: AppHandle, timer: Timer) -> Result<(), String> {
    let store = app.state::<Store>();
    let list = {
        let mut st = store.lock();
        match st.timers.iter_mut().find(|t| t.id == timer.id) {
            Some(slot) => *slot = timer,
            None => st.timers.push(timer),
        }
        st.timers.clone()
    };
    state::save_timers(&app, &list)
}

/// 删除一个计时器。
#[tauri::command]
pub async fn timer_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    let list = {
        let mut st = store.lock();
        st.timers.retain(|t| t.id != id);
        st.timers.clone()
    };
    state::save_timers(&app, &list)
}

// ===============================================================
// 备忘录
// ===============================================================

/// 列出全部备忘录。
#[tauri::command]
pub async fn memos_list(app: AppHandle) -> Vec<Memo> {
    let store = app.state::<Store>();
    let list = store.lock().memos.clone();
    list
}

/// 新增或更新一条备忘录。
#[tauri::command]
pub async fn memo_save(app: AppHandle, memo: Memo) -> Result<(), String> {
    let store = app.state::<Store>();
    let list = {
        let mut st = store.lock();
        match st.memos.iter_mut().find(|m| m.id == memo.id) {
            Some(slot) => *slot = memo,
            None => st.memos.push(memo),
        }
        st.memos.clone()
    };
    state::save_memos(&app, &list)
}

/// 删除一条备忘录。
#[tauri::command]
pub async fn memo_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    let list = {
        let mut st = store.lock();
        st.memos.retain(|m| m.id != id);
        st.memos.clone()
    };
    state::save_memos(&app, &list)
}

// ===============================================================
// 快捷链接
// ===============================================================

/// 列出全部快捷链接（按 order 再按创建时间排序）。
#[tauri::command]
pub async fn links_list(app: AppHandle) -> Vec<Link> {
    let store = app.state::<Store>();
    let mut list = store.lock().links.clone();
    list.sort_by_key(|l| (l.order, l.created_at));
    list
}

/// 新增或更新一个快捷链接。
#[tauri::command]
pub async fn link_save(app: AppHandle, link: Link) -> Result<(), String> {
    let store = app.state::<Store>();
    let list = {
        let mut st = store.lock();
        match st.links.iter_mut().find(|l| l.id == link.id) {
            Some(slot) => *slot = link,
            None => st.links.push(link),
        }
        st.links.clone()
    };
    state::save_links(&app, &list)
}

/// 删除一个快捷链接。
#[tauri::command]
pub async fn link_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    let list = {
        let mut st = store.lock();
        st.links.retain(|l| l.id != id);
        st.links.clone()
    };
    state::save_links(&app, &list)
}

/// 启动一个快捷链接。
#[tauri::command]
pub async fn link_launch(app: AppHandle, id: String) -> Result<(), String> {
    let target = {
        let store = app.state::<Store>();
        let st = store.lock();
        st.links
            .iter()
            .find(|l| l.id == id)
            .map(|l| (l.target.clone(), l.args.clone()))
    };
    let Some((target, args)) = target else {
        return Err("找不到这个链接，可能已被删除".into());
    };
    launcher::open(&target, args.as_deref())
}

/// 直接打开一个路径或网址（用于"添加后立即测试"这类场景）。
#[tauri::command]
pub async fn open_target(target: String, args: Option<String>) -> Result<(), String> {
    launcher::open(&target, args.as_deref())
}

/// 在资源管理器中定位某个文件。
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    launcher::reveal_in_explorer(&path)
}

/// 提取某个路径的图标。
///
/// 失败返回 `null`，前端会退回按类型区分的内置图标。
/// 提取涉及 Shell 与 GDI，属于"尽力而为"，不能让失败影响到界面。
#[tauri::command]
pub async fn link_icon(path: String) -> Option<IconData> {
    linkicon::extract(&path)
}

// ===============================================================
// 设置
// ===============================================================

/// 读取设置。
#[tauri::command]
pub async fn settings_get(app: AppHandle) -> Settings {
    let store = app.state::<Store>();
    let s = store.lock().settings.clone();
    s
}

/// 保存设置。
#[tauri::command]
pub async fn settings_save(app: AppHandle, settings: Settings) -> Result<(), String> {
    let saved = {
        let store = app.state::<Store>();
        let mut st = store.lock();
        st.settings = settings.clone();
        settings
    };
    state::save_settings(&app, &saved)
}

/// 查询开机自启是否已开启。
///
/// 直接读注册表而不是读内存里的设置：
/// 用户可能刚在「任务管理器 → 启动」里手动关掉，
/// 以注册表为准才不会显示错误的状态。
#[tauri::command]
pub async fn autostart_get() -> bool {
    autostart::is_enabled()
}

/// 设置开机自启。
#[tauri::command]
pub async fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    autostart::set_enabled(enabled)?;
    // 注册表写成功后再同步内存与文件，避免两边不一致
    let saved = {
        let store = app.state::<Store>();
        let mut st = store.lock();
        st.settings.autostart = enabled;
        st.settings.clone()
    };
    state::save_settings(&app, &saved)
}

/// 取当前 exe 路径。设置页用它提示"开机自启会启动这个文件"。
#[tauri::command]
pub async fn current_exe() -> Result<String, String> {
    autostart::current_exe_path()
}

// ===============================================================
// 全局热键
// ===============================================================

/// 取**当前实际生效**的热键文本。
///
/// 刻意不返回设置里存的值，而是返回真正注册成功的那个。
/// 因为注册可能失败（组合键被别的程序占用），
/// 这时设置里存着、实际却没生效——只显示存的值会骗用户。
#[tauri::command]
pub async fn hotkey_current() -> Option<String> {
    hotkey::current()
}

/// 应用热键设置。
///
/// `enabled` 为 false 时注销；为 true 时按 `combo` 注册。
/// 注册失败会返回明确的中文原因，**调用方必须把它显示给用户**，
/// 不能静默失效——否则用户会以为热键开着，然后一直按一直没反应。
#[tauri::command]
pub async fn hotkey_apply(
    app: AppHandle,
    enabled: bool,
    combo: String,
) -> Result<(), String> {
    hotkey::apply(if enabled { Some(combo.as_str()) } else { None })?;

    // 注册成功后再落盘，避免"存了一个用不了的组合键"
    let saved = {
        let store = app.state::<Store>();
        let mut st = store.lock();
        st.settings.hotkey_enabled = enabled;
        if enabled {
            st.settings.hotkey = combo;
        }
        st.settings.clone()
    };
    state::save_settings(&app, &saved)
}

/// 校验一个热键文本是否合法，不实际注册。
///
/// 设置页用它做即时提示，让用户在按下组合键的当下就知道能不能用，
/// 而不是等到点保存才报错。
#[tauri::command]
pub async fn hotkey_validate(combo: String) -> Result<String, String> {
    hotkey::parse(&combo).map(|c| c.label)
}
