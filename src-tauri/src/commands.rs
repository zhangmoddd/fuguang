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

use tauri::{AppHandle, Emitter, Manager};

use crate::linkicon::IconData;
use crate::models::{Folder, Link, LinkKind, MediaRef, Memo, Settings, Timer};
use crate::state::{self, Store};
use crate::{
    autostart, backup, ballmenu, hotkey, launcher, linkicon, media, platform, storage, windows,
};

// ===============================================================
// 窗口与进程
// ===============================================================

/// 记住悬浮球当前的位置（小球窗口在移动后防抖调用）。
///
/// 单独存 `window.json` 而不是写设置：设置是**整份覆盖写**的，
/// 小球和主面板两个窗口各持一份副本，互相会冲掉（见 `windows::FILE_WINDOW`）。
#[tauri::command]
pub async fn save_ball_pos(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    windows::save_ball_position(&app, x, y)
}

/// 在悬浮球上弹出原生右键菜单。
#[tauri::command]
pub async fn show_ball_menu(app: AppHandle) -> Result<(), String> {
    ballmenu::popup(&app)
}

/// 切换主面板显隐。小球左键点击、托盘点击都调它。
///
/// `label` 为 `null` 表示第一个面板（`panel`）——旧版本前端不传参数也是这个语义。
#[tauri::command]
pub async fn toggle_panel(app: AppHandle, label: Option<String>) -> Result<(), String> {
    windows::toggle_panel(&app, label.as_deref()).map_err(|e| e.to_string())
}

/// 显示主面板（`label` 为 `null` = 第一个面板）。目标不存在时创建它。
#[tauri::command]
pub async fn show_panel(app: AppHandle, label: Option<String>) -> Result<(), String> {
    windows::show_panel(&app, label.as_deref())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 隐藏主面板（保留窗口实例，下次打开更快）。
///
/// # `label` 为空时藏的是**调用方自己那个窗口**
///
/// 这条命令是面板标题栏上那个 ✕ 调的。如果默认藏 `panel`，
/// 那么 `panel-2` 上的 ✕ 会把**第一个**面板收起来，用户看到的是"点了没反应、
/// 另一个窗口莫名其妙消失了"。所以默认值取调用窗口的 label，
/// 只有在拿不到调用窗口时才退回 `panel`。
#[tauri::command]
pub async fn hide_panel(
    app: AppHandle,
    window: tauri::WebviewWindow,
    label: Option<String>,
) -> Result<(), String> {
    let target = label
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| window.label().to_string());
    windows::hide_panel(&app, &target)
}

/// 新建一个主面板窗口，返回它的 label（`panel-2`、`panel-3`……）。
///
/// 新窗口用**最小空闲编号**：关掉 `panel-2` 之后新建的又叫 `panel-2`，
/// 于是它会回到用户上次放它的位置（见 `windows::close_panel`）。
#[tauri::command]
pub async fn new_panel(app: AppHandle) -> Result<String, String> {
    let label = windows::next_panel_label(&app);
    windows::show_panel(&app, Some(&label))
        .map(|_| label)
        .map_err(|e| e.to_string())
}

/// 列出当前存在的全部面板 label（按编号排序）。
#[tauri::command]
pub async fn list_panels(app: AppHandle) -> Vec<String> {
    windows::panel_labels(&app)
}

/// 关闭一个面板窗口。
///
/// 第一个面板（`panel`）是常驻的：它只被隐藏，不销毁。
#[tauri::command]
pub async fn close_panel(app: AppHandle, label: String) -> Result<(), String> {
    windows::close_panel(&app, &label)
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
    // 正常退出也留一行：`app.log` 里"最后一行是启动完成"和
    // "最后一行是某处主动退出"是两种完全不同的结论（见 lib.rs 的 panic 钩子）。
    crate::diag!("[浮光] 退出：设置页的「退出浮光」");
    app.exit(0);
}

/// 设置某个窗口是否置顶。
///
/// `label` 为 `null` 表示"调用方自己那个窗口"（理由同 [`hide_panel`]：
/// 面板标题栏上的图钉在 `panel-2` 里必须管它自己，不能去管 `panel`）。
#[tauri::command]
pub async fn set_always_on_top(
    app: AppHandle,
    window: tauri::WebviewWindow,
    label: Option<String>,
    value: bool,
) -> Result<(), String> {
    let target = label
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| window.label().to_string());
    let win = app
        .get_webview_window(&target)
        .ok_or_else(|| format!("窗口不存在：{target}"))?;
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

