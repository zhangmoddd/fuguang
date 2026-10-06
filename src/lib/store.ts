/**
 * 数据持久化。
 *
 * 数据存在 `%APPDATA%\浮光\*.json`，纯文本、可手动编辑、可直接备份。
 * 刻意不用数据库：这个体量（几千条文本）用 JSON 完全够，而且用户能自己打开看、自己抢救。
 *
 * 写入策略是「防抖批量写」：用户连续敲字时不会每敲一个字符就写一次磁盘，
 * 但会在停顿 400ms 后落盘，并且切换页面/关闭窗口时强制立即落盘，保证不丢数据。
 *
 * # 跨窗口同步
 *
 * 主面板可以同时开好几个（每个窗口一份独立的内存副本），而 `snippets.json`
 * 是**整份覆盖写**的：两个窗口各持一份旧副本，后写的会把先写的整份盖掉。
 * 所以写盘成功后广播一次，别的窗口重新读盘。判定逻辑见 {@link decideExternalChange}。
 *
 * ## 广播之外：写盘前先读-合并
 *
 * 广播只能让**空闲**的窗口跟上。用户只要在一个窗口里连续打字，那个窗口就一直
 * 是"有未落盘改动"的状态（防抖不会触发），而它写下去的是**整份**数据 ——
 * 那一次写会把别处刚写的东西整份盖掉，永久丢失。这不是窄窗口竞态，
 * 窗口就是整个打字过程。
 *
 * 所以：**收到过别处改动时**，写盘前先把磁盘读回来，按 `id` 做一次三方合并
 * （见 `merge-by-id.ts`），再写合并结果。没有收到过外部改动时一行都不变 ——
 * 单窗口场景仍然是"直接写 `latest.current`、不多读一次盘"。
 *
 * ## 仍然可能丢的情形（诚实列出，不是"已经彻底解决"）
 *
 * 下面每一条都是**已知的、刻意保留的**残留。改这块代码之前请先读完，
 * 别把"已知残留"当成"没做"又去修一遍（或者更糟：以为不存在）。
 *
 * ### 1. 读-合并-写之间的毫秒级窗口（无法用前端锁消除）
 *
 * 慢路径是「`readData` → 合并 → `writeData`」三步。中间**没有锁** ——
 * Rust 侧 `write_data` 的注释原文就写着"这把锁只串行化写盘，读取完全不受影响"。
 * 所以另一个窗口在这三步之间落盘的内容，会被我们的合并结果整份盖掉。
 *
 * 窗口从"整个打字过程"缩到了毫秒级，但**没有消除**。
 * 根治要么给 `read_data` 带上世代号、由 `write_data` 在锁内比对（乐观并发），
 * 要么把整个读-合并-写搬进 Rust。**队长裁决本轮不做**：那是数据层换模型，
 * 风险比它修的那个毫秒级窗口大。详见 CHANGELOG 的「已知限制」。
 *
 * ### 2. 两边改了同一条
 *
 * 两边都带数字 `updatedAt` 时取**较新**的那次编辑；分不出先后（只有一边带、
 * 类型不对、同一毫秒）时**本地赢**。注意只有 `Snippet` 与 `Memo` 有 `updatedAt`
 * —— `Timer` / `LinkItem` / `Folder` 都没有，它们永远走"本地赢"。
 * 无论哪种，被盖掉的那一次修改会丢 —— 一条记录只有一个版本，
 * 要两边都留住得做逐字段合并或版本历史，那是数据模型级别的改动。
 * 这条规则的边界（包括"正在编辑的那一侧是否总是较新"）写在 `merge-by-id.ts`
 * 的 `preferNewer` 上。
 *
 * ### 3. 导入备份时"已经在飞"的那次写盘（拦不住）
 *
 * `yieldToReplacedFile` 能取消**还没发出**的那次写盘（清定时器 + 清 dirty），
 * 但已经发出去的 IPC 拦不住 —— 它会带着导入前的数据落地，可能把刚导入的
 * `snippets.json` 盖回去。
 *
 * ⚠️ 这种时序的**结果是不确定的**，前端也判定不出来：
 * 我们读回导入结果和那次写盘落地**谁先谁后**决定了两件不同的事 ——
 * - 读在写之前 → 内存是导入后的数据，磁盘随后被旧数据盖掉；
 * - 读在写之后 → 内存和磁盘**都是导入前的旧数据**。
 *
 * 后一种情况下，用户看到的是"导入好像没生效"，而且没有任何提示。
 * 前端能做的只是"下次写盘时把内存那份写回去"，但内存那份**不保证**是导入后的
 * （见上）。要可靠地判定，只能靠 Rust 侧的世代号校验（同第 1 条的根治方案）。
 *
 * 发起导入的那个窗口自己也会踩这个坑，而且它连 `force` 广播都收不到
 * （广播只发给别的窗口）—— 所以 `settings/index.tsx` 的导入流程会**自己先让位**。
 *
 * ### 4. 读盘失败 / 文件形状不对
 *
 * 合并没法做，只能退回"直接写自己那份"，别处的改动这一次就保不住了。
 * 但绝不因此不写 —— 不写会丢掉用户自己的东西。
 *
 * ### 5. 窗口被强制杀掉（任务管理器结束进程）
 *
 * 防抖窗口内（400ms）没落盘的改动本来就丢，与合并无关。
 *
 * ### 6. 已知但**不修**：`sameValue` 对"多一个 `undefined` 值的键"判成不同
 *
 * `{"a":1}` 与 `{"a":1,"b":undefined}` 会被判成"改过了"。审查员把它标为
 * **推测、未构造出反例**，而且对 `snippets.json` 不可达 —— JSON 里没有
 * `undefined` 这个值（`JSON.parse` 不会产出它）。**刻意不修**：
 * 为一条不可达的路径给深比较加分支，只会让这段最容易出错的代码更难读。
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { api } from "./api";
import { isIdItem, mergeById } from "./merge-by-id";
import { currentPanelLabel } from "./panel-state";
import { WriteCoordinator } from "./write-coordinator";

/** 写入防抖延迟。太短会频繁写盘，太长会在异常退出时丢更多数据。 */
const WRITE_DEBOUNCE_MS = 400;

