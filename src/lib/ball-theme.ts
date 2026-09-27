/**
 * 悬浮球的配色方案。
 *
 * # 为什么存 id 而不是让用户填颜色
 *
 * 一个球需要**同时**决定三件事：底色、标志颜色、描边。
 * 三者必须配套——深色底要配白标、浅色底要配深标，
 * 描边也要跟着底色走（浅色球放在白色桌面上没有描边就看不见）。
 * 让用户自由填颜色，很容易配出"标志和底色糊在一起"或者"球在桌面上消失"。
 *
 * 所以给几套试好的方案，用户挑一套即可。
 *
 * # 标志怎么染色
 *
 * 标志资源只有一份**白色** PNG。要把它变成蓝色，用的是 CSS `mask`：
 * 把 PNG 当作遮罩（只取它的 alpha 通道），再给元素填任意背景色。
 * 这样一份资源就能配所有配色，不用为每种颜色单独存图。
 * mask 图片本身写在 `styles.css` 里，由 Vite 处理路径。
 *
 * ⚠️ 新增配色时，`src-tauri/src/models.rs` 的 `BALL_THEMES` 白名单也要加，
 * 否则保存时会被当成无效值退回默认——那边有测试保证两边一致。
 */

export interface BallTheme {
  id: string;
  label: string;
  /** 球体背景。可以是纯色，也可以是渐变。 */
  background: string;
  /** 标志的颜色。 */
  mark: string;
  /** 描边颜色。浅色球放在浅色桌面上全靠它分得开。 */
  border: string;
  /** 投影。 */
  shadow: string;
}

export const BALL_THEMES: BallTheme[] = [
  {
    id: "white",
    label: "白底蓝标",
    background: "#ffffff",
    mark: "#1d4ed8",
    border: "rgba(0, 0, 0, 0.14)",
    // 白球在白色桌面上几乎融为一体，所以投影要比深色球重一些
    shadow: "0 2px 10px rgba(0, 0, 0, 0.26), 0 1px 3px rgba(0, 0, 0, 0.14)",
  },
  {
    id: "soft-blue",
    label: "淡蓝底白标",
    background: "linear-gradient(135deg, #7fb2ff 0%, #4a86e8 100%)",
    mark: "#ffffff",
    border: "rgba(255, 255, 255, 0.55)",
    shadow: "0 2px 10px rgba(0, 0, 0, 0.24)",
  },
  {
    id: "graphite",
    label: "石墨灰底白标",
    background: "linear-gradient(135deg, #5a6070 0%, #2e323c 100%)",
    mark: "#ffffff",
    border: "rgba(255, 255, 255, 0.32)",
    shadow: "0 2px 10px rgba(0, 0, 0, 0.32)",
  },
  {
    id: "dark",
    label: "深蓝近黑底白标",
    background: "linear-gradient(135deg, #3a4356 0%, #1b2130 100%)",
    mark: "#ffffff",
    border: "rgba(255, 255, 255, 0.28)",
    shadow: "0 2px 10px rgba(0, 0, 0, 0.34)",
  },
  {
    id: "purple",
    label: "紫底白标",
    background: "linear-gradient(135deg, #9b7bff 0%, #5b3fc4 100%)",
    mark: "#ffffff",
    border: "rgba(255, 255, 255, 0.5)",
    shadow: "0 2px 10px rgba(0, 0, 0, 0.26)",
  },
  {
    id: "teal",
    label: "青绿底白标",
    background: "linear-gradient(135deg, #4fd1c5 0%, #0e9384 100%)",
    mark: "#ffffff",
    border: "rgba(255, 255, 255, 0.5)",
    shadow: "0 2px 10px rgba(0, 0, 0, 0.26)",
  },
  {
    id: "classic-blue",
    label: "经典蓝（最早那版）",
    background: "linear-gradient(135deg, #6aa8ff 0%, #2b4fa0 100%)",
    mark: "#ffffff",
    border: "rgba(255, 255, 255, 0.55)",
    shadow: "0 2px 10px rgba(0, 0, 0, 0.28)",
  },
];

/** 找不到指定 id 时用的方案。 */
export const DEFAULT_BALL_THEME_ID = "white";

/** 按 id 取配色；认不出来就退回默认，不会返回 undefined。 */
export function findBallTheme(id: string): BallTheme {
  return BALL_THEMES.find((t) => t.id === id) ?? BALL_THEMES[0];
}

/**
 * 把配色应用到界面。
 *
 * 写成 CSS 变量而不是直接改元素样式：
 * 球体本身在 `styles.css` 里，变量让"长什么样"和"用哪套配色"分开。
 */
export function applyBallTheme(id: string): void {
  const theme = findBallTheme(id);
  const style = document.documentElement.style;
  style.setProperty("--ball-bg", theme.background);
  style.setProperty("--ball-mark", theme.mark);
  style.setProperty("--ball-border", theme.border);
  style.setProperty("--ball-shadow", theme.shadow);
}