/// 读取剪贴板里的文本。
///
/// # 为什么前端不能直接用 `navigator.clipboard.readText()`
///
/// WebView2 里那个 API 需要**剪贴板读权限**（`clipboard-read`），而浮光的
/// capability 里一个剪贴板权限都没开、也没装剪贴板插件（见
/// `capabilities/default.json` 的说明：那里只列"前端真的会用、且不能靠
/// core:default 兜底"的能力）。所以浏览器那个调用在浮光里是**不可靠**的：
/// 运气好弹权限提示，运气不好直接 reject —— 右键菜单的「粘贴」就只剩
/// "请用 Ctrl+V"这句降级提示，而用户第 ⑥ 条要的是一个**能用**的粘贴。
///
/// Rust 侧本来就有这份能力（[`platform::clipboard_get_text`]，
/// 模拟粘贴那条路一直在用它读用户的原文做备份），把它暴露出来即可。
///
/// # 为什么返回 `Option` 而不是 `Result`
///
/// 剪贴板里没有文本（只有图片、或者本来就是空的）是**正常情况**：
/// 前端收到 `null` 就"这次不粘贴，退回让用户自己 Ctrl+V"。
/// 把它做成 `Err` 的话，调用方要么把一条正常路径当错误弹给用户，
/// 要么在每个调用点写 `catch` 去吞它 —— 两者都比 `null` 差。
///
/// ⚠️ 这条命令**只读文本**。剪贴板里是图片时同样返回 `None`：
/// 图片走 [`media_import_clipboard`]（那条路会读 `CF_DIB` 并存进媒体库）。
#[tauri::command]
pub async fn read_clipboard_text() -> Option<String> {
    platform::clipboard_get_text()
}

// ===============================================================
// 图片媒体
//
// 像素落在 `%APPDATA%\浮光\media\`，JSON 里只留引用 —— 理由见
// `models::MediaRef` 与 `media` 模块顶部的说明。
//
// 这一组命令都是 `async`：读写文件、调 GDI+、碰剪贴板都可能要等，
// 放在主线程上会卡住窗口消息循环（见文件头的说明）。
// ===============================================================

/// 从磁盘上的一个文件导入图片。
///
/// 扩展名与文件头都必须是图片，按内容 sha256 去重（同一张图导入两次只留一份）。
#[tauri::command]
pub async fn media_import_path(app: AppHandle, path: String) -> Result<MediaRef, String> {
    media::import_path(&app, &path)
}

/// 从剪贴板导入图片。
///
/// 返回 `null` 表示**剪贴板里没有图片**（用户复制的是文字），
/// 这是正常情况，调用方退回"粘贴文字"即可，不是错误。
///
/// 但"有图片却读不出来"（剪贴板被占用、格式认不出、超过体积上限）会走 `Err`，
/// 前端应当把那条中文原因显示出来 —— 压成 `null` 的话，
/// 用户看到的是"复制了截图却什么都没发生"。
#[tauri::command]
pub async fn media_import_clipboard(app: AppHandle) -> Result<Option<MediaRef>, String> {
    media::import_clipboard(&app)
}

/// 回填宽高与缩略图。
///
/// 宽高由前端用 canvas 量出来（Rust 侧要量就得引图片库，见 `media` 模块头部）。
/// `thumb_png_base64` 是 canvas 的 `toDataURL("image/png")` 去掉
/// `data:image/png;base64,` 前缀之后的部分。
#[tauri::command]
pub async fn media_set_meta(
    app: AppHandle,
    id: String,
    width: u32,
    height: u32,
    thumb_png_base64: String,
) -> Result<MediaRef, String> {
    media::set_meta(&app, &id, width, height, &thumb_png_base64)
}

/// 读一张图片，返回可直接放进 `<img src>` 的 data URL。
///
/// `full = false` 时优先读缩略图（列表里用），没有缩略图就退回原图。
/// ⚠️ `full = true` 会把整张图 base64 一遍，几十兆的图会让 IPC 很慢，
/// 列表里一律用缩略图。
#[tauri::command]
pub async fn media_read(app: AppHandle, id: String, full: bool) -> Result<String, String> {
    media::read_data_url(&app, &id, full)
}

