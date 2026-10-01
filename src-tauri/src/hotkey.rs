//! 全局热键：不点小球也能唤出主面板。
//!
//! # 为什么自己实现而不是用官方插件
//!
//! `tauri-plugin-global-shortcut` 会引入一个运行时依赖，而浮光对发布体积敏感
//! （现在整包 1.32 MB）。这里需要的能力很窄——注册一个组合键、收到就切面板——
//! 用已有的 `windows-sys` 直接调 `RegisterHotKey` 只有两百来行。
//!
//! # 为什么必须单独开一个线程
//!
//! `RegisterHotKey(NULL, ...)` 把热键绑到**调用线程的消息队列**上，
//! `WM_HOTKEY` 会投递到那个队列。而 Tauri 的命令跑在异步运行时的工作线程上，
//! 那些线程不泵消息，注册了也永远收不到。
//!
//! 所以这里开一个专属线程：它负责注册、也负责跑消息循环。
//! 换热键时通过 `PostThreadMessageW` 把它从 `GetMessageW` 的阻塞里唤醒，
//! 让它自己去做注销与重注册（注册必须在同一个线程上完成）。

#![cfg(windows)]

use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY,
};

/// 热键标识。同一个线程内唯一即可，取 "FU" 的 ASCII。
const HOTKEY_ID: i32 = 0x4655;

/// 自定义线程消息：有新的注册请求待处理。
const MSG_APPLY: u32 = WM_APP + 1;

/// 等待注册结果的超时。
///
/// 不能无限等：万一消息循环线程出问题，命令会永远挂住，
/// 设置页那个开关就卡死在转圈状态。
const APPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// 补注册的检查间隔。
///
/// 30 秒是权衡：占用者退出后用户最多多等半分钟，而检查本身只是读一次内存里的
/// 设置 + 一个 `Option` 判断，开销可以忽略。
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);

/// 一个解析好的热键组合。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    /// `MOD_*` 的按位或。
    pub modifiers: u32,
    /// 虚拟键码。
    pub vk: u32,
    /// 规范化后的显示文本，例如 `Ctrl+Shift+Space`。
    pub label: String,
}

/// 一次待处理的注册请求。
struct Request {
    /// `None` 表示取消注册。
    combo: Option<Combo>,
    /// 把结果回传给发起方。
    reply: mpsc::Sender<Result<(), String>>,
}

/// 当前**实际注册成功**的组合。用于设置页显示真实状态，也用于换键失败时回滚。
///
/// 存整个 `Combo` 而不是只存显示文本：换键要先注销旧的、再注册新的，
/// 而新键可能注册失败（被别的程序占用）—— 那时必须能把旧键**原样注册回去**，
/// 注册需要的是 modifiers + vk，光有 "Ctrl+Shift+Space" 这个字符串不够。
static CURRENT: OnceLock<Mutex<Option<Combo>>> = OnceLock::new();
/// 待处理请求队列。
static PENDING: OnceLock<Mutex<Vec<Request>>> = OnceLock::new();
/// 消息循环线程 id，用于唤醒它。
static THREAD_ID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

fn current_slot() -> &'static Mutex<Option<Combo>> {
    CURRENT.get_or_init(|| Mutex::new(None))
}
fn pending_slot() -> &'static Mutex<Vec<Request>> {
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}
fn thread_id_slot() -> &'static Mutex<Option<u32>> {
    THREAD_ID.get_or_init(|| Mutex::new(None))
}

