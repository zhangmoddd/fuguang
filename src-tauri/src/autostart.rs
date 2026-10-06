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

/// 开发模式（debug 构建）下拒绝开启自启时给出的说明。///
/// 这段话会原样出现在设置页的错误提示里，所以要同时讲清「为什么」和「怎么办」。
///
/// 为什么必须拒绝：debug 构建**不内嵌前端**，它的窗口地址是 `tauri.conf.json`
/// 里的 `devUrl`（`http://127.0.0.1:4173`），也就是 Vite 开发服务器。
/// 开机自启发生在登录那一刻，那时开发服务器根本不在，WebView2 拿不到页面，
/// 于是小球和面板里显示的都是浏览器的「无法访问此页面」——
/// 这正是用户实测踩到的那个坑，光靠设置页写一行小字提示挡不住。
const DEV_BUILD_REFUSAL: &str = "开发模式（调试版）不能设为开机自启：\
调试版没有把界面打包进 exe，运行时要去连本机的开发服务器 127.0.0.1:4173；\
开机时那个服务器不在，小球和面板里只会显示浏览器的「无法访问此页面」。\
请改用正式版 exe（先跑一次 2-重新编译.bat，产物在 src-tauri\\target\\release\\fuguang.exe）再开启自启。";

/// 「任务管理器 → 启动」的批准记录键。
///
/// Windows 在那里禁用一条自启项时**不删 Run 值**，而是往这个键下写一个
/// 12 字节的 blob：首字节最低位为 1 表示禁用（最常见的是 `0x03`），
/// `0x02` 表示启用。
const STARTUP_APPROVED_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/// 那个 blob 是不是表示"已禁用"。
///
/// 抽成纯函数以便单测：真正的判定逻辑（最低位）只有一行，但它是"开关会不会
/// 撒谎"的全部依据，值得钉住。
fn blob_says_disabled(bytes: &[u8]) -> bool {
    // 空 blob 当成"没有标记"，保守处理（宁可显示已开启，也不要凭空说被禁了）
    matches!(bytes.first(), Some(b) if b & 0x01 != 0)
}

/// 这条自启项是不是被「任务管理器 → 启动」禁用了。
///
/// # 为什么必须看它
///
/// 只看 Run 值的话，用户在那里禁用之后设置页仍然显示"已开启"，而开机**不会**
/// 启动 —— 开关在撒谎。更糟的是点"关"再点"开"也修不好：我们只写 Run 值，
/// 那个 blob 还留着，系统照样跳过。
///
/// 读不到（键/值不存在、形状不认识）一律当作"没被禁用"。
fn disabled_by_task_manager() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_QUERY_VALUE, REG_BINARY,
    };

    let sub = wide(STARTUP_APPROVED_KEY);
    let mut hkey: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey)
    };
    if opened != ERROR_SUCCESS {
        return false;
    }

    let name = wide(VALUE_NAME);
    let mut kind = 0u32;
    let mut buf = [0u8; 32];
    let mut len = buf.len() as u32;
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buf.as_mut_ptr(),
            &mut len,
        )
    };
    unsafe { RegCloseKey(hkey) };

    if status != ERROR_SUCCESS || kind != REG_BINARY {
        return false;
    }
    blob_says_disabled(&buf[..(len as usize).min(buf.len())])
}

/// 清掉「任务管理器 → 启动」留下的禁用标记。
///
/// 用户在设置页里明确要开启时调它 —— 不清的话我们写了 Run 值、系统还是按
/// 那个 blob 跳过，用户看到的是"开关是开的、开机却不启动"。
fn clear_task_manager_flag() {
    use windows_sys::Win32::System::Registry::{RegDeleteValueW, RegOpenKeyExW, KEY_SET_VALUE};

    let sub = wide(STARTUP_APPROVED_KEY);
    let mut hkey: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_SET_VALUE, &mut hkey)
    };
    if opened != ERROR_SUCCESS {
        return; // 键不存在就说明没有禁用标记
    }
    let name = wide(VALUE_NAME);
    unsafe { RegDeleteValueW(hkey, name.as_ptr()) };
    unsafe { RegCloseKey(hkey) };
}

