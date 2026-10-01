/**
 * 拖拽排序与归类。
 *
 * # 为什么不用 HTML5 拖放
 *
 * Tauri 在 Windows 上要求把窗口的 `dragDropEnabled` 关掉，HTML5 的
 * `dragstart` / `drop` 才会触发——而那会**同时废掉「把文件拖进面板添加链接」**，
 * 那是已经在用的功能。两者冲突，所以这里用指针事件自绘：
 * 不依赖浏览器的拖放实现，也就和 OS 级的文件拖放互不干扰。
 *
 * # 一个手势，两种落点
 *
 * 拖一个条目时：
 * - 落在**另一个条目**上 → 插到它前面/后面（排序）
 * - 落在**文件夹卡片**上 → 放进那个文件夹（归类）
 *
 * 拖一个**文件夹**时：只能和同级文件夹排序。把文件夹拖进另一个文件夹
 * （改变父子关系）刻意不做——那是"移动"而不是"排序"，混在同一个手势里
 * 会有歧义（落在卡片中间到底是排到它前面还是放进去？）。
 *
 * # 判定为什么用矩形而不是 `elementFromPoint`
 *
 * `elementFromPoint` 会被跟手的元素挡住，而且它把"能不能点中"和"拖到哪儿"
 * 两件事混在一起。用「拖拽开始时缓存一批矩形 + 纯函数判断点在不在里面」
 * 既好推理，**也能直接单测**——见 `resolveDrop`。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import "./drag-drop.css";

/** 投放标记属性。`FolderTiles` 写前者，各功能的条目写后者。 */
export const DROP_FOLDER_ATTR = "data-drop-folder";
export const DROP_ITEM_ATTR = "data-drop-item";

/**
 * 显式标记「这个控件可以发起拖拽」。
 *
 * 只有文件夹卡片本体那个「打开」按钮带它 —— 卡片是文件夹排序唯一的抓手，
 * 而它本身又是个按钮。卡片内部的删除/改名按钮**故意不带**。
 */
export const DRAG_HANDLE_ATTR = "data-drag-handle";

/**
 * 这次 `pointerdown` 能不能发起拖拽。
 *
 * 抽成纯函数是为了能直接单测：两个 `closest()` 的结果由调用方查好传进来，
 * 这里只负责判定。这段判定的两个分支都踩过坑：
 *
 * - **控件上按下 → 不拖**。不拦的话，手抖越过 6px 阈值就会把「点删除」
 *   变成「拖卡片」，用户看到的是按钮点了没反应。
 * - **但文件夹卡片本体那个按钮必须能拖**，否则文件夹没法排序。
 *   所以例外收窄到显式标了 [`DRAG_HANDLE_ATTR`] 的元素上，
 *   而不是原来那句「只要在 `[data-drop-folder]` 里就放行」——
 *   后者会把卡片内部的删除/改名按钮一起放行。
 *
 * @param onControl    按下点是否命中 `ignoreSelector`（button/input/…）
 * @param onDragHandle 按下点是否命中显式的拖拽抓手
 */
export function canStartDrag(onControl: boolean, onDragHandle: boolean): boolean {
  return !onControl || onDragHandle;
}

/** 拖拽落点。 */
export type DropSpot =
  | { kind: "item"; id: string; before: boolean }
  | { kind: "folder"; id: string };

