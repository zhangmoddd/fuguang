/**
 * 全应用共用的右键菜单。
 *
 * # 为什么必须自己做
 *
 * `main.tsx:125-131` 在 document 的**捕获阶段**全局 `preventDefault` 掉了
 * `contextmenu`（为了掐掉 WebView2 自带的「刷新 / 另存为 / 打印 / 检查」）。
 * 那个拦截是必需的，但副作用是**右键从此什么都不发生** —— 卡片、编辑器、
 * 列表行上点右键，用户等一个菜单，结果一片安静。
 *
 * # 为什么不用 Rust 的原生菜单
 *
 * 小球窗口的右键走的是 Rust 侧的原生托盘菜单（`BallWindow.tsx:154-156`）。
 * 那条路在这里走不通：原生菜单只认**菜单项文本**，我们这些动作要显示
 * 图标、要显示「Ctrl+C」这类小字说明、要按行禁用，而且面板是 420×640 的
 * 小窗，原生菜单的定位由系统决定、不受我们控制。所以这里是自绘菜单。
 *
 * # 为什么坐标算法单独一个文件
 *
 * 见 `context-menu-logic.ts` 的文件头：右键菜单是**光标锚定**的，
 * 面板只有 420px 宽，鼠标停在右下角时整块菜单必须翻到光标的左上侧。
 * 那种"只在边缘才出错"的判断最容易静默坏掉（现象是「右键没反应」），
 * 所以它单独成文件、有单测。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import {
  confirmSelection,
  hoverSelection,
  initialSelection,
  moveSelection,
  placeContextMenu,
  tidyItems,
  type MenuItemSpec,
  type Point,
} from "./context-menu-logic";
import { HIGHLIGHT_TTL_MS, shouldClearOnInteraction, type Highlight } from "./focus-highlight";
import { api } from "./api";

import "./context-menu.css";

/** 一个菜单项：纯逻辑那份规格 + 图标 + 点击后干什么。 */
export interface ContextMenuItem extends MenuItemSpec {
  icon?: ReactNode;
  /**
   * 用户选中了这一项。
   *
   * ⚠️ **调用时菜单已经关掉了**（先关再执行）。这不是顺手为之：
   * 「键入到当前光标」要靠"面板窗口失去焦点、外部窗口重新拿到焦点"
   * 才能把字打到用户刚才那个程序里；菜单还盖在屏幕上、面板还是活动窗口
   * 的时候去粘贴，字会打到面板自己身上。
   */
  onSelect: () => void;
}

/** 打开菜单时要给的全部信息。 */
export interface ContextMenuRequest {
  /** 光标位置（视口坐标）。 */
  point: Point;
  /** 菜单项。空数组会被当成"没东西可点"，直接不开。 */
  items: ContextMenuItem[];
  /**
   * 菜单关掉之后焦点该还给谁。不传就用"打开菜单那一刻的 activeElement"。
   *
   * 为什么需要显式传：右键的 `pointerdown` 有可能已经把焦点从输入框
   * 挪走了，等 `contextmenu` 事件到达时 `document.activeElement` 已经是
   * `<body>`。编辑器里右键 → 点「全选」→ 接着敲键盘，是最自然的动作，
   * 焦点回不到那个 textarea 的话用户会觉得"输入框坏了"。
   */
  restoreFocusTo?: HTMLElement | null;
}

/**
 * 打开菜单。
 *
 * 把 React 的 `onContextMenu` 事件直接传进来最省事（`clientX/clientY` 就是
 * 视口坐标）。**不要在这里 `preventDefault`**：全局那条捕获监听
 * （`main.tsx:125-131`）已经拦掉了浏览器默认菜单，这里再拦一次只会让
 * "谁负责拦"变成两个地方。
 */
