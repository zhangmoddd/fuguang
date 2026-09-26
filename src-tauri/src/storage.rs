//! 数据目录与 JSON 存储。
//!
//! 设计决策：数据固定放在 `%APPDATA%\浮光\`。
//! 原因是要发布到 GitHub 给其他人用，而用户可能把 exe 放在只读目录
//! （例如 `C:\Program Files\`），放在 exe 旁边会直接写入失败。
//! 同时这个位置对开发模式和正式版是同一份数据，不会出现「开发时记的东西正式版看不见」。
//!
//! # 分层
//!
//! 真正干活的读写逻辑都写成**接收路径**的版本（[`read_json_at`] / [`write_json_at`] /
//! [`check_file_name`]），它们不依赖 `AppHandle`，因此能被单元测试直接覆盖。
//!
//! 面向 `AppHandle` 的那几个函数只是"算出数据目录，然后转调"，
//! 自身没有分支逻辑。
//!
//! 这样分层是因为：数据损坏处理、原子写入、路径穿越拦截这几处一旦出错，
//! 后果是**用户数据丢失**，属于必须测到的部分；而它们原本和 Tauri 耦合在一起，
//! 根本没法测。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 应用数据文件夹名（同时作为窗口标题前缀与产品名的来源）。
pub const APP_DIR_NAME: &str = "浮光";

/// 解析数据目录，必要时创建它。
///
/// 优先用 `%APPDATA%\浮光`；若环境变量缺失（极端情况）则退回 Tauri 的 app_data_dir，
/// 保证任何情况下都有可写目录，不会让软件直接崩在启动阶段。
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var_os("APPDATA") {
        Some(appdata) => PathBuf::from(appdata).join(APP_DIR_NAME),
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法定位应用数据目录：{e}"))?,
    };

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败（{}）：{e}", dir.display()))?;
    }
    Ok(dir)
}

/// 校验前端传来的文件名，返回可安全拼接的相对路径。
///
/// 这是**安全边界**：前端理论上可以传任何字符串过来。
/// 不拦的话 `../../something` 能让读写跑到数据目录之外。
///
/// 只允许纯文件名（可带一层扩展名），不接受任何路径分隔符或上跳。
pub fn check_file_name(file: &str) -> Result<&str, String> {
    if file.is_empty() {
        return Err("文件名不能为空".into());
    }
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err(format!("非法文件名：{file}"));
    }
    // Windows 上盘符（C:）与 NTFS 数据流（a:b）都可能被滥用
    if file.contains(':') {
        return Err(format!("非法文件名：{file}"));
    }
    Ok(file)
}

/// 读取 JSON 文件（路径版本，可单测）。
///
/// 文件不存在或内容损坏时返回 `fallback`，而不是报错。
/// 理由：数据文件是纯文本、用户可能手动编辑；一次手滑不该让软件打不开。
///
/// 损坏时会**先把坏文件改名备份**再返回默认值，
/// 否则下次写入会直接覆盖掉用户还能抢救的内容。
pub fn read_json_at<T: serde::de::DeserializeOwned>(path: &Path, fallback: T) -> T {
    let Ok(raw) = fs::read_to_string(path) else {
        // 文件不存在属于正常情况（首次运行），静默用默认值
        return fallback;
    };

    match serde_json::from_str::<T>(&raw) {
        Ok(value) => value,
        Err(err) => {
            let backup = corrupt_backup_path(path);
            match fs::rename(path, &backup) {
                Ok(()) => eprintln!(
                    "[浮光] {} 解析失败（{err}），已备份到 {}",
                    path.display(),
                    backup.display()
                ),
                Err(rename_err) => eprintln!(
                    "[浮光] {} 解析失败（{err}），且备份失败（{rename_err}）",
                    path.display()
                ),
            }
            fallback
        }
    }
}

/// 生成损坏文件的备份路径。
///
/// 时间戳后缀而不是固定名：同一个文件反复损坏时不会互相覆盖，
/// 用户能拿到每一份坏数据。
fn corrupt_backup_path(path: &Path) -> PathBuf {
    let stamp = timestamp();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "data".into());
    path.with_file_name(format!("{stem}.corrupt-{stamp}.json"))
}

/// 原子写入 JSON（路径版本，可单测）。
///
/// 先写临时文件再替换：直接覆盖的话，写到一半断电/崩溃会留下半截 JSON，
/// 下次启动就变成"文件损坏"。而临时文件方案下，最坏情况只是丢掉这一次写入，
/// 旧文件依然完整。
pub fn write_json_at<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");

    let json = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败：{e}"))?;

    // Windows 的 rename 不能覆盖已存在的目标，必须先删。
    // 这一步会短暂出现"目标不存在"的窗口，但读侧对文件缺失是容错的，
    // 且写入都在同一进程内串行发生，不会读到中间态。
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("替换旧数据文件失败：{e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("提交数据文件失败：{e}"))?;
    Ok(())
}

/// 读取数据文件（面向 `AppHandle`）。
pub fn read_json<T: serde::de::DeserializeOwned>(app: &AppHandle, file: &str, fallback: T) -> T {
    let Ok(name) = check_file_name(file) else {
        eprintln!("[浮光] 拒绝读取非法文件名：{file}");
        return fallback;
    };
    let Ok(dir) = data_dir(app) else {
        return fallback;
    };
    read_json_at(&dir.join(name), fallback)
}

