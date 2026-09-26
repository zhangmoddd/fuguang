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
}

fn default_restore_delay() -> u64 {
    120
}
fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            autostart: false,
            paste_restore_delay_ms: default_restore_delay(),
            panel_always_on_top: true,
            alert_sound: true,
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