/** 一个候选落点在视口里的矩形。 */
export interface DropCandidate {
  id: string;
  /** 落到它身上是「插到前后」还是「放进去」。 */
  kind: "item" | "folder";
  rect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

/** 判断"插到前面还是后面"时看哪个轴。 */
export type DropAxis = "vertical" | "horizontal";

/**
 * 根据指针位置算出应该投放到哪里。
 *
 * @param candidates - 候选落点。**顺序即优先级**，调用方要把文件夹排在前面：
 *   两个矩形重叠时取第一个命中的，顺序不确定的话同一次拖动会一会儿放这儿
 *   一会儿放那儿。卡片正常不会重叠，但缩放到某个临界值时就可能贴上。
 * @param axis - 纵向列表看 `y`，横向/网格看 `x`
 */
export function resolveDrop(
  x: number,
  y: number,
  candidates: DropCandidate[],
  axis: DropAxis,
): DropSpot | null {
  for (const c of candidates) {
    const { left, top, right, bottom } = c.rect;
    // 闭区间：用半开区间的话，两个相邻卡片之间会有一条"谁都放不进去"的缝
    if (x < left || x > right || y < top || y > bottom) continue;

    if (c.kind === "folder") return { kind: "folder", id: c.id };

    const before =
      axis === "vertical"
        ? y < top + (bottom - top) / 2
        : x < left + (right - left) / 2;
    return { kind: "item", id: c.id, before };
  }
  return null;
}

/** 拖动前必须移动这么多像素才算"在拖"，否则算点击。 */
const DRAG_THRESHOLD = 6;

export interface DragSortOptions {
  /** 排序轴：纵向列表用 `vertical`，网格用 `horizontal`。 */
  axis: DropAxis;
  /** 松手时的落地动作，由各功能自己实现（怎么存它最清楚）。 */
  onDrop: (draggedId: string, draggedKind: "item" | "folder", spot: DropSpot) => void;
  /**
   * 从这些元素上按下的**不算拖拽**。
   *
   * 默认排除按钮和输入框：列表页的卡片里全是按钮，不排除的话，
   * 点「粘贴」时手稍微抖一下就会被判成拖拽，而拖拽会吞掉点击——
   * 表现是"按钮时灵时不灵"，而且极难排查。
   *
   * 链接页必须覆盖这个默认值：它的整个格子本体**就是一个按钮**
   * （点了就打开），只能排除那一排悬停操作按钮。
   */
  ignoreSelector?: string;
}

/**
 * 哪些元素算「控件」：在它们上面按下**不该**发起拖拽（除非显式标了拖拽抓手）。
 *
 * 这是**底线**，页面覆盖不掉。页面可以再用 `ignoreSelector` 追加排除项，
 * 但追加不能替代它 —— 链接页曾经把 `ignoreSelector` 收窄成"只排除那一排
 * 悬停操作按钮"（因为它的格子本体是个按钮，必须能拖），结果**文件夹卡片内部**
 * 的删除/改名按钮就不在排除范围里了：手抖越过 6px 阈值就把「点删除」变成
 * 「拖卡片」。靠页面各自记得加选择器是不可靠的，所以这里兜住。
 */
const CONTROL_SELECTOR = "button, input, textarea, select, a";

/** 页面不传 `ignoreSelector` 时的默认值。 */
const DEFAULT_IGNORE = CONTROL_SELECTOR;

export interface DragItemProps {
  onPointerDown: (e: ReactPointerEvent) => void;
  /** 只有条目才有这个标记；文件夹卡片靠 `data-drop-folder` 被识别。 */
  "data-drop-item"?: string;
}

export interface DragSortApi {
  /** 正在拖的东西 id；`null` 表示没在拖。 */
  draggingId: string | null;
  /** 指针下方的落点，用来高亮。 */
  over: DropSpot | null;
  /** 指针位置（视口坐标）。 */
  pointer: { x: number; y: number } | null;
  /**
   * 挂到**可拖动、同时也是排序投放目标**的条目上。
   *
   * 只给真正参与手动排序的列表用（目前是链接页）。文本片段和计时器的顺序是
   * **刻意自动排的**（收藏优先、使用次数优先、运行中的在前），给它们加手动顺序
   * 会和那套语义打架；它们只需要 `handleProps`。
   */
  itemProps: (id: string) => DragItemProps;
  /**
   * 只给拖动能力、**不当作排序投放目标**。
   *
   * 两处用得上：不参与手动排序的条目（片段 / 计时器），
   * 以及文件夹卡片（它靠 `data-drop-folder` 被识别，写成条目会让
   * "把链接插到两个文件夹之间"这种无意义落点也生效）。
   */
  handleProps: (id: string, kind?: "item" | "folder") => {
    onPointerDown: (e: ReactPointerEvent) => void;
  };
  /**
   * 目标条目上要加的类名（插入位置的提示线）；不是目标就返回空串。
   *
   * 横向和纵向的线画在不同边上，所以这里按 `axis` 给出不同的类名。
   */
  overClass: (id: string) => string;
  /**
   * 拖动结束后要**吞掉**的那一次 click。
   *
   * 条目本身可能绑了点击动作（比如链接格子点了就打开）。
   * 不吞的话，拖完松手会顺手把那个链接打开——用户根本预料不到。
   */
  consumeClick: () => boolean;
}

/**
 * 把拖拽排序 / 归类这套交互绑起来。
 *
 * @param options.onDrop - 松手时的落地动作
 */
export function useDragSort({
  axis,
  onDrop,
  ignoreSelector = DEFAULT_IGNORE,
}: DragSortOptions): DragSortApi {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [over, setOver] = useState<DropSpot | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  /**
   * 拖拽进行中的可变状态。
   *
   * 必须放 ref：`pointermove` 监听器是挂在 document 上的，
   * 它闭包捕获的是注册那一刻的值，读 state 会读到旧值。
   */
  const session = useRef<{
    id: string;
    kind: "item" | "folder";
    startX: number;
    startY: number;
    /** 是否已经越过阈值、真正进入拖拽。 */
    active: boolean;
    /** 拖拽开始时缓存的目标矩形，见 `resolveDrop` 的说明。 */
    candidates: DropCandidate[];
    /** 最近一次指针位置。滚动时要按它重新判落点。 */
    lastX: number;
    lastY: number;
  } | null>(null);

  /** 指针下方的落点（ref 版，`pointerup` 里要读最新值）。 */
  const overRef = useRef<DropSpot | null>(null);
  /** 刚刚拖完，接下来那一次 click 要吞掉。 */
  const swallowClick = useRef(false);

  /**
   * 最新的 `onDrop`。
   *
   * 放 ref 里而不是进 effect 依赖：调用方通常写成内联箭头函数，每次渲染都是新的，
   * 直接进依赖会让 document 上的三个监听器**每渲染一次就重挂一次**——
   * 计时页每 100ms 重渲染一次，等于每秒重挂十次，还可能吃掉正好落在
   * 摘除与重挂之间的那一次 `pointermove`。
   */
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  });

  const reset = useCallback(() => {
    session.current = null;
    overRef.current = null;
    setDraggingId(null);
    setOver(null);
    setPointer(null);
  }, []);

  useEffect(() => {
    /** 收集当前的候选落点。顺序即优先级：文件夹排在前面。 */
    const collect = (draggedKind: "item" | "folder"): DropCandidate[] => {
      const rectOf = (el: Element) => el.getBoundingClientRect();
      const out: DropCandidate[] = [];

      // 文件夹卡片：拖条目时是"放进去"，拖文件夹时是"插到它前后"（同级排序）
      for (const el of document.querySelectorAll<HTMLElement>(`[${DROP_FOLDER_ATTR}]`)) {
        const id = el.getAttribute(DROP_FOLDER_ATTR) ?? "";
        out.push({ id, kind: draggedKind === "item" ? "folder" : "item", rect: rectOf(el) });
      }

      // 条目之间排序只在拖条目时有意义：文件夹和条目是两段，不会互相插入
      if (draggedKind === "item") {
        for (const el of document.querySelectorAll<HTMLElement>(`[${DROP_ITEM_ATTR}]`)) {
          const id = el.getAttribute(DROP_ITEM_ATTR) ?? "";
          out.push({ id, kind: "item", rect: rectOf(el) });
        }
      }

      return out;
    };

    /** 按当前缓存的矩形判一次落点；只有真的变了才 setState。 */
    const settle = (x: number, y: number) => {
      const s = session.current;
      if (!s) return;
      const hit = resolveDrop(x, y, s.candidates, axis);
      // 只在落点真的变了时才 setState：pointermove 一秒能来上百次
      const same =
        (hit === null && overRef.current === null) ||
        (hit !== null &&
          overRef.current !== null &&
          hit.kind === overRef.current.kind &&
          hit.id === overRef.current.id &&
          (hit.kind !== "item" ||
            overRef.current.kind !== "item" ||
            hit.before === overRef.current.before));
      if (!same) {
        overRef.current = hit;
        setOver(hit);
      }
    };

    /**
     * 拖拽期间列表被滚动时**必须重新采集矩形**。
     *
     * 矩形只在拖拽开始时缓存一次（每帧对所有卡片调 `getBoundingClientRect`
     * 会强制同步布局）。但"拖拽期间布局不会变"这个前提**不成立** ——
     * 按住鼠标拖的同时滚轮照样能用，用户完全可以一边拖一边滚列表。
     * 那时卡片已经移走了、缓存的矩形还停在原位，表现为"松手插到了别处"。
     *
     * 滚动事件**不冒泡**，所以要挂在捕获阶段。
     */
    const onScroll = () => {
      const s = session.current;
      if (!s || !s.active) return;
      s.candidates = collect(s.kind);
      // 滚动之后指针没动，但落点可能已经变了 —— 得按最后的位置重判一次，
      // 否则用户"滚到目标位置再松手"时用的还是旧落点
      settle(s.lastX, s.lastY);
    };

    const onMove = (e: PointerEvent) => {
      const s = session.current;
      if (!s) return;
      s.lastX = e.clientX;
      s.lastY = e.clientY;

      if (!s.active) {
        // 没越过阈值就什么都不做：一次普通点击也会走 pointerdown/up，
        // 不加这道闸门的话，轻轻一点就会被当成拖拽
        if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD) return;

        s.active = true;
        setDraggingId(s.id);
        // 拖拽期间布局本身不会变，矩形缓存一次就够——
        // 每帧对所有卡片调 getBoundingClientRect 会强制同步布局，很浪费。
        // 但**滚动会让它失效**，所以同时挂上滚动监听（见 onScroll）。
        s.candidates = collect(s.kind);
        document.addEventListener("scroll", onScroll, true);
      }

      setPointer({ x: e.clientX, y: e.clientY });
      settle(e.clientX, e.clientY);
    };

    const onUp = () => {
      const s = session.current;
      if (!s) return;

      if (s.active) {
        // 这一轮是拖拽，不是点击：吞掉紧随其后的 click
        swallowClick.current = true;
        const spot = overRef.current;
        if (spot) dropRef.current(s.id, s.kind, spot);
      }
      document.removeEventListener("scroll", onScroll, true);
      reset();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    // 系统级打断（例如触摸被系统接管）也要复位，否则会永远停在"正在拖"的状态
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [axis, reset]);

  const onPointerDownFor = useCallback(
    (id: string, kind: "item" | "folder") => (e: ReactPointerEvent) => {
      // 只处理主键：右键和中键有自己的用途（右键是原生菜单）
      if (e.button !== 0) return;

      const el = e.target as HTMLElement | null;

      // 上一次拖拽留下的「吞点击」标志只对**紧接着那一次** click 有效。
      //
      // 为什么必须在这里清掉：`click` 的派发目标是 mousedown 与 mouseup 目标的
      // **最近公共祖先**。拖拽把卡片拖到别处松手时，公共祖先通常是网格容器而不是
      // 卡片本身 —— 于是没有任何卡片会去消费这个标志，它就留到了下一次交互，
      // 把用户**下一次正常点击链接**吞掉（表现为"拖过一次之后，第一次点链接没反应"）。
      // 每次按下都先清掉，它就不可能跨交互存活。
      swallowClick.current = false;

      // 命中控件就默认不拖（点了就是点了），例外收窄到显式抓手。
      // 判定本身抽在 canStartDrag 里，有单测（这个例外原来写宽了，踩过坑）。
      // 两个来源都要看：
      //   1. 页面自己给的 `ignoreSelector`（链接页用它排除那排悬停操作按钮）
      //   2. **内置的控件底线**（见 CONTROL_SELECTOR 的说明）
      const onControl =
        el?.closest?.(ignoreSelector) != null ||
        el?.closest?.(CONTROL_SELECTOR) != null;
      const onDragHandle = el?.closest?.(`[${DRAG_HANDLE_ATTR}]`) != null;
      if (!canStartDrag(onControl, onDragHandle)) return;

      session.current = {
        id,
        kind,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        candidates: [],
        lastX: e.clientX,
        lastY: e.clientY,
      };
    },
    [ignoreSelector],
  );

  const handleProps = useCallback(
    (id: string, kind: "item" | "folder" = "item") => ({
      onPointerDown: onPointerDownFor(id, kind),
    }),
    [onPointerDownFor],
  );

  const itemProps = useCallback(
    (id: string): DragItemProps => ({
      onPointerDown: onPointerDownFor(id, "item"),
      [DROP_ITEM_ATTR]: id,
    }),
    [onPointerDownFor],
  );

  const overClass = useCallback(
    (id: string) => {
      if (over?.kind !== "item" || over.id !== id) return "";
      const edge = axis === "vertical" ? "" : "-x";
      return over.before ? `drag-over-before${edge}` : `drag-over-after${edge}`;
    },
    [over, axis],
  );

  const consumeClick = useCallback(() => {
    if (!swallowClick.current) return false;
    swallowClick.current = false;
    return true;
  }, []);

  // 拖拽期间给 body 加个标记，让整页换成抓取光标（样式见 drag-drop.css）：
  // 没有这个反馈的话，用户不确定"我现在是在拖东西还是只是按着鼠标"
  useEffect(() => {
    if (!draggingId) return;
    document.body.classList.add("dragging");
    return () => document.body.classList.remove("dragging");
  }, [draggingId]);

  return { draggingId, over, pointer, itemProps, handleProps, overClass, consumeClick };
}
