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
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export type TimerKind = "countdown" | "pomodoro" | "stopwatch" | "alarm";
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
  /**
   * 闹钟：响铃的钟点，**从本地零点起的分钟数**（0~1439）。
   *
   * 和倒计时的 `durationMs` 是同一个角色：`endsAt` 是"下一次响的绝对时刻"，
   * 响过就清空了，代表不了用户设的那个钟点。没有它，「停止」之后再
   * 「开始」就只能去猜一个时间。
   *
   * 存分钟数而不是 `"07:30"`：字符串要解析、有格式歧义，分钟数是唯一表示。
   * 换算与取模见 `lib/alarm.ts` 的 `formatClock` / `parseClock`。
   */
  alarmMinutes: number;
  /** 闹钟：是否每天重复。`false` 表示只响一次。 */
  alarmDaily: boolean;
  fired: boolean;
  /**
   * 所属文件夹 id，`null` 表示在顶层。
   *
   * 后加字段：老数据里没有，Rust 侧 `#[serde(default)]` 会补成 `null`。
   */
  folderId: string | null;
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
  /**
   * 所属文件夹 id，`null` 表示在顶层。
   *
   * 后加字段：老数据里没有，Rust 侧 `#[serde(default)]` 会补成 `null`。
   */
  folderId: string | null;
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
// 文件夹
// ===============================================================

/**
 * 一个文件夹，用来给条目分类。
 *
 * 三个页签（链接 / 文本片段 / 计时器）**共用同一个列表**，靠 `feature` 区分归属，
 * 所以取回来之后要先用 {@link foldersOf} 过滤。备忘不做文件夹：它的组织维度是日期。
 *
 * 嵌套用 `parentId` 表达，`null` 就是顶层。
 */
export interface Folder {
  id: string;
  /** 属于哪个页签，取值是 `FeatureModule.id`（`links` / `snippets` / `timer`）。 */
  feature: string;
  name: string;
  /** 备注。名字要短才排得下，想写清楚用途就写在这里。 */
  note: string;
  /** 父文件夹 id，`null` 表示在顶层。 */
  parentId: string | null;
  order: number;
  createdAt: number;
}

// ===============================================================
// 文本片段
// ===============================================================

/**
 * 一条文本片段。
 *
 * 它是**前端自己拥有**的数据类型：不像计时器 / 备忘 / 链接那样有对应的 Rust
 * 结构，而是走通用的 `read_data` / `write_data` 直接读写 `snippets.json`。
 *
 * 定义放在这里而不是 `features/snippets` 里，是为了让 `lib/` 下的模块
 * （全局搜索、命令面板）能引用它，不必反过来依赖某个功能模块——
 * `lib` 依赖 `features` 是倒过来的，以后拆模块会很难受。
 */