/// 删除一张图片（原图 + 缩略图 + 元数据）。幂等。
#[tauri::command]
pub async fn media_delete(app: AppHandle, id: String) -> Result<(), String> {
    media::delete(&app, &id)
}

/// 把一张图片另存到用户选定的位置（原图字节，不重新编码）。
#[tauri::command]
pub async fn media_export(app: AppHandle, id: String, dest_path: String) -> Result<(), String> {
    media::export(&app, &id, &dest_path)
}

/// 把一张图片写进剪贴板（`CF_DIB`）。
///
/// ⚠️ 会清空用户原来的剪贴板（`EmptyClipboard`），且**不做还原** ——
/// 理由见 `media::copy_image_to_clipboard`。
#[tauri::command]
pub async fn media_copy_image(app: AppHandle, id: String) -> Result<(), String> {
    media::copy_image_to_clipboard(&app, &id)
}

/// 把一张图片"键入到当前光标"：放进剪贴板 → 切回上一次的外部窗口 → 模拟 Ctrl+V。
///
/// 返回 `PasteOutcome`，和文本路径共用同一个结构，前端显示提示的方式可以完全一致。
#[tauri::command]
pub async fn media_paste_to_target(app: AppHandle, id: String) -> Result<platform::PasteOutcome, String> {
    media::paste_to_target(&app, &id)
}

/// 媒体库统计（张数与占用字节数）。
#[tauri::command]
pub async fn media_stats(app: AppHandle) -> media::MediaStats {
    media::stats(&app)
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
    // 走写锁：`backup::import` 会写同一批文件（`snippets.json` 就是其中之一），
    // 前端这次防抖写盘要是插在导入中间落盘，就会把刚恢复的数据盖掉。
    // 这把锁只串行化**写盘**，读取完全不受影响。
    state::with_write_lock(|| storage::write_json(&app, &file, &value))
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
    {
        let mut st = store.lock();
        match st.timers.iter_mut().find(|t| t.id == timer.id) {
            Some(slot) => *slot = timer,
            None => st.timers.push(timer),
        }
    }
    // 快照必须在写锁内重新取：拿锁外这份旧快照落盘，会覆盖掉并发写者的新数据
    state::persist(&app, || store.lock().timers.clone(), state::save_timers)
}

/// 删除一个计时器。
#[tauri::command]
pub async fn timer_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        st.timers.retain(|t| t.id != id);
    }
    state::persist(&app, || store.lock().timers.clone(), state::save_timers)
}

/// 把一个「每天重复」的闹钟推进到下一次响铃时刻。
///
/// # 为什么不能由前端读出来改一改、再 `timer_save` 写回去
///
/// 那是跨越 IPC 的「比较并交换」：前端读到的是 `fired: true, endsAt: null`，
/// 而在它把结果写回来之前，用户可能已经点了「停止」或「再响一次」。
/// `timer_save` 是**整条覆盖写**，于是用户那一下会被静默吞掉 ——
/// 界面上已经变回「未开始」，盘上却还排着明天响，第二天照样吵醒他。
///
/// 所以判断和写入必须落在同一把锁里（见 [`Timer::advance_alarm_to`]）。
/// 下一次响铃时刻仍然由前端算：Rust 没有日历能力，也不打算引
/// （见 [`crate::models`] 顶部的分工）。
///
/// 返回 `true` 表示真的推进了，调用方据此决定要不要广播给其他窗口。
#[tauri::command]
pub async fn timer_advance_alarm(
    app: AppHandle,
    id: String,
    next_ends_at: i64,
) -> Result<bool, String> {
    let store = app.state::<Store>();
    let advanced = {
        let mut st = store.lock();
        match st.timers.iter_mut().find(|t| t.id == id) {
            Some(t) => t.advance_alarm_to(next_ends_at),
            // 用户已经把它删了：什么都不做，更不能把它复活
            None => false,
        }
    };

    if advanced {
        state::persist(&app, || store.lock().timers.clone(), state::save_timers)?;
    }
    Ok(advanced)
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

/// 告诉所有窗口「备忘录变了」。
///
/// # 为什么备忘录需要广播，而计时器/链接暂时不用
///
/// 因为备忘有一条**别的窗口会替它改数据**的路径：后台推进重复提醒
/// （`lib/repeat-advance.ts`，挂在每个窗口的入口，小球窗口常驻所以一直在跑）
/// 会把 `remindAt` 推到下一次。
///
/// 不广播的后果有两层：
/// 1. 主面板的备忘页不知道，一直显示**旧的**提醒时刻 —— `formatUntil` 会说
///    "已到期"，用户以为重复提醒坏了；
/// 2. 更糟：用户此时点「编辑」，编辑器里拿的是那份陈旧对象，保存时把
///    `remindAt = 过期值` 整条写回去，而 Rust 的幂等判断 `fired_for == Some(at)`
///    从此成立 —— **这条重复提醒永久卡死**，只能重启才可能被再推进一次。
///
/// 广播之后闭环是收敛的：推进 → 保存 → 广播 → 各窗口重新拉取 →
/// 此时 `firedFor` 已是 null、没有可推进的 → 不会再保存、也不会再广播。
fn notify_memos_changed(app: &AppHandle) {
    let _ = app.emit("state-changed", serde_json::json!({ "what": ["memos"] }));
}

/// 新增或更新一条备忘录。
#[tauri::command]
pub async fn memo_save(app: AppHandle, memo: Memo) -> Result<(), String> {
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        match st.memos.iter_mut().find(|m| m.id == memo.id) {
            Some(slot) => *slot = memo,
            None => st.memos.push(memo),
        }
    }
    let saved = state::persist(&app, || store.lock().memos.clone(), state::save_memos);
    if saved.is_ok() {
        notify_memos_changed(&app);
    }
    saved
}