/**
 * `flushAll` 最多等多久。
 *
 * 为什么要超时：关窗口和导入备份都在等它，而**一次永不返回的写盘会让调用方
 * 永远卡住** —— 用户点了「覆盖导入，无法撤销」，界面一直 busy、导入永远不开始、
 * 也没有任何提示。那是典型的"卡死且不解释"。
 *
 * 3 秒是取舍：正常的写盘是毫秒级，磁盘慢（机械盘 + 杀软扫描）也就几百毫秒；
 * 超过 3 秒说明这一次写盘大概率有问题，不该再让用户干等。
 */
const FLUSH_ALL_TIMEOUT_MS = 3000;

// ===============================================================
// 跨窗口同步
// ===============================================================

/** 「某个数据文件变了」的跨窗口事件名。 */
export const DATA_CHANGED_EVENT = "fuguang:data-changed";

/** 事件载荷。 */
export interface DataChangedPayload {
  /** 变了的文件名（例如 `snippets.json`）。`"*"` 表示**全部**文件都变了。 */
  file: string;
  /**
   * 是不是"用户明确要求覆盖"（导入备份）。
   *
   * 只有这种广播才允许**盖掉**别的窗口里还没落盘的改动 —— 用户刚刚在确认框上
   * 点了「覆盖导入」，那是他的明确意图。普通写盘的广播没有这个资格。
   */
  force?: boolean;
  /**
   * 谁发的。
   *
   * 必须带：`emit` 是广播给**所有**窗口的，发消息的窗口自己也会收到。
   * 不带的话本窗口会把自己的写盘当成"别处的改动"，白读一次盘、白换一次数组。
   */
  from: string;
}

/** 收到外部变更之后该怎么做。 */
export type ExternalChangeDecision =
  /** 与本次广播无关（不是我这份文件，或就是我自己发的）。 */
  | "ignore"
  /** 立刻重新读盘、替换内存。 */
  | "reload"
  /** 现在不能覆盖内存（本地还有没落盘的改动），等落盘完成后再拉。 */
  | "defer";

/**
 * 收到一条「别处改了这个文件」的广播时，该不该重新拉取。
 *
 * 抽成纯函数是因为这段判断错了**不会报错**，只会表现成"东西莫名其妙没了" ——
 * 那是数据层最难排查的一类 bug，必须能用固定输入钉死。
 *
 * # 三种结论的判据
 *
 * - 不是这份文件 / 就是自己发的 → `ignore`
 * - 本地没有未落盘的改动 → `reload`。这是绝大多数情况：广播来自别的窗口的一次写盘，
 *   我们手里那份已经陈旧了，直接采纳磁盘上的最新值。
 * - 本地**有**未落盘的改动 → 看 `force`：
 *   - `force`（导入备份）→ 仍然 `reload`。用户刚点了「覆盖导入，无法撤销」，
 *     这时候保住本地那份未落盘的改动反而违背他的意图。
 *   - 否则 → `defer`：**不能**直接覆盖（那会把用户正在敲的东西删掉），
 *     也不能不管（我们这份是陈旧的，下次任何一次 update 都会把别处的改动整份盖回去）。
 *     所以记一个"待重拉"，等本地这次落盘完成、内存与磁盘重新一致之后立刻拉一次。
 */
export function decideExternalChange(
  payload: DataChangedPayload | null | undefined,
  file: string,
  dirty: boolean,
  selfLabel: string,
): ExternalChangeDecision {
  if (!payload) return "ignore";
  if (payload.from && payload.from === selfLabel) return "ignore";
  if (payload.file !== "*" && payload.file !== file) return "ignore";
  if (!dirty) return "reload";
  return payload.force ? "reload" : "defer";
}

/**
 * 广播「这个文件变了」，让别的窗口重新读盘。
 *
 * 刻意**不放进 `api.ts`**：那是 Rust 侧的调用清单（一条命令一个包装），
 * 而这是一条纯粹的前端约定（事件名、载荷形状、要不要重读都由前端定）。
 */
export async function emitDataChanged(file: string, force = false): Promise<void> {
  const payload: DataChangedPayload = { file, force, from: currentPanelLabel() };
  await emit(DATA_CHANGED_EVENT, payload);
}

/**
 * 广播「所有数据都被整份换掉了」—— 导入备份之后调用。
 *
 * 要发**两条**事件，因为窗口里的数据有两条不同的来源：
 *
 * 1. `fuguang:data-changed`（`file: "*"`）：走 `usePersistentState` 的那些
 *    （目前是 `snippets.json`）会重新读盘；
 * 2. `state-changed`：备忘 / 计时器 / 链接页 / 文件夹各自持有一份**自己的**
 *    内存状态，它们订阅的是 Rust 侧那条既有的事件（`what` 里点名了哪几类数据变了，
 *    见 `main.tsx` 与各功能页的订阅）。文件夹那一份在 `lib/folders-ui.tsx` 的
 *    `useFolders` 里（三个用到文件夹的页签共用同一套）；`snippets` 不走这条，
 *    它走上面第 1 条。
 *
 *    ⚠️ 改这个 `what` 数组时请同步确认那几处还在听 —— 少一项就是"某个页签在别的
 *    窗口里永远是旧的"，而用户会以为导入没生效。
 *
 * 只发第 1 条的话，别的面板窗口会一直显示导入前那份，而且它下一次保存就会把
 * 刚恢复的备份**整份写回旧值** —— Rust 侧的写锁拦不住这个（它只串行化写盘，
 * 内容本身就是旧的）。
 *
 * ⚠️ 这条广播**发不到发起导入的那个窗口自己**（它就在发消息的窗口里，而
 * `decideExternalChange` 会忽略自己发的）。所以发起方必须自己让位 ——
 * 见 `settings/index.tsx` 的导入流程（先 `flushAll()` 再 `importAll`）。
 *
 * `force: true`：用户刚在确认框上点了「覆盖导入，无法撤销」，
 * 这时候别的窗口里没落盘的改动也该让位。
 */