export interface ContextMenuEventLike {
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/**
 * 打开菜单，菜单项**由调用点现拼**。
 *
 * 为什么是"传一个返回数组的函数"而不是"传一个数组"：
 * 调用点常常是几十张卡片共用一个渲染函数，每一项要闭包住**当前那一条**。
 * 写成数组的话，要么在 render 期就为所有条目拼一遍菜单（浪费），
 * 要么把 `items` 塞进 state（多一份会和数据不同步的副本）。
 * 传函数则只在真正右键的那一刻才拼。
 */
export type OpenContextMenu = (
  event: ContextMenuEventLike,
  build: () => ContextMenuItem[],
) => void;

export interface UseContextMenuResult {
  /**
   * 挂到 `onContextMenu` 上。因为要多传一个 `build`，所以不能直接写
   * `onContextMenu={ctx.open}`，要用 `onContextMenu={(e) => ctx.open(e, build)}`。
   */
  open: OpenContextMenu;
  /** 要渲染的菜单。没有打开时是 `null`。 */
  menu: ReactNode;
}

/**
 * 右键菜单的挂载点。
 *
 * 用法：
 * ```tsx
 * const ctx = useContextMenu();
 * return (
 *   <>
 *     <article onContextMenu={(e) => ctx.open(e, () => menuFor(item))}>…</article>
 *     {ctx.menu}
 *   </>
 * );
 * ```
 *
 * 菜单是 `position: fixed`，所以挂在哪儿都行 —— 它不受任何祖先
 * `overflow: auto` 的裁剪（这也是必须用 fixed 的原因：三个列表页的
 * 内容区都是滚动容器，absolute 的菜单会被切掉一半）。
 */
export function useContextMenu(): UseContextMenuResult {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);

