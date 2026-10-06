/**
 * 「每个面板窗口停在哪」的持久化。
 *
 * # 它解决什么
 *
 * 多窗口之后每个窗口是一份**独立的**界面状态：窗口 A 停在「临时」文件夹、
 * 窗口 B 停在「账号密码」，用户希望重启后各自回到原处。
 * 而页签和文件夹层级原来都是组件 state，切页签/重启就丢。
 *
 * # 为什么用 `localStorage`，键为什么按 label 分
 *
 * 三个窗口（小球 / 主面板 / 提醒）共用同一个前端包、同一个 origin，
 * `localStorage` 是按 origin 隔离的 —— 也就是说**所有窗口能看见彼此的键**。
 * 所以键里必须带上自己的 label（`fuguang:panel-state:<label>`），
 * 否则窗口 A 切页签会把窗口 B 的位置也改掉。
 *
 * # ⚠️ label 会被复用 —— 新窗口会**继承**同名旧窗口的页签与文件夹（刻意的）
 *
 * `new_panel` 取的是**最小空闲编号**（见 `api.ts` 的 `newPanel`）：关掉 `panel-2`
 * 之后再点「新建窗口」，新窗口又叫 `panel-2`。而它的位置是按 label 存在
 * `localStorage` 里的，于是**新窗口会回到上一个 `panel-2` 待过的地方**。
 *
 * 队长裁决：**保持现状，不"修"**。理由有两条：
 *
 * 1. 用户要的是"两个窗口并排、各自停在不同文件夹"。窗口是按**槽位**记的 ——
 *    关掉 2 号槽再开，回到 2 号槽上次待的地方，正是"记住每个窗口停在哪"这个
 *    功能本身该有的样子。清掉反而会让"新建窗口"每次都回到默认页签。
 * 2. 窗口**位置**也是刻意复用的（Rust 侧 `windows.rs` 为了拿回窗口位置特意
 *    保留了记录）。位置复用、页签不复用会自相矛盾：新窗口出现在老位置、
 *    内容却是另一个页签。
 *
 * 所以这里**没有**在关窗口时清键。真要"新建窗口 = 干净的面板"，就得在
 * `close_panel` 的成功路径里删掉 `fuguang:panel-state:<label>`，那是一个
 * 明确的产品决定，不是 bug 修复。
 *
 * 不用数据文件：这是纯界面状态（"上次看的是哪一页"），不是用户数据。
 * 混进 `settings.json` 会让它变成"整份覆盖写"的又一个写者（见 `store.ts` 的说明）。
 *
 * # 坏值怎么办
 *
 * 这个键是用户能手改的（`localStorage` 在开发者工具里一眼可见）。
 * 读到坏 JSON 时**当成"没记过"**，绝不抛异常 —— 一段坏值不该让面板打不开。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 键前缀。后面接窗口 label。 */
export const PANEL_STATE_PREFIX = "fuguang:panel-state:";

/**
 * 取不到窗口 label 时用的兜底值。
 *
 * 它是 Rust 侧给**第一个**主面板窗口用的 label（见 `src-tauri/src/windows.rs`），
 * 也就是老的单窗口行为。脱离 Tauri 单独跑前端时也会走到这里。
 */
export const FALLBACK_PANEL_LABEL = "panel";

/** 一个面板窗口记住的东西。 */
export interface PanelState {
  /** 上次停在哪个页签（`FeatureModule.id`）。 */
  featureId?: string;
  /**
   * 每个页签各自停在哪一层文件夹。
   *
   * 值是文件夹 id，`null` 表示顶层。**必须显式存 `null`**：
   * 用户从文件夹里退回顶层之后，如果这里不写 `null`，重启还会钻进那个文件夹。
   */
  folders?: Record<string, string | null>;
}

/** 只需要这两个方法 —— 传 `localStorage`，测试里传一个假的。 */
export interface StateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 真实的存储；取不到（脱离浏览器环境）就返回 `null`。 */
function defaultStorage(): StateStorage | null {
  try {
    return window.localStorage;
  } catch {
    // 隐私模式下访问 localStorage 可能直接抛异常
    return null;
  }
}

/**
 * 本窗口的 label。
 *
 * 多窗口之后每个面板的 label 都不同（见 `src-tauri/src/windows.rs`），
 * 所以它足够当"我是谁"用：既用来分持久化的键，也用来当跨窗口广播的发送者身份。
 *
 * 取不到（理论上不会；例如脱离 Tauri 单独跑前端）就退回
 * {@link FALLBACK_PANEL_LABEL}，等于老的单窗口行为。
 */
export function currentPanelLabel(): string {
  try {
    return getCurrentWindow().label || FALLBACK_PANEL_LABEL;
  } catch {
    return FALLBACK_PANEL_LABEL;
  }
}

/** 某个窗口的持久化键。 */
export function panelStateKey(label: string): string {
  return `${PANEL_STATE_PREFIX}${label}`;
}

/**
 * 读一个窗口记住的状态。
 *
 * 任何异常情况（没有键、坏 JSON、形状不对、某个字段类型不对）都退化成
 * "这一项没记过"，而不是抛出去 —— 界面状态读不出来只是回到默认值，
 * 而抛异常会让整个面板白屏。
 */
export function readPanelState(
  label: string,
  storage: StateStorage | null = defaultStorage(),
): PanelState {
  if (!storage) return {};

  let raw: string | null;
  try {
    raw = storage.getItem(panelStateKey(label));
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 被手改坏了：当成没记过
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const value = parsed as { featureId?: unknown; folders?: unknown };
  const state: PanelState = {};

  if (typeof value.featureId === "string" && value.featureId !== "") {
    state.featureId = value.featureId;
  }

  if (value.folders && typeof value.folders === "object" && !Array.isArray(value.folders)) {
    const folders: Record<string, string | null> = {};
    for (const [feature, id] of Object.entries(value.folders as Record<string, unknown>)) {
      // 只认 `string` 和 `null`：`0` / `false` / 嵌套对象一律丢掉，
      // 否则它们会被当成文件夹 id 传下去
      if (typeof id === "string" || id === null) folders[feature] = id;
    }
    state.folders = folders;
  }

  return state;
}

/**
 * 改一个窗口记住的状态（读-改-写，只动传进来的那几项）。
 *
 * 存不下（隐私模式 / 配额满）只影响"下次启动记不记得"，不该影响界面 ——
 * 所以这里吞掉异常，不让它冒到 React 的渲染路径上。
 */
export function writePanelState(
  label: string,
  patch: Partial<PanelState>,
  storage: StateStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const next: PanelState = { ...readPanelState(label, storage), ...patch };
    storage.setItem(panelStateKey(label), JSON.stringify(next));
  } catch {
    /* 见上 */
  }
}

/**
 * 某个页签上次停在哪一层文件夹。
 *
 * @returns 文件夹 id；`null` 表示顶层（包括"从来没记过"）。
 */
export function folderOf(state: PanelState, featureId: string): string | null {
  const id = state.folders?.[featureId];
  return typeof id === "string" ? id : null;
}
