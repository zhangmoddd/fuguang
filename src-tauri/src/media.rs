//! 图片媒体：落盘、读取、剪贴板互转。
//!
//! # 像素为什么不进 JSON
//!
//! 见 [`crate::models::MediaRef`] 的说明：数据文件是整份覆盖写的，
//! 把 base64 塞进去会让 `snippets.json` 膨胀几个数量级，还会污染全文搜索。
//! 所以像素单独落在 `%APPDATA%\浮光\media\`，JSON 里只留引用。
//!
//! # 目录里都有什么
//!
//! 一张图片最多三个文件，都以 id 开头：
//!
//! | 文件 | 内容 |
//! |---|---|
//! | `<id>.<ext>` | 原图，扩展名由**文件头**决定（不是用户给的名字） |
//! | `<id>.thumb.png` | 缩略图，前端 canvas 生成后回填 |
//! | `<id>.json` | 元数据（原名、宽高、字节数、导入时刻） |
//!
//! 元数据单独放一个 sidecar 而不是集中一个 `media.json`：集中式那个文件一旦损坏，
//! 全部图片的宽高和原名一起丢，而它偏偏是**每次导入都要重写**的文件 ——
//! 一旦损坏就是全局的。sidecar 只影响它自己那一张图，而且读写复用
//! [`storage::read_json_at`]（坏文件会被改名留证，不是静默清空）。
//!
//! # 为什么不在 Rust 里引 `image` crate
//!
//! 与 [`crate::linkicon`]、[`crate::backup`] 是同一个取舍：**本项目对发布体积极敏感**
//! （每个依赖都直接进 exe）。图片编解码改用系统自带的 GDI+（`gdiplus.dll`，
//! Windows XP 起就在系统里，不进安装包），缩略图则交给前端的 canvas ——
//! 前端本来就有 canvas，这是 [`crate::linkicon`] 已经用过的分工。
//!
//! # 失败一律降级，不 panic
//!
//! GDI+ / 剪贴板 / 文件系统任何一步都可能失败（图片格式古怪、剪贴板被别的程序占着、
//! 磁盘满）。这里的约定和 [`crate::linkicon`] 一致：**返回 `None` 或 `Err(中文原因)`**，
//! 绝不 panic —— 正式版没有控制台，panic 就是"软件自己退出了"。

#![cfg(windows)]

use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::AppHandle;

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ, RGBQUAD,
};
use windows_sys::Win32::Graphics::GdiPlus::{
    GdipCreateBitmapFromFile, GdipCreateBitmapFromScan0, GdipCreateHBITMAPFromBitmap,
    GdipDisposeImage, GdipGetImageEncoders, GdipGetImageEncodersSize, GdipGetImageHeight,
    GdipGetImageWidth, GdipSaveImageToFile, GdiplusStartup, GdiplusStartupInput, GpBitmap, GpImage,
    ImageCodecInfo, ImageFormatPNG, Ok as GpOk,
};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};

use crate::linkicon::base64_encode;
use crate::models::{now_ms, MediaRef};
use crate::platform::{self, PasteOutcome};
use crate::storage;

/// 媒体子目录名（数据目录下，与六份 JSON 平级）。
const DIR: &str = "media";

/// 单张图片的体积上限。
///
/// 20 MB 是**产品决定**而不是技术限制：一张 4K 截图（3840×2160×4）约 33 MB，
/// 但那已经是"屏幕录像"级别的素材了。真正需要存的是截图和参考图，
/// 20 MB 足够，而它同时挡住了"用户拖进来一个 500 MB 的 PSD"这种会把
/// 数据目录撑爆、备份文件也一起撑爆的误操作。
///
/// 所有**导入**路径都要过这道闸（选文件、剪贴板、拖放）。备份恢复走的是
/// [`write_original`]，刻意不受它限制：那些图片本来就是库里的，
/// 因为一次恢复而被拒收只会让数据凭空少一块。
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 超过体积上限时的报错文案（导入路径共用，保证提示一致）。
fn too_big_message(bytes: u64) -> String {
    format!(
        "图片太大（{:.1} MB），上限是 {} MB",
        bytes as f64 / 1_048_576.0,
        MAX_IMAGE_BYTES / 1_048_576
    )
}

/// 缩略图解码后的字节上限（4 MB 的 PNG 已经远超"缩略图"该有的体积）。
const MAX_THUMB_BYTES: usize = 4 * 1024 * 1024;

/// 缩略图文件名后缀。
const THUMB_SUFFIX: &str = ".thumb.png";
/// 元数据 sidecar 后缀。
const META_SUFFIX: &str = ".json";

/// 剪贴板里的 `CF_DIB`（设备无关位图）。
///
/// 与 [`crate::platform::CF_DIB`] 是同一个值，刻意复用那边的常量：
/// 两处各写一个 `8` 的话，将来有人改一处就会静默错位。
const CF_DIB: u32 = platform::CF_DIB;

/// 识别的图片种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageKind {
    /// 落盘用的扩展名（小写，不带点）。
    pub ext: &'static str,
    /// MIME 类型。
    pub mime: &'static str,
}

const PNG: ImageKind = ImageKind {
    ext: "png",
    mime: "image/png",
};
const JPEG: ImageKind = ImageKind {
    ext: "jpg",
    mime: "image/jpeg",
};
const GIF: ImageKind = ImageKind {
    ext: "gif",
    mime: "image/gif",
};
const BMP: ImageKind = ImageKind {
    ext: "bmp",
    mime: "image/bmp",
};
const WEBP: ImageKind = ImageKind {
    ext: "webp",
    mime: "image/webp",
};

/// 全部支持的图片种类，顺序固定（`find_file_at` 靠它保证查找结果稳定）。
const ALL_KINDS: [ImageKind; 5] = [PNG, JPEG, GIF, BMP, WEBP];

/// 按**文件头**判断图片类型。
///
/// # 为什么以文件头为准，而不是扩展名
///
/// 扩展名是用户（或另一个程序）随手写的，文件头不是。判错的代价很具体：
/// 把一张 JPEG 当成 PNG 存下来，前端 `data:image/png` 的 data URL 就会解码失败，
/// 界面上一片裂图，而文件明明好好地躺在盘上。
///
/// `None` 表示"这不是我们认得的图片"——调用方必须据此拒绝导入，而不是硬存。
pub fn detect_kind(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(PNG);
    }
    // JPEG 的 SOI + 第一个标记。只认 `FF D8 FF`：`FF D8` 两个字节太短，
    // 一堆二进制文件都能撞上。
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(JPEG);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(GIF);
    }
    // ⚠️ BMP 的 magic 只有 "BM" 两个字符，是这里最弱的一条：
    // 任何以 "BM" 开头的文件都会被认成 BMP。所以导入路径上**还要求扩展名
    // 也在图片集合里**（见 `import_path`），两道判据同时成立才收。
    if bytes.starts_with(b"BM") {
        return Some(BMP);
    }
    // WebP 是 RIFF 容器，第 8..12 字节才是 "WEBP"
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(WEBP);
    }
    None
}

/// 按扩展名判断图片类型（不带点、大小写不敏感）。
pub fn kind_from_ext(ext: &str) -> Option<ImageKind> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some(PNG),
        "jpg" | "jpeg" => Some(JPEG),
        "gif" => Some(GIF),
        "bmp" => Some(BMP),
        "webp" => Some(WEBP),
        _ => None,
    }
}

/// 校验一个 id 是不是我们生成的形状（32 位小写十六进制）。
///
/// # 这是安全边界
///
/// id 是**前端传进来**的，而它会被直接拼进文件名。不校验的话
/// `../../settings` 之类能让读写跑到数据目录之外 —— 和
/// [`storage::check_file_name`] 拦的是同一类问题，所以这里也必须拦。
fn check_id(id: &str) -> Result<&str, String> {
    if id.len() != ID_LEN || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(format!("非法的图片 id：{id}"));
    }
    Ok(id)
}

/// id 的十六进制长度（sha256 的前 16 字节）。
const ID_LEN: usize = 32;

/// 由**文件内容**算出的图片 id。
///
/// 取 sha256 的前 16 字节（128 位）而不是全部 32 字节：128 位的碰撞概率
/// 在"一个用户存几千张图"这个量级上完全不可能发生，而短一半的 id
/// 让文件名、JSON、日志都更好读。
///
/// 用内容摘要当 id 的**直接好处**是去重变成天然的：同一张图导入两次算出的 id 相同，
/// 第二次直接复用已有文件，不需要额外维护一张"内容 → 文件"的索引表。
pub fn id_for(bytes: &[u8]) -> String {
    sha256::hex(bytes)[..ID_LEN].to_string()
}

// ===============================================================
// 目录与文件
// ===============================================================

/// 取媒体目录（必要时创建）。
pub fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = storage::data_dir(app)?;
    let dir = base.join(DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败（{}）：{e}", dir.display()))?;
    }
    Ok(dir)
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{META_SUFFIX}"))
}

fn thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{THUMB_SUFFIX}"))
}

/// 找出某个 id 的原图（扩展名由内容决定，所以得挨个试）。
fn find_file_at(dir: &Path, id: &str) -> Option<(PathBuf, ImageKind)> {
    ALL_KINDS
        .iter()
        .map(|k| (dir.join(format!("{id}.{}", k.ext)), *k))
        .find(|(p, _)| p.is_file())
}

