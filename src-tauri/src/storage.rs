//! 数据目录与 JSON 存储。
//!
//! 设计决策：数据固定放在 `%APPDATA%\浮光\`。
//! 原因是要发布到 GitHub 给其他人用，而用户可能把 exe 放在只读目录
//! （例如 `C:\Program Files\`），放在 exe 旁边会直接写入失败。
//! 同时这个位置对开发模式和正式版是同一份数据，不会出现「开发时记的东西正式版看不见」。

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

/// 读取 JSON 文件。
///
/// 文件不存在或内容损坏时返回 `fallback`，而不是报错。
/// 理由：数据文件是纯文本、用户可能手动编辑；一次手滑不该让软件打不开。
pub fn read_json<T: serde::de::DeserializeOwned>(app: &AppHandle, file: &str, fallback: T) -> T {
    let Ok(dir) = data_dir(app) else {
        return fallback;
    };
    let path = dir.join(file);
    let Ok(raw) = fs::read_to_string(&path) else {
        return fallback;
    };
    match serde_json::from_str::<T>(&raw) {
        Ok(value) => value,
        Err(err) => {
            // 备份损坏文件，让用户有机会自己抢救，同时不阻塞启动
            let backup = path.with_extension(format!("corrupt-{}.json", timestamp()));
            let _ = fs::rename(&path, &backup);
            eprintln!("[浮光] {file} 解析失败（{err}），已备份到 {}", backup.display());
            fallback
        }
    }
}

/// 原子写入 JSON：先写临时文件再替换，避免写入中途断电导致数据文件损坏。
pub fn write_json<T: serde::Serialize>(app: &AppHandle, file: &str, value: &T) -> Result<(), String> {
    let dir = data_dir(app)?;
    let path = dir.join(file);
    let tmp = dir.join(format!("{file}.tmp"));

    let json = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败：{e}"))?;

    // Windows 上 rename 无法覆盖已存在的文件，先删目标
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("替换旧数据文件失败：{e}"))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("提交数据文件失败：{e}"))?;
    Ok(())
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
    let dir = data_dir(app)?;
    Ok(dir)
}

/// 判断给定路径是否位于数据目录内（用于校验前端传来的文件名，防止路径穿越）。
pub fn safe_data_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    if file.contains("..") || file.contains('/') || file.contains('\\') {
        return Err("非法文件名".into());
    }
    let dir = data_dir(app)?;
    let path = dir.join(file);
    debug_assert!(path.starts_with(Path::new(&dir)));
    Ok(path)
}
