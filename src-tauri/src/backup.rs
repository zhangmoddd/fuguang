//! 全量数据的导出与导入。
//!
//! # 为什么是一个 JSON 文件而不是 zip
//!
//! 打包压缩要引压缩库，而本项目对发布体积很敏感（每个依赖都直接进 exe，
//! 见 README 的体积表）。全量数据本来就是几份纯文本 JSON，拼成一个文件已经够用；
//! 更重要的是用户能**直接用记事本打开检查**——"备份文件看不懂"本身就是一种不放心。
//!
//! # 文本片段为什么是「原样搬运」
//!
//! 计时器 / 备忘 / 链接 / 文件夹在 Rust 侧都有结构，可以强类型序列化。
//! 但文本片段走的是前端的通用 JSON 文件接口（`read_data` / `write_data`），
//! Rust 不认识它的形状。
//!
//! 所以这里用 `serde_json::Value` 原样读、原样写。好处是前端以后给片段加字段，
//! 导出/导入**不需要同步改 Rust**，也不会因为 Rust 侧结构落后而把新字段悄悄丢掉。
//!
//! # 导入的顺序：先全部写盘，再更新内存
//!
//! 六份文件没法做成一个事务。折中办法是：**六份都写成功之后，最后一步才动内存**。
//! 中途失败时磁盘上最多是"部分新、部分旧"，但内存里仍然是导入前的完整状态，
//! 用户不会在界面上看到半套数据。
//!
//! 另外，`state.rs` 有一条约定：**持锁期间不做任何 IO**。所以写盘全部放在
//! 拿锁之前，拿锁之后只做赋值。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::models::{now_ms, Folder, Link, Memo, Settings, Timer};
use crate::state::{self, Store};
use crate::storage;

/// 备份文件里用来认领「这是浮光的备份」的标识。
///
/// 用户手滑选错文件时靠它挡住，而不是把别家的 JSON 导进来把数据冲掉。
const APP_ID: &str = "fuguang";

/// 备份格式版本。
///
/// 导入时只接受**小于等于**这个值：来自更新版本的备份可能带着当前版本不认识的
/// 字段，硬导进来会静默丢数据，不如明确拒绝并让用户先升级。
pub const BACKUP_VERSION: u32 = 1;

/// 文本片段的数据文件名。它由前端读写，Rust 只做搬运。
const FILE_SNIPPETS: &str = "snippets.json";

/// 备份文件的信封。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    /// 固定标识，见 [`APP_ID`]。
    pub app: String,
    pub version: u32,
    /// 导出时刻（Unix 毫秒）。只用于用户自己辨认"这份是什么时候的"。
    pub exported_at: i64,
    pub data: BackupData,
}

/// 备份文件里的全部数据。
///
/// # 为什么每一段都是 `Option`
///
/// `None` 表示「这份备份里**没有**这一段」，导入时保持当前数据不动。
/// 用户手写的部分备份、或将来把数据拆得更细的情况，都靠这个语义。
///
/// ⚠️ serde **分不清**「字段缺失」和「显式写了 `null`」—— 两者都反序列化成 `None`。
/// 所以 `"snippets": null` 与"根本没写 snippets"是同一个意思（都表示"别动这一段"），
/// 想表达"把这一段清空"必须写 `"snippets": []`。
/// 当前 `export` 总是写真实值、不会产出 `null`，所以这只影响手写或裁剪过的备份。
///
/// ⚠️ 不能图省事拿 `Vec::default()` / `Value::Null` 当"缺失"的默认值：
/// 那样「缺这一项」会被当成「这一项是空的」，导入就等于把用户的数据全部清掉，
/// 而且导入前不备份、不可恢复。`settings` 那一段一直是对的，其余五段曾经是错的。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupData {
    /// 文本片段：原样搬运，理由见文件头。
    #[serde(default)]
    pub snippets: Option<Value>,
    #[serde(default)]
    pub timers: Option<Vec<Timer>>,
    #[serde(default)]
    pub memos: Option<Vec<Memo>>,
    #[serde(default)]
    pub links: Option<Vec<Link>>,
    #[serde(default)]
    pub folders: Option<Vec<Folder>>,
    /// 设置。`None` 表示这份备份里没有设置，导入时保持当前设置不动。
    #[serde(default)]
    pub settings: Option<Settings>,
}

/// 把全部数据写成一个备份文件。
pub fn export(app: &AppHandle, path: &Path) -> Result<(), String> {
    let store = app.state::<Store>();

    // 取快照必须在**写锁内**。
    //
    // 不然一次 `import` 正在写锁内逐份写盘时执行导出，会读到
    // 「snippets 是导入后的、timers 还是导入前的」这种**混合快照** ——
    // 用户拿它去换电脑，得到的是一份谁也不是的数据。
    //
    // 内存那五段还要在**同一次取锁**里全部取出来，否则它们彼此之间也可能不一致。
    // 落盘放在锁外：写的是另一个文件（备份文件），没必要占着应用数据的写锁。
    let backup = state::with_write_lock(|| {
        let (timers, memos, links, folders, settings) = {
            let st = store.lock();
            (
                st.timers.clone(),
                st.memos.clone(),
                st.links.clone(),
                st.folders.clone(),
                st.settings.clone(),
            )
        };

        Backup {
            app: APP_ID.into(),
            version: BACKUP_VERSION,
            exported_at: now_ms(),
            data: BackupData {
                snippets: Some(storage::read_json(
                    app,
                    FILE_SNIPPETS,
                    Value::Array(Vec::new()),
                )),
                timers: Some(timers),
                memos: Some(memos),
                links: Some(links),
                folders: Some(folders),
                settings: Some(settings),
            },
        }
    });

    storage::write_json_at(path, &backup)
}