/// 读 sidecar 元数据。文件不存在或读不了时返回 `None`。
fn read_meta_at(dir: &Path, id: &str) -> Option<MediaRef> {
    let path = meta_path(dir, id);
    if !path.is_file() {
        return None;
    }
    // 复用 storage 的读法：坏文件会被改名留证，而不是静默清空
    Some(storage::read_json_at(&path, MediaRef::default()))
}

fn write_meta_at(dir: &Path, media: &MediaRef) -> Result<(), String> {
    storage::write_json_at(&meta_path(dir, &media.id), media)
}

/// 进程内单调计数器，用来给临时文件起唯一名字。
///
/// 和 [`storage::unique_tmp_path`] 是同一个理由：Windows 的时钟粒度是 100ns，
/// 同一刻取两次时间戳常常相同，光靠时间戳会撞名。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 原子地写一个文件（先写同目录的临时文件，再改名）。
///
/// 直接覆盖写的话，"写到一半崩了/断电"会留下半截图片文件，而界面上引用还在 ——
/// 表现是**这张图永远显示不出来**，用户只能删掉重加。
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "media".into());
    // 必须同目录：rename 跨卷会失败
    let tmp = path.with_file_name(format!("{name}.{}-{seq}.tmp", std::process::id()));

    if let Err(err) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入图片失败：{err}"));
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("提交图片失败：{err}"));
    }
    Ok(())
}

// ===============================================================
// 导入
// ===============================================================

/// 把一段**已经是图片**的字节存进媒体目录。
///
/// 已经存在（内容相同）时直接返回已有引用，不重复落盘、也不覆盖 `addedAt`。
fn import_bytes_at(dir: &Path, bytes: &[u8], name: &str) -> Result<MediaRef, String> {
    if bytes.is_empty() {
        return Err("图片是空的".into());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(too_big_message(bytes.len() as u64));
    }
    let kind = detect_kind(bytes).ok_or("这个文件的内容不是图片（认不出文件头）")?;
    let id = id_for(bytes);
    let target = dir.join(format!("{id}.{}", kind.ext));

    if target.is_file() {
        // 同一张图重复导入：复用已有那份。元数据丢了也要给出一份能用的引用，
        // 否则前端会拿到一个"没有宽高、没有原名"的残缺对象。
        let mut existing = read_meta_at(dir, &id).unwrap_or_default();
        existing.id = id;
        if existing.mime.is_empty() {
            existing.mime = kind.mime.into();
        }
        if existing.name.is_empty() {
            existing.name = name.to_string();
        }
        if existing.bytes == 0 {
            existing.bytes = bytes.len() as u64;
        }
        return Ok(existing);
    }

    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    }
    write_bytes_atomic(&target, bytes)?;

    let media = MediaRef {
        id,
        name: name.to_string(),
        mime: kind.mime.into(),
        // 宽高由前端用 canvas 量出来回填（见 `set_meta_at`）：
        // Rust 侧要量宽高就得把图片解码一遍，而"不解码"正是本模块能不带 image crate 的原因。
        width: 0,
        height: 0,
        bytes: bytes.len() as u64,
        added_at: now_ms(),
    };

    // 元数据写失败**不该**让导入失败：图已经落盘了，报错会让用户以为没存上，
    // 而实际上盘上多了一个"没有名字"的孤儿文件。记日志，把可用的引用照常返回。
    if let Err(err) = write_meta_at(dir, &media) {
        crate::diag!("[浮光] 图片元数据写入失败（{}）：{err}", media.id);
    }
    Ok(media)
}

/// 从磁盘上的一个文件导入图片。
///
/// 两道判据都要过：**扩展名像图片**，且**文件头也像图片**。
/// 只看文件头的话，用户误拖一个 `.exe`（恰好以 `BM` 开头）也会被收下；
/// 只看扩展名的话，把 `a.png` 改成 `a.png.txt` 再改回来这种事就没意义了 ——
/// 关键是别把"内容根本不是图片"的东西存进图片目录。
pub fn import_path(app: &AppHandle, path: &str) -> Result<MediaRef, String> {
    let src = Path::new(path);
    let meta = fs::metadata(src).map_err(|e| format!("读不到这个文件：{e}"))?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        // 先看文件长度再读：一个 500 MB 的文件不该先被整个读进内存再拒绝
        return Err(too_big_message(meta.len()));
    }

    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if kind_from_ext(&ext).is_none() {
        return Err(format!(
            "不支持的图片格式：{ext}（只支持 png / jpg / gif / bmp / webp）"
        ));
    }

    let bytes = fs::read(src).map_err(|e| format!("读取图片失败：{e}"))?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "图片".into());

    import_bytes_at(&media_dir(app)?, &bytes, &name)
}

/// 把剪贴板里的图片存进媒体目录。
///
/// 返回 `Ok(None)` 表示**剪贴板里没有图片**——这是正常情况（用户复制的是文字），
/// 调用方会退回"粘贴文字"，所以**不报错**。
///
/// 但"有图片却读不出来"必须返回 `Err`：那是真的出问题了
/// （剪贴板被别的程序占着、系统解码器不认识这个格式、图太大）。
/// 把它也压成 `None` 的话，用户看到的是"复制了截图却什么都没发生" ——
/// 正是本项目最想消灭的那类静默失败。
///
/// 读取顺序：
/// 1. 注册格式 `PNG`：Chromium 系浏览器、截图工具（Win+Shift+S）、Office
///    复制图片时都会放这一份**原始 PNG 字节**，拿到就能直接落盘，不用重新编码，
///    也不会有"重新编码后画质/透明通道变化"的问题；
/// 2. 退回 `CF_DIB`：老程序（画图、部分 IM）只给 DIB，这时用 GDI+ 转成 PNG。
pub fn import_clipboard(app: &AppHandle) -> Result<Option<MediaRef>, String> {
    let dir = media_dir(app)?;
    let Some((bytes, name)) = clipboard_image_bytes()? else {
        return Ok(None);
    };
    Ok(Some(import_bytes_at(&dir, &bytes, &name)?))
}

/// 从剪贴板取图片字节。优先原始 PNG，退回 DIB→PNG。
///
/// 三种结果各有含义，见 [`import_clipboard`] 的说明。
fn clipboard_image_bytes() -> Result<Option<(Vec<u8>, String)>, String> {
    unsafe {
        if !platform::open_clipboard_retry() {
            // 打不开剪贴板就**没法判断**里面有没有图片（Office、剪贴板管理器
            // 会短暂占用它）。这种"读不出来"必须说出来，不能当成"没有图片"。
            return Err("读不到剪贴板（可能被其他程序占用），请重试".into());
        }
        let result = read_clipboard_image_locked();
        CloseClipboard();
        result
    }
}

/// 剪贴板已经打开时的读取逻辑（调用方负责 `CloseClipboard`）。
///
/// # Safety
/// 必须在持有剪贴板（`OpenClipboard` 成功）时调用。
unsafe fn read_clipboard_image_locked() -> Result<Option<(Vec<u8>, String)>, String> {
    // 1. 注册格式 "PNG"：拿到的就是原始 PNG 字节
    let png_format = RegisterClipboardFormatW(platform::wide("PNG").as_ptr());
    if png_format != 0 && IsClipboardFormatAvailable(png_format) != 0 {
        if let Some(raw) = read_hglobal(png_format) {
            if detect_kind(&raw) == Some(PNG) {
                return Ok(Some((trim_png(&raw).to_vec(), clipboard_image_name())));
            }
        }
        // 认不出来就往下走 CF_DIB：有的程序注册了 "PNG" 这个名字却塞了别的东西，
        // 那时候 DIB 往往还在
    }

    // 2. 退回 CF_DIB，交给 GDI+ 编码成 PNG
    if IsClipboardFormatAvailable(CF_DIB) == 0 {
        // 两种格式都没有 → 剪贴板里就是没有图片
        return Ok(None);
    }
    let raw = read_hglobal(CF_DIB).ok_or("剪贴板里的图片读不出来（数据被占用或已失效）")?;

    // ⚠️ 剪贴板的 HGLOBAL 是**分配大小**，分配器会向上取整，所以它可能比
    // 数据本身大。多出来的尾巴会让"同一张图"算出两个不同的 id（去重失效），
    // 也会把垃圾字节一起存进 media/。DIB 的真实长度能从头部算出来，按它裁。
    let dib: &[u8] = match parse_dib(&raw).and_then(|info| info.exact_len()) {
        Some(len) if len <= raw.len() => &raw[..len],
        // 算不出来、或算出来比实际还大：原样交给后面的解析去报错，
        // 总比在这里瞎裁一刀强
        _ => &raw[..],
    };
    let png = dib_to_png_bytes(dib)?;
    Ok(Some((png, clipboard_image_name())))
}

/// 把 PNG 截到 `IEND` 块结束处。
///
/// 理由同上面那段注释：剪贴板给的缓冲区可能比数据本身大。PNG 的结尾由
/// `IEND` 块唯一确定（长度 4 字节 + 类型 4 字节 + CRC 4 字节），所以按块表
/// 往前走到 IEND 就能裁准。
///
/// 表结构不完整（截断的 PNG）时**原样返回**：那是"这张图本来就是坏的"，
/// 该由后面的解码器去报错，不该在这里猜。
fn trim_png(bytes: &[u8]) -> &[u8] {
    // 跳过 8 字节签名，之后每个块：长度(4) + 类型(4) + 数据 + CRC(4)
    let mut pos = 8usize;
    while pos + 8 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]])
            as usize;
        let chunk_end = pos + 8 + len + 4;
        if chunk_end > bytes.len() {
            return bytes;
        }
        let is_end = &bytes[pos + 4..pos + 8] == b"IEND";
        pos = chunk_end;
        if is_end {
            return &bytes[..pos];
        }
    }
    bytes
}

