//! 开机自启（写 HKCU 的 Run 键）。
//!
//! 用当前用户的 Run 键而不是计划任务或服务：
//! - 不需要管理员权限
//! - 用户能在「任务管理器 → 启动」里自己看到并关掉，不会被软件偷偷劫持
//!
//! 设计决策里开机自启**默认关闭**，设置页里给开关。

#![cfg(windows)]

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
};

/// Run 键路径。
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// 注册表值名。用中文名，用户在任务管理器里能一眼认出来是什么软件。
const VALUE_NAME: &str = "浮光";

/// 把字符串转成以 NUL 结尾的 UTF-16。
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 当前 exe 的完整路径。
///
/// ⚠️ 开发模式下这个路径指向 `src-tauri\target\debug\fuguang.exe`，
/// 所以开着开发模式去勾选自启，开机启动的会是那个调试版。
/// 正式版安装后路径才是安装目录里的 exe。这一点在设置页里有提示文案。
pub fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("取当前程序路径失败：{e}"))
}

/// 打开（必要时创建）Run 键。
fn open_run_key(create: bool) -> Result<HKEY, String> {
    let sub = wide(RUN_KEY);
    let mut hkey: HKEY = std::ptr::null_mut();
    let access = KEY_SET_VALUE | KEY_QUERY_VALUE;

    let status = unsafe {
        if create {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                0,
                std::ptr::null(),
                0, // REG_OPTION_NON_VOLATILE
                access,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            )
        } else {
            RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, access, &mut hkey)
        }
    };

    if status != ERROR_SUCCESS {
        return Err(format!("打开注册表 Run 键失败（错误码 {status}）"));
    }
    Ok(hkey)
}

/// 设置开机自启。
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let hkey = open_run_key(true)?;
    let name = wide(VALUE_NAME);

    let status = unsafe {
        if enabled {
            let exe = current_exe_path()?;
            // Run 键的值需要带引号，否则路径含空格时 Windows 会解析错
            let value = wide(&format!("\"{exe}\""));
            RegSetValueExW(
                hkey,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr() as *const u8,
                (value.len() * std::mem::size_of::<u16>()) as u32,
            )
        } else {
            RegDeleteValueW(hkey, name.as_ptr())
        }
    };

    unsafe { RegCloseKey(hkey) };

    // 关闭时如果本来就没有这个值，删除会返回"找不到文件"，这不算错误
    const ERROR_FILE_NOT_FOUND: u32 = 2;
    if status != ERROR_SUCCESS && !(status == ERROR_FILE_NOT_FOUND && !enabled) {
        return Err(format!("写入注册表失败（错误码 {status}）"));
    }
    Ok(())
}

/// 查询当前是否已开启自启。
///
/// 注意这是"注册表里有没有这个值"，不代表用户没在任务管理器里禁用它。
/// 对设置页的开关来说这个语义足够。
pub fn is_enabled() -> bool {
    let Ok(hkey) = open_run_key(false) else {
        return false;
    };
    let name = wide(VALUE_NAME);
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    unsafe { RegCloseKey(hkey) };
    status == ERROR_SUCCESS
}
