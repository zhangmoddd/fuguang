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
 *
 * # `shouldClaim`：让更内层的浮层先认领（RV3 的 F4/F8 相关）
 *
 * 默认这一层**无条件认领** Esc。但编辑器里可能盖着浮层（右键菜单、
 * 大图预览），那一下 Esc 应该是"关掉浮层"，而不是"退出编辑器"。
 *
 * 只写"回调里早退"是不够的 —— 因为下面那行 `stopPropagation()` **已经执行了**：
 *
 * - **右键菜单**的 Esc 是 React 的 `onKeyDown`，React 18 把它委托到
 *   **根容器、冒泡阶段**；document 在根容器**之上**，所以在 document 捕获阶段
 *   一拦，事件根本到不了根容器，菜单的处理器永远不跑。
 *   结果是"Esc 什么都不发生"（菜单没关、编辑器也没关）—— 比原来的 bug 更糟。
 * - **大图预览**是另一个 `useEscapeToClose`（同在 document 捕获），
 *   和这一层是**同一节点上的兄弟**。`stopPropagation()` 拦的是"传播到下一个
 *   节点"，拦不住同节点的兄弟 —— 所以那一层其实照样会跑。
 *
 * 两种浮层的机制不同，但"先判认领、再决定拦不拦"这一条对两者都成立：
 * 不认领时**既不 `stopPropagation` 也不回调**，事件原样往下走，
 * 由内层浮层自己处理（菜单自己会 `stopPropagation`，所以面板仍然收不起来）。
 *
 * # 最严重的后果：备忘页会**丢掉草稿 + 删掉刚导入的图片**
 *
 * 这条值得单独写出来，因为它是"先判再拦"最有力的理由，而且后果不对称：
 *
 * - **笔记页**：Esc 走 `onDone`（自动保存），最坏只是关掉编辑器 —— 改动早就在数据里；
 * - **备忘页**：Esc 走 `onCancel` → `cancelEdit`（`features/memo/index.tsx`），
 *   它会**丢弃草稿**，并**删掉这次编辑期间导入、而数据里还没引用的图片文件**
 *   （那是"取消"该有的语义，本身没错）。
 *
 * 于是"右键菜单开着顺手按个 Esc"在备忘页的真实后果不是"编辑器关了"，
 * 而是**"你刚拖进来的那张图没了"**。菜单开着时编辑器不认领 Esc，
 * `onCancel` 根本不会被调用，草稿和图片都保住。
 */
import { useEffect, useRef } from "react";

export function useEscapeToClose(
  onClose: () => void,
  /**
   * 这一层现在认领 Esc 吗？返回 `false` 表示"让给更内层的浮层"。
   *
   * 省略 = 恒为 `true`（所有既有调用点行为完全不变）。
   */
  shouldClaim?: () => boolean,
): void {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });

  // 和 `latest` 同理：调用方传的多半是内联箭头函数，每次渲染都是新的，
  // 进依赖会反复重挂监听器
  const claim = useRef(shouldClaim);
  useEffect(() => {
    claim.current = shouldClaim;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // ⚠️ 顺序不能反：**先判认领，再拦传播**。
      // 反过来的话（先拦再判）就会把事件截死在这一层，内层浮层再也收不到，
      // 表现为"按 Esc 什么都没发生"。
      if (claim.current && !claim.current()) return;
      // 只关这一层：别让主面板的「收起面板」也一起响应
      e.stopPropagation();
      latest.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}
