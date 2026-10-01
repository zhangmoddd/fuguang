/**
 * 前端入口。
 *
 * 三个窗口（小球 / 主面板 / 提醒弹窗）共用同一个 HTML 与同一份 JS 包，
 * 靠 URL hash 区分要渲染哪一个。这样只产出一个前端包，体积最小。
 */
import React from "react";
import ReactDOM from "react-dom/client";

/**
 * ⚠️ `styles.css` 必须**第一个** import，顺序不能挪到后面。
 *
 * 打包时 Vite 按模块图的遍历顺序拼 CSS，而 `.btn` / `.iconbtn` / `.field__input`
 * 这些基础类和模块自己的类**特异性一样**（都是 0,1,0）—— 于是"谁在后面谁赢"。
 * 一个元素同时挂 `class="iconbtn links__more"` 时，靠的就是这个顺序。
 *
 * 这个顺序原来在最后，等于**基础样式盖住模块样式**，结果 5 条规则被静默吃掉：
 *   `.links__more` 的 20px 宽 → 变成 24px（悬停按钮占掉格子宽的 26%）
 *   `.tmr__clock` 的 120px 宽 → 变成 376px（闹钟时间框撑满一整行）
 *   `.datepicker__input` 的 padding、`.memo__today` 与 `.tmr__quick` 的
 *   padding / 字号，同样被 `.btn` / `.field__input` 盖掉。
 *
 * 这类 bug 特别阴：写样式的人会以为"我写了怎么没生效"，而查的时候又看不到报错。
 * 基础在前、模块在后是 CSS 的通行约定，也是这里唯一说得通的顺序。
 */
import "./styles.css";

import { api, onStateChanged } from "./lib/api";
import { advanceAlarmsOnce } from "./lib/alarm";
import { applyBallTheme } from "./lib/ball-theme";
import { ErrorBoundary } from "./lib/error-boundary";
import { advanceRepeatsOnce } from "./lib/repeat-advance";
import { applyFontSize } from "./lib/ui-scale";
import { AlertWindow } from "./windows/AlertWindow";
import { BallWindow } from "./windows/BallWindow";
import { PanelWindow } from "./windows/PanelWindow";

/** 根据当前 hash 选择要渲染的窗口。 */
function resolveWindow(): React.ComponentType {
  const hash = window.location.hash;
  if (hash.startsWith("#/ball")) return BallWindow;
  if (hash.startsWith("#/alert")) return AlertWindow;
  return PanelWindow;
}

const Root = resolveWindow();

/**
 * 尽早套用用户的界面偏好（字号、悬浮球配色）。
 *
 * 必须在**渲染之前**发起：设置是异步读的，晚一步就会先按默认样式画一帧
 * 再跳变，看起来像闪了一下。
 *
 * 读失败也不管——用 CSS 里的默认值即可，外观偏好不该成为打不开界面的原因。
 */
void api
  .settingsGet()
  .then((s) => {
    applyFontSize(s.fontSizePx);
    applyBallTheme(s.ballTheme);
  })
  .catch(() => {
    /* 用默认样式 */
  });

/**
 * 后台维护：把「已经弹过、且需要重复」的备忘与闹钟推进到下一次。
 *
 * 必须放在这里 —— 每个窗口都会执行这段入口代码，而悬浮球窗口是常驻的。
 *
 * 原来备忘这件事只在 `features/memo/index.tsx` 的挂载逻辑里做，但主面板
 * **只挂载当前页签**，默认页签是「文本片段」。于是用户不打开备忘页时：
 * Rust 到点弹窗并记下 `firedFor = remindAt`，却没有任何代码把 `remindAt`
 * 推到下一次 —— 幂等判断从此永远成立，**重复提醒永久静默**，重启也不恢复。
 * 闹钟的「每天重复」是同一个形状（Rust 记 `fired`，下一次由前端算），
 * 所以走同一条路。
 *
 * 数据推进是数据层的职责，不该由某个页面有没有被挂载来决定。
 * 详见 `lib/repeat-advance.ts` 与 `lib/alarm.ts`。
 */
void advanceRepeatsOnce();
void advanceAlarmsOnce();
void onStateChanged((what) => {
  if (what.includes("memos")) void advanceRepeatsOnce();
  // 闹钟的「每天重复」同理：Rust 只负责响，下一次响铃时刻由这里算好写回去。
  // 不推进的话 `fired` 会一直是 true，这个闹钟从此再也不响。
  // 详见 `lib/alarm.ts`。
  if (what.includes("timers")) void advanceAlarmsOnce();
}).catch(() => {
  /* 订阅不上只影响这两条后台推进，不该影响界面 */
});

/**
 * 兜底扫描：每分钟再推一次闹钟。
 *
 * # 为什么光有事件驱动不够
 *
 * 推进失败的路径有两条，两条都会让 `fired` 停在 true 而**再也没有事件**：
 *
 * 1. `advanceAlarmsOnce` 的三次退避重试全部写盘失败（磁盘忙、被杀软占用）；
 * 2. 某个窗口手里是过期快照（`fired: true, endsAt: null`），用户点一下
 *    「移动到文件夹」，那份快照被整条写回去，把刚推进好的结果冲掉。
 *
 * 两条的共同后果是：调度线程看到 `fired` 为真就跳过这条（`scheduler.rs`
 * 的 Alarm 分支），于是它**永远不会再产生 `alerts`**，也就永远不会有新的
 * `state-changed` —— 推进再也不会被触发。用户只看到一个「已完成」的每天闹钟，
 * 没有任何理由怀疑它坏了。
 *
 * 一分钟一次足够：这是兜底，不是准点机制，晚几分钟扫到都能救回来。
 * 定时器放在这里（每个窗口都会执行），小球窗口是常驻的；
 * 隐藏窗口的定时器会被系统降频，但兜底不怕慢。
 */
window.setInterval(() => void advanceAlarmsOnce(), 60_000);

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

/**
 * 关掉 WebView2 自带的「Ctrl + 滚轮缩放整个界面」。
 *
 * 桌面软件里没有"网页缩放"这个概念，而且那个缩放**没有菜单可以还原**——
 * 用户不小心按到 Ctrl 滚一下，整个界面就变大或变小且再也回不去，
 * 只能去翻 WebView2 的数据目录，看起来就像软件坏了。
 *
 * 更要紧的是：浮光自己用 Ctrl + 滚轮做页签缩放（见 `lib/zoom.ts`）。
 * 各处实现不同步的话，同一个手势在有的页签缩放内容、在别的页签
 * 缩放整个界面，行为就没法解释了。所以这里全局拦掉，
 * 由需要它的页签自己在容器上接管。
 *
 * 同样必须在**捕获阶段**：默认行为发生在冒泡之前。
 */
document.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { capture: true, passive: false },
);

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点，index.html 可能被改坏了");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
