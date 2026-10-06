/**
 * 图片附件的界面与接线。
 *
 * # 分工
 *
 * - `lib/media.ts`：纯逻辑（尺寸换算、孤儿判定、导入汇总、体积文案），有单测。
 * - 本文件：三路导入、缩略图回填、网格与预览、图片右键菜单。
 * - 各功能页：只负责"图片列表变了之后写进哪儿"（笔记页自动保存、备忘页等「保存」）。
 *
 * 这样两个页面共用同一套实现，不会出现"笔记页能拖、备忘页不能"这种漂移。
 *
 * # 像素为什么不进数据文件
 *
 * 见 `lib/api.ts` 的 `MediaRef` 与 `src-tauri/src/media.rs` 头部：
 * 数据文件是整份覆盖写的，塞 base64 会让它膨胀几个数量级、污染全文搜索、
 * 备份文件也跟着变成几十兆。所以这里**只传引用**，像素在 `media/` 目录里。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ClipboardPaste,
  Copy,
  Download,
  FileImage,
  Image as ImageIcon,
  Maximize2,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { api, type MediaRef, type MediaStats, type PasteOutcome } from "./api";
import type { ContextMenuItem, UseContextMenuResult } from "./context-menu";
import { isContextMenuOpen } from "./context-menu";
import { allPaths } from "./dialog";
import { useEscapeToClose } from "./escape";
import {
  CONCURRENT_IMPORT_WARNING,
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  dataUrlPayload,
  formatBytes,
  imagePathsOnly,
  importNotice,
  isImportBatchEmpty,
  largeLibraryNotice,
  mediaDeletionNotice,
  planMediaDeletion,
  applyMediaDeletion,
  referencedImageIdsExcluding,
  skippedNotice,
  statsNotice,
  summarizeImport,
  thumbnailSize,
  type ImportOutcome,
  type MediaGcEvidence,
  type WithImages,
} from "./media";
import { currentPanelLabel } from "./panel-state";
import { DATA_CHANGED_EVENT, type DataChangedPayload } from "./store";

import "./media.css";

/** 面板只有 420px 宽，提示里带的目标窗口名要截断（与片段页同一个做法）。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把一次图片粘贴的结果说给用户听。与文本粘贴的提示口径完全一致。 */
function reportImagePaste(
  outcome: PasteOutcome,
  onNotice: (text: string, kind: "ok" | "warn") => void,
): void {
  if (outcome.ok) {
    const base = outcome.target
      ? `已键入到「${truncate(outcome.target, 18)}」`
      : "已键入到光标处";
    // ⚠️ 成功时也可能带回一条**必须看到**的警告：图片路径不做剪贴板还原
    // （见 `media::copy_image_to_clipboard`），所以"切不回目标窗口"这类
    // 降级信息就在 message 里。只在失败分支读它会让这条提示变成死代码。
    onNotice(
      outcome.message ? `${base}；${outcome.message}` : base,
      outcome.message ? "warn" : "ok",
    );
    return;
  }
  onNotice(outcome.message ?? "已把图片放进剪贴板，请手动 Ctrl+V", "warn");
}

// ===============================================================
// canvas：量宽高 + 生成缩略图
// ===============================================================

/** 把 data URL 解码成 `<img>`。解码失败（图片坏了）时 reject。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("这张图打不开"));
    img.src = src;
  });
}

export interface MeasuredThumb {
  /** 原图宽（像素）。量不出来是 0。 */
  width: number;
  /** 原图高（像素）。 */
  height: number;
  /** 缩略图的**纯 base64**（没有 data URL 前缀），量不出来是 `null`。 */
  thumbBase64: string | null;
}

/**
 * 用 canvas 量出真实宽高，并生成一张最长边不超过 `MAX_THUMB_EDGE` 的 PNG 缩略图。
 *
 * # 为什么这件事在前端做
 *
 * Rust 侧要量宽高就得把图片解码一遍，而"不解码"正是 `media.rs` 能不引
 * `image` crate 的原因（本项目对发布体积极敏感）。前端本来就有 canvas，
 * 这是 `linkicon` 已经用过的分工。
 *
 * # 为什么缩略图一定要是 PNG
 *
 * Rust 侧 `media_set_meta` 会**校验文件头**，不是 PNG 直接拒绝
 * （存进去一个非 PNG 会让列表里的缩略图全部裂掉，而原因很难查）。
 * canvas 的 `toDataURL("image/png")` 正好产出 PNG。
 *
 * # 为什么宽高取 `naturalWidth/Height`
 *
 * 那是图片的**原始**尺寸，与 canvas 里画多大无关。回填给 Rust 的是原图尺寸，
 * 缩略图尺寸只是显示用的 —— 混在一起会让「另存为」和以后可能做的"原图信息"
 * 全都错。
 */
export async function measureAndMakeThumb(dataUrl: string): Promise<MeasuredThumb> {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const size = thumbnailSize(width, height);

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const ctx = canvas.getContext("2d");
  // 理论上 2d 上下文拿不到（显存耗尽）时不该让整次导入失败：
  // 图片已经落盘了，只是没有缩略图 —— 那种情况下 `mediaRead(id, false)` 会退回原图
  if (!ctx) return { width, height, thumbBase64: null };

  // 截图缩到 320px 时用默认插值会有明显的锯齿（细字体最明显）
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size.width, size.height);

  return { width, height, thumbBase64: dataUrlPayload(canvas.toDataURL("image/png")) };
}

// ===============================================================
// 拖放订阅
// ===============================================================

