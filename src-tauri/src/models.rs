//! 数据模型。
//!
//! # 时间怎么存
//!
//! 所有时间点一律存 **Unix 毫秒（i64）**，Rust 侧只做 `now >= 目标时刻` 这种
//! 大小比较，**不做任何日期计算**。
//!
//! 原因：日期加减（尤其是"每周三""每月 15 号""工作日"这类重复规则）需要考虑
//! 本地时区和夏令时。Rust 标准库没有日历能力，要么引入 `chrono`（体积代价），
//! 要么去调 Windows 时区 API（复杂度代价）。
//!
//! 而前端的 JS `Date` 原生就正确处理本地时区与夏令时。所以分工是：
//! - **前端**：负责所有日期计算，算出"下一次该提醒的绝对时刻"写进来
//! - **Rust**：负责盯着绝对时刻，到点了就弹窗
//!
//! 这样 Rust 不需要任何日期库，也不会算错时区。

use serde::{Deserialize, Serialize};

/// 计时器的三种模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerKind {
    /// 倒计时：设定一段时长，到点提醒。
    Countdown,
    /// 番茄钟：专注与休息自动循环。
    Pomodoro,
    /// 秒表：正向计时，可计次。
    Stopwatch,
}

/// 番茄钟当前处于哪个阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PomodoroPhase {
    Focus,
    Break,
}

/// 一个计时器实例。
///
/// 三种模式共用同一个结构，靠 `kind` 区分，只用到各自相关的字段。
/// 这样前端列表、持久化、调度线程都只需要处理一种类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: String,
    /// 用户给的名字，例如"煮蛋""开会"。
    pub name: String,
    pub kind: TimerKind,

    /// 绝对结束时刻（Unix 毫秒）。运行中的倒计时/番茄钟用它。
    ///
    /// 存"结束时刻"而不是"剩余秒数"，是为了让关机、重启、软件崩溃后
    /// 时间依然准确——重新打开时只要比较 now 和 ends_at 就知道过了多久。
    #[serde(default)]
    pub ends_at: Option<i64>,

    /// 暂停时保留的剩余毫秒。运行时为 None。
    #[serde(default)]
    pub remaining_ms: Option<i64>,

    /// 倒计时设定的总时长（毫秒）。
    ///
    /// 必须单独存：`remaining_ms` 在到点后会被清成 0、暂停时又是动态值，
    /// 都不能代表"用户当初设了多久"。没有它的话，
    /// 「重置」和「重新开始」就只能去猜一个默认时长。
    #[serde(default)]
    pub duration_ms: Option<i64>,

    // ---- 番茄钟专用 ----
    #[serde(default)]
    pub phase: Option<PomodoroPhase>,
    #[serde(default = "default_focus_minutes")]
    pub focus_minutes: u32,
    #[serde(default = "default_break_minutes")]
    pub break_minutes: u32,
    /// 已完成的专注轮数。
    #[serde(default)]
    pub rounds: u32,

    // ---- 秒表专用 ----
    /// 已累计毫秒，不含当前正在跑的这一段。
    #[serde(default)]
    pub elapsed_ms: i64,
    /// 当前这一段的开始时刻。停止时为 None。
    #[serde(default)]
    pub running_since: Option<i64>,
    /// 计次记录（每次计次时的累计毫秒）。
    #[serde(default)]
    pub laps: Vec<i64>,

    /// 是否已经提醒过（防止同一轮重复弹窗）。
    #[serde(default)]
    pub fired: bool,

    pub created_at: i64,
}

fn default_focus_minutes() -> u32 {
    25
}
fn default_break_minutes() -> u32 {
    5
}

/// 提醒的重复规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    /// 只提醒一次。
    None,
    /// 每天同一时刻。
    Daily,
    /// 每周同一天同一时刻。
    Weekly,
    /// 每月同一日同一时刻。
    Monthly,
    /// 周一至周五同一时刻。
    Weekday,
}

impl Default for Repeat {
    fn default() -> Self {
        Repeat::None
    }
}

/// 一条备忘录。
///
/// 设计要点：**记录日期**与**提醒时间**是两个独立字段。
/// 所以你可以在今天写一条"下周三交材料"，它存在今天的日记里，
/// 但下周三才弹提醒。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: String,
    /// 记录日期，格式 `YYYY-MM-DD`（前端按本地时区算好后传进来）。
    pub date: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,

    /// 下一次该提醒的绝对时刻（Unix 毫秒）。None 表示不提醒。
    ///
    /// 重复提醒由前端在每次触发后算出下一次并写回这里。
    #[serde(default)]
    pub remind_at: Option<i64>,

    #[serde(default)]
    pub repeat: Repeat,

    /// 已经为哪个 `remind_at` 值弹过窗。
    ///
    /// 用它做幂等：即使前端因为窗口被降频而没能及时写入下一次时间，
    /// 也不会对同一个时刻重复弹窗。
    #[serde(default)]
    pub fired_for: Option<i64>,

    pub created_at: i64,
    pub updated_at: i64,
}