  /**
   * 最近一次**按下鼠标时**的焦点元素。
   *
   * 为什么不直接读 `document.activeElement`：右键的 `pointerdown` 有可能
   * 先把焦点从输入框挪走，等 `contextmenu` 事件到达时已经是 `<body>` 了。
   * 在 pointerdown 的**捕获阶段**（早于任何 blur 和任何组件的 handler）
   * 记一份，就拿到了用户右键之前真正在用的那个元素。
   */
  const lastActiveRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onDown = () => {
      const el = document.activeElement;
      lastActiveRef.current = el instanceof HTMLElement ? el : null;
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  /**
   * `open` 的 identity 必须稳定：它会挂到几十张卡片的 `onContextMenu` 上，
   * 每次渲染换一个新函数等于让 React 每次都重挂一遍所有卡片的属性。
   * 用 ref 存一份，`useCallback` 的空依赖版本和它等价。
   */
  const openRef = useRef<OpenContextMenu>((event, build) => {
    // 列表行外面可能还套着别的右键处理器（卡片里嵌按钮），
    // 里层的这一条更具体，不该让外层的也跟着开
    event.stopPropagation?.();
    // 一个可点的项都没有时**不开**：弹出一个空框比不弹更让人困惑
    const items = tidyItems(build());
    if (items.length === 0) {
      // 这里是"右键了但什么都没发生"的一种可能来源，所以不留成静默 return。
      // 现有的四个调用点（编辑器正文区、四个列表行、图片）都不可能产出空菜单，
      // 所以正常情况下这行永远不会打 —— 它的作用是：万一以后有人拼出一个
      // 全是条件项、条件全不成立的菜单，能在控制台看到原因，而不是对着
      // "右键没反应"干瞪眼。
      console.warn("[浮光] 右键菜单没有任何可用项，已跳过弹出");
      return;
    }
    setRequest({
      point: { x: event.clientX, y: event.clientY },
      items,
      restoreFocusTo: lastActiveRef.current,
    });
  });

  const menu = request ? (
    <ContextMenu
      point={request.point}
      items={request.items}
      restoreFocusTo={request.restoreFocusTo}
      onClose={() => setRequest(null)}
    />
  ) : null;

  return { open: openRef.current, menu };
}

/**
 * 菜单根节点的类名。
 *
 * ⚠️ 这个字符串被 {@link isContextMenuOpen} 用来判断"菜单现在开着"，
 * 而那个判断是**编辑器/表单在 Esc 上让位的唯一依据**（见 `lib/escape.ts`
 * 的 `shouldClaim`）。所以它必须只在这里定义一次，别处不许再写一份字面量。
 */
const MENU_CLASS = "ctxmenu";

/**
 * 现在有右键菜单开着吗？
 *
 * # 为什么用 DOM 探测，而不是把开合状态暴露出去
 *
 * 菜单的开合状态在 `useContextMenu` 内部（一个 `useState`）。要让外面问到它，
 * 得加 context 或者往回调链里塞一个 `isOpen` —— 而调用方只需要一个布尔，
 * 且**只在按 Esc 的那一刻**需要。所以按类名探测一次最省事，
 * 也不在渲染路径上（`querySelector` 只在 keydown 里跑）。
 *
 * # 谁能看见
 *
 * 菜单从渲染到卸载的**整段时间**里，根节点都带着 {@link MENU_CLASS}，
 * 所以任何时刻问都是准的。两处消费者：
 * 1. `lib/media-ui.tsx` 的 `blocksEscapeNow()`（编辑器让位）；
 * 2. `features/timer/index.tsx` 的计时器表单让位 ——
 *    表单挂在列表上方，列表行还能右键，菜单盖在表单上时
 *    Esc 应该关菜单而不是关表单（关表单会把没保存的设置丢掉）。
 */
export function isContextMenuOpen(): boolean {
  return document.querySelector(`.${MENU_CLASS}`) !== null;
}

export interface ContextMenuProps {
  point: Point;
  items: ContextMenuItem[];
  /** 关掉之后焦点还给谁。见 `ContextMenuRequest.restoreFocusTo`。 */
  restoreFocusTo?: HTMLElement | null;
  onClose: () => void;
}

/**
 * 菜单本体。
 *
 * 交互约定（与项目里其它弹层一致，见 `lib/escape.ts`）：
 * - `↑`/`↓`（左右也认）移动选择，两端循环，**跳过禁用的项**；
 * - `Enter` 执行选中的项；没选中就什么都不做（**刻意不默认选中第一项**，
 *   理由见 `context-menu-logic.ts` 的 `initialSelection`）；
 * - `Esc` 只关菜单这一层：在捕获阶段 `stopPropagation`，
 *   不让它冒泡到主面板的「收起面板」；
 * - 点菜单外面、窗口失焦都关掉；
 * - 靠近右/下边缘时翻转，绝不越界。
 */
export function ContextMenu({ point, items, restoreFocusTo, onClose }: ContextMenuProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [selection, setSelection] = useState<number>(() => initialSelection());

  /**
   * `onClose` 每次渲染都是新的箭头函数，直接进依赖会让下面那两个
   * document 监听每渲染一次就重挂一次 —— 而鼠标在菜单上移动就会重渲染
   * （选择态变化）。用 ref 存最新的一份。
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  /**
   * 打开菜单之前焦点在哪儿。
   *
   * 关掉菜单之后要还回去：编辑器里右键 → 点「全选」→ 关掉菜单，
   * 焦点必须回到那个 textarea，否则用户接着敲键盘什么都没发生
   * （而他又看不到焦点在哪，只会觉得"输入框坏了"）。
   */
  const restoreRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const fallback = document.activeElement;
    restoreRef.current =
      restoreFocusTo ?? (fallback instanceof HTMLElement ? fallback : null);
    // 只在挂载时取一次：菜单开着的时候用户可能点了别处，
    // 但那之后菜单早就被"点外面关掉"了，不会走到这里
  }, []);

  /**
   * 把焦点拿到菜单上。
   *
   * 不做这一步的话，键盘完全没用：keydown 会发给**原来的**焦点元素
   * （编辑器里那个 textarea、或者 `<body>`），而我们的 `onKeyDown` 挂在
   * 菜单元素上，一个都收不到 —— 用户看到菜单弹出来了，按方向键却没反应。
   *
   * `tabIndex={-1}` 让它可被 `focus()` 但不进 Tab 序列：
   * 菜单是"就地弹出的一层"，不该打乱用户原本的 Tab 顺序。
   */
  useLayoutEffect(() => {
    boxRef.current?.focus({ preventScroll: true });
  }, []);

  // 点菜单外面关掉。用 `pointerdown`（不是 click）：
  // 用户按下的那一刻菜单就该消失，等抬起手指才消失会有一瞬间的"没反应"。
  // 监听挂在 document 上、**捕获阶段**，因为列表行自己也可能有 pointerdown
  // （拖拽）——那些 handler 调 `stopPropagation` 不会影响捕获阶段的我们。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const box = boxRef.current;
      if (box && !box.contains(e.target as Node)) closeRef.current();
    };
    const onBlur = () => closeRef.current();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  /**
   * 键盘。
   *
   * ⚠️ 这是 **React 的合成事件**，不是挂在菜单元素上的原生监听器：
   * React 18 把 `onKeyDown` 委托到**根容器、冒泡阶段**（**不是**捕获阶段）。
   *
   * 它仍然拦得住主面板的「Esc 收起」（`PanelWindow` 监听在 `window` 冒泡阶段）——
   * 因为根容器在 `window` 之下，冒泡时**先到根容器**，在那里
   * `stopPropagation` 就够把事件截住，不必用捕获。
   *
   * ⚠️ **别改成 `onKeyDownCapture`。** 那不是"更保险"，而是换了语义：
   * 捕获阶段在根容器上、早于菜单元素自己的处理，而且会和 `escape.ts` 里那套
   * 「先判认领、再决定拦不拦传播」的让位机制对不上 ——
   * 编辑器/大图/菜单三层的 Esc 分工就乱了。
   * 现在的行为是**对的**（三轮独立审查都确认过）；要动它先读 `lib/escape.ts`。
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      setSelection((s) => moveSelection(items, s, 1));
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      setSelection((s) => moveSelection(items, s, -1));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      const item = confirmSelection(items, selection);
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      run(item);
    }
  };

  /**
   * 执行一项：**先关菜单，再执行**。
   *
   * 顺序不能反。「键入到当前光标」是把字打到用户刚才用的那个外部窗口 ——
   * 只有面板窗口不再是活动窗口时，`paste_text` 才找得到它
   * （见 `src-tauri/src/platform.rs` 的"上一次外部窗口"是怎么记的）。
   * 菜单还开着就去粘贴，等于把字打在面板自己身上。
   *
   * 延迟对所有项一视同仁（包括「复制」「全选」这些不需要窗口焦点切换的）：
   * 120ms 在人的感知里仍是"立刻"，而给每一项单独判断"这一项要不要等"
   * 会多出一个必然会被改错的分支。
   */
  const run = (item: ContextMenuItem) => {
    if (item.disabled) return;
    closeRef.current();
    window.setTimeout(item.onSelect, PANEL_BLUR_SETTLE_MS);
  };

  /**
   * 量完之后再摆。
   *
   * 菜单高度取决于里面有几行、有没有分隔线，**写死会翻错方向** ——
   * 靠底边的菜单本该朝上翻，按一个偏小的估计高度算出来"下面放得下"，
   * 结果最后一行被窗口切掉，用户永远看不到「删除」。
   * 用 `useLayoutEffect`：在浏览器绘制之前就摆好，看不到"先出现在左上角再跳过去"。
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    setPos(
      placeContextMenu(
        point,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [point, items]);

  // 关掉之后把焦点还回原处。菜单里点完「全选」接着敲键盘是很自然的动作。
  useEffect(() => {
    return () => {
      const el = restoreRef.current;
      // `isConnected` 那道判断是必要的：定位请求可能让页面换了文件夹 /
      // 换了日期，原来那个输入框已经被卸载了。对着一个脱离文档的元素
      // 调 `focus()` 不会报错，但焦点会留在 `<body>` 上，用户敲键盘没反应。
      if (el && el.isConnected) el.focus();
    };
  }, []);

  const view = useMemo(() => tidyItems(items), [items]);

  return (
    <div
      ref={boxRef}
      className={MENU_CLASS}
      role="menu"
      tabIndex={-1}
      // 量之前先藏起来，避免"先出现在左上角再跳过去"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
      onKeyDown={onKeyDown}
      // 菜单内部的点击不该冒泡到别处（例如卡片的"点开"）
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // 在菜单上再右键：不要叠出第二个菜单
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {view.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          aria-disabled={item.disabled || undefined}
          className={`ctxmenu__row${item.dividerBefore ? " ctxmenu__row--divider" : ""}${
            item.danger ? " ctxmenu__row--danger" : ""
          }${selection === i ? " ctxmenu__row--on" : ""}`}
          // 菜单项在渲染后不该抢走焦点：焦点留在菜单容器上，
          // 方向键才不会被浏览器当成"在按钮之间移动"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setSelection(hoverSelection(view, i))}
          onClick={() => run(item)}
        >
          {item.icon && <span className="ctxmenu__icon">{item.icon}</span>}
          <span className="ctxmenu__label">{item.label}</span>
          {item.hint && <em className="ctxmenu__hint">{item.hint}</em>}
        </button>
      ))}
    </div>
  );
}

/**
 * 关掉菜单之后多久再执行动作。
 *
 * # 为什么需要等
 *
 * 「键入到当前光标」依赖"上一次使用的外部窗口"这个记录
 * （Rust 侧 `platform::paste_text` 去找它）。而用户此刻的活动窗口是**面板**——
 * 他刚在面板里点了右键。如果立刻调 `paste_text`，目标窗口就是面板自己。
 *
 * 所以顺序必须是：关掉菜单 → 面板把焦点交还出去 → 再粘贴。
 * 菜单组件保证"先关再执行"（见 `run()`），这个延迟保证**焦点真的交出去了**。
 *
 * # 这是"实测校准"的值，不是理论值
 *
 * 120ms 是保守取值（本机实测窗口焦点切换在 20~60ms 之间完成）。
 * 它偏大不会出问题（用户感知不到 0.12 秒），偏小才会 —— 那会变成
 * "偶尔粘到面板自己身上"，而这种偶发最难排查。所以宁可等久一点。
 * ⚠️ 这个延迟是否在所有机器上都够，**未验证**（只在开发机上观察过）。
 */