export interface Snippet {
  id: string;
  /** 标题，用于快速辨认。 */
  title: string;
  /** 实际会被粘贴出去的正文。 */
  content: string;
  /** 备注，方便以后想起来这条是干什么用的；也参与搜索。 */
  note: string;
  /** 标签，便于分类。 */
  tags: string[];
  /** 是否敏感（账号密码类）：列表里遮罩显示。 */
  sensitive: boolean;
  /** 是否收藏：收藏项排在最前面。 */
  starred: boolean;
  /** 使用次数，用于「常用」排序。 */
  uses: number;
  /**
   * 所属文件夹 id，`null` 表示在顶层。
   *
   * 后加字段：老数据里没有这一项，读出来是 `undefined`，
   * 过滤时会把「没有」和「指向不存在的文件夹」都当成顶层。
   */
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
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
  /**
   * 界面基准字号（像素）。
   *
   * 会被设成 CSS 变量 `--fs-base`，整个界面的字号都由它推导。
   * Rust 侧保存时会夹到 12~18 之间，见 `lib/ui-scale.ts`。
   */
  fontSizePx: number;
  /**
   * 悬浮球的配色方案 id。
   *
   * 存 id 而不是具体颜色：每个配色要**同时**决定底色、标志颜色、描边，
   * 三者必须配套（深色底配白标、浅色底配深标），
   * 让用户自由填颜色很容易配出"标志和底色糊在一起"的组合。
   * 可选值与渲染方式见 `lib/ball-theme.ts`。
   */
  ballTheme: string;
  /**
   * 各页签的缩放百分比（100 = 默认大小）。
   *
   * 键是页签 id（见 `features/registry.ts`）。用一个 map 而不是"每个页签一个字段"：
   * 页签是刻意做成可扩展的，每加一个都改数据模型不合理。
   * 认不出来的键会原样留着——不影响显示，也不会因为卸载了某个页签就丢掉用户的选择。
   *
   * 取值范围由 Rust 侧 `models::ZOOM_MIN` / `ZOOM_MAX` 夹取，
   * 前端也夹一次（见 `lib/zoom.ts`）：设置还没保存、只是先预览的路径
   * 不该因为一个越界值把界面搞坏。
   */
  zoom: Record<string, number>;
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
  /**
   * 记住悬浮球当前的位置（小球窗口在移动后防抖调用）。
   *
   * 存进单独的 `window.json`，**不写设置**：设置是整份覆盖写的，
   * 小球和主面板两个窗口各持一份副本，互相会冲掉
   * （见 Rust 侧 `windows::FILE_WINDOW` 的说明）。
   */
  saveBallPos: (x: number, y: number) => invoke<void>("save_ball_pos", { x, y }),

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
  /**
   * 把一个「每天重复」的闹钟推进到下一次响铃时刻（下一次时刻由调用方算好）。
   *
   * 为什么不用 `timerSave` 写回去：那是"读出来 → 改一改 → 整条覆盖写"，
   * 中间隔着一次 IPC 往返。用户在这两步之间点下「停止」，就会被静默吞掉
   * （界面显示「未开始」，盘上还排着明天响）。判断和写入必须在 Rust 侧
   * 同一把锁里完成，所以单独一条命令 —— 详见 `lib/alarm.ts`。
   *
   * @returns 是否真的推进了。`false` 表示这条闹钟当时不处于可推进的状态
   *          （用户已经停掉/改过/删掉它），调用方不该广播、也不该改本地状态。
   */
  timerAdvanceAlarm: (id: string, nextEndsAt: number) =>
    invoke<boolean>("timer_advance_alarm", { id, nextEndsAt }),

  // ---- 备忘录 ----
  memosList: () => invoke<Memo[]>("memos_list"),
  memoSave: (memo: Memo) => invoke<void>("memo_save", { memo }),
  memoRemove: (id: string) => invoke<void>("memo_remove", { id }),

  // ---- 快捷链接 ----
  linksList: () => invoke<LinkItem[]>("links_list"),
  linkSave: (link: LinkItem) => invoke<void>("link_save", { link }),
  linkRemove: (id: string) => invoke<void>("link_remove", { id }),
  linkLaunch: (id: string) => invoke<void>("link_launch", { id }),
  linkIcon: (path: string) => invoke<IconData | null>("link_icon", { path }),
  /**
   * 判断一批路径各自是什么（拖拽添加链接时用）。
   *
   * 前端拿不到「这是不是目录」——Tauri 的拖放事件只给路径字符串，
   * 所以只能让 Rust 读一次文件系统属性。判不出来时返回 `file`，不会报错。
   */
  classifyPaths: (paths: string[]) => invoke<LinkKind[]>("classify_paths", { paths }),

  // ---- 文件夹（链接 / 文本片段 / 计时器共用）----
  foldersList: () => invoke<Folder[]>("folders_list"),
  folderSave: (folder: Folder) => invoke<void>("folder_save", { folder }),
  /**
   * 删除文件夹。
   *
   * 只会把**子文件夹**挂到被删文件夹的父级；文件夹里的**条目**要由调用方
   * 先改挂过去（见 `lib/folders-ui.tsx` 的 `useFolders`）。
   * 原因见 Rust 侧 `commands::folder_remove` 的说明。
   */
  folderRemove: (id: string) => invoke<void>("folder_remove", { id }),

