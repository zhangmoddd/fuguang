/**
 * 主面板窗口。
 *
 * 结构：标题栏 + 页签栏 + 当前功能内容。
 * 页签栏完全由 `registry.ts` 推导，这里不认识任何具体功能，
 * 所以以后新增功能不需要改动这个文件。
 */
import { useEffect, useMemo, useState } from "react";
import { Pin, PinOff, Search, X } from "lucide-react";

import { DEFAULT_FEATURE_ID, sortedFeatures } from "../features/registry";
import { api, emitSettingsChanged, onSettingsChanged } from "../lib/api";
import { CommandPalette } from "../lib/command-palette";

export function PanelWindow() {
  const features = useMemo(() => sortedFeatures(), []);
  const [activeId, setActiveId] = useState(DEFAULT_FEATURE_ID);
  const [pinned, setPinned] = useState(true);
  /** 全局搜索面板是否打开。 */
  const [paletteOpen, setPaletteOpen] = useState(false);

  const active = features.find((f) => f.id === activeId) ?? features[0];

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
      // 这个监听器就活在面板窗口里，所以窗口必然存在，可以直接套用
      void api.setAlwaysOnTop("panel", s.panelAlwaysOnTop).catch(() => {
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
  }, []);

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
        void api.hidePanel();
        return;
      }
      if (typing) return;

      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < features.length) {
        setActiveId(features[index].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [features]);

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);

    // 第一步：把窗口真正置顶 / 取消置顶。**只有它失败才该把图标翻回去。**
    try {
      await api.setAlwaysOnTop("panel", next);
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

        <div className="panel__window-actions">
          {/* 搜索按钮是 Ctrl+K 的可见入口：不给按钮的话，
              这个功能只有读过文档的人才知道存在 */}
          <button
            className="iconbtn"
            onClick={() => setPaletteOpen(true)}
            title="全局搜索（Ctrl+K）"
          >
            <Search size={13} />
          </button>

          <button
            className="iconbtn"
            onClick={() => void togglePin()}
            title={pinned ? "取消置顶" : "保持置顶"}
          >
            {pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>

          {/*
            ✕ 只收起面板，不退出软件。
            
            这里踩过一个坑：最初 ✕ 绑的是"退出浮光"，结果用户按窗口惯例
            点它想关面板，整个软件被杀掉了，悬浮球也跟着消失。
            ✕ 在任何窗口里都意味着"关掉这个窗口"，把它绑成"杀进程"是危险的错配。
            
            退出软件改到设置页底部，以及小球的右键菜单和托盘菜单里 ——
            那几处是用户明确表达"我要退出"的地方。
          */}
          <button className="iconbtn" onClick={() => void api.hidePanel()} title="收起面板">
            <X size={13} />
          </button>
        </div>
      </header>

      {/* 页签栏：由注册表推导，超出宽度时横向滚动 */}
      <nav className="tabs">
        {features.map((f, i) => (
          <button
            key={f.id}
            className={`tabs__item${f.id === activeId ? " tabs__item--active" : ""}`}
            onClick={() => setActiveId(f.id)}
            title={`${f.description ?? f.title}${i < 9 ? `（快捷键 ${i + 1}）` : ""}`}
          >
            <f.icon size={14} />
            <span>{f.title}</span>
            {f.wip && <span className="tabs__wip">开发中</span>}
          </button>
        ))}
      </nav>

      <main className="panel__body">
        <Active />
      </main>

      {/* 搜索面板盖在内容之上，但页签栏和标题栏仍然可见——
          用户能一眼看出"我还在这四个页签的应用里" */}
      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onNavigate={setActiveId} />
      )}
    </div>
  );
}