export async function emitDataReplacedAll(): Promise<void> {
  await emitDataChanged("*", true);
  await emit("state-changed", {
    what: ["memos", "timers", "links", "snippets", "folders", "settings"],
  });
}

/**
 * 把「按 id 合并」套到 hook 的泛型 `T` 上。
 *
 * `usePersistentState` 的 `T` 是**整份数据**的类型（对 `snippets.json` 就是
 * `Snippet[]`），而它是个通用 hook，对 T 没有约束 —— 加约束会改掉它的公开签名。
 * 所以这里先用运行期判断确认"它是个元素带 id 的数组"：
 * 不是就退化成"本地赢"（也就是这一轮之前的行为：直接写自己那份）。
 *
 * ⚠️ 最后那处断言是**必需的，也是安全的**：`mergeById` 只会从传进去的两个数组里
 * **挑**元素、不会新建元素，所以结果里的每个对象都还是原来那个类型的对象；
 * TS 表达不了"这个数组装的还是 T 的那些元素"（把 `T` 约束成 `{id:string}[]` 也不行 ——
 * 那样 `T` 还可能是元组，`T[number][]` 一样赋不回 `T`），只能断言一次。
 * 它不是"把编译错误糊过去"：判断在前一行、断言在后一行，两者是配套的；
 * `store.test.ts` 里有一组用例专门走这个入口，验证合并结果确实是原来那些对象。
 */
function mergeValues<T>(base: T, local: T, remote: T): T {
  if (!isIdList(base) || !isIdList(local) || !isIdList(remote)) return local;
  return mergeById(base, local, remote) as T;
}

/**
 * 运行期确认"这是个元素带 id 的数组"，并把它收窄成 `T & { id: string }[]`。
 *
 * 收窄成"与 T 的交集"而不是"另一个类型"是关键：交集可以赋回 `T`，
 * 于是 `mergeValues` 里只需要在**合并结果**那一处收口（见那里的说明）。
 */
function isIdList<T>(value: T): value is T & { id: string }[] {
  if (!Array.isArray(value)) return false;
  // `Array.isArray` 之后 value 是 `T & any[]`；先落成 `unknown[]` 再逐项判断，
  // 这样下面读 `item.id` 不用写任何断言
  const list: unknown[] = value;
  return list.every(isIdItem);
}

/**
 * 算出这一次写盘该写什么。
 *
 * - `externalSeen` 为假（没收到过别处的改动）→ **快路径**：原样返回 `local`，
 *   **一次盘都不读**。单窗口场景的行为与以前逐字节相同。
 * - `externalSeen` 为真 → **慢路径**：先读盘，再按 id 做三方合并，返回合并结果。
 *   读不到盘（文件不存在 / 读失败 / 形状不对）时退回 `local` ——
 *   不能因为合并失败就不写盘，那会丢掉用户自己的改动。
 *
 * 抽成不依赖 React 的普通函数是为了能在 node 里直接测（这个项目的测试跑在
 * `environment: "node"`，hook 测不了）。`read` 由调用方注入，测试里就能数它被调了几次 ——
 * 于是"没收到外部变更时不会去读盘"这句话是可验证的，而不是靠读代码相信。
 *
 * @returns `value` 是要写到磁盘上的那一份；`localAtMerge` 是**算合并那一刻**的
 *   本地值（快路径为 `null`），调用方写完盘之后拿它和最新的本地值比，
 *   决定要不要把结果采纳进界面 —— 见 {@link shouldAdoptMerge}。
 */
export async function planWrite<T>(args: {
  file: string;
  base: T;
  local: T;
  externalSeen: boolean;
  read: (file: string) => Promise<T | null>;
  isShapeValid?: (value: unknown) => boolean;
}): Promise<{ value: T; localAtMerge: T | null }> {
  if (!args.externalSeen) return { value: args.local, localAtMerge: null };

  const local = args.local;
  let disk: T | null = null;
  try {
    const read = await args.read(args.file);
    if (
      read !== null &&
      read !== undefined &&
      (!args.isShapeValid || args.isShapeValid(read))
    ) {
      disk = read;
    }
  } catch {
    /* 读不了 → disk 保持 null → 下面退回现状 */
  }

  if (disk === null) return { value: local, localAtMerge: local };
  return { value: mergeValues(args.base, local, disk), localAtMerge: local };
}

/**
 * 把「有未落盘的改动」这个标记清掉，并且不写盘。
 *
 * `WriteCoordinator` 没有 `reset()`，而 `begin()` + `commit()` 正好是"标记成已写盘"
 * 的原语 —— 这正是"取消这次写"的意思：这一份我们不要了，所以不需要它落盘。
 * 清完之后 `dirty` 为假，`flush()` 会直接早退（连 `writeData` 都不会调）。
 *
 * @returns 是否确实没有待写内容了。`false` 表示有一次写盘**正在飞**（`begin()` 被拒）——
 *   那次飞行已经带着旧数据走了，拦不住；调用方只能把内存换成新的那份，
 *   让它落地之后被后续的写盘纠正（见 `store.ts` 模块头「仍然可能丢的情形」）。
 */
