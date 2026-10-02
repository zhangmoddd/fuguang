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

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 计时器的四种模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerKind {
    /// 倒计时：设定一段时长，到点提醒。
    Countdown,
    /// 番茄钟：专注与休息自动循环。
    Pomodoro,
    /// 秒表：正向计时，可计次。
    Stopwatch,
    /// 闹钟：在指定的**钟点**响，可选每天重复。
    ///
    /// 和倒计时的区别只有一处：倒计时设的是「多久之后」，
    /// 闹钟设的是「几点」。两者到点后的收尾完全一样。
    Alarm,
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

    // ---- 闹钟专用 ----
    /// 响铃的钟点，**从本地零点起的分钟数**（0~1439）。
    ///
    /// 必须单独存，理由和倒计时的 `duration_ms` 一样：`ends_at` 是
    /// 「下一次响的绝对时刻」，响过之后就清空了，代表不了用户设的那个钟点。
    /// 没有它，「停止」之后再「开始」就只能去猜一个时间。
    ///
    /// 存分钟数而不是 `"07:30"` 字符串：字符串要解析、会有格式歧义
    /// （`7:30` / `07:30` / `0730`），而分钟数是唯一的整数表示，
    /// 排序和比较都是现成的。
    ///
    /// 反序列化走 [`lenient_minutes`] 而不是直接 `u32`，**理由见那个函数** ——
    /// 简单说：手改成一个越界数值不该让整份 `timers.json` 被判为损坏。
    #[serde(default, deserialize_with = "lenient_minutes")]
    pub alarm_minutes: u32,

    /// 闹钟是否每天重复。
    ///
    /// `false` 表示只响一次，响完就停在「已完成」，等用户再点一次。
    #[serde(default)]
    pub alarm_daily: bool,

    /// 上一次**真的响**的时刻（Unix 毫秒）。没响过是 `None`。
    ///
    /// 只用来把「已完成」说清楚 —— 卡片上光写"已响过"，用户不知道是刚才响的
    /// 还是昨天响的（原话：「明明没有到 11:30 却显示已经响过」）。
    /// 有了它就能显示「已响过 · 昨天 11:30」。
    ///
    /// 刻意不在前端"推算上一次"：推算只能给出"最近的某个钟点"，
    /// 而软件没开的时候闹钟是不响的 —— 推算出来的时间会是假的。
    #[serde(default)]
    pub last_fired_at: Option<i64>,

    /// 是否已经提醒过（防止同一轮重复弹窗）。
    #[serde(default)]
    pub fired: bool,

    /// 所属文件夹 id。`None` 表示在顶层。
    ///
    /// 后加字段：老数据里没有这一项，缺省即顶层。
    #[serde(default)]
    pub folder_id: Option<String>,

    pub created_at: i64,
}

fn default_focus_minutes() -> u32 {
    25
}
fn default_break_minutes() -> u32 {
    5
}

/// 宽容地读一个「钟点分钟数」：**任何 JSON 值都能收成一个合法钟点，绝不失败**。
///
/// # 为什么不能直接写 `u32`
///
/// `timers.json` 是纯文本、用户可以手改（README 里就是这么承诺的）。
/// 而 `serde` 对 `u32` 遇到 `-1`、`1.5`、`99999999999` 都会**解析失败**，
/// 而解析失败会被 [`crate::storage::read_json_at`] 当成「文件损坏」——
/// **整份计时器被改名隔离**，不只是这一条坏掉，用户会以为数据全丢了。
///
/// 这个字段的用途只是「取模之后当钟点显示 / 算下一次响铃」，任何数值都能归到
/// 一个合法钟点，所以宽容没有任何代价：
///
/// - 数字 → 向下取整后对 1440 取模（负数也能落进 0~1439）
/// - 其它形状（字符串、null、对象、`NaN`）→ 0 点
///
/// # 为什么只对这个字段宽容
///
/// 别处的字段（`focus_minutes`、枚举值 `kind`）刻意保持严格：那些值一旦被
/// 悄悄改掉，调度线程会做出**错误的行为**（0 分钟的番茄钟会变成弹窗风暴），
/// 明确报错并隔离反而是对的。钟点不一样 —— 它只是"几点响"，
/// 归一到最近的一个合法钟点永远比丢掉全部数据好。
fn lenient_minutes<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let raw = value.as_f64().unwrap_or(0.0);
    if !raw.is_finite() {
        return Ok(0);
    }
    // `rem_euclid` 而不是 `%`：后者对负数会返回负值，落不进 0~1439
    Ok(raw.floor().rem_euclid(1440.0) as u32)
}