/// 复制 `hglobal` 里的剪贴板数据（拷贝出来，因为 `CloseClipboard` 之后就失效了）。
///
/// # Safety
/// 必须在持有剪贴板时调用。
unsafe fn read_hglobal(format: u32) -> Option<Vec<u8>> {
    let handle = GetClipboardData(format);
    if handle.is_null() {
        return None;
    }
    let size = GlobalSize(handle);
    if size == 0 {
        return None;
    }
    let ptr = GlobalLock(handle) as *const u8;
    if ptr.is_null() {
        return None;
    }
    let out = std::slice::from_raw_parts(ptr, size).to_vec();
    GlobalUnlock(handle);
    Some(out)
}

/// 剪贴板图片的默认文件名。
///
/// 不带时间戳：`addedAt` 已经记了导入时刻，文件名里再塞一个时间戳只会让
/// 「另存为」的默认名变得又长又难认。
fn clipboard_image_name() -> String {
    "剪贴板图片.png".into()
}

// ===============================================================
// DIB ⇄ PNG（GDI+）
// ===============================================================

/// 32bpp ARGB。GDI+ 的头文件里有这个名字，但 `windows-sys` 没有导出，所以自己写。
///
/// 值来自 `gdipluspixelformats.h`：
/// `10 | (32 << 8) | PixelFormatAlpha | PixelFormatGDI | PixelFormatCanonical`。
const PIXEL_FORMAT_32BPP_ARGB: i32 = 0x0026_200A;

/// GDI+ 只需在进程内初始化一次，而且**不能**在 `DllMain` 里调 —— 这里在首次用到时才初始化。
///
/// 拿到 token 后不做 `GdiplusShutdown`：进程退出时系统会收走。
/// 提前关掉反而会让"关掉之后又有人来用"变成未定义行为。
fn gdiplus_init() -> Result<(), String> {
    static TOKEN: OnceLock<Result<usize, String>> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            let input = GdiplusStartupInput {
                GdiplusVersion: 1,
                ..Default::default()
            };
            let mut token = 0usize;
            let status = unsafe { GdiplusStartup(&mut token, &input, std::ptr::null_mut()) };
            if status != GpOk {
                return Err(format!("GDI+ 初始化失败（status={status}）"));
            }
            Ok(token)
        })
        .clone()
        .map(|_| ())
}

/// 从运行时查出来的 PNG 编码器 CLSID。
///
/// # 为什么不写死一个常量
///
/// PNG 编码器的 CLSID 是个魔法 GUID（`557CF406-…`），写死之后如果哪天
/// 系统里换了编码器，保存会失败而且失败原因完全看不出来。系统本来就提供
/// `GdipGetImageEncoders`，问一次就能拿到，还能顺带确认"这台机器上有 PNG 编码器"。
fn png_encoder_clsid() -> Option<windows_sys::core::GUID> {
    static CLSID: OnceLock<Option<windows_sys::core::GUID>> = OnceLock::new();
    *CLSID.get_or_init(|| unsafe {
        let mut num = 0u32;
        let mut size = 0u32;
        if GdipGetImageEncodersSize(&mut num, &mut size) != GpOk || num == 0 || size == 0 {
            return None;
        }
        // 用 u64 缓冲区：`ImageCodecInfo` 里有 GUID 与指针，需要 8 字节对齐，
        // 而 `Vec<u8>` 只保证 1 字节对齐 —— 直接转指针是 UB 风险。
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        if GdipGetImageEncoders(num, size, buf.as_mut_ptr() as *mut ImageCodecInfo) != GpOk {
            return None;
        }
        let base = buf.as_ptr() as *const ImageCodecInfo;
        for i in 0..num as usize {
            let info = &*base.add(i);
            if same_guid(&info.FormatID, &ImageFormatPNG) {
                return Some(info.Clsid);
            }
        }
        None
    })
}

/// `windows-sys` 的 `GUID` 没实现 `PartialEq`，只能逐字段比。
fn same_guid(a: &windows_sys::core::GUID, b: &windows_sys::core::GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

/// DIB 头部里我们关心的信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DibInfo {
    pub width: u32,
    /// 取绝对值：DIB 的 `biHeight` 为负表示"自顶向下"，那只是个行序标记。
    pub height: u32,
    pub bit_count: u16,
    pub compression: u32,
    /// 头部字节数（40 = `BITMAPINFOHEADER`，108 = `BITMAPV4HEADER`……）。
    pub header_size: u32,
    /// `biSizeImage`：`BI_JPEG` / `BI_PNG` 时像素区的真实长度。
    pub size_image: u32,
    /// `biClrUsed`：0 表示"用满 2^bit_count 个调色板项"。
    pub clr_used: u32,
}

impl DibInfo {
    /// 这个 DIB 的**真实**字节数。
    ///
    /// # 为什么需要它
    ///
    /// 剪贴板里的位图是一块 HGLOBAL，而 `GlobalSize` 返回的是**分配大小**
    /// （分配器会向上取整），可能比数据本身大几个字节到几百字节。多出来的尾巴
    /// 会让"同一张图"算出两个不同的 id —— 去重直接失效 —— 还会被一起写进
    /// `media/`。DIB 的长度恰好是能从头部算出来的：头 + 调色板 + 像素。
    ///
    /// 算不出来时返回 `None`（调用方原样使用，交给解析去报错）。
    pub fn exact_len(&self) -> Option<usize> {
        // BI_JPEG(4) / BI_PNG(5)：像素区是压缩数据，长度只能信 biSizeImage
        if self.compression == 4 || self.compression == 5 {
            return Some(self.header_size as usize + self.size_image as usize);
        }

        let bits = self.bit_count as usize;
        if bits == 0 {
            return None;
        }

        let palette = if bits <= 8 {
            let entries = if self.clr_used > 0 {
                self.clr_used as usize
            } else {
                1usize << bits
            };
            entries * 4
        } else if self.compression == 3 && self.header_size == 40 {
            // BI_BITFIELDS 且头是 40 字节时，三个颜色掩码紧跟在头后面
            12
        } else {
            0
        };

        // 每行按 4 字节对齐
        let stride = (self.width as usize * bits).div_ceil(32) * 4;
        Some(self.header_size as usize + palette + stride * self.height as usize)
    }
}

/// 解析 `CF_DIB` 的头部。
///
/// 只支持 `BITMAPINFOHEADER`（40 字节）及更新的头。12 字节的
/// `BITMAPCOREHEADER` 是 OS/2 时代的东西，现代剪贴板不会给，
/// 认不出来就返回 `None`（调用方按"剪贴板里没有图片"处理）。
pub fn parse_dib(bytes: &[u8]) -> Option<DibInfo> {
    if bytes.len() < 40 {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let u16_at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);

    let header_size = u32_at(0);
    if header_size < 40 || bytes.len() < header_size as usize {
        return None;
    }
    let width = u32_at(4) as i32;
    let height = u32_at(8) as i32;
    // 宽度为 0 或负、高度为 0 的位图没有意义（负高度是合法的自顶向下标记）
    if width <= 0 || height == 0 {
        return None;
    }
    Some(DibInfo {
        width: width as u32,
        height: height.unsigned_abs(),
        bit_count: u16_at(14),
        compression: u32_at(16),
        header_size,
        size_image: u32_at(20),
        clr_used: u32_at(32),
    })
}

/// 把 DIB 转成 PNG 字节（剪贴板 → 落盘用）。
pub fn dib_to_png_bytes(dib: &[u8]) -> Result<Vec<u8>, String> {
    let info = parse_dib(dib).ok_or("认不出剪贴板里位图的格式")?;
    gdiplus_init()?;

    let (width, height, bgra) = dib_to_bgra(dib, &info)?;

    unsafe {
        let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
        // ⚠️ `stride` 必须显式给（这里是「每行字节数」），传 0 会被 GDI+ 判成
        // `InvalidParameter`（实测 status=2），而不是"自动按格式推算"。
        let status = GdipCreateBitmapFromScan0(
            width as i32,
            height as i32,
            (width * 4) as i32,
            PIXEL_FORMAT_32BPP_ARGB,
            bgra.as_ptr(),
            &mut bitmap,
        );
        if status != GpOk || bitmap.is_null() {
            return Err(format!("GDI+ 建立位图失败（status={status}）"));
        }
        let png = save_bitmap_as_png(bitmap);
        GdipDisposeImage(bitmap as *mut GpImage);
        png
    }
}

