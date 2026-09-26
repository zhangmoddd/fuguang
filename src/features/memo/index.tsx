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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  NotebookPen,
  Pencil,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";

import { api, newId, onStateChanged, type Memo, type Repeat } from "../../lib/api";
import {
  REPEAT_OPTIONS,
  combineLocal,
  dateKey,
  firstOccurrence,
  formatDateHuman,
  formatMoment,
  formatUntil,
  nextOccurrence,
  splitLocal,
  todayKey,
} from "../../lib/datetime";
import type { FeatureModule } from "../registry";

import "./memo.css";

/** 空笔记工厂。`date` 由调用方给定：新建时默认落在当前翻到的那一天。 */
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
   * 正在推进的笔记 id。
   *
   * 用 ref 而不是 state：它只是防重入的闸门，不需要触发渲染。
   * 后端在提醒被推进后又广播一次 `memos` 变化，如果第二次事件到达时
   * 前一次写回还没落地，就会拿着同一份旧数据再算一次下一次，
   * 结果是提醒被连推两次（跳过一轮）。所以同一 id 只允许有一次推进在飞。
   */
  const advancing = useRef<Set<string>>(new Set());

  /**
   * 推进已经弹过窗的重复提醒。
   *
   * 触发条件是 `firedFor === remindAt`，也就是 Rust 侧已经为当前这个
   * `remindAt` 弹过窗了。此时把它推到下一次并把 `firedFor` 清空，
   * 这样到下一次到点时条件会重新成立，重复提醒才能一直响下去。
   *
   * `repeat === "none"` 的笔记**刻意不动**：它只提醒一次，
   * 保持 `firedFor` 等于 `remindAt` 反而是好事——Rust 侧的幂等判断
   * 会因此永远不会为它再弹第二次。
   */
  const advanceRepeats = async (list: Memo[]) => {
    const due = list.filter(
      (m) =>
        m.remindAt !== null &&
        m.firedFor !== null &&
        m.firedFor === m.remindAt &&
        m.repeat !== "none" &&
        !advancing.current.has(m.id),
    );
    if (due.length === 0) return;

    const saved: Memo[] = [];
    for (const memo of due) {
      advancing.current.add(memo.id);
      try {
        // `due` 是 filter 出来的新数组，TS 不会把里面的收窄带过来，
        // 所以这里再取一次局部变量做判空。同时也兜住极端情况：
        // 万一 remindAt 是 null（数据被手动改过），没有「上一次」可推，跳过就好。
        const current = memo.remindAt;
        if (current === null) continue;

        const next = nextOccurrence(current, memo.repeat);
        // 上面的 filter 已经排掉了 repeat === "none"，正常走不到这里；
        // 这一步是让类型收窄，同时兜住数据被手动改成非法组合的情况。
        if (next === null) continue;

        // 再过一道 firstOccurrence：如果系统时钟被往前调过（或休眠很久后
        // 一次醒来），算出来的「下一次」可能仍然在过去，直接写回去会立刻再弹一次。
        const updated: Memo = {
          ...memo,
          remindAt: firstOccurrence(next, memo.repeat),
          firedFor: null,
          updatedAt: Date.now(),
        };
        await api.memoSave(updated);
        saved.push(updated);
      } catch (err) {
        setError(String(err));
      } finally {
        // 失败也解除闸门：下次事件来了应该允许重试，否则这条提醒会永久卡住。
        advancing.current.delete(memo.id);
      }
    }

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
      if (!disposed) await advanceRepeats(list);

      // onStateChanged 返回 Promise<UnlistenFn>，卸载时一定要调用它，
      // 否则面板被销毁后回调仍会触发，对着已卸载组件 setState。
      unlisten = await onStateChanged((what) => {
        if (disposed || !what.includes("memos")) return;
        void (async () => {
          const fresh = await load();
          if (!disposed) await advanceRepeats(fresh);
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

  // 反馈提示 2.4 秒后自动消失
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 2400);
    return () => window.clearTimeout(t);
  }, [feedback]);

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

  const save = async (draft: Memo) => {
    const cleaned: Memo = {
      ...draft,
      // 标题留空时用正文开头顶上，列表里至少有个可辨认的名字
      title: draft.title.trim() || summarize(draft.body, 24) || "无标题",
      body: draft.body.trim(),
      updatedAt: Date.now(),
    };
    try {
      await api.memoSave(cleaned);
      // 保存后直接切到它被记下的那一天，否则用户会以为保存失败了
      setSelected(cleaned.date);
      await load();
      setEditing(null);
      setFeedback("已保存");
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.memoRemove(id);
      setMemos((prev) => prev.filter((m) => m.id !== id));
      setFeedback("已删除");
    } catch (err) {
      setError(String(err));
    }
  };

  if (editing) {
    return (
      <MemoEditor
        draft={editing}
        onCancel={() => setEditing(null)}
        onSave={(m) => void save(m)}
      />
    );
  }

  const isToday = selected === todayKey();

  return (
    <div className="memo">
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

      {/* 直接跳日期。原生 date 控件比自己搓日历可靠，也不引依赖 */}
      <div className="memo__jump">
        <CalendarDays size={13} className="memo__jumpicon" />
        <input
          className="field__input memo__jumpinput"
          type="date"
          value={selected}
          onChange={(e) => {
            // 用户清空日期框时 e.target.value 是空串，保留原选择而不是崩掉
            if (e.target.value) setSelected(e.target.value);
          }}
        />
        <span className="memo__count">这一天 {visible.length} 条</span>
      </div>

      <div className="memo__toolbar">
        <span className="memo__hint">
          {memos.length === 0
            ? "还没有任何笔记"
            : `共 ${memos.length} 条笔记 · ${reminderCount} 条挂了提醒`}
        </span>
        <button className="btn btn--primary" onClick={() => setEditing(emptyMemo(selected))}>
          <Plus size={13} />
          记一条
        </button>
      </div>

      {feedback && (
        <div className="memo__feedback">
          <Check size={13} />
          {feedback}
        </div>
      )}

      {error && <div className="memo__error">数据读写异常：{error}</div>}

      <div className="memo__list">
        {loading && <div className="memo__empty">正在读取数据…</div>}

        {!loading && visible.length === 0 && (
          <div className="memo__empty">
            {memos.length === 0 ? (
              <>
                {formatDateHuman(selected)}还没有笔记。
                <br />
                点右上角「记一条」。提醒时间是独立的，所以可以今天先记下
                <br />
                下周要做的事，到时候它自己会来叫你。
              </>
            ) : (
              <>
                {formatDateHuman(selected)}没有笔记。
                <br />
                其他日期里还有 {memos.length} 条。
              </>
            )}
          </div>
        )}

        {visible.map((m) => (
          <article key={m.id} className="memo__card">
            <div className="memo__cardhead">
              <span className="memo__title">{m.title}</span>
              {m.tags.map((t) => (
                <span key={t} className="memo__tag">
                  {t}
                </span>
              ))}
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
    </div>
  );
}

/** 新建 / 编辑界面。 */
function MemoEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: Memo;
  onSave: (m: Memo) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Memo>(draft);
  const [tagInput, setTagInput] = useState(draft.tags.join(", "));

  // 提醒拆成「日期 + 时间」两个输入框，所以这里保留字符串形态的草稿。
  // 直接绑 remindAt 的话，用户每改一次日期框都会先经过一个空值状态，
  // 那个中间态会把已经填好的另一半冲掉。
  const initial = draft.remindAt !== null ? splitLocal(draft.remindAt) : null;
  const [remindDate, setRemindDate] = useState(initial?.date ?? "");
  const [remindTime, setRemindTime] = useState(initial?.time ?? "09:00");
  const [repeat, setRepeat] = useState<Repeat>(draft.repeat);

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
      const wanted = combineLocal(remindDate, remindTime || "09:00");
      // 关键一步：用户填的时刻可能已经过去了（下午三点设「今天 9:00 每天提醒」）。
      // firstOccurrence 会按重复规则推到下一次，而不是立刻弹一条过期提醒；
      // 不重复的笔记则原样保留，让用户看到「已到期」而不是被悄悄改掉。
      remindAt = firstOccurrence(wanted, repeat);
      nextRepeat = repeat;
    }

    onSave({ ...form, tags, remindAt, repeat: nextRepeat });
  };

  return (
    <div className="editor">
      <div className="editor__head">{draft.title ? "编辑笔记" : "记一条"}</div>

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
          className="field__input field__input--area"
          value={form.body}
          placeholder="今天做了什么、想到了什么、要办什么事…"
          onChange={(e) => patch({ body: e.target.value })}
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
          <em className="field__hint">决定这条笔记出现在日记的哪一页</em>
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
            {(() => {
              // 实时预览，把「填的时刻已经过去」这件事在保存之前就告诉用户，
              // 而不是等他保存完发现提醒跑到了明天而一头雾水。
              const wanted = combineLocal(remindDate, remindTime || "09:00");
              const actual = firstOccurrence(wanted, repeat);
              const moved = actual !== wanted;
              const rule = repeat !== "none" ? `，${repeatLabel(repeat)}` : "";
              return (
                <>
                  <Bell size={12} />
                  <span>
                    {moved ? "这个时刻已经过了，改到 " : "将在 "}
                    {formatMoment(actual)}
                    {rule}提醒
                  </span>
                </>
              );
            })()}
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
  description: "按日期记笔记，可挂定时提醒",
  icon: NotebookPen,
  order: 30,
  component: MemoPanel,
};
