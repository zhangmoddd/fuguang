/**
 * 快捷链接功能。
 *
 * 解决的问题：常用的软件、文件夹、文档、网址散落在桌面、开始菜单、浏览器收藏夹里，
 * 每次找都要十几秒。这里把它们集中成一面「格子墙」，点一下就在外部打开。
 *
 * 核心设计决策（记录「为什么」，避免以后被改回去）：
 *
 * 1. **纯启动器，绝不把外部程序窗口嵌进面板**。
 *    内嵌窗口是「体积膨胀 + 一堆兼容问题」的来源，用户已明确否决。
 *    所以点击只做一件事：交给 Rust 侧的 `ShellExecuteW` 在外部打开。
 *
 * 2. **悬停小按钮，不做右键菜单**。
 *    `main.tsx` 在 document 的捕获阶段全局 `preventDefault` 了 contextmenu
 *    （为了掐掉 WebView2 自带的「刷新/检查」菜单），自绘菜单要额外和这套逻辑较劲；
 *    而且这里只有「重命名 / 删除」两项，藏进右键反而更难发现。
 *    悬停显示两个小按钮更直接，也不依赖那套被全局拦截的机制。
 *
 * 3. **图标缓存放在模块作用域，不放在组件里**。
 *    提取图标要跨进程调 Rust + 走 Shell/GDI，一次几十毫秒。缓存跟着组件走的话，
 *    每次切页签回来（组件卸载又重挂）都要重来一遍，用户会看到「图标晚一拍才冒出来」。
 *    模块级 Map 在整个 WebView 生命周期内有效，切来切去都是瞬开。
 *    代价是缓存不自动失效——但链接图标是装软件时定下来的，基本不会变。
 *
 * 4. **图标是装饰品，提取失败一律静默降级**成按 kind 区分的内置图标。
 *    Rust 侧也约定「任何失败都返回 null，绝不 panic」，两边口径一致。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Check,
  FileText,
  Folder,
  FolderInput,
  Globe,
  Link2,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  api,
  newId,
  type Folder as FolderItem,
  type IconData,
  type LinkItem,
  type LinkKind,
} from "../../lib/api";
import { FolderBar, FolderEditor, FolderPicker, FolderTiles, useFolders } from "../../lib/folders-ui";
import { allPaths } from "../../lib/dialog";
import { previewOrder, useDragSort } from "../../lib/drag-drop";
import { placeMenu } from "../../lib/menu-position";
import { useZoom } from "../../lib/zoom";
import type { FeatureModule } from "../registry";

import "./links.css";

/** 认作「程序」的扩展名。与「添加程序」文件选择框里的过滤器保持一致。 */
const PROGRAM_EXTENSIONS = new Set(["exe", "lnk", "bat", "cmd"]);

/**
 * 提示条里最多列几条失败原因。
 *
 * 多选之后一次可以失败几十上百条（数据目录不可写、磁盘满），
 * 全部拼进同一个提示条会把它撑到几千像素高，而它是 `flex-shrink: 0`，
 * 被挤没的是下面那面格子墙。剩下的只报数量。
 */
const MAX_LISTED_FAILURES = 3;

/** kind → 内置图标。提取不到真实图标（或本来就是网址）时用它兜底。 */
const KIND_ICON: Record<LinkKind, LucideIcon> = {
  program: AppWindow,
  folder: Folder,
  file: FileText,
  url: Globe,
};

// ===============================================================
// 图标提取与缓存
// ===============================================================

/**
 * target → PNG data URL。
 *
 * 刻意放在模块作用域而不是 useRef：见文件头「设计决策 3」。
 */
const iconCache = new Map<string, string>();

/**
 * 正在飞的提取请求。
 *
 * 网格一次渲染会挂出很多格子，重渲染时同一个 target 可能被请求多次；
 * 用这张表把并发请求合并成一次，避免白白打一串 invoke 出去。
 */
const iconPending = new Map<string, Promise<string | null>>();

/**
 * 把 Rust 给的 RGBA 像素画成 PNG data URL。
 *
 * Rust 侧刻意不引 PNG 编码依赖（本项目对发布体积敏感），
 * 编码这件事交给浏览器 canvas 做最划算。
 */
function encodeIcon(icon: IconData): string | null {
  try {
    const raw = atob(icon.rgbaBase64);
    const need = icon.width * icon.height * 4;
    // 长度对不上就别画了：画出来是花屏，不如老实用内置图标
    if (icon.width <= 0 || icon.height <= 0 || raw.length < need) return null;

    const rgba = new Uint8ClampedArray(need);
    for (let i = 0; i < need; i += 1) rgba[i] = raw.charCodeAt(i);

    const canvas = document.createElement("canvas");
    canvas.width = icon.width;
    canvas.height = icon.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, icon.width, icon.height), 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    // atob 遇到非法 base64 会抛，canvas 也可能因为内存不足失败。
    // 图标只是装饰，任何失败都退回内置图标，不该让整个面板崩掉。
    return null;
  }
}

/** 取图标（带缓存 + 并发去重）。失败返回 null，由调用方用内置图标兜底。 */
function loadIcon(target: string): Promise<string | null> {
  const cached = iconCache.get(target);
  if (cached) return Promise.resolve(cached);

  const pending = iconPending.get(target);
  if (pending) return pending;

  const task = api
    .linkIcon(target)
    .then((icon) => {
      const url = icon ? encodeIcon(icon) : null;
      if (url) iconCache.set(target, url);
      return url;
    })
    // Rust 侧已经约定失败返回 null，这里再兜一层序列化 / 命令名之类的意外
    .catch(() => null)
    .finally(() => {
      iconPending.delete(target);
    });

  iconPending.set(target, task);
  return task;
}

