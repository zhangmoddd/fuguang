/**
 * 图片附件纯逻辑的测试。
 *
 * 这里钉的三件事都是"错了不报错、只表现成偶尔有点怪"的：
 * 1. **缩略图尺寸**：算大了数据目录悄悄涨，算错了 canvas 产出空串；
 * 2. **孤儿判定**：判错要么删掉别人还在用的图（界面裂图），要么一张都不删；
 * 3. **导入结果汇总**：重复导入 / 部分失败时说不清发生了什么。
 *
 * 另外单独钉了一条**边界**：图片不能跑进全文搜索（见文件末尾）。
 */
import { describe, expect, it } from "vitest";

import { searchAll, type SearchData } from "./search";
import {
  CONCURRENT_IMPORT_WARNING,
  IMAGE_EXTENSIONS,
  LARGE_LIBRARY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_THUMB_EDGE,
  dataUrlPayload,
  extensionOf,
  formatBytes,
  hasAnyContent,
  imagePathsOnly,
  importNotice,
  isImportBatchEmpty,
  largeLibraryNotice,
  mediaGcHold,
  mediaGcHoldNotice,
  orphanedByItemRemoval,
  orphanedImageIds,
  referencedImageIds,
  referencedImageIdsExcluding,
  skippedNotice,
  statsNotice,
  summarizeImport,
  thumbnailSize,
  type ImportOutcome,
  type MediaGcEvidence,
  type MediaGcHold,
  type WithImages,
} from "./media";

/** 造一个带图片的条目。 */
function item(id: string, ...imageIds: string[]): WithImages {
  return { id, images: imageIds.map((imageId) => ({ id: imageId })) };
}

describe("thumbnailSize", () => {
  it("横图：长边缩到上限，短边按比例", () => {
    // 4K 截图，正是最常被拖进来的那种
    expect(thumbnailSize(3840, 2160)).toEqual({ width: 320, height: 180, scale: 320 / 3840 });
  });

  it("竖图：同样缩长边", () => {
    const size = thumbnailSize(2160, 3840);
    expect(size.width).toBe(180);
    expect(size.height).toBe(320);
  });

  it("正方形正好在上限时不动", () => {
    expect(thumbnailSize(320, 320)).toEqual({ width: 320, height: 320, scale: 1 });
  });

  it("小图不放大（放大只会更占地方、更糊）", () => {
    expect(thumbnailSize(100, 50)).toEqual({ width: 100, height: 50, scale: 1 });
    expect(thumbnailSize(1, 1)).toEqual({ width: 1, height: 1, scale: 1 });
  });

  it("极端长条图的短边至少是 1px", () => {
    // 1×10000：按比例算出来的宽是 0.032，round 之后是 0 ——
    // 0 会让 canvas.toDataURL() 产出空串，Rust 报「缩略图是空的」，
    // 而真实原因完全看不出来
    const tall = thumbnailSize(1, 10000);
    expect(tall.width).toBe(1);
    expect(tall.height).toBe(320);

    const wide = thumbnailSize(10000, 1);
    expect(wide.width).toBe(320);
    expect(wide.height).toBe(1);

    // 641 的边界：缩放后短边是 0.499 → round 成 0
    expect(thumbnailSize(641, 1).height).toBe(1);
  });

  it("尺寸量不出来时给 1×1，而不是 0", () => {
    // canvas 宽高为 0 时 toDataURL() 返回 "data:,"，Rust 侧报「缩略图是空的」
    for (const [w, h] of [
      [0, 0],
      [0, 100],
      [100, 0],
      [-5, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
    ]) {
      expect(thumbnailSize(w, h)).toEqual({ width: 1, height: 1, scale: 1 });
    }
  });

  it("小数尺寸向下取整（canvas 不接受小数）", () => {
    expect(thumbnailSize(100.9, 50.9)).toEqual({ width: 100, height: 50, scale: 1 });
  });

  it("maxEdge 传成 0 或负数时退回默认值，不会除出 Infinity", () => {
    const size = thumbnailSize(1000, 500, 0);
    expect(Number.isFinite(size.width)).toBe(true);
    expect(size.width).toBe(MAX_THUMB_EDGE);
  });

  it("扫一遍各种长宽比：长边一定不超过上限、且不为 0", () => {
    for (const w of [1, 2, 7, 100, 320, 321, 800, 3840, 12000]) {
      for (const h of [1, 2, 7, 100, 320, 321, 800, 2160, 12000]) {
        const size = thumbnailSize(w, h);
        expect(size.width).toBeGreaterThanOrEqual(1);
        expect(size.height).toBeGreaterThanOrEqual(1);
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_THUMB_EDGE);
        expect(Number.isInteger(size.width)).toBe(true);
        expect(Number.isInteger(size.height)).toBe(true);
      }
    }
  });

  it("上限就是 320（改这个值要连着改 media.rs 的说明）", () => {
    expect(MAX_THUMB_EDGE).toBe(320);
  });
});

