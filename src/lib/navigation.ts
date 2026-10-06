/**
 * 「定位到某一条」的请求契约。
 *
 * # 它解决什么
 *
 * 命令面板（`Ctrl+K`）搜到一条东西之后，得让**目标页签**知道"用户要的是这一条"。
 * 原来 `onNavigate` 只传了一个 `featureId`：切过去就完事了。
 * 于是搜到一条备忘、按回车，备忘页仍然停在「今天」——那条根本不在列表里，
 * 用户看到的是「点了没反应」（这条在 `command-palette.tsx` 的注释里被写成已知限制）。
 *
 * 光传一个 id 也不够：条目分散在文件夹里（片段 / 链接 / 计时器），
 * 或者分散在日期里（备忘）。所以请求必须带上**位置**：`folderId` / `date`。
 *
 * # 为什么请求存在 `PanelWindow` 的 state 里，而不是 feature 组件里
 *
 * `PanelWindow` **只挂载当前页签**（见 `PanelWindow.tsx` 的 `<Active />`）。
 * 用户按回车那一刻，目标页签的组件还没挂载 —— 请求放在组件里就会随卸载丢掉。
 * 所以请求存在主面板的 state 里，用 context 往下发；页签切过去挂载之后，
 * 才从 context 里把请求取走。**这条是 editor-ui 依赖的语义，不能改。**
 *
 * # 为什么要有 `seq`
 *
 * 用户可能**本来就在那个页签上**（搜到片段、当前页就是片段页），
 * 这时 `setActiveId` 是 no-op、组件不会重挂 —— 光靠"挂载时读一次 context"
 * 就漏掉了这一次定位。同一条被搜两次也一样。
 * 所以每次请求都带一个新的 `seq`，并产生一个**新的对象 identity**，
 * 消费方的 `useEffect(..., [target])` 才会再跑一次。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import type { SearchHit, SearchKind } from "./search";

/**
 * 一次定位请求。
 *
 * ⚠️ 这是 editor-ui（t3/t4）依赖的**对外契约**，加字段只能加可选的，
 * 不能改已有字段的名字和类型。
 */
export interface FocusTarget {
  /** 目标页签 id：`"snippets"` | `"memo"` | `"timer"` | `"links"`。 */
  featureId: string;
  /** 条目 id。 */
  id: string;
  /** 所属文件夹 id（片段 / 链接 / 计时器），`null` 表示顶层。 */
  folderId?: string | null;
  /** 备忘用的日期，`YYYY-MM-DD`。 */
  date?: string;
  /**
   * 请求序号：**只增不减**。
   *
   * 它的作用有两个，都不是"去重"：
   * 1. 让每次请求都是**新的对象 identity**（`{...input, seq}`），消费方的
   *    `useEffect(..., [target])` 才会在"用户本来就在这个页签上、组件不会重挂"
   *    的情况下再跑一次；
   * 2. 给迟到的 `done()` 一个判别依据：见 {@link FocusBus.clear} —— 序号对不上
   *    就不清，否则一个迟到的 `done()` 会把**新**请求误清掉。
   *
   * 由 {@link useFocusBus} 统一分配，调用方不要自己编。
   */
  seq: number;
  /**
   * 是否**打开**这一条（而不是仅仅选中它）。
   *
   * 命令面板的 `Ctrl+Enter`（「打开它」）与 `Enter`（「定位到它」）走同一条通道，
   * 靠这个字段区分。**后加的可选字段**：消费方不认它时就退化成"只定位"，
   * 不会出错。它必须由 feature 自己实现 —— 打开编辑器是各功能自己的事，
   * `lib` 层碰不到那些 state。
   */
  open?: boolean;
}

/** 派发一次请求时提供的部分（`seq` 由 {@link useFocusBus} 补上）。 */
export type FocusRequestInput = Omit<FocusTarget, "seq">;

/** 从 context 取到的请求 + 消费掉它的方法。 */
export interface PendingFocus {
  /** 属于本页签的待处理请求；没有就是 `null`。 */
  target: FocusTarget | null;
  /**
   * 消费掉这次请求。
   *
   * **必须调用**：不调用的话，本次请求会在组件每次重渲染时继续返回，
   * 消费方的 effect 会被反复触发（例如反复把编辑器打开）。
   * 调用之后 `target` 立刻变回 `null`，消费方会以 `target === null` 再跑一次 effect，
   * 所以消费方的 effect 必须能处理 `null`。
   */
  done: () => void;
}