/// 删除一条备忘录。
#[tauri::command]
pub async fn memo_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        st.memos.retain(|m| m.id != id);
    }
    let saved = state::persist(&app, || store.lock().memos.clone(), state::save_memos);
    if saved.is_ok() {
        notify_memos_changed(&app);
    }
    saved
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
    {
        let mut st = store.lock();
        match st.links.iter_mut().find(|l| l.id == link.id) {
            Some(slot) => *slot = link,
            None => st.links.push(link),
        }
    }
    state::persist(&app, || store.lock().links.clone(), state::save_links)
}

/// 删除一个快捷链接。
#[tauri::command]
pub async fn link_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        st.links.retain(|l| l.id != id);
    }
    state::persist(&app, || store.lock().links.clone(), state::save_links)
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

/// 提取某个路径的图标。
///
/// 失败返回 `null`，前端会退回按类型区分的内置图标。
/// 提取涉及 Shell 与 GDI，属于"尽力而为"，不能让失败影响到界面。
#[tauri::command]
pub async fn link_icon(path: String) -> Option<IconData> {
    linkicon::extract(&path)
}

/// 判断一批路径各自是什么（拖拽添加链接时用）。
///
/// 前端拿不到"这是不是目录"，所以这里读一次文件系统属性。
/// 认不出来的路径按普通文件处理——拖进来的东西总得能加进去，
/// 不该因为判不出类型就拒绝。
#[tauri::command]
pub async fn classify_paths(paths: Vec<String>) -> Vec<LinkKind> {
    paths.iter().map(|p| launcher::classify(p)).collect()
}

// ===============================================================
// 文件夹
//
// 三个功能页签（链接 / 文本片段 / 计时器）共用一套文件夹，
// 靠 `feature` 字段区分归属。备忘不做文件夹：它的组织维度是日期。
// ===============================================================

/// 列出全部文件夹（按 order 再按创建时间排序）。
///
/// 不做按 `feature` 过滤：总共也就几十个文件夹，一次全取回来，
/// 前端切换页签时不用重新请求，也省掉一个"过滤参数"。
#[tauri::command]
pub async fn folders_list(app: AppHandle) -> Vec<Folder> {
    let store = app.state::<Store>();
    let mut list = store.lock().folders.clone();
    list.sort_by_key(|f| (f.order, f.created_at));
    list
}

/// 新增或更新一个文件夹。
#[tauri::command]
pub async fn folder_save(app: AppHandle, folder: Folder) -> Result<(), String> {
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        match st.folders.iter_mut().find(|f| f.id == folder.id) {
            Some(slot) => *slot = folder,
            None => st.folders.push(folder),
        }
    }
    state::persist(&app, || store.lock().folders.clone(), state::save_folders)
}

