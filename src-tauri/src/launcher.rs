//! 启动外部程序 / 打开文件夹与网址，以及「这个目标现在还在不在」的核对。
//!
//! 用 `ShellExecuteExW` 而不是自己 `CreateProcess`：
//! - 它走系统默认关联，所以文件夹、文档、网址能用同一套代码处理
//! - 会复用已在运行的实例（例如已打开的文件夹窗口不会重复开一个）
//!
//! 设计决策里明确过：快捷链接是**纯启动器**，点了就在外部打开，
//! 绝不把外部程序窗口嵌进浮光（那是臃肿和一堆兼容问题的来源）。
//!
//! # 为什么这里还有一套「核对」（`probe`）
//!
//! 链接把「目标在哪」存成一个一次性写死的字符串，而**目标在磁盘上会变**：
//! 用户把桌面上的 `.bat` 收进 `桌面\临时\`、卸掉一个软件、拔掉一个 U 盘，
//! 链接就指向一个不存在的位置了。原来应用对此**一无所知** ——
//! 唯一的反馈是点下去之后弹一句「找不到文件」，而且这句话还经常不准
//! （`.lnk` 明明在，是它指向的程序没了）。
//!
//! 所以这里补上两件事：
//!
//! 1. [`probe`]：**纯本地、零网络**地核对目标现在还在不在，让界面能提前打标记；
//! 2. [`find_same_name`]：文件只是被挪到附近时直接找出来，省掉手工翻文件夹。
//!
//! # 为什么 `probe` 必须"零网络"
//!
//! 链接目标是完全自由的字符串（可以从别人给的备份里导进来），而核对是
//! **面板一挂载就自动跑、不需要任何点击**的。对 `\\attacker\share\x.exe`
//! 做一次 `metadata` 就等于把当前用户的 NetNTLM 响应发出去，可以离线破解
//! 或做中继 —— 这条零点击通道必须在碰文件系统之前就掐掉，
//! 和 `linkicon` 里拦 `SHGetFileInfoW` 是同一个理由（见 [`touches_network`]）。

#![cfg(windows)]

use std::collections::VecDeque;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_ACP};
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};

use crate::models::LinkKind;

/// `SW_SHOWNORMAL`。用字面量而不是常量名，省得再引一个模块。
const SW_SHOWNORMAL: i32 = 1;

/// `SEE_MASK_FLAG_NO_UI`：出错时**不要弹系统自己的错误框**。
///
/// # 为什么这一位是必须的（实测，不是推断）
///
/// `fMask = 0` 时 Shell 会自己弹一个模态框（「Windows 找不到文件
/// 'C:\…\x.bat'。请确定文件名是否正确后，再试一次。」）。
/// 这有三个后果，每一个都足以否掉 `fMask = 0`：
///
/// 1. **错误码被吃掉。** 用户把那个框关掉之后，`GetLastError()` 返回的是
///    `ERROR_CANCELLED (1223)` —— 而 1223 是"提权被取消"的意思。
///    于是"文件不存在"会被报成「已取消（需要管理员权限的操作被拒绝了）」，
///    比改动前那句「找不到文件」更误导。实测：对不存在的文件调
///    `ShellExecuteExW(fMask = 0)` 得到 `(返回 0, GetLastError 1223)`，
///    两次不同输入都是 1223（先 `SetLastError(0x5A5A)` 排除了读到陈旧值）。
/// 2. **框是模态的**，会一直挡住调用线程，直到用户看见并点掉它。
///    启动是在阻塞线程池上跑的，界面不会冻住，但那一格会一直显示"正在打开"。
/// 3. **它出现在用户没预期的地方。** 用户点的是一个"启动器"，
///    弹出来的却是系统错误框 —— 而这个应用自己就能把原因说清楚。
///
/// # 代价（明确记下来）
///
/// 双击一个**没有关联程序**的文件时，Windows 原本会弹「你要如何打开这个文件？」，
/// 现在不会了。换成一句我们自己的提示（错误码 31 / 1155 → 「没有默认程序可以打开
/// 这种文件，可以先在系统设置里指定」）。对启动器来说这个交换是划算的：
/// 保住真实的错误码，比保住一个可以从资源管理器里触发的对话框重要。
///
/// 注意它**不影响** `runas` 的 UAC 提权框 —— 那不是"错误框"，
/// 由 AppInfo 服务负责，`SEE_MASK_FLAG_NO_UI` 管不到它。
const SEE_MASK_FLAG_NO_UI: u32 = 0x400;

/// `GetDriveTypeW` 的返回值之一。常量在本版 windows-sys 里位于
/// `Win32::System::WindowsProgramming`，为它引一整个绑定模块不划算。
const DRIVE_REMOTE: u32 = 4;

/// 认作「程序」的扩展名。与前端「添加程序」文件选择框里的过滤器保持一致。
const PROGRAM_EXTENSIONS: [&str; 4] = ["exe", "lnk", "bat", "cmd"];

// ===============================================================
// 网络路径拦截
// ===============================================================

/// 判断这个路径会不会让 Shell / 文件系统去访问网络。
///
/// # 为什么必须拦
///
/// `SHGetFileInfoW` 不带 `SHGFI_USEFILEATTRIBUTES` 时会**真实解析**路径。
/// 对 `\\attacker\share\x.exe` 这种 UNC 路径，Windows 会去连 SMB 并做 NTLM 认证 ——
/// 于是「打开链接页」这个动作就变成了「把当前用户的 NetNTLM 响应发给攻击者指定的主机」，
/// 可以离线破解或做中继。
///
/// 链接目标是完全自由的字符串（可以从别人给的备份里导进来），
/// 而链接页**渲染即自动提取图标、不需要任何点击**，所以这一步是零点击可达的，
/// 必须在调用 Shell 之前拦住。
///
/// 顺带的好处：不可达主机不再让 `SHGetFileInfoW` 阻塞到 SMB 超时（几十秒）拖住界面。
///
/// 现在有**两个**调用方（图标提取、目标核对），两边理由完全一样，
/// 所以放在这里共用 —— 谁也不能"以后再说"地漏掉这一步。
///
/// # 为什么不做「映射网络驱动器」的检查
///
/// 那需要 `GetDriveTypeW` + `DRIVE_REMOTE`，而该常量在这个版本的 windows-sys 里位于
/// `Win32::System::WindowsProgramming` —— 为一个判断引入整个绑定模块不划算。
/// 更要紧的是**它不是攻击者可控的**：盘符映射是用户自己的配置，
/// 攻击者无法凭空让 `Z:` 指向他的服务器。UNC 才是唯一的零点击通道。
///
/// 映射盘另有 [`is_remote_drive`] 单独处理（那是为了**别卡住**，不是为了安全）。
pub fn touches_network(path: &str) -> bool {
    let p = path.trim();

    // UNC：`\\server\share\...`、`\\?\UNC\server\share`，以及正斜杠写法
    if p.starts_with("\\\\") || p.starts_with("//") {
        return true;
    }

    // 带协议头的 URL（http://、ftp://…）：Shell 同样会去连网络。
    // 前端对 `kind === "url"` 已经跳过，但链接类型本身也能被备份文件改掉，
    // 所以这里必须自己再挡一次，不能依赖前端的判断。
    // Windows 文件名里不可能出现 `:`（除盘符），所以这个子串不会误伤本地路径。
    if p.contains("://") {
        return true;
    }

    false
}

/// 这个盘符现在**在不在**（拔掉的 U 盘、删掉的虚拟光驱都会是"不在"）。
///
/// # 为什么用 `GetLogicalDrives` 而不是 `Path::exists("E:\\")`
///
/// `exists` 会真的去问那个盘：拔掉的 U 盘要等超时，断开的网络映射盘要等
/// SMB 超时（几十秒）。而 `probe` 是**一次要核对几十条链接**的，
/// 一条卡住就是整批卡住。`GetLogicalDrives` 只读内核里那张盘符位图，
/// 不产生任何 I/O，也不产生任何网络流量。
///
/// 返回 `false` 只在**确定**这个盘符不存在时给；API 自己失败（返回 0）
/// 时保守地当"在"，交给后面的 `metadata` 去判 —— 宁可少报，不可错报。
fn drive_present(letter: u8) -> bool {
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return true;
    }
    (mask & (1u32 << (letter - b'A'))) != 0
}

