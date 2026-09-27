fn main() {
    // 让 cargo 在图标变化时重新运行本脚本。
    //
    // 为什么需要这一条：`tauri_build::build()` 默认只声明监视
    // `tauri.conf.json` 与 `capabilities/`，**不监视图标文件**。
    // 于是换掉 `icons/icon.ico` 之后，构建脚本不会重跑，
    // 生成的 `resource.rc` 还是旧的，exe 里嵌的仍然是上一版图标 ——
    // 而且**完全不报错**，只有把 exe 的图标提取出来看才会发现。
    //
    // 这个坑实测踩到过：换成新标志后跑完整 release 构建，
    // 产物里还是最初那个占位图标。
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