/** 格子里的图标：优先用提取到的真实图标，拿不到就用按类型区分的内置图标。 */
function LinkGlyph({ link }: { link: LinkItem }) {
  // 初始值直接读缓存：命中时连一帧内置图标都不会闪
  const [src, setSrc] = useState<string | null>(() => iconCache.get(link.target) ?? null);

  useEffect(() => {
    // 网址没有可提取的图标（对 http:// 调 SHGetFileInfoW 只会拿到浏览器或默认图标），
    // 直接跳过这次跨进程调用，用 Globe 表达「这是个网址」更贴切。
    if (link.kind === "url") {
      setSrc(null);
      return;
    }

    const cached = iconCache.get(link.target);
    if (cached) {
      setSrc(cached);
      return;
    }

    let alive = true;
    void loadIcon(link.target).then((url) => {
      // 组件可能已经卸载、或 target 已经变了，晚到的结果不能再写进状态
      if (alive && url) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [link.target, link.kind]);

  if (src) {
    return <img className="links__glyph" src={src} alt="" draggable={false} />;
  }

  const Fallback = KIND_ICON[link.kind];
  return (
    <Fallback className="links__glyph links__glyph--builtin" size={26} strokeWidth={1.6} />
  );
}

// ===============================================================
// 小工具
// ===============================================================

/** 把 invoke 抛出来的东西转成能显示的文本。Rust 侧 `Err(String)` 到前端就是纯字符串。 */
function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 路径最后一段去掉扩展名。加链接时的默认名字，绝大多数情况够用了。 */
function baseName(target: string): string {
  // 同时按两种分隔符切：拖进来的可能是 `C:\a\b.exe`，网址里则是 `/`
  const parts = target.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? target;
  // 只对最后一段去扩展名，避免把 `a.b\c` 这种目录名误伤
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** 从网址取一个可读的默认名字（主机名）。 */
function urlName(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * 补全用户输入的网址。
 *
 * 用户往往只打 `example.com`，而 `ShellExecuteW` 对没有协议的字符串会当成**文件路径**
 * 去找（然后报「找不到文件」），所以必须补上协议。
 */
function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;

  // `mailto:` / `steam:` / `ms-settings:` 这类自定义协议也是合法的启动目标，别硬塞 https。
  // 判据是冒号前不能有点号：`example.com:8080` 里点号在冒号前，那是主机名加端口，不是协议。
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme && !scheme[1].includes(".")) return text;

  return `https://${text}`;
}

/** 从路径猜种类（拖拽用）。 */
function kindOfPath(path: string): LinkKind {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (PROGRAM_EXTENSIONS.has(ext)) return "program";

  // 前端拿不到「这是不是目录」：Tauri 2 的拖放事件只给路径字符串，不查文件系统就没有目录信息。
  // 这里按约定简化——扩展名对不上就当普通文件。
  // 取舍代价很小：kind 只决定「用哪个默认图标」，不影响打开行为
  // （ShellExecuteW 对文件夹和文档走的是同一套默认关联）。
  return "file";
}

/** 与 Rust 侧 `links_list` 保持一致的排序：order 小的在前，同 order 按创建时间。 */
function sortLinks(list: LinkItem[]): LinkItem[] {
  return [...list].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/**
 * 按 id 顺序重排一批条目。
 *
 * `orderById` 和 `previewOrder`（在 `lib/drag-drop.ts`）是一对：
 * 前者只负责"按给定 id 顺序取出来"，后者只负责"算出新顺序"。
 * 分开是因为 `previewOrder` 是纯字符串运算、可以单测，
 * 而这里要跟具体的数据类型打交道。
 *
 * id 对不上的（数据刚变过、被删了）直接跳过，不会渲染出一个空壳。
 */
function orderById<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids
    .map((id) => byId.get(id))
    .filter((item): item is T => item !== undefined);
}

/** 一次添加请求。拖拽可以一次进来好几个文件，所以按批处理。 */
interface Draft {
  target: string;
  kind: LinkKind;
  /** 用户手动起的名字；留空则按路径/网址推导。 */
  name?: string;
}

/** 一条提示。成功提示会自动消失，错误提示留着让用户读完。 */
interface Notice {
  kind: "ok" | "error";
  text: string;
}

// ===============================================================
// 主界面
// ===============================================================

export function LinksPanel() {
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  /** 读盘失败。和操作提示分开：它表示「数据都没拿到」，性质不同。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 正在启动的那一条。用来压暗格子，避免用户以为「点了没反应」而连点。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * 正在就地编辑的那条链接，以及它的草稿。
   *
   * 三个字段一起编辑（名字 / 目标 / 启动参数）：原来分成"重命名"和"启动参数"
   * 两个独立的小编辑器，而**目标路径根本没有入口** —— 路径写错只能删了重加。
   * 别的页签的铅笔都是"打开完整编辑面"，这里也统一成一样。
   */
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", target: "", args: "" });
  /** 网址是「名称 + 网址」两个字段，用内联表单而不是 window.prompt：
   *  prompt 在 WebView2 里是浏览器样式的弹框，和面板风格完全不搭，也无法校验。 */
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlForm, setUrlForm] = useState({ name: "", url: "" });
  /** 拖拽能力是否可用。不可用时要把界面上的拖拽提示撤掉，免得用户以为坏了。 */
  const [dragAvailable, setDragAvailable] = useState(true);
  /** 拖拽悬停中，用来高亮整块区域。 */
  const [dragActive, setDragActive] = useState(false);
  /** 文件夹弹层。`target` 为 `null` 表示新建，否则是改名/改备注。 */
  const [folderEditor, setFolderEditor] = useState<{
    open: boolean;
    target: FolderItem | null;
  }>({ open: false, target: null });
  /** 正在「移动到…」的那条链接。 */
  const [movingId, setMovingId] = useState<string | null>(null);
  /**
   * 右上角「⋯」菜单：是哪一条、以及那个按钮的矩形（用来把菜单贴着它展开）。
   *
   * 存矩形而不是存"上/下"两个坐标：面板宽度固定 420，但格子可能在任意一行，
   * 菜单要按按钮的实际位置决定往上还是往下翻。
   */
  const [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null);

  /**
   * 这次编辑是否已被取消（按了 Esc）。
   *
   * 取消会让输入框卸载、紧接着触发一次 blur，而 blur 的语义是「保存」。
   * 没有这个闸门的话，「Esc 取消」会被随后的 blur 又存回去。
   */
  const editAborted = useRef(false);
  /** 正在编辑的 id（ref 版）。Enter 提交后紧跟的 blur 要靠它判断「已经结束了，别再存一次」。 */
  const editRef = useRef<string | null>(null);

  // ---- 数据 ----

  const reload = useCallback(async () => {
    try {
      const list = await api.linksList();
      setLinks(sortLinks(list));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ---- 文件夹与缩放 ----

  /**
   * 把本页签在 `from` 文件夹下的链接改挂到 `to`。
   *
   * 只在删除文件夹时被调用。条目为什么由前端搬而不是 Rust 一起做，
   * 见 `lib/folders-ui.tsx` 与 `commands::folder_remove` 的说明。
   */
  const moveItems = useCallback(
    async (from: string, to: string | null) => {
      const updated = links
        .filter((l) => l.folderId === from)
        .map((l) => ({ ...l, folderId: to }));
      for (const link of updated) await api.linkSave(link);
      if (updated.length === 0) return;
      setLinks((prev) => prev.map((l) => updated.find((u) => u.id === l.id) ?? l));
    },
    [links],
  );

  const folders = useFolders("links", { moveItems });
  const zoom = useZoom("links");

  /**
   * 当前文件夹里该显示的链接。
   *
   * `folderId` 指向一个**不存在**的文件夹时按顶层处理：删文件夹中途失败、
   * 或用户手改过 JSON 都会留下这种条目。不兜的话它们会从界面上消失，
   * 而数据其实还在。
   */
  const visible = useMemo(() => {
    const known = new Set(folders.mine.map((f) => f.id));
    return links.filter((l) => {
      const folder = l.folderId && known.has(l.folderId) ? l.folderId : null;
      return folder === folders.currentId;
    });
  }, [links, folders.mine, folders.currentId]);

  /** 每个文件夹里有几条链接，显示在文件夹卡片上（只算直接子级）。 */
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of links) {
      if (l.folderId) counts[l.folderId] = (counts[l.folderId] ?? 0) + 1;
    }
    return counts;
  }, [links]);

  /**
   * 把 `draggedId` 插到 `targetId` 前面或后面，并给这一层重新编号。
   *
   * `order` 只在**同一层内**比较，所以直接重排成 `0..n-1` 就行——
   * 不同文件夹之间即使 order 撞车也不会同时显示，看不出问题。
   */
  const reorderLinks = async (draggedId: string, targetId: string, before: boolean) => {
    if (draggedId === targetId) return;

    const list = [...visible];
    const from = list.findIndex((l) => l.id === draggedId);
    if (from < 0) return;
    const [moved] = list.splice(from, 1);
    const at = list.findIndex((l) => l.id === targetId);
    if (at < 0) return;
    list.splice(before ? at : at + 1, 0, moved);

    // 只写 order 真的变了的那些：整层重写一遍会产生一堆无意义的磁盘写入
    const changed = list
      .map((link, order) => ({ link, order }))
      .filter(({ link, order }) => link.order !== order);
    if (changed.length === 0) return;

    try {
      for (const { link, order } of changed) await api.linkSave({ ...link, order });
      /**
       * ⚠️ 必须**重新排序数组**，不能只改每条 link 的 `order` 字段。
       *
       * 这里原来只写了 `prev.map(...)`（原地替换那几条的 order），而 `visible`
       * 是直接 `filter(links)` —— 数组顺序没变，界面上的顺序也就没变。
       * 表现是：拖动时空位会动（那是渲染时的预览顺序），一松手格子**弹回原位**，
       * 看起来就是"拖了没反应"。要等切页签/重启重新 `reload()` 才会看到新顺序。
       *
       * 用 `sortLinks` 而不是手动拼：它和 Rust 侧 `links_list` 的排序规则
       * （order 小的在前，同 order 按 createdAt）是同一套，不会出现
       * "界面一个顺序、重启后另一个顺序"。
       */
      setLinks((prev) =>
        sortLinks(
          prev.map((l) => {
            const hit = changed.find((c) => c.link.id === l.id);
            return hit ? { ...l, order: hit.order } : l;
          }),
        ),
      );
      setNotice({ kind: "ok", text: "已重新排序" });
    } catch (err) {
      setNotice({ kind: "error", text: `排序失败：${errorText(err)}` });
    }
  };

  /**
   * 拖拽：条目之间排序，或者把条目放进文件夹；文件夹自己也能同级排序。
   *
   * 链接页是网格，所以"插到前面还是后面"看**横轴**（见 `useDragSort` 的 axis）。
   * 用的是指针事件自绘，不是 HTML5 拖放——原因见 `lib/drag-drop.ts`。
   */
  const drag = useDragSort({
    axis: "horizontal",
    onDrop: (draggedId, draggedKind, spot) => {
      if (draggedKind === "folder") {
        // 拖文件夹时候选全是 item 类型（见 useDragSort 的 collect），
        // 落点就是"插到那个文件夹的前面/后面"
        if (spot.kind === "item") void folders.reorder(draggedId, spot.id, spot.before);
        return;
      }
      if (spot.kind === "folder") {
        const link = links.find((l) => l.id === draggedId);
        if (link) void moveTo(link, spot.id);
        return;
      }
      void reorderLinks(draggedId, spot.id, spot.before);
    },
    // 只排除那一排悬停操作按钮和就地编辑框。
    // 页面这一层只是**追加**排除项，真正兜底的是 drag-drop 里的控件底线
    // （见 CONTROL_SELECTOR）：格子本体是个按钮、但显式标了拖拽抓手，
    // 所以它仍然能拖；「⋯」和输入框没有抓手，老老实实是控件。
    ignoreSelector: ".links__more, input",
  });

  // 成功提示看一眼就够，2.4 秒自动消失；
  // 错误提示不自动消失——Rust 返回的「找不到文件，可能已被移动或删除」需要时间读完。
  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const t = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** 落盘并同步界面。所有写操作都走这里，保证「界面看到的」和「磁盘上存的」一致。 */
  const persist = useCallback(async (link: LinkItem, okText: string) => {
    try {
      await api.linkSave(link);
      setLinks((prev) => {
        const exists = prev.some((l) => l.id === link.id);
        return exists ? prev.map((l) => (l.id === link.id ? link : l)) : [...prev, link];
      });
      setNotice({ kind: "ok", text: okText });
    } catch (err) {
      setNotice({ kind: "error", text: `保存失败：${errorText(err)}` });
    }
  }, []);

  /**
   * 批量新增。
   *
   * 拖拽一次可能丢进来好几个文件，必须一次性算 order：
   * 逐个算的话，后面的调用读到的还是旧的 links（React 状态要等重渲染才更新），
   * 会拿到同一个 order，最后只能按 createdAt 排——而它们的时间戳可能是同一毫秒，顺序就乱了。
   */
  const addMany = useCallback(
    async (items: Draft[]) => {
      if (items.length === 0) return;

      const base = links.reduce((max, l) => Math.max(max, l.order), -1) + 1;
      const now = Date.now();
      const drafts: LinkItem[] = items.map((item, i) => ({
        id: newId(),
        // 名字默认取路径最后一段（去掉扩展名）或网址主机名，用户手动填了就用用户的
        name:
          item.name?.trim() ||
          (item.kind === "url" ? urlName(item.target) : baseName(item.target)),
        target: item.target,
        args: null,
        kind: item.kind,
        // 新加的链接落在**当前所在的那个文件夹**里。
        // 这是下钻浏览的自然语义：进去了再添加，东西就该在那一层。
        folderId: folders.currentId,
        // 同一次批量里依次 +1，保证顺序稳定（时间戳可能同毫秒，排不出先后）
        order: base + i,
        createdAt: now + i,
      }));

      const saved: LinkItem[] = [];
      const failures: string[] = [];
      for (const draft of drafts) {
        try {
          await api.linkSave(draft);
          saved.push(draft);
        } catch (err) {
          failures.push(`「${draft.name}」${errorText(err)}`);
        }
      }

      if (saved.length > 0) {
        setLinks((prev) => sortLinks([...prev, ...saved]));
      }

      if (failures.length > 0) {
        // 只列前几条。多选之后一次可以失败几十上百条，全拼进提示条会把它撑成
        // 几千像素高 —— 而提示条是 `flex-shrink: 0`，被挤没的正是下面那面格子墙。
        const shown = failures.slice(0, MAX_LISTED_FAILURES);
        const more = failures.length - shown.length;
        setNotice({
          kind: "error",
          text: `有 ${failures.length} 条没存上：${shown.join("；")}${more > 0 ? `；…… 还有 ${more} 条` : ""}`,
        });
      } else {
        setNotice({
          kind: "ok",
          text: saved.length === 1 ? `已添加「${saved[0].name}」` : `已添加 ${saved.length} 个链接`,
        });
      }
    },
    [links, folders.currentId],
  );

  // ---- 拖拽添加 ----

  /**
   * 拖进来的路径：先让 Rust 判类型，再加。
   *
   * 原来只按扩展名猜，于是拖进来的**文件夹一律被当成「文件」**，图标不对
   * （README 的已知限制里记着这条）。判类型要读文件系统属性，只有 Rust 能做。
   */
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const kinds = await api.classifyPaths(paths);
        await addMany(paths.map((p, i) => ({ target: p, kind: kinds[i] ?? "file" })));
      } catch {
        // 判类型失败不该拦住添加：退回按扩展名猜，行为和以前完全一样
        await addMany(paths.map((p) => ({ target: p, kind: kindOfPath(p) })));
      }
    },
    [addMany],
  );

  /**
   * 拖放处理器放在 ref 里，只让「注册监听」的 effect 依赖空数组。
   *
   * 处理器需要用到最新的 links（算 order）。如果把它写进 effect 的依赖，
   * 每次数据变化都要重新订阅一次，中间那几十毫秒里拖进来的文件会被丢掉。
   */
  const dropRef = useRef<(paths: string[]) => void>(() => {});
  // 每次渲染后刷新 ref，处理器永远是最新那份闭包
  useEffect(() => {
    dropRef.current = (paths: string[]) => {
      void addPaths(paths);
    };
  });

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void (async () => {
      try {
        // 用 Tauri 的拖放事件，不用 HTML5 的 drop：
        // 后者在 Tauri 里拿不到真实文件路径（`dataTransfer.files` 里是空壳对象），
        // 拿不到路径这个功能就没法做。
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDragActive(true);
          } else if (payload.type === "drop") {
            setDragActive(false);
            dropRef.current(payload.paths);
          } else {
            // leave：拖到一半又拖出去了
            setDragActive(false);
          }
        });

        // 竞态：await 期间组件可能已经卸载了，那就当场退订，别把监听漏在外面
        if (disposed) stop();
        else unlisten = stop;
      } catch (err) {
        // 拿不到拖放能力（旧版 Tauri、或配置里关了 dragDrop）就退化成「只能点按钮加」。
        // 界面上的拖拽提示必须撤掉：留着提示但拖进来没反应，比没有提示更糟。
        setDragAvailable(false);
        console.warn("文件拖放不可用，已退化为按钮添加", err);
      }
    })();

    return () => {
      disposed = true;
      // 组件卸载必须退订，否则面板反复开关会累积一堆监听器
      unlisten?.();
    };
  }, []);

  // ---- 文件选择框 ----

  /**
   * 统一兜住选择框本身的失败。
   *
   * 插件命令是要过 Tauri 权限表的，权限没配时 `open()` 会直接 reject。
   * 不 catch 的话用户点「添加程序」会毫无反应，那是最难排查的一种故障。
   */
  const runPicker = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      setNotice({ kind: "error", text: `打开文件选择框失败：${errorText(err)}` });
    }
  };

  const addProgram = () =>
    runPicker(async () => {
      const picked = allPaths(
        await open({
          multiple: true,
          directory: false,
          filters: [{ name: "程序", extensions: ["exe", "lnk", "bat", "cmd"] }],
        }),
      );
      if (picked.length > 0) await addMany(picked.map((p) => ({ target: p, kind: "program" })));
    });

  const addFolder = () =>
    runPicker(async () => {
      const picked = allPaths(await open({ directory: true, multiple: true }));
      if (picked.length > 0) await addMany(picked.map((p) => ({ target: p, kind: "folder" })));
    });

  const addFile = () =>
    runPicker(async () => {
      const picked = allPaths(await open({ multiple: true }));
      if (picked.length > 0) await addMany(picked.map((p) => ({ target: p, kind: "file" })));
    });

  const submitUrl = async () => {
    const target = normalizeUrl(urlForm.url);
    if (!target) return;
    await addMany([{ target, kind: "url", name: urlForm.name }]);
    setUrlForm({ name: "", url: "" });
    setUrlOpen(false);
  };

  // ---- 对单条链接的操作 ----

  const launch = async (link: LinkItem) => {
    setBusyId(link.id);
    try {
      await api.linkLaunch(link.id);
      // 打开成功就没什么好说的：面板马上就失焦了，再留个绿条反而碍事
      setNotice(null);
    } catch (err) {
      // Rust 侧给的就是中文人话（「打开「xxx」失败：找不到文件，可能已被移动或删除」），
      // 直接用，不要再包一层「操作失败」把原因挤掉
      setNotice({ kind: "error", text: errorText(err) });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (link: LinkItem) => {
    try {
      await api.linkRemove(link.id);
      setLinks((prev) => prev.filter((l) => l.id !== link.id));
      // 图标缓存不删：删掉再加回来是很常见的操作（比如路径记错了），留着能秒出图标
      setNotice({ kind: "ok", text: `已删除「${link.name}」` });
    } catch (err) {
      setNotice({ kind: "error", text: `删除失败：${errorText(err)}` });
    }
  };

  /**
   * 把一条链接移到别的文件夹。`null` 表示移到顶层。
   *
   * 有了这个，「分类」才是完整的：不然新链接只能落在建它时所在的文件夹里，
   * 想把已有的东西归类只能删了重加。
   */
  const moveTo = async (link: LinkItem, folderId: string | null) => {
    setMovingId(null);
    // 选的就是它现在待的那一层：什么都不做，也省一次白写的磁盘
    if ((link.folderId ?? null) === folderId) return;
    await persist({ ...link, folderId }, `已移动「${link.name}」`);
  };

  // ---- 就地编辑（名字 / 目标 / 启动参数）----

  const startEdit = (link: LinkItem) => {
    setMenu(null);
    editAborted.current = false;
    editRef.current = link.id;
    setEditId(link.id);
    setEditDraft({ name: link.name, target: link.target, args: link.args ?? "" });
  };

  const cancelEdit = () => {
    editAborted.current = true;
    editRef.current = null;
    setEditId(null);
  };

  /** 编辑框里的键盘约定：回车保存、Esc 取消。三个输入框共用。 */
  const onEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // 主面板把 Esc 当「收起面板」的全局快捷键（见 PanelWindow.tsx）。
      // 这里按 Esc 的意图只是取消这次编辑，所以别让它冒泡到 window。
      e.stopPropagation();
      cancelEdit();
    }
    // 回车交给 `onBlur` 走同一条路：在这里直接提交的话，
    // 输入框卸载又会触发一次 blur，两次提交要靠 `editRef` 那个闸门挡，
    // 与其两处都写一遍，不如只留 blur 一条路（它在回车时也会被触发）。
  };

  const commitLinkEdit = async (link: LinkItem) => {
    // Enter 提交之后输入框会卸载并触发 blur，这里挡掉第二次提交
    if (editRef.current !== link.id) return;
    editRef.current = null;
    setEditId(null);

    if (editAborted.current) {
      editAborted.current = false;
      return;
    }

    const name = editDraft.name.trim() || link.name;
    const rawTarget = editDraft.target.trim() || link.target;
    const argsText = editDraft.args.trim();
    // 空串存成 null：模型里 null 表示「没有参数」。
    // 存空串会让「到底有没有参数」变得没法判断，界面上也说不清。
    const args = argsText === "" ? null : argsText;

    /**
     * 目标变了要**重新判一次类型**，否则图标和"怎么启动"会跟实际对不上：
     * 把一条 .txt 改成 .exe 之后，它仍然按「文件」显示内置图标。
     *
     * 网址不走文件系统判定：`classify_paths` 对 `https://…` 只会拿到
     * 浏览器的默认图标，而且网址还得补全协议。
     */
    let target = rawTarget;
    let kind = link.kind;
    if (rawTarget !== link.target) {
      if (link.kind === "url") {
        target = normalizeUrl(rawTarget);
      } else {
        try {
          kind = (await api.classifyPaths([rawTarget]))[0] ?? link.kind;
        } catch {
          // 判不出来就保留原来的类型：图标不准总比"改不了"好
        }
      }
    }

    if (name === link.name && target === link.target && args === (link.args ?? null)) return;
    await persist({ ...link, name, target, args, kind }, "已保存");
  };

  // ---- 渲染 ----

  /**
   * 「⋯」菜单要操作的那条链接。
   *
   * 每次都从 `links` 里现查，而不是把整条存进 `menu`：存下来的话，
   * 菜单开着的时候数据一变（重命名提交、图标提取回来）它就成了一份陈旧快照。
   * 查不到（被删了）就当菜单没开。
   */
  const menuLink = menu ? links.find((l) => l.id === menu.id) ?? null : null;

  /**
   * 让位之后的渲染顺序。
   *
   * 被拖的那个**也在数组里** —— 渲染时把它画成一个空位（虚框），
   * 其余格子让开，这就是手机桌面拖图标的样子。
   *
   * 用 `drag.over` 而不是"最近一次命中的落点"：落点判定（`resolveSortSpot`）
   * 现在是**离指针最近的那一条**、而且每次都按当前布局重新量，
   * 所以指针在哪，空位就在哪，不会出现"指到这儿、空位在别处"。
   */
  const orderedFolders = useMemo(
    () =>
      orderById(
        folders.children,
        previewOrder(
          folders.children.map((f) => f.id),
          drag.draggingId ?? "",
          drag.over,
        ),
      ),
    [folders.children, drag.draggingId, drag.over],
  );

  const orderedLinks = useMemo(
    () =>
      orderById(
        visible,
        previewOrder(
          visible.map((l) => l.id),
          drag.draggingId ?? "",
          drag.over,
        ),
      ),
    [visible, drag.draggingId, drag.over],
  );

  /** 跟手浮层里的那一条：链接或文件夹，取决于正在拖的是什么。 */
  const ghostLink = drag.draggingId
    ? visible.find((l) => l.id === drag.draggingId) ?? null
    : null;
  const ghostFolder = drag.draggingId
    ? folders.children.find((f) => f.id === drag.draggingId) ?? null
    : null;

  return (
    <div
      className="links"
      // 滚轮监听挂在整页根节点上而不是只挂网格：鼠标停在文件夹卡片、
      // 添加栏上时也应该能缩放。普通滚轮不受影响（见 lib/zoom.ts）。
      ref={zoom.ref}
      style={{ "--tile-scale": String(zoom.percent / 100) } as CSSProperties}
    >
      {/* 添加栏：四个入口平分一行 */}
      <div className="links__addbar">
        <button
          className="btn"
          onClick={() => void addProgram()}
          title="选择程序，可按住 Ctrl / Shift 一次选多个（.exe / .lnk / .bat / .cmd）"
        >
          <AppWindow size={12} />
          程序
        </button>
        <button
          className="btn"
          onClick={() => void addFolder()}
          title="选择文件夹，可按住 Ctrl / Shift 一次选多个"
        >
          <Folder size={12} />
          文件夹
        </button>
        <button
          className="btn"
          onClick={() => void addFile()}
          title="选择任意文件（文档、图片…），可按住 Ctrl / Shift 一次选多个"
        >
          <FileText size={12} />
          文件
        </button>
        <button className="btn" onClick={() => setUrlOpen(true)} title="手动填一个网址">
          <Globe size={12} />
          网址
        </button>
      </div>

      {urlOpen && (
        <div className="links__urlform">
          <label className="field">
            <span className="field__label">
              名称
              <em className="field__hint">留空就用网址本身</em>
            </span>
            <input
              className="field__input"
              autoFocus
              value={urlForm.name}
              placeholder="例如：公司内网"
              onChange={(e) => setUrlForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>

          <label className="field">
            <span className="field__label">网址</span>
            <input
              className="field__input"
              value={urlForm.url}
              placeholder="example.com，或者 https://…"
              onChange={(e) => setUrlForm((f) => ({ ...f, url: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitUrl();
                if (e.key === "Escape") {
                  // 同重命名输入框：Esc 只用来关掉这个表单，别触发主面板的「收起面板」
                  e.stopPropagation();
                  setUrlOpen(false);
                }
              }}
            />
          </label>

          <div className="links__urlform-actions">
            <button className="btn" onClick={() => setUrlOpen(false)}>
              <X size={12} />
              取消
            </button>
            <button
              className="btn btn--primary"
              disabled={!urlForm.url.trim()}
              onClick={() => void submitUrl()}
            >
              <Check size={12} />
              添加
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className={`links__notice${notice.kind === "error" ? " links__notice--error" : ""}`}>
          {notice.kind === "error" ? <TriangleAlert size={13} /> : <Check size={13} />}
          <span>{notice.text}</span>
        </div>
      )}

      {loadError && (
        <div className="links__notice links__notice--error">
          <TriangleAlert size={13} />
          <span>数据读取失败：{loadError}</span>
        </div>
      )}

      {/* 当前路径。放在内容区正上方：先看到「我在哪」，再看这一层有什么 */}
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
        <div className="links__notice links__notice--error">
          <TriangleAlert size={13} />
          <span>文件夹出错：{folders.error}</span>
        </div>
      )}

      <div className={`links__grid${dragActive ? " links__grid--drop" : ""}`}>
        {/* 子文件夹排在链接前面，和资源管理器一致。
            FolderTiles 返回的是一排卡片、不带外层容器，所以能直接当网格子项用 */}
        <FolderTiles
          folders={orderedFolders}
          counts={folderCounts}
          dropTargetId={drag.over?.kind === "folder" ? drag.over.id : null}
          dragProps={(id) => drag.handleProps(id, "folder")}
          onEnter={folders.enter}
          onEdit={(f) => setFolderEditor({ open: true, target: f })}
          onRemove={(f) => void folders.remove(f)}
          variant="grid"
          gapId={drag.draggingId}
        />

        {loading && <div className="links__hint">正在读取数据…</div>}

        {!loading && links.length === 0 && (
          <div className="links__empty">
            <Link2 size={26} />
            <p>还没有任何链接。</p>
            <p>
              点上面的按钮挑程序、文件夹或文件（都可以一次选多个）
              {dragAvailable ? "，也可以直接把它们拖进这个面板。" : "。"}
            </p>
          </div>
        )}

        {/* 有链接、但当前这一层是空的：要说清"是这一层空"而不是"一条都没有"，
            否则用户会以为数据丢了 */}
        {!loading &&
          links.length > 0 &&
          visible.length === 0 &&
          folders.children.length === 0 && (
            <div className="links__empty">
              <Folder size={26} />
              <p>{folders.currentId ? "这个文件夹里还没有链接。" : "这一层还没有链接。"}</p>
              <p>用上面的按钮添加，或者点文件夹卡片进去。</p>
            </div>
          )}

        {orderedLinks.map((link) => {
          // 正在被拖的那个：留一个虚框，其余格子让开。
          // 它不再是投放目标，也不该被点中 —— 用户手里正拎着它。
          if (link.id === drag.draggingId) {
            return <div className="links__gap drag-gap" key={link.id} aria-hidden />;
          }

          /**
           * 就地编辑：**整行宽**，而且能改**全部**可改字段（名字 / 目标 / 启动参数）。
           *
           * 两个理由：
           * 1. 原来是挤在格子里的小输入框 —— 默认档位一格只有 86~95px 宽，
           *    稍微长一点的名字根本看不全（用户反馈「重命名也一样看不完全文字」）。
           *    整行宽之后有 400px 可用，位置还在原来那一格上。
           * 2. 原来「重命名」只能改名字、**目标路径根本没有编辑入口** ——
           *    路径写错（这功能最常见的输入错误）只能删了重加，
           *    而重加要走一次文件选择框。别的页签的铅笔都是"打开完整编辑面"，
           *    这里也该是。
           */
          if (editId === link.id) {
            return (
              <div className="links__editor" key={link.id}>
                <LinkGlyph link={link} />

                <div className="links__editfields">
                  <label className="links__editrow">
                    <span className="links__editlabel">名字</span>
                    <input
                      className="links__editinput"
                      autoFocus
                      value={editDraft.name}
                      placeholder={link.name}
                      onChange={(e) =>
                        setEditDraft((d) => ({ ...d, name: e.target.value }))
                      }
                      onKeyDown={onEditKeyDown}
                      onBlur={() => void commitLinkEdit(link)}
                    />
                  </label>

                  <label className="links__editrow">
                    <span className="links__editlabel">目标</span>
                    <input
                      className="links__editinput"
                      value={editDraft.target}
                      title={link.target}
                      onChange={(e) =>
                        setEditDraft((d) => ({ ...d, target: e.target.value }))
                      }
                      onKeyDown={onEditKeyDown}
                      onBlur={() => void commitLinkEdit(link)}
                    />
                  </label>

                  {/* 启动参数只对程序和文件有意义；网址加了也没人消费 */}
                  {link.kind !== "url" && (
                    <label className="links__editrow">
                      <span className="links__editlabel">参数</span>
                      <input
                        className="links__editinput"
                        value={editDraft.args}
                        placeholder="留空表示不带参数，例如 --profile work"
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, args: e.target.value }))
                        }
                        onKeyDown={onEditKeyDown}
                        onBlur={() => void commitLinkEdit(link)}
                      />
                    </label>
                  )}

                  <em className="links__edithint">回车保存 · Esc 取消</em>
                </div>
              </div>
            );
          }

          return (
            <article
              key={link.id}
              className={[
                "links__tile",
                busyId === link.id ? "links__tile--busy" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={link.args ? `${link.target}\n参数：${link.args}` : link.target}
              {...drag.itemProps(link.id)}
            >
              <button
                // 拖拽抓手：这个按钮就是链接格子的可拖区域。
                // **必须显式标出来** —— drag-drop 里有一条内置的控件底线会拦掉
                // 所有按钮（就是为了防"点删除变成拖卡片"），不标的话链接页
                // 整个就拖不动了。属性名与 lib/drag-drop.ts 的 DRAG_HANDLE_ATTR 一致。
                data-drag-handle
                className="links__tile-body links__open"
                disabled={busyId === link.id}
                onClick={() => {
                  // 拖完松手会紧跟一次 click。不吞掉的话，把链接拖进文件夹之后
                  // 会顺手把它打开——用户完全预料不到。
                  if (drag.consumeClick()) return;
                  void launch(link);
                }}
                title={`打开：${link.target}`}
              >
                <LinkGlyph link={link} />
                <span className="links__name">{link.name}</span>
              </button>

              {/* 悬停才出现。**只占右上角 20px**：
                  原来这里是一排四个图标按钮（加起来 83px），而格子默认只有
                  86~95px 宽 —— 鼠标一移上去按钮就铺满整格，把图标和名字压在
                  下面（用户反馈「放上去第一个字都有点看不清」）。
                  收成一个「⋯」之后，格子的内容始终看得见。 */}
              <button
                className="iconbtn links__more"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu({ id: link.id, rect: e.currentTarget.getBoundingClientRect() });
                }}
                title="更多操作"
              >
                <MoreHorizontal size={13} />
              </button>
            </article>
          );
        })}
      </div>

      {dragAvailable && !loading && links.length > 0 && (
        <div className="links__footer">把文件或文件夹拖进面板也能添加</div>
      )}

      {/* 跟手的浮层：被拖的那一格"提起来"跟着指针走。
          尺寸用按下那一刻量好的（`sourceSize`），因为原处已经被换成空位了。
          它不吃指针事件（见 .drag-ghost 的说明），所以落点判定不受影响。 */}
      {drag.draggingId && drag.pointer && drag.sourceSize && (
        <div
          className="links__ghost drag-ghost"
          style={{
            left: drag.pointer.x,
            top: drag.pointer.y,
            width: drag.sourceSize.width,
            height: drag.sourceSize.height,
          }}
        >
          {ghostLink ? (
            <>
              <LinkGlyph link={ghostLink} />
              <span className="links__name">{ghostLink.name}</span>
            </>
          ) : ghostFolder ? (
            <>
              <Folder size={24} strokeWidth={1.6} className="links__glyph links__glyph--builtin" />
              <span className="links__name">{ghostFolder.name}</span>
            </>
          ) : null}
        </div>
      )}

      {movingId && (
        <FolderPicker
          folders={folders.mine}
          current={links.find((l) => l.id === movingId)?.folderId ?? null}
          onPick={(id) => {
            const link = links.find((l) => l.id === movingId);
            if (link) void moveTo(link, id);
            else setMovingId(null);
          }}
          onClose={() => setMovingId(null)}
        />
      )}

      {menu && menuLink && (
        <LinkMenu
          link={menuLink}
          anchor={menu.rect}
          onClose={() => setMenu(null)}
          onMove={() => {
            setMenu(null);
            setMovingId(menuLink.id);
          }}
          onEdit={() => startEdit(menuLink)}
          onRemove={() => {
            setMenu(null);
            void remove(menuLink);
          }}
        />
      )}
    </div>
  );
}