/// 启动热键线程。需要在 `setup` 阶段调用一次。
pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<u32>();

    thread::spawn(move || {
        let tid = unsafe { GetCurrentThreadId() };

        // ⚠️ **先把消息队列建出来，再把 tid 报回去。**
        //
        // `PostThreadMessageW` 对"还没有消息队列"的线程会**失败**（返回 0），
        // 而线程的消息队列是**第一次调用消息函数时才创建**的。
        // 原来这里是直接 `tx.send(tid)` 就进循环 —— 于是 `start()` 一拿到 tid
        // 就可能有别的线程来 `PostThreadMessageW`，撞上"队列还没建"：
        // `apply` 报"无法通知热键服务"，**整个会话都没有热键**。
        //
        // 实测抓到过（`app.log` 里就这一条，而热键确实没注册上）。
        // `PeekMessageW(..., PM_NOREMOVE)` 不取走任何消息，只负责把队列建出来。
        let mut msg = MSG::default();
        unsafe { PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE) };

        // 把线程 id 交回去，之后别的线程才能 PostThreadMessageW 唤醒我们
        let _ = tx.send(tid);

        loop {
            // 阻塞等待消息。第三个参数为 0 表示不过滤，线程消息也能收到。
            let ret = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
            if ret <= 0 {
                // 0 = WM_QUIT，-1 = 出错。两种情况都结束循环。
                break;
            }
            match msg.message {
                WM_HOTKEY => {
                    // 切面板会创建窗口，必须另开线程（见 windows::spawn_toggle_panel）
                    crate::windows::spawn_toggle_panel(&app);
                }
                MSG_APPLY => process_requests(),
                _ => {}
            }
        }
    });

    // 等线程把自己的 id 报上来。拿不到 id 就没法换热键，
    // 但已经注册的默认热键仍然能用，所以这里只是记录失败。
    match rx.recv_timeout(APPLY_TIMEOUT) {
        Ok(tid) => *thread_id_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(tid),
        Err(e) => crate::diag!("[浮光] 热键线程启动异常：{e}"),
    }
}

/// 处理队列里的注册请求。**只在热键线程上调用。**
fn process_requests() {
    let requests: Vec<Request> = {
        let mut q = pending_slot().lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *q)
    };

    for req in requests {
        let result = match &req.combo {
            Some(combo) => register(combo),
            None => unregister(),
        };
        let _ = req.reply.send(result);
    }
}

/// 注册一个热键。**只在热键线程上调用。**
fn register(combo: &Combo) -> Result<(), String> {
    // 先记下当前生效的，换键失败时要把它恢复回去
    let previous = current_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    // 先注销旧的。失败也无所谓——可能本来就没注册。
    unsafe { UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID) };

    // MOD_NOREPEAT 很关键：不加的话按住组合键会连续触发，
    // 面板会以键盘重复速率疯狂开合。
    let ok = unsafe {
        RegisterHotKey(
            std::ptr::null_mut(),
            HOTKEY_ID,
            combo.modifiers | MOD_NOREPEAT,
            combo.vk,
        )
    };

    if ok == 0 {
        // 新键没注册上，**必须把旧键恢复回去**。
        //
        // 不恢复的后果很隐蔽：用户只是"换一个试试"，新键被占用注册失败，
        // 原来能用的热键却已经被注销了 —— 而他不知道，会以为热键还开着、
        // 一直按一直没反应。设置文件里还写着旧组合，所以重启后又会"看起来配了"。
        let restored = previous
            .as_ref()
            .map(|prev| unsafe {
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_ID,
                    prev.modifiers | MOD_NOREPEAT,
                    prev.vk,
                ) != 0
            })
            .unwrap_or(false);

        let restored_label = if restored {
            previous.as_ref().map(|p| p.label.clone())
        } else {
            None
        };
        *current_slot().lock().unwrap_or_else(|e| e.into_inner()) = if restored {
            previous
        } else {
            None
        };

        return Err(match restored_label {
            Some(label) => format!(
                "「{}」注册失败，可能已被其他程序占用，或属于系统保留的组合。已恢复原来的「{label}」。",
                combo.label
            ),
            None => format!(
                "「{}」注册失败，可能已被其他程序占用，或属于系统保留的组合。换一个试试。",
                combo.label
            ),
        });
    }

    *current_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(combo.clone());
    Ok(())
}

/// 注销当前热键。**只在热键线程上调用。**
fn unregister() -> Result<(), String> {
    unsafe { UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID) };
    *current_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