/// 把 DIB 归一成 32bpp 自顶向下的 BGRA 像素。
///
/// # 为什么要过一遍 GDI，而不是直接把 DIB 交给 GDI+
///
/// 剪贴板里的 DIB 可能是 1/4/8/16/24/32 位、可能带调色板、可能是
/// `BI_BITFIELDS`（三个颜色掩码跟在头后面）。`GdipCreateBitmapFromGdiDib`
/// 对这些组合的支持并不完整，而 `CreateDIBSection` + `GetDIBits` 是
/// GDI 自己的转换路径 —— 系统怎么显示它就怎么转，一条路吃下全部位深。
fn dib_to_bgra(dib: &[u8], info: &DibInfo) -> Result<(u32, u32, Vec<u8>), String> {
    let width = info.width;
    let height = info.height;
    // 上限防的是"手改过的 / 损坏的头部"：一个 4 万 × 4 万的头会让下面的
    // 缓冲区分配直接爆掉内存（正式版没有控制台，只表现为软件消失）。
    if width == 0 || height == 0 || width > 20_000 || height > 20_000 {
        return Err(format!("图片尺寸不合理：{width}×{height}"));
    }

    // `BITMAPINFO` 里的字段是 4 字节对齐的，而 DIB 字节来自 `Vec<u8>`（对齐 1）。
    // 直接转型是 UB 风险，所以先拷进 u32 缓冲再取指针。
    let mut aligned = vec![0u32; dib.len().div_ceil(4)];
    unsafe {
        std::ptr::copy_nonoverlapping(
            dib.as_ptr(),
            aligned.as_mut_ptr() as *mut u8,
            dib.len(),
        );
    }

    unsafe {
        let hdc = CreateCompatibleDC(std::ptr::null_mut());
        if hdc.is_null() {
            return Err("取设备上下文失败".into());
        }

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbm: HBITMAP = CreateDIBSection(
            hdc,
            aligned.as_ptr() as *const BITMAPINFO,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if hbm.is_null() {
            DeleteDC(hdc);
            return Err("剪贴板位图的头部不合法".into());
        }

        let stride = width as usize * 4;
        let mut out = vec![0u8; stride * height as usize];
        // 目标：32bpp BI_RGB、**自顶向下**（负高度）。
        // 自顶向下是为了让像素顺序与屏幕一致，后面所有下标计算都不用再翻行。
        let mut target = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: 40,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD::default()],
        };
        let lines = GetDIBits(
            hdc,
            hbm,
            0,
            height,
            out.as_mut_ptr() as *mut core::ffi::c_void,
            &mut target,
            DIB_RGB_COLORS,
        );
        DeleteObject(hbm as HGDIOBJ);
        DeleteDC(hdc);

        if lines == 0 {
            return Err("读取位图像素失败".into());
        }

        // ⚠️ `BI_RGB` 的 32bpp 里，每像素第 4 个字节按定义是**保留位**，
        // 而截图来源几乎都填 0。GDI+ 会把它当成 alpha 用 ——
        // 不改的话，粘进来的截图在界面上是**全透明的一片空白**，而且不报任何错。
        for px in out.chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok((width, height, out))
    }
}

/// 把 GDI+ 位图编码成 PNG 字节。
///
/// # 为什么要过一遍临时文件
///
/// GDI+ 的保存接口只认**文件路径**（要存进内存得自己实现 `IStream`，
/// 那是几十行 COM 样板换来的零收益）。所以先存进系统临时目录再读回来 ——
/// 临时文件放系统临时目录而不是数据目录：它是中间产物，
/// 不该出现在用户会打开的那个目录里。
fn save_bitmap_as_png(bitmap: *mut GpBitmap) -> Result<Vec<u8>, String> {
    let clsid = png_encoder_clsid().ok_or("这台机器上没有 PNG 编码器")?;

    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = std::env::temp_dir().join(format!("fuguang-media-{}-{seq}.png", std::process::id()));

    let wide: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe {
        GdipSaveImageToFile(
            bitmap as *mut GpImage,
            wide.as_ptr(),
            &clsid,
            std::ptr::null(),
        )
    };
    if status != GpOk {
        let _ = fs::remove_file(&temp);
        return Err(format!("保存 PNG 失败（status={status}）"));
    }

    let bytes = fs::read(&temp).map_err(|e| format!("读取转换结果失败：{e}"));
    // 无论成败都要清掉临时文件，否则用户临时目录里会攒下一堆同名同姓的 png
    let _ = fs::remove_file(&temp);
    bytes
}

/// 把图片文件解码成 `CF_DIB` 字节（供"复制图片到剪贴板"）。
///
/// 输出固定 32bpp BI_RGB、自底向上（`biHeight` 为正，这是 `CF_DIB` 的惯例）。
/// alpha 一律填 255：`CF_DIB` 的 32bpp 里那个字节按定义是保留位，而有些程序
/// （Chromium 系）会把它当 alpha 用 —— 留着从 PNG 解出来的透明像素，
/// 粘出去会得到一张"半透明/全透明"的图，那是用户完全预料不到的结果。
pub fn image_file_to_dib(path: &Path) -> Result<Vec<u8>, String> {
    gdiplus_init()?;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut image: *mut GpBitmap = std::ptr::null_mut();
        let status = GdipCreateBitmapFromFile(wide.as_ptr(), &mut image);
        if status != GpOk || image.is_null() {
            return Err("系统解码器打不开这张图片".into());
        }

        let mut width = 0u32;
        let mut height = 0u32;
        GdipGetImageWidth(image as *mut GpImage, &mut width);
        GdipGetImageHeight(image as *mut GpImage, &mut height);
        if width == 0 || height == 0 {
            GdipDisposeImage(image as *mut GpImage);
            return Err("图片尺寸为 0".into());
        }

        // 背景填白：带透明通道的 PNG 转成不透明的 HBITMAP 时，
        // 透明区域会变成黑色，粘到白底文档里就是一块黑斑。
        let mut hbm: HBITMAP = std::ptr::null_mut();
        let status = GdipCreateHBITMAPFromBitmap(image, &mut hbm, 0x00FF_FFFF);
        GdipDisposeImage(image as *mut GpImage);
        if status != GpOk || hbm.is_null() {
            return Err("转换图片失败".into());
        }

        let hdc = CreateCompatibleDC(std::ptr::null_mut());
        if hdc.is_null() {
            DeleteObject(hbm as HGDIOBJ);
            return Err("取设备上下文失败".into());
        }

        let header = BITMAPINFOHEADER {
            biSize: 40,
            biWidth: width as i32,
            biHeight: height as i32,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut target = BITMAPINFO {
            bmiHeader: header,
            bmiColors: [RGBQUAD::default()],
        };

        let stride = width as usize * 4;
        let mut out = vec![0u8; 40 + stride * height as usize];
        // 头部原样写进前 40 字节：`CF_DIB` 就是一整块 BITMAPINFOHEADER + 像素，
        // 手工逐字段拼字节容易漏字段，直接拷贝结构体最稳。
        std::ptr::copy_nonoverlapping(
            &target.bmiHeader as *const BITMAPINFOHEADER as *const u8,
            out.as_mut_ptr(),
            40,
        );

        let lines = GetDIBits(
            hdc,
            hbm,
            0,
            height,
            out.as_mut_ptr().add(40) as *mut core::ffi::c_void,
            &mut target,
            DIB_RGB_COLORS,
        );
        DeleteObject(hbm as HGDIOBJ);
        DeleteDC(hdc);

        if lines == 0 {
            return Err("读取像素失败".into());
        }
        for px in out[40..].chunks_exact_mut(4) {
            px[3] = 255;
        }
        Ok(out)
    }
}

// ===============================================================
// 读取 / 元数据 / 删除 / 导出 / 统计
// ===============================================================

/// 读一张图片，返回可直接放进 `<img src>` 的 data URL。
///
/// 参数校验与目录定位在这里做，真正的读取在 [`read_data_url_at`]
/// （不依赖 `AppHandle` 才能单测，与 [`storage`] 的分层方式一致）。
pub fn read_data_url(app: &AppHandle, id: &str, full: bool) -> Result<String, String> {
    check_id(id)?;
    let dir = media_dir(app)?;
    read_data_url_at(&dir, id, full)
}

/// 读一张图片（目录版本，可单测）。
///
/// `full = false` 时优先读缩略图（列表里用），没有缩略图就退回原图 ——
/// **不能因为"缩略图还没生成"就显示空白**，那会让用户以为图片坏了。
///
/// # 返回的 MIME 是真实的
///
/// 不写死 `image/png`：库里可能是 JPEG / GIF / WebP，写死会让浏览器解码失败
/// （data URL 的 MIME 与内容不符时，Chromium 会直接拒绝渲染）。
fn read_data_url_at(dir: &Path, id: &str, full: bool) -> Result<String, String> {
    let (path, kind) = find_file_at(dir, id).ok_or_else(|| format!("找不到图片 {id}"))?;

    let (path, mime) = if full {
        (path, kind.mime)
    } else {
        let thumb = thumb_path(dir, id);
        if thumb.is_file() {
            (thumb, PNG.mime)
        } else {
            (path, kind.mime)
        }
    };

    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// 前端量好宽高、生成缩略图之后回填。
///
/// # 为什么宽高和缩略图由前端给
///
/// 因为前端有 canvas：把图丢进 `Image` + `canvas.toDataURL("image/png")` 就能
/// 同时得到宽高和一张压过的缩略图，而 Rust 侧要自己做就得引图片库（体积代价，
/// 见文件头）。这与 [`crate::linkicon`] 的分工完全一致。
pub fn set_meta(
    app: &AppHandle,
    id: &str,
    width: u32,
    height: u32,
    thumb_png_base64: &str,
) -> Result<MediaRef, String> {
    check_id(id)?;
    let dir = media_dir(app)?;
    set_meta_at(&dir, id, width, height, thumb_png_base64)
}

/// 回填宽高与缩略图（目录版本，可单测）。
fn set_meta_at(
    dir: &Path,
    id: &str,
    width: u32,
    height: u32,
    thumb_png_base64: &str,
) -> Result<MediaRef, String> {
    let (_, kind) = find_file_at(dir, id).ok_or_else(|| format!("找不到图片 {id}"))?;
    let mut media = read_meta_at(dir, id).unwrap_or_default();
    media.id = id.to_string();
    if media.mime.is_empty() {
        media.mime = kind.mime.into();
    }

    // 缩略图必须真的是 PNG：前端传的是 canvas 的产物，但这条命令是公开接口，
    // 存进去一个非 PNG 会让列表里的缩略图全部裂掉，而且原因很难查。
    let thumb = base64_decode(thumb_png_base64)?;
    if thumb.is_empty() {
        return Err("缩略图是空的".into());
    }
    if thumb.len() > MAX_THUMB_BYTES {
        return Err("缩略图太大".into());
    }
    if detect_kind(&thumb) != Some(PNG) {
        return Err("缩略图必须是 PNG".into());
    }
    write_bytes_atomic(&thumb_path(dir, id), &thumb)?;

    media.width = width;
    media.height = height;
    write_meta_at(dir, &media)?;
    Ok(media)
}

/// 删除一张图片（原图 + 缩略图 + 元数据）。
///
/// 幂等：图片本来就不在了也返回成功。删除是从界面上点出来的动作，
/// "它已经没了"不该弹一个错误框。
pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    check_id(id)?;
    let dir = media_dir(app)?;
    delete_at(&dir, id)
}

