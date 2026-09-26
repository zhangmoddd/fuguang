// 阻止 Windows 下弹出额外的控制台窗口。
// release 下窗口子系统；debug 下保留控制台便于看 Rust 侧日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fuguang_lib::run()
}