/** 主面板持有的定位总线。 */
export interface FocusBus {
  /** 当前待处理的请求；`null` 表示没有。 */
  target: FocusTarget | null;
  /** 派发一次请求。 */
  request: (input: FocusRequestInput) => void;
  /** 消费掉某个序号的请求（序号对不上就不动，避免把新请求误清）。 */
  clear: (seq: number) => void;
}

/**
 * 定位总线 context。
 *
 * 默认值是 `null`（没有主面板包着）—— 各功能页在单测 / 故事书里单独渲染时
 * 不该因为拿不到 context 就崩，`usePendingFocus` 会退化成"永远没有请求"。
 */
export const FocusContext = createContext<FocusBus | null>(null);

// ===============================================================
// 纯逻辑（可单测，见 navigation.test.ts）
// ===============================================================

/** 下一个请求序号。单调递增 —— 只有变大，消费方的 `seq > lastSeq` 判定才成立。 */
export function nextFocusSeq(prev: number): number {
  return prev + 1;
}

/**
 * 造一次定位请求。
 *
 * 抽成纯函数有两个原因：
 *
 * 1. `useFocusBus` 依赖 `useState`，在 node 环境下测不了（这个项目的 vitest 跑在
 *    `environment: "node"`，没有 jsdom）。而「每次请求都必须是**新对象**」这条是
 *    E1/E2 依赖的语义 —— 用户本来就在那个页签上时组件不会重挂，
 *    只有 identity 变化才能让消费方的 `useEffect(..., [target])` 再跑一次。
 *    抽出来才钉得住（见 `navigation.test.ts` 的「同一条连续请求两次」）。
 * 2. `{ ...input, seq }` 这一行写在 hook 里，读代码的人不会意识到它承担着契约 ——
 *    很容易被"优化"成 `Object.assign(input, { seq })` 之类的写法，
 *    那会让两次请求变成同一个引用，同一条搜第二次就再也不触发了。
 */
export function makeFocusTarget(input: FocusRequestInput, seq: number): FocusTarget {
  return { ...input, seq };
}

/**
 * 这条请求该不该交给 `featureId` 这个页签。
 *
 * 两个条件缺一不可：
 * 1. **类型对得上**：备忘的请求不能交给片段页；
 * 2. **是新的**（`seq > lastSeq`）：同一条被搜第二次也要能再触发一次。
 *
 * 抽成纯函数是因为这段判断错了不会报错，只会表现成"有时候点了没反应"，
 * 而那是最难排查的一类 bug。
 */
export function shouldDeliverFocus(
  target: FocusTarget | null,
  featureId: string,
  lastSeq: number,
): boolean {
  if (!target) return false;
  if (target.featureId !== featureId) return false;
  return target.seq > lastSeq;
}

/**
 * 搜索结果里的类型 → 页签 id（`FeatureModule.id`，见 `features/registry.ts`）。
 *
 * **必须是显式表，不能靠"同名"或拼字符串**：片段那类在注册表里叫 `snippets`、
 * 链接那类叫 `links`，两个都是复数。写错的表现是「按回车什么都不发生」——
 * `setActiveId` 收到一个不存在的 id，`PanelWindow` 会退回第一个页签，
 * 用户看到页签动了一下、内容却完全不对。
 */
const FEATURE_OF_KIND: Record<SearchKind, string> = {
  snippet: "snippets",
  link: "links",
  memo: "memo",
  timer: "timer",
};

/** 搜索结果里的类型 → 页签 id。 */
export function featureOfKind(kind: SearchKind): string {
  return FEATURE_OF_KIND[kind];
}

/** 命令面板上的三个按键。 */
export type PaletteKey = "Enter" | "Ctrl+Enter" | "Shift+Enter";

/** 一个按键在某一类结果上会触发什么。 */
export type PaletteActionKind =
  /** 只定位：跳过去并选中那一格，不打开。 */
  | "focus"
  /** 定位 + 打开编辑器。 */
  | "open"
  /** 执行这一条的主动作（片段键入到光标 / 链接启动 / 备忘计时器打开编辑器）。 */
  | "primary"
  /** 复制这一条的内容到剪贴板。 */
  | "copy"
  /** 这一类型上没有这个动作 —— 什么都不做，提示条里也不列出来。 */
  | "none";

/** 三个按键，按显示顺序。 */
const PALETTE_KEYS: PaletteKey[] = ["Enter", "Ctrl+Enter", "Shift+Enter"];

