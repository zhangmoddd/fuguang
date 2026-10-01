/**
 * 日期选择器（自绘弹层 + 可手打的日期框）。
 *
 * # 为什么不再用原生 `<input type="date">`
 *
 * 最初这里用的是原生 date 控件，当时的理由是「比自己搓日历可靠，也不引依赖」。
 * 可靠确实可靠，但它弹出的那个日历面板**是浏览器内部画的**：不在页面的 DOM 里，
 * 样式和定位都改不了，实测两个问题：
 *
 * 1. **位置**：弹层从输入框左上角铺开，盖住输入框本身，也盖住下面的笔记列表；
 * 2. **大小**：宽高由浏览器定死，字号跟系统走，和面板其余部分不是一个尺度。
 *
 * 而且原生控件只有右侧自带的那个小图标能点开日历，左侧我们放的图标是纯装饰，
 * 点了没反应——两个图标长得一样、行为不一样，这本身就是个坑。
 *
 * 所以改成自绘：宽度按面板算（236px，420px 面板里左右都留得下），
 * 永远锚在日期框正下方；左侧图标和日期框**任意位置都能点开**日历。
 *
 * # 手打日期的能力没有丢
 *
 * 日期框仍然是可以直接输入 `YYYY-MM-DD` 的文本框（只是不再有原生的日历按钮）。
 * 输入合法就采纳，非法就在失焦时退回原值——校验用 `lib/datetime.ts` 的
 * `isRealDateKey`，它连 `2026-02-30` 这种"格式对但不存在"的日期也能挡住。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Undo2 } from "lucide-react";

import { isRealDateKey, monthGrid, todayKey } from "../../lib/datetime";

/** 周一开头：中文语境里一周从周一开始，原生控件也是这么排的。 */
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** 从 `YYYY-MM-DD` 里取出年月。不走 `Date` 解析字符串——各引擎对它的处理不一致。 */
function parseKey(key: string): { year: number; month: number } {
  const [y, m] = key.split("-").map(Number);
  return { year: y || 1970, month: (m || 1) - 1 };
}

export interface DatePickerProps {
  /** 当前值，`YYYY-MM-DD`。 */
  value: string;
  /** 用户选定了某一天（点日历格子、点「今天」，或手打合法日期后提交）。 */
  onChange: (key: string) => void;
  /** 日期框的悬停提示。 */
  title?: string;
}

/**
 * 日期选择器：`[日历图标] [可输入的日期框]`，点图标或日期框都会弹出日历。
 */
export function DatePicker({ value, onChange, title = "选择日期" }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  /** 输入框里的草稿。和 `value` 分开，才能做到"打错了不生效"。 */
  const [draft, setDraft] = useState(value);

  /**
   * 弹层和触发区包在同一个容器里，外部点击判断就用这个容器的 ref。
   *
   * 这点很关键：如果只判断"点在不在弹层里"，那么点触发区会被当成外部点击
   * 先关一次，紧接着触发区自己的 onClick 又开一次——表现就是"点按钮关不掉"。
   * 把触发区也算作内部，点击语义才对。
   */
  const wrapRef = useRef<HTMLDivElement>(null);

  // 外部改了值（翻页按钮、「回到今天」、选了日历格子）时，输入框要跟上
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: PointerEvent) => {
      const wrap = wrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 面板全局的 Esc 是「收起面板」（PanelWindow.tsx，监听在 window 的冒泡阶段）。
      // 日历开着的时候 Esc 应该只关日历，所以在捕获阶段就把它截住。
      e.stopPropagation();
      setOpen(false);
    };

    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  /** 提交手打的日期。非法就退回原值，绝不让一个不存在的日期进到数据里。 */
  const commit = () => {
    if (isRealDateKey(draft)) {
      if (draft !== value) onChange(draft);
      return;
    }
    setDraft(value);
  };

  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
  };

  return (
    <div className="datepicker" ref={wrapRef}>
      <button
        type="button"
        className="datepicker__open"
        onClick={() => setOpen((v) => !v)}
        title={open ? "收起日历" : "打开日历"}
        aria-expanded={open}
      >
        <CalendarDays size={13} />
      </button>

      <input
        className="field__input datepicker__input"
        value={draft}
        title={title}
        spellCheck={false}
        placeholder="YYYY-MM-DD"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />

      {open && <CalendarPopup value={value} onPick={pick} />}
    </div>
  );
}

interface CalendarPopupProps {
  value: string;
  onPick: (key: string) => void;
}

/** 日历弹层本体。由 {@link DatePicker} 在打开时挂载，所以视图初值取当前值即可。 */
function CalendarPopup({ value, onPick }: CalendarPopupProps) {
  const [view, setView] = useState(() => parseKey(value));
  const cells = useMemo(() => monthGrid(view.year, view.month), [view.year, view.month]);
  const today = todayKey();

  // 用户手打了合法日期时，把视图跟过去。
  // 注意依赖只有 value：翻月份改的是 view、不动 value，所以不会把翻页顶回去。
  useEffect(() => {
    setView(parseKey(value));
  }, [value]);

  const shiftMonth = (delta: number) => {
    // 借 Date 的月份进位处理跨年：12 月 +1 会自己变成次年 1 月
    const d = new Date(view.year, view.month + delta, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  return (
    <div className="datepicker__popup">
      <div className="datepicker__head">
        <button type="button" className="iconbtn" onClick={() => shiftMonth(-1)} title="上个月">
          <ChevronLeft size={14} />
        </button>
        <span className="datepicker__title">
          {view.year} 年 {view.month + 1} 月
        </span>
        <button type="button" className="iconbtn" onClick={() => shiftMonth(1)} title="下个月">
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="datepicker__week">
        {WEEKDAYS.map((w) => (
          <span key={w} className="datepicker__weekday">
            {w}
          </span>
        ))}
      </div>

      <div className="datepicker__grid">
        {cells.map((c) => {
          const classes = ["datepicker__day"];
          if (!c.inMonth) classes.push("datepicker__day--out");
          // 选中优先于今天：同一天时只显示"已选中"，避免两种高亮打架
          if (c.key === value) classes.push("datepicker__day--selected");
          else if (c.key === today) classes.push("datepicker__day--today");

          return (
            <button
              type="button"
              key={c.key}
              className={classes.join(" ")}
              onClick={() => onPick(c.key)}
              title={c.key}
            >
              {c.day}
            </button>
          );
        })}
      </div>

      <div className="datepicker__foot">
        <button
          type="button"
          className="btn"
          onClick={() => onPick(today)}
          disabled={value === today}
          title={value === today ? "已经在今天了" : "跳到今天"}
        >
          <Undo2 size={12} />
          今天
        </button>
      </div>
    </div>
  );
}
