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
 * | 有 | 有 | 有 | 只有一边改过 → 改过的那边赢；两边都改过 → 见下 |
 * | 无 | 有 | 有 | 两边各自新增了同一个 id → 本地赢 |
 *
 * ⚠️ **"远端删除"和"本地新增"看起来都是"id 只出现在一边"**，光看 id 在不在
 * 分不清这两件事。上面那两行能分开，靠的是 `base` 的成员关系：
 * 一个 id 在 `base` 里出现过，才谈得上"被谁删了"；没出现过就是"谁新加的"。
 * 这是整个合并里最容易写错的一处，`merge-by-id.test.ts` 有专门用例钉它。
 *
 * # 两边都改过同一条时谁赢
 *
 * 分两档：
 *
 * 1. **两边都真的刷过时间戳**（各自的 `updatedAt` 都比 `base` 新）且不相等 →
 *    **较晚的那次编辑赢**。这样结果与"谁后写盘"无关（见 `preferNewer`，
 *    那里写了这条规则的前提和边界）。
 * 2. 其余情况（只有一边刷过、没有 `updatedAt`、类型不对、同一毫秒）→ **本地赢**。
 *    本地那一份是**用户此刻正在看的**：远端那份已经落盘、磁盘上还有，
 *    而本地这份只活在内存里，盖掉就永久没了。两害相权取其轻。
 *
 * ⚠️ 第 1 档只对**有** `updatedAt` 的数据生效：目前只有 `Snippet` 和 `Memo` 有，
 * `Timer` / `LinkItem` / `Folder` 都没有（它们永远走第 2 档）。
 *
 * 无论哪一档，被盖掉的那一次修改都会丢 —— 一条记录只有一个版本。
 *
 * # 顺序
 *
 * 以 `local` 的顺序为准，远端新增的按 `remote` 里的顺序接在后面。
 * `snippets.json` 的顺序本身没有语义（界面按"收藏 → 使用次数 → 最近更新"重排），
 * 所以这里只求**稳定、可预期**：同一个窗口连续两次合并不会让列表跳来跳去。
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

