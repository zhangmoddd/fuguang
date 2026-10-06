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
  /**
   * 闹钟：上一次**真的响**的时刻。没响过是 `null`。
   *
   * 只用来把「已完成」说清楚 —— 卡片上光写"已响过"，用户不知道是刚才响的
   * 还是昨天响的。有它就能显示「已响过 · 昨天 11:30」。
   *
   * 刻意不在前端推算：推算只能给出"最近的某个钟点"，
   * 而软件没开的时候闹钟是不响的，推算出来的时间会是假的。
   */
  lastFiredAt: number | null;
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
// 图片媒体
// ===============================================================

/**
 * 一张图片的引用。**只有元数据，像素不在里面。**
 *
 * 像素落在 `%APPDATA%\浮光\media\`（Rust 侧 `media.rs`），JSON 里只留这个引用。
 * 为什么不把 base64 塞进数据文件：数据文件是**整份覆盖写**的，
 * 而且前端每次改一条片段都可能重写整份 `snippets.json`（见 `lib/store.ts`）——
 * 塞进去会让文件体积按图片大小膨胀几个数量级，还会污染全文搜索的语义。
 *
 * 与 Rust 侧 `models::MediaRef` 一一对应（字段名驼峰）。
 */
export interface MediaRef {
  /**
   * 图片 id，等于**文件内容的 sha256 前 32 位十六进制**。
   *
   * 用内容摘要当 id 而不是随机 id：同一张图导入两次算出的 id 相同，
   * Rust 那边直接复用已有文件，天然去重。
   */
  id: string;
  /** 原始文件名（或剪贴板图片的自动命名），用于显示与「另存为」的默认名。 */
  name: string;
  /** MIME 类型，例如 `image/png`。由**文件头**判定，不看扩展名。 */
  mime: string;
  /**
   * 宽（像素）。**导入时是 0**，要由前端用 canvas 量出来、
   * 通过 {@link api.mediaSetMeta} 回填。
   *
   * 为什么宽高不由 Rust 算：算宽高就得把图片解码一遍，而"不解码"正是
   * Rust 侧能不引图片库（体积代价）的原因 —— 与 `linkicon` 的分工一致。
   */
  width: number;
  /** 高（像素）。见 {@link MediaRef.width}。 */
  height: number;
  /** 文件字节数。 */
  bytes: number;
  /** 导入时刻（Unix 毫秒）。 */
  addedAt: number;
}

/** 媒体库统计，与 Rust 侧 `media::MediaStats` 一一对应。 */
export interface MediaStats {
  /** 图片张数（不含缩略图与元数据文件）。 */
  count: number;
  /** 占用字节数。**含**缩略图与元数据 —— 这是"这个目录占了我多少磁盘"。 */
  bytes: number;
}

/**
 * 备份导入的结果，与 Rust 侧 `backup::ImportReport` 一一对应。
 *
 * 为什么导入要返回东西：「数据里引用到、但备份里没带的图片」在界面上是**裂图**，
 * 而用户刚看到"恢复成功"。不报出来他就只能一张张翻过去找。
 */