describe("referencedImageIds / referencedImageIdsExcluding", () => {
  it("收齐全部条目引用的 id，缺 images 的条目按空处理", () => {
    const items: WithImages[] = [
      item("a", "x", "y"),
      { id: "b" },
      { id: "c", images: null },
      item("d", "y"),
    ];
    expect([...referencedImageIds(items)].sort()).toEqual(["x", "y"]);
  });

  it("跳过残缺的图片项（没有 id 的）", () => {
    const items: WithImages[] = [
      { id: "a", images: [{ id: "" }, { id: "x" }, {} as { id: string }] },
    ];
    expect([...referencedImageIds(items)]).toEqual(["x"]);
  });

  it("排除某个条目之后的引用集合", () => {
    const items = [item("a", "x", "y"), item("b", "y", "z")];
    const others = referencedImageIdsExcluding(items, "a");
    expect([...others].sort()).toEqual(["y", "z"]);
    // 排除不存在的条目 = 全量
    expect([...referencedImageIdsExcluding(items, "不存在")].sort()).toEqual(["x", "y", "z"]);
  });
});

describe("orphanedImageIds", () => {
  it("只有这一个条目在引用 → 是孤儿，可以删盘", () => {
    const items = [item("a", "x"), item("b", "y")];
    expect(orphanedImageIds(items, "a", ["x"])).toEqual(["x"]);
  });

  it("别的条目也在引用 → **不能**删盘", () => {
    // 导入按内容去重，同一张图被两条引用是正常的。
    // 判错的表现是"另一条里的图突然变成裂图"，而用户不会把它和刚才的删除联系起来
    const items = [item("a", "x"), item("b", "x")];
    expect(orphanedImageIds(items, "a", ["x"])).toEqual([]);
  });

  it("同一个条目里出现两次同一张图也只算一次", () => {
    const items: WithImages[] = [
      { id: "a", images: [{ id: "x" }, { id: "x" }] },
      item("b", "y"),
    ];
    expect(orphanedImageIds(items, "a", ["x"])).toEqual(["x"]);
  });

  it("removedIds 里有重复也只返回一条", () => {
    const items = [item("a", "x")];
    expect(orphanedImageIds(items, "a", ["x", "x", "x"])).toEqual(["x"]);
  });

  it("多张一起删：只返回没人引用的那些", () => {
    const items = [item("a", "x", "y", "z"), item("b", "y")];
    expect(orphanedImageIds(items, "a", ["x", "y", "z"]).sort()).toEqual(["x", "z"]);
  });

  it("没删任何东西 → 空数组（不要顺手把条目里的图全删了）", () => {
    const items = [item("a", "x", "y")];
    expect(orphanedImageIds(items, "a", [])).toEqual([]);
  });

  it("空 id 不算一次移除", () => {
    expect(orphanedImageIds([item("a", "x")], "a", ["", ""])).toEqual([]);
  });

  it("来源条目已经不在列表里（状态先删了）也能算对", () => {
    // 删除路径上很容易先 setState 再算孤儿，这时 items 里已经没有它了
    const afterRemoval = [item("b", "y")];
    expect(orphanedImageIds(afterRemoval, "a", ["x", "y"])).toEqual(["x"]);
  });

  it("空列表：全部算孤儿（它确实没人引用了）", () => {
    expect(orphanedImageIds([], "a", ["x"])).toEqual(["x"]);
  });
});