/**
 * 订阅「从资源管理器拖文件进窗口」。
 *
 * # 为什么和条目拖拽排序不冲突（这一条必须说清）
 *
 * 面板里有**两套完全独立**的拖拽：
 *
 * 1. **条目拖拽排序**（`lib/drag-drop.ts` 的 `useDragSort`）：靠 DOM 的
 *    `pointerdown`/`pointermove`。鼠标是在**面板里**按下的。
 * 2. **本函数订阅的**：Tauri 的 `onDragDropEvent`，是**操作系统**把文件拖进
 *    窗口的事件。鼠标是在**资源管理器里**按下的，面板里从头到尾不会产生
 *    `pointerdown`。
 *
 * 一次操作只可能属于其中一套：按下的位置决定了它是什么。所以两者在事件层面
 * 就是不相交的，不需要（也不该）靠"判据"去区分 —— 那种判据迟早会写错。
 *
 * 这一点还有**现成的先例**：链接页从一开始就同时有这两套
 * （`links/index.tsx` 的 `onDragDropEvent` + `drag.itemProps`），
 * 两个功能都正常工作。这里用的是同一套组合。
 *
 * # 为什么用 Tauri 的事件而不是 HTML5 的 drop
 *
 * HTML5 的 `dataTransfer.files` 在 Tauri 里拿不到真实路径（是空壳对象），
 * 而 `mediaImportPath` 要的就是路径。链接页的注释里也记着这一条。
 *
 * # 拿不到能力时怎么办
 *
 * 退化成"只能用按钮和粘贴"。界面上的拖放提示必须撤掉 ——
 * 留着提示但拖进来没反应，比没有提示更糟（链接页踩过）。
 */
export function useImageDrop(onPaths: (paths: string[]) => void): {
  dragging: boolean;
  available: boolean;
} {
  const [dragging, setDragging] = useState(false);
  const [available, setAvailable] = useState(true);

  /**
   * 处理器每次渲染都是新的闭包（它要读到最新的"当前条目"）。
   * 直接进依赖会让订阅每次渲染都重挂一遍 —— 而重挂的那一瞬间拖进来的文件
   * 会被丢掉（链接页的注释里记着这个坑）。
   */
  const handlerRef = useRef(onPaths);
  useEffect(() => {
    handlerRef.current = onPaths;
  });

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void (async () => {
      try {
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDragging(true);
          } else if (payload.type === "drop") {
            setDragging(false);
            handlerRef.current(payload.paths);
          } else {
            // leave：拖到一半又拖出去了
            setDragging(false);
          }
        });
        // 竞态：await 期间组件可能已经卸载，那就当场退订
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        setAvailable(false);
      }
    })();

    return () => {
      disposed = true;
      // 面板反复开关会累积监听器，必须退订
      unlisten?.();
    };
  }, []);

  return { dragging, available };
}

// ===============================================================
// 媒体库（页面级，常驻）
// ===============================================================

export interface ImportBatch {
  /** 每一张的结果（含"不是图片"这类被前端筛掉的）。 */
  outcomes: ImportOutcome<MediaRef>[];
  /**
   * 图片进来了，但**收尾没做全**（缩略图没生成）。必须说一句：
   * 不说的话用户会看到列表里在加载原图，以为"软件变慢了"。
   */
  warnings: string[];
}

/**
 * 把一批导入结果汇总成"哪些该加进条目、该说什么"。
 *
 * # 为什么要单独导出
 *
 * 判重（"这张图已经在里面了"）和"别处也在用"都要看**当前条目**的图片列表，
 * 而这份列表只有调用方知道。两个调用点：
 * 1. 编辑器里的附件 hook（`useMediaAttachments`）；
 * 2. 页面级的拖放兜底 —— 编辑器**没开着**时拖进来要新建一条，
 *    那种情况下"当前条目"还不存在（已有的引用都算"别处"）。
 *
 * 抽出来两边共用，免得"重复导入怎么说"这件事在两个地方各写一份、各自漂移。
 *
 * `text` 把收尾警告和导入结果合成**一句**：提示条只有一行，
 * 分两次说会让后一句把前一句顶掉（"已加 2 张"就再也看不到了）。
 */
export function batchNotice(
  batch: ImportBatch,
  ctx: { inItem: readonly string[]; elsewhere: ReadonlySet<string> },
): { added: MediaRef[]; text: string | null; kind: "ok" | "warn" } {
  const summary = summarizeImport(batch.outcomes, ctx);
  const notice = importNotice(summary);
  const text = [notice?.text, ...batch.warnings].filter(Boolean).join("；");
  return {
    added: summary.added,
    text: text.length > 0 ? text : null,
    kind: notice?.kind === "warn" || batch.warnings.length > 0 ? "warn" : "ok",
  };
}

export interface MediaLibraryApi {
  /** 媒体库占用。`null` 表示还没读到（第一次读之前）。 */
  stats: MediaStats | null;
  /** 重新读一次占用。**导入 / 删除之后调**，不要在渲染里轮询。 */
  refreshStats: () => void;
  /** 从磁盘路径导入。返回逐张结果，**不自己弹提示** —— 由调用方汇总后说一次。 */
  importPaths: (paths: readonly string[]) => Promise<ImportBatch>;
  /** 从剪贴板导入。返回空数组表示**剪贴板里没有图片**（正常情况，不是错误）。 */
  importClipboard: () => Promise<ImportBatch>;
  /**
   * 判断"敢不敢删媒体文件"用的证据（RV4 的 F4）。
   *
   * 每次真要删之前**现取**：面板窗口数会变（用户随时开关窗口），
   * 而"见过外部改动"是一个只升不降的会话标记。异步是为了问 `list_panels`。
   */
  gcEvidence: () => Promise<MediaGcEvidence>;
  /** 正在导入（按钮要禁用，避免连点导入两遍）。 */
  busy: boolean;
  /** 正有文件悬在窗口上。 */
  dropActive: boolean;
  /** 拖放能力是否可用。 */
  dropAvailable: boolean;
}