  // ---- 备份 ----
  /** 把全部数据导出成一个备份文件。路径由保存对话框给出。 */
  exportAll: (path: string) => invoke<void>("export_all", { path }),
  /**
   * 从备份文件恢复全部数据。**会覆盖当前数据**，调用前必须先让用户确认。
   *
   * 导入完成后前端要把面板整页重载：各功能模块的状态都是导入前那份，
   * 不重载会显示已经不存在的数据。
   */
  importAll: (path: string) => invoke<void>("import_all", { path }),

  // ---- 设置 ----
  settingsGet: () => invoke<Settings>("settings_get"),
  /**
   * 只改设置的某几项，其余保持**内存里的最新值**。
   *
   * 用它而不是"读出来 → 改一改 → `settingsSave` 整份写回去"：
   * 设置有三个写者（设置页、各页签的 Ctrl+滚轮缩放、另一个窗口），
   * 而"读-改-写"中间隔着一次 IPC，两个写者交错时后写的会把先写的整份盖掉 ——
   * 表现是「我改的字号自己变回去了」，而且只在几百毫秒内连改两项时出现。
   * 合并必须在 Rust 侧同一把锁里做（见 `commands::settings_patch`）。
   *
   * @returns 合并并夹取之后的完整设置，直接拿去更新界面
   */
  settingsPatch: (changes: Partial<Settings>) =>
    invoke<Settings>("settings_patch", { changes }),
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

  /**
   * 取最近一次提醒的内容。
   *
   * 提醒窗口挂载时主动拉一次 —— 只靠 `alert:content` 事件推送的话，
   * 窗口复用 + 监听器还没就绪时会丢内容，而调度线程已经把 `fired_for`
   * 落盘了，那条提醒就永远不补弹。
   */
  alertCurrent: () =>
    invoke<{ title: string; body: string } | null>("alert_current"),

  /**
   * 把某条片段的使用次数 +1（「常用优先」排序靠它）。
   *
   * 由 Rust 在写锁里做「读 → 改 → 写」：命令面板浮在片段页上面时两个组件
   * 会同时挂载，前端各开一份 `usePersistentState` 就有两个写者了。
   */
  snippetBumpUse: (id: string) => invoke<void>("snippet_bump_use", { id }),
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

/**
 * 广播「设置变了」。
 *
 * 为什么需要跨窗口事件：小球、主面板、提醒弹窗是**三个独立的窗口**，
 * 各自有自己的 DOM。在主面板里改 CSS 变量，小球那个窗口完全不知道——
 * 实测就是这个原因导致"换了配色但球不变色"。
 *
 * 所以设置改动后广播一次，关心外观的窗口各自重新套用。
 */
export async function emitSettingsChanged(settings: Settings): Promise<void> {
  await emit("settings-changed", settings);
}

/** 订阅设置变更。返回取消订阅函数，组件卸载时必须调用。 */
export function onSettingsChanged(cb: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>("settings-changed", (e) => cb(e.payload));
}

/**
 * 广播「计时器变了」。
 *
 * # 为什么计时器平时不需要广播，这里却要
 *
 * 计时器的数据只有主面板会改，所以 `timer_save` 一直不广播（和链接一样）。
 * 但**闹钟的「每天重复」是例外**：下一次响铃时刻由后台逻辑算好写回来
 * （见 `lib/alarm.ts`），主面板那份内存状态不会自己知道，于是会一直显示
 * 「已完成」；更糟的是用户此时点「移动到文件夹」，写回去的是那份**过期快照**
 * （`fired: true, endsAt: null`），把推进结果整份冲掉 —— 这个闹钟从此
 * 永久不响，重启也不恢复。
 *
 * 这与备忘录那边是同一个坑（见 Rust 侧 `commands::notify_memos_changed`），
 * 所以解法也一样：推进成功后广播一次，各窗口重新拉数据。
 * 闭环是收敛的 —— 重新拉回来时 `fired` 已经是 false，没有可推进的，
 * 也就不会再保存、不会再广播。
 *
 * 用 `emit`（发给所有窗口）而不是 `emitTo`：主面板和小球窗口都可能开着。
 */
export async function emitTimersChanged(): Promise<void> {
  await emit("state-changed", { what: ["timers"] });
}

/** 生成一个足够唯一的 id。本地单机场景时间戳 + 随机数已足够。 */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
