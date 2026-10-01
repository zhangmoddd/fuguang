/**
 * 文件夹的共享界面：面包屑 + 文件夹卡片 + 新建/改名弹层，以及驱动它们的 hook。
 *
 * 链接、文本片段、计时器三个页签共用这一套。备忘不用文件夹：
 * 它的组织维度是日期，再叠一层分类只会让「今天记了什么」变难找。
 *
 * # 浏览方式为什么是面包屑下钻
 *
 * 主面板固定 420px 宽。左侧树是资源管理器里最直观的做法，但它至少要占 140px，
 * 内容区会被压到 260px 以下（链接页一行只能放两个图标）。
 * 所以选择「一屏只显示当前层 + 顶部一条路径」，点路径里任意一级就能回去。
 *
 * # 删除文件夹为什么要有回调
 *
 * Rust 侧的 `folder_remove` 只动 `folders.json`（把子文件夹挂到父级），
 * **不碰条目**：条目分散在三份数据里，让它一起改会同时动四份文件。
 * 所以这里约定由各功能自己把条目搬走，通过 `moveItems` 回调传进来。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  Home,
  Pencil,
  Trash2,
} from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";

import { api, newId, type Folder } from "./api";
import { childrenOf, flattenFolders, folderPath, foldersOf } from "./folders";

import "./folders.css";

/** 同级里最大的 order，用来把新文件夹排到最后。 */
function nextOrder(siblings: Folder[]): number {
  return siblings.reduce((max, f) => Math.max(max, f.order), -1) + 1;
}

export interface UseFoldersOptions {
  /**
   * 把本页签在 `from` 文件夹下的条目改挂到 `to`。
   *
   * 只在删除文件夹时调用。`to` 是被删文件夹的父级，可能是 `null`（顶层）。
   */
  moveItems?: (from: string, to: string | null) => Promise<void>;
}

export interface FoldersApi {
  /** 本页签的全部文件夹。 */
  mine: Folder[];
  /** 当前所在的文件夹 id，`null` 表示顶层。 */
  currentId: string | null;
  /** 当前文件夹下的直接子文件夹。 */
  children: Folder[];
  /** 从顶层到当前文件夹的路径，喂给面包屑。 */
  trail: Folder[];
  /** 切到某个文件夹；传 `null` 回顶层。 */
  enter: (id: string | null) => void;
  /** 在当前文件夹下新建一个子文件夹。 */
  create: (name: string, note: string) => Promise<void>;
  /** 改名 / 改备注。 */
  update: (folder: Folder, name: string, note: string) => Promise<void>;
  /**
   * 把 `folderId` 插到同级 `targetId` 的前面或后面。
   *
   * `order` 只在**同一级内**比较，所以直接重排成 `0..n-1` 就行——
   * 不同父级下即使 order 撞车也不会同时显示，看不出问题。
   */
  reorder: (folderId: string, targetId: string, before: boolean) => Promise<void>;
  /** 删除文件夹（会先问一句，再把里面的条目搬到父级）。 */
  remove: (folder: Folder) => Promise<void>;
  loading: boolean;
  error: string | null;
}

/**
 * 把一个页签的文件夹绑起来。
 *
 * @param feature - 页签 id（`FeatureModule.id`），对应 `Folder.feature`
 */