fn delete_at(dir: &Path, id: &str) -> Result<(), String> {
    for path in [thumb_path(dir, id), meta_path(dir, id)] {
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("删除 {} 失败：{e}", path.display()))?;
        }
    }
    if let Some((path, _)) = find_file_at(dir, id) {
        fs::remove_file(&path).map_err(|e| format!("删除图片失败：{e}"))?;
    }
    Ok(())
}

/// 把一张图片另存到用户选定的位置（原图字节，不重新编码）。
pub fn export(app: &AppHandle, id: &str, dest: &str) -> Result<(), String> {
    check_id(id)?;
    let dir = media_dir(app)?;
    export_at(&dir, id, Path::new(dest))
}

/// 另存为（目录版本，可单测）。
fn export_at(dir: &Path, id: &str, dest: &Path) -> Result<(), String> {
    let (path, _) = find_file_at(dir, id).ok_or_else(|| format!("找不到图片 {id}"))?;

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("目标文件夹不存在：{}", parent.display()));
        }
    }
    if dest == path {
        return Err("目标就是图片本身".into());
    }

    fs::copy(&path, dest).map_err(|e| format!("另存为失败：{e}"))?;
    Ok(())
}

/// 媒体库统计。
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStats {
    /// 图片张数（不含缩略图与元数据）。
    pub count: u64,
    /// 占用字节数。**含**缩略图与元数据：这是"这个目录占了我多少磁盘"。
    pub bytes: u64,
}

/// 读一张图片的原始字节（备份导出用）。
///
/// 不重新编码：备份要能"原样还回来"，转一道格式就变了。
pub fn read_original_bytes(app: &AppHandle, id: &str) -> Option<Vec<u8>> {
    if check_id(id).is_err() {
        return None;
    }
    let dir = media_dir(app).ok()?;
    read_original_bytes_at(&dir, id)
}

/// 读原图字节（目录版本，可单测）。
fn read_original_bytes_at(dir: &Path, id: &str) -> Option<Vec<u8>> {
    let (path, _) = find_file_at(dir, id)?;
    fs::read(path).ok()
}

/// 这张图片还在不在库里。
///
/// 备份导入后用它报告"数据里引用到、但盘上没有"的图片 —— 那些位置在界面上
/// 会显示成裂图，用户得知道是哪几张。
pub fn exists(app: &AppHandle, id: &str) -> bool {
    if check_id(id).is_err() {
        return false;
    }
    media_dir(app)
        .map(|dir| exists_at(&dir, id))
        .unwrap_or(false)
}

/// 图片是否在库里（目录版本，可单测）。
fn exists_at(dir: &Path, id: &str) -> bool {
    find_file_at(dir, id).is_some()
}

/// 把备份里的图片写回媒体目录（备份导入用）。
///
/// 扩展名照旧按**文件头**决定：备份 JSON 是用户可以手改的纯文本，
/// 里面那份 base64 解出来是什么格式，只有文件头说了算。
pub fn write_original(app: &AppHandle, id: &str, bytes: &[u8]) -> Result<(), String> {
    check_id(id)?;
    let dir = media_dir(app)?;
    write_original_at(&dir, id, bytes)
}

/// 写回一张图片（目录版本，可单测）。
fn write_original_at(dir: &Path, id: &str, bytes: &[u8]) -> Result<(), String> {
    let kind = detect_kind(bytes).ok_or_else(|| format!("备份里的图片 {id} 认不出格式"))?;
    let target = dir.join(format!("{id}.{}", kind.ext));

    // 已经有同一份就别动它（id 是内容摘要，同 id 必然同内容）：
    // 覆盖会让 `addedAt` 变新，也会把用户机器上那份更好的元数据冲掉。
    if target.is_file() {
        return Ok(());
    }
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    }
    write_bytes_atomic(&target, bytes)?;

    // 元数据缺了补一份最小的：没有它，这张图在库里是"没有名字、宽高未知"的孤儿，
    // 界面上能显示但"另存为"的默认名是空的。
    if read_meta_at(dir, id).is_none() {
        let media = MediaRef {
            id: id.to_string(),
            name: format!("备份恢复.{}", kind.ext),
            mime: kind.mime.into(),
            width: 0,
            height: 0,
            bytes: bytes.len() as u64,
            added_at: now_ms(),
        };
        if let Err(err) = write_meta_at(dir, &media) {
            crate::diag!("[浮光] 恢复图片的元数据写入失败（{id}）：{err}");
        }
    }
    Ok(())
}

/// 统计媒体目录。
///
/// 目录不存在（从没存过图）时返回全 0，而不是报错 —— 设置页上显示
/// "0 张图片"比显示一个错误更符合事实。
pub fn stats(app: &AppHandle) -> MediaStats {
    match media_dir(app) {
        Ok(dir) => stats_at(&dir),
        Err(_) => MediaStats::default(),
    }
}

fn stats_at(dir: &Path) -> MediaStats {
    let Ok(entries) = fs::read_dir(dir) else {
        return MediaStats::default();
    };

    let mut stats = MediaStats::default();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        stats.bytes += meta.len();

        let name = entry.file_name().to_string_lossy().to_string();
        let is_original = ALL_KINDS.iter().any(|k| name.ends_with(&format!(".{}", k.ext)))
            && !name.ends_with(THUMB_SUFFIX);
        if is_original {
            stats.count += 1;
        }
    }
    stats
}

// ===============================================================
// 剪贴板：写出图片
// ===============================================================

/// 把一张图片写进剪贴板（`CF_DIB`）。
///
/// ⚠️ 这会**清空用户原来的剪贴板**（`EmptyClipboard`），和 [`crate::platform`]
/// 里的文本路径是同一件事。文本路径能备份还原，图片不行 ——
/// 剪贴板里的图片可能是好几种格式（DIB / DIBV5 / PNG / 私有格式），
/// 逐格式备份再还原的代码量和出错面都远超它带来的价值。
/// 所以这里的约定是：**调用方必须把"剪贴板被替换了"告诉用户**
/// （见 [`paste_to_target`] 的返回信息）。
pub fn copy_image_to_clipboard(app: &AppHandle, id: &str) -> Result<(), String> {
    check_id(id)?;
    let dir = media_dir(app)?;
    let (path, kind) = find_file_at(&dir, id).ok_or_else(|| format!("找不到图片 {id}"))?;

    let dib = if kind == BMP {
        // 已经是 BMP 就直接取它的 DIB 部分，省一次解码（也避开 GDI+ 对
        // 某些古怪 BMP 的挑剔）
        bmp_file_to_dib(&fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?)?
    } else {
        image_file_to_dib(&path)?
    };

    if !clipboard_set_dib(&dib) {
        return Err("写入剪贴板失败，可能有其他程序正占用剪贴板，请重试".into());
    }
    Ok(())
}

/// 从 BMP 文件字节里取出 `CF_DIB` 部分（跳过 14 字节的文件头）。
fn bmp_file_to_dib(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // BMP 文件头：2 字节签名 + 4 字节文件长度 + 4 字节保留 + 4 字节像素偏移
    if bytes.len() < 14 || !bytes.starts_with(b"BM") {
        return Err("这不是一个 BMP 文件".into());
    }
    let offset = u32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]) as usize;
    if offset < 14 || offset > bytes.len() {
        return Err("BMP 的像素偏移不合法".into());
    }
    Ok(bytes[14..].to_vec())
}

/// 把 `CF_DIB` 字节写进剪贴板。
fn clipboard_set_dib(dib: &[u8]) -> bool {
    unsafe {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, dib.len());
        if hmem.is_null() {
            return false;
        }
        let dst = GlobalLock(hmem) as *mut u8;
        if dst.is_null() {
            GlobalFree(hmem);
            return false;
        }
        std::ptr::copy_nonoverlapping(dib.as_ptr(), dst, dib.len());
        GlobalUnlock(hmem);

        if !platform::open_clipboard_retry() {
            GlobalFree(hmem);
            return false;
        }
        // ⚠️ 这一行之后，用户原来的剪贴板内容就没了
        EmptyClipboard();
        // 成功后剪贴板接管这块内存的所有权，不能再手动释放
        let ok = !SetClipboardData(CF_DIB, hmem as HANDLE).is_null();
        CloseClipboard();
        if !ok {
            GlobalFree(hmem);
            return false;
        }
        true
    }
}

