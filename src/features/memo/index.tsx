/**
 * 备忘录功能。
 *
 * 解决的问题：一天里零零碎碎记下的东西（今天干了什么、临时冒出来的想法、
 * 下周要交的材料），需要一个「按天翻」的地方，而且其中一部分还得在将来某个
 * 时刻把自己叫起来。
 *
 * 核心设计决策：
 *
 * 1. **形态是日记，不是待办清单**。选一天，只看那天的笔记。
 *    按日期归集的好处是回顾成本低：翻到某天就知道那天记了什么，
 *    不需要维护「已完成 / 未完成」这种会腐烂的状态。
 *
 * 2. **「记录日期」和「提醒时间」是两个完全独立的字段**。
 *    这是本功能最容易被误解的地方，所以界面上反复强调：
 *    `date` 决定这条笔记出现在日记的哪一页，`remindAt` 决定它什么时候弹窗。
 *    于是「今天写一条『9 月 25 日交材料』」是自然可表达的——
 *    它留在今天那一页（将来回顾时你知道这事是什么时候想起来的），
 *    但到 9 月 25 日才提醒。
 *
 * 3. **重复提醒的推进由前端负责**。Rust 侧到点只做两件事：弹窗、
 *    把 `firedFor` 记成这一次的 `remindAt`（幂等，防止重复弹）。
 *    它不会去算「下一次是什么时候」——日期计算全部放在前端，
 *    因为 JS 的 `Date` 原生按本地时区工作，夏令时也能正确处理（见 lib/datetime.ts）。
 *    所以前端在收到提醒事件后必须自己把 `remindAt` 推到下一次，
 *    否则重复提醒只会响一次。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bell,
  BellOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Image as ImageIcon,
  NotebookPen,
  Pencil,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";

import { api, newId, onStateChanged, type Memo, type Repeat } from "../../lib/api";
import {
  scrollIntoViewSoon,
  useContextMenu,
  useFocusHighlight,
  useTextAreaMenu,
  type ContextMenuItem,
  type UseContextMenuResult,
} from "../../lib/context-menu";
import {
  REPEAT_OPTIONS,
  combineLocalSkippingGap,
  dateKey,
  firstOccurrence,
  formatDateHuman,
  formatMoment,
  formatUntil,
  splitLocal,
  todayKey,
} from "../../lib/datetime";
import { useEscapeToClose } from "../../lib/escape";
import { dateToSelect, focusDomId, highlightFrom, isHighlighted } from "../../lib/focus-highlight";
import { orphanedByItemRemoval, referencedImageIds, referencedImageIdsExcluding } from "../../lib/media";
import {
  MediaSection,
  batchNotice,
  useMediaAttachments,
  useMediaLibrary,
  type MediaLibraryApi,
} from "../../lib/media-ui";
import { usePendingFocus } from "../../lib/navigation";
import { advanceRepeats } from "../../lib/repeat-advance";
import { useZoom } from "../../lib/zoom";
import type { FeatureModule } from "../registry";

import { DatePicker } from "./Calendar";

import "./memo.css";

/**
 * 定位高亮用的 DOM id 前缀。和其它页签取不同的前缀，
 * 保证同一个 id 同时出现在两个页面上时不会找错人。
 */
const FOCUS_DOM_PREFIX = "memo-focus";
/**
 * 空备忘工厂。`date` 由调用方给定：新建时默认落在当前翻到的那一天。
 *
 * `images: []` **必须显式写**：`Memo` 是 Rust 侧的结构体，而 `memo_save`
 * 是**整条覆盖写** —— 前端漏掉这个字段等于把这条备忘的图片全删了。
 * 所以它在 TS 里是必填字段（不是可选），漏写在编译期就被拦住。
 * 对照 `Snippet.images`：那个是可选，因为片段是前端自己拥有的类型、
 * 老数据里没有这一项，所以读的时候要写 `s.images ?? []`。
 */
