//! 从文件/程序提取图标，供快捷链接显示。
//!
//! # 为什么返回 RGBA 而不是 PNG
//!
//! 要在 Rust 里编码 PNG 就得引入 `image` crate（或自己写编码器），
//! 都是额外的体积或代码量。而前端有 canvas，把 RGBA 画上去再
//! `toDataURL()` 就能得到 PNG —— 编码这件事交给浏览器做最划算。
//!
//! 所以这里返回原始 RGBA 字节（base64 编码以减小 JSON 体积），
//! 前端拿到后画进 canvas 并缓存成 data URL。
//!
//! # 失败即降级
//!
//! 提取图标涉及 Shell 与 GDI 一堆 API，任何一步都可能失败
//! （文件被删、权限不足、图标格式古怪）。这里的原则是
//! **任何失败都返回 None，绝不 panic**，前端收到 None 就显示按类型区分的内置图标。

#![cfg(windows)]

use std::ffi::c_void;
use std::sync::Mutex;

use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ,
};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// 提取结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconData {
    pub width: u32,
    pub height: u32,
    /// RGBA 像素的 base64 编码，长度应为 width*height*4。
    pub rgba_base64: String,
}

/// 提取串行化用的锁。
///
/// # 为什么必须串行（实测数据）
///
/// 起 40 个线程同时提取，**只有 1 个成功、39 个失败**，
/// 失败点全都一样：`SHGetFileInfoW` 返回 1（成功）但 `hIcon` 是**空指针**。
/// 串行化之后同一台机器上 40 个全部成功。
///
/// 这不是"可能有问题"的猜测，而是真实发生过的用户可见故障：
/// 链接页一次会挂出几十个格子（用户的链接页有 53 条），
/// 于是**大部分图标都出不来**，界面上只剩通用占位图标 ——
/// 用户的原话是「图标怎么消失了？我移动图标才会恢复正常」
/// （拖动会让那一格重新挂载，那时缓存已经写好，所以单独拖一个能显示）。
///
/// # 代价
///
/// 一次提取几毫秒，53 条串起来不到一秒；而且它跑在后台线程池上，
/// 不占界面线程。极端情况下（某个快捷方式指向慢速可移动盘）
/// 会让后面的图标等一会儿 —— 但"图标晚一点出来"远好过"图标出不来"。
static ICON_LOCK: Mutex<()> = Mutex::new(());

/// 从指定路径提取图标。失败返回 None。
pub fn extract(path: &str) -> Option<IconData> {
    if path.is_empty() {
        return None;
    }
    // 网络路径一律不碰。前端拿不到图标就退回内置图标，用户完全无感；
    // 而"为了画一个图标去连一台陌生主机"是不能接受的代价（见 touches_network）。
    if touches_network(path) {
        return None;
    }

    // 中毒了也继续用：图标是尽力而为的东西，
    // 不该因为某个线程 panic 过一次就永久失效。
    let _guard = ICON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    unsafe { extract_inner(path) }
}

/// 判断这个路径会不会让 Shell 去访问网络。
///
/// # 为什么必须拦
///
/// `SHGetFileInfoW` 不带 `SHGFI_USEFILEATTRIBUTES` 时会**真实解析**路径。
/// 对 `\\attacker\share\x.exe` 这种 UNC 路径，Windows 会去连 SMB 并做 NTLM 认证 ——
/// 于是「打开链接页」这个动作就变成了「把当前用户的 NetNTLM 响应发给攻击者指定的主机」，
/// 可以离线破解或做中继。
///
/// 链接目标是完全自由的字符串（可以从别人给的备份里导进来），
/// 而链接页**渲染即自动提取图标、不需要任何点击**，所以这一步是零点击可达的，
/// 必须在调用 Shell 之前拦住。
///
/// 顺带的好处：不可达主机不再让 `SHGetFileInfoW` 阻塞到 SMB 超时（几十秒）拖住界面。
///
/// # 为什么不做「映射网络驱动器」的检查
///
/// 那需要 `GetDriveTypeW` + `DRIVE_REMOTE`，而该常量在这个版本的 windows-sys 里位于
/// `Win32::System::WindowsProgramming` —— 为一个判断引入整个绑定模块不划算。
/// 更要紧的是**它不是攻击者可控的**：盘符映射是用户自己的配置，
/// 攻击者无法凭空让 `Z:` 指向他的服务器。UNC 才是唯一的零点击通道。
fn touches_network(path: &str) -> bool {
    let p = path.trim();

    // UNC：`\\server\share\...`、`\\?\UNC\server\share`，以及正斜杠写法
    if p.starts_with("\\\\") || p.starts_with("//") {
        return true;
    }

    // 带协议头的 URL（http://、ftp://…）：Shell 同样会去连网络。
    // 前端对 `kind === "url"` 已经跳过，但链接类型本身也能被备份文件改掉，
    // 所以这里必须自己再挡一次，不能依赖前端的判断。
    // Windows 文件名里不可能出现 `:`（除盘符），所以这个子串不会误伤本地路径。
    if p.contains("://") {
        return true;
    }

    false
}

