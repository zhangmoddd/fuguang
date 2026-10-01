//! 平台相关底层能力（目前仅 Windows）。
//!
//! 这个模块承载浮光最核心也最容易出问题的一件事：
//! **把文本送进「别的程序」的光标位置，而不打断用户当前正在做的事。**
//!
//! 实现策略（对应设计决策）：
//! 1. 借用剪贴板：写入文本 → 模拟 Ctrl+V → 延时 → 把用户原本的剪贴板内容还回去。
//! 2. 粘贴前把前台焦点还给「用户上一次真正在用的窗口」，否则 Ctrl+V 会打到浮光自己身上。
//! 3. 悬浮球与主面板使用不抢焦点窗口（WS_EX_NOACTIVATE），保证光标不消失。

#![cfg(windows)]

use std::sync::atomic::{AtomicIsize, Ordering};
use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, CountClipboardFormats, EmptyClipboard, GetClipboardData, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
    VK_V,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};

/// CF_UNICODETEXT：剪贴板里的纯文本格式。
const CF_UNICODETEXT: u32 = 13;

/// 浮光自己的窗口标题，用于把「前台窗口」判定为「不是外部目标」。
pub const OUR_WINDOW_TITLES: [&str; 3] = ["浮光·球", "浮光·主面板", "浮光·提醒"];

/// 用户上一次真正在用的外部窗口句柄。
/// 用原子整数保存，避免为这一个值引入 Mutex 与跨线程锁竞争。
static LAST_TARGET_HWND: AtomicIsize = AtomicIsize::new(0);

/// 记录一个候选的前台窗口；若是浮光自己的窗口则忽略。
pub fn remember_foreground(hwnd: HWND, title: Option<&str>) {
    if hwnd.is_null() {
        return;
    }
    if let Some(t) = title {
        if OUR_WINDOW_TITLES.contains(&t) {
            return;
        }
    }
    LAST_TARGET_HWND.store(hwnd as isize, Ordering::Relaxed);
}

/// 读取记录的目标窗口。若那个窗口已经被关闭，则返回 None。
pub fn last_target_window() -> Option<HWND> {
    let raw = LAST_TARGET_HWND.load(Ordering::Relaxed);
    if raw == 0 {
        return None;
    }
    let hwnd = raw as HWND;
    // IsWindow 能挡掉「用户已经关掉了那个程序」的情况
    if unsafe { IsWindow(hwnd) } == 0 {
        return None;
    }
    Some(hwnd)
}

/// 把前台焦点还给目标窗口。
///
/// Windows 默认禁止后台进程抢前台，这里用 AttachThreadInput 把当前线程的输入
/// 队列挂到目标窗口所属线程上，绕过该限制。这是模拟按键类工具的通用做法。
pub fn focus_window(hwnd: HWND) -> bool {
    unsafe { attach_and_focus(hwnd) }
}

/// 同上，但接收裸句柄（`isize`）。
///
/// 给需要从 `tauri::Window::hwnd()` 拿句柄的调用方用，
/// 避免它们为了转类型而引入 windows-sys 依赖。
pub fn force_foreground(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe { attach_and_focus(hwnd as HWND) }
}

/// AttachThreadInput + SetForegroundWindow 的共用实现。
///
/// # Safety
/// `hwnd` 必须是有效的窗口句柄。
unsafe fn attach_and_focus(hwnd: HWND) -> bool {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut target_pid = 0u32;
    let target_tid = GetWindowThreadProcessId(hwnd, &mut target_pid);
    let current_tid = GetCurrentThreadId();

    let attached = if target_tid != 0 && target_tid != current_tid {
        // 第三个参数是 BOOL（i32），1 = 附加
        AttachThreadInput(current_tid, target_tid, 1) != 0
    } else {
        false
    };

    let ok = SetForegroundWindow(hwnd) != 0;

    if attached {
        AttachThreadInput(current_tid, target_tid, 0);
    }
    ok
}

/// 构造一个键盘事件。
fn key_event(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki.wVk = vk;
    input.Anonymous.ki.wScan = 0;
    input.Anonymous.ki.dwFlags = flags;
    input.Anonymous.ki.time = 0;
    input.Anonymous.ki.dwExtraInfo = 0;
    input
}