/** 一次导入没有任何结果。 */
const EMPTY_BATCH: ImportBatch = { outcomes: [], warnings: [] };

/**
 * 并发导入时返回的批次：**没有结果，但带一条真实原因的警告**。
 *
 * 不能返回 {@link EMPTY_BATCH} —— 调用点看到"什么都没有"就会说
 * 「剪贴板里没有图片」，而那时剪贴板里可能真的有图（RV4 的 F7）。
 * 文案常量在 `lib/media.ts` 里，好让"这种情况不算空批次"能被测试钉住。
 */
const BUSY_BATCH: ImportBatch = { outcomes: [], warnings: [CONCURRENT_IMPORT_WARNING] };

/**
 * 页面级的媒体库：导入机制 + 占用统计 + 拖放订阅。
 *
 * # 为什么放在页面级而不是编辑器里
 *
 * 拖放订阅要在**页面挂着的时候**就存在（编辑器只是页面里的一种状态），
 * 而且同一时刻只能有**一个**订阅 —— 页面和编辑器各订阅一份的话，
 * 一次拖放会触发两次导入，同一张图被加两遍（去重会挡住第二遍，
 * 但用户会看到两句"这张图已经在里面了"）。
 *
 * 所以订阅在这里，由 `onDroppedPaths` 决定这一拖该给谁。
 *
 * @param onDroppedPaths 收到拖进来的路径。调用方内部自己用 ref 取最新的"当前目标"
 *   （编辑器开着就给它，没开着就新建一条），这里只管订阅的稳定。
 */
