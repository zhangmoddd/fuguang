/**
 * 搜索结果定位到某一条之后的**高亮态**：哪一条该亮、什么时候灭。
 *
 * # 为什么高亮必须有生命周期
 *
 * 从 `Ctrl+K` 搜到一条、回车跳过去之后，用户的第一反应是"跳是跳过来了，
 * 可哪一条是它？"——列表里几十张卡片长得一模一样，不给一个明显的标记
 * 就等于没定位。但反过来，**永久留一个框**同样是 bug：用户点开别的条目、
 * 翻了别的文件夹，那个框还挂在那儿，会让人以为"这条被选中了"，
 * 而实际上它只是"上一次搜到的那条"。
 *
 * 所以规则是：**短暂 + 可清除**。
 * - 到点自动灭（默认 2.6 秒，够看清一眼，又不至于像常驻状态）；
 * - 用户任何一次交互（点、滚、按键）立刻灭 —— 他开始操作了，说明他
 *   已经找到那一条了，这个标记的使命结束。
 *
 * # 为什么把 `seq` 也放进来
 *
 * 同一个条目被连续搜两次时，请求对象是新的（`seq` 变了），
 * 而 `id` 没变。只比 `id` 的话第二次"跳过去"看起来**什么都没发生**
 * （同一个 id 的高亮已经在亮着了，计时器也不会重启，可能刚好在这一刻灭掉）。
 * 带上 `seq` 就能让每次请求都重启一次计时。
 *
 * 这个文件只做状态与判定，不碰 DOM、不碰 React —— 所以能单测。
 */

/**
 * 高亮自动消失的毫秒数。
 *
 * 2600ms 是"看得清"和"不碍事"之间的取值：
 * 比它短（1000ms 级）用户还没把视线从搜索框挪到列表就灭了；
 * 比它长（10s 级）就变成常驻状态，而常驻的高亮会被误解成"选中"。
 */
export const HIGHLIGHT_TTL_MS = 2600;

/** 当前该高亮哪一条。`seq` 用来区分"同一条被搜了两次"。 */
export interface Highlight {
  id: string;
  seq: number;
}

/**
 * 一次定位请求里，页面真正需要的那几个字段。
 *
 * 刻意**不用 `import` 一份完整类型**，只声明"这里真的会读到的字段"：
 * 传完整对象也能用（TS 是结构化类型），但 `lib` 不需要知道定位请求
 * 还有哪些字段 —— 多一个字段就多一处会漂移的耦合。
 */
export interface FocusLike {
  /** 条目 id。 */
  id: string;
  /** 所属文件夹；`null` / `undefined` / 空串都表示顶层。 */
  folderId?: string | null;
  /** 备忘的记录日期，`YYYY-MM-DD`。 */
  date?: string;
  /** 请求序号，每次请求递增。 */
  seq: number;
}

/**
 * 从定位请求算出高亮态。`null` 请求返回 `null`（没有要亮的东西）。
 *
 * 为什么要有这个函数而不是直接 `{ id: target.id, seq: target.seq }`：
 * 它同时承担"请求 → 高亮"这条**唯一转换路径**的职责。以后高亮要带
 * 更多信息（比如"从搜索来的"这个来源标记），只改这一处。
 */
export function highlightFrom(target: FocusLike | null): Highlight | null {
  if (!target) return null;
  return { id: target.id, seq: target.seq };
}

/** 这一条现在该不该亮。 */
export function isHighlighted(highlight: Highlight | null, id: string): boolean {
  return highlight !== null && highlight.id === id;
}

/**
 * 交互发生后是否该清掉高亮。
 *
 * 传进来的 `highlight` 为 `null` 时返回 `false`（本来就没有，不用"清"）。
 * 这个判断单独抽出来的意义在于：调用方要挂 4 个事件监听
 * （pointerdown / wheel / keydown / blur），每一条路径都做一遍
 * `highlight !== null` 的判断，很容易漏一处 —— 漏掉的那一处就是
 * "滚了一下高亮还在"的来源。
 */
export function shouldClearOnInteraction(highlight: Highlight | null): boolean {
  return highlight !== null;
}

/**
 * 定位请求里有没有"该切到哪个文件夹"的信息。
 *
 * `folderId` 为 `null` / `undefined` / 空串都算**没有**：
 * - `null` 是"在顶层"，这是有意义的定位（用户可能正停在某个子文件夹里），
 *   所以调用方拿到的是"要切到顶层"，而不是"不用切"；
 * - `undefined` / 空串是"这次请求没带文件夹信息"（例如备忘没有文件夹），
 *   调用方该保持原状。
 *
 * 这里返回的是"带没带"，切不切、切到哪儿由调用方决定 ——
 * 因为"顶层"和"没带"在类型上都是 falsy，直接 `if (folderId)` 会把
 * "切到顶层"这条路径整个吃掉，而它恰恰是最常见的一条
 * （搜索命中的多半就是顶层的东西）。
 */
export function hasFolderHint(target: FocusLike): boolean {
  return "folderId" in target && target.folderId !== undefined;
}

/**
 * 定位请求里该切到哪个文件夹。返回值有三种含义：
 * - `{ known: false }`：这次请求没带文件夹信息，保持原状；
 * - `{ known: true, folderId: null }`：切到顶层；
 * - `{ known: true, folderId: "xxx" }`：切到那个文件夹。
 */
export function folderToEnter(
  target: FocusLike,
): { known: false } | { known: true; folderId: string | null } {
  if (!hasFolderHint(target)) return { known: false };
  const raw = target.folderId;
  // 空串当"没写"处理：手改过数据、或以后某处拼错了，不该让页面切到一个
  // 永远为空的文件夹里（那种状态下列表是空的，看起来像"东西全没了"）
  if (raw === undefined || raw === "") return { known: true, folderId: null };
  return { known: true, folderId: raw };
}

/**
 * 请求里的日期（备忘用）。空串 / 缺失返回 `null`。
 *
 * 备忘页的 `selected` 只接受 `YYYY-MM-DD`；给它一个空串会让那一天
 * 变成"没有任何笔记"的空页 —— 而用户明明搜到了东西。
 */
export function dateToSelect(target: FocusLike): string | null {
  const date = target.date;
  if (!date) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * 给列表里的条目生成稳定的 DOM id，供"滚动到可见"使用。
 *
 * 为什么不用 `document.querySelector('[data-focus-id="..."]')` 直接查：
 * 条目 id 是 `newId()` 生成的（时间戳 + 随机数），理论上不含特殊字符，
 * 但它**不是** CSS 选择器安全的契约。加一层前缀并在这里统一拼，
 * 以后 id 生成规则变了（比如允许用户自定义 id）只需要改这一处。
 */
export function focusDomId(prefix: string, id: string): string {
  return `${prefix}-${id}`;
}
