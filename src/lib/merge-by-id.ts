/**
 * 按 `id` 做三方合并 —— 跨窗口写入的"读-合并-写"里的那个"合并"。
 *
 * # 它解决什么
 *
 * `snippets.json` 是**整份覆盖写**的。两个面板各持一份内存副本时，
 * 后写的那一份会把先写的整份盖掉：A 正在打字（一直是 dirty 的），
 * B 存了一条 → A 的防抖到点 → A 写的是"自己那份不含 B 新条目的完整数组"
 * → **B 刚存的东西无声消失**。这不是窄窗口竞态，用户只要在 A 里连续打字，
 * 窗口就是整个打字过程。
 *
 * 所以写盘前先读回磁盘上的那一份，把"我这份""磁盘那份"和"上一次我们一致的那份"
 * 做一次三方合并。有了第三份（共同祖先），才分得清"这条是对方新加的"和
 * "这条是我删掉的" —— 只看 id 在不在是分不清的，那正是最容易写错的地方。
 *
 * # 为什么单独一个文件
 *
 * 这是纯函数（不碰 React、不碰 IPC），而它周围全是 hook 与磁盘。
 * 抽出来才能把上面那些情形**穷举**掉 —— 合并错了不会报错，只会静默丢数据。
 */
/** 只要能按 `id` 认出"同一条"，就能合并。 */
export interface HasId {
  id: string;
}

/**
 * 深度比较两个值是否相同。
 *
 * 用它而不是 `JSON.stringify(a) === JSON.stringify(b)`：后者的结果依赖**键的顺序**，
 * 而同一个对象经过 `{...x, title: "..."}` 之后键顺序就可能变了。键顺序不同不代表
 * 内容不同 —— 用它会让"只有远端改了"被误判成"本地也改了"，于是白白丢掉远端的修改。
 *
 * 只处理 JSON 能表达的值（对象 / 数组 / 字符串 / 数字 / 布尔 / null），
 * 这也正是这些数据文件里可能出现的东西。
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `NaN === NaN` 是 false，但两条记录里都是 NaN 时它们并没有差别
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  // 键的数量不同就一定是不同的对象（下面还会逐键确认对方也有这个键）
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/**
 * 元素是不是"带字符串 id 的对象"。
 *
 * 合并的前提是能认出"同一条"，认不出就退化成"本地赢"（见 `store.ts` 的
 * `mergeValues`）—— 那至少不会丢用户正在敲的东西。
 */
export function isIdItem(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

/**
 * 三方合并两个数组。
 *
 * @param base 上一次"本地与磁盘一致"时的那一份（共同祖先）
 * @param local 本地现在这一份（用户正在编辑的）
 * @param remote 磁盘上现在这一份（别处刚写下去的）
 *
 * # 逐条的判定
 *
 * | base | local | remote | 结论 |
 * |---|---|---|---|
 * | 无 | 有 | 无 | 本地新增 → 保留 |
 * | 无 | 无 | 有 | 远端新增 → 采纳 |
 * | 有 | 无 | 无 | 两边都删了 → 删掉 |
 * | 有 | 有 | 无 | 远端删了 → 本地没动过就跟着删；本地改过就保住本地那份 |
 * | 有 | 无 | 有 | 本地删了 → **本地赢**（删除是用户明确的动作） |
 * | 有 | 有 | 有 | 谁跟 base 不同谁赢；都不同（或都没变）时**本地赢** |
 * | 无 | 有 | 有 | 两边各自新增了同一个 id → 本地赢 |
 *
 * ⚠️ **"远端删除"和"本地新增"看起来都是"id 只出现在一边"**，光看 id 在不在
 * 分不清这两件事。上面那两行能分开，靠的是 `base` 的成员关系：
 * 一个 id 在 `base` 里出现过，才谈得上"被谁删了"；没出现过就是"谁新加的"。
 * 这是整个合并里最容易写错的一处，`merge-by-id.test.ts` 有专门用例钉它。
 *
 * # 顺序
 *
 * 以 `local` 的顺序为准，远端新增的按 `remote` 里的顺序接在后面。
 * `snippets.json` 的顺序本身没有语义（界面按"收藏 → 使用次数 → 最近更新"重排），
 * 所以这里只求**稳定、可预期**：同一个窗口连续两次合并不会让列表跳来跳去。
 *
 * # 两边改了同一条时为什么本地赢
 *
 * 本地那一份是**用户此刻正在敲的**。远端那份已经落盘了、还在磁盘上（下次读还在），
 * 而本地这份只活在内存里，盖掉就永久没了。两害相权取其轻。
 */
export function mergeById<T extends HasId>(base: T[], local: T[], remote: T[]): T[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));

  const out: T[] = [];
  const done = new Set<string>();

  const take = (id: string) => {
    if (done.has(id)) return;
    done.add(id);
    const picked = resolve(baseMap, localMap, remoteMap, id);
    if (picked !== undefined) out.push(picked);
  };

  // 先按本地的顺序；远端新增的（本地没有）接在后面
  for (const item of local) take(item.id);
  for (const item of remote) take(item.id);

  return out;
}

/** 决定某一个 id 最终留哪一份；返回 `undefined` 表示这条不该出现在结果里。 */
function resolve<T extends HasId>(
  baseMap: Map<string, T>,
  localMap: Map<string, T>,
  remoteMap: Map<string, T>,
  id: string,
): T | undefined {
  const base = baseMap.get(id);
  const local = localMap.get(id);
  const remote = remoteMap.get(id);

  // 基底里没有 → 两边各自新增（或只有一边新增）
  if (base === undefined) return local ?? remote;

  // 本地删了：删除是用户明确的动作，本地赢
  if (local === undefined) return undefined;

  if (remote === undefined) {
    // 远端删了。本地没动过就跟着删；本地改过就保住本地改的那一份
    return sameValue(local, base) ? undefined : local;
  }

  const localChanged = !sameValue(local, base);
  const remoteChanged = !sameValue(remote, base);
  // 谁跟 base 不同谁赢；都不同（或都没变）时本地赢
  if (remoteChanged && !localChanged) return remote;
  return local;
}
