/**
 * 高亮态纯逻辑的测试。
 *
 * 重点在两类容易写错的地方：
 * 1. **"切到顶层" 和 "这次请求没带文件夹" 必须分得开** ——
 *    两者在类型上都是 falsy，一句 `if (folderId)` 会把"切到顶层"整个吃掉，
 *    而搜索命中的多半就是顶层的东西（用户会看到"回车之后停在原来的子文件夹里"）。
 * 2. 同一个条目被搜两次时高亮要**重启**（`seq` 变），不能因为 `id` 没变就没反应。
 */
import { describe, expect, it } from "vitest";

import {
  HIGHLIGHT_TTL_MS,
  dateToSelect,
  focusDomId,
  folderToEnter,
  hasFolderHint,
  highlightFrom,
  isHighlighted,
  shouldClearOnInteraction,
  type FocusLike,
} from "./focus-highlight";

function target(extra: Partial<FocusLike> = {}): FocusLike {
  return { id: "abc", seq: 1, ...extra };
}

describe("highlightFrom / isHighlighted", () => {
  it("null 请求 → 没有高亮", () => {
    expect(highlightFrom(null)).toBeNull();
  });

  it("请求 → 高亮，带 id 与 seq", () => {
    expect(highlightFrom(target({ id: "x", seq: 7 }))).toEqual({ id: "x", seq: 7 });
  });

  it("只亮对应的那一条", () => {
    const h = highlightFrom(target({ id: "x" }));
    expect(isHighlighted(h, "x")).toBe(true);
    expect(isHighlighted(h, "y")).toBe(false);
    expect(isHighlighted(null, "x")).toBe(false);
  });

  it("同一条被搜两次：seq 不同，高亮对象不同（能重启计时）", () => {
    const first = highlightFrom(target({ id: "x", seq: 1 }));
    const second = highlightFrom(target({ id: "x", seq: 2 }));
    expect(first).not.toEqual(second);
    expect(second?.seq).toBe(2);
  });
});

describe("shouldClearOnInteraction", () => {
  it("有高亮时才需要清", () => {
    expect(shouldClearOnInteraction({ id: "x", seq: 1 })).toBe(true);
    expect(shouldClearOnInteraction(null)).toBe(false);
  });
});

describe("hasFolderHint / folderToEnter", () => {
  it("请求没带 folderId 字段 → 保持原状", () => {
    const t = target();
    expect(hasFolderHint(t)).toBe(false);
    expect(folderToEnter(t)).toEqual({ known: false });
  });

  it("folderId 显式为 null → 切到顶层（这是有意义的定位，不是'没带'）", () => {
    const t = target({ folderId: null });
    expect(hasFolderHint(t)).toBe(true);
    expect(folderToEnter(t)).toEqual({ known: true, folderId: null });
  });

  it("folderId 是具体 id → 切到那个文件夹", () => {
    expect(folderToEnter(target({ folderId: "f1" }))).toEqual({
      known: true,
      folderId: "f1",
    });
  });

  it("folderId 是空串 → 当'没写'，切到顶层而不是切进一个空文件夹", () => {
    expect(folderToEnter(target({ folderId: "" }))).toEqual({
      known: true,
      folderId: null,
    });
  });
});

describe("dateToSelect", () => {
  it("合法日期原样返回", () => {
    expect(dateToSelect(target({ date: "2026-03-08" }))).toBe("2026-03-08");
  });

  it("没有日期 / 空串 / 格式不对 → null（不要切到一个空的日期页）", () => {
    expect(dateToSelect(target())).toBeNull();
    expect(dateToSelect(target({ date: "" }))).toBeNull();
    expect(dateToSelect(target({ date: "2026/03/08" }))).toBeNull();
    expect(dateToSelect(target({ date: "2026-3-8" }))).toBeNull();
    expect(dateToSelect(target({ date: "今天" }))).toBeNull();
  });
});

describe("focusDomId", () => {
  it("前缀 + id", () => {
    expect(focusDomId("snip", "m1abc")).toBe("snip-m1abc");
  });

  it("不同前缀不撞车（同一个 id 可能同时出现在两个页面上）", () => {
    expect(focusDomId("snip", "x")).not.toBe(focusDomId("memo", "x"));
  });
});

describe("HIGHLIGHT_TTL_MS", () => {
  it("是'看得清'的量级：不短于 1.5 秒、不长于 6 秒", () => {
    // 太短 → 用户视线还没从搜索框挪到列表就灭了；太长 → 变成常驻状态
    expect(HIGHLIGHT_TTL_MS).toBeGreaterThanOrEqual(1500);
    expect(HIGHLIGHT_TTL_MS).toBeLessThanOrEqual(6000);
  });
});