// ===============================================================
// 「⋯」菜单
// ===============================================================

/**
 * 格子右上角那个「⋯」点开的小菜单。
 *
 * # 为什么不再是一排四个图标按钮
 *
 * 链接页默认档位一格只有 86~95px 宽，而四个 20px 的按钮加起来 83px ——
 * 鼠标一移上去，按钮几乎铺满整格，把图标和名字压在下面（用户反馈
 * 「放上去第一个字都有点看不清」）。收成一个「⋯」之后悬停只占右上角 20px。
 *
 * # 为什么菜单里写文字而不是只放图标
 *
 * 图标按钮的问题是**得先悬停看 tooltip 才知道是什么**，而那个 tooltip 又会
 * 盖住格子的名字。写成「移动到文件夹 / 启动参数 / 重命名 / 删除」之后一眼就
 * 知道有什么可用 —— 用户原来就问过「这个启动参数是什么」。
 *
 * # 为什么不用整屏遮罩
 *
 * 四个动作的小菜单用遮罩把面板压暗太重了（`FolderPicker` 用遮罩是因为它
 * 是"选一个目标"的模态选择）。这里改成在 document 上挂一个捕获阶段的
 * `pointerdown`，点到菜单外面就关 —— 和 `FolderEditor` 同一个做法。
 * 挂监听是在渲染之后的 effect 里，所以**不会**被"点开菜单的那一次 pointerdown"
 * 立刻关掉。
 */
