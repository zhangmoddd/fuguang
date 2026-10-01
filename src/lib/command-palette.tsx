/**
 * 全局搜索命令面板（面板里按 `Ctrl+K` 唤出）。
 *
 * # 它解决什么
 *
 * 浮光的四个页签是**互相独立**的：想在"那条记过的邮箱"里找东西，得先想起来
 * 它属于文本片段而不是备忘录，再切过去，再在那一页里搜。东西一多，
 * "我记得记过但想不起来记在哪"就成了最大的摩擦。
 *
 * 这个面板把四类数据放在一起搜，并且**回车直接执行主操作**——
 * 搜到片段就粘贴到光标处，搜到链接就打开，不用先切页签再点。
 *
 * # 为什么是浮层而不是第五个页签
 *
 * 页签是"我要做某一类事"的入口，而搜索是"我知道有这个东西、帮我找到它"。
 * 做成页签的话，用户得先切到搜索页再开始打字，多一步；
 * 而且四类数据的操作各自不同，混进页签栏也会让"1~9 切页签"变得别扭。
 *
 * # 数据每次打开都重新读
 *
 * 不缓存：面板可能开着很久，用户在别的页签里改了东西，
 * 缓存会让搜索给出**已经删掉的条目**——那种"点了没反应"最难排查。
 * 四份数据加起来通常只有几百 KB，读一次是毫秒级。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Clipboard,
  Link2,
  NotebookPen,
  Search,
  Timer as TimerIcon,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { api, type LinkItem, type Memo, type Snippet, type Timer } from "./api";
import { searchAll, type SearchData, type SearchHit, type SearchKind } from "./search";

import "./command-palette.css";

/** 每一类结果的图标。 */
const KIND_ICON: Record<SearchKind, LucideIcon> = {
  snippet: Clipboard,
  link: Link2,
  memo: NotebookPen,
  timer: TimerIcon,
};

/** 每一类结果的中文名，显示在行的右端。 */
const KIND_LABEL: Record<SearchKind, string> = {
  snippet: "片段",
  link: "链接",
  memo: "备忘",
  timer: "计时",
};

/**
 * 回车会做什么。显示在底部提示里 —— 不然用户不知道按下去会发生什么。
 *
 * ⚠️ 这里的文案必须与**实际行为**一致。原来 memo / timer 写的是
 * 「去备忘看这一天」「去计时器看这条」，但实现只是 `setActiveId` 切了个页签 ——
 * 备忘页仍然停在今天、计时器页也不会定位到那一条，用户按提示操作后
 * 发现"点了没反应"，只能自己再搜一次。
 *
 * 要恢复那种文案，得先让 `onNavigate` 带上定位信息（备忘的日期 / 计时器的 id）
 * 并让两个页面接住它。在那之前，文案只能说它真正做的事。
 */
const ACTION_LABEL: Record<SearchKind, string> = {
  snippet: "粘贴到光标处",
  link: "打开",
  memo: "切到备忘页",
  timer: "切到计时器页",
};

/** 四份原始数据。搜索结果只带 `id`，执行动作时要回来取完整对象。 */
interface RawData {
  snippets: Snippet[];
  links: LinkItem[];
  memos: Memo[];
  timers: Timer[];
}

export interface CommandPaletteProps {
  /** 关闭面板。 */
  onClose: () => void;
  /** 切到某个页签（备忘 / 计时器的结果用得上）。 */
  onNavigate: (featureId: string) => void;
}

