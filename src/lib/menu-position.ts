/**
 * 弹出菜单的定位。
 *
 * # 为什么要单独抽出来
 *
 * 「贴着按钮展开」听上去是一句 CSS 就能搞定的事，但这里有一个**很容易漏掉**
 * 的边界：链接页最后一列的格子离面板右边缘只有 10px，最下面一行离底边也不远。
 * 不夹一下，菜单会被切掉一半、或者整个跑到窗口外面去 ——
 * 而用户看到的现象是「点了⋯什么都没发生」，根本不会想到是菜单弹到了屏幕外。
 *
 * 这类"只在边缘才出错"的逻辑正是该单测的东西，所以这里只做坐标计算，
 * 不碰 DOM（尺寸由调用方量好传进来）。
 */

/** 菜单与按钮之间留多少像素。 */
const GAP = 6;
/** 菜单与窗口边缘至少留多少像素。 */
const MARGIN = 8;

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BoxSize {
  width: number;
  height: number;
}

/**
 * 算出菜单左上角该摆在哪（视口坐标）。
 *
 * 规则：
 * - 横向**右对齐到按钮的右边缘**，再夹进窗口；窗口比菜单还窄时至少留 MARGIN。
 * - 纵向**优先往下展开**；下面放不下就翻到按钮上方。
 *   上下都放不下（菜单比窗口还高）时贴住上边 —— 总比负坐标好。
 *
 * @param anchor   触发菜单的那个按钮的矩形
 * @param menu     菜单自己的尺寸（必须**量完**再传：菜单高度取决于里面有几行，
 *                 网址没有「启动参数」那一行，写死高度会翻错方向）
 * @param viewport 窗口尺寸
 */
export function placeMenu(
  anchor: AnchorRect,
  menu: BoxSize,
  viewport: BoxSize,
): { left: number; top: number } {
  // 右对齐，但不许越出右边界。`max` 那一下是给"窗口比菜单还窄"兜底的：
  // 否则 `viewport.width - menu.width - MARGIN` 会是负数，把菜单推到屏幕外左边。
  const maxLeft = Math.max(MARGIN, viewport.width - menu.width - MARGIN);
  const left = Math.min(Math.max(anchor.right - menu.width, MARGIN), maxLeft);

  const below = anchor.bottom + GAP;
  const fitsBelow = below + menu.height <= viewport.height - MARGIN;
  const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - menu.height - GAP);

  return { left, top };
}