export const PANEL_BLUR_SETTLE_MS = 120;

/**
 * 把某个 id 的元素滚进可视区。找不到就什么都不做（不是错误）。
 *
 * 为什么要 `requestAnimationFrame` 再滚：定位请求到达时，页面常常**同一帧**
 * 正在换文件夹 / 换日期 —— 列表内容还没提交到 DOM，这时 `getElementById`
 * 找到的是"上一屏"的元素（或者干脆找不到）。等一帧再滚才滚得对。
 *
 * 为什么用 `block: "center"` 而不是 `"nearest"`：`nearest` 在条目**已经**
 * 在视口里时**完全不滚**，于是高亮出现的位置可能贴着列表最上/最下边缘，
 * 用户很难注意到。居中滚动会让它出现在视线正中。
 */
export function scrollIntoViewSoon(domId: string): void {
  window.requestAnimationFrame(() => {
    const el = document.getElementById(domId);
    if (!el) return;
    // 有些 WebView 版本上 `scrollIntoView` 的选项参数会被忽略；
    // 那时退化成 `scrollIntoView()`（对齐到上边缘），仍然是"能看见"
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      el.scrollIntoView();
    }
  });
}

export interface UseFocusHighlightResult {
  /** 当前该高亮哪一条（`null` = 没有）。 */
  highlight: Highlight | null;
  /**
   * 点亮某一条（传 `null` 等于清掉）。
   *
   * 收 `null` 是刻意的：调用方拿到的是 `highlightFrom(target)` 的结果，
   * 那个函数的返回类型本来就是 `Highlight | null`。不让 `show` 收 null，
   * 每个调用点都要写一句"理论上不会 null"的断言 —— 而那种断言正是
   * 以后被改错的地方。
   */
  show: (target: Highlight | null) => void;
  /** 立刻清掉（不需要自动清理时用）。 */
  clear: () => void;
}/**
 * 搜索结果定位后的高亮态：**短暂 + 可清除**。
 *
 * # 清除时机（两条路，先到先算）
 *
 * 1. **到点自动灭**：`HIGHLIGHT_TTL_MS`（2600ms）之后自己消失；
 * 2. **用户一交互就灭**：点一下、滚一下、按个键、或者窗口失焦
 *    —— 他开始操作了，说明他已经找到那一条了。
 *
 * 交互监听是**延后一帧**才挂上的。这不是洁癖：触发定位的那次按键
 * （命令面板里的 `Enter`）的 `keyup` 会在 React 处理完 `keydown` **之后**
 * 才到达 document —— 监听要是当场就挂上，高亮会在亮起来的同一瞬间被
 * 自己那次 `keyup` 灭掉，用户看到的是"跳过来了但什么都没亮"。
 *
 * # 为什么这个 hook 住在这个文件里
 *
 * 它是纯逻辑 `focus-highlight.ts` 的 React 绑定。那个模块刻意只放
 * 不依赖 React 的东西（这样能直接单测），而 `lib/` 下没有第二个
 * 放"定位相关的 UI 粘合"的地方 —— 硬造一个文件不如放在这里，
 * 两者总是一起被用（页面收到定位 → 点亮 → 渲染右键菜单那一堆）。
 */
