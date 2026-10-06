/**
 * 右键菜单纯逻辑的测试。
 *
 * 断言针对的都是"只在边缘/异常组合下才出错"的情况：
 * 面板只有 420×640，鼠标停在右下角时菜单必须整块翻到光标左上方；
 * 全禁用的菜单不能"选中"一个按回车没反应的东西；
 * 调用方筛掉条件项之后不能留下悬空的分隔线。
 */
import { describe, expect, it } from "vitest";

import {
  NO_SELECTION,
  confirmSelection,
  hoverSelection,
  initialSelection,
  isSelectable,
  moveSelection,
  placeContextMenu,
  tidyItems,
  type MenuItemSpec,
} from "./context-menu-logic";

/** 真实主面板尺寸。 */
const VIEW = { width: 420, height: 640 };
/**
 * 五项的菜单，**按 CSS 推算的量级**（`context-menu.css` 里 `min-width: 168px`、
 * 每行 `7px` 上下内边距 + `--fs-sm` 行高 + `4px` 容器内边距 ≈ 150px）。
 *
 * ⚠️ 这里**不写"实测值"**：真实尺寸由调用方 `getBoundingClientRect()` 量出来
 * 再传进来（见 `context-menu.tsx` 的 `ContextMenu`），算法本身**不依赖**具体数值 ——
 * 换个尺寸只是换个输入。写一个假装量过的数字会让人以为算法调过参。
 */
const MENU = { width: 168, height: 150 };

function item(id: string, extra: Partial<MenuItemSpec> = {}): MenuItemSpec {
  return { id, label: id, ...extra };
}