/// 把图片"键入到当前光标"：放进剪贴板 → 切回上一次的外部窗口 → 模拟 Ctrl+V。
///
/// 与 [`crate::platform::paste_to_target`] 的分工：那边是文本，这边是图片。
/// 图片**不做剪贴板还原**（理由见 [`copy_image_to_clipboard`]），
/// 所以失败路径的提示必须说清"图片已经放进剪贴板，可以手动 Ctrl+V"。
pub fn paste_to_target(app: &AppHandle, id: &str) -> Result<PasteOutcome, String> {
    copy_image_to_clipboard(app, id)?;

    let target_hwnd = platform::last_target_window();
    let mut message: Option<String> = None;
    let target = match target_hwnd {
        Some(hwnd) => {
            let title = platform::window_title(hwnd);
            if !platform::focus_window(hwnd) {
                message = Some("无法切回目标窗口，已把图片放入剪贴板，可手动 Ctrl+V".into());
            }
            // 给系统一点时间完成焦点切换，否则 Ctrl+V 会打偏（与文本路径同一个理由）
            std::thread::sleep(std::time::Duration::from_millis(60));
            title
        }
        None => {
            message = Some("未找到可粘贴的目标窗口，已把图片放入剪贴板，可手动 Ctrl+V".into());
            None
        }
    };

    let mut ok = false;
    if target_hwnd.is_some() && message.is_none() {
        if platform::send_ctrl_v() {
            ok = true;
        } else {
            message = Some(
                "模拟按键被系统拦截（目标程序权限比浮光高），已把图片放入剪贴板，可手动 Ctrl+V"
                    .into(),
            );
        }
    }

    Ok(PasteOutcome {
        ok,
        target,
        message,
    })
}

// ===============================================================
// base64 解码
//
// 编码器复用 `linkicon::base64_encode`（同一个理由：不引依赖）。
// 解码只在"前端回填缩略图"这一条路上用到。
// ===============================================================

/// 极简 base64 解码（标准字母表，允许 `=` 补齐与换行）。
///
/// 遇到非法字符**返回错误**而不是跳过：跳过会让"前端把二进制当 base64 传过来"
/// 这种错误静默变成一个截断的图片，而截断的 PNG 在界面上是裂图。
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;

    for (i, byte) in input.bytes().enumerate() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            // 补齐符之后的内容一律忽略
            b'=' => break,
            // canvas 的 dataURL 去前缀之后不该有空白，但手写/粘贴进来的可能有
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("base64 里有非法字符（第 {i} 个）")),
        } as u32;

        buf = (buf << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= if bits == 0 { 0 } else { (1u32 << bits) - 1 };
        }
    }
    Ok(out)
}

// ===============================================================
// SHA-256
//
// # 为什么自己写
//
// 用途只有一个：给图片内容算去重用的摘要。引 `sha2` 是为这一件事加一个依赖，
// 而这个项目对发布体积敏感（见文件头）；手写 80 行的代价换来零依赖。
//
// # 为什么用 RFC 的标准向量测
//
// 和 `linkicon` 里那份 base64 一样：自己编、自己解，两边同时错也能"通过"。
// 所以测试里钉的是 FIPS 180-4 的官方向量（`abc`、空串、448 位边界）。
// ===============================================================

mod sha256 {
    /// 每轮的常量：前 64 个素数立方根小数部分的前 32 位。
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    /// 初始哈希值：前 8 个素数平方根小数部分的前 32 位。
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    /// 处理一个 64 字节的分组。
    fn compress(hash: &mut [u32; 8], block: &[u8]) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            let o = i * 4;
            *word = u32::from_be_bytes([block[o], block[o + 1], block[o + 2], block[o + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *hash;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }

        for (slot, value) in hash.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    /// 算摘要，返回 64 位小写十六进制。
    pub fn hex(data: &[u8]) -> String {
        let mut hash = H0;

        let mut chunks = data.chunks_exact(64);
        for chunk in &mut chunks {
            compress(&mut hash, chunk);
        }

        // 补齐：先补一个 0x80，再补 0 到「56 mod 64」，最后 8 字节是大端位长度
        let mut tail = chunks.remainder().to_vec();
        tail.push(0x80);
        while tail.len() % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_be_bytes());

        for chunk in tail.chunks_exact(64) {
            compress(&mut hash, chunk);
        }

        hash.iter().map(|word| format!("{word:08x}")).collect()
    }
}

// ===============================================================
// 测试
//
// 这里测的是**纯逻辑**（magic 判定、id 去重、DIB 解析、base64 解码、
// 落盘/删除/统计）以及 GDI+ 那一层的真实转换。
//
// 刻意不测的：真实剪贴板（要用户桌面会话，且会覆盖用户正在用的剪贴板，
// 和 `platform.rs` 里那两条 `#[ignore]` 是同一个理由）。
// ===============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个独立的临时目录。用进程 id + 计数器避免并行测试互相踩。
    fn temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "fuguang-media-test-{}-{tag}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 一张最小的合法 PNG（1×1 透明像素）。
    fn tiny_png() -> Vec<u8> {
        // 用 GDI+ 生成太绕，这里直接写死一份标准的 1×1 PNG 字节
        const BYTES: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        BYTES.to_vec()
    }