export function discardPendingWrite(coord: WriteCoordinator): boolean {
  // 本来就没有待写内容：算成功（"没有挂起的写盘"正是调用方要的结果）
  if (!coord.dirty) return true;
  const writing = coord.begin();
  if (writing === null) return false;
  coord.commit(writing);
  return true;
}

/**
 * 合并写完之后，该不该把合并结果采纳进本地。
 *
 * @param localAtMerge 算合并那一刻的本地值（`planWrite` 的 `localAtMerge`）
 * @param localNow 写盘落地之后的本地值
 *
 * 用**引用比较**：`update()` 每次都会产出一个新对象（`[...prev]` / `prev.map`），
 * 所以"引用没变"就等于"读盘 + 写盘这段时间里用户一个字都没敲"。
 *
 * 为什么必须挡这一下：合并结果是**基于**`localAtMerge` 算出来的。如果这期间
 * 用户又敲了字，那几个字不在合并结果里 —— 直接采纳等于把它们删掉。
 * 不采纳时也不能就当没发生过：调用方要保留 `base` 与 `externalSeen`，
 * 让下一次写盘再合并一次（见 `flush` 里的说明），最终两边会收敛。
 */
export function shouldAdoptMerge<T>(localAtMerge: T, localNow: T): boolean {
  return localNow === localAtMerge;
}

/** 读盘回来之后该怎么做。 */
export type ReloadDecision =
  /** 采纳磁盘上那一份。 */
  | "adopt"
  /** 读盘期间我们自己的写盘落地了 —— 读到的可能比磁盘还旧，重读一次。 */
  | "retry"
  /** 读盘期间真的敲了字 —— 不能采纳（会删掉刚敲的），留给下一次写盘之后再读。 */
  | "defer";

/**
 * 读盘回来之后，这次读到的值该不该采纳。
 *
 * 抽成纯函数是因为三种情况的判据**互相很像、错一种就静默丢数据**：
 *
 * | 读盘期间发生了什么 | 判据 | 结论 |
 * |---|---|---|
 * | 用户真的敲了字 | `coord.revision` 变了 | `defer`（读到的值里没有那几个字） |
 * | 我们自己的写盘落地了 | `writeGen` 变了 | `retry`（读到的可能比磁盘还旧） |
 * | 什么都没发生 | 两个都没变 | `adopt` |
 *
 * ⚠️ 第一行**不能**用 `dirty` 布尔来判断：读盘期间那次改动若已经落盘，`dirty`
 * 会变回假，于是"期间真的改过"这件事被掩盖掉，读到的旧值就会盖掉用户刚敲的字
 * （而且因为 `dirty` 是假的，不会再补写一次）。版本号只增不减，掩盖不了。
 */
export function decideReload(args: {
  /** 发 `readData` **之前**记下的本地改动版本号。 */
  revisionAtRead: number;
  /** 读回来之后本地改动版本号。 */
  revisionNow: number;
  /** 发 `readData` 之前记下的写盘成功次数。 */
  writeGenAtRead: number;
  /** 读回来之后的写盘成功次数。 */
  writeGenNow: number;
}): ReloadDecision {
  if (args.revisionNow !== args.revisionAtRead) return "defer";
  if (args.writeGenNow !== args.writeGenAtRead) return "retry";
  return "adopt";
}

// ===============================================================
// 关窗口之前把挂起的写盘催一遍
// ===============================================================

/**
 * 已挂载的 `usePersistentState` 的「立即落盘」回调。
 *
 * # 为什么需要它
 *
 * 兜底落盘原来挂在 `beforeunload` / `visibilitychange` / 组件卸载上。
 * 但**销毁窗口**（`close_panel` → `destroy()`）不一定跑得到那三个钩子 ——
 * 用户在面板里刚敲完字（400ms 防抖还没到点）就点 ✕，**最后几个字就没了，
 * 而且一句话都不说**。
 *
 * 所以关窗口之前主动催一次。用登记表而不是让 `PanelWindow` 去 `import`
 * 某个具体数据文件：面板外壳不该知道有几个数据文件、分别叫什么。
 */
const flushers = new Set<() => Promise<boolean>>();

/**
 * 登记一个「立即落盘」回调，返回注销函数。
 *
 * `usePersistentState` 在挂载时登记、卸载时注销 —— 注销一定要做，
 * 否则面板被销毁后登记表里会留着指向已卸载组件的回调（内存泄漏）。
 */
export function registerFlush(fn: () => Promise<boolean>): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

/**
 * 把所有已挂载的数据都催一次落盘。
 *
 * 它**只是把已经挂起的写盘跑完**：每个 `flush()` 自己会判断"有没有待写内容"，
 * 没有就立刻返回成功。所以它不会平白多读一次盘、也不会写多余的东西。
 * `flush()` 自己的契约没变（仍然如实回答"存上了没有"）。
 *
 * @param timeoutMs 最多等多久，默认 {@link FLUSH_ALL_TIMEOUT_MS}。**到点就放行**
 *   （返回 `false`），不让调用方无限期卡住。
 * @returns 是不是全都存下来了。超时也算 `false`。
 *   ⚠️ 调用方**不该**因为它是 `false` 就不关窗口 / 不导入 ——
 *   关不掉比丢几个字更烦人；但**必须让用户看见**，不能静默放行
 *   （见 `PanelWindow` 的 `closeOrHide` 与 `settings` 的导入流程）。
 */
