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

/// 剥掉开头的 UTF-8 BOM（如果有）。
///
/// 记事本"另存为"默认可能写 BOM，而 `serde_json` 不认它，会报
/// `expected value at line 1 column 1`。BOM 是**无损可剥**的，把它当
/// "文件损坏"处理会让用户白白丢一次数据 —— 曾经真的这样丢过一整份设置。
///
/// 抽成函数是因为这个坑在**两条**路径上都有：读数据文件（`read_json_at`）
/// 和导入备份（`backup::import`）。修了一处漏另一处，等于没修。
pub fn strip_bom(raw: &str) -> &str {
    raw.trim_start_matches('\u{feff}')
}

/// 读取 JSON 文件（路径版本，可单测）。
///
/// **只有"文件不存在"才静默返回 `fallback`**（首次运行的正常情况）。
/// 读失败与解析失败都要先把文件改名备份，再返回默认值。
///
/// # 为什么读失败也要备份
///
/// 调用方拿到默认值后往往会紧接着写一次（例如设置页随便改一项就整份覆盖写），
/// 不备份的话原文件当场就被覆盖了，用户没有任何抢救机会。
/// 「文件被占用/权限不足/不是 UTF-8」都不等于「文件不存在」，
/// 把它们当成空的，用户看到的是"我的数据全没了"。
///
/// # 为什么先剥 BOM
///
/// 记事本保存 JSON 时默认可能带 UTF-8 BOM，而 `serde_json` 不认它，
/// 会报 `expected value at line 1 column 1`。BOM 是**无损可剥**的，
/// 把它当"文件损坏"处理会让用户白白丢一次全部设置。
pub fn read_json_at<T: serde::de::DeserializeOwned>(path: &Path, fallback: T) -> T {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // 首次运行：文件还没生成过，正常情况，静默用默认值
            return fallback;
        }
        Err(err) => {
            quarantine(path, &format!("读取失败（{err}）"));
            return fallback;
        }
    };

    // 只剥开头的 BOM，不动文件内容里的任何字符
    let raw = strip_bom(&raw);

    match serde_json::from_str::<T>(raw) {
        Ok(value) => value,
        Err(err) => {
            quarantine(path, &format!("解析失败（{err}）"));
            fallback
        }
    }
}

