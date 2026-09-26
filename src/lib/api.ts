/**
 * 与 Rust 侧通信的统一入口。
 *
 * 前端任何地方都不直接写 `invoke("xxx")` 字符串，
 * 一律走这里。好处是命令名拼错会在编译期暴露，而且以后改命令名只需改一处。
 */
import { invoke } from "@tauri-apps/api/core";

/** 粘贴结果，与 Rust 侧 `platform::PasteOutcome` 一一对应。 */
export interface PasteOutcome {
  ok: boolean;
  /** 粘贴目标窗口标题，用于给用户显示「→ 微信」这类反馈。 */
  target: string | null;
  /** 失败或降级原因。 */
  message: string | null;
}

export const api = {
  /** 切换主面板显隐。 */
  togglePanel: () => invoke<void>("toggle_panel"),

  /** 显示主面板。 */
  showPanel: () => invoke<void>("show_panel"),

  /** 隐藏主面板。 */
  hidePanel: () => invoke<void>("hide_panel"),

  /** 隐藏悬浮球。 */
  hideBall: () => invoke<void>("hide_ball"),

  /** 显示悬浮球。 */
  showBall: () => invoke<void>("show_ball"),

  /** 在悬浮球上弹出原生右键菜单。 */
  showBallMenu: () => invoke<void>("show_ball_menu"),

  /** 退出软件。 */
  quit: () => invoke<void>("quit_app"),

  /**
   * 把文本粘贴到上一次使用的外部窗口的光标处。
   * @param text 要粘贴的文本
   * @param restoreDelayMs 粘贴后多久还原用户原剪贴板，默认 120ms
   */
  pasteText: (text: string, restoreDelayMs?: number) =>
    invoke<PasteOutcome>("paste_text", { text, restoreDelayMs }),

  /** 只复制到剪贴板，不粘贴。 */
  copyText: (text: string) => invoke<boolean>("copy_text", { text }),

  /** 读取数据文件；文件不存在返回 null。 */
  readData: <T>(file: string) => invoke<T | null>("read_data", { file }),

  /** 写入数据文件。 */
  writeData: (file: string, value: unknown) => invoke<void>("write_data", { file, value }),

  /** 取数据目录路径。 */
  dataDirPath: () => invoke<string>("data_dir_path"),

  /** 在资源管理器打开数据目录。 */
  openDataDir: () => invoke<void>("open_data_dir"),

  /** 设置窗口置顶。 */
  setAlwaysOnTop: (label: string, value: boolean) =>
    invoke<void>("set_always_on_top", { label, value }),
};