/// 设置开机自启。
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    // 关闭永远允许：用户可能正被一个写坏了的启动项困住，必须能自救。
    if enabled && cfg!(debug_assertions) {
        return Err(DEV_BUILD_REFUSAL.into());
    }

    // 先把**可能失败**的准备工作做完，再打开注册表键。
    //
    // 不能把 `current_exe_path()?` 放进下面那个分支里：它一旦失败会直接返回，
    // 跳过 `RegCloseKey`，泄漏一个 HKEY。凡是"已经拿到资源、后面还有可能 `?` 返回"
    // 的写法都有这个毛病；把会失败的活提到取资源之前，是最省事的根治。
    let value = if enabled {
        // Run 键的值需要带引号，否则路径含空格时 Windows 会解析错
        Some(wide(&format!("\"{}\"", current_exe_path()?)))
    } else {
        None
    };

    let hkey = open_run_key(true)?;
    let name = wide(VALUE_NAME);

    let status = unsafe {
        match &value {
            Some(value) => RegSetValueExW(
                hkey,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr() as *const u8,
                (value.len() * std::mem::size_of::<u16>()) as u32,
            ),
            None => RegDeleteValueW(hkey, name.as_ptr()),
        }
    };

    unsafe { RegCloseKey(hkey) };

    // 关闭时如果本来就没有这个值，删除会返回"找不到文件"，这不算错误
    const ERROR_FILE_NOT_FOUND: u32 = 2;
    if status != ERROR_SUCCESS && (status != ERROR_FILE_NOT_FOUND || enabled) {
        return Err(format!("写入注册表失败（错误码 {status}）"));
    }

    // 开启时还要清掉「任务管理器 → 启动」留下的禁用标记。
    //
    // 不清的话：Run 值写回去了，可系统仍然按那个 blob 跳过 ——
    // 用户看到"开关是开的、开机却不启动"，而且怎么点都修不好。
    if enabled {
        clear_task_manager_flag();
    }
    Ok(())
}