impl Timer {
    /// 这条闹钟是不是「已经响过、还没排下一次」。
    ///
    /// 只有这一种状态才该被推进。用户中途点过「停止」（`fired` 变回 false）
    /// 或「再响一次」（`ends_at` 已经有值），以及只响一次的闹钟，
    /// 都不该被动。
    pub fn alarm_needs_advance(&self) -> bool {
        self.kind == TimerKind::Alarm
            && self.alarm_daily
            && self.fired
            && self.ends_at.is_none()
    }

    /// 把这条闹钟排到下一次响铃。返回 `false` 表示它当时不处于可推进的状态，
    /// 一个字段都没改。
    ///
    /// # 为什么要做成「条件更新」而不是让调用方自己判断
    ///
    /// 判断和写入必须在**同一把锁里**。前端的做法是「读出来 → 算下一次 →
    /// 写回去」，中间隔着一次 IPC 往返；用户完全可能在这两步之间点下「停止」，
    /// 而 `timer_save` 是整条覆盖写 —— 用户那一下就被静默吞掉了
    /// （界面显示「未开始」，盘上还排着明天响）。这个方法让"检查 + 改"
    /// 成为一个原子步骤，用户的操作永远优先。
    pub fn advance_alarm_to(&mut self, next_ends_at: i64) -> bool {
        if !self.alarm_needs_advance() {
            return false;
        }
        self.ends_at = Some(next_ends_at);
        // 闹钟没有"剩余时长"这个概念。留一个 0 在这里，前端会把
        // 「已完成」误判成「已暂停」并给出「继续」按钮。
        self.remaining_ms = None;
        self.fired = false;
        true
    }
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
    /// 所属文件夹 id。`None` 表示在顶层。
    ///
    /// 后加字段：老数据里没有这一项，缺省即顶层。
    #[serde(default)]
    pub folder_id: Option<String>,
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

/// 一个文件夹，用来给条目分类。
///
/// # 为什么单独一个文件（`folders.json`）
///
/// 文件夹不属于某一个功能：链接、文本片段、计时器各有一套，所以用一个文件装全部，
/// 靠 `feature` 字段区分归属。
///
/// 为什么不塞进 `links.json` 之类：数据文件的约定是**只增字段不删字段**，
/// 把 `[条目, ...]` 改成 `{ "items": [...], "folders": [...] }` 会让老版本
/// 直接读不了这个文件——用户的链接会一夜之间消失。
///
/// # 嵌套
///
/// 用 `parent_id` 表达父子关系，`None` 就是顶层。任意层数都能表示，
/// 前端用面包屑下钻来浏览（面板只有 420px，塞不下左侧树）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    /// 属于哪个功能页签（`links` / `snippets` / `timer`）。
    ///
    /// 刻意用字符串而不是枚举：这里不需要"认识"所有取值，前端按自己的 id 过滤即可。
    /// 换成枚举的话，一个前端先加上、后端还不认识的取值会让**整个文件**解析失败，
    /// 而解析失败会被 [`crate::storage`] 当成文件损坏备份掉——代价太大。
    pub feature: String,
    pub name: String,
    /// 备注。和名字分开：名字要短才排得下，
    /// 想写清楚"这个文件夹是干什么的"就写在备注里。
    #[serde(default)]
    pub note: String,
    /// 父文件夹 id。`None` 表示在顶层。
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 排序权重，小的在前。
    #[serde(default)]
    pub order: i32,
    pub created_at: i64,
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

