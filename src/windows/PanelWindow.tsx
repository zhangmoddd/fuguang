/**
 * 主面板窗口。
 *
 * 结构：标题栏 + 页签栏 + 当前功能内容。
 * 页签栏完全由 `registry.ts` 推导，这里不认识任何具体功能，
 * 所以以后新增功能不需要改动这个文件。
 *
 * # 多窗口
 *
 * 同一个前端包可以同时跑出好几个面板窗口，每个窗口有自己的 label
 * （`panel` / `panel-2` / …，见 `src-tauri/src/windows.rs`）。
 * 所以这里有一条硬规矩：**任何窗口相关的调用都要带上自己的 label**。
 * 原来代码里把 `"panel"` 写死在调用点上，多窗口之后那就是
 * "只有第一个窗口的 ✕ 有用、第二个窗口的 ✕ 点不动"这类 bug。
 *
 * 每个窗口记住自己停在哪（页签 + 文件夹层级），键按 label 分
 * （见 `lib/panel-state.ts`）—— 窗口 A 停在「临时」、窗口 B 停在「账号密码」，
 * 重启后各自回到原处。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Pin, PinOff, Search, X } from "lucide-react";

import { ask } from "@tauri-apps/plugin-dialog";

import { DEFAULT_FEATURE_ID, sortedFeatures } from "../features/registry";
import { api, emitSettingsChanged, onSettingsChanged } from "../lib/api";
import { CommandPalette } from "../lib/command-palette";
import {
  FocusContext,
  useFocusBus,
  type FocusRequestInput,
} from "../lib/navigation";
import {
  FALLBACK_PANEL_LABEL,
  currentPanelLabel,
  readPanelState,
  writePanelState,
} from "../lib/panel-state";
import { flushAll } from "../lib/store";
import { panelCommands } from "./panel-commands";

export function PanelWindow() {
  const features = useMemo(() => sortedFeatures(), []);

  /**
   * 本窗口的 label。整个生命周期里不变，所以只取一次。
   *
   * 所有窗口相关调用（收起、置顶）和持久化的键都从它派生 ——
   * 写死 `"panel"` 的写法在多窗口下会操作错窗口。
   */
  const label = useMemo(() => currentPanelLabel(), []);

  /**
   * 是不是**第一个**面板（`panel`）。
   *
   * 它和别的面板身份不同：它是常驻入口，托盘 / 悬浮球只会唤回它
   * （`windows::spawn_show_panel` 传的是 `None`），所以它只能被**隐藏**，
   * 不能销毁 —— 销毁之后托盘那两项就没有目标了。见 `closeOrHide`。
   */
  const isFirstPanel = label === FALLBACK_PANEL_LABEL;

  /** 标题栏上那条会自己消失的提示（标题栏只有 420px，常驻会把品牌名挤没）。 */
  const [newPanelError, setNewPanelError] = useState<string | null>(null);
  const newPanelSeq = useRef(0);

  const showNotice = useCallback((text: string) => {
    const seq = ++newPanelSeq.current;
    setNewPanelError(text);
    window.setTimeout(() => {
      if (newPanelSeq.current === seq) setNewPanelError(null);
    }, 4000);
  }, []);

  /**
   * ✕ 与 Esc 的行为：**第一个面板是隐藏，其余的是真正关掉**。
   *
   * # 为什么必须分开
   *
   * `new_panel` 用**最小空闲编号**（见 `api.ts` 的 `newPanel`）。如果所有面板的 ✕
   * 都只是 `hidePanel`，那么：
   *
   * ```
   * 开 panel-2 → 用完点 ✕（其实只是藏起来，窗口还活着）
   * → 再点「新建窗口」→ 拿到 panel-3（panel-2 的号还占着）
   * → panel-2 从此看不见、也回不来，WebView 一直占着内存
   * ```
   *
   * 反复几次就是几百 MB 的僵尸窗口（每个 WebView2 约 30–50MB）。
   *
   * 第一个面板（`panel`）是常驻入口：托盘和悬浮球的「显示面板」唤回的都是它
   * （`windows::spawn_show_panel` 传的是 `None`），所以它只能被**隐藏**。
   * `panel-2` 及以后没有这种身份，用户点 ✕ 就是想关掉它 —— 而且关掉是可恢复的：
   * 再点「新建窗口」会拿回同一个 label，连同它上次停的页签与文件夹
   * （见 `panel-state.ts` 里 label 复用那段说明）。
   *
   * # 关之前必须先把挂起的写盘催一遍
   *
   * `close_panel` 走的是 `destroy()`，**不一定**跑得到 `beforeunload` /
   * `visibilitychange` / 组件卸载那三个兜底钩子 —— 用户刚敲完字（400ms 防抖还没到点）
   * 就点 ✕，最后几个字会没了、而且一句话都不说。所以先 `flushAll()`。
   *
   * 催不动时**照样关**（关不掉比丢几个字更烦人），但用系统原生确认框问一句，
   * 别静默丢掉：原生框不受这个窗口影响，而且和「删除文件夹」用的是同一套做法。
   */
  const closeOrHide = useCallback(async () => {
    if (isFirstPanel) {
      await panelCommands.hidePanel(label).catch(() => {});
      return;
    }

    const saved = await flushAll();
    if (!saved) {
      try {
        const force = await ask(
          "有改动没能存到磁盘（可能是数据目录写不了）。\n现在关掉这个窗口的话，那些改动会丢。",
          { title: "关闭窗口", kind: "warning", okLabel: "仍然关闭", cancelLabel: "留在这里" },
        );
        // 用户选择留下：窗口不关，他可以再点一次 ✕ 重试落盘
        if (!force) return;
      } catch {
        // 确认框都弹不出来（权限/插件异常）时不再拦着用户 —— 关窗口是他的明确动作
      }
    }

    await panelCommands.closePanel(label).catch((err) => {
      showNotice(`关闭窗口失败：${String(err)}`);
    });
  }, [isFirstPanel, label, showNotice]);

  /**
   * 上次停在哪个页签。
   *
   * 初值从按 label 分的持久化里读。**必须校验**：存的 id 可能是已经被删掉/改名的
   * 页签（或者用户手改过 localStorage），那样 `find` 会返回 undefined，
   * 面板会显示"没有注册任何功能模块"—— 一个改配置就能把界面弄坏的死角。
   */
  const [activeId, setActiveId] = useState(() => {
    const saved = readPanelState(label).featureId;
    return saved && features.some((f) => f.id === saved) ? saved : DEFAULT_FEATURE_ID;
  });

  const [pinned, setPinned] = useState(true);
  /** 全局搜索面板是否打开。 */
  const [paletteOpen, setPaletteOpen] = useState(false);

  /**
   * 定位请求总线。
   *
   * 请求必须存在**这里**、不能存在功能页里：面板只挂载当前页签
   * （见下面的 `<Active />`），用户按回车那一刻目标页签的组件还没挂载，
   * 请求放在组件里会随卸载丢掉。详见 `lib/navigation.ts`。
   */
  const focusBus = useFocusBus();

  const active = features.find((f) => f.id === activeId) ?? features[0];

  /** 切页签，并把它记下来（重启后回到这一页）。 */
  const selectFeature = useCallback(
    (id: string) => {
      setActiveId(id);
      writePanelState(label, { featureId: id });
    },
    [label],
  );

  /**
   * 命令面板的定位请求：切页签 + 把请求交给目标页签。
   *
   * 两件事的顺序不重要（都是 state 更新），但**两件都得做**：
   * 只切页签是这一轮要修的原始 bug（"按了回车没反应"），
   * 只发请求则目标页签根本不会被挂载出来。
   */
  const navigateTo = useCallback(
    (featureId: string, target: FocusRequestInput) => {
      setActiveId(featureId);
      writePanelState(label, { featureId });
      focusBus.request(target);
    },
    [focusBus, label],
  );

  // 图钉的初值必须**读设置**，不能硬编码 true。
  // 面板窗口创建时就是按设置决定置顶的（见 windows.rs 的 show_panel），
  // 这里硬编码会让图标和真实状态对不上：用户明明关了置顶，
  // 图标却显示"已钉住"，点一下还"没反应"（因为本来就是关的）。
  useEffect(() => {
    void (async () => {
      try {
        setPinned((await api.settingsGet()).panelAlwaysOnTop);
      } catch {
        /* 读不到就按默认（置顶）显示 */
      }
    })();
  }, []);

  // 设置页改「面板保持置顶」时，图钉和**窗口本身**都要跟着变。
  //
  // 只改图标是不够的：窗口的置顶标志只在创建时按设置设一次（见 `windows.rs`
  // 的 `show_panel`），而设置页改完并不会重建窗口 —— 那样图标显示"未钉住"、
  // 窗口却仍然压在最上层，等于让图标撒谎。这恰恰是本次要修的那类毛病，
  // 所以监听器里必须把标志也真正套用一次。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onSettingsChanged((s) => {
      setPinned(s.panelAlwaysOnTop);
      // 套用的是**本窗口自己的** label：设置是全局的，但"置顶"这个动作
      // 必须落到每个窗口头上（`applyAlwaysOnTopToAllPanels` 管别的窗口）
      void api.setAlwaysOnTop(label, s.panelAlwaysOnTop).catch(() => {
        /* 套用失败只影响置顶，不该影响界面其余部分 */
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [label]);

  // Ctrl+K 全局搜索；Esc 收起面板；数字键 1-9 快速切页签。
  // 这些快捷键让用户不用鼠标也能操作，是「效率工具」的基本素养。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+K 放在最前面：**输入框里也要能唤出**。
      // 用户可能正在片段里搜东西，突然想起"这条其实记在备忘里"。
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      /**
       * 正在输入框里打字时不要拦截数字键。
       *
       * 判据就是"焦点在不在输入框里"，**没有例外**。
       *
       * 曾经为了救"面板一打开焦点就在搜索框里、数字键全失效"，
       * 把判据改成"框里有内容才算打字"—— 那是个更糟的 bug：
       * **任何空输入框里敲数字都会切页签**。用户在计时页给闹钟起名
       * "1号闹钟"，一敲 `1` 就跳到文本页了。
       *
       * 真正的修法是**不让任何页签自动聚焦输入框**（见 `snippets/index.tsx`
       * 那段说明）：面板打开时焦点在窗口上，数字键正常切页签；
       * 一旦点进某个输入框，数字就是文字。两条规则互不打架。
       */
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

      if (e.key === "Escape") {
        // 与 ✕ 同一套语义：第一个面板是"收起来"，其余的是"关掉"。
        //
        // 不能一律 hide：`new_panel` 用**最小空闲编号**，被隐藏的 `panel-2` 仍占着
        // 那个号，而托盘 / 悬浮球只会唤回第一个面板 —— 于是它既看不见、又回不来、
        // 还一直占着内存。关掉反而是可恢复的：再点「新建窗口」会拿回同一个 label，
        // 连同它上次停的页签与文件夹（见 `panel-state.ts` 的 label 复用说明）。
        //
        // 只收**自己**这个窗口：不带 label 的话多窗口时操作的永远是第一个。
        void closeOrHide();
        return;
      }
      if (typing) return;

      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < features.length) {
        selectFeature(features[index].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [features, label, selectFeature, closeOrHide]);

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);

    // 第一步：把窗口真正置顶 / 取消置顶。**只有它失败才该把图标翻回去。**
    try {
      await api.setAlwaysOnTop(label, next);
    } catch {
      setPinned(!next);
      return;
    }

    // 第二步：落盘。这一步失败**不能**回滚图标 —— 窗口已经真的改了，
    // 翻回去只会让图标撒第二次谎（图标说"未置顶"、窗口却压在最上层）。
    // 落盘失败只影响"下次启动还记不记得"，界面保持与窗口的真实状态一致。
    try {
      // 走 `settingsPatch`（Rust 侧只合并这一项），不要"读出来改一改整份写回去"：
      // 设置有三个写者，整份覆盖写会把别人刚改的字号/配色冲掉。
      const saved = await api.settingsPatch({ panelAlwaysOnTop: next });
      await emitSettingsChanged(saved);
    } catch {
      /* 存不下来只影响下次启动，界面按真实状态显示 */
    }
  };

  /**
   * 再开一个面板窗口。
   *
   * 命令调用失败时给一条明确的提示 —— 静默什么都不做正是这一轮要修的那类毛病。
   *
   * ⚠️ 这里原来举例写的是"窗口数量到上限被 Rust 拒绝"，而**没有这个上限**：
   * `windows::next_panel_label_from` 只是从 2 开始找最小空闲编号（`while used.contains(&n) { n += 1 }`），
   * 不封顶，全仓库也没有任何面板数量上限。留着那句话会让下一个人去找一个
   * 不存在的东西，或者以为有保护而不再加。
   *
   * 真正会失败的路径是**创建窗口本身**失败（`WebviewWindowBuilder::build` 报错：
   * WebView2 运行时异常、系统资源不足等），以及命令没注册 / IPC 出错。
   */
  const openNewPanel = async () => {
    setNewPanelError(null);
    try {
      await panelCommands.newPanel();
    } catch (err) {
      showNotice(`新建窗口失败：${String(err)}`);
    }
  };

  if (!active) {
    return <div className="panel">没有注册任何功能模块。</div>;
  }

  const Active = active.component;

  return (
    <div className="panel">
      {/* 标题栏：整条可拖动，右侧是窗口按钮 */}
      <header className="panel__titlebar" data-tauri-drag-region>
        <span className="panel__brand" data-tauri-drag-region>
          浮光
        </span>
        <span className="panel__crumb" data-tauri-drag-region>
          {active.panelTitle ?? active.title}
        </span>

        {newPanelError && <span className="panel__notice">{newPanelError}</span>}

        <div className="panel__window-actions">
          {/* 搜索按钮是 Ctrl+K 的可见入口：不给按钮的话，
              这个功能只有读过文档的人才知道存在 */}
          <button
            className="iconbtn iconbtn--search"
            onClick={() => setPaletteOpen(true)}
            title="全局搜索（Ctrl+K）"
          >
            <Search size={15} />
          </button>

          {/*
            再开一个面板窗口。
            放在标题栏而不是设置页：这是"我要并排放两个"的即时动作，
            去设置页翻一遍再回来太远。代价是标题栏多一个按钮 ——
            所以尺寸跟着统一到 28×28，四个按钮加起来仍只占约 120px。
          */}
          <button
            className="iconbtn"
            onClick={() => void openNewPanel()}
            title="再开一个面板窗口"
          >
            <AppWindow size={15} />
          </button>

          <button
            className="iconbtn"
            onClick={() => void togglePin()}
            title={pinned ? "取消置顶" : "保持置顶"}
          >
            {pinned ? <Pin size={15} /> : <PinOff size={15} />}
          </button>

          {/*
            ✕ 只处理这个窗口，不退出软件。
            
            这里踩过一个坑：最初 ✕ 绑的是"退出浮光"，结果用户按窗口惯例
            点它想关面板，整个软件被杀掉了，悬浮球也跟着消失。
            ✕ 在任何窗口里都意味着"关掉这个窗口"，把它绑成"杀进程"是危险的错配。
            
            退出软件改到设置页底部，以及小球的右键菜单和托盘菜单里 ——
            那几处是用户明确表达"我要退出"的地方。

            具体行为（隐藏还是销毁、关之前要不要落盘）都在 `closeOrHide` 里，
            与 Esc 共用同一套语义。
          */}
          <button
            className="iconbtn"
            onClick={() => void closeOrHide()}
            title={isFirstPanel ? "收起面板" : "关闭这个面板窗口"}
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {/* 页签栏：由注册表推导，超出宽度时横向滚动 */}
      <nav className="tabs">
        {features.map((f, i) => (
          <button
            key={f.id}
            className={`tabs__item${f.id === activeId ? " tabs__item--active" : ""}`}
            onClick={() => selectFeature(f.id)}
            title={`${f.description ?? f.title}${i < 9 ? `（快捷键 ${i + 1}）` : ""}`}
          >
            <f.icon size={14} />
            <span>{f.title}</span>
            {f.wip && <span className="tabs__wip">开发中</span>}
          </button>
        ))}
      </nav>

      {/*
        当前功能页。
        `<Active />` **保持无 props**（页签是刻意做成可扩展的，
        不该因为外壳要加一个能力就让每个功能模块都改签名）；
        定位请求通过 context 往下发，功能页自己用 `usePendingFocus` 取。

        Provider 不渲染任何 DOM，所以不影响布局。
      */}
      <main className="panel__body">
        <FocusContext.Provider value={focusBus}>
          <Active />
        </FocusContext.Provider>
      </main>

      {/* 搜索面板盖在内容之上，但页签栏和标题栏仍然可见——
          用户能一眼看出"我还在这四个页签的应用里" */}
      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={navigateTo} />
      )}
    </div>
  );
}