describe("placeContextMenu", () => {
  it("面板中间：以光标为左上角、右下展开", () => {
    const p = { x: 100, y: 200 };
    expect(placeContextMenu(p, MENU, VIEW)).toEqual({ left: 102, top: 202 });
  });

  it("光标贴住右下角：整块翻到光标的左上侧，不越界", () => {
    const p = { x: VIEW.width - 2, y: VIEW.height - 2 };
    const { left, top } = placeContextMenu(p, MENU, VIEW);
    // 向右、向下都放不下 → 左翻 + 上翻
    expect(left + MENU.width).toBeLessThanOrEqual(p.x);
    expect(top + MENU.height).toBeLessThanOrEqual(p.y);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + MENU.width).toBeLessThanOrEqual(VIEW.width);
    expect(top + MENU.height).toBeLessThanOrEqual(VIEW.height);
  });

  it("右边放不下但下面放得下：只横向翻转", () => {
    const p = { x: 400, y: 100 };
    const { left, top } = placeContextMenu(p, MENU, VIEW);
    expect(left).toBe(400 - 2 - MENU.width);
    expect(top).toBe(102);
  });

  it("下面放不下但右边放得下：只纵向翻转", () => {
    const p = { x: 50, y: 630 };
    const { left, top } = placeContextMenu(p, MENU, VIEW);
    expect(left).toBe(52);
    expect(top).toBe(630 - 2 - MENU.height);
  });

  it("窗口比菜单还窄/还矮时贴住左上，绝不出现负坐标", () => {
    const tiny = { width: 100, height: 80 };
    const { left, top } = placeContextMenu({ x: 99, y: 79 }, MENU, tiny);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBe(6);
    expect(top).toBe(6);
  });

  it("光标在原点也不出负坐标", () => {
    const { left, top } = placeContextMenu({ x: 0, y: 0 }, MENU, VIEW);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("扫一遍整块面板：任何光标位置 × 任何菜单尺寸都不越界", () => {
    const sizes = [MENU, { width: 120, height: 90 }, { width: 240, height: 300 }];
    for (const menu of sizes) {
      for (let x = 0; x <= VIEW.width; x += 20) {
        for (let y = 0; y <= VIEW.height; y += 20) {
          const { left, top } = placeContextMenu({ x, y }, menu, VIEW);
          expect(left).toBeGreaterThanOrEqual(0);
          expect(top).toBeGreaterThanOrEqual(0);
          expect(left + menu.width).toBeLessThanOrEqual(VIEW.width);
          expect(top + menu.height).toBeLessThanOrEqual(VIEW.height);
        }
      }
    }
  });
});

/**
 * 菜单**比视口的一半还宽**时不能盖住光标。
 *
 * # 这条为什么必须单独钉
 *
 * 面板只有 420px，而图片右键菜单有五项、还带小字说明，量出来可能接近
 * 240px —— 已经超过一半。原来的算法在"两边都放不下"时一律 `clamp` 到
 * `MARGIN`（贴左边），于是光标在中间偏右时**菜单整个铺在光标上**：
 * 用户看不出菜单是从哪儿弹出来的，也就不知道它属于哪一条。
 *
 * # 为什么不能写成"任何位置都不许盖住光标"
 *
 * 那是**几何上无解**的：菜单宽 240、视口 420，合法左边界是 `[6, 174]`，
 * 任何摆放的矩形都是 `[left, left+240]`；要让光标 `x ∈ [174, 246]`
 * 落在矩形外，需要 `left > x`（最大只有 174）或 `left + 240 <= x`
 * （最小只有 246）—— 都不成立。所以判据只能写成
 * **"几何上能避开的，必须避开"**，下面 `canAvoidX/canAvoidY` 就是那个判据。
 */
describe("placeContextMenu：菜单比视口一半还宽时", () => {
  /** 420 的一半是 210，240 明显超过它。 */
  const WIDE = { width: 240, height: 150 };
  const MARGIN = 6;

  /** 横向上有没有一个合法位置能让菜单不盖住光标？ */
  function canAvoidX(x: number): boolean {
    const maxLeft = Math.max(MARGIN, VIEW.width - WIDE.width - MARGIN);
    // 贴最右边仍在光标右侧，或贴最左边仍在光标左侧
    return maxLeft > x || MARGIN + WIDE.width <= x;
  }

  /** 纵向上同理。 */
  function canAvoidY(y: number): boolean {
    const maxTop = Math.max(MARGIN, VIEW.height - WIDE.height - MARGIN);
    return maxTop > y || MARGIN + WIDE.height <= y;
  }

  it("光标偏右：整块翻到光标左侧，不盖住光标", () => {
    const x = VIEW.width - 4;
    const { left } = placeContextMenu({ x, y: 200 }, WIDE, VIEW);
    expect(left + WIDE.width).toBeLessThanOrEqual(x);
  });

  it("光标偏左：整块留在光标右侧，不盖住光标", () => {
    const x = 4;
    const { left } = placeContextMenu({ x, y: 200 }, WIDE, VIEW);
    expect(left).toBeGreaterThan(x);
  });

  it("光标卡在中线附近、但避开仍然可行时，必须挑对那一侧", () => {
    // 这个位置是启发式（"光标偏哪边"）会挑错、而"先判可行性"能挑对的边界：
    // 放右边放不下（175+240+6 > 420），放左边会越界（173-2-240 < 6），
    // 但 maxLeft=174 > 173 → 贴最右边其实**不盖住光标**（174 > 173）
    const x = 173;
    expect(canAvoidX(x)).toBe(true);
    const { left } = placeContextMenu({ x, y: 200 }, WIDE, VIEW);
    expect(left).toBeGreaterThan(x);
  });

  it("扫一遍整块面板：凡是几何上能避开的，都必须避开；且一律不越界", () => {
    for (let x = 0; x <= VIEW.width; x += 2) {
      for (let y = 0; y <= VIEW.height; y += 8) {
        const r = placeContextMenu({ x, y }, WIDE, VIEW);
        const coversX = r.left <= x && x <= r.left + WIDE.width;
        const coversY = r.top <= y && y <= r.top + WIDE.height;
        if (canAvoidX(x) || canAvoidY(y)) {
          // 有一个轴能避开 → 整个点就不该被矩形包含
          expect({ x, y, covers: coversX && coversY, r }).toMatchObject({
            covers: false,
          });
        }
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.top).toBeGreaterThanOrEqual(0);
        expect(r.left + WIDE.width).toBeLessThanOrEqual(VIEW.width);
        expect(r.top + WIDE.height).toBeLessThanOrEqual(VIEW.height);
      }
    }
  });

  it("视口比菜单还窄时无法避开，但绝不越界也不出负坐标", () => {
    const narrow = { width: 120, height: 90 };
    // 120 < 240：任何摆放都会盖住光标，这时只要求"看得见"
    const r = placeContextMenu({ x: 60, y: 45 }, WIDE, narrow);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.left).toBe(MARGIN);
    expect(r.top).toBe(MARGIN);
  });
});