/// 应用热键设置。
///
/// `spec` 为 `None` 表示关闭热键。
/// 返回 `Err` 表示注册失败（组合键冲突），调用方必须把失败告诉用户，
/// 不能静默失效——否则用户会以为热键开着，然后一直按一直没反应。
pub fn apply(spec: Option<&str>) -> Result<(), String> {
    let combo = match spec {
        Some(s) => Some(parse(s)?),
        None => None,
    };

    let tid = {
        let guard = thread_id_slot().lock().unwrap_or_else(|e| e.into_inner());
        *guard
    };
    let Some(tid) = tid else {
        return Err("热键服务未就绪，请重启浮光后再试".into());
    };

    let (tx, rx) = mpsc::channel();
    pending_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(Request { combo, reply: tx });

    // 唤醒消息循环线程。它此刻正阻塞在 GetMessageW 上。
    let posted = unsafe { PostThreadMessageW(tid, MSG_APPLY, 0, 0) };
    if posted == 0 {
        return Err("无法通知热键服务，请重启浮光后再试".into());
    }

    match rx.recv_timeout(APPLY_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err("热键服务没有响应，请重启浮光后再试".into()),
    }
}

/// 起一个后台线程：热键**没注册成功**时定期自动补注册。
///
/// # 为什么需要它
///
/// 启动时只尝试一次 —— 重试几次没有意义（占用者不会因为等一两秒就让开），
/// 但那一次失败就意味着**整个会话都没有热键**：占用它的程序退出之后也不会
/// 自动补上，用户只能自己去设置页重新应用一次。实测过：占用者一消失，
/// 下一次注册**立刻**就能成功（0ms），所以"过一会儿再试"是有效的。
///
/// 只在"设置里要开、实际却没注册上"时才重试；成功之后就安静了。
pub fn start_watchdog(app: AppHandle) {
    thread::spawn(move || {
        // 避免每 30 秒刷一行日志；状态变化（成功/关掉）时重置
        let mut logged = false;
        loop {
            thread::sleep(WATCHDOG_INTERVAL);

            let (enabled, combo) = {
                let store = app.state::<crate::state::Store>();
                let st = store.lock();
                (st.settings.hotkey_enabled, st.settings.hotkey.clone())
            };
            if !enabled {
                logged = false;
                continue;
            }

            let already = current_slot()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some();
            if already {
                logged = false;
                continue;
            }

            match apply(Some(&combo)) {
                Ok(()) => {
                    // 用位置参数而不是 `{combo}`：内联捕获在这里会被当成按值传 `str`
                    crate::diag!("[浮光] 全局热键「{}」补注册成功", combo);
                    logged = false;
                }
                Err(err) => {
                    if !logged {
                        crate::diag!(
                            "[浮光] 全局热键「{}」仍未注册成功，会继续定期重试：{}",
                            combo,
                            err
                        );
                        logged = true;
                    }
                }
            }
        }
    });
}

/// 取当前实际生效的热键文本。没注册成功时返回 `None`。
pub fn current() -> Option<String> {
    current_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|c| c.label.clone())
}

// ===============================================================
// 解析
// ===============================================================

/// 把 `"Ctrl+Shift+Space"` 这样的文本解析成组合键。
///
/// 大小写不敏感；修饰键顺序随意；显示文本会被规范化。
///
/// 要求至少有一个修饰键：不带修饰键的热键会把普通打字吞掉，
/// 是几乎所有人都不想要的行为，这里直接拒绝。
pub fn parse(spec: &str) -> Result<Combo, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("热键不能为空".into());
    }

    let parts: Vec<&str> = trimmed.split('+').map(|p| p.trim()).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err(format!("热键格式不对：{spec}"));
    }

    let mut modifiers: u32 = 0;
    let mut names: Vec<&'static str> = Vec::new();
    let mut key: Option<u32> = None;

    for (index, part) in parts.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        let is_last = index == parts.len() - 1;

        // 修饰键
        let modifier = match lower.as_str() {
            "ctrl" | "control" => Some((MOD_CONTROL, "Ctrl")),
            "alt" => Some((MOD_ALT, "Alt")),
            "shift" => Some((MOD_SHIFT, "Shift")),
            "win" | "super" | "meta" | "cmd" => Some((MOD_WIN, "Win")),
            _ => None,
        };

        if let Some((flag, label)) = modifier {
            // 修饰键写在最后是常见笔误，明确报错比静默当成按键好
            if is_last {
                return Err(format!("「{part}」是修饰键，热键最后必须是一个普通按键"));
            }
            modifiers |= flag;
            if !names.contains(&label) {
                names.push(label);
            }
            continue;
        }

        // 普通按键只能出现一次
        if key.is_some() {
            return Err(format!("热键里只能有一个普通按键：{spec}"));
        }
        key = Some(virtual_key(part).ok_or_else(|| format!("不认识的按键「{part}」"))?);
    }

    let Some(vk) = key else {
        return Err(format!("热键缺少普通按键：{spec}"));
    };
    if modifiers == 0 {
        return Err("热键至少要包含一个修饰键（Ctrl / Alt / Shift / Win），否则会吞掉正常打字".into());
    }

    // 规范化显示文本：修饰键按固定顺序排，按键用大写
    let mut ordered: Vec<&str> = Vec::new();
    for want in ["Ctrl", "Alt", "Shift", "Win"] {
        if names.contains(&want) {
            ordered.push(want);
        }
    }
    let key_label = parts.last().map(|p| p.trim()).unwrap_or("");
    let normalized_key = if key_label.len() == 1 {
        key_label.to_ascii_uppercase()
    } else {
        // 按键名统一成首字母大写的规范写法
        canonical_key_name(key_label)
    };

    Ok(Combo {
        modifiers,
        vk,
        label: format!("{}+{}", ordered.join("+"), normalized_key),
    })
}