    /// 悬浮球的配色方案 id。
    ///
    /// 存 id 而不是具体颜色：每个配色需要**同时**决定底色、标志颜色、描边，
    /// 三者必须配套（深色底配白标、浅色底配深标），
    /// 让用户自由填颜色很容易配出"标志和底色糊在一起"的组合。
    #[serde(default = "default_ball_theme")]
    pub ball_theme: String,

    /// 各页签的缩放百分比（100 = 默认大小）。
    ///
    /// 用一个 map 而不是"每个页签一个字段"：页签是刻意做成可扩展的
    /// （见前端 `features/registry.ts`），每加一个页签都要改数据模型不合理。
    ///
    /// 用 `BTreeMap` 而不是 `HashMap`：前者按 key 排序序列化，
    /// 写出来的 `settings.json` 顺序稳定，diff 才不会每次都在抖。
    ///
    /// 认不出来的 key 会被原样留着——前端只读自己那个页签的键，
    /// 多出来的键既不影响显示，也不会因为卸载了某个页签就把用户的选择删掉。
    #[serde(default)]
    pub zoom: BTreeMap<String, u32>,
}

/// 悬浮球可选配色。与前端 `src/lib/ball-theme.ts` 里的 id 一一对应。
///
/// 两边都要有：Rust 侧用于校验（防止手改数据文件写入无效 id），
/// 前端侧用于渲染。新增配色时两边都要加。
pub const BALL_THEMES: [&str; 7] = [
    "white",
    "soft-blue",
    "graphite",
    "dark",
    "purple",
    "teal",
    "classic-blue",
];

fn default_ball_theme() -> String {
    // 默认白底蓝标：与软件的浅色主题一致
    "white".into()
}

/// 界面字号的下限。再小就真的看不清了。
pub const FONT_SIZE_MIN: u32 = 12;
/// 界面字号的上限。再大面板里就放不下了。
pub const FONT_SIZE_MAX: u32 = 18;

/// 页签缩放的上下限（百分比）。
///
/// 下限 70：再小图标就点不中了；上限 160：再大链接页一行只放得下两个。
///
/// 「没有单独设置过的页签用多少」不在 Rust 侧定义：缺 key 就代表用默认值，
/// 默认值由前端 `lib/zoom.ts` 的 `ZOOM_DEFAULT` 说了算——
/// 那样调整默认档位不用动数据模型，也不会让老数据文件凭空多出一堆键。
pub const ZOOM_MIN: u32 = 70;
/// 见 [`ZOOM_MIN`]。
pub const ZOOM_MAX: u32 = 160;

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
        // 无效的配色 id 会让前端拿不到任何样式，球会变成没有底色的一团。
        // 认不出来就退回默认值，而不是让它空着。
        if !BALL_THEMES.contains(&self.ball_theme.as_str()) {
            self.ball_theme = default_ball_theme();
        }
        // 缩放档位也要夹：一个手写的 "zoom": {"links": 9999}
        // 会让链接页一个图标占满整屏，等于把功能弄坏了。
        for v in self.zoom.values_mut() {
            *v = (*v).clamp(ZOOM_MIN, ZOOM_MAX);
        }
    }
}

/// 把 `changes` 里出现的键合并进 `current`，其余保持不动，最后夹取一遍。
///
/// # 为什么用 JSON 合并而不是给每个字段写一遍
///
/// 逐个字段写一遍意味着以后每加一个设置项都要来这里改一次，
/// 忘了改的表现是"那一项怎么都存不上"。用 JSON 合并之后，
/// "哪些字段能改"由 `Settings` 自己决定（`serde` 的默认值管缺字段、
/// 未知键被忽略），新增字段不用动这里。
///
/// 抽成纯函数是为了能单测：`settings_patch` 命令要 `AppHandle`，
/// 单测里造不出来，而"合并"恰恰是那段逻辑里唯一会出错的地方。
pub fn merge_settings(
    current: &Settings,
    changes: &serde_json::Value,
) -> Result<Settings, String> {
    let mut base =
        serde_json::to_value(current).map_err(|e| format!("序列化当前设置失败：{e}"))?;

    // `changes` 不是对象（数组、字符串、null…）时什么都不合并、原样返回 ——
    // 调用方传错形状不该把用户的设置清空。
    if let (Some(base), Some(patch)) = (base.as_object_mut(), changes.as_object()) {
        for (key, value) in patch {
            base.insert(key.clone(), value.clone());
        }
    }

    let mut merged: Settings =
        serde_json::from_value(base).map_err(|e| format!("设置格式不对：{e}"))?;
    merged.clamp();
    Ok(merged)
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
            ball_theme: default_ball_theme(),
            zoom: BTreeMap::new(),
        }
    }
}