export interface ImportReport {
  /** 备份里带回、并写回 `media/` 的图片张数。 */
  mediaWritten: number;
  /** 导入进来的数据引用到、但库里没有的图片 id（空数组 = 全都在）。 */
  missingMedia: string[];
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
  /**
   * 这条备忘里附带的图片。
   *
   * ⚠️ **永远存在**（Rust 侧是 `#[serde(default)]` 的普通字段，老数据读出来是 `[]`）。
   * 写回去时也必须带上：`memo_save` 是整条覆盖写，漏掉这个字段等于把图片删了。
   */
  images: MediaRef[];
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
  /**
   * 这条笔记里附带的图片。
   *
   * 可选（`?`）而不是必填：老数据里**没有这一项**，读出来是 `undefined`，
   * 所以用之前一律 `s.images ?? []`。与 `Memo.images` 的区别在于数据来源 ——
   * 备忘走 Rust 的强类型结构（那边 `#[serde(default)]` 会补齐），
   * 而片段是前端自己拥有的通用 JSON（见这个接口的说明）。
   */
  images?: MediaRef[];
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
  /**
   * 切换主面板显隐。
   *
   * @param label 目标面板；省略表示第一个面板（`panel`）。
   *              悬浮球左键点击、托盘左键点击都是这个语义。
   */
  togglePanel: (label?: string) => invoke<void>("toggle_panel", { label: label ?? null }),
  /**
   * 显示主面板；目标面板不存在时**创建**它。
   *
   * @param label 目标面板；省略表示第一个面板（`panel`）。
   */
  showPanel: (label?: string) => invoke<void>("show_panel", { label: label ?? null }),
  /**
   * 隐藏主面板（窗口实例保留，下次打开更快）。
   *
   * ⚠️ `label` 省略时藏的是**调用方自己那个窗口**（Rust 侧取命令的调用窗口），
   * 不是"第一个面板"。面板标题栏上的 ✕ 就是靠这条语义在 `panel-2` 里也能正确收起。
   */
  hidePanel: (label?: string) => invoke<void>("hide_panel", { label: label ?? null }),
  /**
   * 新建一个主面板窗口，返回它的 label（`panel-2`、`panel-3`……）。
   *
   * 用**最小空闲编号**：关掉 `panel-2` 之后新建的又叫 `panel-2`，
   * 于是它会回到用户上次放它的位置。多面板的入口在托盘菜单和悬浮球右键菜单的
   * 「新建窗口」，前端要自己加按钮也可以调这个。
   */
  newPanel: () => invoke<string>("new_panel"),
  /** 当前存在的全部面板 label（按编号排序，`panel` 在最前）。 */
  listPanels: () => invoke<string[]>("list_panels"),
  /**
   * 关闭一个面板窗口。
   *
   * 第一个面板（`panel`）是常驻的：它只会被隐藏，不会被销毁。
   */
  closePanel: (label: string) => invoke<void>("close_panel", { label }),
  hideBall: () => invoke<void>("hide_ball"),
  showBall: () => invoke<void>("show_ball"),
  quit: () => invoke<void>("quit_app"),
  showBallMenu: () => invoke<void>("show_ball_menu"),
  /**
   * 设置某个窗口是否置顶。
   *
   * @param label 目标窗口；传 `null` 表示**调用方自己那个窗口**。
   *              面板标题栏上的图钉必须传 `null`（或自己那个 label）——
   *              写死 `"panel"` 会让 `panel-2` 上的图钉去改第一个面板的置顶状态。
   */
  setAlwaysOnTop: (label: string | null, value: boolean) =>
    invoke<void>("set_always_on_top", { label, value }),
  /**
   * 记住悬浮球当前的位置（小球窗口在移动后防抖调用）。
   *
   * 存进单独的 `window.json`，**不写设置**：设置是整份覆盖写的，
   * 小球和主面板两个窗口各持一份副本，互相会冲掉
   * （见 Rust 侧 `windows::FILE_WINDOW` 的说明）。
   *
   * 面板的位置不用前端管：Rust 侧监听 `WindowEvent::Moved` 自己记。
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
  /**
   * 读取剪贴板里的**文本**（右键菜单的「粘贴」用它）。
   *
   * # 为什么不用 `navigator.clipboard.readText()`
   *
   * WebView2 里那个 API 要剪贴板读权限，而浮光没开任何剪贴板权限、
   * 也没装剪贴板插件，所以它在浮光里是不可靠的（轻则弹权限提示、重则直接
   * reject），右键「粘贴」就只剩"请用 Ctrl+V"这句降级提示。Rust 侧本来就有
   * 这份能力（模拟粘贴一直在用它读用户的原文做备份），所以走命令。
   *
   * @returns `null` 表示**剪贴板里没有文本**（只有图片、或者空的）——
   *          这是**正常路径**，不是错误：调用方应当"这次不粘贴，
   *          退回让用户自己 Ctrl+V"。剪贴板里是图片时也返回 `null`，
   *          图片走 {@link api.mediaImportClipboard}。
   */
  readClipboardText: () => invoke<string | null>("read_clipboard_text"),

