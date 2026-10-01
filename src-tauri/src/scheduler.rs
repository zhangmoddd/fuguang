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
//!
//! # 分层：纯逻辑 / IO
//!
//! 判定部分（[`evaluate`] 及其辅助函数）是**纯函数**：只接收数据切片与 `now`，
//! 不碰 `AppHandle`、不碰文件、不碰窗口。这样它们能被单元测试直接覆盖。
//!
//! 这一点很关键：这些判定的 bug 表现是"某天提醒没响"或"重复弹两次"，
//! 用户很难察觉、也很难复现。把它们做成纯函数是唯一能可靠测到的办法。
//!
//! IO 部分（读状态、落盘、弹窗、发事件）在 `run_*` 里，只负责把纯逻辑的结果
//! 搬出去，本身没有分支逻辑，出 bug 的空间小得多。

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::models::{now_ms, Memo, PendingAlert, PomodoroPhase, Timer, TimerKind};
use crate::state::{self, AppState, Store};
use crate::windows;

/// 轮询间隔。
///
/// 取 500ms 而不是 1s：提醒最多晚半秒，肉眼无感，
/// 但能避免"刚好卡在整秒边界"导致提醒晚 1 秒的观感问题。
const TICK: Duration = Duration::from_millis(500);

/// 汇总提醒里最多列出多少条，超出只报数量，避免弹窗被撑爆。
const MAX_LISTED: usize = 8;

// ===============================================================
// 纯逻辑
// ===============================================================

/// 一次判定的结果。
#[derive(Debug, Default)]
pub struct Evaluation {
    /// 本次需要弹出的提醒，按原定时刻升序。
    pub alerts: Vec<PendingAlert>,
    /// 计时器数据是否被改动（决定要不要落盘）。
    pub timers_changed: bool,
    /// 备忘录数据是否被改动。
    pub memos_changed: bool,
}

/// 判定所有计时器与备忘录。
///
/// 会**就地修改**传入的数据（标记已提醒、推进番茄钟阶段），
/// 因为"判定"和"更新状态"本质是同一件事：不可能只判定不更新，
/// 否则下一 tick 会重复弹同一条。
pub fn evaluate(timers: &mut [Timer], memos: &mut [Memo], now: i64) -> Evaluation {
    let mut out = Evaluation::default();

    evaluate_timers(timers, now, &mut out);
    evaluate_memos(memos, now, &mut out);

    // 按原定时刻排序，让用户看到的顺序符合直觉（先发生的先说）
    out.alerts.sort_by_key(|a| a.due_at);
    out
}