/// 删除一个文件夹。
///
/// # 只动 `folders.json`
///
/// 子文件夹会被挂到**被删文件夹的父级**，避免出现"父级没了、孩子谁也够不着"
/// 的孤儿（那种文件夹在界面上永远打不开）。
///
/// 文件夹里的**条目**刻意不在这里处理：条目分散在三份数据里
/// （链接和计时器在 Rust 侧，文本片段还在前端的通用 JSON 里），
/// 统一在这里改意味着这个命令要同时碰四份数据、任何一步失败都会留下不一致。
///
/// 所以约定：**由前端在调用本命令之前，先把该文件夹下的条目改挂到 `parentId`。**
/// 前端本来就知道自己的条目在哪、用哪条命令保存，比这里猜要可靠。
#[tauri::command]
pub async fn folder_remove(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Store>();
    {
        let mut st = store.lock();

        // 先取出父级，再改孩子，最后删自己——顺序不能反，
        // 删掉之后就拿不到它的 parent_id 了。
        let parent = st
            .folders
            .iter()
            .find(|f| f.id == id)
            .and_then(|f| f.parent_id.clone());

        for f in st.folders.iter_mut() {
            if f.parent_id.as_deref() == Some(id.as_str()) {
                f.parent_id = parent.clone();
            }
        }

        st.folders.retain(|f| f.id != id);
    }
    state::persist(&app, || store.lock().folders.clone(), state::save_folders)
}

// ===============================================================
// 备份
// ===============================================================

/// 把全部数据导出成一个备份文件。
///
/// 目标路径由前端的保存对话框给出。路径不可写时返回可读的中文原因，
/// 前端会直接显示出来——"导出失败"不说是为什么，用户没法处理。
#[tauri::command]
pub async fn export_all(app: AppHandle, path: String) -> Result<(), String> {
    backup::export(&app, std::path::Path::new(&path))
}

/// 从备份文件恢复全部数据。**会覆盖当前的全部数据。**
///
/// 前端必须先让用户确认过再调这个命令——它没有撤销。
/// 返回值里带着「带回了多少张图片」和「哪些图片引用缺图」，见 `backup::ImportReport`。
#[tauri::command]
pub async fn import_all(app: AppHandle, path: String) -> Result<backup::ImportReport, String> {
    backup::import(&app, std::path::Path::new(&path))
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

/// 把**当前这条提醒**延后几分钟再弹一次（手机闹钟的「稍后提醒」）。
///
/// # 为什么改的是"提醒"而不是"数据"
///
/// 用户点「稍后提醒」说的是**"这条提醒再等我五分钟"**，
/// 不是"把我的闹钟改成五分钟后"。所以这里只是把当前弹窗的标题正文
/// 原样排进 [`scheduler`] 的稍后队列，**闹钟的钟点、备忘的提醒时刻一个都不动**。
/// 改数据的话，用户下次打开会发现自己设的时间被悄悄改掉了 —— 那才是真的坑。
///
/// `minutes` 必须夹：前端理论上可以传任何数字，一个 525600（一年）
/// 会让这条提醒永远回不来。
#[tauri::command]
pub async fn snooze_alert(minutes: u32) -> Result<(), String> {
    let Some(current) = windows::last_alert() else {
        return Err("现在没有正在显示的提醒".into());
    };
    let minutes = minutes.clamp(1, 60);
    crate::scheduler::push_snooze(
        &current.title,
        &current.body,
        minutes,
        crate::models::now_ms(),
    );
    Ok(())
}

/// 保存设置。
///
/// 存之前必须夹取取值范围：前端理论上可以传任何数字过来，
/// 一个越界的字号会让界面彻底没法用。
///
/// ⚠️ 这是**整份覆盖写**。前端"读出来 → 改一改 → 写回去"的路径要用
/// [`settings_patch`]，不要用这个 —— 理由见那里。
#[tauri::command]
pub async fn settings_save(app: AppHandle, mut settings: Settings) -> Result<(), String> {
    settings.clamp();
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        st.settings = settings;
    }
    state::persist_settings(&app, &store)
}

