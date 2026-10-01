/**
 * 页签缩放。
 *
 * # 缩放的是「尺寸」，不是「字号」
 *
 * 链接页是图标网格，缩放改的是**格子大小**（一行放得下几个）；
 * 文本 / 计时 / 备忘是纵向列表，缩放改的是**列表项密度**
 * （行高、内边距、图标尺寸）。
 *
 * 两者都**不动字体大小** —— 字号是设置页里那个独立的「界面字号」。
 * 把两套东西混在一起，用户就永远说不清"我到底调的是哪个"。
 *
 * # 手势为什么是 Ctrl + 滚轮
 *
 * 普通滚轮必须留给滚动列表：列表长了要能滚，而"滚一下就变大小"是没法用的。
 * Ctrl + 滚轮是桌面软件里「缩放」的通用手势。
 *
 * # 值存在哪
 *
 * 每个页签一个百分比，存进 `settings.json` 的 `zoom` 字段（键是页签 id）。
 * 认不出来的键不影响显示，也不会因为以后卸载了某个页签就把用户的选择删掉。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api, emitSettingsChanged, type Settings } from "./api";

/** 与 Rust 侧 `models::ZOOM_MIN` / `ZOOM_MAX` 保持一致。 */
export const ZOOM_MIN = 70;
/** 见 [`ZOOM_MIN`]。 */
export const ZOOM_MAX = 160;
/** 没有单独设置过的页签用这一档。 */
export const ZOOM_DEFAULT = 100;
/** 每滚一格的步长。 */
export const ZOOM_STEP = 10;

/**
 * 把任意数字夹到合法档位，并对齐到步长。
 *
 * 对齐这一步是为了手改数据文件的情况：写成 `137` 也能落回 `140`，
 * 而不是让界面卡在一个"说不出是什么档"的大小上。
 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
  return Math.round(clamped / ZOOM_STEP) * ZOOM_STEP;
}

/** 缩放的落盘防抖时间（毫秒）。 */
const SAVE_DELAY_MS = 400;

export interface ZoomControl {
  /** 当前缩放百分比。 */
  percent: number;
  /** 加减若干格。 */
  step: (dir: 1 | -1) => void;
  /**
   * 挂到**整页根节点**上（`<div ref={zoom.ref}>`）。
   *
   * 用回调 ref 而不是 `useRef` 的对象 ref，是因为有两个页签（文本、备忘）
   * 在编辑时会把整页内容换成编辑器——根节点是个**新的** DOM 元素。
   * 对象 ref 那种写法只在挂载时读一次 `ref.current`，换元素之后
   * 监听还挂在旧的（已经从文档里摘掉的）节点上，表现就是
   * 「编辑一次回来，Ctrl+滚轮就失灵了」。
   */
  ref: (el: HTMLDivElement | null) => void;
}

/**
 * 把一个页签的缩放绑起来。
 *
 * @param featureId - 页签 id（`FeatureModule.id`），同时是 `settings.zoom` 里的键
 */
export function useZoom(featureId: string): ZoomControl {
  const [percent, setPercent] = useState(ZOOM_DEFAULT);
  /** 当前的根节点。用 state 而不是 ref，换元素时才能重新挂监听（见 ZoomControl.ref）。 */
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setNode(el), []);

  /** 当前档位。滚轮会连发十几个事件，靠 state 读会读到旧值。 */
  const current = useRef(ZOOM_DEFAULT);
  /** 还没落盘的档位；null 表示没有待写的改动。 */
  const pending = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    current.current = percent;
  }, [percent]);

  // 启动时读一次已保存的档位
  useEffect(() => {
    let alive = true;
    void api
      .settingsGet()
      .then((s) => {
        if (!alive) return;
        setPercent(clampZoom(s.zoom?.[featureId] ?? ZOOM_DEFAULT));
      })
      .catch(() => {
        /* 读不到就用默认档。外观偏好不该成为打不开界面的原因 */
      });
    return () => {
      alive = false;
    };
  }, [featureId]);

  /**
   * 把待写的档位落盘。
   *
   * 两个关键细节：
   *
   * 1. **保存前重新读一次设置**。`settings_save` 是整份覆盖写的，
   *    如果拿启动时读到的那个副本去写，会把用户刚在设置页改的字号、
   *    热键、配色一起冲掉。
   * 2. **防抖**。滚轮一次滑动连发十几个事件，每个都写一次文件太浪费。
   */
  const flush = useCallback(async () => {
    const value = pending.current;
    pending.current = null;
    saveTimer.current = null;
    if (value === null) return;

    try {
      const fresh = await api.settingsGet();
      const next: Settings = {
        ...fresh,
        zoom: { ...fresh.zoom, [featureId]: value },
      };
      await api.settingsSave(next);
      await emitSettingsChanged(next);
    } catch {
      /* 存不下来只影响"下次打开还记不记得"，不该打断当前操作 */
    }
  }, [featureId]);

  const schedule = useCallback(
    (value: number) => {
      pending.current = value;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void flush();
      }, SAVE_DELAY_MS);
    },
    [flush],
  );

  // 卸载时把还没落盘的档位补写一次。
  // 切页签会卸载组件，不补的话"滚完立刻切页签"这次调整就丢了。
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      void flush();
    };
  }, [flush]);

  /** 改到某一档。相同则什么都不做，避免无意义的重渲染与写盘。 */
  const apply = useCallback(
    (next: number) => {
      const value = clampZoom(next);
      if (value === current.current) return;
      current.current = value;
      setPercent(value);
      schedule(value);
    },
    [schedule],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      apply(current.current + dir * ZOOM_STEP);
    },
    [apply],
  );

  useEffect(() => {
    if (!node) return;

    const onWheel = (e: WheelEvent) => {
      // 只有按住 Ctrl 才缩放：普通滚轮必须留给滚动列表
      if (!e.ctrlKey) return;

      // 必须拦掉默认行为。不拦的话 WebView2 会把**整个界面**缩放，
      // 而那个缩放没有菜单可以还原——用户会以为软件坏了。
      e.preventDefault();

      apply(current.current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    };

    // 必须显式 `passive: false`：滚轮监听默认是被动的，
    // 被动监听里 preventDefault() 会被直接忽略，界面就会被 WebView2 缩放。
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [node, apply]);

  return { percent, step, ref };
}