/// # Safety
/// 只在本模块内调用，内部已处理所有句柄的释放。
unsafe fn extract_inner(path: &str) -> Option<IconData> {
    // 1) 问 Shell 要一个 HICON
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut shfi = SHFILEINFOW::default();
    let ok = SHGetFileInfoW(
        wide.as_ptr(),
        0,
        &mut shfi,
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON, // SHGFI_LARGEICON 的值是 0，所以不必再或上
    );
    if ok == 0 || shfi.hIcon.is_null() {
        return None;
    }
    let hicon = shfi.hIcon;

    // 从这里开始，任何提前返回都必须先销毁 hicon，所以用闭包包一层
    let result = (|| -> Option<IconData> {
        // 2) 拆出颜色位图与掩码位图
        let mut info = ICONINFO::default();
        if GetIconInfo(hicon, &mut info) == 0 {
            return None;
        }
        let hbm_color = info.hbmColor;
        let hbm_mask = info.hbmMask;
        if hbm_color.is_null() {
            // 单色图标没有颜色位图，直接放弃，交给前端用内置图标
            if !hbm_mask.is_null() {
                DeleteObject(hbm_mask as HGDIOBJ);
            }
            return None;
        }

        let out = (|| -> Option<IconData> {
            // 3) 问位图要尺寸
            let mut bm = BITMAP::default();
            let got = GetObjectW(
                hbm_color as HGDIOBJ,
                std::mem::size_of::<BITMAP>() as i32,
                &mut bm as *mut BITMAP as *mut c_void,
            );
            if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
                return None;
            }
            let w = bm.bmWidth as u32;
            let h = bm.bmHeight as u32;
            // 防御异常大的图标（正常不会超过 256）
            if w > 512 || h > 512 {
                return None;
            }

            // 4) 用 32bpp 自顶向下的 DIB 把像素读出来
            let mut bi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w as i32,
                    // 负高度 = 自顶向下，省得后面再翻转行
                    biHeight: -(h as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0, // BI_RGB
                    ..Default::default()
                },
                ..Default::default()
            };

            let dc = CreateCompatibleDC(std::ptr::null_mut());
            if dc.is_null() {
                return None;
            }

            let mut buf = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(
                dc,
                hbm_color,
                0,
                h,
                buf.as_mut_ptr() as *mut c_void,
                &mut bi,
                DIB_RGB_COLORS,
            );
            DeleteDC(dc);

            if lines == 0 {
                return None;
            }

            // 5) BGRA -> RGBA
            let mut has_alpha = false;
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
                if px[3] != 0 {
                    has_alpha = true;
                }
            }

            // 老式图标不带 alpha 通道，读出来全是 0，那样会变成全透明。
            // 这种情况下退化成不透明，至少图标能看见。
            if !has_alpha {
                for px in buf.chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }

            Some(IconData {
                width: w,
                height: h,
                rgba_base64: base64_encode(&buf),
            })
        })();

        // 位图用完必须释放，否则每调一次就漏一点 GDI 资源
        DeleteObject(hbm_color as HGDIOBJ);
        if !hbm_mask.is_null() {
            DeleteObject(hbm_mask as HGDIOBJ);
        }
        out
    })();

    DestroyIcon(hicon);
    result
}

/// 极简 base64 编码（标准字母表 + 补 `=`）。
///
/// 自己写而不是引入 `base64` crate：只有这一个用途，
/// 二十来行代码换掉一个依赖是划算的（本项目对发布体积敏感）。
///
/// 对 `crate::media` / `crate::backup` 公开：图片的 base64 也走这一份 ——
/// 三处各写一份编码器，迟早会有一处编错（而编错的表现是"图片花了/文件坏了"）。
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;

        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ===============================================================
// 测试
//
// base64 是自己手写的，而且它编码的是**图标像素**——
// 一旦编错，表现是"图标花了"或"图标根本不显示"，
// 前端只会静默降级成内置图标，用户完全不会知道发生了什么。
//
// 所以这里用 RFC 4648 的标准测试向量来验证，而不是自己编自己解
// （那样即使两边同时错也能"通过"）。
// ===============================================================

#[cfg(test)]
mod real_icon_tests {
    use super::*;

