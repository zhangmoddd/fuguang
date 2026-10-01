/**
 * `folders.ts` 的测试。
 *
 * 重点在**孤儿与环**这两类坏数据：它们在正常使用中不会出现，
 * 但一旦出现，表现是「文件夹在界面上凭空消失、还删不掉」——
 * 用户既看不懂也处理不了。所以这里用固定数据把这些路径钉死。
 */
import { describe, expect, it } from "vitest";

import type { Folder } from "./api";
import { childrenOf, flattenFolders, folderPath, foldersOf, subtreeIds } from "./folders";

/** 造一个文件夹。测试只关心结构，其余字段给固定值。 */
function f(id: string, parentId: string | null, order = 0, feature = "links"): Folder {
  return { id, feature, name: id, note: "", parentId, order, createdAt: 0 };
}

describe("foldersOf", () => {
  it("只留本页签的文件夹", () => {
    const all = [f("a", null), f("b", null, 0, "timer")];
    expect(foldersOf(all, "links").map((x) => x.id)).toEqual(["a"]);
    expect(foldersOf(all, "memo")).toEqual([]);
  });
});

describe("childrenOf", () => {
  it("只取直接子级，不取孙子", () => {
    const all = [f("root", null), f("kid", "root"), f("grand", "kid")];
    expect(childrenOf(all, null).map((x) => x.id)).toEqual(["root"]);
    expect(childrenOf(all, "root").map((x) => x.id)).toEqual(["kid"]);
    expect(childrenOf(all, "kid").map((x) => x.id)).toEqual(["grand"]);
  });

  it("按 order 再按创建时间排序", () => {
    const all = [
      { ...f("late", null, 2), createdAt: 1 },
      { ...f("early", null, 1), createdAt: 9 },
      { ...f("older", null, 1), createdAt: 1 },
    ];
    expect(childrenOf(all, null).map((x) => x.id)).toEqual(["older", "early", "late"]);
  });

  it("父级不存在的文件夹按顶层处理", () => {
    // 关键一条：不这么兜的话，这些文件夹谁也够不着，
    // 数据还在、界面上却永远打不开
    const all = [f("orphan", "已经删掉的父级")];
    expect(childrenOf(all, null).map((x) => x.id)).toEqual(["orphan"]);
    expect(childrenOf(all, "已经删掉的父级")).toEqual([]);
  });
});

describe("folderPath", () => {
  it("从顶层排到目标", () => {
    const all = [f("a", null), f("b", "a"), f("c", "b")];
    expect(folderPath(all, "c").map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("顶层返回空数组", () => {
    expect(folderPath([f("a", null)], null)).toEqual([]);
  });

  it("认不出来的 id 返回空数组而不是抛错", () => {
    // 当前所在的文件夹刚被删掉时会走到这里
    expect(folderPath([f("a", null)], "不存在")).toEqual([]);
  });

  it("数据里出现环时不会死循环", () => {
    // 手改 JSON 能造出这种结构。宁可面包屑少一截，也不能把界面卡死
    const all = [f("a", "b"), f("b", "a")];
    const trail = folderPath(all, "a");
    expect(trail.length).toBeLessThanOrEqual(2);
    expect(trail.map((x) => x.id)).toContain("a");
  });
});

describe("subtreeIds", () => {
  it("包含自己与全部后代", () => {
    const all = [f("a", null), f("b", "a"), f("c", "b"), f("other", null)];
    expect(subtreeIds(all, "a").sort()).toEqual(["a", "b", "c"]);
  });

  it("叶子节点只有自己", () => {
    expect(subtreeIds([f("a", null)], "a")).toEqual(["a"]);
  });

  it("遇到环也不会无限展开", () => {
    const all = [f("a", "b"), f("b", "a")];
    expect(subtreeIds(all, "a").sort()).toEqual(["a", "b"]);
  });
});

describe("flattenFolders", () => {
  it("父级排在子级前面，并标出缩进深度", () => {
    // 深度优先：a 的整棵子树排在 z 前面——缩进要有意义就必须这样，
    // 否则子级会离父级很远，用户看不出谁属于谁
    const all = [f("a", null), f("b", "a"), f("c", "b"), f("z", null)];
    expect(flattenFolders(all).map((x) => [x.folder.id, x.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["z", 0],
    ]);
  });

  it("孤儿文件夹也列出来（按顶层）", () => {
    // 不列的话「移动到…」里就选不到它，而它其实还在数据里
    const all = [f("root", null), f("orphan", "已经删掉的父级")];
    expect(flattenFolders(all).map((x) => x.folder.id).sort()).toEqual(["orphan", "root"]);
  });

  it("环里的文件夹也不会漏掉", () => {
    // A、B 互相是对方的父级：既不是根也不是孤儿，第一趟遍历够不着。
    // 漏掉的后果是这两个文件夹在「移动到…」里永远选不到。
    const all = [f("a", "b"), f("b", "a"), f("normal", null)];
    const ids = flattenFolders(all).map((x) => x.folder.id);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("normal");
  });

  it("每个文件夹只出现一次", () => {
    const all = [f("a", null), f("b", "a"), f("c", "a"), f("d", "b")];
    const ids = flattenFolders(all).map((x) => x.folder.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