/// 一条待弹出的提醒。用于"错过的提醒汇总补发"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAlert {
    /// 来源类型：`timer` / `alarm` / `memo` / `snooze`。
    ///
    /// `alarm` 单独标出来（而不是并进 `timer`）是因为**响铃行为不同**：
    /// 闹钟按手机的逻辑"响到你处理为止"，其余几种只是一声提醒。
    /// `snooze` 是用户点了「稍后提醒」之后排队重弹的那条。
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
        assert_eq!(t.folder_id, None, "老数据没有分类，应落在顶层");
        // 闹钟字段是后加的，老数据里没有：缺省必须是"零点、不重复"这种
        // 明确无害的值，而不是让整个文件解析失败
        assert_eq!(t.alarm_minutes, 0);
        assert!(!t.alarm_daily);
        // 「上次响铃时刻」也是后加字段：老数据里没有 → None（表示"没响过"）
        assert_eq!(t.last_fired_at, None);
    }

    #[test]
    fn 闹钟钟点被手改成越界值也不会让整份数据读不出来() {
        // 场景：用户手改 timers.json，或者被别的工具改坏。
        // `u32` 遇到这些值会解析失败，而解析失败会被 storage 当成
        // 「文件损坏」把**整份计时器**改名隔离 —— 代价太大，
        // 而这个字段只是"几点响"，任何数值都能归到一个合法钟点。
        for (bad, want) in [
            ("-1", 1439),
            ("1.5", 1),
            ("99999999999", (99999999999u64 % 1440) as u32),
            ("\"450\"", 0),
            ("null", 0),
            ("{}", 0),
            ("1440", 0),
        ] {
            let json = format!(
                r#"{{"id":"a","name":"n","kind":"alarm","alarmMinutes":{bad},"createdAt":1}}"#
            );
            let t: Timer = serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("alarmMinutes={bad} 不该让整条解析失败：{e}"));
            assert_eq!(t.alarm_minutes, want, "alarmMinutes={bad} 的归一结果不对");
            assert!(t.alarm_minutes < 1440, "归一之后必须是合法钟点");
        }
    }

    #[test]
    fn 合法钟点原样保留() {
        for m in [0u32, 1, 450, 720, 1439] {
            let json =
                format!(r#"{{"id":"a","name":"n","kind":"alarm","alarmMinutes":{m},"createdAt":1}}"#);
            let t: Timer = serde_json::from_str(&json).expect("合法值必须能解析");
            assert_eq!(t.alarm_minutes, m);
        }
    }

    /// 造一条「每天重复、刚响过、还没排下一次」的闹钟。
    fn due_alarm() -> Timer {
        Timer {
            id: "a1".into(),
            name: "起床".into(),
            kind: TimerKind::Alarm,
            ends_at: None,
            remaining_ms: None,
            duration_ms: None,
            phase: None,
            focus_minutes: 25,
            break_minutes: 5,
            rounds: 0,
            elapsed_ms: 0,
            running_since: None,
            laps: Vec::new(),
            alarm_minutes: 450,
            alarm_daily: true,
            last_fired_at: None,
            fired: true,
            folder_id: None,
            created_at: 1,
        }
    }

    #[test]
    fn 刚响过的每天闹钟需要推进() {
        assert!(due_alarm().alarm_needs_advance());
    }

    #[test]
    fn 用户点过停止的闹钟不需要推进() {
        // 「停止」把 fired 清成 false。这时候再去推进，等于把用户的操作吞掉
        let mut t = due_alarm();
        t.fired = false;
        assert!(!t.alarm_needs_advance());
        assert!(!t.advance_alarm_to(9_999), "不该改动任何字段");
        assert_eq!(t.ends_at, None);
        assert!(!t.fired);
    }

    #[test]
    fn 用户点过再响一次的闹钟不需要推进() {
        // 「再响一次」已经把 ends_at 排好了。再推一次会把它挪到别的时刻
        let mut t = due_alarm();
        t.ends_at = Some(1_800_000_000_000);
        t.fired = false;
        assert!(!t.alarm_needs_advance());
        assert!(!t.advance_alarm_to(9_999));
        assert_eq!(t.ends_at, Some(1_800_000_000_000), "原时刻不能被改掉");
    }

    #[test]
    fn 只响一次的闹钟不需要推进() {
        let mut t = due_alarm();
        t.alarm_daily = false;
        assert!(!t.alarm_needs_advance());
        assert!(!t.advance_alarm_to(9_999));
        assert!(t.fired, "只响一次的必须停在「已完成」");
    }

    #[test]
    fn 别的计时器类型不需要推进() {
        for kind in [
            TimerKind::Countdown,
            TimerKind::Pomodoro,
            TimerKind::Stopwatch,
        ] {
            let mut t = due_alarm();
            t.kind = kind;
            assert!(!t.alarm_needs_advance(), "{kind:?} 不该被推进");
            assert!(!t.advance_alarm_to(9_999));
        }
    }

    #[test]
    fn 推进成功后排好下一次并清掉已响标记() {
        let mut t = due_alarm();
        t.remaining_ms = Some(0); // 就算数据里残留了，也该被清掉

        assert!(t.advance_alarm_to(1_800_000_000_000));

        assert_eq!(t.ends_at, Some(1_800_000_000_000));
        assert!(!t.fired, "清掉 fired，下一轮到点才会再响");
        assert_eq!(
            t.remaining_ms, None,
            "留一个 0 会让前端把「已完成」误判成「已暂停」"
        );
        // 用户设的钟点与重复规则不能被推进逻辑改掉
        assert_eq!(t.alarm_minutes, 450);
        assert!(t.alarm_daily);
    }

    #[test]
    fn 推进是幂等的第二次不生效() {
        // 两个窗口同时推进时，后到的那个必须什么都不做
        let mut t = due_alarm();
        assert!(t.advance_alarm_to(1_800_000_000_000));
        assert!(!t.advance_alarm_to(1_900_000_000_000));
        assert_eq!(t.ends_at, Some(1_800_000_000_000), "第二次不该覆盖第一次");
    }

    #[test]
    fn 闹钟的钟点与重复设置能往返序列化() {        let t = Timer {
            id: "a1".into(),
            name: "起床".into(),
            kind: TimerKind::Alarm,
            ends_at: None,
            remaining_ms: None,
            duration_ms: None,
            phase: None,
            focus_minutes: 25,
            break_minutes: 5,
            rounds: 0,
            elapsed_ms: 0,
            running_since: None,
            laps: Vec::new(),
            // 7:30 = 从本地零点起 450 分钟
            alarm_minutes: 450,
            alarm_daily: true,
            last_fired_at: None,
            fired: false,
            folder_id: None,
            created_at: 1,
        };

        let json = serde_json::to_string(&t).expect("序列化");
        assert!(json.contains("\"alarmMinutes\":450"), "实际：{json}");
        assert!(json.contains("\"alarmDaily\":true"));
        assert!(!json.contains("alarm_minutes"), "不该出现下划线命名");

        let back: Timer = serde_json::from_str(&json).expect("反序列化");
        assert_eq!(back.kind, TimerKind::Alarm);
        assert_eq!(back.alarm_minutes, 450);
        assert!(back.alarm_daily);

        // 枚举值必须是小写字面量，前端按它判断是不是闹钟
        assert_eq!(
            serde_json::to_string(&TimerKind::Alarm).expect("序列化"),
            "\"alarm\""
        );
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
        assert_eq!(l.folder_id, None, "老数据没有分类，应落在顶层");
    }

    #[test]
    fn 只有必填字段的文件夹也能解析() {
        let json = r#"{
            "id": "f1",
            "feature": "links",
            "name": "工作",
            "createdAt": 1
        }"#;

        let f: Folder = serde_json::from_str(json).expect("老数据必须能解析");

        assert_eq!(f.feature, "links");
        assert_eq!(f.name, "工作");
        assert_eq!(f.note, "");
        assert_eq!(f.parent_id, None, "缺省即顶层");
        assert_eq!(f.order, 0);
    }

    #[test]
    fn 文件夹的父子关系能往返序列化() {
        let f = Folder {
            id: "f2".into(),
            feature: "links".into(),
            name: "项目".into(),
            note: "正在做的".into(),
            parent_id: Some("f1".into()),
            order: 3,
            created_at: 1,
        };

        let json = serde_json::to_string(&f).expect("必须能序列化");
        // 前端按 camelCase 读，字段名写错会让嵌套关系整条失效
        assert!(json.contains("\"parentId\":\"f1\""), "实际输出：{json}");
        assert!(json.contains("\"createdAt\":1"));

        let back: Folder = serde_json::from_str(&json).expect("必须能解析回去");
        assert_eq!(back.parent_id.as_deref(), Some("f1"));
        assert_eq!(back.note, "正在做的");
        assert_eq!(back.order, 3);
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
    fn 缩放档位被夹到合法区间() {
        // 场景同字号：手写一个 "zoom": {"links": 9999}
        // 会让链接页一个图标占满整屏，等于把功能弄坏了。
        let mut s = Settings::default();
        s.zoom.insert("links".into(), 9999);
        s.zoom.insert("timer".into(), 1);
        s.zoom.insert("snippets".into(), 120);
        s.clamp();

        assert_eq!(s.zoom["links"], ZOOM_MAX);
        assert_eq!(s.zoom["timer"], ZOOM_MIN);
        assert_eq!(s.zoom["snippets"], 120, "合法值不该被改动");
    }

    #[test]
    fn 缩放档位按页签独立保存() {
        // 这是这个功能的核心承诺：调大链接的图标不该影响计时器
        let mut s = Settings::default();
        s.zoom.insert("links".into(), 140);
        s.clamp();

        assert_eq!(s.zoom.get("links"), Some(&140));
        assert_eq!(s.zoom.get("timer"), None, "没设置过的页签不该被写进去");
    }

    #[test]
    fn 老设置文件没有缩放字段时是空表() {
        // 空表代表"所有页签都用默认大小"。clamp 刻意不往里塞默认值：
        // 塞了就分不清"用户没调过"和"用户调回了 100"。
        let s: Settings = serde_json::from_str("{}").expect("必须能解析");
        assert!(s.zoom.is_empty());
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
    fn 悬浮球配色默认是白底蓝标() {
        let s: Settings = serde_json::from_str("{}").expect("空设置必须能解析");
        assert_eq!(s.ball_theme, "white");
    }

    #[test]
    fn 无效的悬浮球配色会退回默认值() {
        // 场景：用户手动改了 settings.json，或者以后删掉了某个配色方案。
        // 不校验的话前端查不到对应样式，球会变成没有底色的一团。
        let mut s = Settings {
            ball_theme: "neon-pink".into(),
            ..Settings::default()
        };
        s.clamp();
        assert_eq!(s.ball_theme, "white");
    }

    #[test]
    fn 全部合法配色都能通过校验() {
        // 这条保证 Rust 侧的白名单和前端实际提供的配色不会脱节：
        // 前端多给了一个而这里没加，用户选了就会被悄悄改回默认值
        for theme in BALL_THEMES {
            let mut s = Settings {
                ball_theme: theme.into(),
                ..Settings::default()
            };
            s.clamp();
            assert_eq!(s.ball_theme, theme, "合法配色不该被改动：{theme}");
        }
    }

    // ---------- 设置的部分更新（settings_patch） ----------

    #[test]
    fn 只改一个键时其余键原样保留() {
        // 这是这个函数存在的**全部理由**：前端连改两项时，第二次不能把
        // 第一次的结果冲掉（"我改的字号自己变回去了"）。
        let current = Settings {
            font_size_px: 17,
            ball_theme: "dark".into(),
            ..Settings::default()
        };
        let merged =
            merge_settings(&current, &serde_json::json!({ "alertSound": false })).expect("合并");

        assert!(!merged.alert_sound, "改的这一项要生效");
        assert_eq!(merged.font_size_px, 17, "没改的字号必须留着");
        assert_eq!(merged.ball_theme, "dark", "没改的配色必须留着");
    }

    #[test]
    fn 合并时越界值照样被夹取() {
        // `settings_save` 会夹取，`settings_patch` 走的字段不一样，也不能漏
        let current = Settings::default();
        let merged = merge_settings(
            &current,
            &serde_json::json!({ "fontSizePx": 200, "pasteRestoreDelayMs": 999_999 }),
        )
        .expect("合并");

        assert_eq!(merged.font_size_px, FONT_SIZE_MAX);
        assert_eq!(merged.paste_restore_delay_ms, 2_000);
    }

    #[test]
    fn 合并时认不出来的键被忽略而不是报错() {
        // 前端先加上一个字段、后端还不认识时，不该让整次保存失败
        let current = Settings::default();
        let merged = merge_settings(
            &current,
            &serde_json::json!({ "someFutureField": { "nested": true }, "alertSound": false }),
        )
        .expect("未知键不该让合并失败");

        assert!(!merged.alert_sound, "认识的键仍要生效");
    }

    #[test]
    fn changes_不是对象时原样返回而不是清空设置() {
        // 调用方传错形状（数组 / 字符串 / null）时，最坏结果只能是"什么都没改"
        let current = Settings {
            font_size_px: 17,
            ..Settings::default()
        };
        for bad in [
            serde_json::json!([]),
            serde_json::json!("oops"),
            serde_json::Value::Null,
            serde_json::json!(42),
        ] {
            let merged = merge_settings(&current, &bad).expect("不该失败");
            assert_eq!(merged.font_size_px, 17, "传错形状不该改设置：{bad}");
        }
    }

    #[test]
    fn 合并时值的类型不对会明确报错而不是静默丢弃() {
        // `fontSizePx` 传成字符串：与其悄悄忽略，不如让前端知道它写错了
        let current = Settings::default();
        let result = merge_settings(&current, &serde_json::json!({ "fontSizePx": "17" }));
        assert!(result.is_err(), "类型不对必须报错");
        assert!(result.unwrap_err().contains("设置格式不对"));
    }

    #[test]
    fn 合并可以同时改多个键() {
        let current = Settings::default();
        let merged = merge_settings(
            &current,
            &serde_json::json!({
                "fontSizePx": 15,
                "ballTheme": "teal",
                "panelAlwaysOnTop": false,
                "zoom": { "links": 130 }
            }),
        )
        .expect("合并");

        assert_eq!(merged.font_size_px, 15);
        assert_eq!(merged.ball_theme, "teal");
        assert!(!merged.panel_always_on_top);
        assert_eq!(merged.zoom.get("links"), Some(&130));
    }

    #[test]
    fn 老版本设置文件缺少热键字段时用默认值() {        // 场景：用户在热键功能上线之前就已经在用了，settings.json 里没有这两个字段
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
            alarm_minutes: 0,
            alarm_daily: false,
            last_fired_at: None,
            fired: false,
            folder_id: Some("f1".into()),
            created_at: 4,
        };

        let json = serde_json::to_string(&t).expect("序列化");

        assert!(json.contains("\"endsAt\""), "实际：{json}");
        assert!(json.contains("\"remainingMs\""));
        assert!(json.contains("\"durationMs\""));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"alarmMinutes\""), "闹钟字段也要驼峰：{json}");
        assert!(json.contains("\"alarmDaily\""));
        assert!(json.contains("\"folderId\":\"f1\""), "分类字段也要驼峰：{json}");
        assert!(!json.contains("ends_at"), "不该出现下划线命名");
        assert!(!json.contains("folder_id"), "不该出现下划线命名");
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
            alarm_minutes: 0,
            alarm_daily: false,
            last_fired_at: None,
            fired: false,
            folder_id: None,
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