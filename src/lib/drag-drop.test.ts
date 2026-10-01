/**
 * `drag-drop.ts` 里纯逻辑的测试。
 *
 * 拖拽这件事**没法在 jsdom 里测**（没有布局，`getBoundingClientRect` 全是 0），
 * 所以这里只把「指针落在哪儿、插到前面还是后面」这个判定钉死——
 * 它恰好是整个交互里唯一会算错、而且算错了不容易被发现的部分
 * （表现是"偶尔放不进去"或者"插到了隔壁"）。
 */
import { describe, expect, it } from "vitest";

import { resolveDrop, canStartDrag, type DropCandidate } from "./drag-drop";

/** 造一个候选落点。用「左上角 + 宽高」比写四个边界值好读。 */
function box(
  id: string,
  kind: "item" | "folder",
  left: number,
  top: number,
  w: number,
  h: number,
): DropCandidate {
  return { id, kind, rect: { left, top, right: left + w, bottom: top + h } };
}

describe("resolveDrop 基本判定", () => {
  it("点在所有候选之外就是没命中", () => {
    const candidates = [box("a", "item", 0, 0, 100, 50)];
    expect(resolveDrop(150, 25, candidates, "vertical")).toBeNull();
    expect(resolveDrop(50, 80, candidates, "vertical")).toBeNull();
    expect(resolveDrop(-1, -1, candidates, "vertical")).toBeNull();
  });

  it("没有候选时返回 null", () => {
    expect(resolveDrop(10, 10, [], "vertical")).toBeNull();
  });

  it("边界上算命中（闭区间）", () => {
    // 用半开区间的话，两个相邻卡片之间会有一条"谁都放不进去"的缝，
    // 指针正好落在缝上时表现为"拖过去没反应"
    const candidates = [box("a", "item", 0, 0, 100, 50)];
    expect(resolveDrop(0, 0, candidates, "vertical")).not.toBeNull();
    expect(resolveDrop(100, 50, candidates, "vertical")).not.toBeNull();
  });

  it("负坐标也能正确判断", () => {
    // 副屏摆在主屏左边时，视口坐标可能是负数
    const candidates = [box("left-screen", "item", -1920, 0, 1920, 1080)];
    expect(resolveDrop(-500, 500, candidates, "vertical")).not.toBeNull();
    expect(resolveDrop(10, 500, candidates, "vertical")).toBeNull();
  });
});

describe("resolveDrop 落点类型", () => {
  it("落在文件夹卡片上就是「放进去」", () => {
    const candidates = [box("f1", "folder", 0, 0, 100, 50)];
    expect(resolveDrop(50, 25, candidates, "vertical")).toEqual({ kind: "folder", id: "f1" });
  });

  it("文件夹排在前面时优先命中文件夹", () => {
    // 候选顺序就是优先级：顺序不确定的话，同一次拖动会一会儿放进去、
    // 一会儿插到前后。调用方负责把文件夹排在前面（见 useDragSort 的 collect）
    const candidates = [
      box("folder", "folder", 0, 0, 100, 100),
      box("item", "item", 0, 0, 100, 100),
    ];
    expect(resolveDrop(50, 50, candidates, "vertical")).toEqual({
      kind: "folder",
      id: "folder",
    });
  });
});

describe("resolveDrop 插入位置", () => {
  it("纵向列表：上半插到前面，下半插到后面", () => {
    const candidates = [box("a", "item", 0, 0, 100, 50)];
    expect(resolveDrop(50, 10, candidates, "vertical")).toEqual({
      kind: "item",
      id: "a",
      before: true,
    });
    expect(resolveDrop(50, 40, candidates, "vertical")).toEqual({
      kind: "item",
      id: "a",
      before: false,
    });
  });

  it("横向 / 网格：左半插到前面，右半插到后面", () => {
    const candidates = [box("a", "item", 0, 0, 100, 50)];
    expect(resolveDrop(10, 25, candidates, "horizontal")).toEqual({
      kind: "item",
      id: "a",
      before: true,
    });
    expect(resolveDrop(90, 25, candidates, "horizontal")).toEqual({
      kind: "item",
      id: "a",
      before: false,
    });
  });

  it("正中线上算「插到后面」", () => {
    // 边界必须确定：`<` 还是 `<=` 决定了正好压在分割线时的行为，
    // 含糊的话同一个位置会时前时后
    const candidates = [box("a", "item", 0, 0, 100, 50)];
    expect(resolveDrop(50, 25, candidates, "vertical")).toEqual({
      kind: "item",
      id: "a",
      before: false,
    });
  });

  it("多个条目各自命中自己的区域", () => {
    const candidates = [
      box("a", "item", 0, 0, 100, 50),
      box("b", "item", 0, 60, 100, 50),
    ];
    expect(resolveDrop(50, 40, candidates, "vertical")).toEqual({
      kind: "item",
      id: "a",
      before: false,
    });
    expect(resolveDrop(50, 70, candidates, "vertical")).toEqual({
      kind: "item",
      id: "b",
      before: true,
    });
    // 两个卡片中间的空隙：没命中任何候选
    expect(resolveDrop(50, 55, candidates, "vertical")).toBeNull();
  });
});

describe("canStartDrag：按下点能不能发起拖拽", () => {
  it("空白处按下可以拖", () => {
    expect(canStartDrag(false, false)).toBe(true);
  });

  it("普通控件上按下不拖（点了就是点了）", () => {
    // 不拦的话手抖越过 6px 阈值就把「点删除」变成「拖卡片」
    expect(canStartDrag(true, false)).toBe(false);
  });

  it("显式抓手即使本身是控件也允许拖", () => {
    // 文件夹卡片本体那个「打开」按钮：既是按钮，又是排序唯一的抓手
    expect(canStartDrag(true, true)).toBe(true);
  });

  it("空白处按下时抓手标志无关紧要", () => {
    expect(canStartDrag(false, true)).toBe(true);
  });
});