describe("moveSelection", () => {
  const items = [item("a"), item("b"), item("c")];

  it("还没选中时按下 → 第一项；按上 → 最后一项", () => {
    expect(moveSelection(items, NO_SELECTION, 1)).toBe(0);
    expect(moveSelection(items, NO_SELECTION, -1)).toBe(2);
  });

  it("两端循环", () => {
    expect(moveSelection(items, 2, 1)).toBe(0);
    expect(moveSelection(items, 0, -1)).toBe(2);
  });

  it("跳过禁用的项", () => {
    const withDisabled = [item("a"), item("b", { disabled: true }), item("c")];
    expect(moveSelection(withDisabled, 0, 1)).toBe(2);
    expect(moveSelection(withDisabled, 2, -1)).toBe(0);
  });

  it("全部禁用时不选中任何一项", () => {
    const allOff = [item("a", { disabled: true }), item("b", { disabled: true })];
    expect(moveSelection(allOff, NO_SELECTION, 1)).toBe(NO_SELECTION);
    expect(moveSelection(allOff, 0, 1)).toBe(NO_SELECTION);
  });

  it("空菜单不崩、返回未选中", () => {
    expect(moveSelection([], NO_SELECTION, 1)).toBe(NO_SELECTION);
    expect(moveSelection([], 0, -1)).toBe(NO_SELECTION);
  });

  it("只有一项可用时来回都停在它身上", () => {
    const one = [item("a", { disabled: true }), item("b")];
    expect(moveSelection(one, NO_SELECTION, 1)).toBe(1);
    expect(moveSelection(one, 1, 1)).toBe(1);
    expect(moveSelection(one, 1, -1)).toBe(1);
  });
});

describe("initialSelection / hoverSelection", () => {
  const items = [item("a"), item("b", { disabled: true })];

  it("打开时默认不选中（右键后顺手回车不该执行第一个动作）", () => {
    expect(initialSelection()).toBe(NO_SELECTION);
  });

  it("鼠标移到禁用项上不选中", () => {
    expect(hoverSelection(items, 0)).toBe(0);
    expect(hoverSelection(items, 1)).toBe(NO_SELECTION);
  });

  it("鼠标下标越界时不选中", () => {
    expect(hoverSelection(items, -1)).toBe(NO_SELECTION);
    expect(hoverSelection(items, 9)).toBe(NO_SELECTION);
  });
});

describe("confirmSelection", () => {
  const items = [item("a"), item("b", { disabled: true })];

  it("未选中 / 越界 / 禁用项都返回 null", () => {
    expect(confirmSelection(items, NO_SELECTION)).toBeNull();
    expect(confirmSelection(items, 5)).toBeNull();
    expect(confirmSelection(items, 1)).toBeNull();
  });

  it("选中的可用项原样返回", () => {
    expect(confirmSelection(items, 0)?.id).toBe("a");
  });
});

describe("isSelectable", () => {
  it("只有显式 disabled 才算不可用", () => {
    expect(isSelectable(item("a"))).toBe(true);
    expect(isSelectable(item("a", { disabled: false }))).toBe(true);
    expect(isSelectable(item("a", { disabled: true }))).toBe(false);
  });
});

describe("tidyItems", () => {
  // `dividerBefore` 是可选的，这里统一用 `=== true` 读：
  // `undefined` 和 `false` 都是"不画线"，断言写 `false` 会因为
  // `undefined !== false` 而失败 —— 那是断言写法的问题，不是逻辑的问题
  const dividers = (list: MenuItemSpec[]) => list.map((i) => i.dividerBefore === true);

  it("第一项的分隔线去掉（否则菜单顶上多一条悬空横线）", () => {
    const out = tidyItems([item("a", { dividerBefore: true }), item("b")]);
    expect(dividers(out)).toEqual([false, false]);
  });

  it("连续的分隔线合并成一条", () => {
    const out = tidyItems([
      item("a"),
      item("b", { dividerBefore: true }),
      item("c", { dividerBefore: true }),
    ]);
    expect(dividers(out)).toEqual([false, true, false]);
  });

  it("开头连续两条分隔线只剩一条（顶上不能出现悬空线）", () => {
    const out = tidyItems([
      item("a", { dividerBefore: true }),
      item("b", { dividerBefore: true }),
      item("c", { dividerBefore: true }),
    ]);
    // a 是头一项 → 不画；b 想要线 → 画；c 再要 → 上一条已经有线了，合并掉
    expect(dividers(out)).toEqual([false, true, false]);
  });

  it("不改动原数组里的对象（避免把调用方的常量改坏）", () => {
    const src = [item("a", { dividerBefore: true })];
    tidyItems(src);
    expect(src[0].dividerBefore).toBe(true);
  });

  it("空数组返回空数组", () => {
    expect(tidyItems([])).toEqual([]);
  });
});
