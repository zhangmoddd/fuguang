//! 浮光 · 轻量 Windows 桌面悬浮工具箱
//!
//! 模块划分（刻意保持扁平，方便以后按同样套路加新功能）：
//!
//! 系统底层
//! - [`platform`]  剪贴板、模拟粘贴、前台窗口记录
//! - [`launcher`]  启动外部程序、打开文件夹与网址
//! - [`linkicon`]  从 exe/文件提取图标
//! - [`media`]     图片媒体：落盘、读取、剪贴板互转
//! - [`autostart`] 开机自启（注册表）
//! - [`hotkey`]    全局热键唤出面板
//!
//! 数据与调度
//! - [`models`]     数据模型（时间语义见该文件顶部）
//! - [`storage`]    数据目录与 JSON 原子读写
//! - [`state`]      内存状态与持久化
//! - [`backup`]     全量数据的导出与导入（含图片）
//! - [`scheduler`]  后台调度线程：到点弹提醒
//!
//! 界面
//! - [`windows`]    小球 / 主面板（可多个）/ 提醒弹窗的创建与定位
//! - [`tray`]       系统托盘兜底入口
//! - [`ballmenu`]   悬浮球的右键原生菜单
//! - [`commands`]   暴露给前端的命令

mod autostart;
mod backup;
mod ballmenu;
mod commands;
mod diag;
mod hotkey;
mod launcher;
mod linkicon;
mod media;
mod models;
mod platform;
mod scheduler;
mod state;
mod storage;
mod tray;
mod windows;

use std::thread;
use std::time::Duration;

use tauri::Manager;

