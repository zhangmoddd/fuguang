/**
 * 主面板窗口。
 *
 * 结构：标题栏 + 页签栏 + 当前功能内容。
 * 页签栏完全由 `registry.ts` 推导，这里不认识任何具体功能，
 * 所以以后新增功能不需要改动这个文件。
 */
import { useEffect, useMemo, useState } from "react";
import { Minus, Pin, PinOff, X } from "lucide-react";

import { DEFAULT_FEATURE_ID, sortedFeatures } from "../features/registry";
import { api } from "../lib/api";

export function PanelWindow() {
  const features = useMemo(() => sortedFeatures(), []);
  const [activeId, setActiveId] = useState(DEFAULT_FEATURE_ID);
  const [pinned, setPinned] = useState(true);

  const active = features.find((f) => f.id === activeId) ?? features[0];

  // Esc 收起面板；数字键 1-9 快速切页签。
  // 这些快捷键让用户不用鼠标也能操作，是「效率工具」的基本素养。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 正在输入框里打字时不要拦截数字键
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

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
    await api.setAlwaysOnTop("panel", next);
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
          <button
            className="iconbtn"
            onClick={() => void togglePin()}
            title={pinned ? "取消置顶" : "保持置顶"}
          >
            {pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <button className="iconbtn" onClick={() => void api.hidePanel()} title="收起面板">
            <Minus size={13} />
          </button>
          <button className="iconbtn iconbtn--danger" onClick={() => void api.quit()} title="退出浮光">
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
    </div>
  );
}
