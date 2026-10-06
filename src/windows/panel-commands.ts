/**
 * 多窗口命令的前端调用口。
 *
 * # 为什么要有这一层
 *
 * 多窗口那批命令（新建 / 列出 / 显示 / 隐藏面板）由 Rust 侧提供，
 * 而前端有两处要调它们：主面板自己（收起、置顶、新建窗口）和设置页
 * （「面板保持置顶」要套用到**所有**面板）。
 *
 * 这一层把三件事收在一处，调用方不用各写一遍：
 *
 * 1. **都带上自己真实的 label**。原来前端把 `"panel"` 写死在调用点上，
 *    多窗口之后那就是"只能操作第一个窗口"的 bug。
 * 2. **`list_panels` 取不到时退回老的单窗口行为**（见 `listPanelLabels`）。
 * 3. 把"哪些命令归多窗口管"列在一处，`api.ts` 那边一改名这里就编译不过。
 *
 * # 这里曾经有过一个类型断言（已删除）
 *
 * `api.ts` 还没落地时，这里用 `api as unknown as PanelCommands` 顶上，
 * 好让前端和 Rust 两条线并行推进。那个断言的问题很实在：断言之后编译器对这
 * 6 个成员**完全不再校验**，rust-core 把 `newPanel` 命名成别的、或者签名不一样，
 * 照样编译通过 —— 结果是 `tsc` 零错误、测试全绿，一跑起来「点新建窗口没反应」。
 *
 * 现在 `api.ts` 已经落地，所以**直接调 `api.*`，让编译器核对签名**。
 * 下面那几条调用点就是签名校验本身：参数个数、参数类型、返回类型对不上都会
 * 在 `tsc -b` 里报出来。
 */
import { api } from "../lib/api";
import { FALLBACK_PANEL_LABEL } from "../lib/panel-state";

/**
 * 当前所有面板窗口的 label。
 *
 * 取不到（脱离 Tauri 单独跑前端，或 `list_panels` 调用出错）就退回
 * `[FALLBACK_PANEL_LABEL]` —— 那是**老的单窗口行为**：那时候只可能有一个面板，
 * label 就是 `"panel"`。退回空数组的话，"面板保持置顶"会变成什么都不做，
 * 而界面看起来像设置生效了。
 *
 * ⚠️ 这个 `catch` 会连**真实**错误一起吞掉。`api.ts` 落地之后它理论上不会再触发；
 * 真的触发了就说明 `list_panels` 注册失败或调用出错，那是值得去查的事，
 * 不要因为"反正有兜底"就放过。
 */
export async function listPanelLabels(): Promise<string[]> {
  try {
    const labels = await api.listPanels();
    if (Array.isArray(labels) && labels.length > 0) return labels;
  } catch {
    /* 见上：退回老的单窗口行为 */
  }
  return [FALLBACK_PANEL_LABEL];
}

/**
 * 把「面板保持置顶」套用到**所有**面板窗口。
 *
 * `panelAlwaysOnTop` 是**全局**设置项（`models.rs` 里的 `Settings`），
 * 本轮刻意保持全局：一个面板切置顶 = 所有面板一起切。
 *
 * # 为什么不做成"每个窗口各自置顶"
 *
 * 那需要把这一项从全局设置挪进 `window.json`（按 label 存），并且给每个面板
 * 单独一个开关 —— 也就是在标题栏再加一个"本窗口置顶"的按钮。设置页那一项
 * 就变成了"新窗口的默认值"，语义变得含糊（用户改的是哪一个？）。
 * 用户这一轮要的是"两个面板并排"，并排时两个都置顶或都不置顶才是一致的行为。
 *
 * 逐个套用而不是只套第一个：只改一个的话，设置说"面板保持置顶"、
 * 别的面板却被别的窗口盖住，等于让这个开关撒谎。
 */
export async function applyAlwaysOnTopToAllPanels(value: boolean): Promise<void> {
  const labels = await listPanelLabels();
  for (const label of labels) {
    // 单个窗口失败（窗口刚好被关掉）不该中断其余的
    await api.setAlwaysOnTop(label, value).catch(() => {});
  }
}

/**
 * 面板窗口相关的动作。
 *
 * 名字与 `api.ts` 里的命令一一对应，方便对照；这里只做"总是带上 label"的收口。
 */
export const panelCommands = {
  /** 收起某个面板窗口。 */
  hidePanel: (label: string): Promise<void> => api.hidePanel(label),
  /** 显示某个面板窗口。 */
  showPanel: (label: string): Promise<void> => api.showPanel(label),
  /**
   * 新建一个面板窗口，返回它的 label（`panel-2`、`panel-3`……）。
   *
   * 用**最小空闲编号**：关掉 `panel-2` 之后新建的又叫 `panel-2`，
   * 于是它会回到用户上次放它的位置（见 `api.ts` 的 `newPanel` 说明，
   * 以及 `panel-state.ts` 里"label 会被复用"那段）。
   */
  newPanel: (): Promise<string> => api.newPanel(),
  /** 关掉（销毁）某个面板窗口。第一个面板 `panel` 只会被隐藏，不会被销毁。 */
  closePanel: (label: string): Promise<void> => api.closePanel(label),
};