    /// 造一个 2×2 的 32bpp `CF_DIB`（自底向上，BI_RGB）。
    fn sample_dib() -> Vec<u8> {
        let mut dib = Vec::new();
        let header = BITMAPINFOHEADER {
            biSize: 40,
            biWidth: 2,
            biHeight: 2,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 16,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        unsafe {
            let raw = std::slice::from_raw_parts(
                &header as *const BITMAPINFOHEADER as *const u8,
                std::mem::size_of::<BITMAPINFOHEADER>(),
            );
            dib.extend_from_slice(raw);
        }
        // 4 个像素，alpha 故意留 0：真实剪贴板就是这样，
        // 而转换时必须把它改成 255（见 `dib_to_bgra`）
        dib.extend_from_slice(&[
            0x00, 0x00, 0xFF, 0x00, // 红
            0x00, 0xFF, 0x00, 0x00, // 绿
            0xFF, 0x00, 0x00, 0x00, // 蓝
            0xFF, 0xFF, 0xFF, 0x00, // 白
        ]);
        dib
    }

    // ---------- magic ----------

    #[test]
    fn 按文件头认出各种图片() {
        assert_eq!(detect_kind(&tiny_png()), Some(PNG));
        assert_eq!(detect_kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(JPEG));
        assert_eq!(detect_kind(b"GIF89a...."), Some(GIF));
        assert_eq!(detect_kind(b"GIF87a...."), Some(GIF));
        assert_eq!(detect_kind(b"BM\x00\x00"), Some(BMP));
        assert_eq!(
            detect_kind(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(WEBP)
        );
    }

    #[test]
    fn 非图片内容不会被误判() {
        // 这些都必须返回 None —— 误判的后果是把一个非图片文件存进图片目录，
        // 界面上从此挂着一张永远显示不出来的图
        for bad in [
            b"".as_slice(),
            b"hello world".as_slice(),
            b"<html><body>x</body></html>".as_slice(),
            // 只有半个 PNG magic
            &[0x89, 0x50, 0x4E, 0x47][..],
            // RIFF 但不是 WEBP（例如 WAV）
            b"RIFF\x00\x00\x00\x00WAVEfmt ".as_slice(),
        ] {
            assert_eq!(detect_kind(bad), None, "不该认成图片：{bad:?}");
        }
    }

    #[test]
    fn 扩展名判定覆盖常见写法() {
        assert_eq!(kind_from_ext("PNG"), Some(PNG));
        assert_eq!(kind_from_ext("jpeg"), Some(JPEG));
        assert_eq!(kind_from_ext("JPG"), Some(JPEG));
        assert_eq!(kind_from_ext("webp"), Some(WEBP));
        assert_eq!(kind_from_ext("svg"), None, "svg 不是位图，不支持");
        assert_eq!(kind_from_ext(""), None);
        assert_eq!(kind_from_ext("png.exe"), None, "多段扩展名要按最后一段判");
    }

    // ---------- id 与去重 ----------

    #[test]
    fn sha256_对上官方测试向量() {
        // FIPS 180-4 的向量。自己编自己解会一起错，所以钉官方向量
        assert_eq!(
            sha256::hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256::hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256::hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // 55 / 56 / 64 字节：补齐要跨分组的三个边界
        assert_eq!(
            sha256::hex(&[b'a'; 55]),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            sha256::hex(&[b'a'; 56]),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
        assert_eq!(
            sha256::hex(&[b'a'; 64]),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
    }

    #[test]
    fn 图片_id_是内容摘要的前_32_位且形状固定() {
        let id = id_for(&tiny_png());
        assert_eq!(id.len(), ID_LEN);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        // 同样的内容必然得到同样的 id —— 去重全靠这一点
        assert_eq!(id, id_for(&tiny_png()));
        // 差一个字节就完全不同
        let mut other = tiny_png();
        other.push(0);
        assert_ne!(id, id_for(&other));
    }

    #[test]
    fn 非法_id_会被拒绝() {
        // 这是安全边界：id 直接拼进文件名
        for bad in [
            "../../settings",
            "abc",
            "",
            "0123456789ABCDEF0123456789abcdef", // 大写：我们不产出大写，也不接受
            "0123456789abcdef0123456789abcde/",
        ] {
            assert!(check_id(bad).is_err(), "应拒绝：{bad:?}");
        }
        assert!(check_id(&id_for(b"x")).is_ok());
    }

    #[test]
    fn 同一张图导入两次只留一份且复用原有时刻() {
        let dir = temp_dir("dedup");
        let png = tiny_png();

        let first = import_bytes_at(&dir, &png, "截图.png").expect("第一次导入");
        let second = import_bytes_at(&dir, &png, "另一个名字.png").expect("第二次导入");

        assert_eq!(first.id, second.id, "内容相同必须得到同一个 id");
        assert_eq!(second.name, "截图.png", "复用已有引用，不覆盖原名");
        assert_eq!(second.added_at, first.added_at, "不该刷新导入时刻");
        assert_eq!(second.mime, "image/png");
        assert_eq!(second.bytes, png.len() as u64);

        // 盘上只能有一份原图 + 一份元数据
        let files: Vec<String> = fs::read_dir(&dir)
            .expect("读目录")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 2, "实际文件：{files:?}");
        assert!(files.iter().any(|f| f == &format!("{}.png", first.id)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 导入会拒绝非图片内容() {
        let dir = temp_dir("reject");
        let err = import_bytes_at(&dir, "这不是图片".as_bytes(), "x.png").expect_err("必须拒绝");
        assert!(err.contains("图片"), "错误信息要能直接给用户看：{err}");

        // 拒绝之后目录里不能留下任何垃圾
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("读目录")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(leftovers.is_empty(), "实际：{leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 落盘的扩展名由文件头决定而不是文件名() {
        // 用户把一张 PNG 存成 .jpg（改扩展名）时，按扩展名落盘会让前端
        // 用 image/jpeg 去解码 PNG 字节 —— 界面上是裂图
        let dir = temp_dir("ext-by-magic");
        let media = import_bytes_at(&dir, &tiny_png(), "其实不是jpg.jpg").expect("导入");
        assert_eq!(media.mime, "image/png");
        assert!(
            dir.join(format!("{}.png", media.id)).is_file(),
            "必须按 magic 落成 .png"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- DIB ----------

    #[test]
    fn 解析_dib_头部() {
        let info = parse_dib(&sample_dib()).expect("应能解析");
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.bit_count, 32);
        assert_eq!(info.compression, BI_RGB);
    }

    #[test]
    fn 自顶向下的负高度要取绝对值() {
        let mut dib = sample_dib();
        // biHeight 在偏移 8
        dib[8..12].copy_from_slice(&(-2i32).to_le_bytes());
        let info = parse_dib(&dib).expect("负高度是合法的自顶向下标记");
        assert_eq!(info.height, 2);
    }

    #[test]
    fn 畸形_dib_不会被当成图片() {
        assert!(parse_dib(&[]).is_none());
        assert!(parse_dib(&[0u8; 39]).is_none(), "短于头部");

        let mut core_header = sample_dib();
        // biSize = 12（OS/2 的 BITMAPCOREHEADER）：不支持
        core_header[0..4].copy_from_slice(&12u32.to_le_bytes());
        assert!(parse_dib(&core_header).is_none());

        let mut zero_width = sample_dib();
        zero_width[4..8].copy_from_slice(&0i32.to_le_bytes());
        assert!(parse_dib(&zero_width).is_none(), "宽度为 0 无意义");

        let mut zero_height = sample_dib();
        zero_height[8..12].copy_from_slice(&0i32.to_le_bytes());
        assert!(parse_dib(&zero_height).is_none(), "高度为 0 无意义");

        // 头部声称比实际字节数还长
        let mut truncated = sample_dib();
        truncated[0..4].copy_from_slice(&108u32.to_le_bytes());
        assert!(parse_dib(&truncated).is_none());
    }

    #[test]
    fn 尺寸离谱的_dib_会被拒绝而不是撑爆内存() {
        let mut dib = sample_dib();
        dib[4..8].copy_from_slice(&40_000i32.to_le_bytes());
        let info = parse_dib(&dib).expect("头部本身合法");
        let err = dib_to_bgra(&dib, &info).expect_err("必须拒绝");
        assert!(err.contains("尺寸"), "实际：{err}");
    }

    #[test]
    fn dib_能真的转成_png_且像素不透明() {
        // 这一条测的是 GDI+ 那一层：转换失败的话，用户"从剪贴板加图片"
        // 会静默失败（返回 None，界面退化成粘贴文字）
        let info = parse_dib(&sample_dib()).expect("解析");
        let (w, h, bgra) = dib_to_bgra(&sample_dib(), &info).expect("转 BGRA");
        assert_eq!((w, h), (2, 2));
        assert_eq!(bgra.len(), 16);
        // alpha 必须被强制成 255：留着 0 的话粘进来的截图是全透明的空白
        assert!(
            bgra.chunks_exact(4).all(|px| px[3] == 255),
            "实际像素：{bgra:?}"
        );

        // 走完整入口（DIB → GDI+ → PNG 字节）
        let bytes = dib_to_png_bytes(&sample_dib()).expect("DIB 转 PNG");
        assert_eq!(detect_kind(&bytes), Some(PNG), "产出的必须是 PNG");
        // PNG 的 IHDR 里能读到宽高，顺带证明编码是完整的
        assert_eq!(
            u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]),
            2
        );
        assert_eq!(
            u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]),
            2
        );

        // 转出来的 PNG 必须能被系统解码器读回去（否则界面上是裂图）
        let dir = temp_dir("dib-png");
        let path = dir.join("roundtrip.png");
        fs::write(&path, &bytes).expect("写 PNG");
        let dib = image_file_to_dib(&path).expect("解码回来");
        let back = parse_dib(&dib).expect("合法 DIB");
        assert_eq!((back.width, back.height), (2, 2));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 备份恢复的图片写回后能读出来并且不覆盖已有那份() {
        let dir = temp_dir("restore");
        let id = id_for(&tiny_png());

        assert!(!exists_at(&dir, &id), "还没写回时不该存在");
        write_original_at(&dir, &id, &tiny_png()).expect("写回");
        assert!(exists_at(&dir, &id));
        assert_eq!(read_original_bytes_at(&dir, &id).expect("读回"), tiny_png());

        // 元数据也要补一份：没有它，这张图在界面上"没有名字"
        let meta = read_meta_at(&dir, &id).expect("元数据");
        assert_eq!(meta.mime, "image/png");
        assert!(meta.name.ends_with(".png"), "实际：{}", meta.name);

        // 重复写回（同一张图出现两次引用）不该报错，也不该刷新 addedAt
        let before = meta.added_at;
        write_original_at(&dir, &id, &tiny_png()).expect("重复写回");
        assert_eq!(read_meta_at(&dir, &id).expect("元数据").added_at, before);

        // 认不出格式的内容要明确拒绝，而不是在 media/ 里留一个垃圾文件
        let err = write_original_at(&dir, "b".repeat(32).as_str(), "不是图片".as_bytes())
            .expect_err("拒绝");
        assert!(err.contains("认不出格式"), "实际：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn png_文件能解成_dib_并且_alpha_是满的() {
        // 「复制图片到剪贴板」那条路。alpha 必须填 255：
        // 32bpp 的 CF_DIB 里那个字节按定义是保留位，但有些程序当 alpha 用，
        // 留着透明像素会让粘出去的是张看不见的图
        let dir = temp_dir("png-dib");
        let png = dir.join("in.png");
        fs::write(&png, tiny_png()).expect("写测试图");

        let dib = image_file_to_dib(&png).expect("应能解码");
        let info = parse_dib(&dib).expect("产出的必须是合法 DIB");
        assert_eq!((info.width, info.height), (1, 1));
        assert_eq!(info.bit_count, 32);
        assert_eq!(dib.len(), 40 + 4, "头部 + 一个像素");
        assert_eq!(dib[43], 255, "alpha 必须是满的");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bmp_文件能直接取出_dib_部分() {
        let dir = temp_dir("bmp-dib");
        // 造一个最小的 BMP 文件：14 字节文件头 + 我们那份 DIB
        let dib = sample_dib();
        let mut bmp = Vec::new();
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&((14 + dib.len()) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0]);
        bmp.extend_from_slice(&14u32.to_le_bytes()); // 像素偏移
        bmp.extend_from_slice(&dib);

        let back = bmp_file_to_dib(&bmp).expect("应能取出");
        assert_eq!(back, dib);
        assert!(bmp_file_to_dib(b"BM\x00").is_err(), "截断的文件头要拒绝");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- base64 解码 ----------

    #[test]
    fn base64_解码对上标准向量() {
        // RFC 4648 的测试向量（与 `linkicon` 里编码侧的向量配套）
        assert_eq!(base64_decode("").expect("空串"), b"");
        assert_eq!(base64_decode("Zg==").expect("f"), b"f");
        assert_eq!(base64_decode("Zm8=").expect("fo"), b"fo");
        assert_eq!(base64_decode("Zm9v").expect("foo"), b"foo");
        assert_eq!(base64_decode("Zm9vYg==").expect("foob"), b"foob");
        assert_eq!(base64_decode("Zm9vYmE=").expect("fooba"), b"fooba");
        assert_eq!(base64_decode("Zm9vYmFy").expect("foobar"), b"foobar");
    }

    #[test]
    fn base64_解码与编码能往返() {
        // 和 linkicon 那份编码器配对：前端回填缩略图时走的就是这条往返
        for len in [0usize, 1, 2, 3, 4, 5, 63, 64, 65, 255] {
            let data: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
            let encoded = base64_encode(&data);
            assert_eq!(base64_decode(&encoded).expect("解码"), data, "长度 {len}");
        }
    }

    #[test]
    fn base64_里的非法字符会被报出来() {
        // 静默跳过非法字符会让"传错东西"变成一个截断的图片（界面上是裂图）
        let err = base64_decode("Zm9v!!!").expect_err("必须报错");
        assert!(err.contains("非法字符"), "实际：{err}");
        // 换行/空格是宽容的：data URL 手工粘贴时常见
        assert_eq!(base64_decode("Zm9v\n").expect("换行"), b"foo");
    }

    // ---------- 元数据 / 删除 / 统计 ----------

    #[test]
    fn 缩略图必须是_png_否则拒绝() {
        let dir = temp_dir("thumb-type");
        let media = import_bytes_at(&dir, &tiny_png(), "a.png").expect("导入");

        // 传一段不是 PNG 的东西（这里用 base64 编码的普通文本）
        let bad = base64_encode(b"not a png");
        let err = set_meta_at(&dir, &media.id, 1, 1, &bad).expect_err("必须拒绝");
        assert!(err.contains("PNG"), "实际：{err}");
        assert!(!thumb_path(&dir, &media.id).exists(), "拒绝时不该留下文件");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 回填宽高会写进元数据并保留原有字段() {
        let dir = temp_dir("meta");
        let media = import_bytes_at(&dir, &tiny_png(), "原名.png").expect("导入");
        assert_eq!(media.width, 0, "导入时宽高未知");

        let thumb = base64_encode(&tiny_png());
        let updated = set_meta_at(&dir, &media.id, 1, 1, &thumb).expect("回填");
        assert_eq!((updated.width, updated.height), (1, 1));
        assert_eq!(updated.name, "原名.png", "回填不该丢掉原名");
        assert_eq!(updated.bytes, media.bytes);

        // 读回来也要对（证明真的落盘了）
        let back = read_meta_at(&dir, &media.id).expect("读元数据");
        assert_eq!((back.width, back.height), (1, 1));
        assert!(thumb_path(&dir, &media.id).is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 删除会清掉三个文件并且可以重复调用() {
        let dir = temp_dir("delete");
        let media = import_bytes_at(&dir, &tiny_png(), "a.png").expect("导入");
        set_meta_at(&dir, &media.id, 1, 1, &base64_encode(&tiny_png())).expect("回填");

        delete_at(&dir, &media.id).expect("第一次删除");
        assert!(read_meta_at(&dir, &media.id).is_none());
        assert!(find_file_at(&dir, &media.id).is_none());
        assert!(!thumb_path(&dir, &media.id).exists());

        // 幂等：界面上的删除按钮被点两次不该报错
        delete_at(&dir, &media.id).expect("第二次删除");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 统计只数原图但把全部占用算进去() {
        let dir = temp_dir("stats");
        let media = import_bytes_at(&dir, &tiny_png(), "a.png").expect("导入");
        set_meta_at(&dir, &media.id, 1, 1, &base64_encode(&tiny_png())).expect("回填");

        let stats = stats_at(&dir);
        assert_eq!(stats.count, 1, "缩略图和元数据不该被算成第二张图");

        let on_disk: u64 = fs::read_dir(&dir)
            .expect("读目录")
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();
        assert_eq!(stats.bytes, on_disk, "bytes 是目录的真实占用");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 目录不存在时统计返回全零而不是报错() {
        let dir = std::env::temp_dir().join("fuguang-media-test-不存在的目录");
        let _ = fs::remove_dir_all(&dir);
        let stats = stats_at(&dir);
        assert_eq!(stats.count, 0);
        assert_eq!(stats.bytes, 0);
    }

    #[test]
    fn dib_的真实长度能从头部算出来() {
        // 剪贴板的 HGLOBAL 是分配大小，可能比数据本身大；不裁掉尾巴的话，
        // 同一张图会因为多出几个字节而算出**不同的 id**，去重直接失效
        let mut dib = sample_dib();
        assert_eq!(
            parse_dib(&dib).expect("解析").exact_len(),
            Some(40 + 4 * 4),
            "32bpp 2×2：40 字节头 + 每行 8 字节 × 2 行"
        );

        // 24bpp 的每行要按 4 字节对齐：宽 3 → 9 字节 → 补到 12
        dib[4..8].copy_from_slice(&3i32.to_le_bytes());
        dib[8..12].copy_from_slice(&3i32.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        assert_eq!(
            parse_dib(&dib).expect("解析").exact_len(),
            Some(40 + 12 * 3),
            "24bpp 3×3：每行 9 字节补到 12"
        );

        // 8bpp 带调色板：biClrUsed 为 0 表示用满 256 项
        dib[14..16].copy_from_slice(&8u16.to_le_bytes());
        dib[32..36].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(
            parse_dib(&dib).expect("解析").exact_len(),
            Some(40 + 256 * 4 + 4 * 3),
            "8bpp：40 字节头 + 256 项调色板 + 每行 4 字节 × 3 行"
        );

        // BI_BITFIELDS + 40 字节头：三个颜色掩码跟在头后面（12 字节）
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[16..20].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(
            parse_dib(&dib).expect("解析").exact_len(),
            Some(40 + 12 + 12 * 3),
            "BITFIELDS：掩码也要算进长度"
        );

        // bitCount 为 0 是畸形数据：算不出来就返回 None（调用方原样用）
        dib[14..16].copy_from_slice(&0u16.to_le_bytes());
        assert_eq!(parse_dib(&dib).expect("解析").exact_len(), None);
    }

    #[test]
    fn png_尾巴会被裁掉但坏_png_原样返回() {
        let png = tiny_png();

        // 模拟"分配大小比数据大"：尾部多出一串垃圾
        let mut padded = png.clone();
        padded.extend_from_slice(&[0xAB; 37]);
        assert_eq!(trim_png(&padded), png.as_slice(), "必须裁到 IEND 结束处");
        assert_eq!(trim_png(&png), png.as_slice(), "没有尾巴时不该改动");

        // 截断的 PNG（块长度声称超过实际）：原样返回，交给解码器报错
        let broken = &png[..png.len() - 6];
        assert_eq!(trim_png(broken), broken);
    }

    #[test]
    fn 超过体积上限的图片会被拒绝() {
        // 上限是产品决定（20 MB），但**所有导入路径**都要过这道闸 ——
        // 剪贴板路径漏掉的话，用户从某个程序复制一张超大图就能把数据目录撑爆
        let mut huge = tiny_png();
        huge.resize(MAX_IMAGE_BYTES as usize + 1, 0);

        let dir = temp_dir("too-big");
        let err = import_bytes_at(&dir, &huge, "大图.png").expect_err("必须拒绝");
        assert!(err.contains("太大"), "实际：{err}");

        // 拒绝之后目录里不能留下任何东西
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("读目录")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(leftovers.is_empty(), "实际：{leftovers:?}");

        // 边界：正好等于上限要放行（不能因为差一个字节把合法图片挡在外面）
        let mut exact = tiny_png();
        exact.resize(MAX_IMAGE_BYTES as usize, 0);
        assert!(import_bytes_at(&dir, &exact, "正好.png").is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 读不存在的图片会给出可读原因() {
        let dir = temp_dir("missing");
        let err = read_data_url_at(&dir, &id_for(b"x"), true).expect_err("必须报错");
        assert!(err.contains("找不到"), "实际：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn data_url_的_mime_跟着真实格式走() {
        // 写死 image/png 会让 JPEG 的 data URL 解码失败（浏览器直接拒绝渲染）
        let dir = temp_dir("mime");
        let media = import_bytes_at(&dir, &tiny_png(), "a.png").expect("导入");
        let url = read_data_url_at(&dir, &media.id, true).expect("读原图");
        assert!(url.starts_with("data:image/png;base64,"), "实际：{url}");

        // 有缩略图时 full=false 读缩略图（一定是 PNG）
        set_meta_at(&dir, &media.id, 1, 1, &base64_encode(&tiny_png())).expect("回填");
        let thumb_url = read_data_url_at(&dir, &media.id, false).expect("读缩略图");
        assert!(thumb_url.starts_with("data:image/png;base64,"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 没有缩略图时读缩略图要退回原图() {
        // 退回原图而不是报错：缩略图是异步回填的，列表先渲染出来时它可能还没生成
        let dir = temp_dir("thumb-fallback");
        let media = import_bytes_at(&dir, &tiny_png(), "a.png").expect("导入");
        let url = read_data_url_at(&dir, &media.id, false).expect("应退回原图");
        assert!(url.starts_with("data:image/png;base64,"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 另存为会把原图字节原样拷出去() {
        let dir = temp_dir("export");
        let media = import_bytes_at(&dir, &tiny_png(), "a.png").expect("导入");
        let dest = dir.join("导出的.png");

        export_at(&dir, &media.id, &dest).expect("另存为");
        assert_eq!(fs::read(&dest).expect("读导出文件"), tiny_png());

        // 目标目录不存在时要给出可读原因，而不是一个裸的 IO 错误
        let err = export_at(&dir, &media.id, &dir.join("没有这个目录/x.png")).expect_err("必须报错");
        assert!(err.contains("目标文件夹不存在"), "实际：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---------- 写盘原子性 ----------

    #[test]
    fn 原子写入不留临时文件() {
        let dir = temp_dir("atomic");
        let path = dir.join("x.png");
        write_bytes_atomic(&path, &tiny_png()).expect("写入");

        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("读目录")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "实际：{leftovers:?}");
        assert_eq!(fs::read(&path).expect("读回"), tiny_png());
        let _ = fs::remove_dir_all(&dir);
    }
}