/**
 * 某个键在某一类结果上触发哪个动作。
 *
 * # 为什么单抽一个纯函数
 *
 * `command-palette.tsx` 的 `onKeyDown` 是**没有任何自动测试能碰到**的代码
 * （这个项目的 vitest 跑在 `node` 环境，没有 jsdom / 组件测试）。
 * 而用户上一轮报的原始 bug 就是「按了没反应」—— 正是"接错线、静默什么都不做"。
 * 所以这段决策必须离开组件、能用固定输入钉死。
 *
 * # 三个键的语义（每一条都能一句话说清）
 *
 * - `Enter` = **去那里把它打开**。片段 / 备忘 / 计时器直接打开编辑器；
 *   **链接例外**：对链接来说"打开"就是启动程序，那是它的主动作（落在 `Ctrl+Enter`），
 *   所以回车对链接只是跳过去并选中那一格（`focus`）。
 * - `Ctrl+Enter` = **执行这个条目的主动作**。
 * - `Shift+Enter` = **复制这一条的内容**；没有内容可复制的类型返回 `none`。
 *
 * ⚠️ 新增类型 / 新增按键时改**这一个**函数就够了：提示条（{@link paletteActions}）
 * 和键盘分发都从它推导，不可能对不上。
 */
export function actionForKey(key: PaletteKey, kind: SearchKind): PaletteActionKind {
  if (key === "Ctrl+Enter") return "primary";
  if (key === "Shift+Enter") {
    // 计时器的"内容"是个时间，复制它没有意义；备忘的正文倒是能复制，
    // 但那是"把随手记的东西搬出去"，不是它的主动作 —— 两个都不列。
    return kind === "snippet" || kind === "link" ? "copy" : "none";
  }
  return kind === "link" ? "focus" : "open";
}

/**
 * 把一次按键事件的修饰键归一成 {@link PaletteKey}。
 *
 * 优先级：Ctrl 高于 Shift。两个都按时按 Ctrl 算 —— 总得选一个，
 * 而"执行主动作"比"复制"更接近用户按住 Ctrl 时的意图。
 */
export function paletteKeyOf(modifiers: { ctrl: boolean; shift: boolean }): PaletteKey {
  if (modifiers.ctrl) return "Ctrl+Enter";
  if (modifiers.shift) return "Shift+Enter";
  return "Enter";
}

/** 底部提示条上的一条「按键 → 会做什么」。 */
export interface PaletteAction {
  /**
   * 这个键会触发哪个动作。
   *
   * ⚠️ 键盘分发必须**按这个 id 走**（见 {@link actionForKey}），
   * 不能自己另写一套 `if (e.ctrlKey)`。两边各写一套的话，
   * 迟早出现"提示条上写着能按、按下去却没反应"。
   */
  id: PaletteActionKind;
  /** 键位，例如 `Ctrl+Enter`。 */
  key: PaletteKey;
  /** 这个键会做什么，人话。 */
  label: string;
}

/**
 * 一个动作在某一类结果上的说明文案。
 *
 * 只负责"怎么说"，不负责"能不能做"—— 能不能做由 {@link actionForKey} 决定。
 * 两者分开之后，提示条上不可能出现一个按不动的键。
 */
function labelFor(action: PaletteActionKind, kind: SearchKind): string {
  switch (action) {
    case "focus":
      return "定位到它";
    case "open":
      return "定位并打开";
    case "copy":
      return kind === "link" ? "复制地址" : "复制正文";
    case "primary":
      if (kind === "snippet") return "键入到光标";
      if (kind === "link") return "打开链接";
      return "打开编辑器";
    case "none":
      return "";
  }
}

/**
 * 某一类结果上**真正可用**的动作，按 `Enter` / `Ctrl+Enter` / `Shift+Enter` 的顺序。
 *
 * 列表本身是**从 {@link actionForKey} 推导**出来的（`none` 会被滤掉），
 * 所以"提示条上列出来的"与"按得动的"永远是同一份数据。
 *
 * ⚠️ 这里踩过坑：原来文案是一张写死的表，写的是「切到备忘页」——
 * 那是"实现只做了切页签"时用来兜底的实话。两处各写一遍，迟早对不上。
 */
export function paletteActions(kind: SearchKind): PaletteAction[] {
  const actions: PaletteAction[] = [];
  for (const key of PALETTE_KEYS) {
    const id = actionForKey(key, kind);
    if (id === "none") continue;
    actions.push({ id, key, label: labelFor(id, kind) });
  }
  return actions;
}

