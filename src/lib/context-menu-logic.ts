/**
 * 右键菜单的纯逻辑：定位、键盘选择、可用项过滤。
 *
 * # 为什么不复用 `lib/menu-position.ts` 的 `placeMenu`
 *
 * 两者的**锚点形状根本不同**，共用会写出一个到处是 `if` 的函数：
 *
 * - `placeMenu` 贴的是一个**按钮矩形**，规则是"右对齐到按钮右边缘"——
 *   链接页的「⋯」在格子右上角，右对齐才显得是"从那个按钮长出来的"。
 * - 右键菜单的锚点是一个**点**（鼠标位置），规则是"以点击处为左上角、
 *   右边放不下就朝左翻、下边放不下就朝上翻"。
 *
 * 而且右键菜单是**光标锚定**的：面板 420×640，鼠标可能停在最右下角，
 * 这时必须让菜单完全翻到光标的左上侧，而不是像 `placeMenu` 那样
 * 右对齐到某个矩形再夹回来 —— 夹回来的结果会让菜单**盖住光标**，
 * 用户看不出菜单是从哪儿弹出来的。
 *
 * 所以这里单独一套坐标计算，不碰 `menu-position.ts`（它是链接页的，
 * 而且那个文件不在本任务的改动范围内）。
 *
 * # 为什么单独抽出来
 *
 * "只在窗口边缘才出错"的逻辑是这个项目里最容易静默坏掉的一类：
 * 菜单跑到窗口外，用户看到的现象是「右键什么都没发生」，
 * 而报错、日志、控制台里一个字都没有。抽成纯函数才能用单测钉死。
 * 这里不碰 DOM —— 菜单尺寸由调用方**量好**再传进来。
 */

/** 菜单与光标之间留多少像素。 */
const GAP = 2;
/** 菜单与窗口边缘至少留多少像素。 */
const MARGIN = 6;

export interface BoxSize {
  width: number;
  height: number;
}

/** 光标位置（视口坐标，与 `MouseEvent.clientX/clientY` 同一坐标系）。 */
export interface Point {
  x: number;
  y: number;
}

/** 一个菜单项。`disabled` 的项仍要显示（用户得知道这个功能存在），但不参与键盘选择。 */
export interface MenuItemSpec {
  id: string;
  label: string;
  /** 右侧的小字说明，例如「Ctrl+C」。 */
  hint?: string;
  disabled?: boolean;
  /** 危险动作（删除），渲染成红字。 */
  danger?: boolean;
  /** 分隔线：这一项之前画一条横线。 */
  dividerBefore?: boolean;
}

/**
 * 算出菜单左上角该摆在哪（视口坐标）。
 *
 * 规则：
 * - 默认**以光标为左上角**向右下展开（和系统右键菜单一致：菜单从光标处长出来）。
 * - 右边放不下就翻到光标**左侧**；下边放不下就翻到光标**上方**。
 * - **两边都放不下**（菜单比视口的一半还宽）时才夹到边缘 ——
 *   这时候菜单必然盖住光标，属于无奈之举，但至少不越界。
 * - **绝不返回负坐标** —— 负坐标等于整个菜单看不见。
 *
 * # 为什么"两边都放不下"不能简单地夹到 MARGIN
 *
 * 原来只有"向右"和"翻到左边"两种可能，左边的位置算完直接 `clamp` 到
 * `MARGIN`。菜单比视口的一半还宽时，`point.x - GAP - width` 是负数，
 * clamp 之后菜单从 `MARGIN` 开始铺开 —— **一定会盖住光标**，
 * 而"盖住光标"正是这个函数要避免的事（用户看不出菜单是从哪儿弹出来的）。
 *
 * 现在改成**两边都试一次，挑盖住光标更少的那一侧**：
 * 与其一律贴左边，不如看光标偏哪边 —— 光标在右半边时贴左边更合理，
 * 在左半边时贴右边更合理。判据是"菜单离光标有多远"，取更远的那个。
 *
 * @param point    右键点击的位置
 * @param menu     菜单量完之后的尺寸。必须**量完**再传：
 *                 菜单高度取决于里面有几行、有没有分隔线，写死会翻错方向
 * @param viewport 窗口尺寸（面板是 420×640）
 */