/**
 * 两边都改过同一条时，能不能靠 `updatedAt` 明确分出谁更新。
 *
 * @param base 共同祖先（必须由调用方传进来，**不要在这里重新构造** —— 那会多出一个
 *   真相来源，而"谁比 base 新"正是这条规则的判据）
 * @returns 该留下的那一份；`null` 表示"分不出来"，调用方退回"本地赢"。
 *
 * # 前提：**两边都必须真的刷过时间戳**
 *
 * 只有 `localAt > baseAt && remoteAt > baseAt`（两边各自的 `updatedAt` 都比 base 新）
 * 时才比大小。少了这一条会踩一个**静默丢用户操作**的坑：
 *
 * `moveTo` / `moveItems`（把条目拖进文件夹）**刻意不刷 `updatedAt`**
 * （见 `features/snippets` 那段说明：归类不是改内容，一刷时间戳就会把条目顶到
 * "最近更新"最前面）。于是"本地刚把条目拖进文件夹"这一版的时间戳**等于** base：
 *
 * ```
 * base   : { folderId: null, updatedAt: T0 }
 * local  : { folderId: "f1", updatedAt: T0 }   ← 刚拖进去，时间戳没变
 * remote : { title: "改了正文", updatedAt: T1 } ← 另一窗口后来改了内容
 * ```
 *
 * 不检查前提的话两边都算"改过"，取较新的那一侧 → **远端的 `folderId: null` 胜出**
 * → 用户的拖拽被丢弃并写回磁盘，条目自己跳回原位，而且没有任何提示。
 * 加上前提之后这一档退回"本地赢"，拖拽保住了。
 *
 * 镜像的那一档（远端只挪文件夹、本地改正文）同样由"本地赢"兜住：
 * 远端没刷时间戳 → 不比大小 → 本地那份内容编辑留下。
 *
 * ⚠️ 代价说清楚：**一边只挪文件夹、另一边改内容**时，无论方向如何都是"本地赢"，
 * 也就是**远端那一次修改会丢**。要两边都留住得做逐字段合并（内容取一边、
 * `folderId` 取另一边），那是数据模型级别的改动，本轮不做。
 *
 * # 内容对内容
 *
 * 两边都真的刷过时间戳（即都是内容编辑）时，仍然是**较晚的那次编辑赢** ——
 * 与写盘顺序无关。这一档没有被上面那个前提削弱，`merge-by-id.test.ts` 里
 * 「两边都改过同一条：靠 updatedAt 分先后」那一组钉的就是它。
 *
 * # 哪些数据有 `updatedAt`
 *
 * 只有 `Snippet`（`api.ts` 的 `Snippet.updatedAt`）和 `Memo`（`Memo.updatedAt`）有；
 * **`Timer` / `LinkItem` / `Folder` 都没有** —— 对它们这条规则永远不生效，
 * 一律走"本地赢"。这是刻意的：`mergeById` 是通用的，不能要求所有调用方都提供
 * 这个字段（也不该给没有时间戳的数据硬造一个）。
 *
 * # ⚠️ 它与"保住用户正在敲的东西"的关系（别以为万无一失）
 *
 * - 片段编辑器**每敲一下**都会把 `updatedAt` 刷成当前时间
 *   （`features/snippets` 的 `onDraftChange`；编辑器的每个输入框都走
 *   `patch()` → `onChange` → 那里）。所以"我正在编辑这一条"几乎总是较新的一侧。
 * - 但"几乎"不是"总是"：如果**另一侧在这之后**也编辑了同一条，那一侧更新，
 *   于是本窗口刚敲的那版会被换成对面那版 —— 用户会看到自己刚写的内容被替换。
 *   这是"较新的编辑赢"的代价，换来的正是上面那条"结果与写盘顺序无关"。
 *   编辑器「完成」时的提示会如实说明（见 `features/snippets` 的 `finishEdit`）。
 * - 正在编辑中的那一条通常不会真的丢内容：编辑器手里还有一份自己的草稿
 *   （`SnippetEditor` 的 `form`），下一次敲键会把整条重写回去。
 * - `moveTo`（移动到文件夹）**刻意不刷 `updatedAt`**，所以它走第 2 档、永远是
 *   本地赢 —— 拖拽不会被吃掉（见上面那个例子）。
 */
function preferNewer<T extends HasId>(base: T, local: T, remote: T): T | null {
  const baseAt = updatedAtOf(base);
  const localAt = updatedAtOf(local);
  const remoteAt = updatedAtOf(remote);
  if (baseAt === null || localAt === null || remoteAt === null) return null;

  /**
   * ⚠️ 两边都必须**真的刷过**时间戳（严格比 base 新）才比大小。
   *
   * 用 `<=` 而不是 `===` 来挡：时间戳倒退（系统时钟被改、或数据被手改过）时
   * 也当成"分不出先后"，退回本地赢 —— 那比"按一个不可信的先后去覆盖"安全。
   */
  if (localAt <= baseAt || remoteAt <= baseAt) return null;

  // 同一毫秒（两边都在这一毫秒里刷过）分不出先后 → 本地赢
  if (localAt === remoteAt) return null;
  return remoteAt > localAt ? remote : local;
}

/** 读一条记录的 `updatedAt`；没有或者不是有限数字就返回 `null`。 */
function updatedAtOf(item: unknown): number | null {
  if (typeof item !== "object" || item === null || !("updatedAt" in item)) return null;
  const value = item.updatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  // 只有一边改过：改过的那边赢
  if (remoteChanged && !localChanged) return remote;
  if (localChanged && !remoteChanged) return local;

  // 两边都改过（或都没改过）：能靠 `updatedAt` 分出先后就取较新的，否则本地赢。
  // `base` 必须一路传下去 —— "谁真的刷过时间戳"的判据就是"谁比 base 新"，
  // 在 preferNewer 里重新构造一个 base 会多出第二个真相来源。
  return preferNewer(base, local, remote) ?? local;
}