/// 读取 Run 键里记录的启动命令行，去掉外层引号。
///
/// 值不存在、类型不对、或读失败都返回 `None`——对调用方来说这三者等价：
/// 都表示"没有一条可用的自启记录"。
fn read_registered_path(hkey: HKEY) -> Option<String> {
    let name = wide(VALUE_NAME);
    // Run 键的值最长也就几百字符，1024 个 UTF-16 码元足够；
    // 真被塞了更长的东西会返回 ERROR_MORE_DATA，这里按"没有记录"处理。
    let mut buf = [0u16; 1024];
    let mut len = (buf.len() * std::mem::size_of::<u16>()) as u32;

    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut u8,
            &mut len,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    // len 是**字节**数，含结尾的 NUL，所以要除以 2 再裁掉那个 NUL
    let units = (len as usize) / std::mem::size_of::<u16>();
    let text = String::from_utf16_lossy(&buf[..units.min(buf.len())]);
    let text = text.trim_end_matches('\0').trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

/// 从 Run 键的值里取出**可执行文件路径**。取不出来时返回 `None`。
///
/// # 为什么不能直接拿整个值去判断
///
/// Run 的值是**命令行**，不是路径。Windows 开机时按 `CreateProcess` 的规则解析它，
/// 所以 `"C:\x\浮光\fuguang.exe" --minimized` 是**完全合法、能正常工作**的一条自启项。
/// 而把整串丢给 `Path::exists()` 必然为假 —— 那就会把这条好记录当成"失效"删掉。
///
/// # 未加引号时整串就是路径
///
/// 曾经因为"未加引号且含空格 → 判不准 → 返回 None"，结果 `is_enabled` 对
/// `C:\sp ace\fuguang.exe` 这种**实测能启动**的写法谎报"未开启"，
/// 用户看到开关是关的、开机却照样启动。
///
/// 所以这里返回整串。**"含空格所以有歧义"这件事交给 [`is_ambiguous`]** ——
/// 它的用途不同：`is_enabled` 该尽力认（认出来对用户更好），
/// `should_clean` 该保守（判不准就别删注册表）。
fn exe_path_of(command: &str) -> Option<&str> {
    let s = command.trim();
    if s.is_empty() {
        return None;
    }

    if let Some(rest) = s.strip_prefix('"') {
        // 带引号：取引号内。引号没闭合、或引号内是空的 → 判不准
        return rest.split('"').next().filter(|p| !p.is_empty());
    }

    Some(s)
}

/// 这个 Run 值是不是"未加引号**且**含空格"。
///
/// 这种写法**有歧义**：Windows 会从 `c:\program.exe` 开始逐个尝试更长的前缀，
/// 所以 `C:\Program Files\浮光\fuguang.exe` 这样写既可能启动到浮光，
/// 也可能启动到 `C:\Program.exe`。能不能启动、启动的是谁都不确定 ——
/// 那就**不许据此删注册表**。
fn is_ambiguous(command: &str) -> bool {
    let s = command.trim();
    !s.starts_with('"') && s.contains(char::is_whitespace)
}

/// 判断注册表里记的路径是不是就是当前这个 exe。
///
/// 大小写不敏感、正反斜杠等价、忽略结尾的分隔符：
/// Windows 路径这几种写法都指向同一个文件，逐字节比较会把它们当成两个程序。
fn same_exe(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        // `\\?\C:\...`（`canonicalize` 会加上这个前缀）和 `C:\...` 是同一个文件
        let s = s.strip_prefix(r"\\?\").unwrap_or(s);
        // Windows **忽略路径尾部的空格和点**：`C:\x\f.exe ` 与 `C:\x\f.exe` 等价。
        // 实测这两种写法 `CreateProcess` 都能启动，不裁就会让 `is_enabled` 谎报"未开启"。
        //
        // ⚠️ **只裁一次，不要循环，也不要把尾部的反斜杠一起裁掉。**
        // 曾经改成"循环裁掉空格/点/反斜杠"，理由是"`f.exe \` 与 `f.exe` 是同一个文件"。
        // **那个前提是错的**：实测 `CreateProcess` 对 `"…\cmd.exe\"` 返回
        // ERROR_FILE_NOT_FOUND(2) —— 这种写法**根本启动不了**。循环裁剪会让
        // `is_enabled` 把一条启动不了的记录认成"就是我们自己"，从而谎报"已开启"，
        // 而 `should_clean` 也不再清理它。
        let s = s.trim_end_matches([' ', '.']);
        s.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    !a.is_empty() && !b.is_empty() && norm(a) == norm(b)
}

/// 查询当前是否已开启自启。
///
/// **只认指向当前这个 exe 的记录**，而不是"值存不存在"。
///
/// 为什么：开发模式曾经把自己写进过 Run 键（指向 `target\debug\fuguang.exe`）。
/// 如果只看值在不在，用户从正式版里打开设置页会看到开关是"已开启"，
/// 但开机启动的其实是那个调试版——界面上什么都没错，实际启动的却是另一个程序。
/// 这正是用户实测踩到的坑：以为自启的是正式版，开机出来的却是一个报错页。
///
/// 另外，用户可能在「任务管理器 → 启动」里手动禁用了这条记录 ——
/// 那种情况 Run 值仍在，但系统会**跳过**它。所以还要看那份批准记录
/// （见 [`disabled_by_task_manager`]）：只看 Run 值的话，开关会显示"已开启"
/// 而开机不启动，用户怎么点都修不好。
pub fn is_enabled() -> bool {
    let Ok(hkey) = open_run_key(false) else {
        return false;
    };
    let registered = read_registered_path(hkey);
    unsafe { RegCloseKey(hkey) };

    let Some(registered) = registered else {
        return false;
    };

    // 被任务管理器禁用 = 开机不会启动 = 语义上"没开启"
    if disabled_by_task_manager() {
        return false;
    }

    match current_exe_path() {
        // 比的是**可执行文件路径**，不是整条命令行 ——
        // `"…\fuguang.exe" --minimized` 也是在启动我们这个 exe，不能算"未开启"。
        // 取不出路径时返回 false（保守：宁可不认，也不要误报"已开启"）
        Ok(me) => exe_path_of(&registered).is_some_and(|exe| same_exe(exe, &me)),
        Err(_) => false,
    }
}

/// 该不该把 Run 键里那条记录当成"失效"清掉。
///
/// 抽成纯函数是为了能直接单测 —— 这段判定决定了"删不删用户的注册表"，
/// 收得够不够紧必须能被验证，而不是靠读一遍代码觉得没问题。
///
/// # 三道闸门，缺一不可
///
/// 1. 值名是我们自己的（固定为 `浮光`，只有本程序会写它）；
/// 2. 它指向的**不是**当前这个 exe（比的是命令行里的可执行文件路径）；
/// 3. 它指向的那个文件**确实不存在**，而且那看起来是个绝对路径。
///
/// 第 3 条那个"绝对路径"的附加条件是为了不误删第三方写的值：
/// `%LOCALAPPDATA%\…` 这类待展开的写法我们没展开，`Path::exists()` 会判不存在，
/// 但它其实能正常工作。只有形如 `X:\…` 或 `\\…` 的绝对路径才允许被判"失效"。
///
/// @param registered 注册表里记的**命令行**
/// @param current_exe 当前进程的 exe 路径；拿不到时传 `None`（保守：不删）
fn should_clean(registered: &str, current_exe: Option<&str>) -> bool {
    // 未加引号且含空格 → 有歧义（见 is_ambiguous），不许据此删注册表
    if is_ambiguous(registered) {
        return false;
    }

    // 取不出可执行文件路径（空值、引号没闭合）→ 判不准，不碰
    let Some(exe) = exe_path_of(registered) else {
        return false;
    };

    // 指向我们自己 → 这是一条**好的**记录，当然不动
    let is_us = current_exe.map(|me| same_exe(exe, me)).unwrap_or(false);
    if is_us {
        return false;
    }

    // 不是绝对路径（相对路径、光秃文件名、垃圾串）→ 不碰
    if !looks_absolute(exe) {
        return false;
    }

    // 路径里还有**没展开的环境变量** → 判不准，不碰。
    //
    // 只挡开头的 `%LOCALAPPDATA%\...` 是不够的：变量出现在中段时
    // （`C:\Users\%USERNAME%\...`）`Path::exists()` 同样判假，而这条记录
    // 若是 REG_EXPAND_SZ，Explorer 会展开它、其实能正常启动。
    if exe.contains('%') {
        return false;
    }

    // ⚠️ **顺序很重要：先确认它在不在本机固定磁盘上，再问文件存不存在。**
    //
    // `Path::exists()` 对**不可达的 UNC 路径**会去连 SMB，实测阻塞 **21 秒**
    // （`\\198.51.100.7\share\…`，本机复现 21044 ms）。而 `clean_stale_entry`
    // 是在 `setup()` 里**同步**调用的，一次阻塞就让悬浮球和托盘晚出现 20 多秒
    // （端到端实测 127.8 秒）。
    //
    // `is_on_local_fixed_drive` 对 UNC 和未映射盘符直接返回 false、**不碰文件系统**，
    // 所以把它放前面既能短路掉网络路径，又完整保住"别删别人的自启"这个目的。
    //
    // 这正是原来那道"网络共享离线…删了就没了"的守卫 —— 它写对了，但排在
    // `exists()` **后面**，于是**在真正需要它的那条路径上永远执行不到**。
    if !is_on_local_fixed_drive(exe) {
        return false;
    }

    // 目标文件还在 → 可能是另一个目录下的正式版，别碰别人的自启
    !std::path::Path::new(exe).exists()
}

/// `DRIVE_FIXED`：本机固定磁盘，`GetDriveTypeW` 的返回值之一。
///
/// 自己定义而不是从 `windows_sys` 引：它住在
/// `Win32::System::WindowsProgramming` 里，为**一个常量**多开一个 feature 不划算。
/// 值取自 Win32 头文件（`winbase.h`），是稳定的 ABI 常量。
const DRIVE_FIXED: u32 = 3;

/// 这条路径是不是位于一个**本机固定磁盘**上（`C:\` 这种）。
///
/// 只有在这种地方，"文件不存在"才真正说明自启项失效。
fn is_on_local_fixed_drive(path: &str) -> bool {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    // UNC（`\\server\share`）一律不算：共享可能只是暂时离线
    if path.starts_with("\\\\") {
        return false;
    }
    let b = path.as_bytes();
    if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
        return false;
    }
    let root = [b[0] as u16, b':' as u16, b'\\' as u16, 0];
    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
}

/// 看起来是不是一条**绝对路径**（`X:\…` 或 `\\server\…`）。
///
/// 只用来给"删不删"加一道保守闸门：判不准就当它不是绝对路径，于是不删。
fn looks_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    // 盘符形式：`C:\`
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    // UNC 形式：`\\server\share`
    let unc = path.starts_with("\\\\");
    drive || unc
}

