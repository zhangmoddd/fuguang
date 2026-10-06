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
//! # 图片为什么必须一起带（v2）
//!
//! 图片的像素**不在** JSON 里，它们是 `%APPDATA%\浮光\media\` 下的独立文件
//! （见 [`crate::media`]）。只备份六份 JSON 的话，「备份 → 换台电脑 → 恢复」
//! 之后图片全都不在，而数据里还留着引用 —— 界面上是一片裂图，
//! 用户完全不知道发生了什么。所以 v2 把**被引用到的**图片以 base64 嵌进
//! 备份文件的一个 `media` 映射里。
//!
//! 为什么只带"被引用到的"而不是整个 `media/` 目录：库里可能留着用户已经删掉的
//! 条目留下的孤儿图片，全带会让备份白白大出几十兆。
//!
//! # 导入的顺序：先全部写盘，再更新内存
//!
//! 六份文件没法做成一个事务。折中办法是：**六份都写成功之后，最后一步才动内存**。
//! 中途失败时磁盘上最多是"部分新、部分旧"，但内存里仍然是导入前的完整状态，
//! 用户不会在界面上看到半套数据。
//!
//! 另外，`state.rs` 有一条约定：**持锁期间不做任何 IO**。所以写盘全部放在
//! 拿锁之前，拿锁之后只做赋值。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::linkicon::base64_encode;
use crate::media;
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
///
/// # 版本历史
///
/// - v1：六段数据（片段 / 计时器 / 备忘 / 链接 / 文件夹 / 设置），**不含图片**。
/// - v2：多一个 `media` 映射，把被引用到的图片以 base64 带上。
///
/// v1 的备份**必须**仍然能导入（那时还没有图片功能，`media` 缺失即"没有图片"）；
/// 反过来 v2 被旧版本拒绝是**正确**的：旧版本读不了 `media` 这一段，
/// 硬导进去会得到一堆指向不存在图片的引用。
pub const BACKUP_VERSION: u32 = 2;

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
    /// 被引用到的图片：`图片 id → 原图字节的 base64`。
    ///
    /// v1 的备份没有这一段（读出来是 `None`），那时也还没有图片功能，
    /// 所以"没有"就等于"没有图片"，导入时不去动 `media/` 目录里已有的文件 ——
    /// **绝不能把"没有这一段"当成"要把图片全删掉"**。
    ///
    /// 用 `BTreeMap` 而不是 `HashMap`：备份文件是给用户看的，
    /// 键按字典序排好之后 diff 两份备份能直接看出差异。
    #[serde(default)]
    pub media: Option<BTreeMap<String, String>>,
}

/// 导入结果。
///
/// # 为什么导入要返回东西
///
/// 「引用存在但图片没带回来」是**必须报出来**的情况：那些位置在界面上是裂图，
/// 而用户刚看到"恢复成功"。不报的话他只能自己一张张翻过去找。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 备份里带回、并写进 `media/` 的图片张数。
    pub media_written: u64,
    /// 导入进来的数据**引用到**、但库里没有的图片 id。
    ///
    /// 空数组表示"引用到的图片全都在"。调用方应当把它显示给用户。
    pub missing_media: Vec<String>,
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
        let snippets = storage::read_json(app, FILE_SNIPPETS, Value::Array(Vec::new()));

        // 只带**被引用到的**图片（理由见文件头）。读文件放在写锁内：
        // 图片是数据的一部分，"哪些图片被引用"与上面的快照必须来自同一刻。
        let mut media_map = BTreeMap::new();
        for id in referenced_media_ids(&memos, &snippets) {
            match media::read_original_bytes(app, &id) {
                Some(bytes) => {
                    media_map.insert(id, base64_encode(&bytes));
                }
                // 引用了一张已经不在库里的图片：备份里就没有它。
                // 记一条日志，导入时那边还会再报一次（用户能看见）。
                None => crate::diag!("[浮光] 备份：图片 {id} 被引用但不在库里"),
            }
        }

        Backup {
            app: APP_ID.into(),
            version: BACKUP_VERSION,
            exported_at: now_ms(),
            data: BackupData {
                snippets: Some(snippets),
                timers: Some(timers),
                memos: Some(memos),
                links: Some(links),
                folders: Some(folders),
                settings: Some(settings),
                media: Some(media_map),
            },
        }
    });

    storage::write_json_at(path, &backup)
}

