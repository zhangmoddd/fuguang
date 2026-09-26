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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Search,
  Send,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { api, type PasteOutcome } from "../../lib/api";
import { newId, usePersistentState } from "../../lib/store";
import type { FeatureModule } from "../registry";

/** 一条文本片段。 */
export interface Snippet {
  id: string;
  /** 标题，用于快速辨认。 */
  title: string;
  /** 实际会被粘贴出去的正文。 */
  content: string;
  /** 备注，方便以后想起来这条是干什么用的；也参与搜索。 */
  note: string;
  /** 标签，便于分类。 */
  tags: string[];
  /** 是否敏感（账号密码类）：列表里遮罩显示。 */
  sensitive: boolean;
  /** 是否收藏：收藏项排在最前面。 */
  starred: boolean;
  /** 使用次数，用于「常用」排序。 */
  uses: number;
  createdAt: number;
  updatedAt: number;
}

const DATA_FILE = "snippets.json";

/** 空片段工厂。 */
function emptySnippet(): Snippet {
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

export function SnippetsPanel() {
  const { value: snippets, update, loading, error } = usePersistentState<Snippet[]>(
    DATA_FILE,
    [],
  );

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  /** 哪些条目的遮罩被临时揭开。 */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // 打开面板就聚焦搜索框：这个功能 90% 的使用路径是「搜索 → 点击」
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 反馈提示 2.4 秒后自动消失
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 2400);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const visible = useMemo(
    () => sortSnippets(snippets.filter((s) => matches(s, query.trim()))),
    [snippets, query],
  );

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
      setFeedback(
        outcome.target
          ? `已粘贴到「${truncate(outcome.target, 18)}」`
          : "已粘贴",
      );
    } else {
      // 降级路径：内容已经躺在剪贴板里了，明确告诉用户手动 Ctrl+V
      setFeedback(outcome.message ?? "已复制到剪贴板，请手动 Ctrl+V");
    }
  };

  /** 只复制，不粘贴。 */
  const copyOnly = async (s: Snippet) => {
    const ok = await api.copyText(s.content);
    bumpUse(s.id);
    setFeedback(ok ? "已复制到剪贴板" : "复制失败，剪贴板可能被占用");
  };

  const save = (draft: Snippet) => {
    const cleaned: Snippet = {
      ...draft,
      title: draft.title.trim() || summarize(draft.content, 24) || "未命名",
      updatedAt: Date.now(),
    };
    update((prev) => {
      const exists = prev.some((s) => s.id === cleaned.id);
      return exists ? prev.map((s) => (s.id === cleaned.id ? cleaned : s)) : [cleaned, ...prev];
    });
    setEditing(null);
    setFeedback("已保存");
  };

  const remove = (id: string) => {
    update((prev) => prev.filter((s) => s.id !== id));
    setFeedback("已删除");
  };

  const toggleFlag = (id: string, key: "starred" | "sensitive") => {
    update((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [key]: !s[key], updatedAt: Date.now() } : s)),
    );
  };

  const toggleReveal = (id: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (editing) {
    return (
      <SnippetEditor
        draft={editing}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    );
  }

  return (
    <div className="snip">
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
          共 {snippets.length} 条
          {query && ` · 命中 ${visible.length} 条`}
        </span>
        <button className="btn btn--primary" onClick={() => setEditing(emptySnippet())}>
          <Plus size={13} />
          新建
        </button>
      </div>

      {feedback && (
        <div className="snip__feedback">
          <Check size={13} />
          {feedback}
        </div>
      )}

      {error && <div className="snip__error">数据读写异常：{error}</div>}

      <div className="snip__list">
        {loading && <div className="snip__empty">正在读取数据…</div>}

        {!loading && visible.length === 0 && (
          <div className="snip__empty">
            {snippets.length === 0 ? (
              <>
                还没有任何文本片段。
                <br />
                点右上角「新建」加一条，比如你的邮箱、常用地址、一段格式模板。
              </>
            ) : (
              <>没有匹配「{query}」的片段。</>
            )}
          </div>
        )}

        {visible.map((s) => {
          const shown = s.sensitive && !revealed.has(s.id);
          return (
            <article key={s.id} className="card">
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
                <button className="iconbtn" onClick={() => setEditing(s)} title="编辑">
                  <Pencil size={13} />
                </button>
                <button className="iconbtn iconbtn--danger" onClick={() => remove(s.id)} title="删除">
                  <Trash2 size={13} />
                </button>

                {s.uses > 0 && <span className="card__uses">用过 {s.uses} 次</span>}
              </div>
            </article>
          );
        })}
      </div>
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
  onSave: (s: Snippet) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Snippet>(draft);
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