export function CommandPalette({ onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState<RawData | null>(null);
  const [cursor, setCursor] = useState(0);
  /**
   * 出错时留在面板上显示，而不是静默关掉——用户需要知道"没成功"。
   *
   * `kind === "warn"` 表示**成功了但有东西没了**（例如剪贴板原文已被替换）。
   * 它必须和"失败"分开：把这种话渲染成红底三角警告，用户会以为粘贴失败了，
   * 于是**再按一次回车** —— 第二次会真的再粘一遍，目标程序里出现两份内容。
   */
  const [error, setError] = useState<{
    text: string;
    kind: "fail" | "warn";
  } | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 浮层从多高开始 —— 也就是标题栏 + 页签栏的实际高度。
   *
   * 不能硬编码：字号是用户可调的（12–18px），那两条的高度会跟着变，
   * 写死一个值迟早对不上。也不能直接 `inset: 0` 铺满整个窗口 ——
   * 那样浮层会压住页签栏，而 `PanelWindow` 的注释明确承诺"页签栏和标题栏仍然可见"，
   * 用户看到按钮却点不动。
   *
   * 量不到（理论上不会）就退回 0，等于铺满，至少不会把浮层摆到奇怪的位置。
   */
  const [layerTop, setLayerTop] = useState(0);
  // 用 `useLayoutEffect` 而不是 `useEffect`：后者在**绘制之后**才跑，
  // 于是首帧会以 `top: 0` 落盘（fixed + left/right/bottom:0 盖住标题栏和页签栏），
  // 下一帧才跳到页签栏下面 —— 用户看到闪一下 + 面板位置跳变，
  // 而那一帧里正好把这次改动想避开的"盖住页签栏"又演了一遍。
  // `useLayoutEffect` 在 commit 之后、paint 之前跑，首帧就是对的。
  useLayoutEffect(() => {
    const chrome =
      (document.querySelector(".panel__titlebar")?.getBoundingClientRect().height ?? 0) +
      (document.querySelector(".tabs")?.getBoundingClientRect().height ?? 0);
    setLayerTop(chrome);
  }, []);

  // ---- 读数据 ----

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // 四份数据并行读。串行的话每份都要等一次 IPC 往返，面板会有可感的延迟
        const [snippets, links, memos, timers] = await Promise.all([
          api.readData<Snippet[]>("snippets.json"),
          api.linksList(),
          api.memosList(),
          api.timersList(),
        ]);
        if (!alive) return;
        setRaw({
          snippets: snippets ?? [],
          links,
          memos,
          timers,
        });
      } catch (err) {
        if (alive) setError({ text: `读取数据失败：${String(err)}`, kind: "fail" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---- 搜索 ----

  // 结构上 Snippet / LinkItem / Memo / Timer 都满足对应的 Searchable* 接口，
  // 所以可以直接传进去，不需要再映射一遍
  const searchData: SearchData = useMemo(
    () => ({
      snippets: raw?.snippets ?? [],
      links: raw?.links ?? [],
      memos: raw?.memos ?? [],
      timers: raw?.timers ?? [],
    }),
    [raw],
  );

  const hits = useMemo(() => searchAll(query, searchData), [query, searchData]);

  // 每次改搜索词都把光标收回第一条：留在原来的下标上很容易选到不相干的东西
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Esc 只关这一层。必须在捕获阶段截住，否则会冒泡到主面板把整个面板收起来
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** 上下移动光标，两端循环。 */
  const move = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      setCursor((c) => (c + delta + hits.length) % hits.length);
    },
    [hits.length],
  );

  // ---- 执行 ----

  const run = useCallback(
    async (hit: SearchHit) => {
      if (!raw || busy) return;
      setBusy(true);
      setError(null);

      try {
        if (hit.kind === "snippet") {
          const snippet = raw.snippets.find((s) => s.id === hit.id);
          if (!snippet) return;
          const outcome = await api.pasteText(snippet.content);
          if (outcome.ok) {
            if (outcome.message) {
              // 粘贴成功了，但带回一条**必须让用户看到**的警告
              // （剪贴板里原来是图片/文件、已被替换且无法还原）。
              //
              // 两个都不能做：直接 onClose() 会把警告丢掉；用红色"失败"样式
              // 又会让用户以为没粘上、**再按一次回车** —— 第二次会真的再粘一遍，
              // 目标程序里出现两份内容。所以用中性的警示样式，并清空查询：
              // 清空后 `current` 变 undefined，回车不会再触发一次粘贴。
              setError({ text: outcome.message, kind: "warn" });
              setQuery("");
              return;
            }
            onClose();
            return;
          }
          // 粘贴失败**不关面板**：内容这时已经在剪贴板里了，
          // 得把「请手动 Ctrl+V」这句话留在屏幕上让用户看到
          setError({
            text: outcome.message ?? "已复制到剪贴板，请手动 Ctrl+V",
            kind: "fail",
          });
          return;
        }

        if (hit.kind === "link") {
          await api.linkLaunch(hit.id);
          onClose();
          return;
        }

        // 备忘和计时器没有"一句话就能做完"的动作，切到对应页签最实在
        onNavigate(hit.kind === "memo" ? "memo" : "timer");
        onClose();
      } catch (err) {
        setError({ text: String(err), kind: "fail" });
      } finally {
        setBusy(false);
      }
    },
    [raw, busy, onClose, onNavigate],
  );

  // `hits` 在 render 期重算，而"把 cursor 归零"发生在 effect 里（commit 之后）。
  // 所以 query 变短的那一帧 `hits[cursor]` 可能是 undefined：高亮消失、
  // 页脚的回车提示退化成"执行"，用户看不出回车到底会做什么。用派生值兜住这一帧。
  const current = hits[cursor < hits.length ? cursor : 0];

  /** 当前高亮那一行，用来把它滚进可视区。 */
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  /**
   * 键盘移动选中项时，必须把它滚进可视区。
   *
   * 不滚的话，结果超过一屏之后高亮行会移出视口 —— 界面上看起来"选中项消失了"，
   * 而 Enter 执行的**正是那条看不见的结果**。对文本片段来说，这意味着把内容
   * 粘贴到一个用户根本没看见的条目上：一个看不见的破坏性动作。
   */
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
    // `hits` 也要进依赖：用滚动条把列表拖下去（拖动滚动条不会触发任何行的
    // onMouseEnter，所以 cursor 仍是 0），再收窄查询 —— 此时 `setCursor(0)`
    // 是同值、React 会跳过，只有 `hits` 变了。漏掉它的话高亮行可能停在视口外，
    // 而回车执行的正是那条看不见的结果。
  }, [cursor, hits]);

  return (
    // 点浮层外面关闭；里面那层要 stopPropagation，否则点任意一行都会先冒泡到这里
    <div
      className="palette-layer"
      // 从页签栏下面开始，别压住它（高度是量出来的，见 layerTop）
      style={{ top: layerTop }}
      onClick={onClose}
    >
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette__search">
          <Search size={14} className="palette__searchicon" />
          <input
            className="palette__input"
            autoFocus
            spellCheck={false}
            value={query}
            placeholder="搜索文本片段、链接、备忘、计时器…"
            // 焦点始终在这个输入框上（行本身不可聚焦），所以要用
            // aria-activedescendant 把"当前选中哪一行"告诉屏幕阅读器 ——
            // 只给行挂 role="option"/aria-selected 是断链的，读屏用户
            // 完全不知道上下键选中了什么。行上的 id 与这里一一对应。
            role="combobox"
            aria-expanded
            aria-controls="palette-listbox"
            aria-activedescendant={
              current ? `palette-opt-${current.kind}-${current.id}` : undefined
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (current) void run(current);
              }
            }}
          />
        </div>

        {error && (
          <div
            className={`palette__error${
              error.kind === "warn" ? " palette__error--warn" : ""
            }`}
          >
            <TriangleAlert size={13} />
            <span>{error.text}</span>
          </div>
        )}

        <div className="palette__list" id="palette-listbox" role="listbox">
          {!raw && !error && <div className="palette__hint">正在读取数据…</div>}

          {raw && query.trim() === "" && (
            <div className="palette__hint">
              输入关键词开始搜索。可以打多个词，用空格分开——两个词都命中的才会出现。
            </div>
          )}

          {raw && query.trim() !== "" && hits.length === 0 && (
            <div className="palette__hint">没有匹配「{query}」的内容。</div>
          )}

          {hits.map((hit, i) => {
            const Icon = KIND_ICON[hit.kind];
            return (
              <div
                key={`${hit.kind}-${hit.id}`}
                id={`palette-opt-${hit.kind}-${hit.id}`}
                ref={i === cursor ? activeRowRef : undefined}
                className={`palette__row${i === cursor ? " palette__row--on" : ""}`}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                // 按下时不让输入框失焦：失焦之后上下键就选不动了
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void run(hit)}
              >
                <Icon size={14} className="palette__rowicon" />
                <span className="palette__text">
                  <span className="palette__title">{hit.title}</span>
                  {hit.detail && <span className="palette__detail">{hit.detail}</span>}
                </span>
                <span className="palette__kind">{KIND_LABEL[hit.kind]}</span>
              </div>
            );
          })}
        </div>

        <div className="palette__foot">
          <span className="palette__keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择 · <kbd>Enter</kbd> {current ? ACTION_LABEL[current.kind] : "执行"} ·{" "}
            <kbd>Esc</kbd> 关闭
          </span>
          {hits.length > 0 && <span className="palette__count">{hits.length} 条</span>}
        </div>
      </div>
    </div>
  );
}