/// 挑出全部被引用到的图片 id（去重、按字典序）。
///
/// # 为什么要能处理"前端拥有的"片段数据
///
/// `Snippet` 在 Rust 侧没有结构（见文件头），它的 `images` 字段只有前端知道，
/// 所以这里按形状走一遍 JSON：顶层是数组，每项是可选的 `images` 数组，
/// 每张图有一个 `id` 字符串。形状对不上就跳过 —— 备份绝不能因为
/// 某条片段被用户手改坏而整个失败。
pub fn referenced_media_ids(memos: &[Memo], snippets: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();

    for memo in memos {
        for image in &memo.images {
            ids.push(image.id.clone());
        }
    }

    if let Some(list) = snippets.as_array() {
        for item in list {
            let Some(images) = item.get("images").and_then(|v| v.as_array()) else {
                continue;
            };
            for image in images {
                if let Some(id) = image.get("id").and_then(|v| v.as_str()) {
                    ids.push(id.to_string());
                }
            }
        }
    }

    ids.retain(|id| !id.is_empty());
    ids.sort();
    ids.dedup();
    ids
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
///
/// 返回导入报告（带回了多少张图片、哪些引用缺图），见 [`ImportReport`]。
pub fn import(app: &AppHandle, path: &Path) -> Result<ImportReport, String> {
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

    // 整段「写六份文件 + 写图片 + 改内存」必须**独占写锁**。
    //
    // 不独占的话调度线程会插进来：它拿的是导入前的内存快照，
    // 于是刚写好的文件被旧数据盖回去 —— 界面显示「恢复成功」，
    // 重启后却变回旧值（已用确定性交错复现）。
    // 它自己的 `state::persist` 也要拿同一把写锁，所以会老老实实排在后面，
    // 拿到的是导入**之后**的最新快照。
    state::with_write_lock(move || -> Result<ImportReport, String> {
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

        // ---- 图片 ----
        // 只写备份里带的那些；**不删**库里多出来的（v1 备份没有这一段，
        // 把它当成"图片全删掉"会是灾难性的）。多出来的图片只是不再被引用。
        let mut report = ImportReport::default();
        if let Some(media_map) = backup.data.media.as_ref() {
            for (id, encoded) in media_map {
                let bytes = crate::media::base64_decode(encoded)
                    .map_err(|e| format!("备份里的图片 {id} 解码失败：{e}"))?;
                media::write_original(app, id, &bytes)
                    .map_err(|e| format!("写回图片 {id} 失败：{e}"))?;
                report.media_written += 1;
            }
        }

        // ---- 报告缺图 ----
        // 只对**这次真的导入了的数据**报告：没导入的那几段里就算有引用，
        // 也不该拿来吓唬用户（那些数据本来就没被这次导入碰过）。
        let referenced = match (backup.data.memos.as_ref(), backup.data.snippets.as_ref()) {
            (None, None) => Vec::new(),
            (memos, snippets) => referenced_media_ids(
                memos.map(Vec::as_slice).unwrap_or(&[]),
                snippets.unwrap_or(&Value::Null),
            ),
        };
        report.missing_media = referenced
            .into_iter()
            .filter(|id| !media::exists(app, id))
            .collect();

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

        Ok(report)
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
        assert!(json.contains("\"version\":2"), "版本要跟着 BACKUP_VERSION 走：{json}");
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
        assert!(
            b.data.media.is_none(),
            "v1 的备份没有图片段 —— 缺失必须读成 None，而不是空表"
        );
    }

    #[test]
    fn v1_的老备份仍然能导入_图片为空() {
        // **向后兼容的守门测试。**
        //
        // v1 是"还没有图片功能"的版本，它导出的备份里根本没有 `media` 这一段。
        // 现在版本提到 v2，导入必须照样接受 v1：拒绝的话用户换台电脑就恢复不了
        // 自己上个月的数据。
        let json = r#"{
            "app": "fuguang", "version": 1, "exportedAt": 1800000000000,
            "data": {
                "snippets": [{ "id": "s1", "content": "老片段" }],
                "timers": [], "memos": [], "links": [], "folders": [],
                "settings": { "fontSizePx": 15 }
            }
        }"#;
        let b: Backup = serde_json::from_str(json).expect("v1 备份必须能解析");

        assert!(check_envelope(&b.app, b.version).is_ok(), "v1 必须被接受");
        assert!(b.data.media.is_none(), "v1 没有图片段");
        // 六段必须全部被认成"有"，一段都不能变成 None
        assert!(b.data.snippets.is_some(), "snippets 不该被当成缺失");
        assert!(b.data.timers.is_some());
        assert!(b.data.memos.is_some());
        assert!(b.data.links.is_some());
        assert!(b.data.folders.is_some());
        assert!(b.data.settings.is_some(), "settings 不该被当成缺失");
    }

    #[test]
    fn v2_备份能带回图片且形状是_id_到_base64() {
        let json = r#"{
            "app": "fuguang", "version": 2, "exportedAt": 1,
            "data": {
                "memos": [{
                    "id": "m1", "date": "2026-09-19", "title": "t",
                    "images": [{ "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "name": "a.png" }],
                    "createdAt": 1, "updatedAt": 1
                }],
                "media": { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": "iVBORw0KGgo=" }
            }
        }"#;
        let b: Backup = serde_json::from_str(json).expect("v2 备份必须能解析");

        assert!(check_envelope(&b.app, b.version).is_ok());
        let media_map = b.data.media.as_ref().expect("v2 必须带图片段");
        assert_eq!(
            media_map.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").map(String::as_str),
            Some("iVBORw0KGgo=")
        );

        // 引用关系要能读出来（导出/导入两边都用它）
        let memos = b.data.memos.as_ref().expect("有备忘");
        assert_eq!(
            referenced_media_ids(memos, &Value::Null),
            vec!["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()]
        );
    }

    #[test]
    fn 挑出被引用的图片时去重且能容忍坏数据() {
        let memo = |id: &str, images: Vec<&str>| Memo {
            id: id.into(),
            date: "2026-09-19".into(),
            title: "t".into(),
            body: String::new(),
            tags: Vec::new(),
            remind_at: None,
            repeat: crate::models::Repeat::None,
            fired_for: None,
            images: images
                .into_iter()
                .map(|i| crate::models::MediaRef {
                    id: i.into(),
                    ..Default::default()
                })
                .collect(),
            created_at: 1,
            updated_at: 1,
        };

        // 备忘与片段引用了同一张图 → 只该出现一次
        let memos = vec![
            memo("m1", vec!["aaa", "bbb"]),
            memo("m2", vec!["aaa"]),
            // 空 id 是"没有图片"的一种写法（前端可能留下这种数据），要丢掉
            memo("m3", vec![""]),
        ];
        let snippets = serde_json::json!([
            { "id": "s1", "images": [{ "id": "ccc" }, { "id": "aaa" }] },
            // 没有 images 字段
            { "id": "s2" },
            // images 不是数组
            { "id": "s3", "images": "坏数据" },
            // images 里的项缺 id
            { "id": "s4", "images": [{ "name": "没有id" }] },
            // 顶层不是对象
            "字符串",
        ]);

        assert_eq!(
            referenced_media_ids(&memos, &snippets),
            vec!["aaa".to_string(), "bbb".to_string(), "ccc".to_string()],
            "去重 + 排序 + 坏数据不能让它崩"
        );

        // 片段那份整个坏掉（不是数组）时也不该崩
        assert_eq!(
            referenced_media_ids(&memos, &Value::Null),
            vec!["aaa".to_string(), "bbb".to_string()]
        );
    }

    #[test]
    fn 更新版本的备份会被拒绝而不是静默丢数据() {
        // 新版本可能加了当前版本不认识的字段，硬导进来会悄悄丢掉它们。
        // 特别是 v3 之后如果图片换了存法，旧版本硬导会得到一堆裂图引用。
        let err = check_envelope(APP_ID, BACKUP_VERSION + 1).expect_err("必须拒绝");
        assert!(err.contains("更新的版本"), "实际：{err}");
    }

    #[test]
    fn 同版本与更旧版本的备份都能导入() {
        assert!(check_envelope(APP_ID, BACKUP_VERSION).is_ok());
        assert!(check_envelope(APP_ID, 1).is_ok(), "v1 必须仍然能导入");
    }

    #[test]
    fn 新导出的备份与老格式形状一致() {
        // 反向保证：`Some(x)` 序列化出来就是 `x`，所以除了多出来的 `media`，
        // 新备份的 JSON 形状与 v1 完全一样 —— 那六段老版本都能读。
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
                media: Some(BTreeMap::new()),
            },
        };
        let json = serde_json::to_string(&backup).expect("序列化");

        // 不能出现 `"snippets":null` 这种形状（那是 `None` 才有的）
        assert!(json.contains("\"snippets\":[]"), "实际：{json}");
        assert!(!json.contains("\"snippets\":null"));
        // settings 为 None 时才是 null，老代码把它读成"没有设置"，语义一致
        assert!(json.contains("\"settings\":null"));
        // 没有图片时是空对象（不是 null）：老版本读到 `media` 会忽略它
        assert!(json.contains("\"media\":{}"), "实际：{json}");
    }

    #[test]
    fn 导入报告默认是空的() {
        // 前端拿它判断"要不要提示用户有缺图"
        let report = ImportReport::default();
        assert_eq!(report.media_written, 0);
        assert!(report.missing_media.is_empty());

        let json = serde_json::to_string(&report).expect("序列化");
        assert!(json.contains("\"mediaWritten\""), "字段要驼峰：{json}");
        assert!(json.contains("\"missingMedia\""), "字段要驼峰：{json}");
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
}