/// 这个盘符是不是网络驱动器。
///
/// # 为什么要单独判
///
/// 映射盘（`Z:` 指向 `\\server\share`）在字符串上**长得像本地盘**，
/// 所以 `touches_network` 拦不住它。而 `metadata("Z:\\…")` 在共享断开时
/// 会一直等到 SMB 超时 —— 那正是"打开链接页卡半天"的来源。
///
/// `GetDriveTypeW` 读的是本机挂载表，不去连那台服务器。
///
/// `pub(crate)`：`linkicon` 也要用（见那里的调用点）—— 图标提取是零点击的，
/// 而它对一个断开的映射盘会等到 SMB 超时，还会**占着那把串行锁**让整面
/// 图标墙一起等。
pub(crate) fn is_remote_drive(letter: u8) -> bool {
    let root = [letter as u16, b':' as u16, b'\\' as u16, 0u16];
    let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
    kind == DRIVE_REMOTE
}

// ===============================================================
// 目标字符串的归一化
// ===============================================================

/// 把用户存下来的目标整成「真正要交给 Shell 的那个字符串」。
///
/// 做三件事，每一件都对应一种真实会遇到的输入：
///
/// 1. **去首尾空白**（含换行）。从网页、聊天记录里复制路径经常带上这些东西，
///    而 `ShellExecuteExW` 不会帮你 trim —— 多一个换行就是"找不到文件"。
/// 2. **剥掉一层成对的引号**。复制 `"C:\Program Files\a.exe"` 是很常见的操作，
///    引号是给命令行用的，交给 Shell 就成了路径的一部分。
/// 3. **展开 `%USERPROFILE%` 这类环境变量**。`ShellExecuteExW` 不认 `%VAR%`，
///    会把它当字面路径去找。放在**启动/核对时**展开而不是保存时展开：
///    存成展开后的绝对路径，换台机器、改个用户名就全废了。
///
/// # 这个函数**不能**把一条本来能打开的路径改坏
///
/// 它跑在"打开"和"核对"两条路上，所以任何误改都会同时造成
/// "标成失效"和"点开真失败"—— 也就是这次要消灭的那个故障，只是换了个成因。
/// 因此每一处改动都配了一条"宁可不动"的退路，见下面两段注释。
pub fn normalize(raw: &str) -> String {
    let mut s = raw.trim();

    if s.len() >= 2 {
        let b = s.as_bytes();
        let (first, last) = (b[0], b[b.len() - 1]);
        // 首尾都是 ASCII 引号，所以切出来的边界一定落在字符边界上
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            let inner = &s[1..s.len() - 1];
            // 里面还有引号，说明首尾这两个**不是一对**（`"a.exe" 尾巴"`）。
            // 那就别动：剥掉的结果里仍然有非法字符，一样打不开，
            // 而"只剥成对的一层"这条规则也就名不副实了。
            if !inner.contains('"') && !inner.contains('\'') {
                s = inner.trim();
            }
        }
    }

    expand_env_carefully(s)
}

/// 展开环境变量，但**先确认原样的路径不存在**。
///
/// # 为什么需要这一步（这是实测出来的一个真实回归）
///
/// Windows 允许文件名里带 `%`。一个真叫 `%TEMP%` 的文件夹（从别处解压、
/// 同步过来的目录树里很常见）会被无条件展开成临时目录，于是
/// `…\临时目录\%TEMP%\a.txt` 变成 `…\临时目录\C:\Users\…\Temp\a.txt` ——
/// **一条本来能打开的路径被改成了打不开的**。
///
/// 所以顺序反过来：原样的字符串**已经存在**就一个字都不动，只有当它不存在时
/// 才当成"用户写的是变量"。`%USERPROFILE%\Desktop\x.bat` 这种写法原样查当然
/// 不存在，照样会展开，用法不受影响。
///
/// # 两个不能省的细节
///
/// - **只在串里有 `%` 时才做这次探测。** 否则每次 `normalize` 都要多一次
///   `stat`，而 `classify` 会在拖进来一批文件时被连调几百次。
/// - **网络路径绝不碰。** 这次探测跑在 `touches_network` 之前（`normalize`
///   是各条路径的第一步），对 UNC 做 `exists()` 就是零点击的 NTLM 外发 ——
///   正是 `touches_network` 要拦的那件事。所以这里自己先挡一次。
fn expand_env_carefully(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    if !touches_network(s) && Path::new(s).exists() {
        return s.to_string();
    }
    expand_env(s)
}

/// 展开 `%NAME%`。
///
/// 只认「像变量名」的内容（字母数字下划线、以及 `ProgramFiles(x86)` 里的括号）：
/// `C:\50% off\a%b.txt` 这种路径里也有 `%`，不设限制就会把 `a` 当变量名去找，
/// 找不到倒是没事，但 `% off\a%` 中间那段要是碰巧撞上某个变量名就会被误展开。
fn expand_env(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string();
    }

    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '%' {
            if let Some(close) = chars[i + 1..].iter().position(|c| *c == '%') {
                let name: String = chars[i + 1..i + 1 + close].iter().collect();
                let looks_like_name = !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '(' || c == ')');

                if looks_like_name {
                    if let Some(value) = std::env::var(&name).ok().filter(|v| !v.is_empty()) {
                        out.push_str(&value);
                        i += close + 2;
                        continue;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    out
}

/// 目标开头的协议名（`https://…` → `https`、`mailto:…` → `mailto`）。
///
/// 判据是「冒号前是纯字母开头、且不含点号与反斜杠」：
/// - `C:\a\b` 里冒号前只有一个字母 —— 那是盘符，不是协议；
/// - `example.com:8080` 冒号前有点号 —— 那是主机名加端口；
/// - `\\server\share\a:b` 冒号前有反斜杠 —— 那是路径。
///
/// # 为什么允许的字符里**故意没有点号**
///
/// RFC 3986 其实允许协议名里有点（`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`），
/// 但 `example.com:8080` 这种输入在真实使用里比带点的协议名常见得多，
/// 认错了就会把一个网址当成路径去核对、去打开。
/// 更要紧的是**前端 `normalizeUrl` 用的是同一条判据** ——
/// 两边不一致的话，同一个字符串在"补协议"和"核对"两步会被判成两种东西。
fn scheme_of(target: &str) -> Option<&str> {
    let colon = target.find(':')?;
    let head = &target[..colon];

    // 盘符：单个 ASCII 字母
    if head.len() == 1 && head.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    if head.is_empty() {
        return None;
    }

    let mut chars = head.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-') {
        return None;
    }

    Some(head)
}

/// 目标所在的盘符（`D:\a\b` → `D`）。不是「盘符 + 冒号」形态就返回 `None`。
pub(crate) fn drive_letter(target: &str) -> Option<u8> {
    let b = target.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        Some(b[0].to_ascii_uppercase())
    } else {
        None
    }
}

// ===============================================================
// 类型判定
// ===============================================================

/// 判断一个路径是程序、文件夹还是普通文件。
///
/// # 为什么必须放在 Rust 侧
///
/// Tauri 的拖放事件**只给路径字符串**，前端拿不到"这是不是目录"。
/// 原来的做法是按扩展名猜，于是拖进来的文件夹一律被当成「文件」
/// （README 的已知限制里记着这条），图标也就不对。
/// 这里读一次文件系统属性就能判准，代价是一次很便宜的 `stat`。
pub fn classify(path: &str) -> LinkKind {
    let cleaned = normalize(path);
    let p = Path::new(&cleaned);

    // 先判目录：目录名里也可能带点（例如叫 `node.js` 的文件夹），
    // 反过来按扩展名先判就会把它当成文件
    if p.is_dir() {
        return LinkKind::Folder;
    }

    if PROGRAM_EXTENSIONS.contains(&extension_of(p).as_str()) {
        LinkKind::Program
    } else {
        LinkKind::File
    }
}

/// 小写扩展名。没有扩展名就是空串。
fn extension_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ===============================================================
// 目标状态核对
// ===============================================================

/// 一个目标**现在**的状态。
///
/// 序列化给前端时用小驼峰，和别的 IPC 类型一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetState {
    /// 网址或自定义协议：不做文件系统核对。
    Url,
    /// 路径现在还在，点开就能用。
    Ok,
    /// 目标本身不在了（文件夹还在，只是里面没这个东西）。
    Missing,
    /// 目标所在的**文件夹**不在了。
    NoParent,
    /// 所在盘符现在不存在（U 盘拔了、虚拟光驱卸了）。
    NoDrive,
    /// 路径在，但没权限访问。
    Denied,
    /// `.lnk` 在，但它指向的目标不在。
    LnkBroken,
    /// 网络路径（UNC 或映射盘）：刻意不核对，见模块头的说明。
    Network,
    /// 目标是空的。
    Empty,
    /// 查不出来（既不是明确的"在"，也不是明确的"不在"）。
    Unknown,
}

