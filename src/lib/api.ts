/**
 * 与 Rust 侧通信的统一入口。
 *
 * 前端任何地方都不直接写 `invoke("xxx")` 字符串，
 * 一律走这里。好处是命令名拼错会在编译期暴露，而且以后改命令名只需改一处。
 *
 * # 时间约定
 *
 * 所有时间点都是 **Unix 毫秒（number）**。
 * 日期计算（"下一次提醒是什么时候"）一律在前端用 `Date` 完成，
 * Rust 只负责比较 `now` 和目标时刻。原因见 `src-tauri/src/models.rs`。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 粘贴结果，与 Rust 侧 `platform::PasteOutcome` 一一对应。 */
export interface PasteOutcome {
  ok: boolean;
  /** 粘贴目标窗口标题，用于给用户显示「→ 微信」这类反馈。 */
  target: string | null;
  /** 失败或降级原因。 */
  message: string | null;
}

// ===============================================================
// 计时器
// ===============================================================

export type TimerKind = "countdown" | "pomodoro" | "stopwatch";
export type PomodoroPhase = "focus" | "break";

export interface Timer {
  id: string;
  name: string;
  kind: TimerKind;
  /**
   * 绝对结束时刻。运行中的倒计时/番茄钟用它。
   * 存结束时刻而不是剩余秒数，关机重启后时间依然准确。
   */
  endsAt: number | null;
  /** 暂停时保留的剩余毫秒。 */
  remainingMs: number | null;
  /**
   * 倒计时设定的总时长（毫秒）。
   *
   * 必须单独存：`remainingMs` 在到点后会被清成 0、暂停时又是动态值，
   * 都不能代表"用户当初设了多久"。没有它的话，
   * 「重置」和「重新开始」就只能去猜一个默认时长。
   */
  durationMs: number | null;
  phase: PomodoroPhase | null;
  focusMinutes: number;
  breakMinutes: number;
  rounds: number;
  /** 秒表：已累计毫秒，不含当前正在跑的一段。 */
  elapsedMs: number;
  /** 秒表：当前这一段的开始时刻。 */
  runningSince: number | null;
  laps: number[];
  fired: boolean;
  createdAt: number;
}

// ===============================================================
// 备忘录
// ===============================================================

export type Repeat = "none" | "daily" | "weekly" | "monthly" | "weekday";

export interface Memo {
  id: string;
  /** 记录日期，`YYYY-MM-DD`（按本地时区）。 */
  date: string;
  title: string;
  body: string;
  tags: string[];
  /** 下一次该提醒的绝对时刻。null 表示不提醒。 */
  remindAt: number | null;
  repeat: Repeat;
  /** 已经为哪个 remindAt 值弹过窗，用于幂等。 */
  firedFor: number | null;
  createdAt: number;
  updatedAt: number;
}

// ===============================================================
// 快捷链接
// ===============================================================

export type LinkKind = "program" | "folder" | "file" | "url";

export interface LinkItem {
  id: string;
  name: string;
  /** 目标路径或网址。 */
  target: string;
  args: string | null;
  kind: LinkKind;
  order: number;
  createdAt: number;
}

/** 提取到的图标：RGBA 像素 + 尺寸。 */
export interface IconData {
  width: number;
  height: number;
  /** RGBA 字节的 base64，长度应为 width*height*4。 */
  rgbaBase64: string;
}

// ===============================================================
// 设置
// ===============================================================

export interface Settings {
  autostart: boolean;
  pasteRestoreDelayMs: number;
  panelAlwaysOnTop: boolean;
  alertSound: boolean;
  /** 是否启用全局热键唤出面板。 */
  hotkeyEnabled: boolean;
  /** 全局热键组合，例如 `Ctrl+Shift+Space`。 */
  hotkey: string;
}

// ===============================================================
// 命令
// ===============================================================

