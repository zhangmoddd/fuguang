/**
 * 备忘录功能（第一版为占位，显示已确定的设计规格）。
 *
 * 已确定的设计决策：
 * - 按日期归集的日记式：选一天，看那天的所有笔记
 * - 「记录日期」与「提醒时间」是两个独立字段
 *   （所以可以今天先记下下周要做的事）
 * - 提醒支持：单次 / 每天 / 每周 / 每月 / 工作日
 * - 错过的提醒在开机后汇总补发一条「你错过了 N 条提醒」
 */
import { NotebookPen } from "lucide-react";

import type { FeatureModule } from "../registry";

export function MemoPanel() {
  return (
    <div className="placeholder">
      <NotebookPen size={28} />
      <h3>备忘录 · 开发中</h3>
      <p>按日期翻的日记本，每条笔记可以单独挂一个提醒。</p>
      <ul>
        <li>按日期归集，像翻日记一样回顾</li>
        <li>记录日期与提醒时间分开，可以提前很久记下将来的事</li>
        <li>提醒重复：单次 / 每天 / 每周 / 每月 / 工作日</li>
        <li>错过提醒开机后汇总补发，不会真的漏事</li>
      </ul>
    </div>
  );
}

export const MemoFeature: FeatureModule = {
  id: "memo",
  title: "备忘",
  description: "按日期记笔记，可挂定时提醒",
  icon: NotebookPen,
  order: 30,
  component: MemoPanel,
  wip: true,
};
