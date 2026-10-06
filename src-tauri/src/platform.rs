//! 平台相关底层能力（目前仅 Windows）。
//!
//! 这个模块承载浮光最核心也最容易出问题的一件事：
//! **把文本送进「别的程序」的光标位置，而不打断用户当前正在做的事。**
//!
//! 实现策略（对应设计决策）：
//! 1. 借用剪贴板：写入文本 → 模拟 Ctrl+V → 延时 → 把用户原本的剪贴板内容还回去。
//! 2. 粘贴前把前台焦点还给「用户上一次真正在用的窗口」，否则 Ctrl+V 会打到浮光自己身上。
//! 3. **只有悬浮球是不抢焦点的窗口**（`windows.rs` 里 `focused(false)`）；
//!    主面板和提醒窗都是 `focused(true)` + `set_focus()`，会拿走焦点 ——
//!    这是刻意的取舍（不抢焦点的窗口在 Windows 上按钮点击不可靠，
//!    见 README 的「已知限制」）。这条注释原来写的是"悬浮球与主面板都用
//!    `WS_EX_NOACTIVATE`"，**全项目根本没有那个样式**，是错的，已改正。

#![cfg(windows)]

use std::sync::atomic::{AtomicIsize, Ordering};
use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, CountClipboardFormats, EmptyClipboard, GetClipboardData,
    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
    VK_V,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};

/// CF_UNICODETEXT：剪贴板里的纯文本格式。
const CF_UNICODETEXT: u32 = 13;

/// 「文本家族之外」的几种剪贴板格式。
///
/// 用来判断用户原来复制的东西是不是**不只是纯文本** —— 这次粘贴会
/// `EmptyClipboard()` 把整个剪贴板清空，事后我们只能把**文本**写回去，
/// 这些格式一旦原来存在就永久没了，必须告诉用户。
///
/// 为什么不按"格式数 > 1"判断：Windows 复制**纯文本**时也会同时放
/// `CF_TEXT` / `CF_OEMTEXT` / `CF_UNICODETEXT` / `CF_LOCALE` 好几种，
/// 那样会对普通文本误报"你的东西被销毁了"。
const CF_BITMAP: u32 = 2;
const CF_METAFILEPICT: u32 = 3;
/// `CF_DIB`（设备无关位图）。
///
/// 对 `crate::media` 公开：图片模块要靠它判断"剪贴板里是不是图片"、
/// 以及把图片写进剪贴板。两处各写一个 `8` 的话，将来改一处就会静默错位。
pub(crate) const CF_DIB: u32 = 8;
const CF_ENHMETAFILE: u32 = 14;
const CF_HDROP: u32 = 15;
const CF_DIBV5: u32 = 17;

