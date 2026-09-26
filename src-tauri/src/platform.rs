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
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
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

/// 模拟按下并松开 Ctrl+V。
fn send_ctrl_v() {
    let inputs = [
        key_event(VK_CONTROL, 0),
        key_event(VK_V, 0),
        key_event(VK_V, KEYEVENTF_KEYUP),
        key_event(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

/// 读取剪贴板中的文本。剪贴板非文本或为空时返回 None。
pub fn clipboard_get_text() -> Option<String> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
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

        if OpenClipboard(std::ptr::null_mut()) == 0 {
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

    // 1. 先备份用户原本的剪贴板（失败不致命，只是无法还原）
    let backup = clipboard_get_text();

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

    // 4. 只有确实有目标窗口时才模拟按键，否则只把内容留在剪贴板
    let ok = if target_hwnd.is_some() && message.is_none() {
        send_ctrl_v();
        true
    } else {
        false
    };

    // 5. 还原用户原来的剪贴板
    if let Some(previous) = backup {
        if restore_delay_ms > 0 {
            thread::sleep(Duration::from_millis(restore_delay_ms));
        }
        // 只有在用户没在等待期间复制新东西时才还原，避免覆盖用户的新操作
        if let Some(current) = clipboard_get_text() {
            if current == text {
                clipboard_set_text(&previous);
            }
        }
    }

    PasteOutcome {
        ok,
        target,
        message,
    }
}