/// [`probe`] 的结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    pub state: TargetState,
    /// 归一化之后真正会交给 Shell 的那个字符串。
    ///
    /// 前端拿它做两件事：显示"实际会打开的是什么"（和用户填的不一样时），
    /// 以及给「重新定位」的文件选择框当默认目录。
    pub resolved: String,
    /// `.lnk` 里解析出来的真实目标。只有 [`TargetState::LnkBroken`] 时有值。
    pub lnk_target: Option<String>,
}

impl TargetStatus {
    fn new(state: TargetState, resolved: String) -> Self {
        Self {
            state,
            resolved,
            lnk_target: None,
        }
    }
}

/// 核对一个目标现在还在不在。
///
/// 纯本地、零网络、零进程启动：只读盘符位图和文件属性。
/// 单个 `.lnk` 会额外读一次它自己那个小文件（几十字节到几 KB）。
///
/// # 为什么要带上 `kind`
///
/// 链接自己声明了"我是网址"时就**不该**去文件系统里找它 ——
/// `example.com:8080` 这种只写了主机名加端口的网址在磁盘上当然不存在，
/// 按路径核对会给它打上一个假的"失效"标记。声明过的类型优先于字符串猜测。
pub fn probe(target: &str, kind: LinkKind) -> TargetStatus {
    if kind == LinkKind::Url {
        return TargetStatus::new(TargetState::Url, normalize(target));
    }
    probe_at(target, 0)
}

/// 带层数上限的核对。
///
/// # 为什么必须有这个上限
///
/// `.lnk` 会顺着它指向的目标再核一次。而一个**指向自己**的 `.lnk`
/// （坏文件、或者手改出来的）会让这一步无限递归 —— 结果是栈溢出崩溃，
/// 不是一句错误提示。所以只跟一层：快捷方式指向快捷方式的情况极罕见，
/// 真遇到了报"目标不在"也足够准确。
fn probe_at(target: &str, depth: u8) -> TargetStatus {
    let resolved = normalize(target);

    if resolved.is_empty() {
        return TargetStatus::new(TargetState::Empty, resolved);
    }

    // 协议开头的东西（`https://…`、`mailto:…`、`ms-settings:…`）没有"在不在"这回事。
    // 这一步必须排在 `touches_network` 前面：`://` 两边都命中，
    // 但网址该报「网址」而不是「网络路径不核对」。
    if scheme_of(&resolved).is_some() {
        return TargetStatus::new(TargetState::Url, resolved);
    }

    if touches_network(&resolved) {
        return TargetStatus::new(TargetState::Network, resolved);
    }

    // 光秃秃一个文件名（`notepad.exe`、`run.bat`）一律报「没确认」。
    //
    // # 为什么不报 `Missing`（这是一条会**把好链接标红**的路）
    //
    // 交给 Shell 的裸文件名不是"相对磁盘上的某个位置"，而是**按 `PATH`
    // 环境变量和注册表里的 `App Paths` 键解析**的。我们没法照搬那套规则
    // （`App Paths` 在注册表里，而且每个安装器写进去的东西都不一样），
    // 所以 `metadata("notepad.exe")` 查不到**不代表打不开**。
    //
    // 报 `Missing` 的后果是双重的：格子上出现"已失效"标记，
    // 而且点击会被拦下来去开修复面板 —— 一条本来点一下就开的链接变成点不动。
    // 那正是 `link-health.ts` 开头那条规矩要防的事：**没确认不等于坏了**。
    if !resolved.contains('\\') && !resolved.contains('/') {
        return TargetStatus::new(TargetState::Unknown, resolved);
    }

    if let Some(letter) = drive_letter(&resolved) {
        if !drive_present(letter) {
            return TargetStatus::new(TargetState::NoDrive, resolved);
        }
        // 映射盘：共享断开时 `metadata` 会卡到 SMB 超时，所以不碰
        if is_remote_drive(letter) {
            return TargetStatus::new(TargetState::Network, resolved);
        }
    }

    match std::fs::metadata(&resolved) {
        Ok(_) => {
            // `.lnk` 本身在，不代表它指的东西还在 —— 而 Shell 报错时会说
            // 「找不到 C:\…\豆包.lnk」，把用户指向一个明明存在的文件。
            if depth == 0 && extension_of(Path::new(&resolved)) == "lnk" {
                if let Some(inner) = lnk_target(&resolved) {
                    let inner_status = probe_at(&inner, depth + 1);
                    if inner_status.state == TargetState::Missing
                        || inner_status.state == TargetState::NoParent
                        || inner_status.state == TargetState::NoDrive
                    {
                        return TargetStatus {
                            state: TargetState::LnkBroken,
                            resolved,
                            lnk_target: Some(inner),
                        };
                    }
                }
            }
            TargetStatus::new(TargetState::Ok, resolved)
        }
        Err(err) => {
            let state = match err.kind() {
                std::io::ErrorKind::NotFound => {
                    // 分开"文件没了"和"整个文件夹没了"：前者是自己被挪走，
                    // 后者是上级目录被删/改名，用户该做的事完全不同。
                    match Path::new(&resolved).parent() {
                        Some(parent) if !parent.as_os_str().is_empty() && !parent.exists() => {
                            TargetState::NoParent
                        }
                        _ => TargetState::Missing,
                    }
                }
                std::io::ErrorKind::PermissionDenied => TargetState::Denied,
                _ => TargetState::Unknown,
            };
            TargetStatus::new(state, resolved)
        }
    }
}

// ===============================================================
// `.lnk` 解析
// ===============================================================

/// `.lnk` 文件头长度（规范里的固定值）。
const LNK_HEADER_SIZE: usize = 76;
/// `LinkFlags` 的位：后面跟着 `LinkTargetIDList`。
const LNK_FLAG_HAS_TARGET_ID_LIST: u32 = 0x01;
/// `LinkFlags` 的位：后面跟着 `LinkInfo`。
const LNK_FLAG_HAS_LINK_INFO: u32 = 0x02;
/// `LinkInfo` 的位：里面有本地路径（`LocalBasePath`）。
const LINK_INFO_HAS_LOCAL_BASE_PATH: u32 = 0x01;
/// `LinkInfo` 表头到这个大小才带 Unicode 版本的路径偏移量。
const LINK_INFO_HEADER_WITH_UNICODE: usize = 0x24;