export function placeContextMenu(
  point: Point,
  menu: BoxSize,
  viewport: BoxSize,
): { left: number; top: number } {
  // 窗口比菜单还宽/还高时 `viewport - menu - MARGIN` 会是负数，
  // `max(MARGIN, ...)` 是给这种极端情况兜底的（否则 clamp 的下界高于上界）
  const maxLeft = Math.max(MARGIN, viewport.width - menu.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - menu.height - MARGIN);

  /** 某个起点能不能完整放下（含与边缘的留白）。 */
  const fitsFrom = (start: number, limit: number) => start + menu.width + MARGIN <= limit;

  // ---- 横向：优先"放得下的那一侧" ----
  const rightStart = point.x + GAP;
  const leftStart = point.x - GAP - menu.width;
  let left: number;
  if (fitsFrom(rightStart, viewport.width)) {
    left = rightStart;
  } else if (leftStart >= MARGIN) {
    left = leftStart;
  } else {
    /**
     * 两边都放不下（菜单比视口的一半还宽）。
     *
     * 这时**先看能不能整个放到光标的某一侧**：
     * - `maxLeft > x`：贴最右边也还在光标右侧 → 放右边就不盖住光标；
     * - `MARGIN + width <= x`：贴最左边也在光标左侧 → 放左边就不盖住光标。
     *
     * 两个都成立（菜单很窄，被前面两个分支拦住了，理论上到不了这里）或
     * 都不成立（菜单宽到无论如何都会盖住光标 —— 数学上无解）时，
     * 才退回"看光标偏哪边"的启发式。
     *
     * ⚠️ 光看"光标偏哪边"是不够的：菜单宽度刚好卡在视口一半附近时，
     * 光标在中线上、而避开其实仍然可行（贴另一边的最外侧），
     * 启发式会挑错边。所以这里必须**先判可行性**，再谈偏好。
     */
    const canGoRight = maxLeft > point.x;
    const canGoLeft = MARGIN + menu.width <= point.x;
    if (canGoRight && !canGoLeft) left = rightStart;
    else if (canGoLeft && !canGoRight) left = leftStart;
    else left = point.x <= viewport.width / 2 ? rightStart : leftStart;
  }
  const clampedLeft = Math.min(Math.max(left, MARGIN), maxLeft);

  // ---- 纵向：同理（放得下就放，放不下先判可行性）----
  const belowStart = point.y + GAP;
  const aboveStart = point.y - GAP - menu.height;
  let top: number;
  if (belowStart + menu.height + MARGIN <= viewport.height) {
    top = belowStart;
  } else if (aboveStart >= MARGIN) {
    top = aboveStart;
  } else {
    const canGoBelow = maxTop > point.y;
    const canGoAbove = MARGIN + menu.height <= point.y;
    if (canGoBelow && !canGoAbove) top = belowStart;
    else if (canGoAbove && !canGoBelow) top = aboveStart;
    // 两边都不行（或都行）时按系统菜单的习惯优先往下
    else top = belowStart;
  }
  const clampedTop = Math.min(Math.max(top, MARGIN), maxTop);

  return { left: clampedLeft, top: clampedTop };
}

/** 键盘选择状态：`-1` 表示还没选中任何一项。 */
export type MenuSelection = number;

/** 空菜单的初始选中态。 */
export const NO_SELECTION: MenuSelection = -1;

/** 一项能不能被选中/执行。 */
export function isSelectable(item: MenuItemSpec): boolean {
  return !item.disabled;
}

