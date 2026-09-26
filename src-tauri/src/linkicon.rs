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

/// 从指定路径提取图标。失败返回 None。
pub fn extract(path: &str) -> Option<IconData> {
    if path.is_empty() {
        return None;
    }
    unsafe { extract_inner(path) }
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
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
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
