/**
 * 全局搜索命令面板（面板里按 `Ctrl+K` 唤出）。
 *
 * # 它解决什么
 *
 * 浮光的四个页签是**互相独立**的：想在"那条记过的邮箱"里找东西，得先想起来
 * 它属于文本片段而不是备忘录，再切过去，再在那一页里搜。东西一多，
 * "我记得记过但想不起来记在哪"就成了最大的摩擦。
 *
 * 这个面板把四类数据放在一起搜，并且**回车直接跳到那一条并把它打开** ——
 * 不用先切页签、也不用在目标页里再找一遍。
 *
 * # 三个键各自做什么
 *
 * - `Enter` = **去那里把它打开**（片段 / 备忘 / 计时器打开编辑器；链接只定位高亮，
 *   因为链接的"打开"是启动程序，那是它的主动作）
 * - `Ctrl+Enter` = **执行这个条目的主动作**（片段 → 键入到光标；链接 → 启动；
 *   备忘 / 计时器 → 打开编辑器）
 * - `Shift+Enter` = **复制这一条的内容到剪贴板**
 *
 * 这张表在 `lib/navigation.ts` 的 `paletteActions()` 里，底部提示条和键盘处理
 * **共用同一份数据** —— 两边各写一套的话，迟早出现"提示条上写着能按、按下去却没反应"。
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
import { isContextMenuOpen } from "./context-menu";
import { useEscapeToClose } from "./escape";
import {
  actionForKey,
  featureOfKind,
  focusTargetOf,
  paletteActions,
  paletteKeyOf,
  type FocusRequestInput,
  type PaletteActionKind,
  type PaletteKey,
} from "./navigation";
import { searchAll, type SearchData, type SearchHit, type SearchKind } from "./search";

import "./command-palette.css";

/** 每一类结果的图标。 */
const KIND_ICON: Record<SearchKind, LucideIcon> = {
  snippet: Clipboard,
  link: Link2,
  memo: NotebookPen,
  timer: TimerIcon,
};

/**
 * 每一类结果的中文名，显示在行的右端。
 *
 * ⚠️ 这里的名字**必须与页签名一致**：`snippet` 那一栏原来写「片段」，
 * 而页签早就叫「笔记」了 —— 用户在同一个界面上看到"笔记"和"片段"两个词，
 * 只会以为它们是两种东西。所以统一成「笔记」。
 * （备忘那半边在 t13 里已经统一过：页签叫「备忘」、页内也叫「备忘」。）
 *
 * 只改**显示文案**：`SearchKind` 的取值 `"snippet"` 是内部类型标识，
 * 与 `snippets.json` / `folders.json` 的 `feature` 字段一样是数据契约，不动。
 */