export function useFolders(feature: string, options: UseFoldersOptions = {}): FoldersApi {
  const [all, setAll] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const { moveItems } = options;

  const reload = useCallback(async () => {
    try {
      setAll(await api.foldersList());
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mine = useMemo(() => foldersOf(all, feature), [all, feature]);
  const children = useMemo(() => childrenOf(mine, currentId), [mine, currentId]);
  const trail = useMemo(() => folderPath(mine, currentId), [mine, currentId]);

  /**
   * 当前所在的文件夹没了（被删掉，或数据被手改过）就退回顶层。
   *
   * 不兜这一步的话 `childrenOf` 会一直返回空数组，
   * 界面看起来就像卡在一个打不开的空目录里，而面包屑又是空的。
   */
  useEffect(() => {
    if (loading) return;
    if (currentId !== null && !mine.some((f) => f.id === currentId)) setCurrentId(null);
  }, [loading, mine, currentId]);

  const create = useCallback(
    async (name: string, note: string) => {
      const folder: Folder = {
        id: newId(),
        feature,
        name: name.trim() || "新建文件夹",
        note: note.trim(),
        parentId: currentId,
        order: nextOrder(children),
        createdAt: Date.now(),
      };
      await api.folderSave(folder);
      await reload();
    },
    [feature, currentId, children, reload],
  );

  const update = useCallback(
    async (folder: Folder, name: string, note: string) => {
      await api.folderSave({
        ...folder,
        // 名字被清空时保留原名，而不是存一个空字符串——
        // 空名字的文件夹在界面上就是一个点不中标签的空框
        name: name.trim() || folder.name,
        note: note.trim(),
      });
      await reload();
    },
    [reload],
  );

  const reorder = useCallback(
    async (folderId: string, targetId: string, before: boolean) => {
      if (folderId === targetId) return;

      const list = [...children];
      const from = list.findIndex((f) => f.id === folderId);
      if (from < 0) return;
      const [moved] = list.splice(from, 1);
      const at = list.findIndex((f) => f.id === targetId);
      if (at < 0) return;
      list.splice(before ? at : at + 1, 0, moved);

      // 只写 order 真的变了的那些：整层重写一遍会产生一堆无意义的磁盘写入
      const changed = list
        .map((folder, order) => ({ folder, order }))
        .filter(({ folder, order }) => folder.order !== order);
      for (const { folder, order } of changed) {
        await api.folderSave({ ...folder, order });
      }
      if (changed.length > 0) await reload();
    },
    [children, reload],
  );

  const remove = useCallback(
    async (folder: Folder) => {
      try {
        // 用系统原生确认框（和悬浮球右键菜单同一个思路：原生对话框不受
        // 面板尺寸限制，也不会被 420px 的窗口裁掉）。
        // `ask` 在这个版本是 `message` 命令的别名，走 `dialog:default` 权限。
        // 按钮文案必须自己给：不给的话默认是英文的 Yes / No。
        const confirmed = await ask(
          `删除文件夹「${folder.name}」？\n里面的内容会移到上一级，不会丢。`,
          { title: "删除文件夹", kind: "warning", okLabel: "删除", cancelLabel: "取消" },
        );
        if (!confirmed) return;

        // 先搬条目、再删文件夹。顺序不能反：反了的话中途失败会留下
        // "文件夹没了、条目却指向一个不存在的 id"，那些条目会落到顶层，
        // 用户看到的是"东西自己跑了"。
        if (moveItems) await moveItems(folder.id, folder.parentId);
        await api.folderRemove(folder.id);
        if (currentId === folder.id) setCurrentId(folder.parentId);
        await reload();
        setError(null);
      } catch (err) {
        // 不吞掉异常：确认框拿不到权限、写盘失败都会走到这里，
        // 界面必须说出"没删掉"，否则用户以为删成功了
        setError(String(err));
      }
    },
    [moveItems, currentId, reload],
  );

  return {
    mine,
    currentId,
    children,
    trail,
    enter: setCurrentId,
    create,
    update,
    reorder,
    remove,
    loading,
    error,
  };
}

// ===============================================================
// 界面
// ===============================================================

export interface FolderBarProps {
  trail: Folder[];
  onEnter: (id: string | null) => void;
  onCreate: () => void;
}

/** 面包屑 + 新建按钮。放在内容区顶部。 */
export function FolderBar({ trail, onEnter, onCreate }: FolderBarProps) {
  return (
    <div className="folderbar">
      <nav className="folderbar__trail">
        <button
          type="button"
          className={`folderbar__crumb${trail.length === 0 ? " folderbar__crumb--current" : ""}`}
          onClick={() => onEnter(null)}
          title="回到顶层"
        >
          全部
        </button>

        {trail.map((f, i) => {
          const isLast = i === trail.length - 1;
          return (
            <span className="folderbar__step" key={f.id}>
              <ChevronRight size={11} className="folderbar__sep" />
              <button
                type="button"
                className={`folderbar__crumb${isLast ? " folderbar__crumb--current" : ""}`}
                onClick={() => onEnter(f.id)}
                title={f.note || f.name}
              >
                {f.name}
              </button>
            </span>
          );
        })}
      </nav>

      <button type="button" className="iconbtn" onClick={onCreate} title="新建文件夹">
        <FolderPlus size={14} />
      </button>
    </div>
  );
}

export interface FolderTilesProps {
  folders: Folder[];
  /** 每个文件夹里有几条内容，显示在卡片上。 */
  counts?: Record<string, number>;
  onEnter: (id: string) => void;
  onEdit: (folder: Folder) => void;
  onRemove: (folder: Folder) => void;
  /**
   * `grid` 用于链接页：和图标格子同宽，靠外层设的 `--tile-scale` 对齐。
   * `list` 用于纵向列表页：一行一个。
   */
  variant?: "grid" | "list";
  /**
   * 正被拖到上面的文件夹 id，用来高亮。
   *
   * 由各功能把 `useDragSort().over` 里 kind 为 folder 的那个传进来——
   * 拖拽状态不属于文件夹本身，文件夹只是"可以被投放"。
   */
  dropTargetId?: string | null;
  /**
   * 让文件夹卡片也能被拖动（用于同级排序）。
   *
   * 传进来的是各功能 `useDragSort().itemProps(id, "folder")` 的结果——
   * 卡片长什么样是这里的事，"怎么拖"是拖拽模块的事，
   * 所以走注入，而不是让 folders-ui 反过来依赖 drag-drop。
   */
  dragProps?: (id: string) => { onPointerDown: (e: ReactPointerEvent) => void };
  /**
   * 正在被拖的那个文件夹：把它渲染成一个**空位**而不是卡片。
   *
   * 手机桌面拖图标就是这个样子：被拖的那个"提起来"跟着手走（浮层由调用方画），
   * 原处留一个虚框，其余卡片让开。传 `null` 表示没在拖文件夹。
   */
  gapId?: string | null;
}

/**
 * 当前层里的子文件夹。
 *
 * **刻意不套外层容器**，直接返回一排卡片：链接页要把它们和图标格子放进
 * 同一个网格（列宽由 `--tile-scale` 决定，缩放时一起变），列表页要让它们
 * 和条目共用同一列纵向布局。套一层 `<div>` 的话就会变成"容器套容器"，
 * 卡片要么只占一格、要么和条目的间距对不上。
 *
 * 所以布局交给调用方的容器，这里只负责卡片本身长什么样。
 */
export function FolderTiles({
  folders,
  counts = {},
  onEnter,
  onEdit,
  onRemove,
  variant = "list",
  dropTargetId = null,
  dragProps,
  gapId = null,
}: FolderTilesProps) {
  return (
    <>
      {folders.map((f) =>
        // 正在被拖的那个：留一个虚框（`drag-gap` 的样式在 lib/drag-drop.css 里）。
        // 它不再是投放目标，也不该被点中 —— 用户手里正拎着它。
        f.id === gapId ? (
          <div
            className={`foldertile foldertile--${variant} drag-gap`}
            key={f.id}
            aria-hidden
          />
        ) : (
          <div
            // ⚠️ `data-drop-folder` 必须与 lib/drag-drop.ts 的 DROP_FOLDER_ATTR 一致：
            // 那边靠这个属性收集候选投放矩形。改一处要改两处。
            data-drop-folder={f.id}
            className={`foldertile foldertile--${variant}${
              dropTargetId === f.id ? " foldertile--over" : ""
            }`}
            key={f.id}
            {...(dragProps?.(f.id) ?? {})}
          >
            <button
              type="button"
              // 拖拽抓手：卡片本体这个按钮允许发起文件夹排序拖拽。
              // 卡片内部那两个操作按钮**故意不加**这个属性 —— 它们必须老老实实是按钮，
              // 否则手抖几像素就会把"点删除"变成"拖卡片"。
              // 属性名与 lib/drag-drop.ts 里的判断必须一致。
              data-drag-handle
              className="foldertile__open"
              onClick={() => onEnter(f.id)}
              title={f.note ? `${f.name}\n${f.note}` : f.name}
            >
              <FolderIcon size={variant === "grid" ? 24 : 15} className="foldertile__icon" />
              <span className="foldertile__text">
                <span className="foldertile__name">{f.name}</span>
                {/* 网格里放不下备注（格子只有 86px 宽），只在列表里显示 */}
                {variant === "list" && f.note && (
                  <span className="foldertile__note">{f.note}</span>
                )}
              </span>
              <span className="foldertile__count">{counts[f.id] ?? 0}</span>
            </button>

            <div className="foldertile__actions">
              <button
                type="button"
                className="iconbtn"
                onClick={() => onEdit(f)}
                title="改名 / 写备注"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="iconbtn iconbtn--danger"
                onClick={() => void onRemove(f)}
                title="删除文件夹"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ),
      )}
    </>
  );
}

export interface FolderEditorProps {
  /** 正在编辑的文件夹；`null` 表示新建。 */
  target: Folder | null;
  /** 提交。名字和备注都已 `trim` 过。 */
  onSubmit: (name: string, note: string) => Promise<void>;
  onClose: () => void;
}

/**
 * 新建 / 改名的弹层。
 *
 * 复用日期选择器那套交互约定：绝对定位、点外部或按 Esc 关闭。
 * Esc 同样在捕获阶段截住，避免连带把整个面板收起来。
 */
export function FolderEditor({ target, onSubmit, onClose }: FolderEditorProps) {
  const [name, setName] = useState(target?.name ?? "");
  const [note, setNote] = useState(target?.note ?? "");
  const [busy, setBusy] = useState(false);
  /** 保存失败的提示。必须显示在弹层**内部**，理由见 `submit`。 */
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const box = boxRef.current;
      if (box && !box.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
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

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name, note);
      onClose();
    } catch (err) {
      // 必须在这里接住。`onSubmit` 上游（`folders.create` / `folders.update`
      // → `api.folderSave`）没有 catch，失败会一路抛上来。
      //
      // 原来的写法没有 catch：`onClose()` 不会执行、**弹层关不掉**，
      // 而错误只写进了 `folders.error` —— 那行字渲染在弹层**底下**，
      // 被完全盖住。用户看到的是"点创建毫无反应，还退不出去"。
      setError(`保存失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="folderedit" ref={boxRef}>
      <div className="folderedit__title">{target ? "文件夹设置" : "新建文件夹"}</div>

      <label className="field">
        <span className="field__label">名字</span>
        <input
          className="field__input"
          value={name}
          autoFocus
          placeholder="工作"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">
          备注
          <em className="field__hint">以后想不起来这个文件夹是干什么的，就靠它</em>
        </span>
        <input
          className="field__input"
          value={note}
          placeholder="选填"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </label>

      {error && <div className="folderedit__error">{error}</div>}

      <div className="folderedit__actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
          {target ? "保存" : "创建"}
        </button>
      </div>
    </div>
  );
}

export interface FolderPickerProps {
  /** 本页签的全部文件夹（已按 `feature` 过滤）。 */
  folders: Folder[];
  /** 条目当前所在的文件夹，用于标出「就在这一层」。 */
  current: string | null;
  /** 用户选定了目标文件夹；`null` 表示顶层。 */
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}

/**
 * 「移动到…」选择器。
 *
 * # 为什么是居中的浮层，不是贴在条目旁边的小气泡
 *
 * 贴条目的气泡会被滚动容器裁掉：三个页签的内容区都是 `overflow-y: auto`，
 * 靠近边缘的条目弹出来的气泡会被切掉一半，还得再写一套翻转定位逻辑。
 * 居中浮层不受任何祖先裁剪影响，代价只是多盖一层半透明底。
 *
 * # 为什么是压平的列表而不是树
 *
 * 树控件要维护展开/收起状态，而文件夹通常只有几十个。压平 + 缩进一次就能看全，
 * 少一层交互，也少一份要维护的状态。
 *
 * # 但「压平 + 缩进」光靠几像素的缩进是不够的
 *
 * 原来的写法里「顶层」和顶层文件夹的缩进**完全一样**，看起来是平级的 ——
 * 用户根本看不出「顶层」是所有文件夹的父级，也看不出哪几个文件夹是子级。
 * 现在三件事一起做：
 * 1. 「顶层」单独一行、加粗、下面一条分隔线，明确它是根；
 * 2. 所有文件夹从「顶层」再缩进一级；
 * 3. 每一级祖先画一条竖引导线，能顺着线看出「它是谁的子级」。
 */

/** 「顶层」那一行的左内边距。 */
const ROOT_INDENT = 9;
/** 文件夹相对「顶层」再缩进多少，以及每深一级再加多少。 */
const FOLDER_INDENT = 26;
const INDENT_STEP = 16;

export function FolderPicker({ folders, current, onPick, onClose }: FolderPickerProps) {
  const flat = useMemo(() => flattenFolders(folders), [folders]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 同日期选择器：Esc 只关这一层，别连带把整个面板收起来
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    // 点浮层外面关闭。里面那层要 stopPropagation，否则点任意一行都会先冒泡到这里
    <div className="folderpick-layer" onClick={onClose}>
      <div className="folderpick" onClick={(e) => e.stopPropagation()}>
        <div className="folderpick__title">移动到…</div>

        <div className="folderpick__list">
          <button
            type="button"
            className={`folderpick__row folderpick__row--root${
              current === null ? " folderpick__row--on" : ""
            }`}
            style={{ paddingLeft: ROOT_INDENT }}
            onClick={() => onPick(null)}
            title="所有文件夹都在这一层下面"
          >
            <Home size={12} className="folderpick__icon" />
            顶层
            <em className="folderpick__aside">
              {flat.length > 0 ? `下面 ${flat.length} 个文件夹都在它里面` : "还没有子文件夹"}
            </em>
          </button>

          {flat.map(({ folder, depth }) => (
            <button
              type="button"
              key={folder.id}
              className={`folderpick__row${current === folder.id ? " folderpick__row--on" : ""}`}
              // 缩进表示层级。用 padding 而不是 margin：整行都保持可点
              style={{ paddingLeft: FOLDER_INDENT + depth * INDENT_STEP }}
              onClick={() => onPick(folder.id)}
              title={folder.note || folder.name}
            >
              {/* 每一级祖先一条竖引导线。位置取"上一级与这一级的中间"，
                  这样线正好落在缩进台阶上，能顺着它看出父子关系。 */}
              {Array.from({ length: depth }, (_, i) => (
                <span
                  key={i}
                  className="folderpick__guide"
                  style={{
                    left: FOLDER_INDENT - INDENT_STEP / 2 + i * INDENT_STEP,
                  }}
                />
              ))}
              <FolderIcon size={12} className="folderpick__icon" />
              {folder.name}
            </button>
          ))}

          {flat.length === 0 && (
            <div className="folderpick__hint">
              还没有文件夹。用内容区上方的「新建文件夹」加一个。
            </div>
          )}
        </div>

        <div className="folderpick__actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
