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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Check,
  FileText,
  Folder,
  FolderInput,
  Globe,
  Link2,
  Pencil,
  Terminal,
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
import { useDragSort } from "../../lib/drag-drop";
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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
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
  /** 正在编辑启动参数的那条链接。 */
  const [argsId, setArgsId] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("");

  /**
   * 重命名是否已被取消（按了 Esc）。
   *
   * 取消会让输入框卸载、紧接着触发一次 blur，而 blur 的语义是「保存」。
   * 没有这个闸门的话，「Esc 取消」会被随后的 blur 又存回去。
   */
  const renameAborted = useRef(false);
  /** 正在重命名的 id（ref 版）。Enter 提交后紧跟的 blur 要靠它来判断「已经结束了，别再存一次」。 */
  const renamingRef = useRef<string | null>(null);

  /**
   * 启动参数编辑的两个闸门，和重命名同款。
   *
   * Esc 取消会让输入框卸载、紧接着触发一次 blur，而 blur 的语义是「保存」；
   * 没有这个闸门的话「Esc 取消」会被随后的 blur 又存回去。
   */
  const argsAborted = useRef(false);
  const argsEditingRef = useRef<string | null>(null);

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
      setLinks((prev) =>
        prev.map((l) => {
          const hit = changed.find((c) => c.link.id === l.id);
          return hit ? { ...l, order: hit.order } : l;
        }),
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
    // 链接格子的本体就是一个按钮（点了就打开），所以不能沿用"排除所有按钮"的默认值，
    // 只排除那一排悬停操作按钮和就地重命名/参数输入框
    ignoreSelector: ".links__actions, input",
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

  const startRename = (link: LinkItem) => {
    renameAborted.current = false;
    renamingRef.current = link.id;
    setRenamingId(link.id);
    setRenameText(link.name);
  };

  const cancelRename = () => {
    renameAborted.current = true;
    renamingRef.current = null;
    setRenamingId(null);
  };

  const commitRename = async (link: LinkItem) => {
    // Enter 提交之后输入框会卸载并触发 blur，这里挡掉第二次提交
    if (renamingRef.current !== link.id) return;
    renamingRef.current = null;
    setRenamingId(null);

    if (renameAborted.current) {
      renameAborted.current = false;
      return;
    }

    const name = renameText.trim();
    if (!name || name === link.name) return;
    await persist({ ...link, name }, "已重命名");
  };

  const startArgs = (link: LinkItem) => {
    argsAborted.current = false;
    argsEditingRef.current = link.id;
    setArgsId(link.id);
    setArgsText(link.args ?? "");
  };

  const cancelArgs = () => {
    argsAborted.current = true;
    argsEditingRef.current = null;
    setArgsId(null);
  };

  const commitArgs = async (link: LinkItem) => {
    // Enter 提交之后输入框会卸载并触发 blur，这里挡掉第二次提交
    if (argsEditingRef.current !== link.id) return;
    argsEditingRef.current = null;
    setArgsId(null);

    if (argsAborted.current) {
      argsAborted.current = false;
      return;
    }

    const text = argsText.trim();
    // 空串存成 null：模型里 null 表示「没有参数」。
    // 存空串会让「到底有没有参数」变得没法判断，界面上也说不清。
    const args = text === "" ? null : text;
    if (args === (link.args ?? null)) return;
    await persist({ ...link, args }, "已保存启动参数");
  };

  // ---- 渲染 ----

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
          folders={folders.children}
          counts={folderCounts}
          dropTargetId={drag.over?.kind === "folder" ? drag.over.id : null}
          dragProps={(id) => drag.handleProps(id, "folder")}
          onEnter={folders.enter}
          onEdit={(f) => setFolderEditor({ open: true, target: f })}
          onRemove={(f) => void folders.remove(f)}
          variant="grid"
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

        {visible.map((link) => (
          <article
            key={link.id}
            className={[
              "links__tile",
              busyId === link.id ? "links__tile--busy" : "",
              drag.draggingId === link.id ? "drag-source" : "",
              drag.overClass(link.id),
            ]
              .filter(Boolean)
              .join(" ")}
            title={link.args ? `${link.target}\n参数：${link.args}` : link.target}
            {...drag.itemProps(link.id)}
          >
            {argsId === link.id ? (
              <div className="links__tile-body">
                <LinkGlyph link={link} />
                <input
                  className="links__rename"
                  autoFocus
                  value={argsText}
                  placeholder="启动参数"
                  title="例如 --profile work；留空表示不带参数"
                  onChange={(e) => setArgsText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitArgs(link);
                    if (e.key === "Escape") {
                      // 同重命名：Esc 只取消这次输入，别触发主面板的「收起面板」
                      e.stopPropagation();
                      cancelArgs();
                    }
                  }}
                  onBlur={() => void commitArgs(link)}
                />
              </div>
            ) : renamingId === link.id ? (
              <div className="links__tile-body">
                <LinkGlyph link={link} />
                <input
                  className="links__rename"
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(link);
                    if (e.key === "Escape") {
                      // 主面板把 Esc 当「收起面板」的全局快捷键（见 PanelWindow.tsx）。
                      // 重命名时按 Esc 的意图只是取消输入，所以别让它冒泡到 window。
                      e.stopPropagation();
                      cancelRename();
                    }
                  }}
                  onBlur={() => void commitRename(link)}
                />
              </div>
            ) : (
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
            )}

            {/* 悬停才出现：平时不抢视线，鼠标移上来才给这几个修改性/破坏性操作 */}
            <div className="links__actions">
              <button
                className="iconbtn"
                onClick={() => setMovingId(link.id)}
                title="移动到文件夹"
              >
                <FolderInput size={12} />
              </button>
              {/* 启动参数只对程序和文件有意义；网址加了也没人消费 */}
              {link.kind !== "url" && (
                <button
                  className="iconbtn"
                  onClick={() => startArgs(link)}
                  title="启动参数（例如 --profile work）"
                >
                  <Terminal size={12} />
                </button>
              )}
              <button className="iconbtn" onClick={() => startRename(link)} title="重命名">
                <Pencil size={12} />
              </button>
              <button
                className="iconbtn iconbtn--danger"
                onClick={() => void remove(link)}
                title="删除"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </article>
        ))}
      </div>

      {dragAvailable && !loading && links.length > 0 && (
        <div className="links__footer">把文件或文件夹拖进面板也能添加</div>
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
