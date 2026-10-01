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

use crate::models::{Folder, Link, Memo, Settings, Timer};
use crate::storage;

/// 数据文件名。
const FILE_TIMERS: &str = "timers.json";
const FILE_MEMOS: &str = "memos.json";
const FILE_LINKS: &str = "links.json";
const FILE_FOLDERS: &str = "folders.json";
const FILE_SETTINGS: &str = "settings.json";

/// 全部应用数据。
#[derive(Debug, Default)]
pub struct AppState {
    pub timers: Vec<Timer>,
    pub memos: Vec<Memo>,
    pub links: Vec<Link>,
    /// 文件夹。三个功能页签共用这一个列表，靠 `feature` 字段区分归属。
    pub folders: Vec<Folder>,
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
        // 设置要过一遍夹取：文件是纯文本、用户可能手动编辑，
        // 一个手写的极端值（比如字号 200）就能让界面彻底没法用。
        let mut settings: Settings = storage::read_json(app, FILE_SETTINGS, Settings::default());
        settings.clamp();

        let state = AppState {
            timers: storage::read_json(app, FILE_TIMERS, Vec::new()),
            memos: storage::read_json(app, FILE_MEMOS, Vec::new()),
            links: storage::read_json(app, FILE_LINKS, Vec::new()),
            folders: storage::read_json(app, FILE_FOLDERS, Vec::new()),
            settings,
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

pub fn save_folders(app: &AppHandle, folders: &[Folder]) -> Result<(), String> {
    storage::write_json(app, FILE_FOLDERS, &folders)
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    storage::write_json(app, FILE_SETTINGS, &settings)
}

// ---------------------------------------------------------------
// 写锁：串行化「取快照 + 落盘」
//
// # 为什么需要它（这是一次真实事故的修复）
//
// 所有写入原本都是「锁内改内存 → 锁外落盘整份数组」。两个写者并发时，
// **先取快照的那个可能后落盘**，把新数据整份盖回旧值。已用确定性交错复现：
//
// - `timer_save` 方向 → 用户刚改的名字被回滚
// - `timer_remove` 方向 → 删掉的计时器「复活」，到点的倒计时重启后再弹一次
// - `backup::import` 方向 → 界面显示「恢复成功」，重启后变回旧值
//
// 磁盘与内存分叉，而且**跨重启保留**。
//
// # 修法
//
// 加一把只用来串行化写盘的锁，并要求所有写者**在写锁内重新取一次内存快照**。
// 这样「取快照 + 落盘」这一整段对其他写者是原子的，最后落盘的一定是最新状态。
//
// 为什么不干脆把落盘挪进 `Store` 那把锁里：本文件顶部那条
// 「持锁期间不做任何 IO」的约定是为了不阻塞命令线程与调度线程，值得保留。
// 单独一把写锁的代价只是**写入之间**排队，读取完全不受影响。
// ---------------------------------------------------------------

/// 只用于串行化写盘的锁。和 `Store::inner` 是两把不同的锁，顺序固定为：
/// 先 `Store::inner`（改内存、立刻放）→ 再 `WRITE_LOCK`（取快照、落盘）。
/// 任何地方都不许反过来先拿写锁再拿 `Store::inner` 之后又去拿写锁，否则会死锁。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 在写锁内执行一段临界区。
///
/// 只给本模块与 `backup::import` 用：`import` 需要把「写六份文件 + 改内存」
/// 整体包起来，否则调度线程会在中间插进来把旧快照盖上去。
pub fn with_write_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// 在写锁内取一份**最新**的内存快照并落盘。
///
/// 用 `fetch` 闭包而不是让调用方传切片，是为了让「拿锁外那份旧快照去写」
/// 这件事在写法上就做不到 —— 快照只能在写锁内取。
pub fn persist<T>(
    app: &AppHandle,
    fetch: impl FnOnce() -> Vec<T>,
    save: fn(&AppHandle, &[T]) -> Result<(), String>,
) -> Result<(), String> {
    with_write_lock(|| save(app, &fetch()))
}

/// 设置只有一份，不是集合，所以单独给一个。理由同 [`persist`]。
pub fn persist_settings(app: &AppHandle, store: &Store) -> Result<(), String> {
    with_write_lock(|| save_settings(app, &store.lock().settings.clone()))
}