export async function flushAll(
  timeoutMs: number = FLUSH_ALL_TIMEOUT_MS,
): Promise<boolean> {
  const all = Promise.all(
    [...flushers].map((flush) =>
      // 单个失败不该拖垮其余的：一个面板的磁盘错误不该让另一个面板的数据也不落盘
      flush().catch(() => false),
    ),
  ).then((results) => results.every(Boolean));

  // 超时**不取消**那次写盘（它可能只是慢，硬砍会留下一个写到一半的文件），
  // 只是不再等它 —— 放行给调用方，由调用方把"有东西没落盘"告诉用户。
  //
  // 这里用**全局的** `setTimeout` / `clearTimeout` 而不是这个文件别处的
  // `window.setTimeout`：这个函数会被单测直接调用，而测试跑在 node 环境
  // （没有 `window`）。`ReturnType<typeof setTimeout>` 在浏览器里是 `number`、
  // 在 node 里是 `Timeout`，两边都对，不需要任何断言。
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([all, timeout]);
  } finally {
    // 别留一个空转的定时器（写盘先回来时它还在跑）
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 把一份数据绑定到磁盘上的一个 JSON 文件。
 *
 * @param file 数据文件名，例如 `snippets.json`
 * @param initial 文件不存在时使用的初始值
 * @param isShapeValid 可选的形状校验。返回 `false` 时**不采纳**磁盘上的值，
 *   而是保持 `initial` 并给一条明确的错误。见下面加载那段的说明。
 * @returns 当前数据、更新函数、是否仍在首次加载
 */
export function usePersistentState<T>(
  file: string,
  initial: T,
  isShapeValid?: (value: unknown) => boolean,
) {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 最新的值，供 flush 使用，避免闭包捕获旧值。 */
  const latest = useRef<T>(initial);
  /**
   * 上一次「本地与磁盘一致」时的那一份 —— 三方合并的**共同祖先**。
   *
   * ⚠️ 它的含义不是"磁盘上现在是什么"，而是"本地这一份是从哪儿派生出来的"。
   * 两者在"合并写完但没采纳"的那一刻会不一样（本地仍是旧 base 派生出来的），
   * 那时**必须**保持旧 base —— 否则下一次合并会把远端新增误判成"本地删掉了它"
   * 而丢掉。`flush` 里那段有完整说明。
   *
   * 更新时机只有三处：首次读盘采纳、`reload` 采纳、写盘成功且**采纳了**结果。
   */
  const base = useRef<T>(initial);
  /** 写盘版本协调：解决"写盘飞行期间的新改动被误清"（见 write-coordinator.ts）。 */
  const coord = useRef(new WriteCoordinator());
  /** 本地是否发生过改动。回读磁盘时用它判断"能不能拿磁盘盖掉本地"。 */
  const touched = useRef(false);
  /** 连续写失败次数：给重试做退避，并设个上限（磁盘真写不了时不能一直撞）。 */
  const failures = useRef(0);
  const timer = useRef<number | null>(null);
  /**
   * 写盘成功过多少次。用来判断"读盘期间我们自己的写盘落地了没有"。
   *
   * 为什么不能只看 `coord.dirty`：读盘是**异步**的，可能在写盘之前发出、却在写盘
   * 之后才回来 —— 那时 `dirty` 已经变回假，可这次读到的内容比磁盘**还旧**。
   * 采纳它会让用户刚敲的字从界面上消失，而且因为 `dirty` 是假的，不会再补写一次，
   * 用户再编辑时还会以那份旧内容为基准，把刚写下去的改动覆盖掉。
   * 所以 `reload` 里要拿这个计数器比一次（见那里的说明）。
   */
  const writeGen = useRef(0);
  /**
   * 收到过「别处改了这个文件」的广播（**不是自己发的**）。
   *
   * 它决定写盘走快路径还是慢路径：置真之后，下一次写盘要先读盘、按 id 合并再写
   * （见 `planWrite`）。写盘成功后清掉 —— 那时内存与磁盘已经重新一致。
   */
  const externalSeen = useRef(false);
  /**
   * 收到过「别处改了这个文件、但本地有未落盘的改动」的广播。
   *
   * 置上之后不立刻重拉，而是等本地这次写盘落地（`flush` 里检查）。
   * 见 {@link decideExternalChange} 里 `defer` 那一段的说明。
   */
  const reloadPending = useRef(false);
  /**
   * 形状校验函数放 ref 里，**不进加载 effect 的依赖**。
   *
   * 调用方多半写成内联箭头函数（`(v) => Array.isArray(v)`），每次渲染都是新的；
   * 进依赖的话加载 effect 会每渲染一次就重跑一次，等于不停地重读磁盘。
   */
  const shapeRef = useRef(isShapeValid);
  useEffect(() => {
    shapeRef.current = isShapeValid;
  });
  /**
   * 正在飞的那次写盘。
   *
   * `flush()` 要能**如实回答"存上了没有"**（片段编辑器靠它决定提示"已保存"
   * 还是"保存失败"），而"已经有写盘在飞"时 `begin()` 会返回 null ——
   * 那种情况下必须等这次飞行落地再回答，否则会撒一个"已保存"的谎。
   */
  const pending = useRef<Promise<boolean> | null>(null);

  /**
   * 重新读盘并**替换内存**。
   *
   * 调用时机：收到"别处改了"的广播且本地没有未落盘的改动；以及那个广播被推迟到
   * 本地落盘完成之后（见 `flush` 的成功分支）。
   *
   * # 判据是版本号，不是 `dirty` 布尔
   *
   * 读盘是异步的，而写盘也是。三种情况必须分开（见 {@link decideReload}）：
   *
   * - 读盘期间**真的敲了字**（`coord.revision` 变了）→ 不能采纳：读到的值里没有
   *   那几个字，采纳等于把它们删掉。判据**不能**用 `dirty` 布尔 —— 那次改动若
   *   在读盘期间落盘了，`dirty` 会变回假，于是"期间真的改过"这件事被掩盖掉。
   * - 读盘期间**我们自己的写盘**落地了（`writeGen` 变了）→ 读到的可能比磁盘还旧
   *   （读在写之前发出、写却先落地），**重读一次**。
   * - 都没有 → 采纳。
   *
   * 最多读两次；两次都在"写盘落地"上撞车（极小概率）就不采纳，只留一个"待重拉"。
   *
   * # 这里为什么**不**弹提示
   *
   * 采纳磁盘上的值会让"本地有、磁盘没有"的条目消失。听起来该提醒用户一句，
   * 但把所有能走到这里的路径列一遍就会发现：`reload` 只在**本地没有未落盘改动**
   * 时才会被调用（`decideExternalChange` 的 `reload` 分支要求 `!dirty`，
   * 另一处是 `flush` 成功之后）。也就是说我们手里那份和磁盘是一致的，
   * 磁盘少了的条目只可能是**别的窗口删掉的** —— 那是同步在正常工作。
   * 每删一条就在另一个窗口弹一句"有东西没了"，那是噪音，不是帮助。
   *
   * 真正会**静默丢掉用户自己东西**的地方是导入备份（本地没落盘的改动被覆盖），
   * 提示加在那里，见 `yieldToReplacedFile`。
   */
  const reload = useCallback(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revisionAtRead = coord.current.revision;
      const writeGenAtRead = writeGen.current;

      try {
        const loaded = await api.readData<T>(file);
        if (loaded === null || loaded === undefined) return;

        const decision = decideReload({
          revisionAtRead,
          revisionNow: coord.current.revision,
          writeGenAtRead,
          writeGenNow: writeGen.current,
        });
        if (decision === "defer") {
          // 读盘期间真的敲了字：这次不采纳，等这次改动落盘之后（见 `flush`）再读
          reloadPending.current = true;
          return;
        }
        if (decision === "retry") continue;

        if (shapeRef.current && !shapeRef.current(loaded)) {
          setError(
            `${file} 被改成了软件不认识的形状（多半是被手改过）。` +
              `当前显示的是内存里那份，磁盘上的文件没有被改动 —— 改回来即可。`,
          );
          return;
        }

        // 采纳磁盘上的值：内存与磁盘重新一致，本地也就"没改过"了
        touched.current = false;
        latest.current = loaded;
        base.current = loaded;
        reloadPending.current = false;
        /**
         * 采纳之后内存与磁盘一致，**之后的写盘不必再合并**。
         *
         * 这一行原来漏了：干净窗口收到广播 → `reload` 采纳 → `externalSeen`
         * 还留着真 → 之后每一次写盘都白读一次盘（不是数据问题，是白干活）。
         */
        externalSeen.current = false;
        setValue(loaded);
        setError(null);
        return;
      } catch (err) {
        setError(String(err));
        return;
      }
    }

    // 两次都撞上"读盘期间写盘落地"：这次不采纳，留给下一次写盘之后再读
    reloadPending.current = true;
  }, [file]);

  /**
   * 导入备份之后：**本地彻底让位**。
   *
   * 用户刚在确认框上点了「覆盖导入，无法撤销」，所以这里不是"标记一下待重拉"，
   * 而是**取消本地这次写**、把内存与合并基底都换成导入后的那一份。
   *
   * 为什么必须做到这个程度（而不是沿用 `reload`）：
   * `force` 广播到达时本地可能正挂着一次没落盘的写盘。放着不管的话，它会带着
   * **导入前的旧条目**去写盘 —— 加了合并之后更糟：它会拿"本地旧改动"去合并
   * "导入后的新数据"，于是**旧条目被合并回来**，用户看到自己刚清掉的东西又冒出来。
   */
  const yieldToReplacedFile = useCallback(async () => {
    /**
     * 这个窗口里有没有"还没存到磁盘"的改动。
     *
     * 要在清掉之前问，清完就问不出来了。它决定下面要不要给用户一句提示 ——
     * 那些改动连磁盘都没到过，会被导入的数据直接盖掉，**不能静默**。
     */
    const hadPendingChanges = coord.current.dirty;

    // 1. 取消挂起的写盘。定时器清了，还要把"有未落盘改动"这个标记清掉 ——
    //    只清定时器是不够的：`dirty` 仍为真，下一次 `flush()` 照样会把旧数据写出去。
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    discardPendingWrite(coord.current);

    // 2. 把导入后的那一份读回来，同时替换内存与合并基底
    try {
      const loaded = await api.readData<T>(file);
      if (loaded === null || loaded === undefined) {
        // 读不回来 → 内存里还是导入前那份，而用户以为导入成功了。必须说一句
        setError("导入后的数据没能读回来，本窗口显示的仍是导入前的内容 —— 请重开这个窗口。");
        return;
      }
      if (shapeRef.current && !shapeRef.current(loaded)) {
        setError("导入后的数据形状不对（文件可能被改过），本窗口显示的仍是导入前的内容。");
        return;
      }

      /**
       * ⚠️ 这两个标记要等**读回成功之后**才清。
       *
       * 读回失败就提前 return 的话，如果先把 `externalSeen` 清成 false，
       * 下一次写盘会走**快路径**、把内存里那份（导入前的）整份写出去 ——
       * 把刚导入的文件盖回旧值，**导入静默失效**。
       * 保持 `true` 时下一次写盘会走"读-合并-写"，导入的那份才保得住。
       * `reloadPending` 同理：留着它，下一次写盘成功之后还会再拉一次盘。
       */
      externalSeen.current = false;
      reloadPending.current = false;

      touched.current = false;
      latest.current = loaded;
      base.current = loaded;
      setValue(loaded);
      /**
       * 给用户一句提示，**不能静默**。
       *
       * 这是整个数据层里唯一一处"用户自己没存下的东西被丢掉"的地方：
       * 导入是**另一个窗口**发起的，而这个窗口里可能正敲着字。用户点确认框时
       * 想的是"覆盖磁盘上的数据"，未必想到"另一个面板里没保存的编辑也会没"。
       *
       * 没有未落盘改动时不提示：那时候被换掉的只是磁盘上的旧内容，
       * 而那正是用户刚刚明确要求覆盖的东西。
       */
      setError(
        hadPendingChanges
          ? "另一个面板导入了备份，本窗口里还没存下的改动已被覆盖（导入时确认过「覆盖全部数据」）"
          : null,
      );
    } catch (err) {
      setError(String(err));
    }
  }, [file]);

  /**
   * 立即把当前值写入磁盘。
   *
   * @returns **是否确实写成功了**。没有待写内容算成功；写失败算失败。
   *   调用方（例如"保存"按钮）必须等这个结果再告诉用户"已保存" ——
   *   原来它返回 void，于是界面只能无条件说成功。
   */
  const flush = useCallback(async (): Promise<boolean> => {
    // 已经有一次在飞：先等它落地。落地后如果还有新改动，下面会再写一次。
    const flying = pending.current;
    if (flying) {
      await flying;
      if (!coord.current.dirty) return true;
    }

    const writing = coord.current.begin();
    if (writing === null) {
      // 走到这里只有一种可能：`dirty` 为假（在飞的情况上面已经等过了）。
      // 也就是说磁盘上已经是最新的，算成功。
      //
      // 注意这里**不能**顺手把定时器清掉：清了之后，万一在飞的那次写失败
      // （它只调 fail()、不 commit），就再没有任何东西安排下一次写盘了 ——
      // 用户若就此不再改动并退出，最后一次编辑会永久丢失。
      return !coord.current.dirty;
    }

    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }

    const task = (async (): Promise<boolean> => {
      try {
        /**
         * 这一次写到磁盘上的内容。
         *
         * - 快路径（`externalSeen` 为假）：`plan` 的 `value` 就是 `latest.current`
         *   **本身**（同一个引用），一次盘都不多读 —— 与这一轮之前的
         *   `writeData(file, latest.current)` 逐字节等价。
         * - 慢路径（收到过别处的改动）：先读盘、按 id 三方合并，写合并结果。
         *
         * 之所以要存进局部变量，是因为写完盘之后要把它记成 `base`（"磁盘上现在
         * 是这一份"），而 `await` 期间 `latest` 可能已经被用户的下一次输入改掉了。
         */
        const plan = await planWrite<T>({
          file,
          base: base.current,
          local: latest.current,
          externalSeen: externalSeen.current,
          read: (name) => api.readData<T>(name),
          isShapeValid: shapeRef.current,
        });
        const toWrite = plan.value;

        await api.writeData(file, toWrite);
        setError(null);
        failures.current = 0;
        writeGen.current += 1;
        // 广播给别的窗口：它们手里那份现在是陈旧的，得重新读盘。
        // 失败也不影响本地写盘的结果，所以不 await（`emit` 走一次 IPC 往返，
        // 让"已保存"的提示等它没有意义）。
        void emitDataChanged(file).catch(() => {});

        if (plan.localAtMerge !== null && !shouldAdoptMerge(plan.localAtMerge, latest.current)) {
          /**
           * 读盘 + 写盘期间用户又敲了字 → **不能**把合并结果塞进界面
           * （那几个字不在里面，塞进去等于把它们删掉）。
           *
           * 但也不能就此不管：
           * - `base` 保持不动 —— 它的含义是"本地这一份是从哪儿派生出来的"，
           *   本地没采纳合并结果，那 base 就还是原来那个共同祖先。更新成 `toWrite`
           *   的话，下一次合并会把**远端新增**误判成"本地删掉了它"而丢掉。
           * - `externalSeen` 必须**留着** —— 下一次写盘得再合并一次，否则会把
           *   一份不含远端改动的数据写出去，把它们整份盖掉。
           *
           * 下一次写盘由上面 `commit()` 返回真值时的补排负责（用户刚改过，
           * `dirty` 必然为真），所以一定会再来一次、最终收敛。
           */
          externalSeen.current = true;
        } else {
          base.current = toWrite;
          externalSeen.current = false;
          if (plan.localAtMerge !== null) {
            // 采纳合并结果：内存与磁盘重新一致（快路径不进来，所以单窗口
            // 场景下不会多出一次 setState）
            latest.current = toWrite;
            setValue(toWrite);
          }
        }

        // 写盘期间用户又改了：必须立刻再写一次。
        // 旧实现这里是无条件 `dirty = false`，那一次改动就永远落不了盘 ——
        // 而且 beforeunload / 窗口隐藏的兜底落盘走的也是这个函数，同样会早退。
        if (coord.current.commit(writing)) {
          timer.current = window.setTimeout(() => {
            void flush();
          }, 0);
        } else if (reloadPending.current) {
          // 本地改动全部落盘了，内存与磁盘重新一致 —— 现在可以安全地把
          // 别处的改动拉回来。留在 `defer` 状态不管的话，我们这份陈旧数据
          // 会在下一次 update 时把别处刚写的整份盖掉。
          //
          // 慢路径（上面刚读过盘、合并过）走到这里时会多读一次盘 —— 读回来的
          // 内容与刚写下去的一致，**冗余但无害**。刻意保留这条老路径：
          // 单窗口场景根本不进慢路径，而多窗口场景少一次 IPC 读也不值得
          // 为它加一个"这次到底合并过没有"的状态位。
          reloadPending.current = false;
          void reload();
        }
        return true;
      } catch (err) {
        // 写失败：解除"在飞"标记但不动版本号，于是 dirty 保持为真
        coord.current.fail();
        setError(String(err));

        // 而且必须**自己再排一次**：此刻 dirty 为真、却没有任何定时器在等
        // （`begin()` 早退那条路径已经把定时器清掉了）。只靠"下次 update 会排"
        // 是不够的 —— 用户可能就此不再改动，直接从托盘退出。
        // 加上限 + 递增间隔：磁盘真的写不了时不能每 400ms 撞一次。
        if (failures.current < 3) {
          failures.current += 1;
          timer.current = window.setTimeout(
            () => {
              void flush();
            },
            WRITE_DEBOUNCE_MS * failures.current,
          );
        }
        return false;
      }
    })();

    pending.current = task;
    try {
      return await task;
    } finally {
      // 只有队尾还是自己时才清，否则会把后来者的记录删掉
      if (pending.current === task) pending.current = null;
    }
  }, [file, reload]);

  /**
   * 把「立即落盘」登记到模块级的表里 —— 关窗口之前 / 导入备份之前（`flushAll`）要用。
   *
   * # 注销为什么放在"最后一次落盘落地之后"
   *
   * 卸载时（切页签、关窗口）组件会消失，但**它的写盘可能还在飞**。
   * 如果这时候立刻把回调从表里摘掉，`flushAll()` 就看不到这次写 ——
   * 于是"导入备份之前先把本窗口的写盘催完"会漏掉它，那次写盘随后落地，
   * 把刚导入的文件盖回旧值（导入静默失效）。
   *
   * 所以：先催一次落盘，**等它落地再注销**。落地之后这次写已经不影响任何人了。
   * `flush()` 自己会判断"有没有待写内容"，没有就立刻返回，不会平白多写一次。
   */
  useEffect(() => {
    const off = registerFlush(flush);
    return () => {
      void flush().finally(off);
    };
  }, [flush]);

  // 首次加载：从磁盘读，读不到就用 initial
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await api.readData<T>(file);
        if (cancelled) return;
        if (loaded !== null && loaded !== undefined && !touched.current) {
          /**
           * ⚠️ 形状校验不能省。
           *
           * `read_data` 返回的是 `serde_json::Value`，**只保证是合法 JSON，
           * 不保证是我们要的形状**；`api.readData<T>` 是纯类型断言，
           * 运行期零校验。而这个文件是纯文本、用户能手改 ——
           * 把它写成 `{"a":1}`（或者 `"[]"` 这种字符串），
           * 消费方一句 `snippets.filter(...)` 就在**渲染期**抛异常。
           *
           * 渲染期异常会把整棵 React 树掀掉（`main.tsx` 的 ErrorBoundary 兜着），
           * 而面板窗口是 `prevent_close` + `hide`、**组件不会卸载** ——
           * 于是用户看到的是 420×640 的一片空白，关掉面板再打开还是白的，
           * 只有杀掉进程才能恢复。
           *
           * 所以这里宁可不采纳：保持空数据 + 一条说明，界面还能用，
           * 用户也能看懂发生了什么（磁盘上的文件一个字节都没动）。
           */
          if (shapeRef.current && !shapeRef.current(loaded)) {
            setError(
              `${file} 的内容不是软件认识的形状（多半是被手改过）。` +
                `当前显示为空，磁盘上的文件没有被改动 —— 改回来或把它改名再重启即可。`,
            );
            return;
          }
          setValue(loaded);
          latest.current = loaded;
          // 首次读盘采纳的那一份就是"共同祖先"：从这里开始，本地与磁盘分岔
          base.current = loaded;
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  /**
   * 订阅「别处改了这个文件」。
   *
   * 多窗口之后这是**必需**的：`snippets.json` 是整份覆盖写的，两个窗口各持一份
   * 内存副本，谁后写谁赢 —— 另一个窗口刚存下的东西会**无声消失**。
   * 收不到广播（例如脱离 Tauri 跑）时只影响跨窗口同步，本地功能照常。
   */
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void listen<DataChangedPayload>(DATA_CHANGED_EVENT, (e) => {
      if (disposed) return;
      const decision = decideExternalChange(
        e.payload,
        file,
        coord.current.dirty,
        currentPanelLabel(),
      );
      if (decision === "ignore") return;

      // 用户明确要求覆盖（导入备份）：本地彻底让位，**不是**"标记一下待重拉"。
      // 见 `yieldToReplacedFile` 的说明 —— 挂着的写盘必须取消，否则它会带着
      // 导入前的旧条目去合并导入后的新数据，把用户刚清掉的东西合并回来。
      if (e.payload?.force) {
        void yieldToReplacedFile();
        return;
      }

      // 别处动过这个文件 → 下一次写盘要先读-合并-写（见 `planWrite`）
      externalSeen.current = true;

      if (decision === "reload") void reload();
      else reloadPending.current = true;
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* 订阅不上只影响跨窗口同步，不该影响界面 */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [file, reload, yieldToReplacedFile]);

  /** 更新数据并安排一次防抖写入。 */
  const update = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next =
          typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
        latest.current = next;
        touched.current = true;
        coord.current.markDirty();

        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          void flush();
        }, WRITE_DEBOUNCE_MS);

        return next;
      });
    },
    [flush],
  );

  // 窗口关闭/隐藏前强制落盘，避免防抖窗口内退出导致丢数据
  useEffect(() => {
    const onHide = () => {
      void flush();
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
      // 组件卸载（例如面板被销毁）时也要落盘
      void flush();
    };
  }, [flush]);

  return { value, update, loading, error, flush };
}

/** 生成一个足够唯一的 id。不引入 uuid 依赖，因为本地单机场景时间戳+随机数已足够。 */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