export function useMediaLibrary(
  onDroppedPaths: (paths: string[]) => void,
): MediaLibraryApi {
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  /**
   * 这次会话里观察到过**别的窗口**改了数据吗（RV4 的 F4 要的证据之一）。
   *
   * 用 ref 而不是 state：它只在"真要删文件"的那一刻被读一次，
   * 不需要触发重渲染。
   *
   * # 为什么一旦为真就不再变回假
   *
   * 见到别的窗口写数据之后，本窗口这份引用集合**可能**已经落后于盘
   * （能不能追平取决于那几处订阅有没有及时重读，而"及时"是没法证明的）。
   * 所以这里按"见过就不再信任"处理 —— 代价只是不再删盘（文件留着），
   * 换来的是不可能因为一次竞态删掉别人的图。取舍见 `lib/media.ts` 的 `planMediaDeletion`。
   *
   * # 为什么只认 `fuguang:data-changed`
   *
   * 那条广播带着**发送者身份**（`payload.from`，见 `lib/store.ts` 的
   * `emitDataChanged`），所以能把自己发的写盘和别的窗口发的分开。
   * Rust 侧的 `state-changed` 不带发送者，自己保存也会收到 ——
   * 拿它当"外部改动"会让本窗口保存一次之后就永远不敢删。
   */
  const sawExternalChangeRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<DataChangedPayload>(DATA_CHANGED_EVENT, (event) => {
      const payload = event.payload;
      // 自己发的写盘不算外部改动（`emit` 是广播给所有窗口的，自己也收得到）
      if (payload?.from && payload.from === currentPanelLabel()) return;
      sawExternalChangeRef.current = true;
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 订阅不上只影响"敢不敢删盘"的判断，不影响图片本身能用 */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * 现取删盘证据。问不到面板数就返回 `null`（= 不确定 → 不删）。
   *
   * 用 `api.listPanels()` 而不是 `windows/panel-commands.ts` 的
   * `listPanelLabels()`：那个包装在 `windows/` 层，`lib` 反过来依赖它是倒过来的
   * （而且会形成 `lib → windows → lib` 的循环）。这里只借它的兜底思路：
   * 问不到就当"不确定"，而不是当"只有一个窗口"。
   */
  const gcEvidence = useCallback(async (): Promise<MediaGcEvidence> => {
    let panelCount: number | null = null;
    try {
      const labels = await api.listPanels();
      if (Array.isArray(labels) && labels.length > 0) panelCount = labels.length;
    } catch {
      panelCount = null;
    }
    return { panelCount, sawExternalChange: sawExternalChangeRef.current };
  }, []);

  const refreshStats = useCallback(() => {
    void api
      .mediaStats()
      .then(setStats)
      // 统计读不到不影响用图片：这一行只是"给用户看看占了多少"，
      // 弹一条错误提示反而会让人以为导入失败了
      .catch(() => undefined);
  }, []);

  // 挂载时读一次，之后只在导入 / 删除后刷新。
  // 不做轮询：那会在渲染路径上反复打 IPC，而占用不可能自己变。
  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  /**
   * 把一张导入结果收尾：量宽高 + 生成缩略图 + 回填。
   *
   * 失败**不当作导入失败**：图片已经落盘了，只是没有缩略图
   * （`mediaRead(id, false)` 会退回原图，界面照常能看）。所以返回一句警告，
   * 而不是一个失败结果 —— 报成失败会让用户以为图没进来，然后重拖一遍。
   */
  const backfillThumb = useCallback(async (media: MediaRef): Promise<string | null> => {
    try {
      // 必须读**原图**（full = true）：要量的是原始尺寸，而且要用原图去降采样。
      // 拿缩略图当输入会越缩越糊。
      const dataUrl = await api.mediaRead(media.id, true);
      const measured = await measureAndMakeThumb(dataUrl);
      if (!measured.thumbBase64) {
        return "有一张图打不开，缩略图没生成（列表里会显示原图）";
      }
      await api.mediaSetMeta(media.id, measured.width, measured.height, measured.thumbBase64);
      return null;
    } catch {
      return "缩略图生成失败（列表里会显示原图，慢一些）";
    }
  }, []);

  const importPaths = useCallback(
    async (paths: readonly string[]): Promise<ImportBatch> => {
      if (busyRef.current) return BUSY_BATCH;
      busyRef.current = true;
      setBusy(true);
      try {
        // 前端先按扩展名筛一遍：只为了省一次 IPC 和更快的提示。
        // **这不是安全边界** —— 真正决定收不收的是 Rust（扩展名 + 文件头两道）
        const { images, skipped } = imagePathsOnly(paths);
        const outcomes: ImportOutcome<MediaRef>[] = [];
        const warnings: string[] = [];

        if (skipped.length > 0) {
          /**
           * 被筛掉的到底是什么？**问一次 Rust**（RV4 的 F3）。
           *
           * 用户把一整个**文件夹**拖进来时，路径没有扩展名 → 归进 `skipped`，
           * 而"不是图片文件"会让他以为"这个功能不支持文件夹"。
           * `classify_paths` 是链接页已经在用的命令（前端拿不到文件系统属性，
           * 只能让 Rust 看一眼），返回与入参一一对应的种类。
           *
           * 问不到（命令失败 / 脱离 Tauri）就传 `null` —— `skippedNotice`
           * 会退回笼统说法，**不猜**（猜错比笼统更糟）。
           */
          const kinds = await api
            .classifyPaths([...skipped])
            .then((list) => (Array.isArray(list) ? list.map(String) : null))
            .catch(() => null);
          outcomes.push({ ok: false, error: skippedNotice(skipped, kinds) });
        }

        for (const path of images) {
          try {
            const media = await api.mediaImportPath(path);
            outcomes.push({ ok: true, media });
            const warning = await backfillThumb(media);
            if (warning) warnings.push(warning);
          } catch (err) {
            // Rust 侧给的就是中文人话（超限 / 不是图片 / 磁盘写失败），直接用
            outcomes.push({ ok: false, error: String(err) });
          }
        }

        if (outcomes.some((o) => o.ok)) refreshStats();
        return { outcomes, warnings };
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [backfillThumb, refreshStats],
  );

  const importClipboard = useCallback(async (): Promise<ImportBatch> => {
    if (busyRef.current) return BUSY_BATCH;
    busyRef.current = true;
    setBusy(true);
    try {
      // `null` = 剪贴板里没有图片（用户复制的是文字）。**这是正常路径**，
      // 由调用方决定说什么，这里不报错。
      const media = await api.mediaImportClipboard();
      if (!media) return EMPTY_BATCH;
      const warning = await backfillThumb(media);
      refreshStats();
      return { outcomes: [{ ok: true, media }], warnings: warning ? [warning] : [] };
    } catch (err) {
      return { outcomes: [{ ok: false, error: String(err) }], warnings: [] };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [backfillThumb, refreshStats]);

  const drop = useImageDrop(onDroppedPaths);

  return {
    stats,
    refreshStats,
    importPaths,
    importClipboard,
    gcEvidence,
    busy,
    dropActive: drop.dragging,
    dropAvailable: drop.available,
  };
}

// ===============================================================
// 图片附件（编辑器级）
// ===============================================================

export interface MediaAttachmentsOptions {
  /** 当前条目已有的图片。用函数是为了每次取到**最新**的那一份。 */
  images: () => readonly MediaRef[];
  /** 图片列表变了（导入 / 删除）。页面负责写进草稿或数据。 */
  onChange: (next: MediaRef[]) => void;
  /** 当前条目 id。判孤儿时要排除自己。 */
  itemId: string;
  /** **全部**条目的图片引用，用来判"这张图还有没有别人在用"。 */
  allItems: () => readonly WithImages[];
  /** 提示（复用页面自己的提示条）。 */
  onNotice: (text: string, kind: "ok" | "warn") => void;
  /** 整个编辑器共用的右键菜单。不要每张图各建一个。 */
  contextMenu: UseContextMenuResult;
  /** 页面级媒体库。 */
  library: MediaLibraryApi;
  /**
   * 「撤销改动 / 取消」会把**这一份**图片还原回来。
   *
   * # 为什么移除图片时要知道它
   *
   * 从条目里移除一张图时，如果"没有任何条目再引用它"就删磁盘文件 ——
   * 这个判断漏了一件事：**编辑器还有一条撤销路径**。用户在条目里删掉一张图、
   * 发现删错了、点「撤销改动」，数据里那张图回来了，**文件却已经没了** ——
   * 界面上是一个"读不到"的格子。
   *
   * 所以判据是两条一起看：没人引用 **且** 撤销也带不回来，才删。
   * 带得回来就先留着文件（数据里已经没有引用了，但用户一撤销就又有了）。
   *
   * 传 `null` / 不传表示"这个页面没有撤销路径"。
   */
  undoImages?: () => readonly MediaRef[];
}

export interface MediaAttachmentsApi {
  /** 挂到编辑器根节点上：`<div className="editor" onPaste={media.onPaste}>`。 */
  onPaste: (e: ClipboardEvent<HTMLElement>) => void;
  /** 打开选文件框。 */
  pickFiles: () => void;
  /** 从剪贴板导入（按钮用）。 */
  pasteFromClipboard: () => void;
  /** 把一批**已经导入好**的图片加进当前条目（拖放新建条目那条路也用）。 */
  addRefs: (refs: MediaRef[]) => void;
  /** 把一批路径导入并加进当前条目（拖放时编辑器自己处理）。 */
  addPaths: (paths: readonly string[]) => void;
  /** 删一张：从条目里去掉；没有别人引用才删磁盘文件。 */
  removeImage: (image: MediaRef) => void;
  /** 图片的右键菜单项。 */
  imageMenu: (image: MediaRef) => ContextMenuItem[];
  /** 打开大图预览。 */
  openViewer: (image: MediaRef) => void;
  /**
   * 现在有浮层盖在编辑器上面吗（大图预览 / 右键菜单）。
   *
   * 编辑器把它交给 `useEscapeToClose` 的第二个参数
   * （`() => !media.blocksEscapeNow()`），**先判认领、再决定拦不拦传播** ——
   * 不认领时既不 `stopPropagation` 也不回调，事件原样往下走，由浮层自己关自己。
   * 详细机制见 `lib/escape.ts` 的 `shouldClaim` 说明。
   *
   * # 为什么要问 `isContextMenuOpen()`
   *
   * 右键菜单的开合状态在 `lib/context-menu.tsx` 里（`useContextMenu` 只给
   * `{ open, menu }`，没有对外暴露），所以那边导出了 `isContextMenuOpen()`
   * 做一次 DOM 探测 —— 类名和探测函数都在同一个文件里，不会各改一半。
   * 它只在**按 Esc 时**跑一次，不在渲染路径上。
   */
  blocksEscapeNow: () => boolean;
  /** 大图预览浮层。由 `MediaSection` 渲染，页面不用管。 */
  viewer: ReactNode;
  busy: boolean;
  dropActive: boolean;
  dropAvailable: boolean;
  stats: MediaStats | null;
}

/**
 * 剪贴板里**可能**有图片吗？
 *
 * 这道判断只用来省掉"纯文字粘贴时的无用 IPC 往返"，**不是**拦截的开关。
 * 所以它宁可宽松：只要看到文件项、`Files` 类型、或者任何 `image/*` 类型
 * 就算"可能有"。判漏了的代价是"截图后按 Ctrl+V 没反应"，
 * 而判多了的代价只是一次 IPC 往返。
 *
 * 判据里**没有**"剪贴板里是文件"以外的排除条件：剪贴板里是纯文字时
 * `types` 只有 `text/plain`，这里返回 false，于是 `onPaste` 一个字节都不碰。
 */
function clipboardMayHoldImage(e: ClipboardEvent<HTMLElement>): boolean {
  const dt = e.clipboardData;
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;

  const items = dt.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item?.kind === "file") return true;
      if (item?.type?.startsWith("image/")) return true;
    }
  }
  const types = Array.from(dt.types ?? []);
  return types.includes("Files") || types.some((t) => t.startsWith("image/"));
}

/**
 * 一个编辑器的图片附件能力。
 *
 * 在**编辑器组件**里调用（它才知道当前条目是谁）。
 */
export function useMediaAttachments(options: MediaAttachmentsOptions): MediaAttachmentsApi {
  const [viewing, setViewing] = useState<MediaRef | null>(null);

  /** 选项每次渲染都是新对象/新闭包，放 ref 里取最新那份。 */
  const optRef = useRef(options);
  useEffect(() => {
    optRef.current = options;
  });

  /**
   * 把一批结果汇总成"该说什么"，并在需要时写进数据。
   *
   * 汇总必须在这里做（而不是在 `useMediaLibrary` 里）：判重和"别处也在用"
   * 都要看**当前条目**的图片列表，那是只有编辑器才知道的事。
   */
  const consume = useCallback((batch: ImportBatch) => {
    const opt = optRef.current;
    const current = opt.images();
    const result = batchNotice(batch, {
      inItem: current.map((m) => m.id),
      elsewhere: referencedImageIdsExcluding(opt.allItems(), opt.itemId),
    });

    if (result.added.length > 0) opt.onChange([...current, ...result.added]);
    if (result.text) opt.onNotice(result.text, result.kind);
  }, []);

  const addRefs = useCallback(
    (refs: MediaRef[]) => {
      consume({ outcomes: refs.map((media) => ({ ok: true as const, media })), warnings: [] });
    },
    [consume],
  );

  const addPaths = useCallback(
    (paths: readonly string[]) => {
      void (async () => {
        const batch = await optRef.current.library.importPaths(paths);
        // 用 `isImportBatchEmpty` 而不是自己判 `outcomes.length`：
        // 并发导入被挡下时批次是"空的但带警告"，那种情况**要说**（RV4 的 F7）
        if (isImportBatchEmpty(batch)) return;
        consume(batch);
      })();
    },
    [consume],
  );

  const pasteFromClipboard = useCallback(() => {
    void (async () => {
      const batch = await optRef.current.library.importClipboard();
      // 空批次 = 剪贴板里**真的**没有图片。走按钮这条路时要说一句，
      // 否则用户点了按钮什么都不发生。
      //
      // ⚠️ 判据必须是 `isImportBatchEmpty`（见 `lib/media.ts`），不能自己写
      // `outcomes.length === 0`：并发导入被挡下时 `outcomes` 也是空的，
      // 但它带一条警告 —— 那时说"剪贴板里没有图片"就是谎话（RV4 的 F7），
      // 用户会跑去检查剪贴板、然后怀疑软件。
      if (isImportBatchEmpty(batch)) {
        optRef.current.onNotice("剪贴板里没有图片", "warn");
        return;
      }
      consume(batch);
    })();
  }, [consume]);

  const pickFiles = useCallback(() => {
    void (async () => {
      try {
        const picked = await open({
          multiple: true,
          directory: false,
          filters: [{ name: "图片", extensions: [...IMAGE_EXTENSIONS] }],
        });
        const paths = allPaths(picked);
        // 用户取消 → 空数组 → 什么都不说（取消不是错误）
        if (paths.length === 0) return;
        addPaths(paths);
      } catch (err) {
        // 插件命令要过权限表，权限没配时 `open()` 会直接 reject。
        // 不 catch 的话用户点「加图片」毫无反应 —— 最难排查的一种故障
        optRef.current.onNotice(`打开文件选择框失败：${String(err)}`, "warn");
      }
    })();
  }, [addPaths]);

  /**
   * `Ctrl+V`：剪贴板里有图片就导入，否则**什么都不做**。
   *
   * # 为什么**不** `preventDefault`
   *
   * textarea 是受控组件，而粘贴是浏览器的默认行为。一旦 `preventDefault`，
   * 就得自己把文字插进去 —— 那会毁掉撤销栈、输入法和光标位置，
   * 风险远大于收益。所以这里的规则是：
   *
   * - 剪贴板里**看起来不是图片** → 直接 return，一个字节都不碰；
   * - 看起来可能是图片 → **照样不拦默认行为**，只是并行去问 Rust。
   *
   * 不拦也安全：剪贴板里只有一张图时，浏览器往 textarea 里本来也粘不出
   * 任何东西。而剪贴板里同时有文字和图片（从网页/Word 复制）时，
   * 文字照常粘进去、图片也一并存下来 —— 那正是用户想要的。
   *
   * # 三态处理（与 `media_import_clipboard` 的语义一一对应）
   *
   * - 拿到 `MediaRef` → 正常加进条目；
   * - `null`（剪贴板里没有图片）→ **静默返回**，不报错、不弹提示；
   * - 抛错（有图片但读不出来：剪贴板被占用 / 格式认不出 / 超 20MB）
   *   → 走 `consume`，把 Rust 给的中文原因显示出来。
   *   把抛错也当成 `null` 吞掉的话，用户看到的是「我明明复制了截图，
   *   粘进去什么都没发生」—— 正是这一轮在消灭的那类静默失败。
   */
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      if (!clipboardMayHoldImage(e)) return;
      void (async () => {
        const batch = await optRef.current.library.importClipboard();
        // 空批次 = 剪贴板里真的没有图片 → **静默**（不 preventDefault，
        // 文字粘贴照旧走浏览器原路）。并发被挡下时批次带着警告，要说话。
        if (isImportBatchEmpty(batch)) return;
        consume(batch);
      })();
    },
    [consume],
  );

  /**
   * 从条目里移除一张图。
   *
   * 先把引用从条目里去掉（这一步总是要做），再决定**敢不敢删磁盘文件** ——
   * 判据全部收在 `lib/media.ts` 的 `planMediaDeletion` 里（`still-referenced` /
   * `undoable` / `untrusted-memory`），这里只判 `plan.deletable` 里有没有它。
   *
   * ⚠️ **不要在这里另写一份判据**：删整条条目（`snippets` / `memo` 的 `remove`）
   * 和撤销/取消后的残留清理走的是**同一个** `planMediaDeletion`。
   * 三处各写一遍的话，迟早有人只写前两条 —— 而那正是 RV4 报的那条不可逆问题。
   */
  const removeImage = useCallback((image: MediaRef) => {
    void (async () => {
      const opt = optRef.current;
      const current = opt.images();
      opt.onChange(current.filter((m) => m.id !== image.id));

      const evidence = await opt.library.gcEvidence();
      const plan = planMediaDeletion({
        items: opt.allItems(),
        // 图片**正在**被改（数据还没落盘）→ 传 fromItemId，
        // 判据会排除本条目自己的引用，问的是"别的条目还在引用吗"
        fromItemId: opt.itemId,
        candidateIds: [image.id],
        undoIds: (opt.undoImages?.() ?? []).map((m) => m.id),
        evidence,
      });

      if (plan.deletable.length === 0) {
        opt.onNotice(
          mediaDeletionNotice(plan, evidence) ?? "已从这条里移除，文件先留着",
          "ok",
        );
        return;
      }

      await applyMediaDeletion({ plan, deleteFile: api.mediaDelete });
      opt.onNotice("已删除", "ok");
      opt.library.refreshStats();
    })();
  }, []);

  const copyImage = useCallback((image: MediaRef) => {
    void (async () => {
      try {
        await api.mediaCopyImage(image.id);
        // ⚠️ 图片路径**不做剪贴板还原**（见 `media::copy_image_to_clipboard`：
        // 剪贴板里的图片可能是好几种格式，逐格式备份还原的出错面远超收益）。
        // 所以必须说清"你原来复制的东西没了" —— 这正是 `warn` 那一档的用途
        optRef.current.onNotice("图片已放进剪贴板；原来的剪贴板内容被替换了", "warn");
      } catch (err) {
        optRef.current.onNotice(`复制图片失败：${String(err)}`, "warn");
      }
    })();
  }, []);

  const pasteImageToTarget = useCallback((image: MediaRef) => {
    void (async () => {
      try {
        // Rust 侧真实能力：写剪贴板 → 切回上一次的外部窗口 → 模拟 Ctrl+V
        // （`media_paste_to_target` → `media::paste_to_target`）
        const outcome = await api.mediaPasteToTarget(image.id);
        reportImagePaste(outcome, optRef.current.onNotice);
      } catch (err) {
        optRef.current.onNotice(`键入失败：${String(err)}`, "warn");
      }
    })();
  }, []);

  const exportImage = useCallback((image: MediaRef) => {
    void (async () => {
      try {
        const dest = await save({
          title: "另存为",
          // 用原文件名当默认名：用户存下来之后还能认得出是哪张
          defaultPath: image.name || "图片.png",
          filters: [{ name: "图片", extensions: [...IMAGE_EXTENSIONS] }],
        });
        // 用户取消时返回 null，不是错误
        if (!dest) return;
        await api.mediaExport(image.id, dest);
        optRef.current.onNotice("已另存为", "ok");
      } catch (err) {
        optRef.current.onNotice(`另存为失败：${String(err)}`, "warn");
      }
    })();
  }, []);

  const imageMenu = useCallback(
    (image: MediaRef): ContextMenuItem[] => [
      {
        id: "view",
        label: "查看大图",
        icon: <Maximize2 size={13} />,
        onSelect: () => setViewing(image),
      },
      {
        id: "copy-image",
        label: "复制图片",
        icon: <Copy size={13} />,
        onSelect: () => copyImage(image),
      },
      {
        id: "type-into",
        label: "键入到当前光标",
        icon: <Send size={13} />,
        onSelect: () => pasteImageToTarget(image),
      },
      {
        id: "export",
        label: "另存为",
        icon: <Download size={13} />,
        hint: formatBytes(image.bytes),
        dividerBefore: true,
        onSelect: () => exportImage(image),
      },
      {
        id: "delete",
        label: "删除",
        icon: <Trash2 size={13} />,
        danger: true,
        dividerBefore: true,
        onSelect: () => removeImage(image),
      },
    ],
    [copyImage, exportImage, pasteImageToTarget, removeImage],
  );

  return {
    onPaste,
    pickFiles,
    pasteFromClipboard,
    addRefs,
    addPaths,
    removeImage,
    imageMenu,
    openViewer: setViewing,
    blocksEscapeNow: () => viewing !== null || isContextMenuOpen(),
    viewer: viewing ? (
      <ImageViewer
        image={viewing}
        onClose={() => setViewing(null)}
        contextMenu={options.contextMenu}
        imageMenu={imageMenu}
      />
    ) : null,
    busy: options.library.busy,
    dropActive: options.library.dropActive,
    dropAvailable: options.library.dropAvailable,
    stats: options.library.stats,
  };
}

// ===============================================================
// 界面
// ===============================================================

/**
 * 缩略图。
 *
 * `mediaRead(id, false)` 让 Rust 优先给缩略图，没有就退回原图 ——
 * **不能因为"缩略图还没生成"就显示空白**，那会让用户以为图片坏了。
 * 代价是极少数情况下（回填失败）会经 IPC 传一次原图，可以接受。
 */
function Thumb({ image }: { image: MediaRef }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    void api
      .mediaRead(image.id, false)
      .then((dataUrl) => {
        if (alive) setUrl(dataUrl);
      })
      .catch(() => {
        // 读不到（文件被删了 / 数据目录被清理过）要说出来，
        // 不能留一个空白格子 —— 空白看起来像"还在加载"
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [image.id]);

  if (failed) {
    return (
      <div className="media__broken">
        <TriangleAlert size={14} />
        <span>读不到</span>
      </div>
    );
  }
  if (!url) {
    return (
      <div className="media__loading">
        <ImageIcon size={14} />
      </div>
    );
  }
  return (
    <img
      className="media__thumb"
      src={url}
      alt={image.name || "图片"}
      draggable={false}
    />
  );
}

export interface MediaSectionProps {
  images: readonly MediaRef[];
  /** 附件能力（`useMediaAttachments` 的返回值）。 */
  media: MediaAttachmentsApi;
  /** 整个编辑器共用的右键菜单实例。 */
  contextMenu: UseContextMenuResult;
  /**
   * 编辑器挂载时把自己注册成拖放目标。
   *
   * 拖放订阅只有一个（在页面级），页面靠这个回调知道"这一拖该给谁"。
   * 传 `null` 表示编辑器要卸载了。
   */
  onRegisterDrop?: (handler: ((paths: string[]) => void) | null) => void;
}

/**
 * 编辑器里的图片区：缩略图网格 + 两个导入按钮 + 占用统计。
 *
 * # 列表里为什么不塞大图
 *
 * 这一块只在**编辑器**里出现。列表行上只给一个「N」的数字标记
 * （见 `snippets/index.tsx` / `memo/index.tsx` 的 `media__marker`）：
 * 卡片只有几十像素高，塞一张缩略图会把"一眼扫十条"变成"一眼看两条"。
 */
export function MediaSection({
  images,
  media,
  contextMenu,
  onRegisterDrop,
}: MediaSectionProps) {
  /**
   * 把"拖进来怎么处理"注册给页面级的订阅。
   *
   * 每次都重新注册（`media.addPaths` 是稳定引用，但 `images()` 那个闭包会变），
   * 所以这里包一层 ref：注册的是**稳定的**那个函数，它内部再取最新的实现。
   */
  const addPathsRef = useRef(media.addPaths);
  useEffect(() => {
    addPathsRef.current = media.addPaths;
  });

  useEffect(() => {
    if (!onRegisterDrop) return;
    const handler = (paths: string[]) => addPathsRef.current(paths);
    onRegisterDrop(handler);
    return () => onRegisterDrop(null);
  }, [onRegisterDrop]);

  const stats = media.stats;
  // 越过阈值时这一行**换成一句完整的话**（而不是加个图标）：
  // 提示条只有一行，说清楚"再涨下去备份会变慢"才有用
  const bigWarning = stats ? largeLibraryNotice(stats.bytes) : null;

  return (
    <div className={`media${media.dropActive ? " media--drop" : ""}`}>
      <div className="media__head">
        <span className="media__label">
          <ImageIcon size={13} />
          图片
          {images.length > 0 && <span className="media__stats">（{images.length} 张）</span>}
        </span>
        <span className="media__spacer" />

        <button
          type="button"
          className="media__btn"
          onClick={media.pickFiles}
          disabled={media.busy}
          title="从文件里选图片（png / jpg / gif / bmp / webp，单张不超过 20 MB）"
        >
          <Plus size={12} />
          加图片
        </button>
        <button
          type="button"
          className="media__btn"
          onClick={media.pasteFromClipboard}
          disabled={media.busy}
          title="把剪贴板里的图片加进来（截图后直接点这个）"
        >
          <ClipboardPaste size={12} />
          剪贴板
        </button>
      </div>

      {images.length === 0 ? (
        <div className="media__empty">
          {media.dropAvailable
            ? "还没有图片。可以把图片文件拖到这里，或者点「加图片」；截图之后按 Ctrl+V 也行。"
            : "还没有图片。点「加图片」选文件，或者截图之后按 Ctrl+V。"}
        </div>
      ) : (
        <div className="media__grid">
          {images.map((image) => (
            <div
              key={image.id}
              className="media__cell"
              // 右键：查看大图 / 复制图片 / 键入到当前光标 / 另存为 / 删除
              onContextMenu={(e) => contextMenu.open(e, () => media.imageMenu(image))}
              // 左键点开大图（要求 8：编辑器里显示缩略图网格，点开看大图）。
              // 缩略图只有 ~90px，看不清内容，点开是这里最自然的动作
              onClick={() => media.openViewer(image)}
              // `title` 把文件名露出来 —— 格子里放不下
              title={image.name || "图片"}
            >
              <Thumb image={image} />
            </div>
          ))}
        </div>
      )}

      {/* 占用统计。数字走 `formatBytes`（人话），不要裸字节数 */}
      {stats && (
        <div className={`media__stats${bigWarning ? " media__stats--warn" : ""}`}>
          {bigWarning ?? statsNotice(stats)}
        </div>
      )}

      {images.length > 0 && (
        <div className="media__empty">
          点一下看大图，右键有更多操作。单张上限 {formatBytes(MAX_IMAGE_BYTES)}。
        </div>
      )}

      {/* 大图预览。挂在这里而不是让页面自己渲染：它是这个组件的状态，
          放外面就要求每个调用点都记得渲染它，漏一个就是"点了没反应" */}
      {media.viewer}
    </div>
  );
}

export interface ImageViewerProps {
  image: MediaRef;
  onClose: () => void;
  /** 整个编辑器共用的右键菜单实例（和缩略图格子、正文区是同一个）。 */
  contextMenu: UseContextMenuResult;
  /** 图片的右键菜单项来源，与缩略图格子同源（`useMediaAttachments.imageMenu`）。 */
  imageMenu: (image: MediaRef) => ContextMenuItem[];
}

/**
 * 大图预览覆盖层。
 *
 * `Esc` 只关这一层 —— 用 `lib/escape.ts` 的 `useEscapeToClose`：
 * 它在**捕获阶段**拦下 Esc 并 `stopPropagation`，所以不会连带把编辑器或
 * 整个面板也关了（项目里踩过这个坑，那个文件头写着事故经过）。
 *
 * # 预览层里也有右键菜单（RV4 的 F2）
 *
 * 原来这里只有左键关闭、没有任何右键处理，而原生菜单又被
 * `main.tsx` 全局关掉了 —— 于是"在预览层上右键图片"什么都不发生。
 * `media.css` 里那条 z-index 注释却写着"菜单要能盖在它上面"，
 * **注释和实现只有一个能留下**，所以这里把菜单真的接上了：
 * 与缩略图格子同源（`media.imageMenu`），只做两处调整（见下面 `items`）。
 */
export function ImageViewer({
  image,
  onClose,
  contextMenu,
  imageMenu,
}: ImageViewerProps) {
  useEscapeToClose(onClose);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * 预览层里的菜单项：与缩略图格子上的那一份同源，只调两处。
   *
   * - **去掉「查看大图」**：已经在看了，留着是个点了没反应的同义项；
   * - **「删除」之后再关掉预览层**：那张图已经从条目里移除、磁盘文件也可能
   *   删掉了，预览层继续显示它就是一个"看着还在、其实没了"的假象。
   */
  const items = useMemo(
    () =>
      imageMenu(image)
        .filter((item) => item.id !== "view")
        .map((item) =>
          item.id === "delete"
            ? {
                ...item,
                onSelect: () => {
                  onClose();
                  item.onSelect();
                },
              }
            : item,
        ),
    [imageMenu, image, onClose],
  );

  useEffect(() => {
    let alive = true;
    // 预览读**原图**（full = true）：缩略图放大了只会看到一团模糊，
    // 而用户点开大图就是为了看清细节
    void api
      .mediaRead(image.id, true)
      .then((dataUrl) => {
        if (alive) setUrl(dataUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [image.id]);

  const size = image.width > 0 ? `${image.width}×${image.height}` : "尺寸未知";

  return (
    // 点背景关闭；里面那层要 stopPropagation，否则点图片也会关掉
    <div className="media__viewer" onClick={onClose}>
      {failed ? (
        <div className="media__viewer-bar">
          <TriangleAlert size={13} />
          读不到这张图片，文件可能已被删除
        </div>
      ) : url ? (
        <img
          className="media__viewer-img"
          src={url}
          alt={image.name || "图片"}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          // 右键：和缩略图格子同一套菜单（复制图片 / 键入到当前光标 / 另存为 / 删除）。
          // `contextMenu.open` 内部会 `stopPropagation`，所以不会连带触发
          // 外层那层"点背景关闭"
          onContextMenu={(e) => contextMenu.open(e, () => items)}
        />
      ) : (
        <div className="media__viewer-bar">
          <FileImage size={13} />
          正在读取…
        </div>
      )}

      <div className="media__viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="media__viewer-name" title={image.name}>
          {image.name || "图片"}
        </span>
        <span>
          {size} · {formatBytes(image.bytes)}
        </span>
        <button type="button" className="media__viewer-btn" onClick={onClose}>
          <X size={12} />
          关闭
        </button>
      </div>
    </div>
  );
}
