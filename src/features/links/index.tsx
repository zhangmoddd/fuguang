/**
 * 快捷链接功能（第一版为占位，显示已确定的设计规格）。
 *
 * 已确定的设计决策：
 * - 纯启动器：点了就在外部打开，不把外部程序嵌进面板
 *   （内嵌窗口是「臃肿」和一堆兼容问题的来源，刻意不做）
 * - 支持 exe / 文件夹 / 任意文件 / 网址
 * - 添加方式：系统文件选择框 + 拖拽 + 自动取图标
 */
import { Link2 } from "lucide-react";

import type { FeatureModule } from "../registry";

export function LinksPanel() {
  return (
    <div className="placeholder">
      <Link2 size={28} />
      <h3>快捷链接 · 开发中</h3>
      <p>把常用的软件、文件夹、网址集中到一处，点一下就打开。</p>
      <ul>
        <li>纯启动器，不内嵌外部程序，所以又快又不会卡</li>
        <li>支持程序、文件夹、文档、网址</li>
        <li>拖进来就能加，自动取图标</li>
      </ul>
    </div>
  );
}

export const LinksFeature: FeatureModule = {
  id: "links",
  title: "链接",
  description: "常用软件、文件夹、网址，一点就开",
  icon: Link2,
  order: 40,
  component: LinksPanel,
  wip: true,
};