    /// 并发提取几十个图标，必须**全部成功**。
    ///
    /// # 这条测试抓出过一个真实的用户故障
    ///
    /// 没有串行化之前，起 40 个线程同时提取：**只有 1 个成功、39 个失败**，
    /// 失败点全都是 `SHGetFileInfoW` 返回 1 但 `hIcon` 是空指针。
    /// 而链接页一次就会挂出几十个格子（用户的链接页有 53 条）——
    /// 于是大部分图标都出不来，界面上只剩通用占位图标。
    /// 用户的原话：「图标怎么消失了？我移动图标才会恢复正常」。
    ///
    /// 所以这条不是"锦上添花的健壮性测试"，它是那个 bug 的回归测试：
    /// 谁把 `ICON_LOCK` 拿掉，这里立刻会红。
    #[test]
    fn 并发提取几十个图标必须全部成功() {
        let mut seeds: Vec<String> = Vec::new();
        let notepad = r"C:\Windows\System32\notepad.exe";
        if std::path::Path::new(notepad).exists() {
            seeds.push(notepad.into());
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            if let Ok(entries) = std::fs::read_dir(format!(r"{home}\Desktop")) {
                seeds.extend(
                    entries
                        .flatten()
                        .map(|e| e.path().to_string_lossy().into_owned())
                        .filter(|p| p.to_ascii_lowercase().ends_with(".lnk"))
                        .take(8),
                );
            }
        }
        if seeds.is_empty() {
            eprintln!("跳过：这台机器上找不到可用的测试路径");
            return;
        }

        // 凑到 32 个：同一个路径重复提取也是并发（而且更能暴露共享状态的问题）
        let mut paths = Vec::new();
        while paths.len() < 32 {
            let i = paths.len() % seeds.len();
            paths.push(seeds[i].clone());
        }

        let handles: Vec<_> = paths
            .into_iter()
            .map(|p| std::thread::spawn(move || extract(&p).is_some()))
            .collect();
        let results: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let failed = results.iter().filter(|ok| !**ok).count();
        assert_eq!(
            failed, 0,
            "并发提取 {} 个里有 {failed} 个失败 —— 检查 ICON_LOCK 是不是被去掉了",
            results.len()
        );
    }
    /// 真去 Shell 要一个图标，验证整条提取链路（Shell → GDI → RGBA → base64）。
    ///
    /// # 为什么要测真实路径，而不是只测纯逻辑
    ///
    /// 这条链路上任何一环坏掉，界面上看到的都是"图标不见了"。
    /// **用户实测报过这个**，当时就是靠这个测试排除了"Rust 侧提取失败"
    /// 这一整类原因：`.exe` 和 `.lnk` 都提取得出来，都是 32×32、长度一致 ——
    /// 于是问题被定位到前端丢更新（见 `links/index.tsx` 的 `iconListeners`）。
    ///
    /// 用 `notepad.exe` 是因为它在所有 Windows 上都有；
    /// 万一没有（被精简过的系统）就跳过，不让测试变成机器相关。
    #[test]
    fn 能从真实的_exe_提取出合法图标() {
        let path = r"C:\Windows\System32\notepad.exe";
        if !std::path::Path::new(path).exists() {
            eprintln!("跳过：这台机器上没有 {path}");
            return;
        }

        let icon = extract(path).expect("notepad.exe 必须能提取出图标");

        // Shell 给的是"大图标"，Windows 上是 32×32
        assert_eq!(icon.width, 32);
        assert_eq!(icon.height, 32);
        // base64 长度必须是 4/3 倍像素字节数（32×32×4 = 4096 → 5464）
        assert_eq!(icon.rgba_base64.len(), 5464);
        // 不能是"全透明"：那种图标提取出来了也等于没提取
        assert!(
            icon.rgba_base64.chars().any(|c| c != 'A'),
            "提取到的是全透明图标"
        );
    }

