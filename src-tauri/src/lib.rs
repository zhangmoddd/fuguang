//! 浮光 · 轻量 Windows 桌面悬浮工具箱
//!
//! 模块划分（刻意保持扁平，方便以后按同样套路加新功能）：
//!
//! 系统底层
//! - [`platform`]  剪贴板、模拟粘贴、前台窗口记录
//! - [`launcher`]  启动外部程序、打开文件夹与网址
//! - [`linkicon`]  从 exe/文件提取图标
//! - [`autostart`] 开机自启（注册表）
//! - [`hotkey`]    全局热键唤出面板
//!
//! 数据与调度
//! - [`models`]     数据模型（时间语义见该文件顶部）
//! - [`storage`]    数据目录与 JSON 原子读写
//! - [`state`]      内存状态与持久化
//! - [`backup`]     全量数据的导出与导入
//! - [`scheduler`]  后台调度线程：到点弹提醒
//!
//! 界面
//! - [`windows`]    小球 / 主面板 / 提醒弹窗的创建与定位
//! - [`tray`]       系统托盘兜底入口
//! - [`ballmenu`]   悬浮球的右键原生菜单
//! - [`commands`]   暴露给前端的命令

mod autostart;
mod backup;
mod ballmenu;
mod commands;
mod hotkey;
mod launcher;
mod linkicon;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // 窗口与进程
            commands::show_ball_menu,
            commands::toggle_panel,
            commands::show_panel,
            commands::hide_panel,
            commands::hide_ball,
            commands::show_ball,
            commands::quit_app,
            commands::set_always_on_top,
            commands::save_ball_pos,
            // 剪贴板
            commands::paste_text,
            commands::copy_text,
            // 通用数据文件
            commands::read_data,
            commands::write_data,
            commands::data_dir_path,
            commands::open_data_dir,
            // 计时器
            commands::timers_list,
            commands::timer_save,
            commands::timer_remove,
            // 备忘录
            commands::memos_list,
            commands::memo_save,
            commands::memo_remove,
            // 快捷链接
            commands::links_list,
            commands::link_save,
            commands::link_remove,
            commands::link_launch,
            commands::open_target,
            commands::reveal_path,
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
            commands::autostart_get,
            commands::autostart_set,
            commands::current_exe,
            commands::hotkey_current,
            commands::hotkey_apply,
            commands::hotkey_validate,
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

            // 创建悬浮球：这是软件的常驻入口，必须在 setup 阶段就出现
            windows::create_ball(&handle)?;

            // 创建托盘兜底入口
            tray::create(&handle)?;

            // 注册小球右键菜单的事件处理器
            ballmenu::register_handler(&handle);

            // 启动调度线程：倒计时、番茄钟、备忘录提醒都靠它
            scheduler::start(handle.clone());

            // 启动全局热键线程，并按保存的设置注册组合键。
            // 顺序不能反：apply 需要先拿到热键线程的 id 才能唤醒它。
            hotkey::start(handle.clone());
            {
                let store = handle.state::<state::Store>();
                let (enabled, combo) = {
                    let st = store.lock();
                    (st.settings.hotkey_enabled, st.settings.hotkey.clone())
                };
                if enabled {
                    if let Err(err) = hotkey::apply(Some(&combo)) {
                        // 不阻断启动：热键只是"快捷方式"，
                        // 小球和托盘仍然可用，用户能在设置页里改一个没冲突的组合。
                        eprintln!("[浮光] 全局热键「{combo}」注册失败：{err}");
                    }
                }
            }

            // 启动前台窗口跟踪线程。
            // 目的：记住「用户上一次真正在用的窗口」，这样点击文本片段时
            // 才能把焦点还回去，让 Ctrl+V 落到正确的地方。
            start_foreground_tracker();

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主面板时只隐藏不销毁，下次打开更快，也保住面板内的搜索状态。
            // 但提醒弹窗要真正销毁，否则下次弹出会残留旧内容。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == windows::PANEL {
                    api.prevent_close();
                    let _ = window.hide();
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