describe("orphanedByItemRemoval", () => {
  it("删整条：只清理没人再引用的图", () => {
    const items = [item("a", "x", "y"), item("b", "y", "z")];
    expect(orphanedByItemRemoval(items, "a").sort()).toEqual(["x"]);
  });

  it("条目不在列表里 → 什么都不删（宁可不删，也不要误删别人的）", () => {
    expect(orphanedByItemRemoval([item("b", "y")], "不存在")).toEqual([]);
  });

  it("条目没有图片 → 空数组", () => {
    expect(orphanedByItemRemoval([item("a")], "a")).toEqual([]);
  });
});

describe("summarizeImport", () => {
  const ok = (id: string) => ({ ok: true, media: { id } }) as ImportOutcome<{ id: string }>;
  const fail = (error: string) => ({ ok: false, error }) as ImportOutcome<{ id: string }>;
  const ctx = { inItem: [] as string[], elsewhere: new Set<string>() };

  it("全部成功：逐条进 added", () => {
    const summary = summarizeImport([ok("a"), ok("b")], ctx);
    expect(summary.added.map((m) => m.id)).toEqual(["a", "b"]);
    expect(summary.failed).toEqual([]);
    expect(summary.alreadyInItem).toBe(0);
  });

  it("重复导入：进 alreadyInItem，不重复加", () => {
    const summary = summarizeImport([ok("a"), ok("a")], { ...ctx, inItem: ["a"] });
    expect(summary.added).toEqual([]);
    expect(summary.alreadyInItem).toBe(2);
  });

  it("同一次导入里自己撞车（选了两个副本）也只加一次", () => {
    const summary = summarizeImport([ok("a"), ok("a")], ctx);
    expect(summary.added.map((m) => m.id)).toEqual(["a"]);
    expect(summary.alreadyInItem).toBe(1);
  });

  it("别处也在用的张数单独计数", () => {
    const summary = summarizeImport([ok("a"), ok("b")], {
      inItem: [],
      elsewhere: new Set(["a"]),
    });
    expect(summary.added).toHaveLength(2);
    expect(summary.sharedElsewhere).toBe(1);
  });

  it("失败路径：原因逐条收下，一条都不吞", () => {
    const summary = summarizeImport(
      [ok("a"), fail("图片太大（31.2 MB），上限是 20 MB"), fail("这个文件的内容不是图片（认不出文件头）")],
      ctx,
    );
    expect(summary.added.map((m) => m.id)).toEqual(["a"]);
    expect(summary.failed).toHaveLength(2);
    expect(summary.failed[0]).toContain("20 MB");
  });

  it("失败路径：返回了没有 id 的结果也算失败，不静默丢掉", () => {
    const summary = summarizeImport(
      [{ ok: true, media: { id: "" } } as ImportOutcome<{ id: string }>],
      ctx,
    );
    expect(summary.added).toEqual([]);
    expect(summary.failed).toHaveLength(1);
  });

  it("一个结果都没有时汇总全空（不能编出「什么都没发生」以外的谎）", () => {
    const summary = summarizeImport([], ctx);
    expect(summary.added).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(importNotice(summary)).toBeNull();
  });
});