/// 清理「指向一个已经不存在的 exe」的自启项。启动时调一次。
///
/// # 为什么必须清理，而不是只把界面改对
///
/// 旧版调试版**没有**拒绝开启自启，所以它能把 `…\target\debug\fuguang.exe`
/// 写进 Run 键；那份 exe 后来被删掉了。此时 `is_enabled()` 会（正确地）显示
/// "未开启" —— 但**注册表里那条记录还在**，开机照样去启动一个不存在的文件。
/// 用户看到开关是关的，根本不会去点它，于是这条坏记录永久留存，
/// "开机出现一个报错的悬浮球"这个坑也就一直没被填掉。
///
/// 删除条件由 [`should_clean`] 决定，只有"不是我们自己、且目标文件确实不存在"
/// 才删 —— 那种记录只会让开机多一次失败，删掉不会破坏任何能正常工作的配置。
pub fn clean_stale_entry() {
    let Ok(hkey) = open_run_key(false) else {
        return;
    };
    let registered = read_registered_path(hkey);

    let Some(registered) = registered else {
        unsafe { RegCloseKey(hkey) };
        return;
    };

    let me = current_exe_path().ok();
    if !should_clean(&registered, me.as_deref()) {
        unsafe { RegCloseKey(hkey) };
        return;
    }

    let name = wide(VALUE_NAME);
    let status = unsafe { RegDeleteValueW(hkey, name.as_ptr()) };
    unsafe { RegCloseKey(hkey) };

    if status == ERROR_SUCCESS {
        crate::diag!("[浮光] 已清理失效的开机自启项（目标已不存在）：{registered}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 路径比较忽略大小写与斜杠方向() {
        // 同一份 exe 在注册表里可能是任意一种写法，逐字节比较会误判成"没开启"
        assert!(same_exe(
            r"D:\software\浮光\fuguang.exe",
            r"d:/SOFTWARE/浮光/FUGUANG.EXE"
        ));
        assert!(same_exe(
            r"D:\software\浮光\fuguang.exe",
            r"D:\software\浮光\fuguang.exe\"
        ));
    }

    #[test]
    fn 指向别的程序时不算已开启() {
        // 这一条是本次修复的核心：注册表里躺着**另一个** exe 的路径时，
        // 设置页必须显示"未开启"，否则用户会以为自启的就是当前这个正式版
        assert!(!same_exe(
            r"D:\Project\codex\浮光\src-tauri\target\debug\fuguang.exe",
            r"D:\software\浮光\fuguang.exe"
        ));
        assert!(!same_exe("", r"D:\software\浮光\fuguang.exe"));
        assert!(!same_exe(r"D:\software\浮光\fuguang.exe", ""));
    }

    #[test]
    fn 调试版不允许开启自启() {
        // debug 构建下开启自启必须被拒绝，否则开机出来的是"无法访问此页面"。
        // release 构建下这条断言不成立，所以只在 debug 下检查。
        if cfg!(debug_assertions) {
            let err = set_enabled(true).expect_err("调试版不该允许开启自启");
            assert!(err.contains("开发模式"), "错误信息要能看懂：{err}");
        }
    }

    #[test]
    fn 失效自启项的判定收得很紧() {
        // 这段判定决定"删不删用户的注册表"，三个分支都必须钉住 ——
        // 删错一次就是把用户能用的自启搞没了。
        let me = r"D:\software\浮光\fuguang.exe";
        let existing = std::env::temp_dir().to_string_lossy().to_string();
        let missing = std::env::temp_dir()
            .join("fuguang-绝对不存在的文件-9f3a.exe")
            .to_string_lossy()
            .to_string();

        // 指向我们自己 → 这是一条**好的**记录，绝不能删
        assert!(!should_clean(me, Some(me)), "不能删自己的自启项");

        // 指向别的 exe、但那个文件还在 → 可能是另一份安装，别碰别人的自启
        assert!(!should_clean(&existing, Some(me)), "目标还在就不能删");

        // 指向一个已经不存在的文件 → 这才是要清的坏记录
        assert!(should_clean(&missing, Some(me)), "目标不存在就该清掉");

        // 拿不到当前 exe 路径时保守处理：只要目标还在就不动
        assert!(!should_clean(&existing, None));
    }

    #[test]
    fn 带参数的自启项只要目标还在就不能删() {
        // Run 的值是**命令行**，带参数完全合法。用当前测试进程自己的 exe
        // 当一个"确实存在"的目标。
        let existing_exe = std::env::current_exe()
            .expect("有 exe 路径")
            .to_string_lossy()
            .to_string();
        let with_args = format!("\"{existing_exe}\" --minimized");

        // 老实现把整串当路径 → `Path::exists()` 判假 → 删掉一条**能正常工作**的自启项
        assert!(
            !should_clean(&with_args, None),
            "带参数的值不能因为整串不是路径就被当成失效"
        );

        // 对照组：真的指向不存在的绝对路径时，才该清
        assert!(should_clean(r"D:\绝对不存在的目录-9f3a\fuguang.exe", None));
    }

    #[test]
    fn 非绝对路径的自启值一律不碰() {        // 环境变量写法我们没展开，`Path::exists()` 会判假 ——
        // 但它其实能正常工作，不能因此删掉
        assert!(!should_clean(r"%LOCALAPPDATA%\浮光\fuguang.exe", None));
        // 相对路径、光秃秃的文件名、垃圾串，一律不碰
        assert!(!should_clean(r"fuguang.exe", None));
        assert!(!should_clean(r".\fuguang.exe", None));
        assert!(!should_clean("", None));
    }

    #[test]
    fn 从命令行里取可执行文件路径() {
        // 带引号：取引号内（路径本身含空格时必须这么写）
        assert_eq!(
            exe_path_of(r#""C:\soft\浮光\fuguang.exe" --minimized"#),
            Some(r"C:\soft\浮光\fuguang.exe")
        );
        assert_eq!(
            exe_path_of(r#"  "C:\a b\f.exe"  /silent  "#),
            Some(r"C:\a b\f.exe")
        );
        // 不带引号：整串就是路径。**含空格也一样** —— 实测这种写法 CreateProcess
        // 能启动，返回 None 会让 is_enabled 谎报"未开启"（开关是关的、开机却照样启动）。
        assert_eq!(
            exe_path_of(r"C:\soft\fuguang.exe"),
            Some(r"C:\soft\fuguang.exe")
        );
        assert_eq!(
            exe_path_of(r"C:\Program Files\浮光\fuguang.exe"),
            Some(r"C:\Program Files\浮光\fuguang.exe")
        );
        // 坏值一律判不准
        assert_eq!(exe_path_of(""), None);
        assert_eq!(exe_path_of("\""), None);
    }

    #[test]
    fn 未加引号含空格的写法有歧义_不能据此删注册表() {
        // Windows 会从 `c:\program.exe` 开始逐个尝试更长的前缀，所以这种写法
        // 能不能启动、启动的到底是哪一个都不确定 —— 判不准就别删注册表。
        assert!(is_ambiguous(r"C:\Program Files\浮光\fuguang.exe"));
        assert!(!should_clean(r"C:\Program Files\浮光\fuguang.exe", None));
        // 带引号的同一路径不歧义；不含空格的也不歧义
        assert!(!is_ambiguous(r#""C:\Program Files\浮光\fuguang.exe""#));
        assert!(!is_ambiguous(r"C:\soft\fuguang.exe"));
    }

    #[test]
    fn 路径比较要认得出同一个文件的几种写法() {
        let me = r"D:\software\浮光\fuguang.exe";
        // 尾部空格 / 尾部点：Windows 忽略（实测这两种 CreateProcess 都能启动，
        // 不裁就会让 is_enabled 谎报"未开启"）
        assert!(same_exe(r"D:\software\浮光\fuguang.exe ", me));
        assert!(same_exe(r"D:\software\浮光\fuguang.exe.", me));
        // `\\?\` 前缀（canonicalize 会加上它）
        assert!(same_exe(r"\\?\D:\software\浮光\fuguang.exe", me));
        // 正斜杠 / 大小写
        assert!(same_exe(r"d:/SOFTWARE/浮光/FUGUANG.EXE", me));
        // 不同的文件不能算相同
        assert!(!same_exe(r"D:\software\浮光\fuguang2.exe", me));
    }

    #[test]
    fn 只有本机固定磁盘上的路径才允许被判失效() {
        // 系统盘一定是固定磁盘
        assert!(is_on_local_fixed_drive(r"C:\Windows\notepad.exe"));

        // UNC 一律不算：共享可能只是暂时离线，那条记录其实能用
        assert!(!is_on_local_fixed_drive(
            r"\\offline-server\share\浮光\fuguang.exe"
        ));
        assert!(!should_clean(
            r"\\offline-server\share\浮光\fuguang.exe",
            None
        ));

        // 找一个当前不存在的盘符，确认"没映射的盘"不会被当成固定磁盘
        let free = ('D'..='Z').find(|c| !std::path::Path::new(&format!("{c}:\\")).exists());
        if let Some(c) = free {
            let p = format!("{c}:\\浮光\\fuguang.exe");
            assert!(!is_on_local_fixed_drive(&p), "未映射的盘符不该算固定磁盘：{p}");
            assert!(!should_clean(&p, None), "未映射盘符上的记录不能删：{p}");
        }

        // 含未展开环境变量的路径一律不碰（变量在中段时同样要挡住）
        assert!(!should_clean(
            r"C:\Users\%USERNAME%\AppData\Local\浮光\fuguang.exe",
            None
        ));
        assert!(!should_clean(r"%LOCALAPPDATA%\浮光\fuguang.exe", None));
    }

    /// 「目标不存在就该清掉」那条断言要求目标**在本机固定磁盘**上
    /// （`should_clean` 最后一道是 `is_on_local_fixed_drive`）。
    /// `std::env::temp_dir()` 在有些机器上落在 U 盘/网络盘/RAM 盘，那样断言会
    /// 无端失败 —— 所以这里显式用系统盘上的一个确定不存在的路径。
    #[test]
    fn 系统盘上不存在的目标会被判失效() {
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let gone = format!(r"{system_drive}\浮光-绝对不存在的目录-9f3a\fuguang.exe");
        assert!(
            !std::path::Path::new(&gone).exists(),
            "这个路径不该存在，测试前提被破坏了：{gone}"
        );
        assert!(should_clean(&gone, None), "系统盘上不存在的目标应判失效：{gone}");
    }

    /// **碰文件系统之前**就必须短路掉不可达的网络路径。
    ///
    /// 这条测试是给一个真实事故上的锁：`should_clean` 原来先调
    /// `Path::new(exe).exists()`，再判"在不在本机固定磁盘上"。
    /// 而 `exists()` 对不可达的 UNC 会去连 SMB —— 本机实测**阻塞 21044 ms**。
    /// `clean_stale_entry()` 又是在 `setup()` 里同步调用的，于是自启项指向
    /// 一个离线共享时，悬浮球和托盘要等 20 多秒才出现（端到端实测 127.8 秒）。
    ///
    /// 把 `is_on_local_fixed_drive` 提到前面之后，UNC 会在**不碰文件系统**的情况下
    /// 直接返回 false。这条断言用时间兜住"顺序被改回去"这种回归。
    #[test]
    fn 不可达的网络路径必须立刻短路_不能去连_smb() {
        // ⚠️ **每次换一个主机地址**，别用固定地址。
        //
        // 内核会缓存失败的 SMB 连接（按**主机**，实测约 6 分钟过期）。用固定地址的话：
        // 第一次跑确实能抓到"顺序被改回去"（实测 21.03s FAILED），
        // **第二次跑就秒回、测试变绿** —— 明明代码里那个 bug 还在。
        // 那正是这个项目反复踩的"假通过"，只是换了个形式。
        //
        // 用 TEST-NET-2（198.51.100.0/24，RFC 5737 保留给文档、实际不可路由），
        // 每次随机取一个，绕开负缓存。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let unc = format!(
            r"\\198.51.100.{}\share\浮光\fuguang.exe",
            1 + (nanos % 254)
        );

        let started = std::time::Instant::now();
        assert!(!should_clean(&unc, None), "网络路径不能判成失效：{unc}");
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "对不可达 UNC 应该立刻返回（不碰文件系统），实际耗时 {elapsed:?} —— \
             说明 `Path::exists()` 又排到 `is_on_local_fixed_drive` 前面去了"
        );
    }

    /// 「任务管理器 → 启动」的批准记录怎么解读。
    ///
    /// 这一行是"开关会不会撒谎"的全部依据：用户在那里禁用之后 Run 值仍在，
    /// 不看这份记录的话设置页会显示"已开启"而开机不启动。
    #[test]
    fn 任务管理器的批准记录怎么读() {
        // 真实 blob 的第一个字节（本机实测）：0x02 启用、0x03 禁用
        assert!(!blob_says_disabled(&[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(blob_says_disabled(&[0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        // 只看最低位：0x07 也是禁用（bit0 = 1）
        assert!(blob_says_disabled(&[0x07]));
        assert!(!blob_says_disabled(&[0x06]));
        // 读不到内容时保守当作"没有标记"，不要凭空说用户的自启被禁了
        assert!(!blob_says_disabled(&[]));
    }
}