/// 模拟按下并松开 Ctrl+V。返回是否**真的**注入成功。
fn send_ctrl_v() -> bool {
    let inputs = [
        key_event(VK_CONTROL, 0),
        key_event(VK_V, 0),
        key_event(VK_V, KEYEVENTF_KEYUP),
        key_event(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    // `SendInput` 会被 UIPI 拦下来：目标窗口的完整性级别比浮光高时
    // （例如以管理员身份运行的编辑器、终端），它返回 0 并置 ERROR_ACCESS_DENIED。
    //
    // 原来忽略返回值，于是"一个字都没进去"被当成成功报给用户 ——
    // 面板显示"已粘贴 → 记事本"，用户反复点都没反应还不知道为什么。
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    sent == inputs.len() as u32
}

/// 打开剪贴板，失败时重试几次。成功返回 true。
///
/// 剪贴板同一时刻只允许一个所有者，而 Office、剪贴板管理器、输入法都会
/// 短暂占用它。Win32 文档明确要求失败时重试；单次失败就放弃会让复制/粘贴
/// 偶发失灵 —— 而且这条路径上用户原来的剪贴板内容已经被清掉了。
fn open_clipboard_retry() -> bool {
    for _ in 0..5 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}

/// 剪贴板里有东西，但我们**没能把它备份下来**。
///
/// # 为什么不能只看"有没有文本格式"
///
/// Office 对 `CF_UNICODETEXT` 用的是**延迟渲染**：`IsClipboardFormatAvailable`
/// 返回真，但 owner 忙、不响应 `WM_RENDERFORMAT` 时 `GetClipboardData` 返回 NULL。
/// 那一刻文本格式"可用"却读不出来 —— 按格式判断会得出"有文本、不用提示"的
/// 错误结论，于是**既不还原、也不提示**，用户的剪贴板静默变成了浮光的内容。
///
/// 所以只看"剪贴板里有没有东西"：`backup` 拿不到、而剪贴板非空，
/// 就说明我们备份不了它，必须告诉用户。
fn clipboard_has_unbacked_content() -> bool {
    unsafe { CountClipboardFormats() > 0 }
}

/// 剪贴板里现在装的**还是**我们刚写进去的那段文本吗？
///
/// - `Some(true)` → 是，这期间没人动过它，可以安全地把用户原来的内容还回去
/// - `Some(false)` → 不是（用户复制了新东西，或目标程序改写了它）→ 别动
/// - `None` → **读不出来**（剪贴板被别的进程占着，重试 5 次都失败）
///
/// 三种情况必须分开。`None` 和 `Some(false)` 都意味着"不能还原"，
/// 但原因完全不同：前者是我们**没法判断**，后者是"有人写过、不该覆盖"。
/// 原来用 `is_some_and` 把两者压成一个 bool，于是"读不出来"被静默当成
/// "内容不一样"，用户的原文丢了而界面上还报"已粘贴"。
///
/// # ⚠️ 不要试图用 `GetClipboardSequenceNumber()` 的差值来判断
///
/// 曾经这么写过：记下写入前的序号，要求写入后正好 `+1` 才还原。
/// **实测一次 `clipboard_set_text` 会把序号推高 5**（本机复现 3/3）：
///
/// ```text
/// 开剪贴板后 +0   EmptyClipboard 后 +1   SetClipboardData 后 +1   CloseClipboard 后 +3
/// ★总增量 = 5
/// ```
///
/// 最后那 +3 多半是剪贴板管理器之类的观察者在响应。于是"差 1"这个判据
/// **恒为假**，剪贴板永远不还原 —— 比它要修的原实现还糟（原实现至少在
/// 常见情况下是对的）。差值判据把"我们自己写了多少次"当成了可控常量，
/// 而它不是。
///
/// 内容相等这个判据没有这种隐藏耦合：它只问"还是我写的那段吗"。
fn clipboard_state(text: &str) -> Option<bool> {
    clipboard_get_text().map(|current| current == text)
}

/// 读取剪贴板中的文本。剪贴板非文本或为空时返回 None。
pub fn clipboard_get_text() -> Option<String> {
    unsafe {
        if !open_clipboard_retry() {
            return None;
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            CloseClipboard();
            return None;
        }
        let ptr = GlobalLock(handle as *mut core::ffi::c_void) as *const u16;
        if ptr.is_null() {
            CloseClipboard();
            return None;
        }
        // 剪贴板文本是以 NUL 结尾的 UTF-16
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
            // 防御异常大的剪贴板内容（正常文本不会有 1M 个字符）
            if len > 1_048_576 {
                break;
            }
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        GlobalUnlock(handle as *mut core::ffi::c_void);
        CloseClipboard();
        Some(text)
    }
}

/// 把文本写入剪贴板。成功返回 true。
pub fn clipboard_set_text(text: &str) -> bool {
    // 转成 UTF-16 并补 NUL 结尾
    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0);
    let bytes = utf16.len() * std::mem::size_of::<u16>();

    unsafe {
        // GMEM_MOVEABLE 是 SetClipboardData 要求的分配方式
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if hmem.is_null() {
            return false;
        }
        let dst = GlobalLock(hmem) as *mut u16;
        if dst.is_null() {
            GlobalFree(hmem);
            return false;
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), dst, utf16.len());
        GlobalUnlock(hmem);

        if !open_clipboard_retry() {
            GlobalFree(hmem);
            return false;
        }
        EmptyClipboard();
        // 成功后剪贴板接管这块内存的所有权，不能再手动释放
        let ok = !SetClipboardData(CF_UNICODETEXT, hmem as HANDLE).is_null();
        CloseClipboard();
        if !ok {
            GlobalFree(hmem);
        }
        ok
    }
}

