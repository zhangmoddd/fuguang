/**
 * 文本片段功能。
 *
 * 解决的问题：日常在电脑上反复输入同样的文本、账号、地址、格式模板。
 *
 * 核心行为（对应设计决策）：
 * - 点击一条 → 借剪贴板粘贴到「上一次使用的外部窗口」的光标处，然后还原用户原剪贴板
 * - 粘贴后面板保持打开，可以连续粘多条
 * - 搜索同时匹配标题、正文、备注、标签
 * - 敏感条目在列表里默认遮罩成圆点，悬停才显示，防止录屏或旁人扫到
 * - 不做加密（避免用户忘密码后数据永久无法恢复），只做视觉遮罩
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  Image as ImageIcon,
  Pencil,
  Plus,
  Search,
  Send,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { api, type Folder as FolderItem, type MediaRef, type PasteOutcome, type Snippet } from "../../lib/api";
import {
  scrollIntoViewSoon,
  useContextMenu,
  useFocusHighlight,
  useTextAreaMenu,
  type ContextMenuItem,
  type UseContextMenuResult,
} from "../../lib/context-menu";
import {
  FolderBar,
  FolderEditor,
  FolderPicker,
  FolderTiles,
  useFolders,
} from "../../lib/folders-ui";
import { useDragSort } from "../../lib/drag-drop";
import { useEscapeToClose } from "../../lib/escape";
import {
  focusDomId,
  folderToEnter,
  highlightFrom,
  isHighlighted,
} from "../../lib/focus-highlight";
import { usePendingFocus } from "../../lib/navigation";
import {
  applyMediaDeletion,
  hasAnyContent,
  mediaDeletionNotice,
  orphanedByItemRemoval,
  planMediaDeletion,
  referencedImageIds,
  referencedImageIdsExcluding,
} from "../../lib/media";
import {
  MediaSection,
  batchNotice,
  useMediaAttachments,
  useMediaLibrary,
  type MediaLibraryApi,
} from "../../lib/media-ui";
import { newId, usePersistentState } from "../../lib/store";
import { useZoom } from "../../lib/zoom";
import type { FeatureModule } from "../registry";

const DATA_FILE = "snippets.json";

/**
 * 定位高亮用的 DOM id 前缀。
 *
 * 和其它页签取不同的前缀：同一个条目 id 理论上可能同时出现在两个页面上
 * （命令面板浮在片段页上面、备忘页也挂着），前缀能保证 `getElementById`
 * 不会找错人。
 */
const FOCUS_DOM_PREFIX = "snip-focus";

/**
 * 空片段工厂。新建时默认落在当前翻到的那个文件夹里。
 *
 * `images: []` 写在这里而不是靠可选字段省掉：新建的片段一定要有明确的
 * "零张图片"，否则后面 `s.images ?? []` 的兜底会散落到每一处读它的地方。
 */
function emptySnippet(folderId: string | null = null): Snippet {
  const now = Date.now();
  return {
    id: newId(),
    title: "",
    content: "",
    note: "",
    tags: [],
    sensitive: false,
    starred: false,
    uses: 0,
    folderId,
    images: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 列表排序：收藏优先 → 使用次数多优先 → 最近更新优先。 */
function sortSnippets(list: Snippet[]): Snippet[] {
  return [...list].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    if (a.uses !== b.uses) return b.uses - a.uses;
    return b.updatedAt - a.updatedAt;
  });
}