const KIND_LABEL: Record<SearchKind, string> = {
  snippet: "笔记",
  link: "链接",
  memo: "备忘",
  timer: "计时",
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
  /**
   * 切到某个页签并**定位到某一条**。
   *
   * 位置信息（`folderId` / `date`）必须一起带过去：光切页签的话，目标页可能正停在
   * 别的文件夹或别的日期上，那一条根本不在列表里 —— 用户看到的是"按了回车没反应"。
   */
  onNavigate: (featureId: string, target: FocusRequestInput) => void;
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
   * 刚刚粘过的那条片段的 id。
   *
   * 用来挡住"再按一次回车导致重复粘贴"，**而不是靠清空查询** ——
   * `setQuery("")` 在 `await` 之后执行，会把用户等待期间新敲的字一起清掉。
   * 用户一开始改搜索词（`onChange`）就解除封锁，所以不影响接着搜别的。
   */
  const justPastedId = useRef<string | null>(null);

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

  /**
   * Esc 只关这一层 —— 但**要让位给更内层的浮层**。
   *
   * # 为什么必须判认领（这条是**可复现**的，不是理论问题）
   *
   * 1. 右键一张卡片 → 菜单弹出（z-index **100**，`context-menu.css:24`）；
   * 2. 按 `Ctrl+K` → 命令面板挂载（z-index **60**，**在菜单下面**）；
   * 3. 按 `Esc` → 原来这段内联监听器无条件 `stopPropagation()` + 关面板
   *    → **菜单留在屏幕上**，浮在一个已经关掉的面板上。
   *
   * 这一层在 `document` 捕获阶段，比菜单的 React `onKeyDown`（委托到根容器、
   * 冒泡阶段）更早，所以不判认领就一定抢在菜单前面。改成 `useEscapeToClose`
   * 之后，菜单开着时这一层**既不拦传播也不回调**，事件原样往下走交给菜单；
   * 菜单自己会 `stopPropagation`，所以主面板的「收起面板」仍然收不起来。
   *
   * ⚠️ 原来那段内联 `document` 捕获监听器**已经删掉**（不是并存）——
   * 两套并存会变成"两个监听器都认领"，比原来的 bug 更难查。
   */
  useEscapeToClose(onClose, () => !isContextMenuOpen());

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
    async (hit: SearchHit, action: PaletteActionKind) => {
      if (!raw || busy) return;

      // 同一条片段刚「键入到光标」过、警告还在屏幕上时，别再粘一次（会在目标程序里
      // 留下两份内容）。
      //
      // 只对主动作成立：跳转 / 复制重复执行最多是多跳一次、多复制一次，没有破坏性。
      //
      // ⚠️ 必须挡在 `setError(null)` **之前**：挡在后面的话，第二次按键会先把
      // 那条"剪贴板原文已被替换、无法还原"的警告**清掉**，然后什么都不做 ——
      // 用户看到警告消失却没有任何反馈，只会更糊涂。
      if (action === "primary" && justPastedId.current === hit.id) return;

      setBusy(true);
      setError(null);

      try {
        // ---- 跳转：只定位 / 定位 + 打开 ----
        if (action === "focus" || action === "open") {
          onNavigate(featureOfKind(hit.kind), focusTargetOf(hit, action === "open"));
          onClose();
          return;
        }

        // ---- 复制这一条的内容 ----
        if (action === "copy") {
          const text =
            hit.kind === "snippet"
              ? raw.snippets.find((s) => s.id === hit.id)?.content
              : raw.links.find((l) => l.id === hit.id)?.target;
          // 数据可能在这几百毫秒里被删掉了（多窗口下最常见的成因：另一个面板
          // 刚把它删了）。这时**必须说一句**，不能默默 return：
          // - 复制一段空文本更糟，会把用户剪贴板里原来的东西**静默清掉**；
          // - 什么都不做的话，用户按了键、界面毫无反应，只能以为软件坏了。
          //   用户这一轮抱怨的原始 bug 就是「按了没反应」。
          if (text === undefined) {
            setError({ text: "这条已经不存在了（可能在别的窗口里被删掉）", kind: "fail" });
            return;
          }
          if (await api.copyText(text)) {
            onClose();
            return;
          }
          setError({ text: "复制失败，没能写进剪贴板", kind: "fail" });
          return;
        }

        // ---- 主动作 ----
        // 走到这里 action 只可能是 "primary"（"none" 根本不会被派发进来）。
        // 这一档才需要看类型：每一类的主动作本来就不同，这是它存在的意义。
        if (hit.kind === "snippet") {
          const snippet = raw.snippets.find((s) => s.id === hit.id);
          if (!snippet) return;
          const outcome = await api.pasteText(snippet.content);
          // 记录一次使用（排序是"收藏 → 使用次数 → 最近更新"）。面板是主推入口，
          // 不记的话"常用"排序长期反映不了真实使用。交给 Rust 写：
          // 面板浮在片段页上面时两个组件同时挂载，前端各写一份会出现两个写者。
          void api.snippetBumpUse(snippet.id).catch(() => {});
          if (outcome.ok) {
            if (outcome.message) {
              // 粘贴成功了，但带回一条**必须让用户看到**的警告
              // （剪贴板里原来是图片/文件、已被替换且无法还原）。
              //
              // 两个都不能做：直接 onClose() 会把警告丢掉；用红色"失败"样式
              // 又会让用户以为没粘上、**再按一次** —— 第二次会真的再粘一遍。
              //
              // 所以用中性的警示样式，并用 `justPastedId` 挡住重复按键。
              // ⚠️ **不要用 `setQuery("")` 来挡**：它在这行 `await` **之后**才执行，
              // 会把用户在等待期间新敲进搜索框的字一起清掉（输入框一直有焦点，
              // 粘贴要花上百毫秒到几秒），用户会看到自己刚打的字凭空消失。
              setError({ text: outcome.message, kind: "warn" });
              justPastedId.current = hit.id;
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

        // 备忘和计时器没有"一句话就能做完"的动作，打开编辑器最实在
        onNavigate(featureOfKind(hit.kind), focusTargetOf(hit, true));
        onClose();
      } catch (err) {
        setError({ text: String(err), kind: "fail" });
      } finally {
        setBusy(false);
      }
    },
    [raw, busy, onClose, onNavigate],
  );

  /**
   * 按某个键做那一档动作。
   *
   * **分支里不再自己判断 `kind`** —— "哪个键 + 哪种结果 = 干什么"全部由
   * `lib/navigation.ts` 的 `actionForKey` 决定（那边有单测钉着）。
   * 这里只负责分发；`none` 表示这一类型上没有这个动作，什么都不做。
   */
  const act = useCallback(
    (hit: SearchHit, key: PaletteKey) => {
      const action = actionForKey(key, hit.kind);
      if (action === "none") return;
      void run(hit, action);
    },
    [run],
  );

  // `hits` 在 render 期重算，而"把 cursor 归零"发生在 effect 里（commit 之后）。
  // 所以 query 变短的那一帧 `hits[cursor]` 可能是 undefined：高亮消失、
  // 底部的动作提示退化成"输入关键词开始搜索"，用户看不出按回车会发生什么。
  // 用派生值兜住这一帧。
  const current = hits[cursor < hits.length ? cursor : 0];

  /** 当前高亮那一行，用来把它滚进可视区。 */
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  /**
   * 键盘移动选中项时，必须把它滚进可视区。
   *
   * 不滚的话，结果超过一屏之后高亮行会移出视口 —— 界面上看起来"选中项消失了"，
   * 而回车执行的**正是那条看不见的结果**。对片段来说，`Ctrl+回车` 意味着把内容
   * 键入到一个用户根本没看见的条目上：一个看不见的破坏性动作。
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
            // 列的是四个**页签名**，所以跟着页签一起改名：
            // 「文本」已经叫「笔记」了，这里还写旧名会让用户以为搜的是别的东西
            placeholder="搜索笔记、链接、备忘、计时器…"
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
            onChange={(e) => {
              // 用户开始改搜索词 → 解除"刚粘过"的封锁，不影响接着搜别的
              justPastedId.current = null;
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (!current) return;
                // 按的是哪一档**由 `actionForKey` 决定**，这里不再自己判断类型：
                // 两边各写一套迟早对不上，表现成"提示条上写着能按、按下去却没反应"。
                // 这一类型上没有这个动作时（例如备忘上的 Shift+回车）什么都不做 ——
                // 提示条上也不会列出它。
                act(
                  current,
                  paletteKeyOf({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }),
                );
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
                // 点一行 = 按回车那一档（"去那里把它打开"）。
                // 鼠标点是最容易误触的入口，得让它做**最可预期**的那件事 ——
                // 而不是"复制"或"键入到光标"。
                onClick={() => act(hit, "Enter")}
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

        {/*
          底部提示条分两行：
          第一行是**当前选中项真正能按的动作**（按类型不同而不同），
          第二行是通用按键（上下选择 / Esc 关闭）和结果条数。

          原来只有一行、而且文案是写死的「切到备忘页」—— 那是"实现只做了切页签"
          时用来兜底的实话。现在定位真的带位置了，提示条也就该说它真正做的事。

          两行而不是一行：三档按键的文案在 380px 宽的浮层里一行排不下，
          挤在一起会换行成锯齿状，反而更难读。
        */}
        <div className="palette__foot">
          <span className="palette__actions">
            {current ? (
              paletteActions(current.kind).map((a) => (
                <span className="palette__action" key={a.id}>
                  <kbd>{a.key}</kbd> {a.label}
                </span>
              ))
            ) : (
              // 没有选中项（还没输入关键词）时说清"下一步做什么"，
              // 而不是留一片空白让用户猜
              <span className="palette__action">输入关键词开始搜索</span>
            )}
          </span>

          <span className="palette__keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择 · <kbd>Esc</kbd> 关闭
            {hits.length > 0 && <span className="palette__count">{hits.length} 条</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
