/**
 * 计时器功能（第一版为占位，显示已确定的设计规格）。
 *
 * 已确定的设计决策（实现时按这些做，不要重新发明）：
 * - 三种模式：倒计时 / 番茄钟 / 秒表
 * - 倒计时存「绝对结束时刻」而不是剩余秒数，关机重启后仍然准确
 * - 结束后弹置顶提醒窗 + 提示音，且不抢焦点
 * - 支持多路倒计时并行，每条可命名、可暂停/继续/重置
 */
import { Clock } from "lucide-react";

import type { FeatureModule } from "../registry";

export function TimerPanel() {
  return (
    <div className="placeholder">
      <Clock size={28} />
      <h3>计时器 · 开发中</h3>
      <p>这一版先把「文本片段」这条链路跑通，计时器排在下一个。</p>
      <ul>
        <li>倒计时（多路并行、可命名、可暂停）</li>
        <li>番茄钟（专注 + 休息自动循环）</li>
        <li>秒表（计次记录）</li>
        <li>结束后置顶弹窗 + 提示音，不打断当前输入</li>
      </ul>
    </div>
  );
}

export const TimerFeature: FeatureModule = {
  id: "timer",
  title: "计时",
  description: "倒计时、番茄钟、秒表",
  icon: Clock,
  order: 20,
  component: TimerPanel,
  wip: true,
};