function emptyMemo(date: string): Memo {
  const now = Date.now();
  return {
    id: newId(),
    date,
    title: "",
    body: "",
    tags: [],
    remindAt: null,
    repeat: "none",
    firedFor: null,
    images: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 在日期键上加减天数。 */
function shiftDateKey(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // 用 (y, m-1, d) 构造并 setDate：JS 会自动处理跨月、跨年和闰年，
  // 比自己算天数省事且不会算错。
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * 同一天内的排序：有提醒的按提醒时刻升序排前面，没提醒的按创建时间排后面。
 *
 * 这样一眼能看出「今天还有什么会被叫醒」，而纯记录的笔记不抢视线。
 */
function sortMemos(list: Memo[]): Memo[] {
  return [...list].sort((a, b) => {
    if (a.remindAt !== null && b.remindAt !== null) return a.remindAt - b.remindAt;
    if (a.remindAt !== null) return -1;
    if (b.remindAt !== null) return 1;
    return a.createdAt - b.createdAt;
  });
}

/** 把正文压成一行摘要用于列表展示。 */
function summarize(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 截断过长文本用于提示（和片段页同一个做法）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 重复规则的中文名，用于卡片上显示提醒状态。 */
function repeatLabel(repeat: Repeat): string {
  return REPEAT_OPTIONS.find((o) => o.value === repeat)?.label ?? "不重复";
}

export function MemoPanel() {
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 当前翻到哪一天。决定列表里显示哪些笔记。 */
  const [selected, setSelected] = useState(() => todayKey());
  const [editing, setEditing] = useState<Memo | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  /**
   * 定时重渲染，让界面跟着时间走。
   *
   * `formatUntil()`（卡片上的「还有 N 分钟」）和 `todayKey()`（今天/昨天）都是
   * **渲染期求值**的，没有重渲染来源就会冻住：卡片上一直写着"还有 5 分钟"，
   * 跨午夜后昨天仍标着"今天"、「回到今天」按钮也一直是禁用状态。
   * 而主面板是"隐藏不销毁"的（`lib.rs` 只对面板做 prevent_close），
   * 所以重新打开也不会重算 —— 必须有个心跳。
   *
   * 30 秒够用：文案最细的粒度是分钟。定时器页用 100ms 是因为它要显示秒。
   */
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * 列表密度缩放（Ctrl + 滚轮）。
   *
   * 备忘不做文件夹：它的组织维度是日期，再叠一层分类只会让
   * 「今天记了什么」变难找。所以这里只有缩放。
   */
  const zoom = useZoom("memo");

  /** 右键菜单。 */
  const ctx = useContextMenu();
  /** 定位高亮：短暂 + 一交互就灭，见 lib/context-menu.tsx 的 useFocusHighlight。 */
  const focus = useFocusHighlight();
  const { target: pending, done: focusDone } = usePendingFocus("memo");

  /**
   * 提示条上的一个图标：成功是对勾，警告是三角。
   *
   * `kind === "warn"` 用在"操作没成功 / 有东西没了"这类**必须读完**的提示上
   * （读剪贴板失败、剪切失败）。它和"已保存"共用同一条通道会让用户
   * 以为成功了，所以用不同的图标区分开。
   */
  const [noticeKind, setNoticeKind] = useState<"ok" | "warn">("ok");

  /**
   * 右键菜单里那些"顺手做一下"的结果提示。
   *
   * 和 `feedback` 共用一条状态（一次只显示一条），但要能区分图标 ——
   * 所以多一个 `noticeKind`。分开存两份会同时出现两条提示，反而更乱。
   */
  const notice = (text: string, kind: "ok" | "warn") => {
    setNoticeKind(kind);
    setFeedback(text);
  };

  // ---- 图片 ----

  /**
   * 拖放进来的路径要交给谁。
   *
   * 用一个 ref 存"当前的处理者"：编辑器开着时它注册自己（图片进那一条），
   * 没开着时走下面的兜底（新建一条）。**订阅只有一个**（在 `useMediaLibrary` 里），
   * 页面和编辑器各订阅一份的话一次拖放会导入两遍。
   */
  const dropHandlerRef = useRef<(paths: string[]) => void>(() => {});
  /** 页面级的媒体库：导入机制 + 占用统计 + 拖放订阅。 */
  const library = useMediaLibrary((paths) => dropHandlerRef.current(paths));
  /** 编辑器挂载时把自己注册成拖放目标。 */
  const dropTargetRef = useRef<((paths: string[]) => void) | null>(null);
  const registerDrop = (handler: ((paths: string[]) => void) | null) => {
    dropTargetRef.current = handler;
  };

  /**
   * 编辑器**没开着**时拖进来：新建一条只装这些图片的备忘，并打开它的编辑器。
   *
   * # 为什么不是"什么都不做，提示用户先新建一条"
   *
   * 「把图片拖进这个页面」这个手势的意思就是"把这张图存下来"。不新建的话
   * 用户拖完什么都看不到，只能自己猜到要先点「记一条」—— 那是把软件的
   * 内部结构（图片必须挂在某一条上）转嫁给用户。
   *
   * ⚠️ 备忘页**不会自动保存**（它是显式「保存」的，与笔记页的自动保存不同），
   * 所以这里只是把编辑器打开并预填好图片，用户仍然要按一次「保存」。
   * 这个差异是两页原有的设计差异，不去抹平。
   */
  const createMemoFromDrop = async (paths: readonly string[]) => {
    const batch = await library.importPaths(paths);
    const result = batchNotice(batch, {
      // 新条目还没有图片；已有的引用都算"别处也在用"
      inItem: [],
      elsewhere: referencedImageIdsExcluding(memos, ""),
    });
    if (result.text) notice(result.text, result.kind);
    if (result.added.length === 0) return;
    setEditing({ ...emptyMemo(selected), images: result.added });
  };

  // 每次渲染后刷新"当前拖放处理者"。放进 effect 而不是渲染期直接赋值：
  // 渲染期改 ref 在 StrictMode 的双渲染下会跑两次，虽然这里无害，
  // 但那是"看起来能用、以后被改坏"的写法。
  useEffect(() => {
    dropHandlerRef.current = (paths) => {
      if (dropTargetRef.current) {
        dropTargetRef.current(paths);
        return;
      }
      void createMemoFromDrop(paths);
    };
  });

  /**
   * 推进已经弹过窗的重复提醒，并把改动并回本地列表。
   *
   * 真正的逻辑在 `lib/repeat-advance.ts` —— 它必须也能在**备忘页没挂载**时跑，
   * 否则默认页签是「文本片段」的用户会永远收不到第二次重复提醒。
   * 这里只负责把结果合并进界面状态。
   */
  const advance = async (list: Memo[]) => {
    const { saved } = await advanceRepeats(list, setError);
    if (saved.length === 0) return;
    // 只改动被推进的那几条，不整表覆盖：用户在推进期间新加的笔记不能丢。
    setMemos((prev) => prev.map((m) => saved.find((s) => s.id === m.id) ?? m));
  };

  /** 拉取全量笔记。这个数据量（几千条以内）整表拉取最简单也最不容易出状态不一致。 */
  const load = async () => {
    try {
      const list = await api.memosList();
      setMemos(list);
      setError(null);
      return list;
    } catch (err) {
      setError(String(err));
      return [] as Memo[];
    } finally {
      setLoading(false);
    }
  };

  // 首次加载 + 订阅后端状态变化。
  // Rust 到点弹窗后会广播 `["memos"]`，我们必须重新拉取并推进重复提醒。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const list = await load();
      if (!disposed) await advance(list);

      // onStateChanged 返回 Promise<UnlistenFn>，卸载时一定要调用它，
      // 否则面板被销毁后回调仍会触发，对着已卸载组件 setState。
      unlisten = await onStateChanged((what) => {
        if (disposed || !what.includes("memos")) return;
        void (async () => {
          const fresh = await load();
          if (!disposed) await advance(fresh);
        })();
      });
      // 订阅建立之前组件就卸载了的极端情况：立刻退订
      if (disposed) unlisten();
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 反馈提示自动消失。警告留久一点 —— 它讲的是"东西没了 / 没成功"，需要读完。
  useEffect(() => {
    if (!feedback) return;
    const ttl = noticeKind === "warn" ? 8000 : 2400;
    const t = window.setTimeout(() => setFeedback(null), ttl);
    return () => window.clearTimeout(t);
  }, [feedback, noticeKind]);

  /** 当天要显示的笔记，已排好序。 */
  const visible = useMemo(
    () => sortMemos(memos.filter((m) => m.date === selected)),
    [memos, selected],
  );

  /** 全部笔记里挂着提醒的条数，用来提示用户「提醒不只在这一页」。 */
  const reminderCount = useMemo(
    () => memos.filter((m) => m.remindAt !== null).length,
    [memos],
  );

  /**
   * 删掉一批**已经确认没人引用**的图片文件。
   *
   * 失败一律吞掉：这些都是"清理残留"，报错会让用户以为刚才那步操作失败了。
   * 留下的孤儿文件看不见、不影响使用，比一个假的失败提示好得多。
   */
  const cleanOrphanFiles = async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => api.mediaDelete(id).catch(() => undefined)));
    library.refreshStats();
  };

  const save = async (draft: Memo) => {
    const cleaned: Memo = {
      ...draft,
      // 标题留空时用正文开头顶上，列表里至少有个可辨认的名字
      title: draft.title.trim() || summarize(draft.body, 24) || "无标题",
      body: draft.body.trim(),
      updatedAt: Date.now(),
    };
    // 保存**之前**这条备忘在盘上是什么样：保存后要拿它和新版本比，
    // 找出"这次被移掉、而且别人也没引用"的图片
    const before = memos.find((m) => m.id === draft.id)?.images ?? [];
    try {
      await api.memoSave(cleaned);
      // 保存后直接切到它被记下的那一天，否则用户会以为保存失败了
      setSelected(cleaned.date);
      const fresh = await load();
      setEditing(null);
      setFeedback("已保存");

      /**
       * 清理这次被移掉的图片。
       *
       * ⚠️ 这里**不能**用 `orphanedImageIds`：那个函数的语义是"这些 id 正在
       * 从某个条目里被移除"，它会把来源条目自身的引用排除掉 —— 而我们
       * 要问的是"**保存后的整份数据**里还有没有人引用它"。
       * 用错的话会把别的备忘还在用的图删掉。
       */
      const removed = before
        .filter((old) => !cleaned.images.some((now) => now.id === old.id))
        .map((old) => old.id);
      if (removed.length > 0) {
        const referenced = referencedImageIds(fresh);
        await cleanOrphanFiles(removed.filter((id) => !referenced.has(id)));
      }
    } catch (err) {
      // ⚠️ 这里**必须**同时给一条用户看得见的提示。
      //
      // 原来只 `setError`，而错误条渲染在列表那棵树里，编辑器分支是整棵换掉的 ——
      // 用户看到的是"点了保存毫无反应，表单还开着"，一个字都没有。
      // 提示走 `feedback`（编辑器里也渲染），`error` 留给列表。
      setError(String(err));
      setFeedback(`保存失败：${String(err)}`);
    }
  };

  /**
   * 放弃这次编辑。
   *
   * # 为什么必须在这里清图片
   *
   * 草稿里新导入的图片**已经落在磁盘上了**（导入是立即落盘的），而这条备忘
   * 从没保存过 —— 数据里没有它，也就没有任何引用。不清理的话，用户每按一次
   * 「取消」，`media/` 里就多一份永远看不见、也删不掉的文件。
   *
   * ⚠️ 判据必须是"**整份数据**里还有没有人引用"（`referencedImageIds`），
   * **不能**用 `orphanedImageIds`：那个函数会把"来源条目"自己的引用排除掉，
   * 而来源条目在盘上**根本没变**（这次编辑取消了）—— 用它会把这条备忘
   * 本来就有的图片当成孤儿删掉，用户下次打开就看见裂图。
   */
  const cancelEdit = () => {
    const draft = editing;
    setEditing(null);
    if (!draft || draft.images.length === 0) return;
    const referenced = referencedImageIds(memos);
    void cleanOrphanFiles(
      draft.images.filter((image) => !referenced.has(image.id)).map((image) => image.id),
    );
  };

  /**
   * 删除一条备忘，并顺手清理**没人再引用**的图片文件。
   *
   * 顺序很重要：先算出孤儿、再删条目、最后删图片。反过来（先删条目）
   * 也**能**算对（`orphanedByItemRemoval` 允许条目已经不在列表里），
   * 但那时列表已经变了，出问题时更难对上。
   *
   * 图片清理失败**不该**让整次删除报错：备忘已经删掉了，报错会让用户
   * 以为没删成功，然后再删一次。所以单独 catch，只记一条提示。
   */
  const remove = async (id: string) => {
    try {
      // 导入按内容 sha256 去重，同一张图被几条备忘引用是正常的 ——
      // 只有一条都不剩时才能删磁盘文件
      const orphans = orphanedByItemRemoval(memos, id);
      await api.memoRemove(id);
      setMemos((prev) => prev.filter((m) => m.id !== id));
      setFeedback("已删除");
      if (orphans.length > 0) await cleanOrphanFiles(orphans);
    } catch (err) {
      setError(String(err));
      setFeedback(`删除失败：${String(err)}`);
    }
  };

  /**
   * 把一条备忘的正文打到用户刚才用的外部窗口。
   *
   * 为什么可以"打整条"：备忘的正文本来就是用户自己随手记的一段话
   * （"下周要交的材料清单"），整条发出去是他要的效果。
   * 计时器页就没有这个动作 —— 计时器的"内容"是个时间，打出去没有意义。
   *
   * 不复用 `save` 那条路径，也不动数据：这是"用一下这条内容"，
   * 不是"改这条内容"。
   */
  const typeInto = async (text: string) => {
    if (!text.trim()) {
      notice("这条备忘没有正文可键入", "warn");
      return;
    }
    const outcome = await api.pasteText(text);
    if (outcome.ok) {
      const base = outcome.target
        ? `已键入到「${truncate(outcome.target, 18)}」`
        : "已键入到光标处";
      // 成功时也可能带回一条必须看到的警告（剪贴板原文已被替换），
      // 和片段页的处理保持一致
      notice(
        outcome.message ? `${base}；${outcome.message}` : base,
        outcome.message ? "warn" : "ok",
      );
      return;
    }
    notice(outcome.message ?? "已复制到剪贴板，请手动 Ctrl+V", "warn");
  };

  /** 只复制，不粘贴。 */
  const copyOnly = async (text: string) => {
    if (!text.trim()) {
      notice("这条备忘没有正文可复制", "warn");
      return;
    }
    const ok = await api.copyText(text);
    notice(ok ? "已复制到剪贴板" : "复制失败，剪贴板可能被占用", ok ? "ok" : "warn");
  };

  /**
   * 一条备忘在右键菜单里的动作。
   *
   * 备忘没有「移动到文件夹」（它不做文件夹，组织维度是日期），
   * 也没有「复制正文」以外的复制对象 —— 所以菜单比片段页短，
   * 这是对的：**只列真的能做的事**。
   */
  const memoMenu = (m: Memo): ContextMenuItem[] => {
    // 正文为空时只发标题：让「键入到当前光标」永远有东西可发，
    // 而不是弹一个点了没反应的菜单项
    const payload = m.body.trim() || m.title;
    return [
      {
        id: "type",
        label: "键入到当前光标",
        icon: <Send size={13} />,
        onSelect: () => void typeInto(payload),
      },
      {
        id: "copy",
        label: "复制",
        icon: <Copy size={13} />,
        hint: "Ctrl+C",
        onSelect: () => void copyOnly(payload),
      },
      {
        id: "edit",
        label: "编辑",
        icon: <Pencil size={13} />,
        dividerBefore: true,
        onSelect: () => setEditing(m),
      },
      {
        id: "delete",
        label: "删除",
        icon: <Trash2 size={13} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => void remove(m.id),
      },
    ];
  };

  /**
   * 收到搜索定位请求：切到那一天 → 滚到可见 → 高亮 →（需要时）打开编辑器。
   *
   * # 这就是用户报的「搜到备忘回车没反应」的根因修复
   *
   * 原来备忘页**没有任何接收外部定位的入参**，`selected` 是本地 state、
   * 默认「今天」（见下面的 `useState(() => todayKey())`）。于是命令面板里
   * 回车只会切到备忘页，而页面还停在今天 —— 命中的那条如果记在别的日子，
   * 它根本不在列表里，用户看到的是"跳过来了，但什么都没有"。
   *
   * # 为什么这个 effect 放在 `remove` / `typeInto` 之后
   *
   * 它要调用 `setEditing` 之外的东西吗？不用 —— 但放在这里是因为
   * 它读 `pending`，而 `pending` 来自上面那几行 hook。位置只影响可读性，
   * 不影响 TDZ（这里用到的都是已经初始化的 `setState`）。
   *
   * `memos` / `selected` 刻意不进依赖：它们是每次渲染都变的新值/新数组，
   * 进来会让 effect 在 `done()` 之后又跑一遍。
   *
   * # ⚠️ 为什么必须等 `loading` 结束（这是用户报的那个 bug 的另一半）
   *
   * 从**别的页签**按回车跳过来时，本页是**刚挂载**的：`memos` 初值是 `[]`，
   * 数据还在异步路上。这时：
   * - 日期切了、高亮也设了，但**列表是空的**；
   * - `pending.open` 时 `memos.find(...)` 拿到 `undefined`，**编辑器打不开**；
   * - 紧接着 `focusDone()` 把这次请求**消费掉**了 —— 请求没了，数据回来也不会再跑。
   *
   * 症状和用户报的「搜到备忘回车没反应」**一模一样**。所以守卫必须在
   * `done()` 之前，而且 `loading` 必须进依赖 —— 只加守卫不加依赖的话，
   * 数据回来时 effect 永远不会再跑，等于换了个方式继续坏。
   *
   * 这与片段页等 `folders.loading` 是同一个道理：**定位请求必须等这一页的
   * 数据就绪再消费**，否则消费掉的是一次"拿不到目标"的请求。
   */
  useEffect(() => {
    if (!pending) return;
    if (loading) return;

    const date = dateToSelect(pending);
    if (date) setSelected(date);

    focus.show(highlightFrom(pending));
    scrollIntoViewSoon(focusDomId(FOCUS_DOM_PREFIX, pending.id));

    if (pending.open) {
      const found = memos.find((m) => m.id === pending.id);
      if (found) setEditing(found);
    }

    focusDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, loading]);

  /**
   * 提示条 + 读写异常条。
   *
   * 抽出来是因为**编辑器分支也要渲染它们**：这两条原来只在列表那棵树里，
   * 而 `if (editing) return <MemoEditor/>` 会整棵换掉 —— 保存失败时
   * 用户一个字都看不到。
   */
  const notices = (
    <>
      {feedback && (
        <div
          className={`memo__feedback${
            noticeKind === "warn" ? " memo__feedback--warn" : ""
          }`}
        >
          {/* 警告用三角而不是对勾：右键菜单里的「剪切失败」「读不到剪贴板」
              都是**没成功**，挂一个对勾会让用户以为做成了 */}
          {noticeKind === "warn" ? <TriangleAlert size={13} /> : <Check size={13} />}
          {feedback}
        </div>
      )}
      {error && <div className="memo__error">数据读写异常：{error}</div>}
    </>
  );

  if (editing) {
    return (
      <div className="memo">
        {notices}
        <MemoEditor
          draft={editing}
          onCancel={cancelEdit}
          onSave={(m) => void save(m)}
          onTypeInto={typeInto}
          onNotice={notice}
          contextMenu={ctx}
          library={library}
          registerDrop={registerDrop}
          allItems={() => memos}
        />
        {ctx.menu}
      </div>
    );
  }

  const isToday = selected === todayKey();

  return (
    <div
      className="memo"
      // 滚轮监听挂在整页根节点上：鼠标停在日期条、日历上时也该能缩放。
      // 普通滚轮不受影响（见 lib/zoom.ts）。
      ref={zoom.ref}
      style={{ "--density": String(zoom.percent / 100) } as CSSProperties}
    >
      {/* 日期条：整个功能的主入口，「翻日记」这个动作就靠它 */}
      <div className="memo__daybar">
        <button
          className="iconbtn"
          onClick={() => setSelected((d) => shiftDateKey(d, -1))}
          title="前一天"
        >
          <ChevronLeft size={15} />
        </button>

        <div className="memo__day">
          <span className="memo__dayname">{formatDateHuman(selected)}</span>
          {/* 相对说法（今天/昨天）会盖住具体日期，两个都给出来 */}
          <span className="memo__daykey">{selected}</span>
        </div>

        <button
          className="iconbtn"
          onClick={() => setSelected((d) => shiftDateKey(d, 1))}
          title="后一天"
        >
          <ChevronRight size={15} />
        </button>

        <button
          className="btn memo__today"
          onClick={() => setSelected(todayKey())}
          disabled={isToday}
          title={isToday ? "已经在今天了" : "跳回今天"}
        >
          <Undo2 size={12} />
          回到今天
        </button>
      </div>

      {/* 直接跳日期。弹层是自绘的，为什么不用原生 date 控件见 Calendar.tsx */}
      <div className="memo__jump">
        <DatePicker value={selected} onChange={setSelected} />
        <span className="memo__count">这一天 {visible.length} 条</span>
      </div>

      <div className="memo__toolbar">
        <span className="memo__hint">
          {/* ⚠️ 用词是「备忘」不是「笔记」：页签「文本」已经改名成「笔记」，
              两个页签都自称「笔记」的话用户分不清在说哪一边 */}
          {memos.length === 0
            ? "还没有任何备忘"
            : `共 ${memos.length} 条备忘 · ${reminderCount} 条挂了提醒`}
        </span>
        <button className="btn btn--primary" onClick={() => setEditing(emptyMemo(selected))}>
          <Plus size={13} />
          记一条
        </button>
      </div>

      {notices}

      <div className="memo__list">
        {loading && <div className="memo__empty">正在读取数据…</div>}

        {!loading && visible.length === 0 && (
          <div className="memo__empty">
            {memos.length === 0 ? (
              <>
                {formatDateHuman(selected)}还没有备忘。
                <br />
                点右上角「记一条」。提醒时间是独立的，所以可以今天先记下
                <br />
                下周要做的事，到时候它自己会来叫你。
              </>
            ) : (
              <>
                {formatDateHuman(selected)}没有备忘。
                <br />
                其他日期里还有 {memos.length} 条。
              </>
            )}
          </div>
        )}

        {visible.map((m) => (
          <article
            key={m.id}
            id={focusDomId(FOCUS_DOM_PREFIX, m.id)}
            className={`memo__card${
              isHighlighted(focus.highlight, m.id) ? " memo__card--focus" : ""
            }`}
            // 右键：和这一条有关的动作（键入到光标 / 复制 / 编辑 / 删除）
            onContextMenu={(e) => ctx.open(e, () => memoMenu(m))}
          >
            <div className="memo__cardhead">
              <span className="memo__title">{m.title}</span>
              {m.tags.map((t) => (
                <span key={t} className="memo__tag">
                  {t}
                </span>
              ))}
              {/* 列表行只给一个**数量标记**，不塞缩略图：卡片只有几十像素高，
                  放一张图会把"一眼扫十条"变成"一眼看两条"。 */}
              {m.images.length > 0 && (
                <span className="media__marker" title={`${m.images.length} 张图片`}>
                  <ImageIcon size={10} />
                  {m.images.length}
                </span>
              )}
            </div>

            {m.body && <div className="memo__body">{summarize(m.body)}</div>}

            {/* 提醒区。时刻本身是绝对时间戳，但用户关心的是「什么时候叫我」，
                所以主要显示相对说法，绝对时刻作为补充。 */}
            {m.remindAt !== null ? (
              <div className="memo__remind">
                <Bell size={12} className="memo__bell" />
                <span className="memo__when">{formatUntil(m.remindAt)}</span>
                <span className="memo__at">{formatMoment(m.remindAt)}</span>
                {m.repeat !== "none" && (
                  <span className="memo__repeat">{repeatLabel(m.repeat)}</span>
                )}
              </div>
            ) : (
              <div className="memo__remind memo__remind--off">
                <BellOff size={12} />
                <span>没有提醒</span>
              </div>
            )}

            <div className="memo__actions">
              {/* 记录日期也放在卡片上明说：用户容易把它和提醒日期搞混 */}
              <span className="memo__recorded">记于 {m.date}</span>
              <button className="iconbtn" onClick={() => setEditing(m)} title="编辑">
                <Pencil size={13} />
              </button>
              <button
                className="iconbtn iconbtn--danger"
                onClick={() => void remove(m.id)}
                title="删除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </article>
        ))}
      </div>

      {/* 右键菜单。`position: fixed` 的独立浮层，只有一份 */}
      {ctx.menu}
    </div>
  );
}

/** 新建 / 编辑界面。 */
function MemoEditor({
  draft,
  onSave,
  onCancel,
  onTypeInto,
  onNotice,
  contextMenu,
  library,
  registerDrop,
  allItems,
}: {
  draft: Memo;
  onSave: (m: Memo) => void;
  onCancel: () => void;
  /** 「键入到当前光标」：把选中的那段文字打到外部窗口。 */
  onTypeInto: (text: string) => void;
  /** 右键菜单里那些"顺手做一下"的结果提示。 */
  onNotice: (text: string, kind: "ok" | "warn") => void;
  /** 上层已经建好的右键菜单实例（一份就够）。 */
  contextMenu: UseContextMenuResult;
  /** 页面级媒体库（导入机制 + 占用统计 + 拖放订阅）。 */
  library: MediaLibraryApi;
  /** 把本编辑器注册成拖放目标（页面级订阅只有一个）。 */
  registerDrop: (handler: ((paths: string[]) => void) | null) => void;
  /** 全部备忘的图片引用，用来判"这张图还有没有别人在用"。 */
  allItems: () => readonly Memo[];
}) {
  const [form, setForm] = useState<Memo>(draft);

  /**
   * Esc 只关这一层：填到一半按 Esc 应该是「退出编辑」，
   * 不是「把整个面板收起来」。
   *
   * ⚠️ 浮层（大图预览 / 右键菜单）开着时**不认领** Esc —— 这条在备忘页
   * 后果最严重：这里的 `onCancel` 是 `cancelEdit`，它会**丢弃草稿**、
   * 并**删掉这次编辑期间刚导入的图片文件**（那是"取消"该有的语义）。
   * 于是"菜单开着顺手按个 Esc"的真实后果是**"你刚拖进来的那张图没了"**。
   *
   * 第二个参数交给 `useEscapeToClose`，它会**先判认领、再决定拦不拦传播** ——
   * 不认领时既不 `stopPropagation` 也不回调，`onCancel` 根本不会被调用，
   * 事件原样走到菜单那一层，由菜单自己关掉自己。详见 `lib/escape.ts`。
   */
  useEscapeToClose(
    onCancel,
    () => !media.blocksEscapeNow(),
  );
  const [tagInput, setTagInput] = useState(draft.tags.join(", "));

  /**
   * 图片附件：三路导入（按钮 / 拖放 / Ctrl+V）+ 网格 + 大图 + 图片右键菜单。
   *
   * `images` 传函数而不是值：导入 / 删除之后要拿到**最新**的那一份列表，
   * 而这个 hook 的各个回调（右键菜单项）是稳定的，读值会在闭包里过期。
   */
  const media = useMediaAttachments({
    images: () => form.images,
    onChange: (next) => patch({ images: next }),
    itemId: form.id,
    allItems,
    onNotice,
    contextMenu,
    library,
    // ⚠️ 备忘是**显式保存**的：草稿里删掉一张图之后按「取消」，
    // 数据里那条备忘**还引用着这张图**。所以"盘上那份"就是撤销路径 ——
    // 移除时先看它，图还在盘上那份里就留着文件（取消之后还要用）。
    // 保存时再统一清理（见下面 `save` 里的 removed 计算）。
    undoImages: () => allItems().find((m) => m.id === form.id)?.images ?? [],
  });

  /** 有图片时正文框才让位（见 media.css 顶部那段说明）。 */
  const hasImages = form.images.length > 0;

  /**
   * 正文区的右键菜单：键入到光标 / 复制 / 剪切 / 粘贴 / 全选。
   * 和片段页共用同一套实现（`lib/context-menu.tsx` 的 `useTextAreaMenu`），
   * 免得两边各写一份、各自漂移。
   */
  const area = useTextAreaMenu(contextMenu, {
    onTypeInto,
    onNotice,
    copyText: api.copyText,
  });

  // 提醒拆成「日期 + 时间」两个输入框，所以这里保留字符串形态的草稿。
  // 直接绑 remindAt 的话，用户每改一次日期框都会先经过一个空值状态，
  // 那个中间态会把已经填好的另一半冲掉。
  const initial = draft.remindAt !== null ? splitLocal(draft.remindAt) : null;
  const [remindDate, setRemindDate] = useState(initial?.date ?? "");
  const [remindTime, setRemindTime] = useState(initial?.time ?? "09:00");
  const [repeat, setRepeat] = useState<Repeat>(draft.repeat);

  /**
   * 让提醒预览跟着时间走。
   *
   * `firstOccurrence` 内部用 `Date.now()`，所以预览是**有时效**的：
   * 编辑器开着跨过所填时刻之后，"将在 今天 HH:MM"就变成了错的
   * （保存时 `submit` 会重新取值，实际排到明天）。`useMemo` 必须有个随时间
   * 变化的依赖，否则这段缓存会把错误结论一直显示下去 ——
   * 而预览存在的唯一目的就是"在保存之前把这件事告诉用户"。
   */
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * 提醒预览：**算一次就够，别放在渲染里现算**。
   *
   * `firstOccurrence` 在"提醒日期是很久以前"时要跑满两万次循环，实测
   * **56–96ms**（工作日规则最慢，见它的说明）。原来这段写在 JSX 的立即执行
   * 函数里，于是**在正文 / 标题 / 标签里每敲一个字都要重付一次** —— 输入明显卡顿。
   */
  const preview = useMemo(() => {
    const wanted = combineLocalSkippingGap(remindDate, remindTime || "09:00");
    const actual = firstOccurrence(wanted, repeat);
    return {
      actual,
      moved: actual !== wanted,
      /**
       * 算出来的时刻**已经过去了**。
       *
       * 不重复的提醒如果设在过去，`firstOccurrence` 会**原样返回**那个过去时刻
       * （刻意的取舍："设在过去就立刻提醒"好过"永远不提醒"）。
       * 但界面上不能只写"将在 <过去的时间> 提醒" —— 用户看不出它到底会不会响。
       * 这种情况直接说清楚：保存后会立刻提醒一次。
       */
      past: actual <= Date.now(),
    };
  }, [remindDate, remindTime, repeat, nowTick]);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const patch = (p: Partial<Memo>) => setForm((f) => ({ ...f, ...p }));

  /** 用户是否在配一个提醒。判断依据是日期框有没有填。 */
  const reminderOn = remindDate !== "";

  /**
   * 切换提醒开关。
   *
   * 关掉时必须把 `repeat` 一起复位：否则会留下「repeat=daily 但 remindAt=null」
   * 这种自相矛盾的数据，将来重新开启提醒时会莫名其妙地按旧规则重复。
   */
  const toggleReminder = (on: boolean) => {
    if (on) {
      // 默认给一个还没到的时刻。只把日期设成今天是不够的：
      // 现在是下午三点的话，默认的 09:00 一开就显示「已到期」，
      // 用户会以为提醒坏了。所以过了 09:00 就把默认值顺延到下一个整点。
      const now = new Date();
      if (now.getHours() >= 9) {
        const next = new Date(now.getTime() + 60 * 60 * 1000);
        setRemindDate(dateKey(next));
        setRemindTime(`${String(next.getHours()).padStart(2, "0")}:00`);
      } else {
        setRemindDate(form.date);
        setRemindTime("09:00");
      }
      return;
    }
    setRemindDate("");
    setRepeat("none");
  };

  const submit = () => {
    const tags = tagInput
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let remindAt: number | null = null;
    let nextRepeat: Repeat = "none";
    if (reminderOn) {
      // 用 combineLocalSkippingGap 而不是 combineLocal：
      // 用户把日期正好选在夏令时跳变那一小时（美东 3-08 的 02:30）时，
      // combineLocal 会把它归一化成 03:30 并**存进 remindAt** ——
      // 于是"每天 02:30"从第一次起就永久变成"每天 03:30"。
      // 跳过那一天、保住钟点，与推进时的策略一致。
      const wanted = combineLocalSkippingGap(remindDate, remindTime || "09:00");
      // 关键一步：用户填的时刻可能已经过去了（下午三点设「今天 9:00 每天提醒」）。
      // firstOccurrence 会按重复规则推到下一次，而不是立刻弹一条过期提醒；
      // 不重复的笔记则原样保留，让用户看到「已到期」而不是被悄悄改掉。
      remindAt = firstOccurrence(wanted, repeat);
      nextRepeat = repeat;
    }

    onSave({ ...form, tags, remindAt, repeat: nextRepeat });
  };

  return (
    <div
      className={`editor${hasImages ? " editor--media" : ""}`}
      // Ctrl+V：剪贴板里有图片就导入图片，是文字就**完全不碰**（走浏览器原路）。
      // 挂在编辑器根节点上而不是 textarea 上：焦点可能在标题/标签框里，
      // 粘贴事件会从那儿冒泡上来，一处就够。
      onPaste={media.onPaste}
    >
      <div className="editor__head">{draft.title ? "编辑备忘" : "记一条"}</div>

      <label className="field">
        <span className="field__label">标题</span>
        <input
          ref={titleRef}
          className="field__input"
          value={form.title}
          placeholder="留空会自动取正文前几个字"
          onChange={(e) => patch({ title: e.target.value })}
        />
      </label>

      <label className="field field--grow">
        <span className="field__label">正文</span>
        <textarea
          ref={area.ref}
          className="field__input field__input--area"
          value={form.body}
          placeholder="今天做了什么、想到了什么、要办什么事…"
          onChange={(e) => patch({ body: e.target.value })}
          // 选中一段文字右键 → 「键入到当前光标」把它打到外部窗口。
          // 没选中时那一项是禁用的（理由见 lib/context-menu.tsx 的 useTextAreaMenu）
          onContextMenu={area.onContextMenu}
        />
      </label>

      {/* 图片区紧跟在正文后面：它和正文一样是"这条备忘的内容"，
          放到提醒设置下面会让人以为它属于提醒 */}
      <MediaSection
        images={form.images}
        media={media}
        contextMenu={contextMenu}
        onRegisterDrop={registerDrop}
      />

      <label className="field">
        <span className="field__label">
          标签
          <em className="field__hint">用逗号或空格分隔</em>
        </span>
        <input
          className="field__input"
          value={tagInput}
          placeholder="工作, 灵感"
          onChange={(e) => setTagInput(e.target.value)}
        />
      </label>

      {/* 记录日期。和下面的提醒日期刻意分成两块、并加上说明文字：
          这是整个界面里最需要讲清楚的一处，否则用户会以为改提醒日期
          就等于把这条笔记挪到别的日子。 */}
      <label className="field">
        <span className="field__label">
          记在哪一天
          <em className="field__hint">决定这条备忘出现在日记的哪一页</em>
        </span>
        <input
          className="field__input"
          type="date"
          value={form.date}
          onChange={(e) => {
            if (e.target.value) patch({ date: e.target.value });
          }}
        />
      </label>

      <div className="memo__section">
        <div className="memo__sectionhead">
          <span className="memo__sectiontitle">提醒</span>
          <em className="field__hint">
            和上面的记录日期无关：写今天、下周提醒也没问题
          </em>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={reminderOn}
            onChange={(e) => toggleReminder(e.target.checked)}
          />
          <span>到时间弹窗叫我</span>
        </label>

        {reminderOn && (
          <div className="memo__remindgrid">
            <label className="field">
              <span className="field__label">日期</span>
              <input
                className="field__input"
                type="date"
                value={remindDate}
                onChange={(e) => setRemindDate(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">时间</span>
              <input
                className="field__input"
                type="time"
                value={remindTime}
                onChange={(e) => setRemindTime(e.target.value)}
              />
            </label>
          </div>
        )}

        {reminderOn && (
          <label className="field">
            <span className="field__label">重复</span>
            <select
              className="field__input"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Repeat)}
            >
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {reminderOn && (
          <div className="memo__preview">
            {/* 实时预览，把「填的时刻已经过去」这件事在保存之前就告诉用户，
                而不是等他保存完发现提醒跑到了明天而一头雾水。
                算法在 preview 那个 useMemo 里，别挪回渲染里。 */}
            <Bell size={12} />
            <span>
              {preview.past
                ? "这个时刻已经过了，保存后会立刻提醒一次"
                : preview.moved
                  ? `这个时刻已经过了，改到 ${formatMoment(preview.actual)}`
                  : `将在 ${formatMoment(preview.actual)}`}
              {!preview.past && repeat !== "none" ? `，${repeatLabel(repeat)}` : ""}
              {!preview.past && "提醒"}
            </span>
          </div>
        )}
      </div>

      <div className="editor__actions">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn--primary" onClick={submit}>
          <Check size={13} />
          保存
        </button>
      </div>
    </div>
  );
}

/** 注册到功能表。 */
export const MemoFeature: FeatureModule = {
  id: "memo",
  title: "备忘",
  description: "按日期记备忘，可挂定时提醒",
  icon: NotebookPen,
  order: 30,
  component: MemoPanel,
};