export const api = {
  // ---- 窗口与进程 ----
  togglePanel: () => invoke<void>("toggle_panel"),
  showPanel: () => invoke<void>("show_panel"),
  hidePanel: () => invoke<void>("hide_panel"),
  hideBall: () => invoke<void>("hide_ball"),
  showBall: () => invoke<void>("show_ball"),
  quit: () => invoke<void>("quit_app"),
  showBallMenu: () => invoke<void>("show_ball_menu"),
  setAlwaysOnTop: (label: string, value: boolean) =>
    invoke<void>("set_always_on_top", { label, value }),

  // ---- 剪贴板 ----
  /**
   * 把文本粘贴到上一次使用的外部窗口的光标处。
   * @param restoreDelayMs 粘贴后多久还原用户原剪贴板；省略则用设置里的值
   */
  pasteText: (text: string, restoreDelayMs?: number) =>
    invoke<PasteOutcome>("paste_text", { text, restoreDelayMs }),
  copyText: (text: string) => invoke<boolean>("copy_text", { text }),

  // ---- 通用数据文件（文本片段还在用）----
  readData: <T>(file: string) => invoke<T | null>("read_data", { file }),
  writeData: (file: string, value: unknown) => invoke<void>("write_data", { file, value }),
  dataDirPath: () => invoke<string>("data_dir_path"),
  openDataDir: () => invoke<void>("open_data_dir"),

  // ---- 计时器 ----
  timersList: () => invoke<Timer[]>("timers_list"),
  timerSave: (timer: Timer) => invoke<void>("timer_save", { timer }),
  timerRemove: (id: string) => invoke<void>("timer_remove", { id }),

  // ---- 备忘录 ----
  memosList: () => invoke<Memo[]>("memos_list"),
  memoSave: (memo: Memo) => invoke<void>("memo_save", { memo }),
  memoRemove: (id: string) => invoke<void>("memo_remove", { id }),

  // ---- 快捷链接 ----
  linksList: () => invoke<LinkItem[]>("links_list"),
  linkSave: (link: LinkItem) => invoke<void>("link_save", { link }),
  linkRemove: (id: string) => invoke<void>("link_remove", { id }),
  linkLaunch: (id: string) => invoke<void>("link_launch", { id }),
  openTarget: (target: string, args?: string | null) =>
    invoke<void>("open_target", { target, args: args ?? null }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  linkIcon: (path: string) => invoke<IconData | null>("link_icon", { path }),

  // ---- 设置 ----
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSave: (settings: Settings) => invoke<void>("settings_save", { settings }),
  autostartGet: () => invoke<boolean>("autostart_get"),
  autostartSet: (enabled: boolean) => invoke<void>("autostart_set", { enabled }),
  currentExe: () => invoke<string>("current_exe"),

  // ---- 全局热键 ----
  /**
   * 取**当前实际生效**的热键文本。
   *
   * 注意这不是设置里存的值：注册可能失败（组合键被别的程序占用），
   * 这时存着却没生效。要显示真实状态就必须用这个。
   */
  hotkeyCurrent: () => invoke<string | null>("hotkey_current"),
  /** 应用热键设置。注册失败会返回可读的中文原因，必须显示给用户。 */
  hotkeyApply: (enabled: boolean, combo: string) =>
    invoke<void>("hotkey_apply", { enabled, combo }),
  /** 只校验组合键文本是否合法，不实际注册。用于输入时的即时提示。 */
  hotkeyValidate: (combo: string) => invoke<string>("hotkey_validate", { combo }),
};

// ===============================================================
// 事件订阅
// ===============================================================

/** 后端状态发生变化（计时器到点、提醒触发等），前端应重新拉取数据。 */
export function onStateChanged(
  cb: (what: string[]) => void,
): Promise<UnlistenFn> {
  return listen<{ what: string[] }>("state-changed", (e) => cb(e.payload.what));
}

/** 提醒弹窗收到新内容。 */
export function onAlertContent(
  cb: (payload: { title: string; body: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ title: string; body: string }>("alert:content", (e) => cb(e.payload));
}

/** 生成一个足够唯一的 id。本地单机场景时间戳 + 随机数已足够。 */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