/// 写入数据文件（面向 `AppHandle`）。
pub fn write_json<T: serde::Serialize>(
    app: &AppHandle,
    file: &str,
    value: &T,
) -> Result<(), String> {
    let name = check_file_name(file)?;
    let dir = data_dir(app)?;
    write_json_at(&dir.join(name), value)
}

/// 用于生成损坏备份文件名的时间戳（秒）。
fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 把数据目录在文件资源管理器中打开，方便用户备份。
pub fn reveal_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_dir(app)
}

/// 校验文件名并拼成数据目录下的完整路径。
pub fn safe_data_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let name = check_file_name(file)?;
    let dir = data_dir(app)?;
    Ok(dir.join(name))
}

// ===============================================================
// 测试
//
// 这一组覆盖的是"出错就会丢用户数据"的部分，所以写得比较细：
// 损坏恢复、原子性、路径穿越。
// ===============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct Item {
        name: String,
        count: u32,
    }

    fn sample() -> Item {
        Item {
            name: "测试".into(),
            count: 7,
        }
    }

    /// 建一个独立的临时目录。
    ///
    /// 用进程 id + 计数器避免并行跑测试时互相踩：
    /// cargo test 默认多线程，共用目录会导致随机失败。
    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "fuguang-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn 写入后能原样读回() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("items.json");

        write_json_at(&path, &vec![sample()]).expect("写入应成功");
        let loaded: Vec<Item> = read_json_at(&path, Vec::new());

        assert_eq!(loaded, vec![sample()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 文件不存在时返回默认值而不是报错() {
        let dir = temp_dir("missing");
        let path = dir.join("nope.json");

        let loaded: Vec<Item> = read_json_at(&path, Vec::new());

        assert!(loaded.is_empty(), "首次运行不该因为文件不存在就失败");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 内容损坏时备份坏文件并回退默认值() {
        let dir = temp_dir("corrupt");
        let path = dir.join("items.json");
        // 半截 JSON，模拟写入过程中断电
        fs::write(&path, r#"[{"name":"未写完""#).expect("写坏文件");

        let loaded: Vec<Item> = read_json_at(&path, Vec::new());

        assert!(loaded.is_empty(), "损坏时应回退默认值");

        // 坏文件必须被改名保留，不能被静默丢弃——用户可能还想抢救里面的内容
        let backups: Vec<_> = fs::read_dir(&dir)
            .expect("读目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1, "应恰好产生一个备份文件，实际：{backups:?}");

        // 原路径应已被让开，后续写入不会覆盖掉备份
        assert!(!path.exists(), "坏文件应已被改名，原路径不再存在");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 损坏备份保留原始内容() {
        let dir = temp_dir("corrupt-keep");
        let path = dir.join("items.json");
        let broken = r#"[{"name":"半截"#;
        fs::write(&path, broken).expect("写坏文件");

        let _: Vec<Item> = read_json_at(&path, Vec::new());

        let backup = fs::read_dir(&dir)
            .expect("读目录")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .expect("应存在备份文件");
        let content = fs::read_to_string(backup.path()).expect("读备份");
        assert_eq!(content, broken, "备份内容必须与损坏前一致");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 类型不匹配也算损坏() {
        // 用户手改成 {"a":1} 而程序期望数组的情况
        let dir = temp_dir("type-mismatch");
        let path = dir.join("items.json");
        fs::write(&path, r#"{"unexpected":"shape"}"#).expect("写文件");

        let loaded: Vec<Item> = read_json_at(&path, Vec::new());

        assert!(loaded.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 写入不留下临时文件() {
        let dir = temp_dir("no-tmp");
        let path = dir.join("items.json");

        write_json_at(&path, &sample()).expect("写入应成功");

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("读目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该残留临时文件：{leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 重复写入会覆盖而不是追加() {
        let dir = temp_dir("overwrite");
        let path = dir.join("items.json");

        write_json_at(&path, &vec![sample(), sample()]).expect("第一次写入");
        write_json_at(&path, &vec![sample()]).expect("第二次写入");

        let loaded: Vec<Item> = read_json_at(&path, Vec::new());
        assert_eq!(loaded.len(), 1, "第二次写入应完全替换第一次的内容");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 路径穿越被拦截() {
        // 这些都必须被拒绝，否则读写能跑到数据目录之外
        for bad in [
            "../secrets.json",
            "..\\secrets.json",
            "sub/dir.json",
            "sub\\dir.json",
            "C:evil.json",
            "stream:name",
            "",
        ] {
            assert!(
                check_file_name(bad).is_err(),
                "应拒绝非法文件名：{bad:?}"
            );
        }
    }

    #[test]
    fn 正常文件名被接受() {
        for good in ["snippets.json", "timers.json", "a", "a.b.c.json"] {
            assert_eq!(
                check_file_name(good).expect("应接受"),
                good,
                "正常文件名不该被误拦：{good}"
            );
        }
    }

    #[test]
    fn 空文件名被拒绝() {
        assert!(check_file_name("").is_err());
    }

    #[test]
    fn 写入中文内容能原样读回() {
        // 中文是最容易在编码上出问题的地方，值得单独断言一次
        let dir = temp_dir("utf8");
        let path = dir.join("items.json");
        let item = Item {
            name: "煮蛋计时器 · 已完成 ✅".into(),
            count: 42,
        };

        write_json_at(&path, &item).expect("写入");
        let loaded: Item = read_json_at(&path, Item {
            name: String::new(),
            count: 0,
        });

        assert_eq!(loaded, item);
        let _ = fs::remove_dir_all(&dir);
    }
}