/// 浮光自己的窗口标题，用于把「前台窗口」判定为「不是外部目标」。
///
/// ⚠️ **这是精确标题匹配，不是前缀匹配。** 多面板（`panel` / `panel-2` / …）
/// 全部共用同一个标题「浮光·主面板」正是为了这个白名单：一旦给新面板起名
/// 「浮光·主面板 2」，它就匹配不上这里，前台跟踪线程会把浮光自己的面板
/// 记成"用户上一次在用的窗口"，于是「粘贴到光标」会把内容打回浮光自己身上。
/// `windows.rs` 里有 `面板标题必须与平台白名单一致` 这条测试钉着这个依赖。
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
///
/// 对 `crate::media` 公开：把图片"键入到当前光标"用的是同一个按键序列，
/// 所以也必须共用同一份失败判定（`SendInput` 被 UIPI 拦下来时返回 0）。
pub(crate) fn send_ctrl_v() -> bool {
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
/// 偶发失灵。
///
/// ⚠️ 注意：**这个函数在 `EmptyClipboard` 之前被调用**，所以它失败时
/// 用户原来的剪贴板内容**完好无损**（曾经这里的注释写成"已经被清掉了"，
/// 那个错误认知让调用方对用户谎报"原文已被清空、无法还原"，
/// 见 `ClipboardWrite::FailedUntouched`）。
///
/// 对 `crate::media` 公开：图片路径也要打开剪贴板，而"失败就重试几次"这条
/// 经验（Office、剪贴板管理器会短暂占用剪贴板）对图片同样成立 ——
/// 各写一份必然会有一份漏掉重试。
pub(crate) fn open_clipboard_retry() -> bool {
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

/// 把字符串转成 NUL 结尾的 UTF-16，供 Win32 的 `*W` 系列函数用。
///
/// 对 `crate::media` 公开：读剪贴板图片时要按**格式名**查注册格式
/// （`RegisterClipboardFormatW("PNG")`），用的是同一套转换。
pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 剪贴板里除了纯文本，还装着别的东西吗（图片 / 元文件 / 文件列表 / HTML / RTF）？
///
/// # 为什么这个判断非有不可
///
/// 这次粘贴会把用户原来的剪贴板**整个清空**（`EmptyClipboard`），事后我们只能把
/// **文本**写回去。所以"文本读到了"**不等于**"用户的东西没丢" ——
/// 从 Word / 浏览器复制一段内容时，剪贴板里同时有 `CF_UNICODETEXT` **和**
/// HTML / RTF / Bitmap；粘贴完那些格式全没了，用户回 Word 再粘一次只会得到纯文本。
///
/// 原来只看 `backup.is_none()`，于是这种情况被判成"没丢、不用提示" ——
/// 与警告文案里明写的"图片/文件/富文本"自相矛盾。
fn clipboard_had_richer_content() -> bool {
    const EXTRA: [u32; 6] = [
        CF_BITMAP,
        CF_METAFILEPICT,
        CF_DIB,
        CF_ENHMETAFILE,
        CF_HDROP,
        CF_DIBV5,
    ];
    unsafe {
        if EXTRA.iter().any(|f| IsClipboardFormatAvailable(*f) != 0) {
            return true;
        }
        // Word / 浏览器复制富文本时会注册这两个格式名（不是预定义常量）
        for name in ["HTML Format", "Rich Text Format"] {
            let id = RegisterClipboardFormatW(wide(name).as_ptr());
            if id != 0 && IsClipboardFormatAvailable(id) != 0 {
                return true;
            }
        }
        false
    }
}

/// 粘贴结束后要不要把用户原来的文本还回去。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoreAction {
    /// 把用户原来的文本写回去
    Restore,
    /// 我们写的文本要**留在**剪贴板里（失败路径上用户得能手动 Ctrl+V）
    KeepOurs,
    /// 什么都不做（有人写过剪贴板，或者我们读不出来）
    LeaveAlone,
}

/// 决定收尾动作。**纯函数，不碰系统剪贴板。**
///
/// # 为什么要把这段判断从 Win32 调用里拆出来
///
/// 这段逻辑**连续错了两次**（一次判据恒为假、一次"手动 Ctrl+V"的提示是假的），
/// 而它原来和 `OpenClipboard` / `SetClipboardData` 缠在一起，只能靠
/// "改真实剪贴板 + 跑 cargo test" 来验证 —— 而那个测试在"剪贴板里正好是图片"
/// 时会静默跳过（libtest 还会把跳过信息吞掉），于是**全绿但一条断言都没跑**。
///
/// 拆成纯函数之后可以穷举所有组合，不依赖任何本机状态。
fn decide_restore(ok: bool, still_ours: Option<bool>) -> RestoreAction {
    // 失败路径上我们刚告诉用户"已把文本放入剪贴板，可手动 Ctrl+V"，
    // 那时必须把文本**留在**剪贴板里。原来不看 `ok`、照还原不误，
    // 于是用户照着提示按 Ctrl+V，粘出来的是他**原来**的内容 —— 那句话是假的。
    if !ok {
        return RestoreAction::KeepOurs;
    }
    match still_ours {
        // 还是我们写的那段 → 没人动过，还回去
        Some(true) => RestoreAction::Restore,
        // 有人写过（用户复制了新东西，或目标程序改写了它）→ 不覆盖它
        Some(false) => RestoreAction::LeaveAlone,
        // 读不出来 → 没法判断，保守不动
        None => RestoreAction::LeaveAlone,
    }
}

/// 用户原来复制的东西是不是**已经找不回来了**。**纯函数，不碰系统剪贴板。**
///
/// 只要返回 true 就必须给用户一条提示 —— 东西没了而他一无所知是最坏的结果。
fn decide_original_lost(
    ok: bool,
    had_backup: bool,
    had_unbacked: bool,
    had_richer: bool,
    still_ours: Option<bool>,
    restored: bool,
) -> bool {
    if !ok {
        // 降级路径：为了保住"手动 Ctrl+V 能粘出 snippet"，我们**故意**不还原。
        // 原来有东西（能备份的文本，或备份不了的东西）就都算丢了；剪贴板原本是空的则无所谓。
        return had_backup || had_unbacked;
    }
    match still_ours {
        Some(true) => {
            // 还回去了（或本来就没什么可还的）。三种情况仍然算丢：
            //   1. 想还但写入失败
            //   2. 原来除了文本还有 HTML/RTF/图片/文件列表 —— 那些已被销毁
            //   3. 原来有我们根本读不出来的东西
            (had_backup && !restored) || had_richer || had_unbacked
        }
        // 有人写过 / 我们读不出来 → 都没还原，原文回不来。
        // "有人写过"几乎一定是目标程序改写的：用户刚点完粘贴，
        // 这 120ms 里不可能自己去复制别的东西。
        _ => true,
    }
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
        let ptr = GlobalLock(handle) as *const u16;
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
        GlobalUnlock(handle);
        CloseClipboard();
        Some(text)
    }
}

