/**
 * 悬浮球窗口。
 *
 * 交互设计：
 * - 左键单击：展开/收起主面板
 * - 右键单击：弹出原生快捷菜单
 * - 按住拖动：移动小球位置
 *
 * 为什么右键用系统原生菜单而不是在窗口里自绘：
 * 小球窗口只有 56×56 逻辑像素，而菜单至少需要 150×120。
 * 自绘菜单会被窗口边界裁掉；把窗口撑大则那片透明区域会挡住桌面点击。
 * 原生菜单不占窗口空间，还会在靠近屏幕边缘时自动翻转回屏幕内。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, onSettingsChanged } from "../lib/api";
import { applyBallTheme } from "../lib/ball-theme";

export function BallWindow() {
  const [busy, setBusy] = useState(false);

  /** 拖动状态。用 ref 而不是 state，避免拖动过程中触发重渲染。 */
  const drag = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  /**
   * 订阅设置变更，实时套用悬浮球配色。
   *
   * 必须有这个订阅：小球和主面板是**两个独立窗口**，
   * 在设置页里改 CSS 变量只影响设置页自己的 DOM，
   * 小球那个窗口完全不知道 —— 实测就是这个原因导致"换了配色但球不变色"。
   *
   * 启动时的首次套用在 `main.tsx` 里做（读一次设置），
   * 这里只负责"之后被改动了"的情况。
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onSettingsChanged((s) => applyBallTheme(s.ballTheme)).then((fn) => {
      // 订阅是异步建立的，可能还没建立组件就卸载了
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * 记住小球的位置。
   *
   * 拖动是交给系统做的（`startDragging()`），我们收不到"拖完了"的回调，
   * 所以改成监听窗口移动事件 + **防抖**：拖动过程中事件会连发几十上百次，
   * 每来一次就写一遍文件太浪费。防抖窗口结束那次一定会写，
   * 所以松手之后的最终位置不会丢。
   *
   * 位置存进单独的 `window.json`（见 `api.saveBallPos` 的说明），
   * 不走设置文件——设置是整份覆盖写的，两个窗口各写一份会互相冲掉。
   */
  useEffect(() => {
    let timer: number | null = null;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWindow()
      .onMoved(({ payload }) => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          void (async () => {
            try {
              // 按**逻辑**像素存：物理像素在不同缩放比例的屏幕上不可比，
              // 换一台机器读回来就会跑到别的地方
              const scale = await getCurrentWindow().scaleFactor();
              await api.saveBallPos(payload.x / scale, payload.y / scale);
            } catch {
              /* 位置存不下来只影响"下次开机回到哪"，不该打断任何事 */
            }
          })();
        }, 400);
      })
      .then((fn) => {
        // 订阅是异步建立的，可能还没建立组件就卸载了
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  /**
   * 指针按下：先记下起点，但**不立即**进入拖动。
   *
   * 这里刻意不用 Tauri 的 `data-tauri-drag-region`：那个属性会吃掉 click 事件，
   * 导致左键点击无法打开面板。
   *
   * 也不能自己用 `e.screenX` 算增量去改窗口位置——那条路在缩放不为 1 的屏幕上
   * 会因逻辑/物理像素换算而累积误差，实测会把小球甩到屏幕另一头。
   * 正确做法是超过阈值后交给系统原生拖动。
   */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { startX: e.screenX, startY: e.screenY, moved: false };
  }, []);

  useEffect(() => {
    /** 超过这个像素距离才算拖动，避免手抖把点击变成移动。 */
    const DRAG_THRESHOLD = 4;

    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.moved) return;

      const dx = e.screenX - d.startX;
      const dy = e.screenY - d.startY;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

      // 超过阈值：认定用户在拖动，交给系统原生拖动，后续移动由 Windows 接管。
      d.moved = true;
      void getCurrentWindow().startDragging();
    };

    const onUp = async () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;

      // 没超过阈值 = 单击，展开/收起面板
      if (!d.moved) {
        setBusy(true);
        try {
          await api.togglePanel();
        } finally {
          setBusy(false);
        }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void api.showBallMenu();
  }, []);

  return (
    <div className="ball-root">
      <div
        className={`ball${busy ? " ball--busy" : ""}`}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        title="左键打开面板 · 右键快捷菜单 · 按住可拖动"
      >
        {/* 标志的图形来自 CSS 里的 mask（见 styles.css 的 .ball__mark），
            颜色由 --ball-mark 决定。所以这里不需要 img，也不需要传资源。 */}
        <span className="ball__mark" />
      </div>
    </div>
  );
}
