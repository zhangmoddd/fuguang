/**
 * 「让位」顺序的测试。
 *
 * # 为什么这几条非有不可
 *
 * 这个函数决定了拖动时**空位出现在哪里**，而它的输入来自一份
 * "按下那一刻缓存下来的矩形"（每帧重测会强制同步布局，见 drag-drop.ts 的说明）。
 * 也就是说：它算出来的顺序必须**只跟指针扫过的位置单调相关**，
 * 一旦出现"同一段指针位置对应两个顺序"，画面就会来回闪 ——
 * 而闪的根源在纯逻辑里，不在渲染里，所以只能在这里钉死。
 */
import { describe, expect, it } from "vitest";

import { previewOrder, type DropSpot } from "./drag-drop";

const IDS = ["a", "b", "c", "d"];

/** 落点：插到 `id` 的前面/后面。 */
const before = (id: string): DropSpot => ({ kind: "item", id, before: true });
const after = (id: string): DropSpot => ({ kind: "item", id, before: false });

describe("previewOrder", () => {
  it("没在拖的时候原样返回", () => {
    expect(previewOrder(IDS, "", null)).toEqual(IDS);
  });

  it("拖到文件夹上（放进去）不改变顺序", () => {
    // 拖到文件夹上是"归类"，不是"排序"，两件事不能混
    expect(previewOrder(IDS, "a", { kind: "folder", id: "f1" })).toEqual(IDS);
  });

  it("往右拖一格：插到目标后面", () => {
    expect(previewOrder(IDS, "a", after("b"))).toEqual(["b", "a", "c", "d"]);
  });

  it("往左拖一格：插到目标前面", () => {
    expect(previewOrder(IDS, "d", before("c"))).toEqual(["a", "b", "d", "c"]);
  });

  it("拖到最前面 / 最后面", () => {
    expect(previewOrder(IDS, "d", before("a"))).toEqual(["d", "a", "b", "c"]);
    expect(previewOrder(IDS, "a", after("d"))).toEqual(["b", "c", "d", "a"]);
  });

  it("拖回自己原来的位置不动", () => {
    // 落点命中的是被拖的那个自己（拖拽开始时缓存了它自己的矩形）
    expect(previewOrder(IDS, "b", before("b"))).toEqual(IDS);
    expect(previewOrder(IDS, "b", after("b"))).toEqual(IDS);
  });

  it("落点不在这一段里时不动", () => {
    // 拖的是文件夹、落点是链接：两段互不影响
    expect(previewOrder(IDS, "a", before("zzz"))).toEqual(IDS);
  });

  it("被拖的那个一定在结果里，且一个都不多一个都不少", () => {
    // 调用方靠这一点把它渲染成空位：少了它就没人占位，多了就多一个格子
    for (const over of [before("a"), after("a"), before("c"), after("d"), null]) {
      const out = previewOrder(IDS, "b", over);
      expect([...out].sort()).toEqual([...IDS].sort());
    }
  });

  it("指针从左扫到右时，空位位置单调不回头", () => {
    // 这条是最要紧的：不单调就会来回闪。
    // 模拟指针依次扫过 a b c d 的左右半边，记下被拖那个的位次。
    const dragged = "d";
    const sweep: DropSpot[] = [
      before("a"), after("a"), before("b"), after("b"),
      before("c"), after("c"), before("d"), after("d"),
    ];
    const positions = sweep.map((over) => previewOrder(IDS, dragged, over).indexOf(dragged));

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
    }
    expect(positions[0]).toBe(0);
    expect(positions[positions.length - 1]).toBe(3);
  });

  it("反着扫也单调（从右往左）", () => {
    const dragged = "a";
    const sweep: DropSpot[] = [
      after("d"), before("d"), after("c"), before("c"),
      after("b"), before("b"), after("a"), before("a"),
    ];
    const positions = sweep.map((over) => previewOrder(IDS, dragged, over).indexOf(dragged));

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeLessThanOrEqual(positions[i - 1]);
    }
    expect(positions[0]).toBe(3);
    expect(positions[positions.length - 1]).toBe(0);
  });

  it("空数组和只有一个元素时不炸", () => {
    expect(previewOrder([], "a", before("b"))).toEqual([]);
    expect(previewOrder(["a"], "a", before("a"))).toEqual(["a"]);
    expect(previewOrder(["a"], "a", before("zzz"))).toEqual(["a"]);
  });
});