/// 只改设置的某几项，其余保持**内存里的最新值**。
///
/// # 为什么不能让前端"读出来 → 改一改 → 整份写回去"
///
/// 设置是整份覆盖写的，而它有**三个写者**：设置页、各页签的 Ctrl+滚轮缩放、
/// 以及另一个窗口（小球/面板各持一份副本）。前端"读-改-写"中间隔着一次 IPC
/// 往返，两个写者交错时后写的会把先写的整份盖掉 ——
/// 用户看到的是**「我改的字号自己变回去了」**，而且只在几百毫秒内连改两项时
/// 出现，极难复现、极难归因。
///
/// 所以合并必须落在**同一把锁里**，和 `snippet_bump_use` 是同一个理由。
///
/// # 为什么用 JSON 合并而不是给每个字段写一遍
///
/// 逐个字段写一遍意味着以后每加一个设置项都要来这里改一次，
/// 忘了改的表现是"那一项怎么都存不上"。用 JSON 合并之后，
/// "哪些字段能改"由 `Settings` 自己决定（`serde` 的默认值管缺字段、
/// 未知键被忽略），新增字段不用动这里。
///
/// 返回合并并夹取之后的完整设置，调用方直接拿去更新界面 ——
/// 不然前端手里那份还是旧的，下一次改别的项又会以旧值为基准。
#[tauri::command]
pub async fn settings_patch(
    app: AppHandle,
    changes: serde_json::Value,
) -> Result<Settings, String> {
    let store = app.state::<Store>();
    let next = {
        let mut st = store.lock();
        // 合并逻辑抽在 `models::merge_settings` 里，有单测
        let merged = crate::models::merge_settings(&st.settings, &changes)?;
        st.settings = merged.clone();
        merged
    };

    state::persist_settings(&app, &store)?;
    Ok(next)
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
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        st.settings.autostart = enabled;
    }
    state::persist_settings(&app, &store)
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

/// 取最近一次提醒的内容。
///
/// 提醒窗口挂载时**主动拉一次**：只靠 `alert:content` 事件推送的话，
/// 窗口复用 + 监听器还没就绪时会丢内容 —— 而调度线程已经把 `fired_for`
/// 落盘了，那条提醒就永远不补弹（见 `windows::last_alert` 的说明）。
#[tauri::command]
pub async fn alert_current() -> Option<windows::AlertContent> {
    windows::last_alert()
}

/// 把某条片段的使用次数 +1（「常用优先」的排序靠它）。
///
/// # 为什么放在 Rust 而不是前端
///
/// 片段数据是 `snippets.json`，前端用 `usePersistentState` 读写。而命令面板
/// 是**浮在片段页上面**的 —— 两个组件会同时挂载。如果面板也开一个
/// `usePersistentState`，同一个文件就有**两个写者**（`WriteCoordinator` 是每实例
/// 一份），谁后写谁赢，另一边刚做的改动会被整份覆盖。
///
/// 让 Rust 在**写锁**里做「读 → 改 → 写」，文件层面就只有一条写入路径。
/// （前端内存里那份会短暂陈旧：用户紧接着手动编辑某条片段时，这一次计数会丢。
///  计数只影响排序，丢一次可以接受；把用户的编辑覆盖掉不行。）
#[tauri::command]
pub async fn snippet_bump_use(app: AppHandle, id: String) -> Result<(), String> {
    state::with_write_lock(|| -> Result<(), String> {
        let current = storage::read_json(
            &app,
            "snippets.json",
            serde_json::Value::Array(Vec::new()),
        );
        let Some(list) = current.as_array() else {
            return Ok(()); // 形状不对就别动它
        };

        let mut next = list.clone();
        let mut hit = false;
        for item in next.iter_mut() {
            if item.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
                continue;
            }
            let uses = item.get("uses").and_then(|v| v.as_u64()).unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if let Some(obj) = item.as_object_mut() {
                obj.insert("uses".into(), serde_json::json!(uses + 1));
                obj.insert("updatedAt".into(), serde_json::json!(now));
            }
            hit = true;
            break;
        }
        if !hit {
            return Ok(()); // 找不到就算了，不值得报错
        }
        storage::write_json(&app, "snippets.json", &serde_json::Value::Array(next))
    })
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
    let store = app.state::<Store>();
    {
        let mut st = store.lock();
        st.settings.hotkey_enabled = enabled;
        if enabled {
            st.settings.hotkey = combo;
        }
    }
    state::persist_settings(&app, &store)
}

/// 校验一个热键文本是否合法，不实际注册。
///
/// 设置页用它做即时提示，让用户在按下组合键的当下就知道能不能用，
/// 而不是等到点保存才报错。
#[tauri::command]
pub async fn hotkey_validate(combo: String) -> Result<String, String> {
    hotkey::parse(&combo).map(|c| c.label)
}
