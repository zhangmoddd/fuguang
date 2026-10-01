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

import {
  previewOrder,
  resolveSortSpot,
  type DropCandidate,
  type DropSpot,
} from "./drag-drop";

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

// ===============================================================
// 落点判定：离指针最近的那一条
// ===============================================================

const COLS = 3;
const TILE = 100;

/**
 * 把一串 id 铺进 3 列的网格，返回每个格子的矩形。
 *
 * `draggedId` 那一格**不返回** —— 它在界面上是个空位，不是候选
 * （渲染成空位的 div 没有 `data-drop-item`，`collect` 收不到它）。
 * 这正是自稳的关键：指针落在空位上时，最近的候选自然变成它的邻居。
 */
function layout(order: string[], draggedId: string): DropCandidate[] {
  const out: DropCandidate[] = [];
  order.forEach((id, i) => {
    if (id === draggedId) return;
    const left = (i % COLS) * TILE;
    const top = Math.floor(i / COLS) * TILE;
    out.push({ id, kind: "item", rect: { left, top, right: left + TILE, bottom: top + TILE } });
  });
  return out;
}

/**
 * 把落点换算成"插到 rest 里的第几位"。
 *
 * 断言这个而不是断言具体的 `{id, before}`：`{b, after}` 和 `{c, before}`
 * 是**同一个插入位置**的两种写法，钉死写法会让测试变得很脆
 * （改一次判定规则就要重写一堆期望值，而且看不出到底错在哪）。
 */
function insertIndex(ids: string[], draggedId: string, spot: DropSpot | null): number {
  if (spot?.kind !== "item") return -1;
  const rest = ids.filter((id) => id !== draggedId);
  const at = rest.indexOf(spot.id);
  if (at < 0) return -1;
  return spot.before ? at : at + 1;
}

describe("resolveSortSpot", () => {
  it("没有候选时返回 null", () => {
    expect(resolveSortSpot(10, 10, [], "horizontal")).toBeNull();
  });

  it("行内按中点决定插到第几位", () => {
    const ids = ["a", "b", "c", "z"];
    const items = layout(ids, "z"); // a b c 在第一行，z 被拖走了
    // 指针在 a 的左半边 → 插到 a 前面（第 0 位）
    expect(insertIndex(ids, "z", resolveSortSpot(10, 50, items, "horizontal"))).toBe(0);
    // 指针在 b 的右半边 → 插到 b 后面（第 2 位）
    expect(insertIndex(ids, "z", resolveSortSpot(TILE + 90, 50, items, "horizontal"))).toBe(2);
    // 指针在行尾右边 → 插到这一行最后（第 3 位）
    expect(insertIndex(ids, "z", resolveSortSpot(TILE * 3 + 50, 50, items, "horizontal"))).toBe(3);
  });

  it("指针在格子外面也能给出一条（不会返回 null）", () => {
    // 拖到面板外面时不该"什么都不做"，而是插到最近的邻居旁边
    const items = layout(["a", "b", "c"], "zzz");
    expect(resolveSortSpot(-500, -500, items, "horizontal")).not.toBeNull();
    expect(resolveSortSpot(9999, 9999, items, "horizontal")).not.toBeNull();
  });

  it("纵向列表看 y", () => {
    const items: DropCandidate[] = [
      { id: "a", kind: "item", rect: { left: 0, top: 0, right: 300, bottom: 60 } },
      { id: "b", kind: "item", rect: { left: 0, top: 60, right: 300, bottom: 120 } },
    ];
    expect(resolveSortSpot(150, 70, items, "vertical")).toEqual({
      kind: "item",
      id: "b",
      before: true,
    });
    expect(resolveSortSpot(150, 110, items, "vertical")).toEqual({
      kind: "item",
      id: "b",
      before: false,
    });
  });

  it("自稳：空位挪过去之后指针不动，插入位次也不再变", () => {
    // 这是这套规则能用的**前提**。不成立的话会出现
    // "重排 → 落点变 → 又重排"的闪烁，用户看到的是空位疯狂跳。
    const ids = ["a", "b", "c", "d", "e", "f"];
    const dragged = "a";
    // 指针停在 c 的右半边
    const px = 2 * TILE + 80;
    const py = 50;

    let order = ids;
    let rounds = 0;
    for (; rounds < 5; rounds += 1) {
      const spot = resolveSortSpot(px, py, layout(order, dragged), "horizontal");
      const next = previewOrder(ids, dragged, spot);
      if (next.join() === order.join()) break;
      order = next;
    }

    // 必须很快收敛（来回翻的话这里会跑满 5 轮还不稳定）
    expect(rounds).toBeLessThan(3);

    // 收敛之后再算一次，结果必须一模一样
    const spot = resolveSortSpot(px, py, layout(order, dragged), "horizontal");
    expect(previewOrder(ids, dragged, spot)).toEqual(order);
  });

  it("沿第一行横扫时插入位次单调，且只在第一行范围内变", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const dragged = "a";

    let order = ids;
    const positions: number[] = [];
    for (let x = -50; x <= COLS * TILE + 50; x += 10) {
      // 每一步都按"当前布局"重新判，模拟真实拖动
      const spot = resolveSortSpot(x, 50, layout(order, dragged), "horizontal");
      order = previewOrder(ids, dragged, spot);
      positions.push(order.indexOf(dragged));
    }

    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
    }
    expect(positions[0]).toBe(0);
    // 只在第一行里挪：一行三格，最多插到第 3 位。
    // 想排到最后必须往下拖到后面的行 —— 这正是网格该有的行为。
    expect(Math.max(...positions)).toBe(COLS - 1);
  });

  it("拖到所有行下方 → 排到最后；拖到所有行上方 → 排到最前", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const dragged = "a";
    const below = layout(ids, dragged);

    // 6 条、一行 3 个 → 两行，第二行底部在 200
    const end = resolveSortSpot(10, 400, below, "horizontal");
    expect(previewOrder(ids, dragged, end)).toEqual(["b", "c", "d", "e", "f", "a"]);

    const start = resolveSortSpot(10, -100, below, "horizontal");
    expect(previewOrder(ids, dragged, start)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("指针落在两行之间的缝里时，取中心最近的那一行", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const items = layout(ids, "a"); // b,c 在 y 0~100；d,e,f 在 y 100~200
    // 缝隙在 y=100 附近；偏上取第一行、偏下取第二行
    const upper = resolveSortSpot(10, 99, items, "horizontal");
    const lower = resolveSortSpot(10, 101, items, "horizontal");
    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    // 两个都不该是 null，而且分别落在不同的行里
    expect(upper!.id).not.toBe(lower!.id);
  });
});
