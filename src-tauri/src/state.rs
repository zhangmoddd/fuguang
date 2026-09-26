//! 应用状态的共享内存与持久化。
//!
//! # 为什么要有内存状态
//!
//! 调度线程每秒都要检查一遍"有没有到点的倒计时/提醒"。
//! 如果每次都去读 JSON 文件，一秒几次磁盘 IO 既浪费又慢。
//! 所以数据常驻内存，只在真正修改时才落盘。
//!
//! # 锁的使用约定
//!
//! 所有对外方法都通过 `Mutex` 串行化。为避免死锁，约定：
//! **持锁期间不做任何 IO、不调用任何会再次拿锁的方法。**
//! 所以 `save_*` 系列都接收数据切片，而不是自己去拿锁。

use std::sync::{Mutex, MutexGuard};

use tauri::AppHandle;

use crate::models::{Link, Memo, Settings, Timer};
use crate::storage;

/// 数据文件名。
const FILE_TIMERS: &str = "timers.json";
const FILE_MEMOS: &str = "memos.json";
const FILE_LINKS: &str = "links.json";
const FILE_SETTINGS: &str = "settings.json";

/// 全部应用数据。
#[derive(Debug, Default)]
pub struct AppState {
    pub timers: Vec<Timer>,
    pub memos: Vec<Memo>,
    pub links: Vec<Link>,
    pub settings: Settings,
}

/// 全局状态容器，通过 `app.manage()` 注入。
pub struct Store {
    inner: Mutex<AppState>,
}

impl Store {
    /// 从磁盘加载全部数据并构造容器。
    ///
    /// 单个文件损坏不会导致启动失败：`storage::read_json` 会备份坏文件并返回默认值。
    pub fn load(app: &AppHandle) -> Self {
        let state = AppState {
            timers: storage::read_json(app, FILE_TIMERS, Vec::new()),
            memos: storage::read_json(app, FILE_MEMOS, Vec::new()),
            links: storage::read_json(app, FILE_LINKS, Vec::new()),
            settings: storage::read_json(app, FILE_SETTINGS, Settings::default()),
        };
        Store {
            inner: Mutex::new(state),
        }
    }

    /// 取锁。
    ///
    /// 用 `unwrap_or_else(into_inner)` 而不是 `unwrap`：
    /// 某个线程 panic 会毒化锁，但数据本身通常仍然可用，
    /// 这里选择继续使用而不是让整个软件崩掉。
    pub fn lock(&self) -> MutexGuard<'_, AppState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------
// 持久化
//
// 每个集合单独一个文件，好处是：文本片段写坏不会连累计时器，
// 用户也能单独备份/删除某一类数据。
// ---------------------------------------------------------------

pub fn save_timers(app: &AppHandle, timers: &[Timer]) -> Result<(), String> {
    storage::write_json(app, FILE_TIMERS, &timers)
}

pub fn save_memos(app: &AppHandle, memos: &[Memo]) -> Result<(), String> {
    storage::write_json(app, FILE_MEMOS, &memos)
}

pub fn save_links(app: &AppHandle, links: &[Link]) -> Result<(), String> {
    storage::write_json(app, FILE_LINKS, &links)
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    storage::write_json(app, FILE_SETTINGS, &settings)
}
