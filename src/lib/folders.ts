/**
 * 文件夹的纯逻辑。
 *
 * # 为什么单独一个模块
 *
 * 链接、文本片段、计时器三个页签**共用同一套文件夹**（数据在 `folders.json`，
 * 靠 `feature` 字段区分归属），三边的浏览方式都是「面包屑下钻」。
 * 所以「取子级」「取路径」「取整棵子树」这些判断只能有一份实现——
 * 写三份迟早会在某个边界上不一致。
 *
 * # 传进来的列表要先按页签过滤
 *
 * 这些函数只认父子关系，不认 `feature`。调用方应当先过一遍
 * {@link foldersOf}，否则会把别的页签的文件夹也算进层级里。
 *
 * # 坏数据：孤儿与环
 *
 * 数据是纯文本 JSON，用户可以手改，也可能遇到"删除到一半失败"的残留。
 * 于是两种坏结构都真实可能出现：
 *
 * - **孤儿**：`parentId` 指向一个不存在的文件夹。这里的统一处理是**当成顶层**。
 *   不这么兜的话，这些文件夹谁也够不着——数据还在，界面上却永远打不开。
 * - **环**：A 的父级是 B、B 的父级是 A。{@link folderPath} 用 `seen` 兜住，
 *   宁可面包屑少一截，也不能让界面卡死。
 */
import type { Folder } from "./api";

/** 排序：先按 order，再按创建时间。和 Rust 侧的排序保持一致。 */
function byOrder(a: Folder, b: Folder): number {
  return a.order - b.order || a.createdAt - b.createdAt;
}

/** 取出某个页签自己的文件夹。 */
export function foldersOf(all: Folder[], feature: string): Folder[] {
  return all.filter((f) => f.feature === feature);
}

/**
 * 取某个父级下的**直接**子文件夹，已排好序。
 *
 * 父级不存在的文件夹按顶层处理（见文件头说明）。
 */
export function childrenOf(all: Folder[], parentId: string | null): Folder[] {
  const ids = new Set(all.map((f) => f.id));
  return all
    .filter((f) => {
      const parent = f.parentId !== null && ids.has(f.parentId) ? f.parentId : null;
      return parent === parentId;
    })
    .sort(byOrder);
}

/**
 * 从顶层到指定文件夹的路径——面包屑要显示的就是它。
 *
 * 传 `null` 返回空数组；认不出来的 id 也返回空数组而不是抛错
 * （当前文件夹刚被删掉时就会走到这条路径）。
 */
export function folderPath(all: Folder[], id: string | null): Folder[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const trail: Folder[] = [];
  const seen = new Set<string>();

  let cursor = id === null ? undefined : byId.get(id);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    trail.unshift(cursor);
    const parentId = cursor.parentId;
    cursor = parentId === null ? undefined : byId.get(parentId);
  }
  return trail;
}

/**
 * 某个文件夹自己 + 全部后代的 id。
 *
 * 用途是「不能把一个文件夹移到它自己的子孙里」这类校验：
 * 那样会造出一个谁也够不着的环。
 */
export function subtreeIds(all: Folder[], id: string): string[] {
  const out = [id];
  // 用下标推进而不是 shift()：数组很小，但 shift 是 O(n)，
  // 在一个会被频繁调用的判定里没必要
  for (let i = 0; i < out.length; i++) {
    const current = out[i];
    for (const f of all) {
      if (f.parentId === current && !out.includes(f.id)) out.push(f.id);
    }
  }
  return out;
}

/** 压平后的一个条目：文件夹 + 它在层级里的缩进深度。 */
export interface FlatFolder {
  folder: Folder;
  /** 顶层是 0，每深一层 +1。 */
  depth: number;
}

/**
 * 把文件夹按层级压平成一维列表，父级排在子级前面。
 *
 * 面包屑是「一层一层往里走」，而「移动到…」这类操作需要**一次看到全部层级**，
 * 否则用户得先记住目标文件夹在哪一层。压平 + 缩进就能一次列全。
 *
 * 两种坏数据都不会让它卡住或漏掉：
 * - **孤儿**（父级不存在）由 {@link childrenOf} 当成顶层，会被遍历到；
 * - **环**（A 的父级是 B、B 的父级是 A）让两个都既不是根也不是孤儿，
 *   第一趟遍历够不着——所以最后补一趟，把没访问过的按顶层挂出来。
 *   界面上宁可层级显示得不准，也不能让文件夹点不到。
 */
export function flattenFolders(all: Folder[]): FlatFolder[] {
  const out: FlatFolder[] = [];
  const seen = new Set<string>();

  const walk = (parentId: string | null, depth: number) => {
    for (const f of childrenOf(all, parentId)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);

  for (const f of all) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      out.push({ folder: f, depth: 0 });
    }
  }

  return out;
}