/// 从 `.lnk` 文件里读出它指向哪里。读不出来返回 `None`。
///
/// # 为什么自己解析二进制，而不是问 Shell
///
/// 正规做法是 `IShellLinkW`，但 `windows-sys` **不生成 COM 接口定义**
/// （那是 `windows` crate 的活），为这一个功能换成 `windows` crate、
/// 或者手写 vtable 都不划算 —— 后者一旦索引错一位就是崩溃。
/// 这里要的只是"它指向哪儿"这一个字段，按规范读偏移量就够。
///
/// # 覆盖范围（本机 51 个桌面快捷方式实测）
///
/// 48 个能读出 `LocalBasePath`，剩下 3 个是 Store 应用（没有 `LinkInfo`）。
/// 读不出来就返回 `None`，界面退回通用提示 —— **宁可不说，也不说错**：
/// 说错一个路径会让用户去"修"一个根本没坏的东西。
///
/// # 编码
///
/// `LocalBasePath` 是**系统 ANSI 代码页**（本机 936）的字节，不是 UTF-8。
/// 实测这 48 个 `.lnk` **一个都没写 Unicode 版本**，所以 ANSI 这条是主路径，
/// 必须过 `MultiByteToWideChar(CP_ACP)`；直接 `from_utf8_lossy`
/// 会把中文路径变成一串问号，然后被当成"目标不存在"。
fn lnk_target(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < LNK_HEADER_SIZE || read_u32(&bytes, 0)? != 0x4C {
        return None;
    }

    let flags = read_u32(&bytes, 20)?;
    let mut off = LNK_HEADER_SIZE;

    if flags & LNK_FLAG_HAS_TARGET_ID_LIST != 0 {
        // IDList 前面是一个 u16 长度（含结尾那两个字节的 0）
        let size = read_u16(&bytes, off)? as usize;
        off = off.checked_add(2)?.checked_add(size)?;
    }

    if flags & LNK_FLAG_HAS_LINK_INFO == 0 {
        return None;
    }

    let info = off;
    let info_size = read_u32(&bytes, info)? as usize;
    let header_size = read_u32(&bytes, info + 4)? as usize;
    let info_flags = read_u32(&bytes, info + 8)?;

    if info_flags & LINK_INFO_HAS_LOCAL_BASE_PATH == 0 || info_size == 0 {
        return None;
    }
    // 整块 LinkInfo 必须落在文件里，否则后面的偏移量全是猜的
    if info.checked_add(info_size)? > bytes.len() {
        return None;
    }

    let base_off = read_u32(&bytes, info + 16)?;
    let suffix_off = read_u32(&bytes, info + 24).unwrap_or(0);
    let wide_base_off = if header_size >= LINK_INFO_HEADER_WITH_UNICODE {
        read_u32(&bytes, info + 28).unwrap_or(0)
    } else {
        0
    };
    let wide_suffix_off = if header_size >= LINK_INFO_HEADER_WITH_UNICODE {
        read_u32(&bytes, info + 32).unwrap_or(0)
    } else {
        0
    };

    // 有 Unicode 版本就优先用它（不受系统代码页影响）
    let (base, suffix) = if wide_base_off != 0 {
        (
            read_utf16_at(&bytes, info, info_size, wide_base_off)?,
            read_utf16_at(&bytes, info, info_size, wide_suffix_off).unwrap_or_default(),
        )
    } else {
        (
            read_ansi_at(&bytes, info, info_size, base_off)?,
            read_ansi_at(&bytes, info, info_size, suffix_off).unwrap_or_default(),
        )
    };

    let full = format!("{base}{suffix}");
    // 过一次 `normalize`：MS-SHLLINK 允许 `LocalBasePath` 带引号
    // （有些安装器就是那么写的），而引号在这里是路径的一部分，
    // 拿去查文件系统会得到 `InvalidFilename`。顺带也把 `%VAR%` 展开掉。
    let cleaned = normalize(full.trim());
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// 读一个小端 `u16`，越界返回 `None`（越界就是"这个文件不合规范"，不是崩溃的理由）。
fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let end = at.checked_add(2)?;
    let slice = bytes.get(at..end)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

/// 读一个小端 `u32`，越界返回 `None`。
fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    let slice = bytes.get(at..end)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// 从 `base + offset` 起读一段以 NUL 结尾的单字节字符串（系统 ANSI）。
fn read_ansi_at(bytes: &[u8], base: usize, limit: usize, offset: u32) -> Option<String> {
    let offset = offset as usize;
    if offset == 0 || offset >= limit {
        return None;
    }
    let start = base.checked_add(offset)?;
    let end = base.checked_add(limit)?.min(bytes.len());
    let raw = bytes.get(start..end)?;
    let nul = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    if nul == 0 {
        return None;
    }
    Some(acp_to_string(&raw[..nul]))
}

/// 从 `base + offset` 起读一段以 NUL 结尾的 UTF-16 字符串。
fn read_utf16_at(bytes: &[u8], base: usize, limit: usize, offset: u32) -> Option<String> {
    let offset = offset as usize;
    if offset == 0 || offset >= limit {
        return None;
    }
    let start = base.checked_add(offset)?;
    let end = base.checked_add(limit)?.min(bytes.len());
    let raw = bytes.get(start..end)?;

    let mut units = Vec::new();
    let mut i = 0;
    while i + 1 < raw.len() {
        let unit = u16::from_le_bytes([raw[i], raw[i + 1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
        i += 2;
    }
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(&units))
}

/// 把系统 ANSI 代码页的字节解成字符串。
///
/// 系统代码页是**每台机器都可能不同**的（本机 936），所以不能写死编码表 ——
/// `MultiByteToWideChar(CP_ACP)` 是唯一能问对"这台机器用哪个代码页"的办法。
fn acp_to_string(raw: &[u8]) -> String {
    if raw.is_empty() {
        return String::new();
    }

    let len = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            raw.as_ptr(),
            raw.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if len <= 0 {
        return String::new();
    }

    let mut buf = vec![0u16; len as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            0,
            raw.as_ptr(),
            raw.len() as i32,
            buf.as_mut_ptr(),
            len,
        )
    };
    if written <= 0 {
        return String::new();
    }

    buf.truncate(written as usize);
    String::from_utf16_lossy(&buf)
}

// ===============================================================
// 启动
// ===============================================================

/// 把字符串转成以 NUL 结尾的 UTF-16。
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 启动时该把工作目录设成哪里。`None` 表示不设（让子进程继承浮光的）。
///
/// # 为什么必须设（这是 `.bat` 最容易踩的坑）
///
/// `lpDirectory` 传 `NULL` 时，子进程继承的是**浮光自己**的工作目录。
/// 于是 `.bat` / `.cmd` 里凡是相对路径（`copy a.txt b.txt`、`.\bin\tool.exe`、
/// `python main.py`）都会跑到浮光那边去找 —— 用户双击同一个脚本好好的，
/// 从浮光点开就报"系统找不到指定的文件"。资源管理器的做法是把工作目录
/// 设成目标所在的那个文件夹，这里跟它一致。
///
/// # 为什么 `.lnk` 和网址不给
///
/// `.lnk` 自己带"起始位置"，我们传一个进去会把它盖掉；
/// 网址根本没有"所在文件夹"。
fn working_dir_for(path: &str) -> Option<String> {
    if scheme_of(path).is_some() {
        return None;
    }

    let p = Path::new(path);
    if extension_of(p) == "lnk" {
        return None;
    }

    let parent = p.parent()?;
    if parent.as_os_str().is_empty() {
        return None;
    }
    Some(parent.to_string_lossy().into_owned())
}

/// 打开一个目标。
///
/// `target` 可以是程序路径、文件夹、文档，或 `http(s)://` 网址。
/// `args` 仅在目标是程序时有意义。
pub fn open(target: &str, args: Option<&str>) -> Result<(), String> {
    run(target, args, "open")
}

/// 以管理员身份打开（会弹 UAC 提权确认）。
///
/// `.bat` / `.cmd` 里如果要做需要管理员权限的事（改注册表、动 `C:\Users` 下的
/// 东西、`net user`），**双击是不会自动提权的** —— 脚本会自己失败。
/// 想提权只能由调用方用 `runas` 谓词发起，所以这个入口必须存在。
pub fn open_elevated(target: &str, args: Option<&str>) -> Result<(), String> {
    run(target, args, "runas")
}

/// 真正调 Shell 的那一层。
fn run(target: &str, args: Option<&str>, verb: &str) -> Result<(), String> {
    let path = normalize(target);
    if path.is_empty() {
        return Err("这条链接没有填目标".into());
    }

    // NUL 必须挡在**调 Shell 之前**。
    //
    // # 为什么（这是一条实测出来的"两个真相"）
    //
    // `wide()` 只是把字符串编码成 UTF-16 再加一个结尾 NUL，它不检查串里
    // 本来有没有 NUL。而 `ShellExecuteExW` 拿到的 `lpFile` 是一个 C 字符串，
    // 于是**在第一个 NUL 处截断**：目标写成 `C:\…\calc.exe\0 -c evil` 时，
    // 界面显示和 `probe` 核对的是那一整串（查不到 → 标成"已失效"），
    // 点下去启动的却是 `calc.exe`。
    //
    // 链接目标是**可以从别人给的备份 JSON 里导进来的自由字符串**
    // （JSON 的 `\u0000` 就能塞进来），所以这不是"用户不会这么写"的问题。
    // 拒绝比静默截断诚实：这里没有任何"猜用户想干嘛"的空间。
    if path.contains('\0') {
        return Err("这条链接的目标里有非法字符（NUL），无法打开".into());
    }
    if args.is_some_and(|a| a.contains('\0')) {
        return Err("这条链接的启动参数里有非法字符（NUL），无法打开".into());
    }

    let op = wide(verb);
    let file = wide(&path);
    let params = args.filter(|a| !a.trim().is_empty()).map(wide);
    let dir = working_dir_for(&path).map(|d| wide(&d));

    // 用 `SHELLEXECUTEINFOW` 的零值起步：它全是 C 的平坦数据（整数、指针、union），
    // 逐个字段手写容易漏（漏掉 `cbSize` 会直接失败），零值 + 覆盖是标准做法。
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    // 必须带 NO_UI：不带的话 Shell 会自己弹模态框，把真实错误码吃成 1223。
    // 完整理由见 `SEE_MASK_FLAG_NO_UI` 的说明。
    info.fMask = SEE_MASK_FLAG_NO_UI;
    info.lpVerb = op.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ref().map_or(std::ptr::null(), |p| p.as_ptr());
    info.lpDirectory = dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr());
    info.nShow = SW_SHOWNORMAL;

    // 用 `ShellExecuteExW` 而不是老的 `ShellExecuteW`：后者的返回值只有
    // `SE_ERR_*` 那一套（0~32 之外没有信息），而 Ex 版会把真正的 Win32
    // 错误码放进 `GetLastError` —— 提权被取消（1223）和没有权限（5）
    // 是两件完全不同的事，老 API 分不出来。
    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        let code = unsafe { GetLastError() } as isize;
        return Err(describe_error(code, &path, verb == "runas"));
    }

    Ok(())
}