/// 判定计时器。
fn evaluate_timers(timers: &mut [Timer], now: i64, out: &mut Evaluation) {
    for t in timers.iter_mut() {
        // 没有结束时刻 = 没在跑（未开始 / 已暂停 / 秒表）
        let Some(ends) = t.ends_at else { continue };
        // 没到点，或这一轮已经提醒过
        if now < ends || t.fired {
            continue;
        }

        match t.kind {
            TimerKind::Countdown => {
                // 标记完成。`remaining_ms` 清 0 只是"这一轮跑完了"，
                // 用户当初设定的时长存在 `duration_ms` 里，重置时靠它恢复。
                t.fired = true;
                t.ends_at = None;
                t.remaining_ms = Some(0);
                out.timers_changed = true;

                out.alerts.push(PendingAlert {
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
                // 这样番茄钟能自己一直循环下去，不需要前端参与。
                // 下限 1 分钟，**不能省**。
                //
                // `focus_minutes` / `break_minutes` 在 Rust 侧没有任何校验，
                // 而 `timers.json` 是纯文本、用户能手动编辑，`#[serde(default)]`
                // 也只管字段缺失、管不了显式的 0。一旦是 0：
                //   `ends_at = now + 0` → 每个 tick（500ms）都判定"又到点了" →
                //   弹窗风暴 + 每 500ms 写一次盘 + `rounds` 无限膨胀。
                // 正常路径前端会拦住 0，但数据文件是可以被手改的。
                let focus_ms = (t.focus_minutes.max(1) as i64) * 60_000;
                let break_ms = (t.break_minutes.max(1) as i64) * 60_000;

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
                out.timers_changed = true;

                out.alerts.push(PendingAlert {
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
}

/// 判定备忘录提醒。
fn evaluate_memos(memos: &mut [Memo], now: i64, out: &mut Evaluation) {
    for m in memos.iter_mut() {
        let Some(at) = m.remind_at else { continue };
        // `fired_for` 是幂等标记：同一个提醒时刻只弹一次。
        //
        // 这个标记不可省。前端负责在弹窗后把 `remind_at` 推到下一次，
        // 但前端可能因为窗口被降频而慢半拍；没有这个标记的话，
        // 在它写回之前每 500ms 都会再弹一次，用户会被刷屏。
        if now < at || m.fired_for == Some(at) {
            continue;
        }

        m.fired_for = Some(at);
        out.memos_changed = true;

        out.alerts.push(PendingAlert {
            source: "memo".into(),
            id: m.id.clone(),
            title: m.title.clone(),
            body: summarize_body(&m.body),
            due_at: at,
        });
    }
}

/// 把提醒列表拼成弹窗要显示的标题与正文。
///
/// 只有一条时直接显示它本身（用户最关心"是什么事"）；
/// 多条时用 `multi_title` 生成汇总标题，正文逐条列出。
///
/// `multi_title` 是个闭包而不是模板字符串：条数只有在这里才知道，
/// 让调用方拿到 `n` 自己决定措辞，比在字符串里塞占位符再替换干净得多。
/// 开机补发时传「你错过了 N 条提醒」，运行时同时到点则传中性的「N 条提醒」。
pub fn compose_alert(
    alerts: &[PendingAlert],
    multi_title: impl Fn(usize) -> String,
) -> Option<(String, String)> {
    match alerts.len() {
        0 => None,
        1 => Some((alerts[0].title.clone(), alerts[0].body.clone())),
        n => {
            let mut lines: Vec<String> = alerts
                .iter()
                .take(MAX_LISTED)
                .map(|a| format!("· {} —— {}", a.title, a.body))
                .collect();
            if n > MAX_LISTED {
                lines.push(format!("…… 还有 {} 条", n - MAX_LISTED));
            }
            Some((multi_title(n), lines.join("\n")))
        }
    }
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

// ===============================================================
// 线程与 IO
// ===============================================================

/// 启动调度线程。需要在 `setup` 阶段调用一次。
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        // 第一次 tick 单独处理：把所有"已经过期"的项目**汇总成一条**提醒，
        // 而不是逐个弹窗。这就是设计里说的「开机后汇总补发错过的提醒」。
        thread::sleep(TICK);
        run(&app, true);

        loop {
            thread::sleep(TICK);
            run(&app, false);
        }
    });
}

/// 跑一次判定并把结果搬出去。
///
/// `first` 为真表示这是开机后的第一次，措辞用"你错过了"。
fn run(app: &AppHandle, first: bool) {
    let (alerts, timers_changed, memos_changed) = {
        let store = app.state::<Store>();
        let mut st = store.lock();

        // 先解构出两个字段的不相交可变借用。
        //
        // 不能直接写 `evaluate(&mut st.timers, &mut st.memos, ...)`：
        // `st` 是 MutexGuard，`st.timers` 会经 DerefMut 借走整个 guard，
        // 于是第二次取 `st.memos` 就变成重复可变借用，编译不过。
        let AppState { timers, memos, .. } = &mut *st;

        let result = evaluate(timers, memos, now_ms());
        (result.alerts, result.timers_changed, result.memos_changed)
    };

    if alerts.is_empty() {
        return;
    }

    persist(app, timers_changed, memos_changed);
    notify_frontend(app, timers_changed, memos_changed);

    let multi_title = |n: usize| {
        if first {
            format!("你错过了 {n} 条提醒")
        } else {
            format!("{n} 条提醒")
        }
    };

    if let Some((title, body)) = compose_alert(&alerts, multi_title) {
        let _ = windows::show_alert(app, &title, &body);
    }
}

/// 落盘被修改的集合。
fn persist(app: &AppHandle, timers: bool, memos: bool) {
    let store = app.state::<Store>();
    // 走 `state::persist` 而不是自己 clone 再 save：快照必须在写锁内取。
    // 自己先 clone 的话，手里这份是**调用时刻**的旧快照，
    // 落盘时会把并发命令刚写进去的新数据整份盖回去
    // （已复现：编辑被回滚、删掉的计时器复活）。
    if timers {
        if let Err(e) = state::persist(app, || store.lock().timers.clone(), state::save_timers) {
            eprintln!("[浮光] 保存计时器失败：{e}");
        }
    }
    if memos {
        if let Err(e) = state::persist(app, || store.lock().memos.clone(), state::save_memos) {
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

// ===============================================================
// 测试
//
// 这一组测试针对的是"错了也不会立刻发现"的逻辑：
// 提醒漏弹、重复弹、番茄钟阶段错乱。
// 这些问题的共同特点是用户很难察觉、更难复现，所以必须靠测试兜住。
// ===============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Repeat;

    /// 基准时刻。用固定值而不是 `now_ms()`，
    /// 否则测试会随运行时间漂移，边界断言变得不可靠。
    const NOW: i64 = 1_800_000_000_000;

    fn timer(id: &str, kind: TimerKind, ends_at: Option<i64>) -> Timer {
        Timer {
            id: id.into(),
            name: format!("计时器-{id}"),
            kind,
            ends_at,
            remaining_ms: None,
            duration_ms: Some(60_000),
            phase: None,
            focus_minutes: 25,
            break_minutes: 5,
            rounds: 0,
            elapsed_ms: 0,
            running_since: None,
            laps: Vec::new(),
            fired: false,
            folder_id: None,
            created_at: 0,
        }
    }

    fn memo(id: &str, remind_at: Option<i64>) -> Memo {
        Memo {
            id: id.into(),
            date: "2026-09-19".into(),
            title: format!("备忘-{id}"),
            body: "正文内容".into(),
            tags: Vec::new(),
            remind_at,
            repeat: Repeat::None,
            fired_for: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    // ---------- 倒计时 ----------

    #[test]
    fn 倒计时未到点不触发() {
        let mut timers = vec![timer("a", TimerKind::Countdown, Some(NOW + 1))];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert!(result.alerts.is_empty(), "还差 1 毫秒，不该触发");
        assert!(!result.timers_changed);
        assert!(!timers[0].fired);
    }

    #[test]
    fn 倒计时到点触发并标记完成() {
        let mut timers = vec![timer("a", TimerKind::Countdown, Some(NOW))];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 1);
        assert_eq!(result.alerts[0].source, "timer");
        assert_eq!(result.alerts[0].due_at, NOW);
        assert!(result.timers_changed);

        // 结束后必须清掉 ends_at，否则下一 tick 会再次判定为"到点"
        assert_eq!(timers[0].ends_at, None);
        assert_eq!(timers[0].remaining_ms, Some(0));
        assert!(timers[0].fired);
    }

    #[test]
    fn 倒计时已提醒过不会重复弹() {
        let mut t = timer("a", TimerKind::Countdown, Some(NOW));
        t.fired = true;
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW + 10_000);

        assert!(result.alerts.is_empty(), "fired 为真时不该再弹");
        assert!(!result.timers_changed);
    }

    #[test]
    fn 暂停中的倒计时不触发() {
        // 暂停的语义就是 ends_at = None + remaining_ms 有值
        let mut t = timer("a", TimerKind::Countdown, None);
        t.remaining_ms = Some(30_000);
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW + 999_999);

        assert!(result.alerts.is_empty());
        assert_eq!(timers[0].remaining_ms, Some(30_000), "暂停状态不该被判定逻辑改动");
    }

    #[test]
    fn 秒表永远不触发() {
        // 秒表是正向计时。即便因为数据被手动改坏而带上 ends_at，也不该弹窗。
        let mut t = timer("a", TimerKind::Stopwatch, Some(NOW));
        t.running_since = Some(NOW - 5_000);
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW + 100_000);

        assert!(result.alerts.is_empty(), "秒表没有到点这回事");
        assert!(!result.timers_changed);
    }

    // ---------- 番茄钟 ----------

    #[test]
    fn 番茄钟专注结束进入休息() {
        let mut t = timer("p", TimerKind::Pomodoro, Some(NOW));
        t.phase = Some(PomodoroPhase::Focus);
        t.focus_minutes = 25;
        t.break_minutes = 5;
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 1);
        assert_eq!(timers[0].phase, Some(PomodoroPhase::Break));
        assert_eq!(timers[0].rounds, 1, "完成一轮专注后轮数 +1");
        // 下一阶段必须立刻排好，番茄钟才能自己循环下去
        assert_eq!(timers[0].ends_at, Some(NOW + 5 * 60_000));
        // fired 必须被清掉，否则休息结束时不会提醒
        assert!(!timers[0].fired);
    }

    #[test]
    fn 番茄钟时长为零也不会变成弹窗风暴() {
        // `timers.json` 是纯文本、可以被手改。focus/break 为 0 时如果不兜底，
        // `ends_at = now + 0` 会让**每个 tick（500ms）**都判定"又到点了"：
        // 弹窗风暴 + 每 500ms 写一次盘 + rounds 无限膨胀。
        // 正常路径前端会拦住 0，但数据文件拦不住。
        let mut t = timer("p", TimerKind::Pomodoro, Some(NOW));
        t.phase = Some(PomodoroPhase::Focus);
        t.focus_minutes = 0;
        t.break_minutes = 0;
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 1, "这一次到点还是要提醒的");
        let ends = timers[0].ends_at.expect("下一阶段必须排好时刻");
        assert!(
            ends > NOW,
            "下一阶段必须落在未来，否则下一个 tick 立刻又到点，实际：{ends} vs {NOW}"
        );
        // 再跑一次：时刻没到，就不该再弹
        let again = evaluate(&mut timers, &mut memos, NOW);
        assert!(again.alerts.is_empty(), "不该每 500ms 弹一次");
    }

    #[test]
    fn 番茄钟休息结束回到专注且轮数不变() {        let mut t = timer("p", TimerKind::Pomodoro, Some(NOW));
        t.phase = Some(PomodoroPhase::Break);
        t.rounds = 3;
        t.focus_minutes = 25;
        t.break_minutes = 5;
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 1);
        assert_eq!(timers[0].phase, Some(PomodoroPhase::Focus));
        assert_eq!(timers[0].rounds, 3, "休息结束不该增加轮数");
        assert_eq!(timers[0].ends_at, Some(NOW + 25 * 60_000));
    }

    #[test]
    fn 番茄钟phase缺失时按专注处理() {
        // 兜底：老数据或手动改坏的数据可能没有 phase。
        // 此时必须当作"专注刚结束"，否则这一轮会静默丢掉。
        let mut t = timer("p", TimerKind::Pomodoro, Some(NOW));
        t.phase = None;
        let mut timers = vec![t];
        let mut memos = Vec::new();

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 1);
        assert_eq!(timers[0].phase, Some(PomodoroPhase::Break));
        assert_eq!(timers[0].rounds, 1);
    }

    // ---------- 备忘录 ----------

    #[test]
    fn 备忘提醒到点触发并打幂等标记() {
        let mut timers = Vec::new();
        let mut memos = vec![memo("m", Some(NOW))];

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 1);
        assert_eq!(result.alerts[0].source, "memo");
        assert!(result.memos_changed);
        assert_eq!(memos[0].fired_for, Some(NOW));
        // remind_at 不在这里推进——那是前端的责任（要算重复规则与本地时区）
        assert_eq!(memos[0].remind_at, Some(NOW));
    }

    #[test]
    fn 备忘提醒不会重复弹() {
        let mut timers = Vec::new();
        let mut memos = vec![memo("m", Some(NOW))];

        // 第一次触发
        evaluate(&mut timers, &mut memos, NOW);
        // 之后每一 tick 都判定一次，模拟真实运行
        for offset in [500, 1_000, 60_000, 3_600_000] {
            let result = evaluate(&mut timers, &mut memos, NOW + offset);
            assert!(
                result.alerts.is_empty(),
                "同一 remind_at 不该重复弹（offset={offset}）"
            );
        }
    }

    #[test]
    fn 备忘未设提醒不触发() {
        let mut timers = Vec::new();
        let mut memos = vec![memo("m", None)];

        let result = evaluate(&mut timers, &mut memos, NOW + 999_999);

        assert!(result.alerts.is_empty());
        assert!(!result.memos_changed);
    }

    #[test]
    fn 备忘推进到下一次后能再次触发() {
        // 模拟前端的重复推进：弹过之后把 remind_at 换成下一次、清掉 fired_for
        let mut timers = Vec::new();
        let mut memos = vec![memo("m", Some(NOW))];

        evaluate(&mut timers, &mut memos, NOW);
        assert_eq!(memos[0].fired_for, Some(NOW));

        let next = NOW + 86_400_000; // 明天同一时刻
        memos[0].remind_at = Some(next);
        memos[0].fired_for = None;

        let result = evaluate(&mut timers, &mut memos, next);
        assert_eq!(result.alerts.len(), 1, "推进后的下一次必须能正常触发");
    }

    // ---------- 组合与排序 ----------

    #[test]
    fn 多个提醒按原定时刻升序排列() {
        let mut timers = vec![
            timer("late", TimerKind::Countdown, Some(NOW - 1_000)),
            timer("early", TimerKind::Countdown, Some(NOW - 9_000)),
        ];
        let mut memos = vec![memo("mid", Some(NOW - 5_000))];

        let result = evaluate(&mut timers, &mut memos, NOW);

        let ids: Vec<&str> = result.alerts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["early", "mid", "late"], "用户看到的顺序应该按发生先后");
    }

    #[test]
    fn 一次判定可以同时处理计时器与备忘() {
        let mut timers = vec![timer("t", TimerKind::Countdown, Some(NOW))];
        let mut memos = vec![memo("m", Some(NOW))];

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert_eq!(result.alerts.len(), 2);
        assert!(result.timers_changed);
        assert!(result.memos_changed);
    }

    #[test]
    fn 没有到点项目时不产生任何改动() {
        let mut timers = vec![timer("t", TimerKind::Countdown, Some(NOW + 60_000))];
        let mut memos = vec![memo("m", Some(NOW + 60_000))];

        let result = evaluate(&mut timers, &mut memos, NOW);

        assert!(result.alerts.is_empty());
        // 这个断言很重要：如果没到点也报 changed，就会每 500ms 无谓地写一次磁盘
        assert!(!result.timers_changed);
        assert!(!result.memos_changed);
    }

    // ---------- 弹窗文案 ----------

    #[test]
    fn 单条提醒直接显示内容本身() {
        let alerts = vec![PendingAlert {
            source: "timer".into(),
            id: "a".into(),
            title: "煮蛋".into(),
            body: "倒计时已完成".into(),
            due_at: NOW,
        }];

        let (title, body) = compose_alert(&alerts, |n| format!("{n} 条")).expect("应有一条");

        assert_eq!(title, "煮蛋", "只有一条时标题就是这件事本身");
        assert_eq!(body, "倒计时已完成");
    }

    #[test]
    fn 多条提醒走汇总标题并逐条列出() {
        let alerts: Vec<PendingAlert> = (0..3)
            .map(|i| PendingAlert {
                source: "memo".into(),
                id: format!("m{i}"),
                title: format!("事项{i}"),
                body: "内容".into(),
                due_at: NOW + i,
            })
            .collect();

        let (title, body) =
            compose_alert(&alerts, |n| format!("你错过了 {n} 条提醒")).expect("应有三条");

        assert_eq!(title, "你错过了 3 条提醒");
        assert_eq!(body.lines().count(), 3);
        assert!(body.contains("事项0"));
    }

    #[test]
    fn 汇总超过上限时只列前几条并说明剩余数量() {
        let alerts: Vec<PendingAlert> = (0..MAX_LISTED + 5)
            .map(|i| PendingAlert {
                source: "memo".into(),
                id: format!("m{i}"),
                title: format!("事项{i}"),
                body: "内容".into(),
                due_at: NOW + i as i64,
            })
            .collect();

        let (_, body) = compose_alert(&alerts, |n| format!("{n} 条")).expect("应有多条");

        // 列出 MAX_LISTED 条 + 一行"还有 N 条"
        assert_eq!(body.lines().count(), MAX_LISTED + 1);
        assert!(body.contains("还有 5 条"));
    }

    #[test]
    fn 空列表不产生弹窗() {
        assert!(compose_alert(&[], |n| format!("{n} 条")).is_none());
    }

    // ---------- 正文摘要 ----------

    #[test]
    fn 摘要把多行压成一行并截断() {
        let long = "很长的内容".repeat(50);
        let s = summarize_body(&long);
        assert!(s.ends_with('…'));
        assert!(s.chars().count() <= 121, "截断后长度应受控");

        assert_eq!(summarize_body("第一行\n第二行"), "第一行 第二行");
        assert_eq!(summarize_body("   "), "（无内容）");
    }
}
