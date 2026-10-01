//! 启动外部程序 / 打开文件夹与网址。
//!
//! 用 `ShellExecuteW` 而不是自己 `CreateProcess`：
//! - 它走系统默认关联，所以文件夹、文档、网址能用同一套代码处理
//! - 会复用已在运行的实例（例如已打开的文件夹窗口不会重复开一个）
//!
//! 设计决策里明确过：快捷链接是**纯启动器**，点了就在外部打开，
//! 绝不把外部程序窗口嵌进浮光（那是臃肿和一堆兼容问题的来源）。

#![cfg(windows)]

use windows_sys::Win32::UI::Shell::ShellExecuteW;

use crate::models::LinkKind;

/// `SW_SHOWNORMAL`。用字面量而不是常量名，省得再引一个模块。
/// 类型是 `SHOW_WINDOW_CMD`，在 windows-sys 0.61 里是 `i32`。
const SW_SHOWNORMAL: i32 = 1;

/// 认作「程序」的扩展名。与前端「添加程序」文件选择框里的过滤器保持一致。
const PROGRAM_EXTENSIONS: [&str; 4] = ["exe", "lnk", "bat", "cmd"];

/// 判断一个路径是程序、文件夹还是普通文件。
///
/// # 为什么必须放在 Rust 侧
///
/// Tauri 的拖放事件**只给路径字符串**，前端拿不到"这是不是目录"。
/// 原来的做法是按扩展名猜，于是拖进来的文件夹一律被当成「文件」
/// （README 的已知限制里记着这条），图标也就不对。
/// 这里读一次文件系统属性就能判准，代价是一次很便宜的 `stat`。
pub fn classify(path: &str) -> LinkKind {
    let p = std::path::Path::new(path);

    // 先判目录：目录名里也可能带点（例如叫 `node.js` 的文件夹），
    // 反过来按扩展名先判就会把它当成文件
    if p.is_dir() {
        return LinkKind::Folder;
    }

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if PROGRAM_EXTENSIONS.contains(&ext.as_str()) {
        LinkKind::Program
    } else {
        LinkKind::File
    }
}

/// 把字符串转成以 NUL 结尾的 UTF-16。
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 打开一个目标。
///
/// `target` 可以是程序路径、文件夹、文档，或 `http(s)://` 网址。
/// `args` 仅在目标是程序时有意义。
pub fn open(target: &str, args: Option<&str>) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("目标为空".into());
    }

    let op = wide("open");
    let file = wide(target);
    let params = args.filter(|a| !a.trim().is_empty()).map(wide);

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            params.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW 的返回值 <= 32 表示失败（这是它独有的约定，不是 GetLastError）
    let code = result as isize;
    if code <= 32 {
        return Err(describe_error(code, target));
    }
    Ok(())
}

/// 把 ShellExecuteW 的错误码翻译成人能看懂的话。
///
/// 直接抛错误码给用户没有意义，常见原因就这么几种。
fn describe_error(code: isize, target: &str) -> String {
    let reason = match code {
        2 => "找不到文件，可能已被移动或删除",
        3 => "找不到路径",
        5 => "拒绝访问，可能没有权限",
        8 => "内存不足",
        26 => "文件被占用，无法打开",
        27 => "文件关联损坏",
        28 => "DDE 超时",
        29 => "DDE 失败",
        30 => "DDE 忙",
        31 => "没有关联的程序可以打开这种文件",
        32 => "无法加载所需的动态库",
        _ => "系统调用失败",
    };
    format!("打开「{target}」失败：{reason}")
}