  // ---- 图片媒体 ----
  //
  // 像素单独落盘在 `%APPDATA%\浮光\media\`，JSON 里只有 `MediaRef` 引用
  // （理由见 `MediaRef` 的说明）。这些命令就是图片的唯一入口。
  /**
   * 从磁盘上的一个文件导入图片（「选择文件」/ 拖放）。
   *
   * 扩展名与文件头都必须是图片；按内容 sha256 去重 —— 同一张图导入两次
   * 只会留一份，第二次直接返回已有引用（`addedAt` 不变）。
   */
  mediaImportPath: (path: string) => invoke<MediaRef>("media_import_path", { path }),
  /**
   * 从剪贴板导入图片（Ctrl+V 粘图 / 「从剪贴板添加」）。
   *
   * 返回 `null` 表示**剪贴板里没有图片**（用户复制的是文字）——
   * 这是正常情况，调用方应当退回"粘贴文字"，**不要报错**。
   *
   * 反过来，`reject` 表示**有图片但读不出来**（剪贴板被其他程序占用、
   * 格式认不出、超过 20 MB 上限）。这种情况下**必须把错误文案显示给用户**：
   * 吞掉它就变成"复制了截图却什么都没发生"。
   */
  mediaImportClipboard: () => invoke<MediaRef | null>("media_import_clipboard"),
  /**
   * 回填宽高与缩略图。
   *
   * @param thumbPngBase64 canvas 的 `toDataURL("image/png")` **去掉**
   *        `data:image/png;base64,` 前缀之后的部分。必须是 PNG，否则会被拒绝
   *        （存进去一个非 PNG 会让列表里的缩略图全部裂掉，而且很难查）。
   *
   * 导入时 `width`/`height` 是 0，靠这一步补齐；列表里显示缩略图也靠它。
   * 缩略图不是必须的：没有缩略图时 {@link api.mediaRead} 会退回原图。
   */
  mediaSetMeta: (id: string, width: number, height: number, thumbPngBase64: string) =>
    invoke<MediaRef>("media_set_meta", { id, width, height, thumbPngBase64 }),
  /**
   * 读一张图片，返回可直接放进 `<img src>` 的 data URL。
   *
   * @param full `false`（默认）优先读缩略图，没有就退回原图 —— 列表里一律用它。
   *        `true` 读原图；⚠️ 原图会被 base64 一遍，几十兆的图会让 IPC 很慢。
   *
   * MIME 由真实格式决定（可能是 `image/jpeg` 等），不要假设一定是 PNG。
   */
  mediaRead: (id: string, full = false) => invoke<string>("media_read", { id, full }),
  /** 删除一张图片（原图 + 缩略图 + 元数据）。幂等，重复调用不报错。 */
  mediaDelete: (id: string) => invoke<void>("media_delete", { id }),
  /**
   * 把一张图片另存到用户选定的位置（原图字节，不重新编码）。
   *
   * 路径由前端的保存对话框给出（`@tauri-apps/plugin-dialog` 的 `save`）。
   */
  mediaExport: (id: string, destPath: string) => invoke<void>("media_export", { id, destPath }),
  /**
   * 把一张图片写进剪贴板（`CF_DIB`），供「复制图片」用。
   *
   * ⚠️ 会**清空用户原来的剪贴板**，而且图片不做还原（文本路径才有还原）。
   * 所以调用方应当把"剪贴板被替换了"告诉用户。
   */
  mediaCopyImage: (id: string) => invoke<void>("media_copy_image", { id }),
  /**
   * 把一张图片「键入到当前光标」：放进剪贴板 → 切回上一次的外部窗口 → 模拟 Ctrl+V。
   *
   * 返回值与文本路径的 {@link api.pasteText} 是同一个 `PasteOutcome`，
   * 所以提示方式可以完全一致（`ok` 为假时 `message` 里已经写好了"可手动 Ctrl+V"）。
   */
  mediaPasteToTarget: (id: string) => invoke<PasteOutcome>("media_paste_to_target", { id }),
  /**
   * 媒体库统计（张数与占用字节数），设置页显示"图片占了多少空间"用。
   *
   * 媒体目录不存在（从没存过图）时返回全 0，不报错。
   */
  mediaStats: () => invoke<MediaStats>("media_stats"),

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
  /**
   * 把全部数据导出成一个备份文件（含**被引用到的图片**，以 base64 内嵌）。路径由保存对话框给出。
   *
   * 图片为什么不放在 JSON 里却在备份里内嵌：数据文件是每次击键都可能整份重写的，
   * 而备份是"换台电脑也要能用"的一次性产物 —— 不带上图片的话，
   * 恢复之后数据里的引用全指向不存在的文件，界面上一片裂图。
   */
  exportAll: (path: string) => invoke<void>("export_all", { path }),
  /**
   * 从备份文件恢复全部数据。**会覆盖当前数据**，调用前必须先让用户确认。
   *
   * 导入完成后前端要把面板整页重载：各功能模块的状态都是导入前那份，
   * 不重载会显示已经不存在的数据。
   *
   * @returns 导入报告。`missingMedia` 非空时要**显示给用户** ——
   *          那些图片在界面上是裂图，而用户刚看到"恢复成功"。
   */
  importAll: (path: string) => invoke<ImportReport>("import_all", { path }),

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
  alertCurrent: () => invoke<AlertContent | null>("alert_current"),

  /**
   * 把**当前这条提醒**延后几分钟再弹一次（手机闹钟的「稍后提醒」）。
   *
   * 它改的是"提醒"，不是"数据"：闹钟的钟点、备忘的提醒时刻一个都不动。
   * 用户点「稍后」说的是"这条再等我五分钟"，不是"把我的闹钟改成五分钟后"。
   */
  snoozeAlert: (minutes: number) => invoke<void>("snooze_alert", { minutes }),

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

/**
 * 一条提醒的内容。
 *
 * `isAlarm` 决定提醒窗**响多久**：闹钟按手机的逻辑"响到你处理为止"
 * （10 分钟自动静音），倒计时 / 番茄钟 / 备忘录只是一声提醒。
 */
export interface AlertContent {
  title: string;
  body: string;
  isAlarm: boolean;
}

/** 后端状态发生变化（计时器到点、提醒触发等），前端应重新拉取数据。 */
export function onStateChanged(
  cb: (what: string[]) => void,
): Promise<UnlistenFn> {
  return listen<{ what: string[] }>("state-changed", (e) => cb(e.payload.what));
}

/** 提醒弹窗收到新内容。 */
export function onAlertContent(
  cb: (payload: AlertContent) => void,
): Promise<UnlistenFn> {
  return listen<AlertContent>("alert:content", (e) => cb(e.payload));
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
