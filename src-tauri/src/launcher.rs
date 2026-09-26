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

/// `SW_SHOWNORMAL`。用字面量而不是常量名，省得再引一个模块。
/// 类型是 `SHOW_WINDOW_CMD`，在 windows-sys 0.61 里是 `i32`。
const SW_SHOWNORMAL: i32 = 1;

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

/// 在资源管理器中定位并选中某个文件。
///
/// 比"打开所在文件夹"更精确：文件多的时候能直接跳到那一个。
pub fn reveal_in_explorer(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".into());
    }
    let op = wide("open");
    let file = wide("explorer.exe");
    // explorer 的 /select 参数需要逗号分隔，且路径带空格时必须整体加引号
    let params = wide(&format!("/select,\"{path}\""));

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result as isize) <= 32 {
        return Err(format!("定位「{path}」失败"));
    }
    Ok(())
}