/// 写剪贴板的结果。
///
/// 必须把"失败了但没碰剪贴板"和"失败了且已清空"分开：调用方要据此决定
/// 该不该告诉用户"你原来的内容没了"。合成一个 bool 会让提示在没丢东西时说丢东西。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardWrite {
    /// 写成功了
    Ok,
    /// 失败了，但**没碰过**剪贴板（分配/加锁/打开失败都发生在 `EmptyClipboard` 之前）
    FailedUntouched,
    /// 失败了，而且剪贴板**已经被清空**（`EmptyClipboard` 执行过，原文没了）
    FailedCleared,
}

/// 把文本写入剪贴板，并区分两种失败。
pub fn clipboard_write_text(text: &str) -> ClipboardWrite {
    // 转成 UTF-16 并补 NUL 结尾
    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0);
    let bytes = utf16.len() * std::mem::size_of::<u16>();

    unsafe {
        // GMEM_MOVEABLE 是 SetClipboardData 要求的分配方式
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if hmem.is_null() {
            return ClipboardWrite::FailedUntouched;
        }
        let dst = GlobalLock(hmem) as *mut u16;
        if dst.is_null() {
            GlobalFree(hmem);
            return ClipboardWrite::FailedUntouched;
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), dst, utf16.len());
        GlobalUnlock(hmem);

        if !open_clipboard_retry() {
            GlobalFree(hmem);
            return ClipboardWrite::FailedUntouched;
        }
        // ⚠️ 这一行之后，用户原来的内容就没了
        EmptyClipboard();
        // 成功后剪贴板接管这块内存的所有权，不能再手动释放
        let ok = !SetClipboardData(CF_UNICODETEXT, hmem as HANDLE).is_null();
        CloseClipboard();
        if !ok {
            GlobalFree(hmem);
            return ClipboardWrite::FailedCleared;
        }
        ClipboardWrite::Ok
    }
}

/// 把文本写入剪贴板。成功返回 true。
///
/// 只关心成败时用它；需要区分"失败但原文还在"和"失败且原文没了"时用
/// [`clipboard_write_text`]。
pub fn clipboard_set_text(text: &str) -> bool {
    clipboard_write_text(text) == ClipboardWrite::Ok
}

