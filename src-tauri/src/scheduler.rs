//! 后台调度线程：负责"到点了就弹窗"。
//!
//! # 为什么必须放在 Rust 侧
//!
//! 面板窗口平时是隐藏的。隐藏的 WebView 里 `setInterval` 会被系统降频
//! （Chromium 对后台页面的定时器有节流），倒计时会变慢、提醒会漏。
//! 所以权威时钟必须放在原生线程里，前端只负责显示和编辑。
//!
//! # 时间语义
//!
//! 只做 `now >= 目标时刻` 的大小比较，不做任何日期运算（原因见 [`crate::models`]）。
//! 重复提醒的"下一次时刻"由前端算好后写回来。

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::models::{now_ms, PendingAlert, PomodoroPhase, TimerKind};
use crate::state::{self, Store};
use crate::windows;

/// 轮询间隔。
///
/// 取 500ms 而不是 1s：提醒最多晚半秒，肉眼无感，
/// 但能避免"刚好卡在整秒边界"导致提醒晚 1 秒的观感问题。
const TICK: Duration = Duration::from_millis(500);

/// 汇总提醒里最多列出多少条，超出只报数量，避免弹窗被撑爆。
const MAX_LISTED: usize = 8;

/// 启动调度线程。需要在 `setup` 阶段调用一次。
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        // 第一次 tick 单独处理：把所有"已经过期"的项目汇总成一条提醒，
        // 而不是逐个弹窗。这就是设计里说的「开机后汇总补发错过的提醒」。
        thread::sleep(TICK);
        run_first_tick(&app);

        loop {
            thread::sleep(TICK);
            run_tick(&app);
        }
    });
}

/// 第一次 tick：汇总补发错过的提醒。
fn run_first_tick(app: &AppHandle) {
    let (alerts, changed_timers, changed_memos) = {
        let store = app.state::<Store>();
        let mut st = store.lock();
        let now = now_ms();

        let mut alerts = Vec::new();

        // 过期的计时器：说明软件关着的时候它已经走完了
        for t in st.timers.iter_mut() {
            if t.fired {
                continue;
            }
            if let Some(ends) = t.ends_at {
                if now >= ends && matches!(t.kind, TimerKind::Countdown) {
                    t.fired = true;
                    t.ends_at = None;
                    t.remaining_ms = Some(0);
                    alerts.push(PendingAlert {
                        source: "timer".into(),
                        id: t.id.clone(),
                        title: t.name.clone(),
                        body: "倒计时已完成".into(),
                        due_at: ends,
                    });
                }
            }
        }

        // 过期的备忘录提醒
        for m in st.memos.iter_mut() {
            if let Some(at) = m.remind_at {
                if now >= at && m.fired_for != Some(at) {
                    m.fired_for = Some(at);
                    alerts.push(PendingAlert {
                        source: "memo".into(),
                        id: m.id.clone(),
                        title: m.title.clone(),
                        body: summarize_body(&m.body),
                        due_at: at,
                    });
                }
            }
        }

        alerts.sort_by_key(|a| a.due_at);
        let ct = alerts.iter().any(|a| a.source == "timer");
        let cm = alerts.iter().any(|a| a.source == "memo");
        (alerts, ct, cm)
    };

    if alerts.is_empty() {
        return;
    }

    persist(app, changed_timers, changed_memos);
    notify_frontend(app, changed_timers, changed_memos);

    // 汇总成一条，按时间排序
    let (title, body) = if alerts.len() == 1 {
        let a = &alerts[0];
        (a.title.clone(), a.body.clone())
    } else {
        let mut lines: Vec<String> = alerts
            .iter()
            .take(MAX_LISTED)
            .map(|a| format!("· {} —— {}", a.title, a.body))
            .collect();
        if alerts.len() > MAX_LISTED {
            lines.push(format!("…… 还有 {} 条", alerts.len() - MAX_LISTED));
        }
        (
            format!("你错过了 {} 条提醒", alerts.len()),
            lines.join("\n"),
        )
    };

    let _ = windows::show_alert(app, &title, &body);
}