/// 把读不了 / 解析不了的文件改名留证，并打一条日志。
///
/// 改名而不是删除：用户还能自己去 `%APPDATA%\浮光\` 把内容捞回来。
/// 改名失败（例如文件被别的进程锁着）只记日志——至少不再是静默。
fn quarantine(path: &Path, why: &str) {
    let backup = corrupt_backup_path(path);
    match fs::rename(path, &backup) {
        Ok(()) => eprintln!(
            "[浮光] {} {why}，已备份到 {}",
            path.display(),
            backup.display()
        ),
        Err(rename_err) => eprintln!(
            "[浮光] {} {why}，且备份失败（{rename_err}）",
            path.display()
        ),
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
    let json = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;

    // 临时文件名必须唯一。`settings_save` / `hotkey_apply` / `autostart_set`
    // 都是 async 命令，跑在多线程 runtime 上，同一个文件可能被并发写；
    // 固定叫 `x.json.tmp` 的话两个写者会互相踩（后写的覆盖前写的临时内容，
    // 或者前一个已经 rename 走、后一个 rename 报 ENOENT）。
    let tmp = unique_tmp_path(path);
    if let Err(err) = fs::write(&tmp, json) {
        // 失败也要清掉临时文件。
        //
        // `fs::write` 会先创建文件再写内容，所以在"创建成功、写内容失败"时
        // （磁盘满 ENOSPC 最典型，也可能写到一半进程被杀）会留下一个残缺的 .tmp。
        // 而它永远不会被读取，只会一直堆在用户的数据目录里 ——
        // 用户打开数据目录会看到一堆 `timers.json.1234-5.tmp` 这样的垃圾，
        // 每个还都长得像数据文件。
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入临时文件失败：{err}"));
    }

    // 直接 rename 覆盖，**不要**先 remove_file。
    //
    // Rust 的 `std::fs::rename` 在 Windows 上走
    // `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`，本来就能覆盖已存在的目标。
    // 先删再改名反而制造了一个"目标文件不存在"的窗口：一旦 rename 失败
    // （磁盘满、被占用、断电），旧数据已经删了、新数据还在 .tmp 里，
    // 而读取侧永远不读 .tmp —— 用户看到的就是"数据全没了"。
    if let Err(err) = fs::rename(&tmp, path) {
        // 提交失败就别把半成品留在用户的数据目录里
        let _ = fs::remove_file(&tmp);
        return Err(format!("提交数据文件失败：{err}"));
    }
    Ok(())
}

/// 临时文件名里的进程内单调计数器。
///
/// # 为什么不能只靠时间戳
///
/// 原来用的是"进程 id + 纳秒"，并假设纳秒唯一。**实测不成立**：
/// Windows 的系统时钟粒度是 100ns，同一纳秒里取两次时间是常事 ——
/// 本机连续取 20 万次时间戳，有约 **16%** 与前一次完全相同；
/// 8 线程各生成 1 万个临时名，8 万个名字去重后只剩 6.6 万个（撞掉 17%）。
///
/// 撞名之后两个写者会互相截断对方的临时文件，或者其中一个 `rename` 拿到
/// ENOENT、报出莫名其妙的"提交数据文件失败"。计数器才是真正的唯一性来源。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 给目标文件生成一个**同目录**下、带唯一后缀的临时路径。
///
/// 必须同目录：`rename` 跨卷会失败（`MoveFileExW` 不支持跨卷移动）。
fn unique_tmp_path(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "data.json".into());
    // 进程 id 区分不同进程，计数器保证同一进程内绝不重复
    path.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()))
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

    // ===========================================================
    // 以下四条对应一次真实事故：用户用记事本把 settings.json 存成
    // 「UTF-8 带 BOM」，重启后整个文件被判为损坏、全部设置回到默认值。
    // ===========================================================

    #[test]
    fn 带_bom_的_json_能正常读回而不是被判损坏() {
        let dir = temp_dir("bom");
        let path = dir.join("items.json");

        // 记事本存「UTF-8 带 BOM」就是这个字节序列
        let body = serde_json::to_string(&sample()).expect("序列化");
        fs::write(&path, format!("\u{feff}{body}")).expect("写文件");

        let loaded: Item = read_json_at(&path, Item {
            name: String::new(),
            count: 0,
        });

        assert_eq!(loaded, sample(), "BOM 应该被剥掉，而不是当成损坏");
        assert!(path.exists(), "原文件必须还在，不该被改名");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 文件不存在时不该留下任何备份文件() {
        // "不存在"是首次运行的正常情况，不能每启动一次就产生一个 .corrupt
        let dir = temp_dir("no-backup");
        let path = dir.join("nope.json");

        let _: Vec<Item> = read_json_at(&path, Vec::new());

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("读目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "文件不存在时不该产生任何文件，实际：{leftovers:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 读失败也会备份而不是静默当成空() {
        // 用 GBK 存过的文件读不成 UTF-8。旧行为是静默返回空列表，
        // 用户随后任何一次写入都会把原文件彻底覆盖掉。
        let dir = temp_dir("gbk");
        let path = dir.join("items.json");

        // "测试" 的 GBK 编码，保证不是合法 UTF-8
        fs::write(&path, [0xB2u8, 0xE2, 0xCA, 0xD4]).expect("写文件");

        let loaded: Vec<Item> = read_json_at(&path, Vec::new());
        assert!(loaded.is_empty(), "读失败应回退默认值");

        let backups: Vec<_> = fs::read_dir(&dir)
            .expect("读目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1, "读失败必须留下备份，实际：{backups:?}");

        // 备份必须保留原始字节，否则"留证"没意义
        let raw = fs::read(dir.join(&backups[0])).expect("读备份");
        assert_eq!(raw, vec![0xB2u8, 0xE2, 0xCA, 0xD4]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_能覆盖已存在的文件() {
        // 这条不是测我们的代码，是**测我们的假设**：
        // `write_json_at` 去掉了"先删后改名"，前提是 std::fs::rename
        // 在 Windows 上能覆盖已存在的目标（MoveFileExW + MOVEFILE_REPLACE_EXISTING）。
        // 如果这个假设错了，去掉 remove_file 会让写入直接失败 —— 必须钉死。
        let dir = temp_dir("rename-overwrite");
        let dst = dir.join("dst.json");
        let src = dir.join("src.json");

        fs::write(&dst, "旧内容").expect("写目标");
        fs::write(&src, "新内容").expect("写源");

        fs::rename(&src, &dst).expect("rename 必须能覆盖已存在的目标");

        assert_eq!(fs::read_to_string(&dst).expect("读目标"), "新内容");
        assert!(!src.exists(), "源文件应该已经被移走");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 并发写同一文件不会互相踩() {
        // 固定临时文件名时，两个写者会算出同一个 .tmp。
        // 这里起 8 个线程同时写同一个文件，最后内容必须是其中完整的一份，
        // 而且不能留下任何 .tmp 残骸。
        let dir = temp_dir("concurrent");
        let path = dir.join("items.json");
        let mut handles = Vec::new();

        for i in 0..8u32 {
            let p = path.clone();
            handles.push(std::thread::spawn(move || {
                let item = Item {
                    name: format!("写者{i}"),
                    count: i,
                };
                write_json_at(&p, &item).expect("并发写入不该失败");
            }));
        }
        for h in handles {
            h.join().expect("线程不该 panic");
        }

        let loaded: Item = read_json_at(&path, Item {
            name: String::new(),
            count: 0,
        });
        assert!(
            (0..8).contains(&loaded.count),
            "读回来的必须是某一次完整写入，实际：{loaded:?}"
        );

        let tmps: Vec<_> = fs::read_dir(&dir)
            .expect("读目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(tmps.is_empty(), "不该留下临时文件，实际：{tmps:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 临时文件名在进程内绝不重复() {
        // 只靠"进程 id + 纳秒"是不够的：Windows 系统时钟粒度实测 100ns，
        // 约 16% 的连续取值完全相同。撞名之后两个写者会互相截断对方的临时文件，
        // 或者其中一个 rename 拿到 ENOENT 报出莫名其妙的"保存失败"。
        // 计数器才是唯一性来源 —— 这条测试就是钉住它。
        let dir = temp_dir("tmp-unique");
        let path = dir.join("items.json");

        let names: std::collections::HashSet<String> = (0..10_000)
            .map(|_| {
                unique_tmp_path(&path)
                    .file_name()
                    .expect("有文件名")
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        assert_eq!(names.len(), 10_000, "临时文件名撞了");
        // 必须同目录：跨卷 rename 会失败
        assert!(unique_tmp_path(&path).starts_with(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 剥_bom_不会动正文里的字符() {
        assert_eq!(strip_bom("\u{feff}{\"a\":1}"), "{\"a\":1}");
        assert_eq!(strip_bom("{\"a\":1}"), "{\"a\":1}");
        // 只在开头剥：正文中间出现的 U+FEFF 是内容，不能动
        assert_eq!(strip_bom("{\"a\":\"\u{feff}\"}"), "{\"a\":\"\u{feff}\"}");
    }
}