/// 清空剪贴板。成功返回 true。
///
/// 用在"用户原来的剪贴板**本来就是空的**"这种情况：把状态还原成空的，
/// 而不是把我们粘过的片段永久留在里面（带「敏感」标记的片段尤其不该留）。
fn clipboard_clear() -> bool {
    unsafe {
        if !open_clipboard_retry() {
            return false;
        }
        EmptyClipboard();
        CloseClipboard();
        true
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

    // 1. 备份用户原本的**文本**，并记下原来还有没有别的东西
    //
    // 备份拿不到文本有两种情况，含义完全不同：剪贴板是空的（无所谓），
    // 或者里面有我们备份不了的东西（图片/文件/富文本，或延迟渲染读不出来的文本）。
    let backup = clipboard_get_text();
    let had_unbacked = backup.is_none() && clipboard_has_unbacked_content();
    // "文本读到了"不等于"用户的东西没丢"：从 Word/浏览器复制时剪贴板里
    // 同时有文本和 HTML/RTF/图片，粘贴完那些格式全被 EmptyClipboard 销毁了
    let had_richer = clipboard_had_richer_content();

    // 2. 写入要粘贴的文本
    match clipboard_write_text(text) {
        ClipboardWrite::Ok => {}
        ClipboardWrite::FailedUntouched => {
            // ⚠️ 这条路径**没碰过剪贴板**：`GlobalAlloc` / `GlobalLock` /
            // `OpenClipboard` 三处失败都发生在 `EmptyClipboard` **之前**。
            // 所以绝不能声称"原文已被清空" —— 那是纯粹的错误信息，
            // 而且会让用户以为东西丢了（原来这里就是这么错的）。
            return PasteOutcome {
                ok: false,
                target: None,
                message: Some("写入剪贴板失败，可能有其他程序正占用剪贴板，请重试".into()),
            };
        }
        ClipboardWrite::FailedCleared => {
            // 这条才真的清空了剪贴板（`EmptyClipboard` 执行过，只是 SetClipboardData 失败）
            let lost = had_unbacked || had_richer || backup.is_some();
            const BASE: &str = "写入剪贴板失败，可能有其他程序正占用剪贴板，请重试";
            return PasteOutcome {
                ok: false,
                target: None,
                message: Some(if lost {
                    format!("{BASE}；剪贴板里原来的内容已被清空，无法还原")
                } else {
                    BASE.into()
                }),
            };
        }
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
    // 决策本身在 `decide_restore` / `decide_original_lost` 两个**纯函数**里，
    // 这里只负责按决策去调 Win32。把它们拆开是因为这段判断连续错了两次，
    // 而和 Win32 缠在一起就只能靠"改真实剪贴板"来验证 ——
    // 那个测试在"剪贴板里正好是图片"时会静默跳过，等于没有安全网。
    if ok && restore_delay_ms > 0 {
        // 先等一会儿：目标程序可能还没处理完那次 Ctrl+V
        thread::sleep(Duration::from_millis(restore_delay_ms));
    }

    let still_ours = if ok { clipboard_state(text) } else { None };
    let action = decide_restore(ok, still_ours);

    let mut restored = false;
    if action == RestoreAction::Restore {
        if let Some(previous) = backup.as_ref() {
            restored = clipboard_set_text(previous);
        }
    }

    // 剪贴板**原本就是空的**（没有东西可还）→ 把状态还原成"空"，
    // 而不是把我们写进去的那段片段永久留在里面。
    //
    // 只有粘贴**成功**时才清：失败路径上那段文本是留给用户手动 Ctrl+V 的
    // （提示里明说了），清掉就等于把提示又变成假话。
    //
    // 带「敏感」标记的片段尤其需要这条 —— 否则它就一直躺在剪贴板里，
    // 下一个 Ctrl+V 就粘出来了。
    if ok && backup.is_none() && !had_unbacked && !had_richer {
        clipboard_clear();
    }

    if decide_original_lost(
        ok,
        backup.is_some(),
        had_unbacked,
        had_richer,
        still_ours,
        restored,
    ) {
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

    /// 这次要不要跑"碰真实剪贴板"的测试 —— 由 `#[ignore]` 决定，不再看环境变量。
    ///
    /// 原来这里有个 `FUGUANG_SKIP_CLIPBOARD_TESTS` 开关，配合"剪贴板里是图片就跳过"。
    /// 那个设计有个致命问题：**跳过的测试仍然显示为 `ok`**，而 libtest 对**通过**的
    /// 测试会捕获 stderr，那句 `eprintln!("已跳过")` 根本看不到 —— 实测
    /// `105 passed` 里有两条一行断言都没执行（全绿但没测）。
    ///
    /// 改成 `#[ignore]` 之后，libtest 会把它们报成 `ignored`（**看得见**），
    /// 想跑就 `cargo test -- --ignored`。
    ///
    /// 真正决定"该不该还原"的逻辑已经拆成 `decide_restore` /
    /// `decide_original_lost` 两个纯函数，由 `收尾决策穷举` 在**任何机器上**
    /// 都真跑 —— 这两条碰真实剪贴板的测试只负责验证 Win32 那一层能对上。
    fn backup_for_clipboard_test() -> Option<String> {
        clipboard_get_text()
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
    #[ignore = "要碰真实剪贴板（会覆盖它）：cargo test -- --ignored 才会跑"]
    fn 写完剪贴板之后判据必须认得自己写的内容() {
        let _guard = CLIPBOARD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        const MARK: &str = "浮光剪贴板自检-7f3a";

        let saved = backup_for_clipboard_test();
        if !clipboard_set_text(MARK) {
            // 拿不到剪贴板会话就**明确失败**，不要静默 return：
            // 静默 return 会让这条测试以 `ok` 出现却零断言（libtest 还会吞掉 stderr）。
            // 现在它默认显示为 ignored（可见），真跑起来时拿不到剪贴板就是环境问题，该红。
            panic!("没有可用的剪贴板会话，无法执行这条测试");
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
    #[ignore = "要碰真实剪贴板（会覆盖它）：cargo test -- --ignored 才会跑"]
    fn 没有目标窗口时不还原剪贴板_文本要留给用户手动粘贴() {
        let _guard = CLIPBOARD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        const ORIGINAL: &str = "浮光测试-原来的剪贴板内容-4b1e";
        const PAYLOAD: &str = "浮光测试-要粘贴的内容-9c2d";

        let saved = backup_for_clipboard_test();
        if !clipboard_set_text(ORIGINAL) {
            panic!("没有可用的剪贴板会话，无法执行这条测试");
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

    /// 收尾决策的**穷举表**。
    ///
    /// 这一段连续错了两次（判据恒为假 → 剪贴板永不还原；不看 `ok` →
    /// "手动 Ctrl+V"的提示是假的），而它原来只能靠"改真实剪贴板 + 跑 cargo test"
    /// 验证 —— 那个测试还会在剪贴板里是图片时静默跳过。
    /// 拆成纯函数之后，这里把每种组合都钉死，**任何机器上都真跑**（CI 也一样）。
    #[test]
    fn 收尾决策穷举() {
        struct Case {
            ok: bool,
            had_backup: bool,
            had_unbacked: bool,
            had_richer: bool,
            still_ours: Option<bool>,
            restored: bool,
            action: RestoreAction,
            lost: bool,
            why: &'static str,
        }

        let cases = [
            // —— 粘贴成功 ——
            Case { ok: true, had_backup: true, had_unbacked: false, had_richer: false, still_ours: Some(true), restored: true, action: RestoreAction::Restore, lost: false,
                why: "普通文本：还回去，什么都没丢" },
            Case { ok: true, had_backup: true, had_unbacked: false, had_richer: false, still_ours: Some(true), restored: false, action: RestoreAction::Restore, lost: true,
                why: "想还但写入失败 → 原文没了" },
            Case { ok: true, had_backup: true, had_unbacked: false, had_richer: true, still_ours: Some(true), restored: true, action: RestoreAction::Restore, lost: true,
                why: "文本+HTML/RTF：文本还回去了，但富文本格式已被 EmptyClipboard 销毁" },
            Case { ok: true, had_backup: false, had_unbacked: true, had_richer: true, still_ours: Some(true), restored: false, action: RestoreAction::Restore, lost: true,
                why: "原来只有图片：还不了" },
            Case { ok: true, had_backup: false, had_unbacked: false, had_richer: false, still_ours: Some(true), restored: false, action: RestoreAction::Restore, lost: false,
                why: "剪贴板原本是空的：没什么可丢" },
            Case { ok: true, had_backup: true, had_unbacked: false, had_richer: false, still_ours: Some(false), restored: false, action: RestoreAction::LeaveAlone, lost: true,
                why: "还原前被目标程序改写了 → 不覆盖它，但原文没了" },
            Case { ok: true, had_backup: true, had_unbacked: false, had_richer: false, still_ours: None, restored: false, action: RestoreAction::LeaveAlone, lost: true,
                why: "读不出来 → 保守不动，但原文没了" },
            // —— 粘贴失败：文本必须留在剪贴板里，用户才能手动 Ctrl+V ——
            Case { ok: false, had_backup: true, had_unbacked: false, had_richer: false, still_ours: None, restored: false, action: RestoreAction::KeepOurs, lost: true,
                why: "失败+原来有文本：故意不还原（否则提示是假的），原文丢了" },
            Case { ok: false, had_backup: false, had_unbacked: true, had_richer: true, still_ours: None, restored: false, action: RestoreAction::KeepOurs, lost: true,
                why: "失败+原来是图片：原文丢了" },
            Case { ok: false, had_backup: false, had_unbacked: false, had_richer: false, still_ours: None, restored: false, action: RestoreAction::KeepOurs, lost: false,
                why: "失败+剪贴板原本是空的：没什么可丢" },
        ];

        for (i, c) in cases.iter().enumerate() {
            assert_eq!(
                decide_restore(c.ok, c.still_ours),
                c.action,
                "第 {i} 条（{}）的收尾动作不对",
                c.why
            );
            assert_eq!(
                decide_original_lost(
                    c.ok,
                    c.had_backup,
                    c.had_unbacked,
                    c.had_richer,
                    c.still_ours,
                    c.restored,
                ),
                c.lost,
                "第 {i} 条（{}）的「原文是否丢失」不对",
                c.why
            );
        }
    }
}