/// 按键名 → 虚拟键码。
fn virtual_key(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();

    // 单个字母或数字：虚拟键码就等于 ASCII 大写值
    if lower.len() == 1 {
        let ch = lower.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_uppercase() as u32);
        }
        if ch.is_ascii_digit() {
            return Some(ch as u32);
        }
    }

    // F1..F24
    if let Some(num) = lower.strip_prefix('f') {
        if let Ok(n) = num.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + (n - 1));
            }
            return None;
        }
    }

    Some(match lower.as_str() {
        "space" | "空格" => 0x20,
        "enter" | "return" | "回车" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        ";" => 0xBA,
        "=" => 0xBB,
        "," => 0xBC,
        "-" => 0xBD,
        "." => 0xBE,
        "/" => 0xBF,
        "`" => 0xC0,
        "[" => 0xDB,
        "\\" => 0xDC,
        "]" => 0xDD,
        "'" => 0xDE,
        _ => return None,
    })
}

/// 把按键名规范成好看的首字母大写形式。
fn canonical_key_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "space" => "Space".into(),
        "enter" | "return" => "Enter".into(),
        "tab" => "Tab".into(),
        "esc" | "escape" => "Esc".into(),
        "backspace" => "Backspace".into(),
        "delete" | "del" => "Delete".into(),
        "insert" | "ins" => "Insert".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" | "pgup" => "PageUp".into(),
        "pagedown" | "pgdn" => "PageDown".into(),
        "up" => "Up".into(),
        "down" => "Down".into(),
        "left" => "Left".into(),
        "right" => "Right".into(),
        other => {
            // F1..F24
            if let Some(num) = other.strip_prefix('f') {
                if let Ok(n) = num.parse::<u32>() {
                    return format!("F{n}");
                }
            }
            other.to_string()
        }
    }
}