/** 从 `from` 出发朝 `step` 方向找下一个可选中的项，两端**循环**。 */
function findFrom(items: MenuItemSpec[], from: number, step: 1 | -1): number {
  const n = items.length;
  if (n === 0) return NO_SELECTION;
  // 从 -1 往下走要落到第一项、往上走要落到最后一项：
  // `((-1 + 1) % n)` 得 0、`((-1 - 1) % n + n) % n` 得 n-2，
  // 后者是错的 —— 所以"还没选中"这个状态单独处理，不套公式。
  if (from === NO_SELECTION) {
    if (step === 1) {
      for (let i = 0; i < n; i += 1) if (isSelectable(items[i])) return i;
      return NO_SELECTION;
    }
    for (let i = n - 1; i >= 0; i -= 1) if (isSelectable(items[i])) return i;
    return NO_SELECTION;
  }
  for (let k = 1; k <= n; k += 1) {
    const i = (((from + step * k) % n) + n) % n;
    if (isSelectable(items[i])) return i;
  }
  // 全被禁用：停在原地，别跳到某个不可用的项上
  return NO_SELECTION;
}

/**
 * 按上/下（或左右）移动选择。
 *
 * 全部项都禁用、或菜单为空时返回 `NO_SELECTION`：菜单不该"选中"一个
 * 按回车没反应的东西。
 */
export function moveSelection(
  items: MenuItemSpec[],
  from: MenuSelection,
  delta: 1 | -1,
): MenuSelection {
  return findFrom(items, from, delta);
}

/**
 * 菜单打开时的默认选中项。
 *
 * 刻意**不默认选中第一项**：右键菜单和"回车确认"是一对，默认选中会让
 * 用户右键之后顺手一个回车就执行了第一个动作 —— 而第一个动作是
 * 「键入到当前光标」，那是一个会往外部窗口打字的**破坏性**动作。
 * 用户想的是"我要复制"，结果打出去一段文字。
 * 所以默认不选中，必须先按方向键或把鼠标移上去。
 */
export function initialSelection(): MenuSelection {
  return NO_SELECTION;
}

/** 把 `onMouseEnter` 拿到的下标收成合法选择（禁用项不移入）。 */
export function hoverSelection(items: MenuItemSpec[], index: number): MenuSelection {
  if (index < 0 || index >= items.length) return NO_SELECTION;
  return isSelectable(items[index]) ? index : NO_SELECTION;
}

/**
 * 回车该执行哪一项。返回 `null` 表示没有可执行项（菜单没选中任何东西）。
 *
 * 用下标而不是返回 item 本身：调用方拿到下标还能同时做"关闭菜单"这类事，
 * 而传对象出去会让"这个对象是不是当前这一份"变成一个新的疑问。
 */
export function confirmSelection<T extends MenuItemSpec>(
  items: T[],
  selection: MenuSelection,
): T | null {
  if (selection < 0 || selection >= items.length) return null;
  const item = items[selection];
  return isSelectable(item) ? item : null;
}

/**
 * 把一个菜单项列表里所有**空的分组**去掉。
 *
 * 为什么需要：同一个菜单组件被四个页签复用，各页签能提供的动作不一样
 * （链接没有「键入到当前光标」、计时器没有「复制正文」）。调用方按能力
 * 拼数组，最容易犯的错是"条件里筛掉了最后一项，却留下了一条分隔线"——
 * 菜单顶上就多出一条悬空的横线，看着像渲染坏了。
 * 这里统一收拾：开头的分隔线去掉、连续的分隔线合并、结尾的不留。
 */
export function tidyItems<T extends MenuItemSpec>(items: T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    // 输出里上一条**画了线**吗？两条线连着画，中间隔着空行，
    // 看着像渲染坏了；而且这时候再补一条也没有任何分组含义。
    const previousHasDivider = out.length > 0 && out[out.length - 1].dividerBefore === true;
    // 第一项永远不画线（菜单顶上多一条悬空横线）
    const keepDivider = out.length > 0 && item.dividerBefore === true && !previousHasDivider;
    // 显式写成 `true` / `false` 而不是沿用 `undefined`：
    // 这个函数的返回值是"已经收拾干净"的列表，调用方（以及测试）
    // 读 `dividerBefore` 时不该还要考虑三态
    out.push({ ...item, dividerBefore: keepDivider });
  }
  return out;
}