    /// 快捷方式（`.lnk`）也要能提取 —— 用户桌面上的程序几乎全是 .lnk。
    ///
    /// 这条曾经是重点怀疑对象（"是不是只有 .lnk 提取失败"），实测排除了。
    /// 留着当回归：`SHGetFileInfoW` 对 `.lnk` 会去**解析目标**，
    /// 这条路径比直接给 `.exe` 复杂得多。
    #[test]
    fn 能从快捷方式提取出合法图标() {
        // 找桌面上任意一个 .lnk，找不到就跳过（无头机器上可能没有）
        let Ok(home) = std::env::var("USERPROFILE") else {
            eprintln!("跳过：拿不到 USERPROFILE");
            return;
        };
        let desktop = format!(r"{home}\Desktop");
        let Ok(entries) = std::fs::read_dir(&desktop) else {
            eprintln!("跳过：读不到桌面目录 {desktop}");
            return;
        };
        let lnk = entries
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")));
        let Some(lnk) = lnk else {
            eprintln!("跳过：桌面上没有 .lnk");
            return;
        };

        let icon = extract(&lnk.to_string_lossy()).expect("桌面的 .lnk 必须能提取出图标");
        assert_eq!(icon.width, 32);
        assert_eq!(icon.height, 32);
        assert_eq!(icon.rgba_base64.len(), 5464);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空输入编码成空串() {
        assert_eq!(base64_encode(&[]), "");
    }

    #[test]
    fn 符合官方标准测试向量() {
        // 这三组是 RFC 4648 §10 的官方测试向量，
        // 覆盖了"不需要补位""补一个 =""补两个 ="三种情况
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn 高位字节不会出错() {
        // 图标像素里大量出现 0xFF 这类字节。
        // 如果位运算写错（例如用了 i8 而不是 u32），这里会先炸。
        assert_eq!(base64_encode(&[0xFF, 0xFE, 0xFD]), "//79");
        assert_eq!(base64_encode(&[0x00, 0x00, 0x00]), "AAAA");
        assert_eq!(base64_encode(&[0xFF, 0xFF, 0xFF]), "////");
        assert_eq!(base64_encode(&[0x80, 0x00, 0x00]), "gAAA");
    }

    #[test]
    fn 输出长度总是四的倍数() {
        // base64 的定义要求如此；长度不对说明补位逻辑有问题，
        // 前端的 atob 会直接抛异常
        for len in 0..40usize {
            let data = vec![0xABu8; len];
            let encoded = base64_encode(&data);
            assert_eq!(
                encoded.len() % 4,
                0,
                "长度 {len} 的输入编码后长度不是 4 的倍数：{encoded}"
            );
            // 期望长度：每 3 字节 4 字符，不足的按 4 取整
            assert_eq!(encoded.len(), len.div_ceil(3) * 4);
        }
    }

    #[test]
    fn 只包含合法字符与补位符() {
        let data: Vec<u8> = (0..=255u8).collect();
        let encoded = base64_encode(&data);

        // `=` 只允许出现在末尾，且最多两个
        let body = encoded.trim_end_matches('=');
        assert!(encoded.len() - body.len() <= 2, "补位符过多");
        assert!(!body.contains('='), "补位符只能出现在末尾");

        for ch in body.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '+' || ch == '/',
                "出现非法 base64 字符：{ch:?}"
            );
        }
    }

    #[test]
    fn 图标数据的序列化字段名是驼峰() {
        // 前端按 `rgbaBase64` 读取，字段名不一致会导致图标永远显示不出来
        let icon = IconData {
            width: 2,
            height: 2,
            rgba_base64: "AAAA".into(),
        };

        let json = serde_json::to_string(&icon).expect("序列化");

        assert!(json.contains("\"rgbaBase64\""), "实际：{json}");
        assert!(json.contains("\"width\""));
        assert!(!json.contains("rgba_base64"));
    }

    #[test]
    fn 一个真实尺寸的图标编码后长度符合预期() {
        // 32x32 的 RGBA 图标 = 4096 字节
        let pixels = vec![0x7Fu8; 32 * 32 * 4];
        let encoded = base64_encode(&pixels);

        // 4096 / 3 = 1365 组余 1 字节，所以 1366*4 = 5464 字符
        assert_eq!(encoded.len(), 5464);
        assert!(encoded.ends_with("=="), "4096 不能被 3 整除，末尾应有补位");
    }

    #[test]
    fn unc_路径会被判定为网络路径() {
        // 这一条守的是「导入别人的备份 → 打开链接页 → 自动向攻击者主机做 NTLM 认证」。
        // 判定必须覆盖各种写法，漏一种就等于没拦。
        for bad in [
            r"\\attacker\share\x.exe",
            r"\\?\UNC\attacker\share\x.exe",
            r"\\10.0.0.1\c$\Windows\notepad.exe",
            "//attacker/share/x.exe",
            r"  \\attacker\share\x.exe  ", // 前后空格不该让它绕过
            "http://attacker/x.ico",
            "https://attacker/x.exe",
            "ftp://attacker/x.exe",
        ] {
            assert!(touches_network(bad), "必须拦住：{bad}");
        }
    }

    #[test]
    fn 普通本地路径不会被误判成网络路径() {
        // 误判的代价是"图标不显示了"，所以也要钉住正常路径
        for good in [
            r"C:\Windows\notepad.exe",
            r"D:\software\浮光\fuguang.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            "notepad.exe",
            "",
        ] {
            assert!(!touches_network(good), "不该拦住：{good}");
        }
    }
}