// ===============================================================
// 测试
//
// 解析是纯逻辑，而且是用户唯一能直接接触到"出错"的地方：
// 解析错了会导致热键注册到意想不到的组合上，或者干脆注册失败。
// ===============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析默认组合() {
        let c = parse("Ctrl+Shift+Space").expect("应能解析");
        assert_eq!(c.modifiers, MOD_CONTROL | MOD_SHIFT);
        assert_eq!(c.vk, 0x20);
        assert_eq!(c.label, "Ctrl+Shift+Space");
    }

    #[test]
    fn 大小写不敏感且顺序随意() {
        let a = parse("ctrl+shift+a").expect("应能解析");
        let b = parse("SHIFT+CTRL+A").expect("应能解析");
        assert_eq!(a, b);
        assert_eq!(a.label, "Ctrl+Shift+A");
    }

    #[test]
    fn 修饰键在显示时按固定顺序排列() {
        // 用户怎么写都行，但显示要统一，否则设置页里会显得很随意
        let c = parse("Shift+Alt+Ctrl+K").expect("应能解析");
        assert_eq!(c.label, "Ctrl+Alt+Shift+K");
    }

    #[test]
    fn 四个修饰键都能识别() {
        assert_eq!(parse("Ctrl+A").unwrap().modifiers, MOD_CONTROL);
        assert_eq!(parse("Alt+A").unwrap().modifiers, MOD_ALT);
        assert_eq!(parse("Shift+A").unwrap().modifiers, MOD_SHIFT);
        assert_eq!(parse("Win+A").unwrap().modifiers, MOD_WIN);
        // 常见的别名也要认
        assert_eq!(parse("Control+A").unwrap().modifiers, MOD_CONTROL);
        assert_eq!(parse("Meta+A").unwrap().modifiers, MOD_WIN);
        assert_eq!(parse("Super+A").unwrap().modifiers, MOD_WIN);
    }

    #[test]
    fn 功能键与特殊键() {
        assert_eq!(parse("Ctrl+F1").unwrap().vk, 0x70);
        assert_eq!(parse("Ctrl+F12").unwrap().vk, 0x7B);
        assert_eq!(parse("Ctrl+F24").unwrap().vk, 0x87);
        assert_eq!(parse("Ctrl+F12").unwrap().label, "Ctrl+F12");

        assert_eq!(parse("Ctrl+Enter").unwrap().vk, 0x0D);
        assert_eq!(parse("Ctrl+Return").unwrap().label, "Ctrl+Enter");
        assert_eq!(parse("Alt+Tab").unwrap().vk, 0x09);
        assert_eq!(parse("Ctrl+Esc").unwrap().label, "Ctrl+Esc");
        assert_eq!(parse("Ctrl+PageUp").unwrap().vk, 0x21);
        assert_eq!(parse("Ctrl+PgUp").unwrap().label, "Ctrl+PageUp");
        assert_eq!(parse("Ctrl+ArrowUp").is_err(), true, "未支持的别名应报错而不是猜");
        assert_eq!(parse("Ctrl+Up").unwrap().vk, 0x26);
    }

    #[test]
    fn 数字键() {
        assert_eq!(parse("Ctrl+1").unwrap().vk, 0x31);
        assert_eq!(parse("Ctrl+0").unwrap().label, "Ctrl+0");
    }

    #[test]
    fn 拒绝没有修饰键的组合() {
        // 这条很重要：不带修饰键的热键会把普通打字吞掉
        let err = parse("A").expect_err("应拒绝");
        assert!(err.contains("修饰键"), "错误信息应说明原因，实际：{err}");
        assert!(parse("F5").is_err());
        assert!(parse("Space").is_err());
    }

    #[test]
    fn 拒绝只有修饰键的组合() {
        assert!(parse("Ctrl").is_err());
        assert!(parse("Ctrl+Shift").is_err());
    }

    #[test]
    fn 拒绝空与畸形输入() {
        for bad in ["", "   ", "Ctrl+", "+A", "Ctrl++A", "Ctrl+A+B"] {
            assert!(parse(bad).is_err(), "应拒绝：{bad:?}");
        }
    }

    #[test]
    fn 拒绝不认识的按键() {
        let err = parse("Ctrl+香蕉").expect_err("应拒绝");
        assert!(err.contains("不认识"), "实际：{err}");
        assert!(parse("Ctrl+F25").is_err(), "F25 超出范围");
        assert!(parse("Ctrl+F0").is_err());
    }

    #[test]
    fn 错误信息里包含原始输入便于排查() {
        let err = parse("Ctrl+Shift+Nope").expect_err("应拒绝");
        assert!(err.contains("Nope"), "实际：{err}");
    }

    #[test]
    fn 解析结果能往返显示() {
        // 解析出的 label 再解析一次应该得到完全相同的结果，
        // 否则设置页显示的值和实际生效的值会对不上
        for spec in [
            "Ctrl+Shift+Space",
            "Ctrl+Alt+K",
            "Win+Shift+F5",
            "Ctrl+`",
            "Alt+[",
        ] {
            let first = parse(spec).expect("应能解析");
            let second = parse(&first.label).expect("规范化文本应能再解析");
            assert_eq!(first, second, "往返不一致：{spec}");
            assert_eq!(first.label, second.label);
        }
    }
}