/**
 * 把一条搜索结果变成一次定位请求。
 *
 * @param open - `true` 表示"连编辑器一起打开"。打开编辑器是各功能自己的事，
 *   `lib` 层只能把意图传下去；消费方不认这个字段时就退化成"只定位"，不会出错。
 */
export function focusTargetOf(hit: SearchHit, open = false): FocusRequestInput {
  const target: FocusRequestInput = {
    featureId: featureOfKind(hit.kind),
    id: hit.id,
  };
  // 备忘没有文件夹（它的组织维度是日期），给它塞一个 null 只会让消费方
  // 多一层"这个字段对我没意义"的判断
  if (hit.kind !== "memo") target.folderId = hit.folderId ?? null;
  if (hit.date) target.date = hit.date;
  if (open) target.open = true;
  return target;
}

// ===============================================================
// React 绑定
// ===============================================================

/**
 * 主面板用的定位总线。
 *
 * `target` 是 state（要触发重渲染），`seq` 计数放在 ref 里（变了也不用重渲染）。
 * `request` / `clear` 的 identity 必须稳定：它们会进消费方 effect 的依赖，
 * 每次渲染换一个的话 effect 会被无谓地反复触发。
 */
export function useFocusBus(): FocusBus {
  const [target, setTarget] = useState<FocusTarget | null>(null);
  /**
   * `target` 的镜像。
   *
   * `clear` 要判断"序号还对得上吗"，而 `useCallback([])` 里的闭包看不到最新的
   * `target`。放进依赖又会让 `clear` 每次渲染换 identity（见上面的说明）。
   */
  const current = useRef<FocusTarget | null>(null);
  const seq = useRef(0);

  const request = useCallback((input: FocusRequestInput) => {
    seq.current = nextFocusSeq(seq.current);
    const next = makeFocusTarget(input, seq.current);
    current.current = next;
    setTarget(next);
  }, []);

  const clear = useCallback((s: number) => {
    // 序号对不上就不动：否则一个迟到的 `done()` 会把**新**请求误清掉
    if (current.current?.seq !== s) return;
    current.current = null;
    setTarget(null);
  }, []);

  return useMemo(() => ({ target, request, clear }), [target, request, clear]);
}

/**
 * 取走属于本页签的定位请求。
 *
 * 用法（消费方）：
 * ```tsx
 * const { target, done } = usePendingFocus("snippets");
 * useEffect(() => {
 *   if (!target) return;
 *   // 进文件夹 → 选中 → target.open 为真时打开编辑器
 *   done();
 * }, [target, done]);
 * ```
 *
 * # 去重靠的是 identity，不是 seq
 *
 * 这里的 `lastSeq` **恒传 0 是刻意的**（也就是"当前总线里挂着什么就交付什么"）。
 * 真正的"不会被重复交付"来自两件事：
 * 1. `done()` 把请求清掉 → `target` 变 `null` → 消费方的 effect 再跑一次、直接返回；
 * 2. `request()` 每次都造**新对象**（见 {@link makeFocusTarget}），所以同一条被搜
 *    第二次时 `target` 的 identity 变了，`useEffect(..., [target])` 会再触发一次。
 *
 * `seq` 在这条路径上不是去重手段，它管的是"迟到的 `done()` 别误清新请求"
 * （见 `useFocusBus` 的 `clear`）与给请求一个可比较的先后次序。
 * 把 `lastSeq` 换成"记住上次交付的 seq"反而会**弄坏**第 2 条：
 * 那样同一条的第二次请求会因为序号只比上次大 1 而被"看起来已经交付过"挡掉。
 */
export function usePendingFocus(featureId: string): PendingFocus {
  const bus = useContext(FocusContext);

  // 总线实例放 ref：`done` 的 identity 必须稳定（见 `useFocusBus` 的说明），
  // 而依赖 `bus` 会让它随 `target` 一起变。
  const busRef = useRef(bus);
  busRef.current = bus;

  const target = bus?.target ?? null;
  const delivered = shouldDeliverFocus(target, featureId, 0) ? target : null;

  /**
   * 本次交付的序号。渲染期同步写入，`done` 闭包才能读到"该清哪一次"。
   *
   * 不写成 `useCallback` 的依赖：`done` 的 identity 必须稳定，
   * 否则它会进消费方 effect 的依赖、让 effect 反复重跑。
   */
  const seqRef = useRef(0);
  if (delivered) seqRef.current = delivered.seq;

  const done = useCallback(() => {
    busRef.current?.clear(seqRef.current);
  }, []);

  return { target: delivered, done };
}
