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
  Pencil,
  Plus,
  Search,
  Send,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { api, type Folder as FolderItem, type PasteOutcome, type Snippet } from "../../lib/api";
import {
  FolderBar,
  FolderEditor,
  FolderPicker,
  FolderTiles,
  useFolders,
} from "../../lib/folders-ui";
import { useDragSort } from "../../lib/drag-drop";
import { useEscapeToClose } from "../../lib/escape";
import { newId, usePersistentState } from "../../lib/store";
import { useZoom } from "../../lib/zoom";
import type { FeatureModule } from "../registry";

const DATA_FILE = "snippets.json";

/** 空片段工厂。新建时默认落在当前翻到的那个文件夹里。 */
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
   * 保存一条片段。
   *
   * # 为什么必须 `await flush()` 之后再提示
   *
   * `update()` 只是把新值放进内存并**排一次 400ms 的防抖写盘**，它不等结果。
   * 原来这里紧接着就 `showFeedback("已保存")` —— 磁盘满、数据目录只读、
   * 文件被杀软独占时，用户看到的是绿色对勾，**重启之后这条根本不存在**。
   * 这是全项目唯一一处"确信存上了、其实没存"的路径，而它恰好发生在
   * 用户最需要被告知的时刻。
   *
   * 失败时**不关编辑器**：关掉就等于告诉用户"存好了"，而改动其实只在内存里。
   * 留着编辑器 + 一条警示提示，用户可以再点一次保存。
   */
  const save = async (draft: Snippet) => {
    const cleaned: Snippet = {
      ...draft,
      title: draft.title.trim() || summarize(draft.content, 24) || "未命名",
      updatedAt: Date.now(),
    };
    update((prev) => {
      const exists = prev.some((s) => s.id === cleaned.id);
      return exists ? prev.map((s) => (s.id === cleaned.id ? cleaned : s)) : [cleaned, ...prev];
    });

    if (await flush()) {
      setEditing(null);
      showFeedback("已保存");
      return;
    }
    showFeedback("保存失败：改动只在内存里，请检查数据目录能不能写", "warn");
  };

  /** 删除一条。同样要等落盘结果再说话 —— 不可逆的操作尤其不能谎报成功。 */
  const remove = async (id: string) => {
    update((prev) => prev.filter((s) => s.id !== id));
    const ok = await flush();
    showFeedback(
      ok ? "已删除" : "删除失败：改动只在内存里，重启后它还会回来",
      ok ? "ok" : "warn",
    );
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
          onCancel={() => setEditing(null)}
          onSave={save}
        />
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
        <button className="btn btn--primary" onClick={() => setEditing(emptySnippet(folders.currentId))}>
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
                还没有任何文本片段。
                <br />
                点右上角「新建」加一条，比如你的邮箱、常用地址、一段格式模板。
              </>
            ) : query ? (
              <>
                没有匹配「{query}」的片段。
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
              <>这个文件夹里还没有片段。</>
            )}
          </div>
        )}

        {visible.map((s) => {
          const shown = s.sensitive && !revealed.has(s.id);
          return (
            <article
              key={s.id}
              className={`card${drag.draggingId === s.id ? " drag-source" : ""}`}
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
              </div>

              <div className="card__content">
                {shown ? mask(s.content) : summarize(s.content)}
              </div>

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
                <button className="iconbtn" onClick={() => setEditing(s)} title="编辑">
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
    </div>
  );
}

/** 新建/编辑界面。 */
function SnippetEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: Snippet;
  onSave: (s: Snippet) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Snippet>(draft);

  // 填到一半按 Esc 应该是「退出编辑」，不是「把整个面板收起来」
  useEscapeToClose(onCancel);
  const [tagInput, setTagInput] = useState(draft.tags.join(", "));
  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    contentRef.current?.focus();
  }, []);

  const patch = (p: Partial<Snippet>) => setForm((f) => ({ ...f, ...p }));

  const submit = () => {
    const tags = tagInput
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({ ...form, tags });
  };

  return (
    <div className="editor">
      <div className="editor__head">
        <span>{draft.title ? "编辑片段" : "新建片段"}</span>
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
          ref={contentRef}
          className="field__input field__input--area"
          value={form.content}
          placeholder="要反复输入的文本、账号、地址、模板…"
          onChange={(e) => patch({ content: e.target.value })}
        />
      </label>

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
          onChange={(e) => setTagInput(e.target.value)}
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
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn btn--primary"
          onClick={submit}
          disabled={!form.content.trim()}
          title={form.content.trim() ? "" : "正文不能为空"}
        >
          <Clipboard size={13} />
          保存
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
  id: "snippets",
  title: "文本",
  description: "常用文本、账号、模板，一点就粘贴到光标处",
  icon: Clipboard,
  order: 10,
  component: SnippetsPanel,
};