describe("importNotice", () => {
  const ok = (id: string) => ({ ok: true, media: { id } }) as ImportOutcome<{ id: string }>;
  const ctx = { inItem: [] as string[], elsewhere: new Set<string>() };

  it("成功：报张数", () => {
    const notice = importNotice(summarizeImport([ok("a"), ok("b")], ctx));
    expect(notice).toEqual({ text: "已加 2 张", kind: "ok" });
  });

  it("重复导入说人话，而不是让人以为「什么都没发生」", () => {
    const notice = importNotice(
      summarizeImport([ok("a")], { inItem: ["a"], elsewhere: new Set() }),
    );
    expect(notice?.text).toBe("这张图已经在里面了");
    expect(notice?.kind).toBe("ok");
  });

  it("多张重复时说清张数", () => {
    const notice = importNotice(
      summarizeImport([ok("a"), ok("b")], { inItem: ["a", "b"], elsewhere: new Set() }),
    );
    expect(notice?.text).toBe("2 张已经在里面了");
  });

  it("别处也在用要说出来（它解释了为什么删了不腾空间）", () => {
    const notice = importNotice(
      summarizeImport([ok("a")], { inItem: [], elsewhere: new Set(["a"]) }),
    );
    expect(notice?.text).toContain("别处也在用");
  });

  it("失败时用 warn（要读久一点），单条失败直接给原因", () => {
    const notice = importNotice(
      summarizeImport([{ ok: false, error: "不支持的图片格式：psd" }], ctx),
    );
    expect(notice).toEqual({ text: "不支持的图片格式：psd", kind: "warn" });
  });

  it("多条失败只报第一条 + 总数（420px 面板放不下三条原因）", () => {
    const notice = importNotice(
      summarizeImport(
        [
          { ok: false, error: "第一" },
          { ok: false, error: "第二" },
          { ok: false, error: "第三" },
        ],
        ctx,
      ),
    );
    expect(notice?.text).toBe("3 张失败：第一");
  });

  it("部分成功：成功和失败都要说，并且按 warn 显示", () => {
    const notice = importNotice(
      summarizeImport([ok("a"), { ok: false, error: "太大" }], ctx),
    );
    expect(notice?.text).toContain("已加 1 张");
    expect(notice?.text).toContain("太大");
    expect(notice?.kind).toBe("warn");
  });

  it("文案要短：最长的组合也不超过 60 个字（面板 420px）", () => {
    const notice = importNotice(
      summarizeImport(
        [ok("a"), ok("b"), ok("c"), ok("d"), { ok: false, error: "图片太大（31.2 MB），上限是 20 MB" }],
        { inItem: ["c", "d"], elsewhere: new Set(["a", "b"]) },
      ),
    );
    expect(notice).not.toBeNull();
    expect(notice!.text.length).toBeLessThanOrEqual(60);
  });
});

describe("mediaGcHold / mediaGcHoldNotice（删盘的安全阀）", () => {
  /**
   * RV4 的 F4：**不可逆**的那一条。
   *
   * 场景：本窗口内存里只有 `a` 引用着 `x`（**陈旧视图** —— 另一个窗口刚把 `x`
   * 引用进它自己的条目，而那个引用还没落盘，本窗口看不见）。
   * 这时用户从 `a` 里移除 `x`：
   * - `orphanedImageIds` 会说"没人引用了"（它只看本窗口内存）；
   * - 但**文件不能被删** —— 另一个窗口的引用还在路上。
   */
  const staleItems = [item("a", "x"), item("b", "y")];
  const twoWindows: MediaGcEvidence = { panelCount: 2, sawExternalChange: false };
  const soleWindow: MediaGcEvidence = { panelCount: 1, sawExternalChange: false };
  const unknownPanels: MediaGcEvidence = { panelCount: null, sawExternalChange: false };
  const sawExternal: MediaGcEvidence = { panelCount: 1, sawExternalChange: true };

  function hold(
    items: WithImages[],
    evidence: MediaGcEvidence,
    undoIds: string[] = [],
    imageId = "x",
  ): MediaGcHold {
    return mediaGcHold({ items, fromItemId: "a", imageId, undoIds, evidence });
  }

  it("本窗口内存陈旧 + 另一个窗口仍引用 → **文件不会被删**", () => {
    // 先确认"看起来"确实没人引用（否则这条测试就是假通过）
    expect(orphanedImageIds(staleItems, "a", ["x"])).toEqual(["x"]);
    // 但多窗口开着 → 决策是"不删"
    expect(hold(staleItems, twoWindows)).toBe("untrusted-memory");
    // 并且会给用户一句解释，而不是静默留下文件
    expect(mediaGcHoldNotice("untrusted-memory", twoWindows)).toContain("文件先留着");
  });

  it("只有这一个面板窗口、也没见过外部改动 → 可以删", () => {
    expect(hold(staleItems, soleWindow)).toBe("none");
    expect(mediaGcHoldNotice("none", soleWindow)).toBeNull();
  });

  it("问不到面板数（list_panels 失败）→ 不删，而不是「假设只有一个」", () => {
    expect(hold(staleItems, unknownPanels)).toBe("untrusted-memory");
    expect(mediaGcHoldNotice("untrusted-memory", unknownPanels)).toContain("不确定");
  });

  it("见过别的窗口改数据 → 不删（本窗口这份引用可能已经落后于盘）", () => {
    expect(hold(staleItems, sawExternal)).toBe("untrusted-memory");
    expect(mediaGcHoldNotice("untrusted-memory", sawExternal)).toContain("别的窗口");
  });

  it("别的条目还在引用 → 不删，且理由说的是「别处也在用」", () => {
    const shared = [item("a", "x"), item("b", "x")];
    expect(hold(shared, soleWindow)).toBe("still-referenced");
    expect(mediaGcHoldNotice("still-referenced", soleWindow)).toContain("别处也在用");
  });

  it("撤销会把它带回来 → 不删（即使只有一个窗口）", () => {
    expect(hold(staleItems, soleWindow, ["x"])).toBe("undoable");
    expect(mediaGcHoldNotice("undoable", soleWindow)).toContain("撤销");
  });

  it("判据的优先级：还在被引用 > 撤销能带回 > 内存不可信", () => {
    // 三个判据同时成立时，给用户看的应该是最具体的那条
    const shared = [item("a", "x"), item("b", "x")];
    expect(hold(shared, twoWindows, ["x"])).toBe("still-referenced");
  });

  it("扫一遍证据组合：只有「单窗口 + 没外部改动」才允许删", () => {
    const counts: (number | null)[] = [null, 0, 1, 2, 3];
    for (const panelCount of counts) {
      for (const sawExternalChange of [false, true]) {
        const evidence: MediaGcEvidence = { panelCount, sawExternalChange };
        const verdict = hold(staleItems, evidence) === "none";
        expect(verdict).toBe(panelCount === 1 && !sawExternalChange);
      }
    }
  });
});