/// 粘贴结果，回传给前端用于提示用户。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PasteOutcome {
    /// 是否成功把文本送出去
    pub ok: bool,
    /// 粘贴目标窗口的标题（用于面板上显示「→ 微信」这类反馈）
    pub target: Option<String>,
    /// 失败或降级原因
    pub message: Option<String>,
}

/// 取窗口标题，用于给用户显示粘贴去向。
pub fn window_title(hwnd: HWND) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let written = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if written <= 0 {
            return None;
        }
        buf.truncate(written as usize);
        Some(String::from_utf16_lossy(&buf))
    }
}

/// 核心动作：把 `text` 粘贴到当前记录的「上一次外部前台窗口」。
///
/// `restore_delay_ms`：模拟 Ctrl+V 之后等多久再把原剪贴板还回去。
/// 太短会在慢程序里粘贴成空内容，太长会明显占用用户剪贴板。
pub fn paste_to_target(text: &str, restore_delay_ms: u64) -> PasteOutcome {
    if text.is_empty() {
        return PasteOutcome {
            ok: false,
            target: None,
            message: Some("内容为空，未执行粘贴".into()),
        };
    }

    // 1. 备份用户原本的**文本**
    //
    // 备份拿不到文本有两种情况，含义完全不同：剪贴板是空的（无所谓），
    // 或者里面有我们备份不了的东西（图片/文件/富文本，或延迟渲染读不出来的文本）。
    let backup = clipboard_get_text();
    let had_unbacked = backup.is_none() && clipboard_has_unbacked_content();

    // 2. 写入要粘贴的文本
    if !clipboard_set_text(text) {
        return PasteOutcome {
            ok: false,
            target: None,
            message: Some("写入剪贴板失败，可能有其他程序正占用剪贴板，请重试".into()),
        };
    }

    // 3. 把焦点还给目标窗口
    let target_hwnd = last_target_window();
    let mut message = None;
    let target = match target_hwnd {
        Some(hwnd) => {
            let title = window_title(hwnd);
            if !focus_window(hwnd) {
                message = Some("无法切回目标窗口，已把文本放入剪贴板，可手动 Ctrl+V".into());
            }
            // 给系统一点时间完成焦点切换，否则 Ctrl+V 会打偏
            thread::sleep(Duration::from_millis(60));
            title
        }
        None => {
            message = Some("未找到可粘贴的目标窗口，已把文本放入剪贴板，可手动 Ctrl+V".into());
            None
        }
    };

    // 4. 只有确实有目标窗口、且前面没出问题时才模拟按键，否则只把内容留在剪贴板
    let mut ok = false;
    if target_hwnd.is_some() && message.is_none() {
        if send_ctrl_v() {
            ok = true;
        } else {
            message = Some(
                "模拟按键被系统拦截（目标程序权限比浮光高），已把文本放入剪贴板，可手动 Ctrl+V"
                    .into(),
            );
        }
    }

    // 5. 还原用户原来的剪贴板
    //
    // ⚠️ **只在这次粘贴真的成功（`ok`）时才还原。**
    //
    // 失败路径上我们刚刚告诉用户"已把文本放入剪贴板，可手动 Ctrl+V"——
    // 那时必须把文本**留在**剪贴板里。原来的写法不看 `ok`、照还原不误，
    // 于是用户照着提示按 Ctrl+V，粘出来的是他**原来**的剪贴板内容
    // （可能是别处的密码、地址），而 snippet 的内容一个字都没出去 ——
    // 那条兜底提示 100% 是假的。
    //
    // 但"不还原"意味着用户原来的内容**没了**，所以这件事要显式跟踪：
    // 只要原文没被成功还回去，就必须告诉他，否则东西没了而他一无所知。
    let mut original_lost = had_unbacked;

    if ok {
        if let Some(previous) = backup {
            if restore_delay_ms > 0 {
                thread::sleep(Duration::from_millis(restore_delay_ms));
            }
            match clipboard_state(text) {
                // 还是我们写的那段 → 没人动过，还回去
                Some(true) => {
                    if !clipboard_set_text(&previous) {
                        original_lost = true;
                    }
                }
                // 有人写过（用户复制了新东西，或目标程序改写了它）→ 不覆盖它。
                // 用户原来那份确实回不来了，但此刻剪贴板里是他自己在意的内容，
                // 报一句"原文已被替换"只会让人困惑，所以这里不提示。
                Some(false) => {}
                // 读不出来：没法判断该不该还原，保守不动 —— 但原文确实丢了，要说
                None => original_lost = true,
            }
        }
    } else if backup.is_some() {
        // 降级路径：为了保住"手动 Ctrl+V 能粘出 snippet"，我们**故意**不还原。
        // 代价就是用户原来的内容被替换掉了 —— 必须说清楚。
        original_lost = true;
    }

    if original_lost {
        const WARN: &str =
            "剪贴板里原来的内容已被这次粘贴替换，无法还原（图片/文件/富文本，或这次没能还原成功的文本）";
        message = Some(match message {
            Some(existing) => format!("{existing}；{WARN}"),
            None => WARN.into(),
        });
    }

    PasteOutcome {
        ok,
        target,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 碰真实剪贴板的测试必须**串行**。
    ///
    /// `cargo test` 默认多线程，两个测试同时读写同一个系统剪贴板会互相把对方的
    /// 内容冲掉，表现为随机失败。全 crate 只有下面两条会碰剪贴板。
    static CLIPBOARD_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 备份当前剪贴板，并判断"这次测试能不能安全地跑"。
    ///
    /// 返回 `None` 表示**必须跳过**：要么没有剪贴板会话（CI / 无桌面），
    /// 要么剪贴板里是图片/文件这种我们还原不了的东西 ——
    /// `clipboard_set_text` 会 `EmptyClipboard()` 把它彻底销毁，
    /// 跑一次测试不该毁掉开发者剪贴板里的截图。
    fn backup_for_clipboard_test() -> Option<Option<String>> {
        let saved = clipboard_get_text();
        if saved.is_none() && clipboard_has_unbacked_content() {
            // 跳过必须**可见**。静默跳过会让"全绿"变成假象 ——
            // 上一批那个"判据恒为假却全绿"的坑就是这么来的。
            eprintln!("[浮光] 剪贴板里是图片/文件，还原不了，跳过这条剪贴板测试");
            return None;
        }
        Some(saved)
    }

    /// 把测试前的剪贴板内容还回去。
    fn restore_after_clipboard_test(saved: Option<String>) {
        if let Some(previous) = saved {
            let _ = clipboard_set_text(&previous);
        }
    }

    /// 判据与真实写入之间的**耦合**必须端到端测一次。
    ///
    /// # 为什么这条测试非有不可
    ///
    /// 上一版判据（用 `GetClipboardSequenceNumber` 的差值）就是**只有纯函数测试**
    /// 才漏过去的：三条测试都在测 `can_restore(100, 101)` 这类人造输入，
    /// 从没问过"真写一次剪贴板，序号实际涨多少"。答案是 **5**，不是 1 ——
    /// 于是判据恒为假、剪贴板永远不还原，而 `cargo test` 全绿。
    #[test]
    fn 写完剪贴板之后判据必须认得自己写的内容() {
        let _guard = CLIPBOARD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        const MARK: &str = "浮光剪贴板自检-7f3a";

        let Some(saved) = backup_for_clipboard_test() else {
            return; // 剪贴板里是还原不了的东西，别动它（原因已 eprintln）
        };
        if !clipboard_set_text(MARK) {
            eprintln!("[浮光] 没有可用的剪贴板会话，跳过这条剪贴板测试");
            return;
        }

        assert!(
            clipboard_state(MARK) == Some(true),
            "判据认不出自己刚写进去的内容 —— 那样粘贴后永远不会还原"
        );
        assert!(
            clipboard_state("别的文本") == Some(false),
            "剪贴板里不是这段内容时应当明确判 false，而不是「读不出来」"
        );

        restore_after_clipboard_test(saved);
    }

    /// 没有目标窗口时**不能**还原剪贴板。
    ///
    /// 这条钉的是一个真实回归：失败路径上我们告诉用户"已把文本放入剪贴板，
    /// 可手动 Ctrl+V"，但第 5 步不看 `ok`、照还原不误 —— 用户照着提示按 Ctrl+V，
    /// 粘出来的是他**原来**的剪贴板内容（可能是别处的密码/地址），
    /// 而 snippet 的内容一个字都没出去。那条兜底提示 100% 是假的。
    #[test]
    fn 没有目标窗口时不还原剪贴板_文本要留给用户手动粘贴() {
        let _guard = CLIPBOARD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        const ORIGINAL: &str = "浮光测试-原来的剪贴板内容-4b1e";
        const PAYLOAD: &str = "浮光测试-要粘贴的内容-9c2d";

        let Some(saved) = backup_for_clipboard_test() else {
            return;
        };
        if !clipboard_set_text(ORIGINAL) {
            eprintln!("[浮光] 没有可用的剪贴板会话，跳过这条剪贴板测试");
            return;
        }

        // 测试进程里没人调过 `remember_foreground`，所以走"未找到目标窗口"分支
        let outcome = paste_to_target(PAYLOAD, 0);

        assert!(!outcome.ok, "没有目标窗口时不该报告成功");
        assert!(
            clipboard_state(PAYLOAD) == Some(true),
            "既然提示了「已把文本放入剪贴板，可手动 Ctrl+V」，剪贴板里就必须是它"
        );

        // 我们**故意**没还原（要让手动 Ctrl+V 能粘出 snippet），
        // 代价是用户原来那份没了 —— 必须一并告诉他，否则东西丢了都不知道
        let msg = outcome.message.expect("应当给出提示");
        assert!(msg.contains("手动 Ctrl+V"), "实际：{msg}");
        assert!(
            msg.contains("无法还原"),
            "没告诉用户原文已被替换，实际：{msg}"
        );

        restore_after_clipboard_test(saved);
    }

    #[test]
    fn 判据只认内容相等() {
        // 纯逻辑部分：判据建立在 clipboard_get_text 之上，
        // 这里只钉住"相等才成立"这个语义本身
        fn holds(current: Option<&str>, written: &str) -> bool {
            current.is_some_and(|c| c == written)
        }
        assert!(holds(Some("abc"), "abc"));
        assert!(!holds(Some("abc"), "abd"));
        assert!(!holds(None, "abc"), "剪贴板里没有文本时不该说成立");
    }
}