/// 校验信封：是不是浮光的备份、版本认不认得。
///
/// 抽成独立函数是为了能直接单测——`import` 需要 `AppHandle`，
/// 而单测里造不出一个真的 Tauri 应用。
fn check_envelope(app_id: &str, version: u32) -> Result<(), String> {
    if app_id != APP_ID {
        return Err("这个文件不是浮光的备份".into());
    }
    if version > BACKUP_VERSION {
        return Err(format!(
            "备份来自更新的版本（v{version}），当前版本只认到 v{BACKUP_VERSION}，请先升级浮光"
        ));
    }
    Ok(())
}

/// 从备份文件恢复全部数据。**会覆盖当前的全部数据。**
pub fn import(app: &AppHandle, path: &Path) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读不到这个文件：{e}"))?;
    // 剥掉 UTF-8 BOM：记事本"另存为"常带它，而 serde_json 不认，
    // 会报 `expected value at line 1 column 1` —— 用户会以为备份文件坏了，
    // 其实它是好的。`storage::read_json_at` 早就剥了，这里是同一个坑的另一条路径。
    let text = storage::strip_bom(&raw);

    let backup: Backup = serde_json::from_str(text)
        .map_err(|e| format!("这个文件不是浮光的备份（解析失败：{e}）"))?;

    check_envelope(&backup.app, backup.version)?;

    // 设置要过一遍夹取：备份文件同样可能被手改过，一个越界字号能让界面没法用
    let mut settings = backup.data.settings;
    if let Some(s) = settings.as_mut() {
        s.clamp();
    }

    // 整段「写六份文件 + 改内存」必须**独占写锁**。
    //
    // 不独占的话调度线程会插进来：它拿的是导入前的内存快照，
    // 于是刚写好的文件被旧数据盖回去 —— 界面显示「恢复成功」，
    // 重启后却变回旧值（已用确定性交错复现）。
    // 它自己的 `state::persist` 也要拿同一把写锁，所以会老老实实排在后面，
    // 拿到的是导入**之后**的最新快照。
    state::with_write_lock(move || -> Result<(), String> {
        // ---- 先全部写盘 ----
        // 任何一步失败都直接返回，内存不动，用户看到的还是导入前那套完整数据。
        //
        // 每一段都只在备份里**确实带了这一项**时才写。缺失 ≠ 空：
        // 把缺失当成空，一次「部分备份」的导入就会把用户其它数据全清掉。
        if let Some(v) = backup.data.snippets.as_ref() {
            storage::write_json(app, FILE_SNIPPETS, v)?;
        }
        if let Some(v) = backup.data.timers.as_ref() {
            state::save_timers(app, v)?;
        }
        if let Some(v) = backup.data.memos.as_ref() {
            state::save_memos(app, v)?;
        }
        if let Some(v) = backup.data.links.as_ref() {
            state::save_links(app, v)?;
        }
        if let Some(v) = backup.data.folders.as_ref() {
            state::save_folders(app, v)?;
        }
        if let Some(s) = settings.as_ref() {
            state::save_settings(app, s)?;
        }

        // ---- 全部成功，最后才动内存 ----
        // 持锁期间只赋值、不做 IO（state.rs 的约定）
        {
            let store = app.state::<Store>();
            let mut st = store.lock();
            if let Some(v) = backup.data.timers {
                st.timers = v;
            }
            if let Some(v) = backup.data.memos {
                st.memos = v;
            }
            if let Some(v) = backup.data.links {
                st.links = v;
            }
            if let Some(v) = backup.data.folders {
                st.folders = v;
            }
            if let Some(s) = settings {
                st.settings = s;
            }
        }

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 信封字段是驼峰命名() {
        // 备份文件是给用户看的，字段名必须和前端、和其余数据文件一致
        let backup = Backup {
            app: APP_ID.into(),
            version: BACKUP_VERSION,
            exported_at: 1_800_000_000_000,
            data: BackupData::default(),
        };
        let json = serde_json::to_string(&backup).expect("序列化");

        assert!(json.contains("\"exportedAt\""), "实际：{json}");
        assert!(json.contains("\"version\":1"));
        assert!(!json.contains("exported_at"), "不该出现下划线命名");
    }

    #[test]
    fn 只有信封和空数据的备份也能解析() {
        // 用户手写的部分备份、或将来把数据拆得更细的情况
        let json = r#"{ "app": "fuguang", "version": 1, "exportedAt": 1, "data": {} }"#;
        let b: Backup = serde_json::from_str(json).expect("必须能解析");

        // 缺失必须是 None（导入时保持不动），**不能**是空 Vec / Value::Null ——
        // 后者会让一次「部分备份」的导入把用户其它数据全部清空，且不可恢复。
        assert!(b.data.snippets.is_none());
        assert!(b.data.timers.is_none());
        assert!(b.data.memos.is_none());
        assert!(b.data.links.is_none());
        assert!(b.data.folders.is_none());
        assert!(b.data.settings.is_none(), "没有设置就保持当前设置不动");
    }

    #[test]
    fn 老版本导出的完整备份能被原样认出来() {
        // **向后兼容的守门测试。**
        //
        // 字段从 `Value` / `Vec<T>` 改成 `Option<...>` 时，最大的风险是
        // "老备份导进来变成缺失、于是整段被静默跳过"。这里用一份
        // **改动之前 export 出来的完整备份**（六个字段齐全）钉住这个保证。
        let json = r#"{
            "app": "fuguang", "version": 1, "exportedAt": 1800000000000,
            "data": {
                "snippets": [{ "id": "s1", "content": "老片段" }],
                "timers": [], "memos": [], "links": [], "folders": [],
                "settings": { "fontSizePx": 15 }
            }
        }"#;
        let b: Backup = serde_json::from_str(json).expect("老备份必须能解析");

        // 六段必须全部被认成"有"，一段都不能变成 None
        assert!(b.data.snippets.is_some(), "snippets 不该被当成缺失");
        assert!(b.data.timers.is_some());
        assert!(b.data.memos.is_some());
        assert!(b.data.links.is_some());
        assert!(b.data.folders.is_some());
        assert!(b.data.settings.is_some(), "settings 不该被当成缺失");

        // 内容也要真的读进来，而不是只认了个壳
        let snippets = b.data.snippets.as_ref().expect("有");
        assert_eq!(snippets.as_array().expect("是数组").len(), 1);
        assert_eq!(b.data.settings.as_ref().expect("有").font_size_px, 15);
    }

    #[test]
    fn 新导出的备份与老格式形状一致() {
        // 反向保证：`Some(x)` 序列化出来就是 `x`，所以新备份的 JSON 形状
        // 与改动前完全一样 —— 老版本的程序也能读新备份。
        let backup = Backup {
            app: APP_ID.into(),
            version: BACKUP_VERSION,
            exported_at: 1,
            data: BackupData {
                snippets: Some(Value::Array(Vec::new())),
                timers: Some(Vec::new()),
                memos: Some(Vec::new()),
                links: Some(Vec::new()),
                folders: Some(Vec::new()),
                settings: None,
            },
        };
        let json = serde_json::to_string(&backup).expect("序列化");

        // 不能出现 `"snippets":null` 这种形状（那是 `None` 才有的）
        assert!(json.contains("\"snippets\":[]"), "实际：{json}");
        assert!(!json.contains("\"snippets\":null"));
        // settings 为 None 时才是 null，老代码把它读成"没有设置"，语义一致
        assert!(json.contains("\"settings\":null"));
    }

    #[test]
    fn 带内容的备份里每一段都是有() {
        // 与上一条配对：真带了数据的备份必须被认成"有"，否则导入会静默不生效
        let json = r#"{
            "app": "fuguang", "version": 1, "exportedAt": 1,
            "data": { "snippets": [], "timers": [], "memos": [], "links": [], "folders": [] }
        }"#;
        let b: Backup = serde_json::from_str(json).expect("必须能解析");

        // 显式给了空数组就是"用户确实要把这一段清空"，和"没带这一段"是两回事
        assert_eq!(b.data.snippets, Some(Value::Array(Vec::new())));
        // Timer/Memo/Link/Folder 没实现 PartialEq，所以断言 is_some + 为空
        for (name, ok) in [
            ("timers", b.data.timers.as_ref().is_some_and(|v| v.is_empty())),
            ("memos", b.data.memos.as_ref().is_some_and(|v| v.is_empty())),
            ("links", b.data.links.as_ref().is_some_and(|v| v.is_empty())),
            ("folders", b.data.folders.as_ref().is_some_and(|v| v.is_empty())),
        ] {
            assert!(ok, "{name} 显式给了空数组就该被认成「有」，而不是缺失");
        }
    }

    #[test]
    fn 不是浮光的备份会被拒绝() {
        let err = check_envelope("some-other-app", 1).expect_err("必须拒绝");
        assert!(err.contains("不是浮光"), "错误信息要能直接给用户看：{err}");
    }

    #[test]
    fn 更新版本的备份会被拒绝而不是静默丢数据() {
        // 新版本可能加了当前版本不认识的字段，硬导进来会悄悄丢掉它们
        let err = check_envelope(APP_ID, BACKUP_VERSION + 1).expect_err("必须拒绝");
        assert!(err.contains("更新的版本"), "实际：{err}");
    }

    #[test]
    fn 同版本与更旧版本的备份都能导入() {
        assert!(check_envelope(APP_ID, BACKUP_VERSION).is_ok());
        assert!(check_envelope(APP_ID, 1).is_ok());
    }
}
