//! 出问题时留个痕迹。
//!
//! # 为什么不能只用 `eprintln!`
//!
//! 正式版是 `windows_subsystem = "windows"`（见 `main.rs`）—— **没有控制台，
//! 也没有 stderr**。`eprintln!` 写进去的东西直接进黑洞：用户看不到，
//! 开发者事后也查不到。
//!
//! 这不是理论问题。作者排查"全局热键突然不生效"时，实际原因就是
//! **上一个实例还占着那个组合键，新实例的 `RegisterHotKey` 失败**；
//! 而当时该报错的那行 `eprintln!` 一个字都没落下来，只能靠
//! "自己试着注册同一个热键、看会不会失败"这种旁门左道反推。
//!
//! 同一个黑洞里还埋着更值钱的信息：`storage.rs` 的"文件损坏已改名"、
//! `scheduler.rs` 的"保存计时器/备忘录失败"（**这两个是真的会丢数据**）。
//!
//! # 取舍
//!
//! 这是个诊断日志，不是数据：超过上限就从头截断，丢了不可惜。
//! `log()` **绝不 panic、也绝不返回错误** —— 记日志失败不该影响主流程。

use std::io::Write;
use std::path::PathBuf;

/// 日志超过这个大小就从头截断。诊断用，不需要留历史。
const MAX_BYTES: u64 = 256 * 1024;

/// 记日志的宏，用法和 `eprintln!` 完全一样。
///
/// 提供宏是为了让替换是**纯文本**的：`eprintln!(...)` → `crate::diag!(...)`，
/// 不必给每个调用点补 `&format!(...)` 和一层括号 —— 那种改动在
/// 多行调用上很容易漏一个括号，而编译器只会说"括号不匹配"。
#[macro_export]
macro_rules! diag {
    ($($arg:tt)*) => {
        $crate::diag::log(&format!($($arg)*))
    };
}

/// 日志文件名，放在数据目录里（用户能从设置页"打开数据文件夹"找到它）。
pub const LOG_FILE: &str = "app.log";

/// 日志文件的完整路径。拿不到 `APPDATA` 时返回 `None`（静默放弃）。
fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(
        PathBuf::from(base)
            .join(crate::storage::APP_DIR_NAME)
            .join(LOG_FILE),
    )
}

/// 记一条日志。
///
/// 任何一步失败都静默放弃：日志是辅助手段，不该因为写不进去就影响主流程。
pub fn log(msg: &str) {
    // 测试进程**不要**往用户的数据目录写日志。
    //
    // `cargo test` 会跑 storage 的"隔离损坏文件"那几条测试，它们走的正是生产
    // 代码里的隔离路径，于是用户的 `app.log` 里会混进一堆
    // `C:\Users\…\Temp\fuguang-test-…` 的路径（实测发生过）。
    // 日志格式由下面的单测覆盖，不需要真的落盘。
    if cfg!(test) {
        return;
    }

    let Some(path) = log_path() else { return };

    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // 超限就整个删掉，下面会重新创建 —— 诊断日志不需要滚动归档
    if std::fs::metadata(&path)
        .map(|m| m.len() > MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }

    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{} {}", stamp(), msg);
    }
}

/// 现在的时间，格式 `2026-10-01 04:12:33Z`（**UTC**）。
///
/// # 为什么自己算日期
///
/// 不引入 `chrono`（为了一个时间戳不值当），也不为它多开一个
/// `windows-sys` 的 feature（`GetLocalTime` 在 `Win32_System_SystemInformation` 里）。
/// 用 Howard Hinnant 的 `civil_from_days` 算法，是标准做法。
///
/// 用 UTC 而不是本地时间：夏令时跳变那天本地时间会有重复的一小时，
/// 日志里出现两个 `01:30` 会让人对不上。需要本地时间时自己换算一下。
fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);

    // civil_from_days：把"1970-01-01 起的天数"转成年月日
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 时间戳的日期换算必须对 —— 它对不上，日志的时间线就是错的，
    /// 而"对着日志排时间顺序"正是它唯一的用途。
    #[test]
    fn 时间戳格式与换算() {
        // 格式：YYYY-MM-DD HH:MM:SSZ
        let s = stamp();
        assert_eq!(s.len(), 20, "格式不对：{s}");
        assert!(s.ends_with('Z'), "应带 Z 后缀：{s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], " ");
        assert_eq!(&s[19..20], "Z");

        // 年-月-日 与 时:分:秒 都要在合法范围里
        let year: i32 = s[0..4].parse().expect("年份可解析");
        let month: u32 = s[5..7].parse().expect("月份可解析");
        let day: u32 = s[8..10].parse().expect("日可解析");
        let hour: u32 = s[11..13].parse().expect("时可解析");
        assert!((2024..2100).contains(&year), "年份离谱：{year}");
        assert!((1..=12).contains(&month), "月份离谱：{month}");
        assert!((1..=31).contains(&day), "日离谱：{day}");
        assert!(hour < 24, "时离谱：{hour}");

        // 关键节点：1970-01-01 与 2000-03-01（闰年边界之后）
        assert_eq!(fmt_secs(0), "1970-01-01 00:00:00Z");
        assert_eq!(fmt_secs(951_782_400), "2000-02-29 00:00:00Z");
        assert_eq!(fmt_secs(951_868_800), "2000-03-01 00:00:00Z");
        assert_eq!(fmt_secs(1_767_225_600), "2026-01-01 00:00:00Z");
    }

    /// 把 `stamp()` 的算法抽出来，用固定秒数验证 —— 否则只能测"现在是合法的"，
    /// 测不出闰年、世纪这些边界算错。
    fn fmt_secs(secs: i64) -> String {
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!(
            "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        )
    }
}