export function useFocusHighlight(): UseFocusHighlightResult {
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  useEffect(() => {
    if (!shouldClearOnInteraction(highlight)) return;

    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_TTL_MS);

    // 延后一帧挂交互监听，理由见上面的说明
    let raf = 0;
    const clear = () => setHighlight(null);
    raf = window.requestAnimationFrame(() => {
      document.addEventListener("pointerdown", clear, true);
      document.addEventListener("wheel", clear, true);
      document.addEventListener("keydown", clear, true);
      window.addEventListener("blur", clear);
    });

    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
      // 无论监听挂没挂上，都移除一遍：`removeEventListener` 对
      // 没注册过的监听是无害的，比维护一个"挂上了吗"的标志可靠
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("wheel", clear, true);
      document.removeEventListener("keydown", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, [highlight]);

  return {
    highlight,
    show: setHighlight,
    clear: () => setHighlight(null),
  };
}

// ===============================================================
// 编辑器正文区的右键菜单
// ===============================================================

/** 编辑器右键菜单里各项实际会做什么。由各页面提供，`lib` 不碰它们的 state。 */
export interface TextAreaMenuActions {
  /**
   * 「键入到当前光标」：把一段文字打到用户刚才用的外部窗口。
   *
   * 复用页面自己的成功 / 警告 / 失败提示（`snippets/index.tsx` 的
   * `reportPaste`）—— 那三档反馈里有一条"成功但剪贴板原文已被替换"
   * 必须让用户看到，重写一遍几乎一定会漏。
   */
  onTypeInto: (text: string) => void;
  /**
   * 读剪贴板失败时说什么。
   *
   * 为什么不让这里直接写死文案：四个页签的提示条样式和措辞风格不同
   * （有的用 `showFeedback`，有的直接 `setError`），文案统一写死会让
   * 某一个页面上出现一句风格不对的话。
   */
  onNotice: (text: string, kind: "ok" | "warn") => void;
  /** 写剪贴板。用 `api.copyText`（Rust 侧 CF_UNICODETEXT），和全应用一致。 */
  copyText: (text: string) => Promise<boolean>;
}

/**
 * 编辑器正文区（受控 textarea）的右键菜单。
 *
 * 用法：
 * ```tsx
 * const area = useTextAreaMenu(ctx, {
 *   onTypeInto: typeInto,
 *   onNotice: (t, k) => showFeedback(t, k),
 *   copyText: api.copyText,
 * });
 * <textarea ref={area.ref} onContextMenu={area.onContextMenu} … />
 * ```
 *
 * # 「键入到当前光标」在没有选中文字时**禁用**，而不是发整段正文
 *
 * 这是本任务里唯一需要我自己拍的一处，理由：
 * 1. **列表行右键已经能发整条**（`snippetMenu` 的第一项就是），
 *    编辑器里再提供一次"发全文"是重复的；
 * 2. 在正文框里右键、**没选中任何字**，用户的心理模型是"我要在这儿
 *    做点什么"，而不是"我要把这一整篇发到微信去"。整段正文可能是几千字，
 *    误发出去是**不可撤销**的（对方已经收到了）；
 * 3. 按钮上的字是「键入到当前光标」，说的是一件**有对象**的事。
 *    没有对象时把它变成"发全文"，就是让按钮做了它没承诺的事。
 *
 * 禁用的同时给一行 `hint`（"先选中文字"），用户一眼就知道怎么让它可用 ——
 * 只把按钮变灰而不说为什么，是比不做还糟的处理。
 */
export function useTextAreaMenu(
  ctx: UseContextMenuResult,
  actions: TextAreaMenuActions,
): {
  /**
   * 挂到 `<textarea ref={...}>` 上。
   *
   * 类型写成 `Ref<HTMLTextAreaElement>`（而不是 `RefObject<...>`）：
   * 这个项目用的是 React 18 的类型，`RefObject` 的 `current` 是**只读**的，
   * 而 `ref` 属性要的正是可写的 `Ref`。写窄了会在每个调用点报一个
   * 看不出原因的类型错误。
   */
  ref: React.Ref<HTMLTextAreaElement>;
  onContextMenu: (e: ContextMenuEventLike) => void;
} {
  const ref = useRef<HTMLTextAreaElement>(null);

  const onContextMenu = (e: ContextMenuEventLike) => {
    const el = ref.current;
    if (!el) return;

    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const selected = el.value.slice(start, end);
    const hasSelection = selected.length > 0;

    /**
     * 改正文。
     *
     * 受控组件不能直接写 `el.value` —— 下一次渲染就被 React 覆盖回去了。
     * 所以走 `HTMLTextAreaElement.prototype` 上那个原生 setter，
     * 再派发一次真正的 `input` 事件，让 React 收到"用户改了内容"。
     *
     * ⚠️ 已知取舍：这么改**不进浏览器的撤销栈**，用户按 Ctrl+Z 撤不回
     * 这一次粘贴 / 剪切。要进撤销栈只能自己维护一份历史，
     * 而那和 textarea 自带的撤销栈会打架（两套历史，Ctrl+Z 时行为不可预测）。
     * 这里选择"不干扰原生撤销栈"，代价是这一次操作撤不回。
     */
    const replaceSelection = (text: string) => {
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      // 用 React 的 value setter 之外的办法改受控组件是徒劳的：
      // 直接写 `el.value` 会在下一次渲染被覆盖回去。所以走 native setter
      // + 派发 input 事件，让 React 收到一次真正的输入事件。
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // 光标落到插入内容的后面：用户接着打字的位置就是他刚插入的那一段之后
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
    };

    const selectAll = () => {
      el.focus();
      el.setSelectionRange(0, el.value.length);
    };

    const items: ContextMenuItem[] = [
      {
        id: "type",
        label: "键入到当前光标",
        disabled: !hasSelection,
        hint: hasSelection ? undefined : "先选中文字",
        onSelect: () => actions.onTypeInto(selected),
      },
      {
        id: "copy",
        label: "复制",
        hint: "Ctrl+C",
        disabled: !hasSelection,
        dividerBefore: true,
        onSelect: () => {
          void actions.copyText(selected).then((ok) => {
            actions.onNotice(
              ok ? "已复制到剪贴板" : "复制失败，剪贴板可能被占用",
              ok ? "ok" : "warn",
            );
          });
        },
      },
      {
        id: "cut",
        label: "剪切",
        hint: "Ctrl+X",
        disabled: !hasSelection,
        onSelect: () => {
          void actions.copyText(selected).then((ok) => {
            if (!ok) {
              // 写剪贴板失败时**不删正文**：那等于把用户的字弄丢了，
              // 而他以为只是"剪切"（字还在剪贴板里）
              actions.onNotice("剪切失败：剪贴板被占用，正文没有改动", "warn");
              return;
            }
            replaceSelection("");
            actions.onNotice("已剪切到剪贴板", "ok");
          });
        },
      },
      {
        id: "paste",
        label: "粘贴",
        hint: "Ctrl+V",
        onSelect: () => {
          void readClipboardText().then((text) => {
            if (text === null) {
              // WebView2 在面板不是活动窗口时会拒绝读剪贴板。
              // 不静默失败：用户点了"粘贴"什么都没发生，会以为软件坏了。
              actions.onNotice("读不到剪贴板，请用 Ctrl+V 粘贴", "warn");
              return;
            }
            if (text === "") {
              actions.onNotice("剪贴板里没有文字", "warn");
              return;
            }
            replaceSelection(text);
          });
        },
      },
      {
        id: "select-all",
        label: "全选",
        hint: "Ctrl+A",
        dividerBefore: true,
        onSelect: selectAll,
      },
    ];

    ctx.open(e, () => items);
  };

  return { ref, onContextMenu };
}

/**
 * 读系统剪贴板里的文字。读不到返回 `null`（不是空串）。
 *
 * # 主路径是 Rust 命令，不是 `navigator.clipboard`（RV3 的 F3）
 *
 * 原来这里只走 `navigator.clipboard.readText()`。那条路**很可能根本走不通**：
 * 它要求文档处于聚焦状态，而且 `src-tauri/capabilities/default.json` 里
 * 没有任何 clipboard 权限 —— 结果是「右键 → 粘贴」永远只能提示用户
 * "请用 Ctrl+V"。**那是降级，不是实现。**
 *
 * 现在主路径是 `read_clipboard_text`（Rust 侧 `platform::clipboard_get_text()`，
 * 走 Win32 剪贴板 API，和"模拟 Ctrl+V"用的是同一套已经稳定的机制），
 * `navigator.clipboard` 只留作**兜底**：命令万一不可用（旧版后端、
 * 命令没注册）时再试一次浏览器那条路。
 *
 * # 三态语义（与 Rust 侧一致）
 *
 * - 拿到文本 → 返回它；
 * - `null` = **剪贴板里没有文本**（只有图片 / 空的）→ 调用方提示用 Ctrl+V，
 *   **不当错误**。rust-core 特意说明过：`clipboard_get_text()` 在"没有文本"
 *   和"剪贴板被别的程序占着读不出来"两种情况下都返回 `None`，
 *   两种情况的处理动作相同，所以前端不用再分状态。
 * - 命令抛错（命令不存在、IPC 断了）→ 落到浏览器兜底；兜底也失败才返回 `null`。
 *
 * # 为什么不用 `document.execCommand("paste")`
 *
 * 它在现代 WebView 里默认被禁用，而且已经废弃 —— 调了不报错、也不生效，
 * 正是最难排查的那种失败。
 */
async function readClipboardText(): Promise<string | null> {
  try {
    const text = await api.readClipboardText();
    // 命令成功但剪贴板里没有文本：**不要**再去试浏览器那条路 ——
    // 它只会因为权限/聚焦再失败一次，白白多等一个 Promise
    if (text === null) return null;
    return text;
  } catch {
    // 命令不可用（旧后端 / 没注册）才退回浏览器。这条兜底本身
    // 能不能在 WebView2 里跑通**未验证**（不许启动 GUI 实测），
    // 所以失败路径必须完整：读不到就提示用户用 Ctrl+V。
    return navigatorFallbackRead();
  }
}

/** 兜底：浏览器剪贴板。要求文档聚焦，权限不足时直接抛。 */
async function navigatorFallbackRead(): Promise<string | null> {
  try {
    const clip = navigator.clipboard;
    if (!clip?.readText) return null;
    return await clip.readText();
  } catch {
    return null;
  }
}