/** 一条片段是否命中搜索词。空搜索词视为全部命中。 */
function matches(s: Snippet, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    s.title.toLowerCase().includes(q) ||
    s.content.toLowerCase().includes(q) ||
    s.note.toLowerCase().includes(q) ||
    s.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** 把标签输入框里的一行拆成标签数组。逗号（中英文）或空格分隔。 */
function parseTags(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 把正文压成一行摘要用于列表展示。 */
function summarize(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 敏感内容遮罩。保持长度信息但隐藏真实内容。 */
function mask(text: string): string {
  const len = Math.min(Math.max(text.length, 6), 24);
  return "•".repeat(len);
}

/**
 * `snippets.json` 读出来的是不是一个片段数组。
 *
 * 放在模块级而不是写成内联箭头函数：`usePersistentState` 把它放进 ref，
 * 但模块级常量天然稳定，读代码的人也不会怀疑它每次渲染都变。
 *
 * 只校验"是数组"这一层。数组**里面**的元素形状不在这里管 ——
 * 一条坏元素最多让那一条显示不对，而整个不是数组会让整页崩掉，
 * 两者的代价差了一个数量级，不值得为前者把加载路径写复杂。
 */
function isSnippetList(value: unknown): boolean {
  return Array.isArray(value);
}

export function SnippetsPanel() {
  const { value: snippets, update, loading, error, flush } = usePersistentState<Snippet[]>(
    DATA_FILE,
    [],
    // 形状校验：`snippets.json` 是纯文本、用户能手改。写成 `{}` 或 `"[]"`
    // 的话，下面一句 `snippets.filter(...)` 就在**渲染期**抛异常、整块面板变白屏。
    isSnippetList,
  );

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [feedback, setFeedback] = useState<{
    text: string;
    kind: "ok" | "warn";
    seq: number;
  } | null>(null);
  /**
   * 反馈序号。同样的文案再出现一次时 `setFeedback` 收到的仍是**新对象**
   * （`seq` 变了），React 不会 bail out，计时器 effect 才会重启 ——
   * 否则 2.4 秒内连点两次同一条，第二次的提示会跟着第一次一起消失。
   */
  const feedbackSeq = useRef(0);

  /**
   * 显示一条反馈。
   *
   * `kind === "warn"` 用于「操作成功了，但有东西没了」这类**必须读完**的提示。
   * 它不能复用 `已保存` 那条绿色对勾 + 2.4 秒的通道：一句六十来字的
   * "剪贴板里原来的内容已被替换，无法还原"读都读不完就消失了，
   * 用户只会以为自己看错了 —— 而那正是最需要他看见的一句话。
   */
  const showFeedback = (text: string, kind: "ok" | "warn" = "ok") => {
    feedbackSeq.current += 1;
    setFeedback({ text, kind, seq: feedbackSeq.current });
  };
  /** 哪些条目的遮罩被临时揭开。 */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  /** 文件夹弹层。`target` 为 `null` 表示新建，否则是改名/改备注。 */
  const [folderEditor, setFolderEditor] = useState<{
    open: boolean;
    target: FolderItem | null;
  }>({ open: false, target: null });
  /** 正在「移动到…」的那条片段。 */
  const [movingId, setMovingId] = useState<string | null>(null);

  /**
   * ⚠️ 这里**刻意不自动聚焦搜索框**（原来会，已去掉）。
   *
   * 自动聚焦看着很体贴（这个页签 90% 的用法是「搜索 → 点一下」），
   * 但它和主面板的数字键 `1`~`9` 切页签**天生冲突**：焦点在输入框里，
   * 数字就只能是文字。曾经想用"框里没内容就放行数字键"绕过去，
   * 结果是**任何空输入框里敲数字都会切页签** ——
   * 用户在计时页给闹钟起名"1号闹钟"，一敲 `1` 就跳到文本页了。
   *
   * 现在的规则简单到没有例外：**焦点在输入框里，数字就是文字；
   * 不在输入框里，数字就是切页签。** 代价是搜索前要多点一下搜索框，
   * 换来的是"打字永远安全"。
   *
   * 键盘优先的搜索入口是 `Ctrl+K`（全局搜索，任何页签、任何焦点下都能唤出）。
   */
  useEffect(() => {
    // 切到这个页签时把焦点**移出**输入框：上一次停留的位置可能还在搜索框里，
    // 那按数字键又会被当成打字（页签是卸载重挂的，一般不会残留，但兜一下）
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  // 反馈提示自动消失。警告留久一点 —— 它讲的是"东西没了"，需要读完。
  useEffect(() => {
    if (!feedback) return;
    const ttl = feedback.kind === "warn" ? 8000 : 2400;
    const t = window.setTimeout(() => setFeedback(null), ttl);
    return () => window.clearTimeout(t);
  }, [feedback]);

  // ---- 文件夹与缩放 ----

  /**
   * 把本页签在 `from` 文件夹下的片段改挂到 `to`。
   *
   * 只在删除文件夹时被调用。文本片段走的是通用的 JSON 文件（`usePersistentState`），
   * 所以这里直接改本地状态即可，防抖写入会负责落盘。
   */
  const moveItems = useCallback(
    async (from: string, to: string | null) => {
      update((prev) =>
        prev.map((s) => (s.folderId === from ? { ...s, folderId: to } : s)),
      );
    },
    [update],
  );

  const folders = useFolders("snippets", { moveItems });
  const zoom = useZoom("snippets");

  /** 右键菜单。 */
  const ctx = useContextMenu();
  /** 定位高亮：短暂 + 一交互就灭，见 lib/context-menu.tsx 的 useFocusHighlight。 */
  const focus = useFocusHighlight();
  const { target: pending, done: focusDone } = usePendingFocus("snippets");

  // ---- 图片 ----

  /**
   * 拖放进来的路径要交给谁。
   *
   * 用一个 ref 存"当前的处理者"：编辑器开着时它注册自己（图片进那一条），
   * 没开着时走下面的兜底（新建一条）。**订阅只有一个**（在 `useMediaLibrary` 里）：
   * 页面和编辑器各订阅一份的话，一次拖放会导入两遍。
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
   * 编辑器**没开着**时拖进来：新建一条只装这些图片的笔记，并打开它的编辑器。
   *
   * # 为什么不是"提示用户先新建一条"
   *
   * 「把图片拖进这个页面」这个手势的意思就是"把这张图存下来"。不新建的话
   * 用户拖完什么都看不到，只能自己猜到要先点「新建」—— 那是把软件的
   * 内部结构（图片必须挂在某一条上）转嫁给用户。
   *
   * # 为什么必须立刻 `onDraftChange`
   *
   * 笔记页是**自动保存**的，而自动保存的触发点是"编辑器里改了一下"
   * （`onDraftChange`）。拖放创建的这条笔记用户一个字都没敲，
   * 不在这里写一次的话，他点「完成」就等于什么都没存下来 ——
   * 图已经落在磁盘上了，数据里却没有引用，成了永远看不见的孤儿文件。
   */
  const createSnippetFromDrop = async (paths: readonly string[]) => {
    const batch = await library.importPaths(paths);
    const result = batchNotice(batch, {
      // 新条目还没有图片；已有的引用都算"别处也在用"
      inItem: [],
      elsewhere: referencedImageIdsExcluding(snippets, ""),
    });
    if (result.text) showFeedback(result.text, result.kind);
    if (result.added.length === 0) return;

    const draft: Snippet = { ...emptySnippet(folders.currentId), images: result.added };
    openEditor(draft);
    onDraftChange(draft);
  };

  // 每次渲染后刷新"当前拖放处理者"。放进 effect 而不是渲染期直接赋值：
  // 渲染期改 ref 在 StrictMode 的双渲染下会跑两次（这里无害，但那是
  // "看起来能用、以后被改坏"的写法）。
  useEffect(() => {
    dropHandlerRef.current = (paths) => {
      if (dropTargetRef.current) {
        dropTargetRef.current(paths);
        return;
      }
      void createSnippetFromDrop(paths);
    };
  });

  /**
   * 当前文件夹里的片段。
   *
   * `folderId` 指向一个**不存在**的文件夹时按顶层处理：删文件夹中途失败、
   * 或用户手改过 JSON 都会留下这种条目。不兜的话它们会从界面上消失，
   * 而数据其实还在。
   */
  const inFolder = useMemo(() => {
    const known = new Set(folders.mine.map((f) => f.id));
    return snippets.filter((s) => {
      const folder = s.folderId && known.has(s.folderId) ? s.folderId : null;
      return folder === folders.currentId;
    });
  }, [snippets, folders.mine, folders.currentId]);

  const visible = useMemo(
    () => sortSnippets(inFolder.filter((s) => matches(s, query.trim()))),
    [inFolder, query],
  );

  /**
   * 当前文件夹**之外**还有多少条命中搜索词。
   *
   * 搜索只在当前这一层做（`inFolder` 参与过滤），所以用户在一个文件夹里搜
   * 别处的东西时，看到的是"没有匹配" —— 而界面上唯一的线索只有面包屑那一行，
   * 很容易被理解成"这条根本不存在"。用它把"别处还有 N 条"说破。
   */
  const outsideHits = useMemo(() => {
    const q = query.trim();
    if (!q || !folders.currentId) return 0;
    const shown = new Set(inFolder.map((s) => s.id));
    return snippets.filter((s) => !shown.has(s.id) && matches(s, q)).length;
  }, [snippets, inFolder, query, folders.currentId]);

  /** 每个文件夹里有几条片段，显示在文件夹卡片上（只算直接子级）。 */
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of snippets) {
      if (s.folderId) counts[s.folderId] = (counts[s.folderId] ?? 0) + 1;
    }
    return counts;
  }, [snippets]);

  /** 记录一次使用（次数 +1、更新时间刷新），用于排序。 */
  const bumpUse = (id: string) => {
    update((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, uses: s.uses + 1, updatedAt: Date.now() } : s,
      ),
    );
  };

  /** 核心动作：粘贴到光标处。 */
  const paste = async (s: Snippet) => {
    const outcome: PasteOutcome = await api.pasteText(s.content);
    bumpUse(s.id);
    reportPaste(outcome);
  };

  /**
   * 把一次粘贴的结果说给用户听。
   *
   * 抽出来是为了让右键菜单的「键入到当前光标」**复用同一套提示**：
   * 那三档反馈（成功 / 成功了但有东西没了 / 失败降级到剪贴板）是这个
   * 功能里最容易被写漏的部分 —— 尤其"成功时也可能带回一条必须看到的警告"
   * 那一条（见下面的说明），重写一遍几乎一定会漏。
   */
  const reportPaste = (outcome: PasteOutcome) => {
    if (outcome.ok) {
      const base = outcome.target
        ? `已粘贴到「${truncate(outcome.target, 18)}」`
        : "已粘贴";
      // ⚠️ 成功时也可能带回一条**必须让用户看到**的警告：剪贴板里原来是图片/文件，
      // 或者这次没能还原成功 —— 那意味着他原来复制的东西已经没了。
      // 只在失败分支读 `message` 的话，这条提示在成功路径上就是死代码。
      showFeedback(
        outcome.message ? `${base}；${outcome.message}` : base,
        outcome.message ? "warn" : "ok",
      );
    } else {
      // 降级路径：内容已经躺在剪贴板里了，明确告诉用户手动 Ctrl+V
      showFeedback(
        outcome.message ?? "已复制到剪贴板，请手动 Ctrl+V",
        "warn",
      );
    }
  };

  /**
   * 「键入到当前光标」：把一段文本打到用户刚才用的外部窗口。
   *
   * 和 `paste` 的区别只有一点：**不计使用次数**。
   * 「常用优先」的排序统计的是"这条片段被用了几次"，而右键菜单里的
   * 「键入」多半是"我想把这段字打进聊天框"，它确实是使用 —— 但**编辑器里
   * 选中一段右键**那种用法，选中的只是这条片段的一部分，
   * 拿它去给整条 +1 会让排序慢慢失真。所以这里不 `bumpUse`。
   * （列表行右键的「键入到当前光标」走的就是 `paste`，会计数 ——
   * 那是完整的"用了一次这条片段"。）
   */
  const typeInto = async (text: string) => {
    const outcome: PasteOutcome = await api.pasteText(text);
    reportPaste(outcome);
  };

  /** 只复制，不粘贴。 */
  const copyOnly = async (s: Snippet) => {
    const ok = await api.copyText(s.content);
    bumpUse(s.id);
    showFeedback(
      ok ? "已复制到剪贴板" : "复制失败，剪贴板可能被占用",
      ok ? "ok" : "warn",
    );
  };

  /**
   * 一条片段在右键菜单里的全部动作。
   *
   * # 为什么保留列表行上原有的「粘贴」「复制」按钮，同时又给右键菜单
   *
   * 用户提过想把这两个按钮收进右键菜单。没有照做，理由是：
   * **「点一下就粘贴到光标处」是这个软件的核心动作**，而右键菜单把它从
   * 1 次点击变成"右键 → 瞄准 → 点"，还要先知道有右键菜单这回事。
   * 高频动作每多一步都是明显变慢。所以是**保留按钮 + 额外提供右键菜单**，
   * 两条路都通。
   */
  const snippetMenu = (s: Snippet): ContextMenuItem[] => [
    {
      id: "type",
      label: "键入到当前光标",
      icon: <Send size={13} />,
      onSelect: () => void paste(s),
    },
    {
      id: "copy",
      label: "复制",
      icon: <Copy size={13} />,
      hint: "Ctrl+C",
      onSelect: () => void copyOnly(s),
    },
    {
      id: "edit",
      label: "编辑",
      icon: <Pencil size={13} />,
      dividerBefore: true,
      onSelect: () => openEditor(s),
    },
    {
      id: "move",
      label: "移动到…",
      icon: <FolderInput size={13} />,
      onSelect: () => setMovingId(s.id),
    },
    {
      id: "star",
      label: s.starred ? "取消收藏" : "收藏置顶",
      icon: <Star size={13} fill={s.starred ? "currentColor" : "none"} />,
      onSelect: () => toggleFlag(s.id, "starred"),
    },
    {
      id: "delete",
      label: "删除",
      icon: <Trash2 size={13} />,
      danger: true,
      dividerBefore: true,
      onSelect: () => void remove(s.id),
    },
  ];

  /**
   * 打开编辑器时那条片段原来的样子，供「撤销改动」还原。
   * `null` 表示没在编辑。
   */
  const snapshotRef = useRef<Snippet | null>(null);
  /**
   * 这条是不是**这次编辑期间才新建**的。
   *
   * 撤销时要区分两种情形：新建的整条删掉（否则盘上会留下一条空壳），
   * 原来就有的还原成 `snapshotRef`。判据在**打开编辑器那一刻**取定，
   * 之后不再变 —— 所以它不是"数据里现在有没有"，而是"进来之前有没有"。
   */
  const isNewRef = useRef(false);
  /** 本次编辑里数据是否真的被动过。只用来决定要不要报「已保存 / 已撤销」。 */
  const dirtyRef = useRef(false);
  /**
   * **最近一次真的写进数据里的那一份草稿**（`onDraftChange` 里 `cleaned`）。
   *
   * 「完成」时要拿它和磁盘上那一条比一比，确认"存下去的到底是不是我这一版" ——
   * 跨窗口合并可能在两边都改过同一条时留下**对面那版**，那时还说"已保存"就是撒谎。
   *
   * ⚠️ 存的是**最后一次真的写过的那份**，不是编辑器当前那份：正文被清空时
   * `onDraftChange` 会提前 return（不写空内容），这时数据里留着的仍是上一次那份，
   * 拿"当前草稿"去比会误判成"被对面盖了"。
   */
  const lastWrittenRef = useRef<Snippet | null>(null);

  const openEditor = (s: Snippet) => {
    snapshotRef.current = s;
    isNewRef.current = !snippets.some((x) => x.id === s.id);
    dirtyRef.current = false;
    lastWrittenRef.current = null;
    setEditing(s);
  };

  /**
   * 收到搜索定位请求：进文件夹 → 滚到可见 → 高亮 →（需要时）打开编辑器。
   *
   * # 为什么这个 effect 放在 `openEditor` **后面**
   *
   * 它要调用 `openEditor`，而 `const` 声明在初始化之前是不可用的
   * （TDZ）。effect 的**回调**虽然要等 commit 之后才跑，但闭包捕获的是
   * 绑定本身 —— 只要 effect 的定义在 `openEditor` 之前，第一次 commit 时
   * 读取它就是 `ReferenceError`。所以顺序不能挪。
   *
   * # 为什么要等 `folders.loading` 结束
   *
   * `useFolders` 的文件夹列表是异步读回来的。请求到达时如果还没读完，
   * `enter(folderId)` 设进去的 id 会立刻被 `folders-ui.tsx:122-125` 那条
   * "当前文件夹不存在就退回顶层"的兜底清掉 —— 用户看到的是"跳到了顶层，
   * 而那条在别的文件夹里"。
   *
   * # 为什么只 `enter` 一次
   *
   * `done()` 之后 `pending` 变 `null`、effect 会再跑一次，那时必须早退，
   * 否则会把用户手动切到的文件夹又拽回去。
   *
   * `folders` / `snippets` / `openEditor` 刻意不进依赖：它们是每次渲染
   * 都变的新对象/新函数，进来会让这个 effect 变成"每渲染跑一次"，
   * 于是每次重渲染都重新 `enter()` 一遍文件夹。真正需要"再跑一次"的
   * 触发点只有 `pending`、`folders.loading` 与 `loading` 三个。
   *
   * # ⚠️ 为什么两个 loading 都要等（缺一个都会「按了回车没反应」）
   *
   * 从别的页签按回车跳过来时，本页是**刚挂载**的：`snippets` 初值是 `[]`、
   * 文件夹列表也还在异步路上。这时如果直接消费请求：
   * - `pending.open` 时 `snippets.find(...)` 拿到 `undefined` → **编辑器打不开**；
   * - 紧接着 `focusDone()` 把请求消费掉，数据回来也不会再跑。
   *
   * 所以两个守卫都必须在 `done()` **之前**，而且两个都要进依赖 ——
   * 只加守卫不加依赖的话，数据回来时 effect 永远不会再跑，
   * 等于换了个方式继续坏。这与备忘页等 `loading` 是同一条道理：
   * **定位请求必须等这一页的数据就绪再消费**。
   */
  useEffect(() => {
    if (!pending) return;
    if (folders.loading || loading) return;

    const folder = folderToEnter(pending);
    if (folder.known) folders.enter(folder.folderId);

    focus.show(highlightFrom(pending));
    scrollIntoViewSoon(focusDomId(FOCUS_DOM_PREFIX, pending.id));

    if (pending.open) {
      const found = snippets.find((s) => s.id === pending.id);
      if (found) openEditor(found);
    }

    focusDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, folders.loading, loading]);

  /**
   * 编辑器里改一下就写一次数据 —— **自动保存**，没有「保存」按钮了。
   *
   * # 为什么原来那套「点保存才存」必须去掉
   *
   * 原来草稿只活在 `SnippetEditor` 的 `useState` 里，只有点「保存」才 `update()`
   * 进数据。于是**没点保存就等于没写**，而且丢的时候一句话都不说：
   * 切页签（`PanelWindow` 只挂载当前页签，切走即卸载整个面板组件）、
   * 点「取消」、按 Esc、直接退出软件，用户刚敲的字全部消失。
   * 面板窗口是 `hide` 不是销毁，所以"收起面板"这一条恰好不丢 ——
   * 于是这个 bug 表现得时灵时不灵，更难归因。
   *
   * 现在的规则是：**敲进去的就是存下来的**。每改一下都进数据，
   * 由 `usePersistentState` 的 400ms 防抖写盘负责落盘（窗口隐藏 / 卸载前
   * 还会强制落盘）。编辑器只剩「完成」和「撤销改动」两个出口。
   *
   * 正文为空时**不写**：和原来「保存」按钮的 `disabled` 是同一条规矩 ——
   * 不存空正文的片段。所以清空正文再退出，数据里仍是上一次的内容。
   *
   * ⚠️ 有了图片之后，判据从"正文非空"换成 **"正文非空 或 有图片"**
   * （`hasAnyContent`）。不换的话，一条**只有图片**的笔记会被这一句
   * 悄悄拦掉：用户贴了一张图、点「完成」，回来发现图没了 ——
   * 而且没有任何提示，因为"没写"和"写了"在界面上长得一样。
   * 同时**不能**把"真的空"（没文字也没图片）也放行，那会重新引入空壳条目。
   */
  const onDraftChange = (draft: Snippet) => {
    if (!hasAnyContent(draft.content, draft.images)) return;
    dirtyRef.current = true;
    const cleaned: Snippet = {
      ...draft,
      // 标题留空时取正文开头几个字。**不用图片信息去编一个标题** ——
      // 标题会进全文搜索，拿"图片 2 张"或文件名当标题会让搜索多出
      // 一堆看不出为什么命中的结果
      title: draft.title.trim() || summarize(draft.content, 24) || "未命名",
      updatedAt: Date.now(),
    };
    update((prev) => {
      const exists = prev.some((s) => s.id === cleaned.id);
      return exists ? prev.map((s) => (s.id === cleaned.id ? cleaned : s)) : [cleaned, ...prev];
    });
    // 记下"这次真的写进去的是哪一份"，供「完成」时核对（见 `lastWrittenRef`）
    lastWrittenRef.current = cleaned;
  };

  /** 从磁盘上读回某一条。读不回来（或形状不对）返回 `null`。 */
  const readSavedSnippet = async (id: string): Promise<Snippet | null> => {
    try {
      const all = await api.readData<Snippet[]>(DATA_FILE);
      // `readData<T>` 是纯类型断言、运行期零校验（见 `store.ts` 那段说明），
      // 所以这里自己确认一下"确实是个数组"
      if (!Array.isArray(all)) return null;
      return all.find((s) => s.id === id) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 「完成」：数据早就写进去了，这里只负责关掉编辑器。
   *
   * 仍然要 `await flush()` 之后再报「已保存」—— `update()` 只是排了一次
   * 400ms 的防抖写盘，磁盘满 / 数据目录只读时它不会成功，而无条件说
   * "已保存"就是撒谎（这条原来踩过，见 CHANGELOG 的「保存失败却告诉用户已保存」）。
   *
   * # ⚠️ 写盘成功 ≠ 存下去的是我这一版
   *
   * 跨窗口合并（`lib/merge-by-id.ts`）在**两边都改过同一条**时可能留下**对面那版**
   * （内容对内容时"较晚的那次编辑赢"）。这时 `flush()` 照样返回 `true`，
   * 但磁盘上不是用户刚敲的内容 —— 再说"已保存"就是第二个版本的同一个谎。
   *
   * 所以回读一次、比 `updatedAt`：合并是**整条挑一份**（不是逐字段合并），
   * 所以"时间戳还是我那个"就等于"存下去的确实是我这一版"。
   *
   * 为什么不用内存里那份比：`await flush()` 之后 React 还没把采纳结果渲染出来，
   * 闭包捕获的那份 `snippets` 是旧的；**磁盘才是权威**。
   *
   * 读不回来时不下结论（宁可说"已保存"—— 写盘确实成功了，也不谎报"被对面盖了"）。
   */
  const finishEdit = async () => {
    setEditing(null);
    if (!dirtyRef.current) return;
    if (!(await flush())) {
      showFeedback("保存失败：改动只在内存里，请检查数据目录能不能写", "warn");
      return;
    }

    const draft = lastWrittenRef.current;
    const saved = draft ? await readSavedSnippet(draft.id) : null;
    if (draft && saved && saved.updatedAt !== draft.updatedAt) {
      showFeedback("这一条在另一个窗口被改过，已保存的是对面那版（你刚敲的没存住）", "warn");
      return;
    }
    showFeedback("已保存");
  };

  /**
   * 删掉一批**候选**的图片文件。
   *
   * # 判据不在这里
   *
   * 这里只负责"把候选交给决策函数、按结果删"，**三个判据全在**
   * `lib/media.ts` 的 `planMediaDeletion` 里 —— 删整条条目、图片单独移除、
   * 撤销/取消后的残留清理，四条路走的都是**同一个**决策函数。
   * 在这个页面里另写一份判据的话，迟早有人只写前两条 ——
   * 而那正是 RV4 报的那条**不可逆**问题。
   *
   * # 为什么静默
   *
   * 这些是"顺手清理残留"，调用方自己已经报过「已撤销改动 / 已保存 / 已删除」了。
   * 闸拦住时也不说话（那三种情况下再叠一句"文件先留着"只是噪音）；
   * 只有**用户明确点了删除**那条路（`remove`）才会解释为什么留着。
   *
   * @param candidates 看起来没人引用的那些 id
   * @param fromItemId 正在改动的那一条；不传表示 `items` 已经是改完之后的样子
   * @param items 判"还有没有人引用"用的条目集合
   */
  const cleanOrphanFiles = (
    candidates: readonly string[],
    options: { items: readonly Snippet[]; fromItemId?: string },
  ) => {
    if (candidates.length === 0) return;
    void (async () => {
      const evidence = await library.gcEvidence();
      const plan = planMediaDeletion({
        items: options.items,
        fromItemId: options.fromItemId,
        candidateIds: candidates,
        evidence,
      });
      if (plan.deletable.length === 0) return;
      await applyMediaDeletion({ plan, deleteFile: api.mediaDelete });
      library.refreshStats();
    })();
  };

  /**
   * 「撤销改动」：退回打开编辑器时的样子。
   *
   * 只有真的动过数据才需要写 —— 否则会白白排一次写盘，还会把
   * "没改过" 的东西重新写一遍。
   *
   * # 顺手清理撤销之后没人引用的图片
   *
   * 笔记页是自动保存的：导入的图片**立刻**进了数据。撤销会把数据退回快照，
   * 于是"这次编辑期间加进来、快照里没有"的那些图就没人引用了 ——
   * 不清理的话，用户每撤销一次，`media/` 里就多一份永远看不见的文件。
   *
   * 候选集分两种（这里必须分清，否则会删掉还在用的图）：
   * - **本次新建**的条目：撤销之后整条消失 → 它带的所有图都作废；
   * - **已有**的条目：撤销只是把数据换成快照 → 只有"快照里没有的那些"作废，
   *   快照里的图撤销之后**又有人引用了**，一个都不能删。
   *
   * ⚠️ 这里**不能**用 `orphanedByItemRemoval`：它的语义是"这些 id 正从条目里
   * 被移除"，会把来源条目自身的引用整个排除掉 —— 那会把快照里的图也当成孤儿。
   */
  const discardEdit = () => {
    const snap = snapshotRef.current;
    if (snap && dirtyRef.current) {
      const stored = snippets.find((s) => s.id === snap.id);
      const storedIds = (stored?.images ?? []).map((image) => image.id);
      const snapIds = new Set((snap.images ?? []).map((image) => image.id));
      const candidates = isNewRef.current
        ? storedIds
        : storedIds.filter((id) => !snapIds.has(id));

      // 撤销之后数据长什么样
      const restored = isNewRef.current
        ? snippets.filter((s) => s.id !== snap.id)
        : snippets.map((s) => (s.id === snap.id ? snap : s));
      const orphans = candidates.filter((id) => !referencedImageIds(restored).has(id));

      update((prev) =>
        isNewRef.current
          ? prev.filter((s) => s.id !== snap.id)
          : prev.map((s) => (s.id === snap.id ? snap : s)),
      );
      showFeedback("已撤销改动");
      // `restored` **就是**改完之后的数据，所以不传 `fromItemId`：
      // 判据问的是"整份数据里还有人引用吗"
      cleanOrphanFiles(orphans, { items: restored });
    }
    setEditing(null);
  };

  /**
   * 删除一条。同样要等落盘结果再说话 —— 不可逆的操作尤其不能谎报成功。
   *
   * 顺手清理**没人再引用**的图片文件：导入按内容 sha256 去重，同一张图
   * 被几条片段引用是正常的，只有一条都不剩时才能删磁盘文件。
   * 图片清理失败**不该**让整次删除报错 —— 片段已经删掉了，报错会让用户
   * 以为没删成功、再删一次。
   *
   * # ⚠️ 已知限制：有一种顺序会留下孤儿文件（刻意不修）
   *
   * 「导入一张图 → 在编辑器里把它移除 → 删掉这条笔记」这条路径下，
   * 那张图既不在条目当前的 `images` 里（已经被移除），也不在任何别处，
   * 而这里的 `orphanedByItemRemoval` 只看条目**当前**引用的图片 ——
   * 于是它的文件会留在 `%APPDATA%\浮光\media\` 里，界面上再也看不到它。
   *
   * 彻底修需要一个跨条目的"本次会话碰过的图片"流水，而收益只有"少占一点磁盘"：
   * **漏掉一个孤儿文件是可恢复的（只是占着空间），删掉一个还在被引用的文件
   * 是不可恢复的（对方立刻裂图）** —— 两者不对称，所以宁可漏删。
   * 已写进 CHANGELOG 的已知限制。
   *
   * # 删盘走的是**同一个**决策函数（t25）
   *
   * 这条路的候选由 `orphanedByItemRemoval` 给出，但**敢不敢删**由
   * `planMediaDeletion` 定 —— 与"图片单独移除"是同一个入口。
   * 这很重要：删整条是**比单独移除一张图更常用**的动作，闸不能只装在不常用的那条路上。
   * 多窗口下本窗口内存陈旧时，这里同样会把别的窗口还在引用的文件抹掉，**不可逆**。
   */
  const remove = async (id: string) => {
    const orphans = orphanedByItemRemoval(snippets, id);
    update((prev) => prev.filter((s) => s.id !== id));
    const ok = await flush();
    showFeedback(
      ok ? "已删除" : "删除失败：改动只在内存里，重启后它还会回来",
      ok ? "ok" : "warn",
    );
    if (!ok || orphans.length === 0) return;

    const evidence = await library.gcEvidence();
    const plan = planMediaDeletion({
      items: snippets,
      // 条目**正在**被删（状态更新是异步的，`snippets` 里还有它）→ 传 fromItemId，
      // 判据会排除它自己的引用，问的是"别的条目还在引用吗"
      fromItemId: id,
      candidateIds: orphans,
      evidence,
    });
    if (plan.deletable.length === 0) {
      // 用户明确点了删除，文件却没删掉 —— 必须说清为什么，不能静默
      showFeedback(mediaDeletionNotice(plan, evidence) ?? "图片文件先留着", "ok");
      return;
    }
    await applyMediaDeletion({ plan, deleteFile: api.mediaDelete });
    library.refreshStats();
  };

  const toggleFlag = (id: string, key: "starred" | "sensitive") => {
    update((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [key]: !s[key], updatedAt: Date.now() } : s)),
    );
  };

  /**
   * 把一条片段移到别的文件夹。`null` 表示移到顶层。
   *
   * 刻意**不动 `updatedAt`**：排序里「最近更新优先」，而归类不是改内容，
   * 一动时间戳就会把这条莫名其妙顶到列表最前面。
   */
  const moveTo = (s: Snippet, folderId: string | null) => {
    setMovingId(null);
    if ((s.folderId ?? null) === folderId) return;
    update((prev) => prev.map((x) => (x.id === s.id ? { ...x, folderId } : x)));
    void flush().then((ok) =>
      showFeedback(
        ok ? `已移动「${s.title}」` : "移动失败：改动只在内存里，重启后它会回到原处",
        ok ? "ok" : "warn",
      ),
    );
  };

  /**
   * 拖拽：把片段放进文件夹，以及文件夹自己同级排序。
   *
   * **片段之间不做手动排序**：这个列表的顺序是刻意自动排的
   * （收藏优先 → 使用次数多优先 → 最近更新优先）。给某几条钉一个手动位置
   * 会和那套语义打架——用户会说不清"为什么这条不动"。
   * 所以这里用 `handleProps`（能拖）而不是 `itemProps`（能当排序落点）。
   */
  const drag = useDragSort({
    axis: "vertical",
    onDrop: (draggedId, draggedKind, spot) => {
      if (draggedKind === "folder") {
        if (spot.kind === "item") void folders.reorder(draggedId, spot.id, spot.before);
        return;
      }
      if (spot.kind !== "folder") return;
      const target = snippets.find((x) => x.id === draggedId);
      if (target) moveTo(target, spot.id);
    },
  });

  const toggleReveal = (id: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 提示条 + 读写异常条。
   *
   * 抽出来是因为**编辑器分支也要渲染它们**：原来这两条只在列表那棵树里，
   * 而 `if (editing) return <SnippetEditor/>` 会整棵换掉 —— 于是"保存失败"
   * 的那句话被写进了一个当帧根本不渲染的 state，用户一个字都看不到。
   */
  const notices = (
    <>
      {feedback && (
        <div
          className={`snip__feedback${
            feedback.kind === "warn" ? " snip__feedback--warn" : ""
          }`}
        >
          {feedback.kind === "warn" ? (
            <TriangleAlert size={13} />
          ) : (
            <Check size={13} />
          )}
          {feedback.text}
        </div>
      )}
      {error && <div className="snip__error">数据读写异常：{error}</div>}
    </>
  );

  if (editing) {
    return (
      <div className="snip">
        {notices}
        <SnippetEditor
          draft={editing}
          onChange={onDraftChange}
          onDone={finishEdit}
          onDiscard={discardEdit}
          // 编辑器正文区的右键菜单（键入到光标 / 复制 / 剪切 / 粘贴 / 全选）
          // 需要两个能力：把文字打出去（typeInto）、以及把结果说给用户听（onNotice）
          onTypeInto={typeInto}
          onNotice={showFeedback}
          contextMenu={ctx}
          // 图片附件：导入机制在页面级（拖放订阅只能有一份），
          // 判重与"这张图还有没有别人在用"要用页面那份完整列表
          library={library}
          registerDrop={registerDrop}
          allItems={() => snippets}
          // 撤销还原的是**打开编辑器那一刻**的快照，所以这里给的是它
          undoImages={() => snapshotRef.current?.images ?? []}
        />
        {ctx.menu}
      </div>
    );
  }

  return (
    <div
      className="snip"
      // 滚轮监听挂在整页根节点上：鼠标停在搜索栏、文件夹卡片上时也该能缩放。
      // 普通滚轮不受影响（见 lib/zoom.ts）。
      ref={zoom.ref}
      style={{ "--density": String(zoom.percent / 100) } as CSSProperties}
    >
      {/* 搜索栏：整个功能的主入口 */}
      <div className="snip__searchbar">
        <Search size={14} className="snip__searchicon" />
        <input
          ref={searchRef}
          className="snip__search"
          placeholder="搜索标题、内容、备注、标签…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="iconbtn" onClick={() => setQuery("")} title="清空搜索">
            <X size={13} />
          </button>
        )}
      </div>

      <div className="snip__toolbar">
        <span className="snip__count">
          {folders.currentId ? `本文件夹 ${inFolder.length} 条` : `共 ${snippets.length} 条`}
          {query && ` · 命中 ${visible.length} 条`}
        </span>
        <button className="btn btn--primary" onClick={() => openEditor(emptySnippet(folders.currentId))}>
          <Plus size={13} />
          新建
        </button>
      </div>

      {notices}

      {/* 当前路径。放在列表上方：先看到「我在哪」，再看这一层有什么 */}
      <div className="folderzone">
        <FolderBar
          trail={folders.trail}
          onEnter={folders.enter}
          onCreate={() => setFolderEditor({ open: true, target: null })}
        />

        {folderEditor.open && (
          <FolderEditor
            target={folderEditor.target}
            onSubmit={(name, note) =>
              folderEditor.target
                ? folders.update(folderEditor.target, name, note)
                : folders.create(name, note)
            }
            onClose={() => setFolderEditor({ open: false, target: null })}
          />
        )}
      </div>

      {folders.error && (
        <div className="snip__error">文件夹出错：{folders.error}</div>
      )}

      <div className="snip__list">
        {/* 子文件夹排在片段前面，和资源管理器一致 */}
        <FolderTiles
          folders={folders.children}
          counts={folderCounts}
          dropTargetId={drag.over?.kind === "folder" ? drag.over.id : null}
          dragProps={(id) => drag.handleProps(id, "folder")}
          onEnter={folders.enter}
          onEdit={(f) => setFolderEditor({ open: true, target: f })}
          onRemove={(f) => void folders.remove(f)}
          variant="list"
        />

        {loading && <div className="snip__empty">正在读取数据…</div>}

        {!loading && visible.length === 0 && folders.children.length === 0 && (
          <div className="snip__empty">
            {snippets.length === 0 ? (
              <>
                还没有任何笔记。
                <br />
                点右上角「新建」加一条，比如你的邮箱、常用地址、一段格式模板。
              </>
            ) : query ? (
              <>
                没有匹配「{query}」的笔记。
                {/* 搜索是**在当前文件夹里**做的（`inFolder` 参与过滤）。
                    不点破的话，用户会以为"这条根本不存在"，而其实它在别的层里 ——
                    界面上唯一的线索只有面包屑那一行。 */}
                {folders.currentId && outsideHits > 0 && (
                  <>
                    <br />
                    别的文件夹里还有 {outsideHits} 条命中。
                    <button
                      type="button"
                      className="snip__empty-link"
                      onClick={() => folders.enter(null)}
                    >
                      回顶层搜
                    </button>
                  </>
                )}
              </>
            ) : (
              <>这个文件夹里还没有笔记。</>
            )}
          </div>
        )}

        {visible.map((s) => {
          const shown = s.sensitive && !revealed.has(s.id);
          // `Snippet.images` 是**可选**字段（片段是前端拥有的类型，老数据里
          // 没有这一项），所以这里兜一次，下面就不用到处写 `?? []`
          const images = s.images ?? [];
          return (
            <article
              key={s.id}
              id={focusDomId(FOCUS_DOM_PREFIX, s.id)}
              className={`card${drag.draggingId === s.id ? " drag-source" : ""}${
                isHighlighted(focus.highlight, s.id) ? " card--focus" : ""
              }`}
              // 右键：和这一条有关的动作。列表行上原有的「粘贴」「复制」按钮
              // **保留**（理由见 snippetMenu 的说明），右键只是多一条路。
              onContextMenu={(e) => ctx.open(e, () => snippetMenu(s))}
              {...drag.handleProps(s.id)}
            >
              <div className="card__head">
                {s.starred && <Star size={12} className="card__star" fill="currentColor" />}
                <span className="card__title">{s.title}</span>
                {s.tags.map((t) => (
                  <span key={t} className="card__tag">
                    {t}
                  </span>
                ))}
                {/* 列表行只给一个**数量标记**，不塞缩略图：卡片只有几十像素高，
                    放一张图会把"一眼扫十条"变成"一眼看两条"。 */}
                {images.length > 0 && (
                  <span className="media__marker" title={`${images.length} 张图片`}>
                    <ImageIcon size={10} />
                    {images.length}
                  </span>
                )}
              </div>

              {/* 正文摘要。**只有图片没有文字**时这一行整个不渲染 ——
                  否则会留下一个空行（而空行看起来像"内容加载失败"）。
                  敏感条目的遮罩也要先判正文非空：对空串调 `mask` 会给出
                  六个圆点，那是"有内容但被遮住了"的假象。 */}
              {(shown ? s.content.trim().length > 0 : summarize(s.content).length > 0) && (
                <div className="card__content">
                  {shown ? mask(s.content) : summarize(s.content)}
                </div>
              )}

              {s.note && <div className="card__note">{s.note}</div>}

              <div className="card__actions">
                <button className="btn btn--primary" onClick={() => void paste(s)} title="粘贴到刚才光标所在的位置">
                  <Send size={12} />
                  粘贴
                </button>
                <button className="btn" onClick={() => void copyOnly(s)} title="只复制，不自动粘贴">
                  <Copy size={12} />
                  复制
                </button>

                {s.sensitive && (
                  <button
                    className="iconbtn"
                    onClick={() => toggleReveal(s.id)}
                    title={shown ? "显示内容" : "遮罩内容"}
                  >
                    {shown ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                )}

                <button
                  className="iconbtn"
                  onClick={() => toggleFlag(s.id, "starred")}
                  title={s.starred ? "取消收藏" : "收藏"}
                >
                  <Star size={13} fill={s.starred ? "currentColor" : "none"} />
                </button>
                <button
                  className="iconbtn"
                  onClick={() => setMovingId(s.id)}
                  title="移动到文件夹"
                >
                  <FolderInput size={13} />
                </button>
                <button className="iconbtn" onClick={() => openEditor(s)} title="编辑">
                  <Pencil size={13} />
                </button>
                <button className="iconbtn iconbtn--danger" onClick={() => void remove(s.id)} title="删除">
                  <Trash2 size={13} />
                </button>

                {s.uses > 0 && <span className="card__uses">用过 {s.uses} 次</span>}
              </div>
            </article>
          );
        })}
      </div>

      {movingId && (
        <FolderPicker
          folders={folders.mine}
          current={snippets.find((s) => s.id === movingId)?.folderId ?? null}
          onPick={(id) => {
            const target = snippets.find((s) => s.id === movingId);
            if (target) moveTo(target, id);
            else setMovingId(null);
          }}
          onClose={() => setMovingId(null)}
        />
      )}

      {/* 右键菜单。挂在这里而不是每张卡片里：它是 `position: fixed` 的
          独立浮层，只有一份，跟着"哪一条被右键"变内容 */}
      {ctx.menu}
    </div>
  );
}

/** 新建/编辑界面。 */
function SnippetEditor({
  draft,
  onChange,
  onDone,
  onDiscard,
  onTypeInto,
  onNotice,
  contextMenu,
  library,
  registerDrop,
  allItems,
  undoImages,
}: {
  draft: Snippet;
  /** 每改一下就回调一次 —— 数据是自动保存的，这里没有「提交」这个动作。 */
  onChange: (s: Snippet) => void;
  onDone: () => void;
  onDiscard: () => void;
  /** 「键入到当前光标」：把选中的那段文字打到外部窗口。 */
  onTypeInto: (text: string) => void;
  /**
   * 右键菜单里那些"顺手做一下"的结果提示（复制成功、剪贴板读不到…）。
   *
   * 由上层传进来而不是这里自己 `setFeedback`：提示条渲染在
   * `SnippetsPanel` 那一层（`notices`），编辑器里再存一份就会有两处
   * 需要同步的状态。
   */
  onNotice: (text: string, kind: "ok" | "warn") => void;
  /** 上层已经建好的右键菜单实例（一份就够，不用每个输入框各建一个）。 */
  contextMenu: UseContextMenuResult;
  /** 页面级媒体库（导入机制 + 占用统计 + 拖放订阅）。 */
  library: MediaLibraryApi;
  /** 把本编辑器注册成拖放目标（页面级订阅只有一个）。 */
  registerDrop: (handler: ((paths: string[]) => void) | null) => void;
  /** 全部片段的图片引用，用来判"这张图还有没有别人在用"。 */
  allItems: () => readonly Snippet[];
  /**
   * 「撤销改动」会还原回来的那份图片（= 打开编辑器那一刻的快照）。
   *
   * 必须是**快照**而不是"数据里现在那份"：撤销还原的是快照，
   * 而数据里那份已经被自动保存改过了。用错的话，用户删掉一张图再撤销，
   * 数据里的图回来了、文件却被我们删了 —— 界面上是个"读不到"的格子。
   */
  undoImages: () => readonly MediaRef[];
}) {
  const [form, setForm] = useState<Snippet>(draft);

  /**
   * Esc 只离开编辑器，**不丢改动**（改动在每次击键时就进了数据）。
   *
   * 这里原来是 `useEscapeToClose(onCancel)` —— 按 Esc 等于"取消"，
   * 而"取消"就是丢掉刚写的东西。这正是「写好东西没点保存就不保存」里
   * 最坑人的一条：想收起面板，顺手按个 Esc，字就没了，还没有提示。
   * 想退回原样请用「撤销改动」—— 一个明确的、带文字的按钮。
   *
   * ⚠️ 浮层（大图预览 / 右键菜单）开着时**不认领** Esc：那一下 Esc 是
   * "关掉浮层"，不是"退出编辑器"。第二个参数交给 `useEscapeToClose`，
   * 它会**先判认领、再决定拦不拦传播** —— 不认领时既不 `stopPropagation`
   * 也不回调，事件原样走到菜单那一层，由菜单自己关掉自己。
   *
   * （笔记页 Esc 走 `onDone`（自动保存），最坏只是关掉编辑器；
   * 备忘页那边同一个坑的后果严重得多，见 `lib/escape.ts` 的说明。）
   */
  useEscapeToClose(
    onDone,
    () => !media.blocksEscapeNow(),
  );
  const [tagInput, setTagInput] = useState(draft.tags.join(", "));

  /**
   * 图片附件：三路导入（按钮 / 拖放 / Ctrl+V）+ 网格 + 大图 + 图片右键菜单。
   *
   * `images` 传函数而不是值：导入 / 删除之后要拿到**最新**的那一份列表，
   * 而这个 hook 里那些回调（右键菜单项）是稳定的，读值会在闭包里过期。
   */
  const media = useMediaAttachments({
    // `Snippet.images` 是可选字段（老数据里没有），所以兜一次
    images: () => form.images ?? [],
    onChange: (next) => patch({ images: next }),
    itemId: form.id,
    allItems,
    onNotice,
    contextMenu,
    library,
    undoImages,
  });

  /** 有图片时正文框才让位（见 media.css 顶部那段说明）。 */
  const hasImages = (form.images?.length ?? 0) > 0;

  /**
   * 正文区的右键菜单：键入到光标 / 复制 / 剪切 / 粘贴 / 全选。
   *
   * 用 `useTextAreaMenu` 而不是在这里手写：备忘页的正文框要的是同一套
   * 菜单、同一套"写剪贴板失败就不删正文"的判断。两边各写一遍必然漂移。
   */
  const area = useTextAreaMenu(contextMenu, {
    onTypeInto,
    onNotice,
    copyText: api.copyText,
  });

  useEffect(() => {
    // 打开编辑器就聚焦正文（原来那个 ref 交给 `useTextAreaMenu` 了）。
    // 先判 `typeof !== "function"`：`Ref` 可能是回调形式的 ref，
    // 那种形态没有 `.current`。`useTextAreaMenu` 现在给的是对象形式，
    // 但类型上分不出来，硬断言以后一定会被改坏。
    const el = area.ref;
    if (el && typeof el !== "function") el.current?.focus();
    // 只在挂载时聚焦一次：`area` 每次渲染都是新对象，进依赖会变成"每渲染抢焦点"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 改一个字段。
   *
   * 本地 `form` 保证打字跟手（受控输入框不能等一次 IPC 往返），
   * 同时把整条推给数据。两边是同一份内容，不存在"本地改了但没存"的中间态。
   */
  const patch = (p: Partial<Snippet>) => {
    const next = { ...form, ...p };
    setForm(next);
    onChange(next);
  };

  return (
    <div
      className={`editor${hasImages ? " editor--media" : ""}`}
      // Ctrl+V：剪贴板里有图片就导入，是文字就**完全不碰**（走浏览器原路）。
      // 挂在编辑器根节点上而不是 textarea 上：焦点可能在标题/标签框里，
      // 粘贴事件会从那儿冒泡上来，一处就够。
      onPaste={media.onPaste}
    >
      <div className="editor__head">
        {/* ⚠️ 用户可见的条目名统一叫「笔记」（与页签名一致）。
            页签早就从「文本」改成「笔记」了，条目本身再叫「片段」的话，
            用户会想"片段是什么？和笔记是一回事吗？" —— 一个东西两个名字。
            备忘页那半边已经统一过了（页签叫「备忘」、页内也叫「备忘」），
            这边留着就是唯一的不一致。
            ⚠️ **只改显示文案**：`id: "snippets"`、`snippets.json`、
            `folders.json` 的 `feature` 字段都是数据契约，一个字都不能动。
            代码注释里的「片段」是内部用词，也**不改**（批量改会产生几百行
            纯文本 diff，把真正的改动埋掉）。 */}
        <span>{draft.title ? "编辑笔记" : "新建笔记"}</span>
      </div>

      <label className="field">
        <span className="field__label">标题</span>
        <input
          className="field__input"
          value={form.title}
          placeholder="留空会自动取正文前几个字"
          onChange={(e) => patch({ title: e.target.value })}
        />
      </label>

      <label className="field field--grow">
        <span className="field__label">
          正文
          <em className="field__hint">点「粘贴」时会被送出去的内容</em>
        </span>
        <textarea
          ref={area.ref}
          className="field__input field__input--area"
          value={form.content}
          placeholder="要反复输入的文本、账号、地址、模板…"
          onChange={(e) => patch({ content: e.target.value })}
          // 选中一段文字右键 → 「键入到当前光标」把它打到外部窗口。
          // 没选中时那一项是禁用的（理由见 lib/context-menu.tsx 的 useTextAreaMenu）
          onContextMenu={area.onContextMenu}
        />
      </label>

      {/* 图片区紧跟在正文后面：它和正文一样是"这条笔记的内容" */}
      <MediaSection
        images={form.images ?? []}
        media={media}
        contextMenu={contextMenu}
        onRegisterDrop={registerDrop}
      />

      <label className="field">
        <span className="field__label">
          备注
          <em className="field__hint">也参与搜索，用来帮你以后想起来这条是干什么的</em>
        </span>
        <input
          className="field__input"
          value={form.note}
          placeholder="例如：公司 VPN 账号，2026 年 3 月改过密码"
          onChange={(e) => patch({ note: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field__label">
          标签
          <em className="field__hint">用逗号或空格分隔</em>
        </span>
        <input
          className="field__input"
          value={tagInput}
          placeholder="账号, 工作"
          onChange={(e) => {
            setTagInput(e.target.value);
            // 标签也是数据的一部分，改完立刻一起存（原来只在点「保存」时才拆）
            patch({ tags: parseTags(e.target.value) });
          }}
        />
      </label>

      <div className="editor__flags">
        <label className="check">
          <input
            type="checkbox"
            checked={form.sensitive}
            onChange={(e) => patch({ sensitive: e.target.checked })}
          />
          <span>敏感内容（列表里遮罩显示）</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.starred}
            onChange={(e) => patch({ starred: e.target.checked })}
          />
          <span>收藏置顶</span>
        </label>
      </div>

      <div className="editor__actions">
        <button className="btn" onClick={onDiscard} title="退回打开编辑器时的内容">
          撤销改动
        </button>
        <button
          className="btn btn--primary"
          onClick={onDone}
          // ⚠️ 判据是「正文非空 **或** 有图片」：只有图片的笔记是合法的，
          // 而只判正文的话那条笔记会被这句 `disabled` 拦在「完成」外面 ——
          // 用户贴了图却按不动完成，而且不知道为什么。
          // 「真的空」（没文字也没图片）仍然禁用，空壳条目不写。
          disabled={!hasAnyContent(form.content, form.images)}
          title={
            hasAnyContent(form.content, form.images) ? "" : "正文和图片至少要有一个"
          }
        >
          <Check size={13} />
          完成
        </button>
      </div>
    </div>
  );
}

/** 截断过长文本用于提示。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 注册到功能表。 */
export const SnippetsFeature: FeatureModule = {
  /**
   * ⚠️ `id` **绝对不能改**。它同时是：
   * - `snippets.json` 这个数据文件名的前缀（见 `DATA_FILE`）；
   * - `folders.json` 里每个文件夹的 `feature` 字段值（`Folder.feature`）。
   *
   * 改掉它，用户现有的全部片段和文件夹归属会一次性失联 —— 数据还在盘上，
   * 但界面上一条都看不到。所以「文本」改名成「笔记」只动 `title`：
   * 标题栏面包屑（`PanelWindow.tsx` 的 `active.panelTitle ?? active.title`）、
   * 页签的悬停提示（同文件 `f.description ?? f.title`）、
   * 页签上显示的名字（同文件 `<span>{f.title}</span>`）——
   * 三处全部从 `title` 派生，改这一处就够了。
   *
   * ⚠️ 这里刻意**只写表达式、不写行号**：行号在别的任务改动
   * `PanelWindow.tsx` 之后会静默变成谎话（RV3 报的 F7 就是这么来的，
   * 原来写的是 `:199` / `:196` / `:150-152`，实际已经漂到别处）。
   * 上面三个表达式都能直接 grep 到，不会过期。
   */
  id: "snippets",
  /**
   * 页签显示名。原来叫「文本」，用户要求改成「笔记」。
   *
   * 备忘页原来大量把「笔记」当名词用（"共 N 条笔记"、"编辑笔记"），
   * 两个页签都叫「笔记」会让人分不清，所以那一页的用词一并改成了
   * 「备忘」口径（见 `features/memo/index.tsx`）。
   */
  title: "笔记",
  description: "常用文本、账号、模板，一点就粘贴到光标处",
  icon: Clipboard,
  order: 10,
  component: SnippetsPanel,
};