/// 一个快捷链接。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub name: String,
    /// 目标路径或网址。
    pub target: String,
    /// 启动参数（可选）。
    #[serde(default)]
    pub args: Option<String>,
    /// 目标种类，用于选默认图标与决定怎么启动。
    #[serde(rename = "kind")]
    pub kind: LinkKind,
    /// 排序权重，小的在前。
    #[serde(default)]
    pub order: i32,
    pub created_at: i64,
}

/// 链接目标的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    /// 可执行程序。
    Program,
    /// 文件夹。
    Folder,
    /// 普通文件（文档、图片等）。
    File,
    /// 网址。
    Url,
}

/// 应用设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 是否开机自启。默认关。
    #[serde(default)]
    pub autostart: bool,
    /// 粘贴后多久还原用户原剪贴板（毫秒）。
    #[serde(default = "default_restore_delay")]
    pub paste_restore_delay_ms: u64,
    /// 面板是否置顶。
    #[serde(default = "default_true")]
    pub panel_always_on_top: bool,
    /// 提醒弹窗是否播放提示音。
    #[serde(default = "default_true")]
    pub alert_sound: bool,

    /// 是否启用全局热键唤出面板。
    ///
    /// 默认开启：不开的话这个功能根本不会被发现，
    /// 而它恰恰是"不点小球也能用"的关键。组合键选了冲突概率很低的
    /// `Ctrl+Shift+Space`，真的撞上了设置页会明确报错。
    #[serde(default = "default_true")]
    pub hotkey_enabled: bool,

    /// 全局热键组合，例如 `Ctrl+Shift+Space`。
    #[serde(default = "default_hotkey")]
    pub hotkey: String,

    /// 界面基准字号（像素）。
    ///
    /// 前端把它设成 CSS 变量 `--fs-base`，整个界面的字号都由它推导。
    /// 面板宽度是固定的 420px，字号太大就会到处换行、按钮挤成一团，
    /// 所以只允许 `FONT_SIZE_MIN..=FONT_SIZE_MAX` 之间（见 [`Settings::clamp`]）。
    #[serde(default = "default_font_size")]
    pub font_size_px: u32,
}

/// 界面字号的下限。再小就真的看不清了。
pub const FONT_SIZE_MIN: u32 = 12;
/// 界面字号的上限。再大面板里就放不下了。
pub const FONT_SIZE_MAX: u32 = 18;

fn default_restore_delay() -> u64 {
    120
}
fn default_true() -> bool {
    true
}
fn default_hotkey() -> String {
    "Ctrl+Shift+Space".into()
}
fn default_font_size() -> u32 {
    13
}

impl Settings {
    /// 把各项取值夹到合法区间。
    ///
    /// 数据文件是纯文本、用户可以手动编辑，也可能被别的工具改坏。
    /// 所以**每次从外部拿到的设置都要过一遍这里**，
    /// 否则一个手写的 `"fontSizePx": 200` 就能让界面彻底没法用。
    pub fn clamp(&mut self) {
        self.font_size_px = self.font_size_px.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
        // 剪贴板还原延时的合理区间：0 会让慢程序粘不上，太大则长时间占着剪贴板
        self.paste_restore_delay_ms = self.paste_restore_delay_ms.min(2_000);
        if self.hotkey.trim().is_empty() {
            self.hotkey = default_hotkey();
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            autostart: false,
            paste_restore_delay_ms: default_restore_delay(),
            panel_always_on_top: true,
            alert_sound: true,
            hotkey_enabled: true,
            hotkey: default_hotkey(),
            font_size_px: default_font_size(),
        }
    }
}

/// 一条待弹出的提醒。用于"错过的提醒汇总补发"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAlert {
    /// 来源类型：`timer` 或 `memo`。
    pub source: String,
    pub id: String,
    pub title: String,
    pub body: String,
    /// 该提醒原本应该响的时刻。
    pub due_at: i64,
}