function LinkMenu({
  link,
  anchor,
  onClose,
  onMove,
  onEdit,
  onRemove,
}: {
  link: LinkItem;
  anchor: DOMRect;
  onClose: () => void;
  onMove: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const box = boxRef.current;
      if (box && !box.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 同就地编辑：Esc 只关这一层，别连带把整个面板收起来
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  /**
   * 贴住「⋯」按钮定位，但不许出面板。
   *
   * 必须**量完之后**再摆：菜单高度取决于有没有「启动参数」那一行
   * （网址没有），写死高度会让最后一行的菜单翻错方向。
   * 用 `useLayoutEffect` 是为了在浏览器绘制之前就摆好，用户看不到闪一下。
   * 坐标怎么算是纯函数（`lib/menu-position.ts`），有单测兜着边缘情况。
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    setPos(
      placeMenu(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  return (
    <div
      className="linkmenu"
      ref={boxRef}
      // 量之前先藏起来，避免"先出现在左上角再跳过去"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      // 菜单内部的点击不该冒泡到别处（例如格子的"点开"）
      onClick={(e) => e.stopPropagation()}
    >
      {/* 把整条名字显示出来：格子里的名字最多两行、会被截断，
          这里是用户唯一能看到全名的地方 */}
      <div className="linkmenu__title" title={link.target}>
        {link.name}
      </div>

      <button type="button" className="linkmenu__row" onClick={onMove}>
        <FolderInput size={13} />
        移动到文件夹
      </button>

      {/* 一个「编辑」打开**全部可改字段**（名字 / 目标 / 启动参数）。
          原来拆成「重命名」和「启动参数」两项，而**目标路径根本没有入口** ——
          路径写错只能删了重加。别的页签的铅笔都是"打开完整编辑面"，这里统一。 */}
      <button type="button" className="linkmenu__row" onClick={onEdit}>
        <Pencil size={13} />
        编辑
        <em className="linkmenu__aside">
          {link.kind === "url" ? "名字 / 网址" : "名字 / 路径 / 参数"}
        </em>
      </button>

      <button
        type="button"
        className="linkmenu__row linkmenu__row--danger"
        onClick={onRemove}
      >
        <Trash2 size={13} />
        删除
      </button>
    </div>
  );
}

/** 注册到功能表。 */
export const LinksFeature: FeatureModule = {
  id: "links",
  title: "链接",
  description: "常用软件、文件夹、网址，一点就开",
  icon: Link2,
  order: 40,
  component: LinksPanel,
};