/// 把错误码翻译成人能看懂的话。
///
/// 直接抛错误码给用户没有意义，常见原因就这么几种。
/// 表里混了两套编码：`ShellExecute` 自己的 `SE_ERR_*`（0~32）和
/// `GetLastError` 的 Win32 码（1223、1155）。
///
/// # `elevated` 为什么必须传进来
///
/// `1223 (ERROR_CANCELLED)` 有两种来源，而它们该说的话完全不同：
///
/// - **提权**那条路上，它是"用户在 UAC 弹窗上点了否"，不是故障；
/// - **普通打开**那条路上它根本不该出现。实测：`fMask` 不带 `NO_UI` 时
///   Shell 会自己弹一个模态错误框，用户一关掉，`GetLastError` 就变成 1223 ——
///   **真实的错误码被那个框吃掉了**。于是"文件被挪走了"会被报成
///   「已取消（需要管理员权限的操作被拒绝了）」，把用户指向完全错误的方向。
///
/// 所以普通打开拿到 1223 时**不能照表念**，而是自己去看目标在不在
/// （见 [`explain_unexpected`]）。`fMask` 已经带上了 `NO_UI`，
/// 但这条退路仍然留着：一个错误文案的来源不该依赖"某个标志位按文档生效了"。
fn describe_error(code: isize, target: &str, elevated: bool) -> String {
    let reason = match code {
        2 => "找不到这个文件或文件夹，可能已被移动或删除",
        3 => "找不到这个路径，可能上一级文件夹已经不在了",
        5 => "拒绝访问，可能没有权限",
        8 => "内存不足",
        26 => "文件被占用，无法打开",
        27 => "文件关联损坏",
        28 => "DDE 超时",
        29 => "DDE 失败",
        30 => "DDE 忙",
        31 => "没有关联的程序可以打开这种文件",
        32 => "无法加载所需的动态库",
        // 用户在 UAC 弹窗上点了「否」。这不是故障，别报成"拒绝访问"吓人。
        1223 if elevated => "已取消（管理员权限的请求被拒绝了）",
        1223 => return explain_unexpected(target),
        // Win10 起没有默认关联时会报这个，而不是老的 31
        1155 => "没有默认程序可以打开这种文件，可以先在系统设置里指定",
        _ => "系统调用失败",
    };
    format!("打开「{target}」失败：{reason}")
}

/// 拿到一个"不该出现在这条路"上的错误码时，自己去看目标到底怎么了。
///
/// 比起照着一张三方 API 的码表猜，直接核对文件系统得到的答案更可靠 ——
/// 而 `probe` 本来就有这套判断（分成文件没了 / 文件夹没了 / 盘没连 /
/// 没权限 / 快捷方式失效几种），复用它，别在这里再写一份。
fn explain_unexpected(target: &str) -> String {
    let reason = match probe(target, LinkKind::File).state {
        TargetState::Missing => "找不到这个文件或文件夹，可能已被移动或删除",
        TargetState::NoParent => "找不到这个路径，可能上一级文件夹已经不在了",
        TargetState::NoDrive => "它所在的盘现在没连上（U 盘没插 / 网络盘没挂）",
        TargetState::Denied => "拒绝访问，可能没有权限",
        TargetState::LnkBroken => "快捷方式指向的程序已经不在了",
        TargetState::Empty => "这条链接没有填目标",
        _ => "系统没能打开它（原因没有从系统取得）",
    };
    format!("打开「{target}」失败：{reason}")
}

// ===============================================================
// 同名文件查找
// ===============================================================

/// 往下找几层。
const SEARCH_MAX_DEPTH: usize = 3;
/// 最多看几个目录项。
const SEARCH_MAX_ENTRIES: usize = 4000;
/// 最多花多久。
const SEARCH_BUDGET: Duration = Duration::from_millis(1500);
/// 最多返回几个候选。
const SEARCH_MAX_HITS: usize = 8;

/// `FILE_ATTRIBUTE_REPARSE_POINT`：符号链接、junction（目录联接）、
/// OneDrive 的占位文件……这一族东西共同的定义位。
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
/// `FILE_ATTRIBUTE_HIDDEN`。
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
/// `FILE_ATTRIBUTE_SYSTEM`。
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

/// 一个「附近找到的同名文件」候选。
///
/// # 为什么必须带大小和时间，而不是只给一个路径
///
/// 候选的判据只有"文件名一样"，而**同名不等于同一个东西**：
/// 用户真正想要的那个和半年前的旧版本、和回收站里那份、和某个模板，
/// 文件名完全一样。只列路径的话，界面上**没有任何信息能帮用户分辨**，
/// 点错了链接就永久指向一个无关的文件 —— 而且它照样"打开成功"，
/// 用户不会发现。
///
/// 大小和修改时间是最便宜、也最有效的两条区分信息，而它们**本来就白拿**：
/// 为了判断重解析点已经读过一次 `metadata` 了。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SameNameCandidate {
    pub path: String,
    /// 文件字节数。目录是 0。
    pub bytes: u64,
    /// 最后修改时刻（Unix 毫秒）。取不到就是 `None`。
    pub modified_ms: Option<i64>,
}

/// 在目标原来所在的文件夹**下面几层**里找同名文件。
///
/// # 为什么需要它
///
/// "链接坏了"最费事的一步是**自己把文件找回来**。而用户挪文件的习惯很集中：
/// 把桌面上的脚本收进 `桌面\临时\`、把项目从 `D:\work\a` 挪到 `D:\work\archive\a`。
/// 这些全都落在"原来那个文件夹的子树里"，走一遍就能找到，
/// 用户不用再开一次资源管理器去翻。
///
/// # 为什么不直接复用 Shell 的"定位"对话框
///
/// 资源管理器双击一个坏快捷方式时会弹它自己的定位/浏览框，看着是现成的。
/// 但它**不可编程调用**（那是 Shell 对 `.lnk` 的内部处理），
/// 对"普通文件被挪走"根本不出现，而且它是个模态框、文案与外观都不受我们控制。
/// 所以自己实现一份，代价是要自己划边界 —— 也就是下面这些。
///
/// # 边界（不设边界就是在拿用户的磁盘做全盘搜索）
///
/// - 只从**原来那个文件夹**往下走，最深 [`SEARCH_MAX_DEPTH`] 层
/// - 最多看 [`SEARCH_MAX_ENTRIES`] 个目录项、最多 [`SEARCH_BUDGET`]，到点就带着已有结果返回
/// - 不跟 reparse point（junction / 符号链接）：既避免绕圈，也避免一步跨到别的盘
/// - 跳过隐藏 / 系统项：回收站（`$RECYCLE.BIN`）、`System Volume Information`
///   这类地方的同名文件只会是噪音，而它们**最容易被误点**
/// - 网络位置直接不搜：UNC 见 [`touches_network`]，**映射盘**见下面那次判断
/// - 只找**同一种类型**的（找文件就别把同名文件夹端出来）
///
/// # 为什么是"提议"而不是"自动改"
///
/// 同名不等于同一个东西。自动改目标有可能把链接指向一个完全无关的文件，
/// 而用户不会发现 —— 所以这里只把候选列出来（并且带上大小和时间帮用户分辨），
/// 改不改由用户点。
pub fn find_same_name(target: &str, want_dir: bool) -> Vec<SameNameCandidate> {
    let path = normalize(target);
    if path.is_empty() || touches_network(&path) {
        return Vec::new();
    }

    // 映射盘在字符串上长得像本地盘，`touches_network` 拦不住它，而
    // `root.is_dir()` 在共享断开时会一直等到 SMB 超时 —— 用户点一下
    // 「重新定位」就卡几十秒。`probe` 早就为同一个理由加了这道闸门，
    // 这条路径不能漏。
    if drive_letter(&path).is_some_and(is_remote_drive) {
        return Vec::new();
    }

    let Some(name) = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase())
    else {
        return Vec::new();
    };

    let Some(root) = Path::new(&path).parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }

    let started = Instant::now();
    let mut seen = 0usize;
    // 广度优先：越浅的先出来，候选列表的顺序就是"越可能对"的顺序
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut hits: Vec<SameNameCandidate> = Vec::new();

    while let Some((dir, depth)) = queue.pop_front() {
        if seen >= SEARCH_MAX_ENTRIES || started.elapsed() > SEARCH_BUDGET {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            seen += 1;
            if seen > SEARCH_MAX_ENTRIES || started.elapsed() > SEARCH_BUDGET {
                break;
            }

            // 一次 metadata 同时拿到属性、类型、大小、时间。
            // `entry.metadata()` 对符号链接**不跟随**（这是它和 `fs::metadata`
            // 的区别），所以拿到的是链接自己的属性。
            let Ok(meta) = entry.metadata() else {
                // 读不到属性就跳过：既不能判类型，也不该跟进去
                continue;
            };
            let attrs = meta.file_attributes();

            // 符号链接 / junction / OneDrive 占位符：不进去、也不当候选。
            // 用属性位而不是 `FileType::is_symlink()` —— 后者跟着 Rust 对
            // "什么算符号链接"的解释走，而这里必须挡住 junction（跟进去可能
            // 绕圈，也可能一步跨到别的盘甚至一台陌生主机上）。
            if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                continue;
            }
            // 隐藏 / 系统项（回收站等）：当候选只会误导，也不值得进去翻
            if attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0 {
                continue;
            }

            let is_dir = meta.is_dir();
            let matches = entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.to_ascii_lowercase() == name);

            if matches && is_dir == want_dir {
                hits.push(SameNameCandidate {
                    path: entry.path().to_string_lossy().into_owned(),
                    bytes: if is_dir { 0 } else { meta.len() },
                    modified_ms: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64),
                });
                if hits.len() >= SEARCH_MAX_HITS {
                    return hits;
                }
                continue;
            }

            if is_dir && depth < SEARCH_MAX_DEPTH {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }

    hits
}