/// 常规 tick：检查到点的计时器与提醒。
fn run_tick(app: &AppHandle) {
    let (alerts, changed_timers, changed_memos) = {
        let store = app.state::<Store>();
        let mut st = store.lock();
        let now = now_ms();

        let mut alerts: Vec<PendingAlert> = Vec::new();
        let mut changed_timers = false;
        let mut changed_memos = false;

        for t in st.timers.iter_mut() {
            let Some(ends) = t.ends_at else { continue };
            if now < ends || t.fired {
                continue;
            }

            match t.kind {
                TimerKind::Countdown => {
                    t.fired = true;
                    t.ends_at = None;
                    t.remaining_ms = Some(0);
                    changed_timers = true;
                    alerts.push(PendingAlert {
                        source: "timer".into(),
                        id: t.id.clone(),
                        title: t.name.clone(),
                        body: "倒计时已完成".into(),
                        due_at: ends,
                    });
                }
                TimerKind::Pomodoro => {
                    // 阶段切换：专注结束进入休息，休息结束进入专注。
                    // 立刻为下一个阶段设好结束时刻并清掉 fired，
                    // 这样番茄钟能自己一直循环下去。
                    let focus_ms = (t.focus_minutes as i64) * 60_000;
                    let break_ms = (t.break_minutes as i64) * 60_000;

                    let (next_phase, next_len, body) = match t.phase {
                        Some(PomodoroPhase::Break) => (
                            PomodoroPhase::Focus,
                            focus_ms,
                            format!("休息结束，开始专注 {} 分钟", t.focus_minutes),
                        ),
                        _ => {
                            t.rounds += 1;
                            (
                                PomodoroPhase::Break,
                                break_ms,
                                format!(
                                    "专注结束，休息 {} 分钟（已完成 {} 轮）",
                                    t.break_minutes, t.rounds
                                ),
                            )
                        }
                    };

                    t.phase = Some(next_phase);
                    t.ends_at = Some(now + next_len);
                    t.fired = false;
                    changed_timers = true;

                    alerts.push(PendingAlert {
                        source: "timer".into(),
                        id: t.id.clone(),
                        title: t.name.clone(),
                        body,
                        due_at: ends,
                    });
                }
                // 秒表是正向计时，没有"到点"这回事
                TimerKind::Stopwatch => {}
            }
        }

        for m in st.memos.iter_mut() {
            let Some(at) = m.remind_at else { continue };
            if now < at || m.fired_for == Some(at) {
                continue;
            }
            m.fired_for = Some(at);
            changed_memos = true;
            alerts.push(PendingAlert {
                source: "memo".into(),
                id: m.id.clone(),
                title: m.title.clone(),
                body: summarize_body(&m.body),
                due_at: at,
            });
        }

        (alerts, changed_timers, changed_memos)
    };

    if alerts.is_empty() {
        return;
    }

    persist(app, changed_timers, changed_memos);
    notify_frontend(app, changed_timers, changed_memos);

    if alerts.len() == 1 {
        let a = &alerts[0];
        let _ = windows::show_alert(app, &a.title, &a.body);
    } else {
        let lines: Vec<String> = alerts
            .iter()
            .map(|a| format!("· {} —— {}", a.title, a.body))
            .collect();
        let _ = windows::show_alert(app, &format!("{} 条提醒", alerts.len()), &lines.join("\n"));
    }
}

/// 落盘被修改的集合。
fn persist(app: &AppHandle, timers: bool, memos: bool) {
    let store = app.state::<Store>();
    if timers {
        let list = store.lock().timers.clone();
        if let Err(e) = state::save_timers(app, &list) {
            eprintln!("[浮光] 保存计时器失败：{e}");
        }
    }
    if memos {
        let list = store.lock().memos.clone();
        if let Err(e) = state::save_memos(app, &list) {
            eprintln!("[浮光] 保存备忘录失败：{e}");
        }
    }
}

/// 通知前端刷新。
///
/// 前端可能正在显示计时器列表，需要立刻反映"已完成""已进入休息阶段"等变化。
/// 前端没在监听也不影响，事件会被丢弃。
fn notify_frontend(app: &AppHandle, timers: bool, memos: bool) {
    let mut what: Vec<&str> = Vec::new();
    if timers {
        what.push("timers");
    }
    if memos {
        what.push("memos");
    }
    let _ = app.emit("state-changed", serde_json::json!({ "what": what }));
}

/// 把备忘正文压成一行摘要，用于弹窗。
fn summarize_body(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 120 {
        format!("{}…", flat.chars().take(120).collect::<String>())
    } else if flat.is_empty() {
        "（无内容）".into()
    } else {
        flat
    }
}
