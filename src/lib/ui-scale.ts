/**
 * 界面缩放。
 *
 * 目前只有字号一项：用户在设置页选一档，整个界面的字号按比例变。
 *
 * # 为什么用 CSS 变量而不是 `html { font-size }` + rem
 *
 * 现有样式里的字号原本是散落的 px。改成 rem 意味着每个值都要换算，
 * 换算错了就是"某个地方突然变大/变小"，而且很难一眼看出来。
 * 用变量推导的好处是：**默认档就是原样**，改动是可控的。
 *
 * # 为什么只给几档预设，不让用户填数字
 *
 * 主面板宽度固定 420px。字号开太大就会到处换行、按钮挤成一团、
 * 标题栏高度不够。预设的每一档都是实际看过的。
 */

/** 可选的字号档位。数值是 `--fs-base` 的像素值。 */
export const FONT_SIZE_PRESETS = [
  { value: 12, label: "小" },
  { value: 13, label: "中" },
  { value: 15, label: "大" },
  { value: 17, label: "特大" },
] as const;

/** 与 Rust 侧 `models::FONT_SIZE_MIN` / `FONT_SIZE_MAX` 保持一致。 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;

/**
 * 把字号应用到整个界面。
 *
 * 写在 `documentElement` 上，所有窗口（小球 / 面板 / 提醒弹窗）都生效。
 */
export function applyFontSize(px: number): void {
  // 前端也夹一次：Rust 侧保存时会夹，但"设置还没保存、先预览一下"的路径
  // 不该因为一个越界值把界面搞坏
  const safe = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(px)));
  document.documentElement.style.setProperty("--fs-base", `${safe}px`);
}
