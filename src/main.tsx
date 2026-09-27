/**
 * 前端入口。
 *
 * 三个窗口（小球 / 主面板 / 提醒弹窗）共用同一个 HTML 与同一份 JS 包，
 * 靠 URL hash 区分要渲染哪一个。这样只产出一个前端包，体积最小。
 */
import React from "react";
import ReactDOM from "react-dom/client";

import { api } from "./lib/api";
import { applyFontSize } from "./lib/ui-scale";
import { AlertWindow } from "./windows/AlertWindow";
import { BallWindow } from "./windows/BallWindow";
import { PanelWindow } from "./windows/PanelWindow";
import "./styles.css";

/** 根据当前 hash 选择要渲染的窗口。 */
function resolveWindow(): React.ComponentType {
  const hash = window.location.hash;
  if (hash.startsWith("#/ball")) return BallWindow;
  if (hash.startsWith("#/alert")) return AlertWindow;
  return PanelWindow;
}

const Root = resolveWindow();

/**
 * 尽早套用用户设的字号。
 *
 * 必须在**渲染之前**发起：设置是异步读的，晚一步就会先按默认字号画一帧
 * 再跳变，看起来像闪了一下。
 *
 * 读失败也不管——用 CSS 里的默认值即可，字号不该成为打不开界面的原因。
 */
void api
  .settingsGet()
  .then((s) => applyFontSize(s.fontSizePx))
  .catch(() => {
    /* 用默认字号 */
  });

/**
 * 全局关掉 WebView2 自带的右键菜单。
 *
 * 桌面软件里弹出「刷新 / 另存为 / 打印 / 检查」这套浏览器菜单非常出戏，
 * 而且它会盖住我们自己要弹的原生菜单。
 *
 * 必须在 document 上用**捕获阶段**监听：只在 React 组件上写 `onContextMenu`
 * 并 `preventDefault()` 实测拦不住 WebView2 的默认菜单，浏览器菜单照样弹出来。
 * 捕获阶段能确保在默认行为发生之前就把它掐掉。
 */
document.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
  },
  { capture: true },
);

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点，index.html 可能被改坏了");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