describe("isImportBatchEmpty / CONCURRENT_IMPORT_WARNING（RV4 的 F7）", () => {
  it("并发导入被挡下时**不算**空批次 —— 调用点不会说「剪贴板里没有图片」", () => {
    // 这正是 RV4 F7 的修法：busy 短路返回的是"带一条警告的空结果"，
    // 而不是"什么都没有"。少了这条警告，调用点就会说那句假话。
    const busyBatch = { outcomes: [], warnings: [CONCURRENT_IMPORT_WARNING] };
    expect(isImportBatchEmpty(busyBatch)).toBe(false);
    expect(CONCURRENT_IMPORT_WARNING).toContain("还没完成");
  });

  it("剪贴板里真的没有图片（空批次、无警告）→ 才算空", () => {
    expect(isImportBatchEmpty({ outcomes: [], warnings: [] })).toBe(true);
  });

  it("有结果就不算空", () => {
    expect(isImportBatchEmpty({ outcomes: [{ ok: true }], warnings: [] })).toBe(false);
    expect(isImportBatchEmpty({ outcomes: [], warnings: ["别的警告"] })).toBe(false);
  });
});

describe("skippedNotice（RV4 的 F3）", () => {
  it("拖进来一个文件夹 → 说的是文件夹，不是「不是图片文件」", () => {
    const text = skippedNotice(["C:\\Users\\me\\图片"], ["folder"]);
    expect(text).toContain("文件夹");
    expect(text).not.toContain("不是图片文件");
  });

  it("拖进来多个文件夹", () => {
    expect(skippedNotice(["C:\\a", "C:\\b"], ["folder", "folder"])).toBe(
      "拖进来的是 2 个文件夹，请把里面的图片文件拖进来",
    );
  });

  it("文件夹与别的混在一起时两个都说", () => {
    const text = skippedNotice(["C:\\a", "C:\\x.txt"], ["folder", "file"]);
    expect(text).toBe("2 个不是图片文件（其中 1 个是文件夹）");
  });

  it("确实不是图片文件 → 保持原来的说法", () => {
    expect(skippedNotice(["C:\\x.txt"], ["file"])).toBe("拖进来的不是图片文件");
    expect(skippedNotice(["C:\\x.txt", "C:\\y.exe"], ["file", "file"])).toBe(
      "2 个不是图片文件",
    );
  });

  it("classify_paths 失败（kinds 为 null）→ 退回笼统说法，不猜", () => {
    expect(skippedNotice(["C:\\a"], null)).toBe("拖进来的不是图片文件");
    expect(skippedNotice(["C:\\a", "C:\\b"], null)).toBe("2 个不是图片文件");
  });

  it("没有跳过任何东西 → 空串（调用点据此什么都不说）", () => {
    expect(skippedNotice([], [])).toBe("");
    expect(skippedNotice([], null)).toBe("");
  });

  it("kinds 比 paths 短时不会崩（按已有的算，多余的当非文件夹）", () => {
    // 防御：两个数组来自不同的调用，理论上等长，但真错位了也不能抛
    expect(skippedNotice(["C:\\a", "C:\\b"], ["folder"])).toBe(
      "2 个不是图片文件（其中 1 个是文件夹）",
    );
  });
});