// ===============================================================
// 测试
// ===============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试里绝大多数调用都是"按路径核对"，`kind` 用不上。
    fn probe_path(p: &str) -> TargetStatus {
        probe(p, LinkKind::File)
    }

    // ---- normalize ----

    #[test]
    fn normalize_trims_and_strips_paired_quotes() {
        assert_eq!(normalize("  C:\\a\\b.exe \r\n"), "C:\\a\\b.exe");
        assert_eq!(normalize("\"C:\\Program Files\\a.exe\""), "C:\\Program Files\\a.exe");
        assert_eq!(normalize("'C:\\a b\\c.txt'"), "C:\\a b\\c.txt");
        // 去掉引号之后两边的空白也要跟着去
        assert_eq!(normalize("\"  C:\\a.exe  \""), "C:\\a.exe");
    }

    #[test]
    fn normalize_expands_environment_variables() {
        // 用 PATH 而不是 USERPROFILE：这个变量在所有 Windows 上都必然存在且非空
        let path = std::env::var("PATH").expect("Windows 一定有 PATH");
        assert_eq!(normalize("%PATH%\\x.exe"), format!("{path}\\x.exe"));
        // 大小写不敏感（Windows 的规矩），小写写法很常见
        assert_eq!(normalize("%path%\\x.exe"), format!("{path}\\x.exe"));
    }

    #[test]
    fn normalize_leaves_unknown_variables_alone() {
        // 展开不了就原样留着：用户能在提示里看到自己写的是什么
        assert_eq!(normalize("%NO_SUCH_VAR_9F3%\\x"), "%NO_SUCH_VAR_9F3%\\x");
        // 落单的 % 不能吞掉后面的内容
        assert_eq!(normalize("C:\\50% off\\a.txt"), "C:\\50% off\\a.txt");
        // 空名字不算变量
        assert_eq!(normalize("a%%b"), "a%%b");
    }

    // ---- scheme_of / drive_letter ----

    #[test]
    fn scheme_recognises_urls_but_not_drives_or_ports() {
        assert_eq!(scheme_of("https://a.com"), Some("https"));
        assert_eq!(scheme_of("mailto:a@b.com"), Some("mailto"));
        assert_eq!(scheme_of("ms-settings:display"), Some("ms-settings"));
        assert_eq!(scheme_of("steam://run/1"), Some("steam"));

        // 盘符不是协议
        assert_eq!(scheme_of("C:\\a\\b"), None);
        assert_eq!(scheme_of("D:/a/b"), None);
        // 主机名加端口不是协议
        assert_eq!(scheme_of("example.com:8080"), None);
        // UNC 路径里的冒号不是协议
        assert_eq!(scheme_of("\\\\srv\\share\\a:b"), None);
        // 没有冒号
        assert_eq!(scheme_of("a.com/x"), None);
        assert_eq!(scheme_of(":leading"), None);
    }

    #[test]
    fn drive_letter_only_accepts_drive_form() {
        assert_eq!(drive_letter("C:\\a"), Some(b'C'));
        assert_eq!(drive_letter("d:/a"), Some(b'D'));
        assert_eq!(drive_letter("\\\\srv\\a"), None);
        assert_eq!(drive_letter("C"), None);
        assert_eq!(drive_letter("1:\\a"), None);
        // `ab:\x` 不是盘符
        assert_eq!(drive_letter("ab:\\x"), None);
    }

    // ---- touches_network ----

    #[test]
    fn network_paths_are_detected() {
        assert!(touches_network("\\\\srv\\share\\x.exe"));
        assert!(touches_network("//srv/share/x.exe"));
        assert!(touches_network("https://a.com"));
        assert!(touches_network("ftp://a.com/x"));

        assert!(!touches_network("C:\\a\\b.exe"));
        assert!(!touches_network("D:/a/b.exe"));
        assert!(!touches_network("mailto:a@b.com"));
    }

    // ---- probe ----

    #[test]
    fn probe_reports_empty_for_blank_target() {
        assert_eq!(probe_path("").state, TargetState::Empty);
        assert_eq!(probe_path("   ").state, TargetState::Empty);
    }

    #[test]
    fn probe_skips_urls_and_network_paths() {
        assert_eq!(probe_path("https://example.com").state, TargetState::Url);
        assert_eq!(probe_path("mailto:a@b.com").state, TargetState::Url);
        assert_eq!(probe_path("\\\\srv\\share\\x.exe").state, TargetState::Network);
        assert_eq!(probe_path("//srv/share/x.exe").state, TargetState::Network);
    }

    #[test]
    fn probe_trusts_the_declared_url_kind() {
        // 只写了主机名加端口的网址：按路径去找必然找不到，
        // 但链接已经声明自己是网址，就不该给它打"失效"标记
        assert_eq!(probe("example.com:8080", LinkKind::Url).state, TargetState::Url);
        // 反过来，按路径声明时它是"裸名字"，只能报"没确认"（见下一条）
        assert_eq!(probe_path("example.com:8080").state, TargetState::Unknown);
    }

    #[test]
    fn probe_refuses_to_call_bare_names_missing() {
        // 裸文件名是 Shell 按 PATH 和注册表 `App Paths` 解析的，不是磁盘相对路径。
        // 报 Missing 会把一条**点一下就开**的链接标红、还拦住点击。
        for bare in ["notepad.exe", "run.bat", "some-tool"] {
            assert_eq!(probe_path(bare).state, TargetState::Unknown, "{bare}");
        }
        // 带分隔符的就是真的按磁盘路径查，照旧
        assert_eq!(
            probe_path("C:\\definitely\\not\\here\\x.exe").state,
            TargetState::NoParent
        );
    }

    #[test]
    fn normalize_does_not_mangle_a_real_percent_directory() {
        // Windows 允许文件名里带 `%`。一个真叫 `%TEMP%` 的文件夹
        // 不能被展开成临时目录 —— 那会把一条本来能打开的路径改坏。
        let dir = std::env::temp_dir().join("fuguang-launcher-pct");
        let real = dir.join("%TEMP%");
        std::fs::create_dir_all(&real).expect("建临时目录");
        let file = real.join("a.txt");
        std::fs::write(&file, b"x").expect("写");

        let text = file.to_string_lossy().into_owned();
        assert_eq!(normalize(&text), text, "真实存在的路径不能被展开");

        // 原样不存在的写法照样展开（用法不受影响）
        let temp = std::env::var("TEMP").expect("Windows 一定有 TEMP");
        assert_eq!(normalize("%TEMP%\\nope-8f3.txt"), format!("{temp}\\nope-8f3.txt"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_keeps_unpaired_quotes() {
        // 不配对的引号是路径的一部分（文件名里真的可以有单引号），不能动
        assert_eq!(normalize("\"C:\\a.exe"), "\"C:\\a.exe");
        assert_eq!(normalize("it's.txt"), "it's.txt");
        // 只有一个字符时不能越界
        assert_eq!(normalize("\""), "\"");
        assert_eq!(normalize(""), "");
        // 首尾各有一个引号、但**不是一对**（里面还有引号）：不动它。
        // 剥掉的结果里仍然有非法字符，一样打不开，而"只剥成对的一层"才是真规则。
        assert_eq!(normalize("\"C:\\a.exe\" 尾巴\""), "\"C:\\a.exe\" 尾巴\"");
    }

    #[test]
    fn probe_reports_ok_for_something_that_exists() {
        // 用当前这个测试可执行文件自己：它必然存在
        let me = std::env::current_exe().expect("取不到当前 exe");
        let status = probe_path(&me.to_string_lossy());
        assert_eq!(status.state, TargetState::Ok, "{status:?}");
        assert!(!status.resolved.is_empty());
    }

    #[test]
    fn probe_reports_missing_and_no_parent() {
        let dir = std::env::temp_dir().join("fuguang-launcher-probe-test");
        std::fs::create_dir_all(&dir).expect("建临时目录");

        // 文件夹在、文件不在 → Missing
        let gone = dir.join("definitely-not-here-8f3.txt");
        assert_eq!(probe_path(&gone.to_string_lossy()).state, TargetState::Missing);

        // 连文件夹都不在 → NoParent
        let orphan = dir.join("no-such-dir-8f3").join("a.txt");
        assert_eq!(probe_path(&orphan.to_string_lossy()).state, TargetState::NoParent);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_reports_no_drive_for_absent_letter() {
        // 找一个当前不存在的盘符（GetLogicalDrives 里没有的）
        let mask = unsafe { GetLogicalDrives() };
        let missing = (b'A'..=b'Z').find(|l| mask & (1u32 << (l - b'A')) == 0);
        let Some(letter) = missing else {
            // 26 个盘符全在（不可能，但别让测试假失败）
            return;
        };
        let path = format!("{}:\\some\\where\\x.exe", letter as char);
        assert_eq!(probe_path(&path).state, TargetState::NoDrive, "{path}");
    }

    // ---- .lnk 解析 ----

    /// 按规范拼一个最小的 `.lnk`：只有 LinkInfo + 一个 ANSI 的 LocalBasePath。
    fn build_lnk_with_ansi_base(local_base: &[u8]) -> Vec<u8> {
        let mut link_info = Vec::new();
        // LocalBasePath 相对 LinkInfo 起点 0x1C
        let base_off = 0x1Cu32;
        let suffix_off = base_off + local_base.len() as u32 + 1;
        let size = suffix_off + 1;

        link_info.extend_from_slice(&size.to_le_bytes()); // LinkInfoSize
        link_info.extend_from_slice(&0x1Cu32.to_le_bytes()); // LinkInfoHeaderSize（无 Unicode 段）
        link_info.extend_from_slice(&1u32.to_le_bytes()); // Flags: VolumeIDAndLocalBasePath
        link_info.extend_from_slice(&0u32.to_le_bytes()); // VolumeIDOffset
        link_info.extend_from_slice(&base_off.to_le_bytes()); // LocalBasePathOffset
        link_info.extend_from_slice(&0u32.to_le_bytes()); // CommonNetworkRelativeLinkOffset
        link_info.extend_from_slice(&suffix_off.to_le_bytes()); // CommonPathSuffixOffset
        link_info.extend_from_slice(local_base);
        link_info.push(0); // LocalBasePath 的 NUL
        link_info.push(0); // CommonPathSuffix 是空串

        let mut out = Vec::new();
        out.extend_from_slice(&0x4Cu32.to_le_bytes()); // HeaderSize
        out.extend_from_slice(&[0u8; 16]); // LinkCLSID（解析时不看）
        out.extend_from_slice(&LNK_FLAG_HAS_LINK_INFO.to_le_bytes()); // LinkFlags
        out.resize(LNK_HEADER_SIZE, 0); // 头里剩下的字段全 0
        out.extend_from_slice(&link_info);
        out
    }

    #[test]
    fn lnk_parser_reads_ascii_local_base_path() {
        let dir = std::env::temp_dir().join("fuguang-launcher-lnk-test");
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let file = dir.join("plain.lnk");

        std::fs::write(&file, build_lnk_with_ansi_base(b"C:\\tools\\plain.exe")).expect("写 lnk");
        assert_eq!(
            lnk_target(&file.to_string_lossy()).as_deref(),
            Some("C:\\tools\\plain.exe")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lnk_parser_decodes_system_ansi_not_utf8() {
        // 这一段是 GBK 的「临时」= 0xC1 0xD9 0xCA 0xB1。
        // 用 UTF-8 解会变成 4 个替换字符，于是路径对不上、被误判成"目标不存在"。
        let dir = std::env::temp_dir().join("fuguang-launcher-lnk-ansi");
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let file = dir.join("ansi.lnk");

        let mut base = b"C:\\".to_vec();
        base.extend_from_slice(&[0xC1, 0xD9, 0xCA, 0xB1]);
        base.extend_from_slice(b"\\a.bat");
        std::fs::write(&file, build_lnk_with_ansi_base(&base)).expect("写 lnk");

        let got = lnk_target(&file.to_string_lossy()).expect("应能解析");
        assert!(
            !got.contains('\u{FFFD}'),
            "被当成 UTF-8 解了（说明没走 CP_ACP）：{got}"
        );
        // 代码页是 936 时必须解出「临时」；别的代码页上只保证"不是乱码替换字符"
        if acp_to_string(b"\xC1\xD9\xCA\xB1") == "临时" {
            assert_eq!(got, "C:\\临时\\a.bat");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_does_not_recurse_forever_on_self_referencing_shortcut() {
        // 一个指向自己的 .lnk：没有层数上限的话这里是栈溢出崩溃，而不是返回值
        let dir = std::env::temp_dir().join("fuguang-launcher-lnk-self");
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let file = dir.join("self.lnk");

        let path = file.to_string_lossy().into_owned();
        if path.is_ascii() {
            std::fs::write(&file, build_lnk_with_ansi_base(path.as_bytes())).expect("写 lnk");
            // 只要求"能返回"：返回什么状态都比崩溃好
            let status = probe_path(&path);
            assert_eq!(status.resolved, path);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lnk_parser_rejects_garbage() {
        let dir = std::env::temp_dir().join("fuguang-launcher-lnk-bad");
        std::fs::create_dir_all(&dir).expect("建临时目录");

        // 不是 .lnk（头 4 字节不是 0x4C）
        let not_lnk = dir.join("not.lnk");
        std::fs::write(&not_lnk, b"hello world, definitely not a shortcut").expect("写");
        assert_eq!(lnk_target(&not_lnk.to_string_lossy()), None);

        // 空文件 / 太短
        let tiny = dir.join("tiny.lnk");
        std::fs::write(&tiny, b"\x4c\x00\x00\x00").expect("写");
        assert_eq!(lnk_target(&tiny.to_string_lossy()), None);

        // 头对、但 LinkInfo 声称的长度超出文件（截断的 .lnk）——不能 panic
        let mut truncated = build_lnk_with_ansi_base(b"C:\\a\\b.exe");
        truncated.truncate(LNK_HEADER_SIZE + 8);
        let cut = dir.join("cut.lnk");
        std::fs::write(&cut, &truncated).expect("写");
        assert_eq!(lnk_target(&cut.to_string_lossy()), None);

        // 不存在的文件
        assert_eq!(lnk_target(&dir.join("nope.lnk").to_string_lossy()), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_flags_broken_shortcut_instead_of_blaming_the_lnk() {
        let dir = std::env::temp_dir().join("fuguang-launcher-lnk-broken");
        std::fs::create_dir_all(&dir).expect("建临时目录");

        // `.lnk` 里的路径是 ANSI 字节，这里用 `to_string_lossy().as_bytes()`
        // （UTF-8）拼，所以只在纯 ASCII 路径下才有意义 —— 临时目录带中文时跳过，
        // 免得测出一个和代码无关的失败。
        let dir_text = dir.to_string_lossy().into_owned();
        if !dir_text.is_ascii() {
            return;
        }

        // 指向一个不存在的目标：.lnk 自己在，坏的是它指的东西
        let lnk = dir.join("broken.lnk");
        let missing = format!("{dir_text}\\gone-8f3.exe");
        std::fs::write(&lnk, build_lnk_with_ansi_base(missing.as_bytes())).expect("写 lnk");

        let status = probe_path(&lnk.to_string_lossy());
        assert_eq!(status.state, TargetState::LnkBroken, "{status:?}");
        assert_eq!(status.lnk_target.as_deref(), Some(missing.as_str()));

        // 指向一个真存在的目标：必须报 Ok，不能乱报
        let ok_lnk = dir.join("ok.lnk");
        let real = dir.join("real.exe");
        std::fs::write(&real, b"x").expect("写");
        std::fs::write(&ok_lnk, build_lnk_with_ansi_base(real.to_string_lossy().as_bytes()))
            .expect("写 lnk");
        assert_eq!(probe_path(&ok_lnk.to_string_lossy()).state, TargetState::Ok);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- working_dir_for ----

    /// 空目标必须在**碰 Shell 之前**就被挡住。
    ///
    /// 这条测试刻意只覆盖"会提前返回"的那条路：真的调 `ShellExecuteExW`
    /// 会启动外部程序（弹窗口、抢焦点），测试里绝对不能做。
    #[test]
    fn open_refuses_blank_target_without_touching_the_shell() {
        assert!(open("", None).is_err());
        assert!(open("   ", None).is_err());
        // 全空白加一对引号，剥完也是空的
        assert!(open("\"\"", None).is_err());
        assert!(open_elevated("", None).is_err());
        assert!(open_elevated("\r\n ", None).is_err());
    }

    /// 目标里的内嵌 NUL 必须在**碰 Shell 之前**被挡住。
    ///
    /// `wide()` 只负责编码，不检查串里本来有没有 NUL；而 `lpFile` 是个 C 字符串，
    /// Shell 会在第一个 NUL 处截断。于是界面显示和核对的是整串（查不到 → 标红），
    /// 点下去启动的却是 NUL 之前那一截 —— **同一条链接两个真相**。
    /// 链接目标能从别人给的备份 JSON 里导进来（`\u0000` 就够），所以这条得堵死。
    #[test]
    fn open_refuses_targets_with_embedded_nul() {
        let err = open("C:\\Windows\\System32\\calc.exe\0 -c evil", None)
            .expect_err("必须拒绝，而不是截断后启动前半截");
        assert!(err.contains("非法字符"), "{err}");

        let err = open("C:\\a\\b.bat", Some("--flag\0 --evil"))
            .expect_err("启动参数里的 NUL 同样要拒绝");
        assert!(err.contains("非法字符"), "{err}");
    }

    /// 普通打开路径上拿到 1223（"已取消"）时，**不能照表念**。
    ///
    /// 1223 在普通打开这条路上只有一个来源：`fMask` 不带 `NO_UI` 时 Shell 自己
    /// 弹的模态错误框被用户关掉了，真实错误码被那个框吃掉。这时报
    /// 「已取消（管理员权限的请求被拒绝了）」会把用户指向完全错误的方向
    /// （文件明明是被挪走了）。所以要自己去看目标在不在。
    #[test]
    fn cancelled_code_on_a_plain_open_is_explained_by_the_filesystem() {
        let missing = std::env::temp_dir()
            .join("fuguang-launcher-cancelled")
            .join("gone-8f3.bat");
        let text = describe_error(1223, &missing.to_string_lossy(), false);
        assert!(text.contains("找不到"), "{text}");
        assert!(!text.contains("管理员"), "{text}");
        assert!(!text.contains("已取消"), "{text}");

        // 提权那条路上它才是真的"用户拒绝了 UAC"
        let text = describe_error(1223, "C:\\a\\b.bat", true);
        assert!(text.contains("已取消"), "{text}");
    }

    #[test]
    fn working_dir_follows_explorer_rules() {
        // 普通文件 / 脚本：用所在文件夹（`.bat` 里的相对路径靠这个）
        assert_eq!(
            working_dir_for("D:\\work\\a\\run.bat").as_deref(),
            Some("D:\\work\\a")
        );
        // 快捷方式自己有"起始位置"，不能盖掉
        assert_eq!(working_dir_for("C:\\a\\b.lnk"), None);
        // 网址没有所在文件夹
        assert_eq!(working_dir_for("https://a.com/x"), None);
        assert_eq!(working_dir_for("mailto:a@b.com"), None);
        // 光秃秃一个文件名：没有上一级，交给系统
        assert_eq!(working_dir_for("run.bat"), None);
    }

    // ---- classify ----

    #[test]
    fn classify_handles_quoted_paths() {
        // 带引号复制进来的路径也要能判对，否则加进来的 kind 是错的
        let dir = std::env::temp_dir().join("fuguang-launcher-classify");
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let quoted = format!("\"{}\"", dir.to_string_lossy());
        assert_eq!(classify(&quoted), LinkKind::Folder);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- find_same_name ----

    #[test]
    fn find_same_name_looks_into_subfolders() {
        let dir = std::env::temp_dir().join("fuguang-launcher-find");
        let nested = dir.join("临时");
        std::fs::create_dir_all(&nested).expect("建临时目录");

        let target = dir.join("run.bat");
        let moved = nested.join("run.bat");
        std::fs::write(&moved, b"echo hello").expect("写");

        let hits = find_same_name(&target.to_string_lossy(), false);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].path.ends_with("run.bat"));
        // 大小和时间必须带上：只给路径的话用户没法在候选之间分辨
        assert_eq!(hits[0].bytes, b"echo hello".len() as u64);
        assert!(hits[0].modified_ms.is_some(), "应能取到修改时间");

        // 找文件夹时不能把同名文件端出来
        assert!(find_same_name(&target.to_string_lossy(), true).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_same_name_skips_hidden_entries() {
        use std::os::windows::fs::MetadataExt as _;

        let dir = std::env::temp_dir().join("fuguang-launcher-find-hidden");
        let hidden_dir = dir.join("回收站");
        std::fs::create_dir_all(&hidden_dir).expect("建临时目录");

        // 一个同名文件放在隐藏目录里：不该出现在候选里（回收站、$RECYCLE.BIN 那一类）
        let buried = hidden_dir.join("run.bat");
        std::fs::write(&buried, b"echo").expect("写");

        // 用 attrib 把目录设成隐藏。设不上（权限/文件系统）就跳过，别假失败。
        let marked = std::process::Command::new("attrib")
            .arg("+h")
            .arg(&hidden_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !marked {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        assert!(
            std::fs::symlink_metadata(&hidden_dir)
                .expect("读属性")
                .file_attributes()
                & FILE_ATTRIBUTE_HIDDEN
                != 0,
            "attrib 没生效，这条测试没有意义"
        );

        let target = dir.join("run.bat");
        assert!(
            find_same_name(&target.to_string_lossy(), false).is_empty(),
            "隐藏目录里的同名文件不该被端出来"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_same_name_refuses_network_and_blank_targets() {
        assert!(find_same_name("", false).is_empty());
        assert!(find_same_name("\\\\srv\\share\\x.exe", false).is_empty());
        assert!(find_same_name("https://a.com/x.exe", false).is_empty());
    }

    #[test]
    fn find_same_name_stops_at_depth_limit() {
        let dir = std::env::temp_dir().join("fuguang-launcher-find-deep");
        // 比深度上限多挖两层
        let deep = dir
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("e");
        std::fs::create_dir_all(&deep).expect("建深层目录");

        let target = dir.join("deep.bat");
        std::fs::write(deep.join("deep.bat"), b"echo").expect("写");

        // 深度上限之内找不到就是找不到 —— 这是刻意的边界，不是 bug
        assert!(find_same_name(&target.to_string_lossy(), false).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拿**这台机器上真实的** `.lnk` 过一遍解析器。
    ///
    /// 默认不跑（`#[ignore]`）：它依赖本机桌面有什么，CI 上必然不一样。
    /// 留着是因为合成出来的缓冲区证明不了"真实文件也能读对" ——
    /// 尤其是 `LocalBasePath` 的 ANSI 解码，只有真带中文的路径才试得出来。
    ///
    ///     cargo test --lib real_desktop -- --ignored --nocapture
    ///
    /// 断言只钉**与机器无关的不变量**：解析出来的东西必须长得像一个绝对路径。
    /// 偏移量错一位会读出乱码，这条就能抓住。
    #[test]
    #[ignore]
    fn real_desktop_shortcuts_parse_into_sane_paths() {
        let mut checked = 0;
        for base in [
            std::env::var("USERPROFILE").map(|p| format!("{p}\\Desktop")),
            Ok("C:\\Users\\Public\\Desktop".to_string()),
        ]
        .into_iter()
        .flatten()
        {
            let Ok(entries) = std::fs::read_dir(&base) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if extension_of(&path) != "lnk" {
                    continue;
                }
                let Some(target) = lnk_target(&path.to_string_lossy()) else {
                    // 读不出来是允许的（Store 应用没有 LinkInfo），但必须不是"读成了空"
                    continue;
                };
                checked += 1;
                assert!(!target.contains('\u{FFFD}'), "解出乱码：{target}");
                let looks_absolute = drive_letter(&target).is_some() || target.starts_with("\\\\");
                assert!(looks_absolute, "不是绝对路径，偏移量可能错了：{target}");
            }
        }
        assert!(checked > 0, "一个都没解析出来，先确认这台机器上有没有 .lnk");
        println!("解析成功 {checked} 个真实快捷方式");
    }
}