/// 当前 Unix 毫秒。全项目统一从这里取时间，避免各处写法不一致。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===============================================================
// 测试
//
// 重点只有一个：**老数据文件必须还能读**。
//
// 这些 JSON 是用户唯一的资产，而且会随着版本升级不断加字段
// （`duration_ms` 就是后加的）。如果新版本读不了旧文件，
// 用户的计时器、备忘录会在一夜之间全部消失。
//
// 所以每个模型都测一遍"只给必填字段的最小 JSON"能否解析成功。
// ===============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只有必填字段的计时器也能解析() {
        // 模拟 duration_ms 存在之前写下的老数据
        let json = r#"{
            "id": "t1",
            "name": "煮蛋",
            "kind": "countdown",
            "createdAt": 1800000000000
        }"#;

        let t: Timer = serde_json::from_str(json).expect("老数据必须能解析");

        assert_eq!(t.id, "t1");
        assert_eq!(t.name, "煮蛋");
        assert_eq!(t.kind, TimerKind::Countdown);
        // 缺省值必须合理：这些字段在老数据里根本不存在
        assert_eq!(t.duration_ms, None, "老数据没有设定时长，应为 None 而不是 0");
        assert_eq!(t.ends_at, None);
        assert_eq!(t.remaining_ms, None);
        assert_eq!(t.phase, None);
        assert_eq!(t.rounds, 0);
        assert!(!t.fired);
        assert!(t.laps.is_empty());
        // 番茄钟时长要有可用的默认值，否则老数据里的番茄钟会变成 0 分钟
        assert_eq!(t.focus_minutes, 25);
        assert_eq!(t.break_minutes, 5);
    }

    #[test]
    fn 只有必填字段的备忘录也能解析() {
        let json = r#"{
            "id": "m1",
            "date": "2026-09-19",
            "title": "交材料",
            "createdAt": 1,
            "updatedAt": 1
        }"#;

        let m: Memo = serde_json::from_str(json).expect("老数据必须能解析");

        assert_eq!(m.date, "2026-09-19");
        assert_eq!(m.remind_at, None);
        assert_eq!(m.repeat, Repeat::None, "缺省重复规则必须是不重复");
        assert_eq!(m.fired_for, None);
        assert!(m.tags.is_empty());
        assert_eq!(m.body, "");
    }

    #[test]
    fn 只有必填字段的链接也能解析() {
        let json = r#"{
            "id": "l1",
            "name": "记事本",
            "target": "C:\\Windows\\notepad.exe",
            "kind": "program",
            "createdAt": 1
        }"#;

        let l: Link = serde_json::from_str(json).expect("老数据必须能解析");

        assert_eq!(l.kind, LinkKind::Program);
        assert_eq!(l.args, None);
        assert_eq!(l.order, 0);
    }

    #[test]
    fn 空对象能解析成默认设置() {
        let s: Settings = serde_json::from_str("{}").expect("空设置必须能解析");

        assert!(!s.autostart, "开机自启默认必须是关的");
        assert!(s.alert_sound, "提示音默认开着");
        assert!(s.panel_always_on_top);
        assert_eq!(s.paste_restore_delay_ms, 120);
        // 热键默认开启：不开的话这个功能根本不会被发现
        assert!(s.hotkey_enabled);
        assert_eq!(s.hotkey, "Ctrl+Shift+Space");
        assert_eq!(s.font_size_px, 13, "默认字号");
    }

    #[test]
    fn 字号被夹到合法区间() {
        // 场景：用户手动编辑了 settings.json，或者被别的工具改坏。
        // 不夹的话界面会彻底没法用（字号 200 会撑爆固定 420px 的面板）。
        let mut too_big = Settings {
            font_size_px: 200,
            ..Settings::default()
        };
        too_big.clamp();
        assert_eq!(too_big.font_size_px, FONT_SIZE_MAX);

        let mut too_small = Settings {
            font_size_px: 1,
            ..Settings::default()
        };
        too_small.clamp();
        assert_eq!(too_small.font_size_px, FONT_SIZE_MIN);
    }

    #[test]
    fn 合法范围内的字号不被改动() {
        for size in FONT_SIZE_MIN..=FONT_SIZE_MAX {
            let mut s = Settings {
                font_size_px: size,
                ..Settings::default()
            };
            s.clamp();
            assert_eq!(s.font_size_px, size, "合法值不该被改动");
        }
    }

    #[test]
    fn 剪贴板延时被限制在上限内() {
        let mut s = Settings {
            paste_restore_delay_ms: 999_999,
            ..Settings::default()
        };
        s.clamp();
        assert_eq!(s.paste_restore_delay_ms, 2_000);
    }

    #[test]
    fn 空的热键会被补回默认值() {
        // 空字符串传给 RegisterHotKey 会失败，与其让它报错不如补默认值
        let mut s = Settings {
            hotkey: "   ".into(),
            ..Settings::default()
        };
        s.clamp();
        assert_eq!(s.hotkey, "Ctrl+Shift+Space");
    }

    #[test]
    fn 老版本设置文件缺少热键字段时用默认值() {
        // 场景：用户在热键功能上线之前就已经在用了，settings.json 里没有这两个字段
        let json = r#"{
            "autostart": true,
            "pasteRestoreDelayMs": 200,
            "panelAlwaysOnTop": false,
            "alertSound": false
        }"#;

        let s: Settings = serde_json::from_str(json).expect("老设置必须能解析");

        // 用户显式设过的值必须保留
        assert!(s.autostart);
        assert_eq!(s.paste_restore_delay_ms, 200);
        assert!(!s.panel_always_on_top);
        assert!(!s.alert_sound);
        // 没设过的字段补默认值
        assert!(s.hotkey_enabled);
        assert_eq!(s.hotkey, "Ctrl+Shift+Space");
    }

    #[test]
    fn 字段名用驼峰而不是下划线() {
        // 前端 TypeScript 按驼峰写，两侧必须一致，否则前端永远读不到值
        let t = Timer {
            id: "t".into(),
            name: "n".into(),
            kind: TimerKind::Countdown,
            ends_at: Some(1),
            remaining_ms: Some(2),
            duration_ms: Some(3),
            phase: None,
            focus_minutes: 25,
            break_minutes: 5,
            rounds: 0,
            elapsed_ms: 0,
            running_since: None,
            laps: Vec::new(),
            fired: false,
            created_at: 4,
        };

        let json = serde_json::to_string(&t).expect("序列化");

        assert!(json.contains("\"endsAt\""), "实际：{json}");
        assert!(json.contains("\"remainingMs\""));
        assert!(json.contains("\"durationMs\""));
        assert!(json.contains("\"createdAt\""));
        assert!(!json.contains("ends_at"), "不该出现下划线命名");
    }

    #[test]
    fn 枚举按小写字符串序列化() {
        // 前端的 TS 联合类型是小写字面量，两侧必须对得上
        assert_eq!(
            serde_json::to_string(&TimerKind::Countdown).expect("序列化"),
            "\"countdown\""
        );
        assert_eq!(
            serde_json::to_string(&PomodoroPhase::Focus).expect("序列化"),
            "\"focus\""
        );
        assert_eq!(
            serde_json::to_string(&Repeat::Weekday).expect("序列化"),
            "\"weekday\""
        );
        assert_eq!(
            serde_json::to_string(&LinkKind::Url).expect("序列化"),
            "\"url\""
        );
    }

    #[test]
    fn 多出来的未知字段不会导致解析失败() {
        // 场景：用户先用新版软件，再退回旧版。
        // 旧版不认识新字段，但不该因此读不了数据。
        let json = r#"{
            "id": "t1",
            "name": "n",
            "kind": "countdown",
            "createdAt": 1,
            "someFutureField": {"nested": true}
        }"#;

        assert!(serde_json::from_str::<Timer>(json).is_ok());
    }

    #[test]
    fn 未知的枚举值会解析失败而不是静默取错() {
        // 这是有意的：如果将来加了新的计时器类型，
        // 旧版本应该明确报错（走"损坏备份 + 回退默认值"那条路），
        // 而不是把未知类型悄悄当成倒计时处理，那会做出错误行为。
        let json = r#"{"id":"t","name":"n","kind":"teleporter","createdAt":1}"#;
        assert!(serde_json::from_str::<Timer>(json).is_err());
    }

    #[test]
    fn 时间戳是合理的毫秒值() {
        let now = now_ms();

        // 2020-01-01 与 2100-01-01 的毫秒时间戳，用来兜住"误用秒"这类错误
        assert!(now > 1_577_836_800_000, "时间戳过小，可能误用了秒");
        assert!(now < 4_102_444_800_000, "时间戳过大");
    }

    #[test]
    fn 完整数据能往返序列化() {
        let t = Timer {
            id: "t".into(),
            name: "开会".into(),
            kind: TimerKind::Pomodoro,
            ends_at: Some(1_800_000_000_000),
            remaining_ms: None,
            duration_ms: Some(1_500_000),
            phase: Some(PomodoroPhase::Break),
            focus_minutes: 25,
            break_minutes: 5,
            rounds: 3,
            elapsed_ms: 0,
            running_since: None,
            laps: vec![100, 200],
            fired: false,
            created_at: 1_700_000_000_000,
        };

        let json = serde_json::to_string(&t).expect("序列化");
        let back: Timer = serde_json::from_str(&json).expect("反序列化");

        assert_eq!(back.id, t.id);
        assert_eq!(back.kind, t.kind);
        assert_eq!(back.ends_at, t.ends_at);
        assert_eq!(back.duration_ms, t.duration_ms);
        assert_eq!(back.phase, t.phase);
        assert_eq!(back.rounds, t.rounds);
        assert_eq!(back.laps, t.laps);
    }
}
