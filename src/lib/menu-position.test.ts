/**
 * 菜单定位的测试。
 *
 * 这些断言针对的都是"只在边缘才出错"的情况 —— 中间那些格子怎么算都对，
 * 出问题的永远是最后一列和最下面一行。而那种错的表现是「点了⋯没反应」，
 * 用户不会想到是菜单弹到屏幕外面去了。
 */
import { describe, expect, it } from "vitest";

import { placeMenu } from "./menu-position";

/** 面板就是 420×640（和真实主面板一致），菜单按实测的 186×170 算。 */
const VIEW = { width: 420, height: 640 };
const MENU = { width: 186, height: 170 };

/** 第 n 列（0 起）的格子按钮矩形：一行四列，格子 95px，间距 6px，左内边距 10px。 */
function tile(col: number, row: number) {
  const left = 10 + col * 101;
  const top = 120 + row * 106;
  return { left, top, right: left + 95, bottom: top + 100 };
}

describe("placeMenu", () => {
  it("中间那些格子：右对齐到按钮右边缘、向下展开", () => {
    const a = tile(1, 1); // 第 2 列第 2 行，四周都有空间
    const { left, top } = placeMenu(a, MENU, VIEW);
    expect(left).toBe(a.right - MENU.width);
    expect(top).toBe(a.bottom + 6);
  });

  it("最后一列：右对齐到按钮右边缘，菜单仍在面板内", () => {
    // 第 4 列的按钮右边缘是 408，离面板右边缘还有 12px，
    // 所以这里**不该**触发夹取 —— 菜单的右边缘就是按钮的右边缘
    const a = tile(3, 0);
    const { left } = placeMenu(a, MENU, VIEW);
    expect(left).toBe(a.right - MENU.width);
    expect(left + MENU.width).toBeLessThanOrEqual(VIEW.width - 8);
  });

  it("按钮真的贴住右边缘时，菜单被夹回来而不是被切掉", () => {
    // 右边缘只剩 2px：不夹的话菜单右边 6px 会跑到面板外
    const a = { left: 340, top: 100, right: 418, bottom: 200 };
    const { left } = placeMenu(a, MENU, VIEW);
    expect(left).toBe(VIEW.width - MENU.width - 8);
    expect(left + MENU.width).toBeLessThanOrEqual(VIEW.width - 8);
  });

  it("第一列：不会越过左边缘", () => {
    // 按钮很窄、菜单比它宽时，"右对齐"会把菜单推到左边去
    const a = { left: 2, top: 100, right: 30, bottom: 140 };
    expect(placeMenu(a, MENU, VIEW).left).toBe(8);
  });

  it("最下面一行：菜单翻到按钮上方", () => {
    const a = tile(0, 4); // 底部那一行
    const { top } = placeMenu(a, MENU, VIEW);
    expect(top).toBe(a.top - MENU.height - 6);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + MENU.height).toBeLessThanOrEqual(VIEW.height);
  });

  it("上下都放不下时贴住上边，绝不出现负坐标", () => {
    // 窗口比菜单还矮的极端情况：宁可盖住按钮，也不能把菜单摆到看不见的地方
    const tiny = { width: 420, height: 100 };
    const a = { left: 10, top: 10, right: 105, bottom: 90 };
    const { top } = placeMenu(a, MENU, tiny);
    expect(top).toBe(8);
  });

  it("窗口比菜单还窄时不会算出负数 left", () => {
    const narrow = { width: 120, height: 640 };
    const a = { left: 10, top: 100, right: 105, bottom: 200 };
    const { left } = placeMenu(a, MENU, narrow);
    expect(left).toBe(8);
    // 这种情况下菜单必然会超出窗口，但至少不是负坐标（负坐标等于整个看不见）
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it("任何按钮位置 × 任何菜单尺寸都不会跑到窗口外", () => {
    // 扫一遍：4 列 × 5 行 × 几种菜单尺寸（网址没有「启动参数」那行，会更矮）
    for (const menu of [MENU, { width: 186, height: 136 }, { width: 260, height: 170 }]) {
      for (let col = 0; col < 4; col += 1) {
        for (let row = 0; row < 5; row += 1) {
          const { left, top } = placeMenu(tile(col, row), menu, VIEW);
          expect(left).toBeGreaterThanOrEqual(0);
          expect(top).toBeGreaterThanOrEqual(0);
          expect(left + menu.width).toBeLessThanOrEqual(VIEW.width);
          expect(top + menu.height).toBeLessThanOrEqual(VIEW.height);
        }
      }
    }
  });
});
