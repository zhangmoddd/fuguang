/**
 * 功能模块注册表。
 *
 * 这是浮光「以后加功能不用动主面板」的实现基础。
 *
 * 加一个新功能只需要两步：
 * 1. 在 `src/features/<你的功能>/index.tsx` 里导出一个 `FeatureModule`
 * 2. 在下面的 `FEATURES` 数组里加一行
 *
 * 主面板的页签栏、快捷键、图标全部从这张表推导出来，不需要改主面板代码。
 * 页签栏会自动处理「放不下」的情况，把多余项收进「更多」。
 */
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

import { SnippetsFeature } from "./snippets";
import { TimerFeature } from "./timer";
import { MemoFeature } from "./memo";
import { LinksFeature } from "./links";

/** 一个功能模块的声明。 */
export interface FeatureModule {
  /** 唯一标识，同时用作数据文件名前缀与页签 key。 */
  id: string;
  /** 页签上显示的名字。 */
  title: string;
  /** 鼠标悬停提示。 */
  description?: string;
  /**
   * 页签图标。
   * 用 `LucideIcon` 而不是自定义 props 类型：lucide 的 `strokeWidth`
   * 允许 string，自定义窄类型会导致所有图标组件都无法赋值。
   */
  icon: LucideIcon;
  /** 页签排序，小的在左。 */
  order: number;
  /** 面板内的标题，不填则用 title。 */
  panelTitle?: string;
  /** 该功能的主界面。 */
  component: ComponentType;
  /** 是否仍处于开发中（页签上会显示标记）。 */
  wip?: boolean;
}

/**
 * 已注册的功能模块。
 *
 * 顺序由每个模块自己的 `order` 决定，这里的书写顺序不影响展示，
 * 这样多人协作时不会因为合并顺序产生无意义的 diff 冲突。
 */
export const FEATURES: FeatureModule[] = [
  SnippetsFeature,
  TimerFeature,
  MemoFeature,
  LinksFeature,
];

/** 按 order 排好序的功能列表，主面板直接用这个。 */
export function sortedFeatures(): FeatureModule[] {
  return [...FEATURES].sort((a, b) => a.order - b.order);
}

/** 按 id 找功能。 */
export function findFeature(id: string): FeatureModule | undefined {
  return FEATURES.find((f) => f.id === id);
}

/** 面板默认打开的功能：优先文本片段，因为它是第一版唯一完整的功能。 */
export const DEFAULT_FEATURE_ID = "snippets";