describe("formatBytes", () => {
  it("常见的几个量级", () => {
    expect(formatBytes(4508876)).toBe("4.3 MB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });

  it("小于 1KB 按字节显示，整数不带小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("10 以上不带小数，10 以下带一位", () => {
    expect(formatBytes(1024 * 1024 * 9.94)).toBe("9.9 MB");
    expect(formatBytes(1024 * 1024 * 10.4)).toBe("10 MB");
  });

  it("非法输入不产出 NaN 文案", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, -0]) {
      const text = formatBytes(bad);
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("Infinity");
      expect(text).toBe("0 B");
    }
  });
});

describe("statsNotice / largeLibraryNotice", () => {
  it("没有图片时说人话，而不是「0 张 · 0 B」", () => {
    expect(statsNotice({ count: 0, bytes: 0 })).toBe("还没有图片");
    expect(statsNotice({ count: -1, bytes: 0 })).toBe("还没有图片");
  });

  it("有图片时给张数与占用", () => {
    expect(statsNotice({ count: 12, bytes: 4508876 })).toBe("图片 12 张 · 4.3 MB");
  });

  it("占用没到阈值时不打扰", () => {
    expect(largeLibraryNotice(0)).toBeNull();
    expect(largeLibraryNotice(LARGE_LIBRARY_BYTES - 1)).toBeNull();
  });

  it("越过阈值时给一句能读懂的话", () => {
    const text = largeLibraryNotice(LARGE_LIBRARY_BYTES);
    expect(text).toContain("512 MB");
    expect(text).toContain("备份");
  });

  it("上限常量与 Rust 侧的 20 MB 对齐（写在注释里，这里钉住值）", () => {
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("hasAnyContent", () => {
  const one = [{ id: "x" }];

  it("只有图片没有文字 → 算有内容（否则贴了图会悄悄存不下来）", () => {
    expect(hasAnyContent("", one)).toBe(true);
    expect(hasAnyContent("   \n\t ", one)).toBe(true);
  });

  it("有文字没图片 → 算有内容（原来的规则不变）", () => {
    expect(hasAnyContent("一段文字", [])).toBe(true);
    expect(hasAnyContent("一段文字", undefined)).toBe(true);
  });

  it("**真的空**（没文字也没图片）→ 不算内容，仍然不写", () => {
    expect(hasAnyContent("", [])).toBe(false);
    expect(hasAnyContent("", undefined)).toBe(false);
    expect(hasAnyContent("", null)).toBe(false);
    // 纯空白按空处理（与原来的 .trim() 判据一致）
    expect(hasAnyContent("  \n\t ", [])).toBe(false);
  });
});

describe("extensionOf / imagePathsOnly", () => {
  it("取最后一段扩展名，大小写不敏感", () => {
    expect(extensionOf("C:\\a\\截图.PNG")).toBe("png");
    expect(extensionOf("/home/x/a.jpeg")).toBe("jpeg");
    expect(extensionOf("没有扩展名")).toBe("");
    // 最后一段没有点 → 没有扩展名（`a.b` 是目录名，不该被当成扩展名来源）
    expect(extensionOf("C:\\a.b\\c")).toBe("");
    // 以点开头的隐藏文件不该被当成扩展名
    expect(extensionOf("C:\\a\\.gitignore")).toBe("");
  });

  it("按扩展名分流，非图片进 skipped（Rust 侧才是真正的把关）", () => {
    const { images, skipped } = imagePathsOnly([
      "C:\\a\\x.png",
      "C:\\a\\y.txt",
      "C:\\a\\z.JPG",
      "C:\\a\\w.webp",
      "C:\\a\\v.exe",
      "C:\\a\\没有扩展名",
    ]);
    expect(images).toEqual(["C:\\a\\x.png", "C:\\a\\z.JPG", "C:\\a\\w.webp"]);
    expect(skipped).toEqual(["C:\\a\\y.txt", "C:\\a\\v.exe", "C:\\a\\没有扩展名"]);
  });

  it("空输入不报错", () => {
    expect(imagePathsOnly([])).toEqual({ images: [], skipped: [] });
  });

  it("扩展名列表与 Rust 的 kind_from_ext 对齐（svg 不在内）", () => {
    expect([...IMAGE_EXTENSIONS].sort()).toEqual(
      ["bmp", "gif", "jpeg", "jpg", "png", "webp"].sort(),
    );
  });
});

describe("dataUrlPayload", () => {
  it("剥掉 data URL 前缀（Rust 的解码器遇到 : 和 ; 会直接报错）", () => {
    expect(dataUrlPayload("data:image/png;base64,AAAA")).toBe("AAAA");
    expect(dataUrlPayload("data:image/jpeg;base64,Zm9v")).toBe("Zm9v");
  });

  it("不是 base64 data URL 时返回 null（调用方跳过回填，不报错）", () => {
    expect(dataUrlPayload("")).toBeNull();
    expect(dataUrlPayload("data:image/png,")).toBeNull();
    expect(dataUrlPayload("data:image/png;base64,")).toBeNull();
    expect(dataUrlPayload("AAAA")).toBeNull();
  });
});

// ===============================================================
// 边界：图片不能污染文本语义
// ===============================================================

describe("全文搜索不受图片影响", () => {
  /**
   * 这条是**回归防线**，不是装饰。
   *
   * 如果哪天有人把 `images` 加进 `SearchableSnippet` 的字段表（"顺手一起搜"），
   * 后果是：搜一个普通词会命中一堆**看起来毫无关系**的条目 ——
   * 因为命中的是文件名或者 base64 里的随机子串，而界面上完全不显示这些内容。
   * 那种"搜出来但看不出为什么"是最难解释的一类 bug。
   */
  const data: SearchData = {
    snippets: [
      {
        id: "s1",
        title: "发票抬头",
        content: "公司名称：浮光科技",
        note: "",
        tags: [],
        sensitive: false,
        // 文件名与 id 里都塞一个只可能来自图片的字符串
        images: [
          { id: "zzzsecretzzz", name: "zzzsecretzzz.png" },
        ],
      },
    ],
    links: [],
    memos: [
      {
        id: "m1",
        date: "2026-03-08",
        title: "备忘标题",
        body: "备忘正文",
        tags: [],
        images: [{ id: "zzzsecretzzz", name: "zzzsecretzzz.png" }],
      },
    ],
    timers: [],
  } as unknown as SearchData;

  it("搜图片的文件名 / id 一个字都不命中", () => {
    expect(searchAll("zzzsecretzzz", data)).toEqual([]);
  });

  it("搜文本照常命中（图片字段的存在不改变原有行为）", () => {
    expect(searchAll("发票", data).map((h) => h.id)).toEqual(["s1"]);
    expect(searchAll("备忘正文", data).map((h) => h.id)).toEqual(["m1"]);
  });

  it("结果里的 detail 只由文本拼成，不含文件名或 base64", () => {
    for (const hit of searchAll("浮光", data)) {
      expect(hit.detail).not.toContain("zzzsecretzzz");
      expect(hit.detail).not.toContain("base64");
    }
  });
});