/// 应用入口。由 `main.rs` 调用。
pub fn run() {
    // 正式版**没有任何地方能看到 panic**：`main.rs` 是 `windows_subsystem = "windows"`
    // （没有控制台、没有 stderr），release 档又开着 `panic = "abort"` ——
    // 于是任何一处 panic（**任何线程**）都是静默秒退：窗口凭空消失，
    // 用户只会说"软件自己退出了"，而事后一点线索都查不到。
    //
    // 这个钩子把 panic 的文件、行号、内容写进 `app.log`。`panic = "abort"` 下
    // 钩子照样会执行，只是执行完就 abort —— 有它和没它的区别就是
    // "能定位"和"永远只能猜"。
    std::panic::set_hook(Box::new(|info| {
        let at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "位置未知".to_string());
        // panic 载荷有两种：字面量是 `&str`，`format!` / `expect` 出来的是 `String`
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "（读不出内容）".to_string());
        crate::diag!("[浮光] panic @ {at}：{what}");
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // 窗口与进程
            commands::show_ball_menu,
            commands::toggle_panel,
            commands::show_panel,
            commands::hide_panel,
            commands::new_panel,
            commands::list_panels,
            commands::close_panel,
            commands::hide_ball,
            commands::show_ball,
            commands::quit_app,
            commands::set_always_on_top,
            commands::save_ball_pos,
            // 剪贴板
            commands::paste_text,
            commands::copy_text,
            // 读剪贴板文本：右键菜单的「粘贴」用它（浏览器 API 在浮光里没有权限）
            commands::read_clipboard_text,
            // 图片媒体
            commands::media_import_path,
            commands::media_import_clipboard,
            commands::media_set_meta,
            commands::media_read,
            commands::media_delete,
            commands::media_export,
            commands::media_copy_image,
            commands::media_paste_to_target,
            commands::media_stats,
            // 通用数据文件
            commands::read_data,
            commands::write_data,
            commands::data_dir_path,
            commands::open_data_dir,
            // 计时器
            commands::timers_list,
            commands::timer_save,
            commands::timer_remove,
            commands::timer_advance_alarm,
            // 备忘录
            commands::memos_list,
            commands::memo_save,
            commands::memo_remove,
            // 快捷链接
            commands::links_list,
            commands::link_save,
            commands::link_remove,
            commands::link_launch,
            commands::link_icon,
            commands::classify_paths,
            // 文件夹（链接 / 文本片段 / 计时器共用）
            commands::folders_list,
            commands::folder_save,
            commands::folder_remove,
            // 备份
            commands::export_all,
            commands::import_all,
            // 设置
            commands::settings_get,
            commands::settings_save,
            commands::settings_patch,
            commands::snooze_alert,
            commands::autostart_get,
            commands::autostart_set,
            commands::current_exe,
            commands::hotkey_current,
            commands::hotkey_apply,
            commands::hotkey_validate,
            commands::alert_current,
            commands::snippet_bump_use,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 先把数据加载进内存。必须在创建窗口之前完成：
            // 前端一挂载就会调 timers_list / memos_list，那时状态必须已经就绪。
            app.manage(state::Store::load(&handle));

            // 清理「指向一个已经不存在的 exe」的自启项。
            // 不清理的话：设置页显示"未开启"（路径对不上），但注册表里那条记录
            // 还在，开机照样去启动一个不存在的文件 —— 用户看到开关是关的，
            // 根本不会去点它，这条坏记录就永久留存了。
            autostart::clean_stale_entry();

            // 创建悬浮球：这是软件的常驻入口，必须在 setup 阶段就出现。
            //
            // ⚠️ **它要排在最前面（在热键之前）**：热键的 `start` 与 `apply`
            // 内部各有一个 3 秒超时，热键线程一旦异常就是 6 秒白等 ——
            // 而悬浮球是用户唯一能看到"软件起来了"的东西，不该被这个拖住。
            // （曾经为了"让热键早点可用"把它挪到前面，那是基于一次误诊：
            //  当时测到的 21.6 秒其实是自启项指向离线共享卡在 `clean_stale_entry`，
            //  不是 WebView2 冷启动。）
            windows::create_ball(&handle)?;

            // 创建托盘兜底入口
            tray::create(&handle)?;

            // 注册小球右键菜单的事件处理器
            ballmenu::register_handler(&handle);

            // 启动调度线程：倒计时、番茄钟、备忘录提醒都靠它
            scheduler::start(handle.clone());

            // 启动全局热键线程，并按保存的设置注册组合键。
            // 顺序不能反：`apply` 需要先拿到热键线程的 id 才能唤醒它。
            hotkey::start(handle.clone());
            {
                let store = handle.state::<state::Store>();
                let (enabled, combo) = {
                    let st = store.lock();
                    (st.settings.hotkey_enabled, st.settings.hotkey.clone())
                };
                if enabled {
                    // 只试一次。**不要重试** —— 实测：热键被占时重试几次全都会失败
                    // （占用者不会因为等一两秒就让开）；而占用者一旦消失，
                    // **第 1 次立刻就能成功**（探针实测 0ms）。所以重试救不回它
                    // 声称要救的场景，只是白等。
                    //
                    // 失败就如实记日志，并且**设置页会显示真实状态**
                    // （`hotkey_current` 返回的是实际注册成功的组合），
                    // 用户能在那里换一个没冲突的。
                    if let Err(err) = hotkey::apply(Some(&combo)) {
                        crate::diag!("[浮光] 全局热键「{combo}」注册失败：{err}");
                    }
                }
            }
            // 万一这次没注册上（组合键被别的程序占着），后台定期补注册 ——
            // 否则整个会话都没有热键，只能等用户自己去设置页重新应用一次。
            hotkey::start_watchdog(handle.clone());

            // 启动前台窗口跟踪线程。
            // 目的：记住「用户上一次真正在用的窗口」，这样点击文本片段时
            // 才能把焦点还回去，让 Ctrl+V 落到正确的地方。
            start_foreground_tracker();

            // 启动完成留一行。作用不是"记录成功"，而是给 `app.log` 一个**起点**：
            // 日志最后一行是"启动完成"、后面什么都没有，说明进程是被崩溃或强杀
            // 带走的；走正常退出的话，那三处出口都会各写一行（见下面）。
            crate::diag!("[浮光] 启动完成 v{}", env!("CARGO_PKG_VERSION"));

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();

            // 关闭主面板时只隐藏不销毁，下次打开更快，也保住面板内的搜索状态。
            // 但提醒弹窗要真正销毁，否则下次弹出会残留旧内容。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // ⚠️ 判据是**面板前缀**而不是 `label == PANEL`。
                //
                // 只拦 `panel` 的话，用户对 `panel-2` 按 Alt+F4（或任务视图里的关闭）
                // 会真的销毁它 —— 后果有两层：那个窗口里前端的全部状态（当前文件夹、
                // 搜索框内容、未落盘的编辑）一起丢；更糟的是窗口卸载时前端会把
                // **内存里那份陈旧数据** flush 落盘，把别的窗口刚写的新数据整份盖回去。
                // 隐藏则两者都不会发生。
                if windows::is_panel_label(label) {
                    api.prevent_close();
                    let _ = window.hide();
                } else if label == windows::BALL {
                    // ⚠️ 小球也必须挡住。
                    //
                    // Tauri 的默认行为是「所有窗口都关掉就退出进程」，而小球是
                    // **唯一一个在启动时就存在的窗口**：主面板要用户点开才创建。
                    // 于是启动后对小球来一次 WM_CLOSE（Alt+F4、任务视图里的关闭等）
                    // 就能把整个软件带走，表现正是"我没主动关，它自己退出了"。
                    //
                    // `closable(false)` 只保证"没有关闭按钮" —— 它挡的是那个按钮，
                    // 不是 WM_CLOSE 这条消息本身（到底拦不拦没实测过），
                    // 不能拿它当兜底。这里显式挡一道，代价是零。
                    //
                    // 只挡不藏：小球是常驻入口，藏起来用户就只能去托盘找了。
                    api.prevent_close();
                }
                return;
            }

            // 面板被拖动之后记住它的位置（多面板时尤其重要：不错开就全叠在一起）。
            //
            // 放在 Rust 侧而不是让前端调 `save_panel_pos`：拖动是系统行为，
            // 前端拿不到"用户什么时候松手"。小球的位置仍然由前端防抖保存
            // （`commands::save_ball_pos`），两条路径互不重叠。
            if let tauri::WindowEvent::Moved(position) = event {
                if windows::is_panel_label(label) {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    windows::remember_panel_move(
                        window.app_handle(),
                        label,
                        position.x as f64 / scale,
                        position.y as f64 / scale,
                    );
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("浮光启动失败");
}

/// 后台线程：每 400ms 记录一次当前前台窗口。
///
/// 为什么用轮询而不是 SetWinEventHook：
/// 轮询实现简单、无回调生命周期问题，400ms 的精度对「记住上次用的窗口」完全够用。
/// 事件钩子虽然更精确，但引入的复杂度和崩溃面不值得。
fn start_foreground_tracker() {
    thread::spawn(|| {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        loop {
            unsafe {
                let hwnd = GetForegroundWindow();
                if !hwnd.is_null() {
                    let title = platform::window_title(hwnd);
                    platform::remember_foreground(hwnd, title.as_deref());
                }
            }
            thread::sleep(Duration::from_millis(400));
        }
    });
}
