/**
 * 在**捕获阶段**拦下 Esc，交给 `onClose`，不让它冒泡到主面板的「收起面板」。
 *
 * # 为什么必须是捕获阶段
 *
 * 主面板把 Esc 当"收起面板"（见 `windows/PanelWindow.tsx`），而它监听在
 * `window` 的**冒泡**阶段。捕获早于冒泡，所以在 document 上捕获 +
 * `stopPropagation()` 就能稳稳拦住 —— 这是全项目统一的弹层约定
 * （日历、文件夹弹层、「移动到…」、「⋯」菜单、命令面板都是这么写的）。
 *
 * # 少了这一层会怎样
 *
 * 用户填到一半按 Esc 想退出编辑，**整个面板消失、编辑器还开着**
 * （面板是 `hide` 不是销毁，组件不卸载）。下次打开面板，那条没保存的草稿
 * 又原样出现 —— 看着像"软件卡在了一个奇怪的中间状态"。
 * 片段编辑器、备忘编辑器、计时器表单原来都是这样。
 *
 * # 为什么用 ref 存回调
 *
 * 调用方几乎都写成内联箭头函数（`() => setEditing(null)`），每次渲染都是新的。
 * 直接进依赖会每渲染一次就重挂一次 document 监听器 —— 而计时页每 100ms
 * 就重渲染一次（秒表要跳数），等于每秒重挂十次。
 */
import { useEffect, useRef } from "react";

export function useEscapeToClose(onClose: () => void): void {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 只关这一层：别让主面板的「收起面板」也一起响应
      e.stopPropagation();
      latest.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}
