/**
 * 图片附件的纯逻辑：尺寸换算、孤儿判定、导入结果汇总、体积文案。
 *
 * # 为什么单独抽出来
 *
 * 这几件事**错了都不报错**，只是表现成"偶尔有点怪"：
 * - 缩略图算大了 → 数据目录悄悄涨，用户过半年才发现备份文件几百兆；
 * - 孤儿判定错了 → 要么删掉别人还在用的图（界面上一片裂图），
 *   要么一张都不删（磁盘只涨不落）；
 * - 导入结果汇总错了 → 拖进去三张图只提示一张，用户以为丢了。
 *
 * 而它们全都是纯计算，抽出来就能用固定数据钉死。
 *
 * # 为什么不 import `api.ts` 的 `MediaRef`
 *
 * 这里只声明"真的会读到的那个字段"（`id`）。传完整的 `MediaRef` 也能用
 * （TS 是结构化类型），但 `lib` 里的纯逻辑不该被 IPC 层的类型绑住 ——
 * 与 `search.ts`、`focus-highlight.ts` 是同一条约定。
 */

/**
 * 缩略图最长边的上限（像素）。
 *
 * 320 是按**显示位置**定的，不是按图片定的：编辑器里缩略图格子最宽约 90px
 * （420px 面板四列），就算以后改成两列也只有 ~190px。320 留了 1.7 倍余量，
 * 高 DPI 屏上不糊，同时把一张 4K 截图的缩略图压到约 30 KB 量级。
 *
 * 更大的代价是具体的：缩略图是**跟着原图一起进备份文件**的（base64 还要再涨 33%），
 * 512 提到 1024 会让每张图的缩略图体积涨 4 倍。
 */
export const MAX_THUMB_EDGE = 320;

/**
 * 单张图片的体积上限，**必须与 Rust 侧 `media::MAX_IMAGE_BYTES` 一致**。
 *
 * 这里留一份只为了在选文件之前就给出提示（省一次 IPC 往返），
 * 真正的把关在 Rust 侧 —— 前端这道拦不住手改过的东西。
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 媒体目录"该提醒用户了"的阈值。
 *
 * 512 MB 是产品决定：这个量级的 `media/` 目录已经会让
 * 「导出备份」明显变慢（备份里图片是 base64，还要再涨三分之一），
 * 而用户没有别的地方能感知它涨到多大了。
 */
export const LARGE_LIBRARY_BYTES = 512 * 1024 * 1024;

/** 选文件对话框用的扩展名列表。**必须与 Rust 侧 `media::kind_from_ext` 一致**。 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp"] as const;

export interface Size {
  width: number;
  height: number;
}

export interface ThumbSize extends Size {
  /** 缩放比例。1 表示没缩放（小图不放大）。 */
  scale: number;
}

/** 这里只用到 id。 */
export interface ImageRefLike {
  id: string;
}

/** 一个"能带图片"的条目（片段 / 备忘都满足）。 */
export interface WithImages {
  id: string;
  /** 老数据没有这个字段，一律按空处理。 */
  images?: readonly ImageRefLike[] | null;
}

// ===============================================================
// 尺寸
// ===============================================================

/**
 * 算缩略图该多大。
 *
 * 规则：
 * - 最长边缩到 `maxEdge`，另一边按比例，**至少 1px**；
 * - **不放大**：比 `maxEdge` 还小的图按原尺寸存。放大只会让缩略图更占地方、
 *   而且更糊（canvas 插值放大不出细节）；
 * - 尺寸量不出来（0 / 负数 / NaN）时给 `1×1`。这不是随便兜的：
 *   `canvas` 宽或高为 0 时 `toDataURL()` 返回 `"data:,"`，
 *   Rust 侧会报「缩略图是空的」—— 用户看到的原因会是"缩略图是空的"，
 *   而真实原因是"这张图打不开"，查起来完全对不上。
 */
export function thumbnailSize(
  width: number,
  height: number,
  maxEdge: number = MAX_THUMB_EDGE,
): ThumbSize {
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 1, height: 1, scale: 1 };
  }

  const longest = Math.max(w, h);
  // 边界：`maxEdge` 被传成 0 或负数时不能除出 Infinity
  const limit = Number.isFinite(maxEdge) && maxEdge > 0 ? Math.floor(maxEdge) : MAX_THUMB_EDGE;
  if (longest <= limit) return { width: w, height: h, scale: 1 };

  const scale = limit / longest;
  return {
    // `max(1, ...)` 是必要的：一条 1×10000 的长图按比例算出来的宽是 0.032 → round 成 0
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

// ===============================================================
// 引用与孤儿
// ===============================================================

/** 一个条目引用到的图片 id（跳过残缺项）。 */
function idsOf(item: WithImages | undefined | null): string[] {
  const list = item?.images;
  if (!list) return [];
  const out: string[] = [];
  for (const image of list) {
    if (image?.id) out.push(image.id);
  }
  return out;
}

/**
 * 全部条目引用到的图片 id。
 *
 * 这是"这张图还有没有别人在用"的**唯一依据**：导入按内容 sha256 去重，
 * 同一张图被两条片段引用是完全正常的，此时删掉其中一条**不能**删磁盘文件。
 */
export function referencedImageIds(items: readonly WithImages[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    for (const id of idsOf(item)) out.add(id);
  }
  return out;
}

/**
 * 除 `excludeItemId` 之外，别的条目引用到的图片 id。
 *
 * 用来提示「这张图别处也在用」—— 它解释了"为什么删了它磁盘占用没降"。
 */
export function referencedImageIdsExcluding(
  items: readonly WithImages[],
  excludeItemId: string,
): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (item.id === excludeItemId) continue;
    for (const id of idsOf(item)) out.add(id);
  }
  return out;
}

/**
 * 从 `fromItemId` 里移除 `removedIds` 之后，哪些图片**已经没有任何条目引用**了。
 *
 * 只有这些才能删磁盘文件。判定必须看**全部条目**，只看当前这一条会把
 * 别的条目还在用的图删掉 —— 那种表现是"另一条里的图突然变成裂图"，
 * 而且用户根本不会把它和"我刚才删了另一条里的图"联系起来。
 *
 * 传进来的 `items` 应当是**移除之后**的列表，或者包含 `fromItemId`
 * 且 `removedIds` 里的 id 仍在它的 `images` 里 —— 两种都能算对：
 * 前者靠"它已经不引用了"，后者靠下面的 `isSource` 显式排除。
 */
export function orphanedImageIds(
  items: readonly WithImages[],
  fromItemId: string,
  removedIds: readonly string[],
): string[] {
  const removing = new Set(removedIds.filter(Boolean));
  if (removing.size === 0) return [];

  const stillReferenced = new Set<string>();
  for (const item of items) {
    const isSource = item.id === fromItemId;
    for (const id of idsOf(item)) {
      // 来源条目里**正在被移除**的那些不算"还有人引用"
      if (isSource && removing.has(id)) continue;
      stillReferenced.add(id);
    }
  }

  return [...removing].filter((id) => !stillReferenced.has(id));
}

/**
 * 删掉整个条目之后，哪些图片该跟着删。
 *
 * 条目不在列表里时返回空数组：**宁可不删**（留下一个孤儿文件，用户看不出，
 * 以后可以在设置里清），也不要因为一次状态不同步就把别人的图删了。
 *
 * ⚠️ 它只回答"**看起来**没人引用了"，不回答"敢不敢删" ——
 * 后者是 {@link planMediaDeletion} 的事，两者必须一起用。
 */
export function orphanedByItemRemoval(
  items: readonly WithImages[],
  removedItemId: string,
): string[] {
  const item = items.find((x) => x.id === removedItemId);
  if (!item) return [];
  return orphanedImageIds(items, removedItemId, idsOf(item));
}

// ===============================================================
// 删盘的安全阀（RV4 的 F4）
// ===============================================================

/**
 * 判断"敢不敢删媒体文件"时能拿到的证据。
 *
 * 两条都是**保守信号**：任一为真/未知，就不删。
 */
export interface MediaGcEvidence {
  /**
   * 当前开着几个面板窗口。`null` = **问不到**
   * （`list_panels` 调用失败、或脱离 Tauri 单独跑前端）。
   */
  panelCount: number | null;
  /**
   * 这次会话里观察到过**别的窗口**改了数据吗。
   *
   * 只认带发送者身份的广播（`fuguang:data-changed` 的 `from`）：
   * Rust 侧的 `state-changed` 不带发送者，自己保存也会收到，分不出是谁写的 ——
   * 拿它当"外部改动"会让本窗口保存一次之后就永远不敢删。
   */
  sawExternalChange: boolean;
}

/**
 * 不删盘的原因。`"none"` 表示**可以删**。
 *
 * 三个"不删"的原因对应三种给用户的话（见 {@link mediaGcHoldNotice}）。
 */
export type MediaGcHold =
  | "none"
  | "still-referenced"
  | "undoable"
  | "untrusted-memory";

/**
 * 现在能不能把这张图从磁盘删掉。
 *
 * # 为什么需要这道闸，而不是"算出孤儿就删"
 *
 * 孤儿判定看的是**本窗口内存里的引用集合**。而这是个多窗口应用，
 * 同一张图被两条条目引用是正常的（导入按内容 sha256 去重），
 * 而**别的窗口可能刚把这张图引用进它自己的条目、那个引用还没落盘** ——
 * 那种引用在本窗口的内存里根本看不见。
 * 于是"本窗口算出来没人引用"**不等于**"真的没人引用"。
 *
 * # 后果不对称，所以宁可漏删
 *
 * - **漏掉一个孤儿文件 = 可恢复**：它只是一直占着磁盘，用户以后还能清理；
 * - **删掉一个还在被引用的文件 = 不可恢复**：另一个窗口那条条目直接裂图，
 *   磁盘上那份已经没了，而且**没有任何提示**告诉他为什么。
 *
 * 两边的代价差一个量级，所以这里的默认是"**不确定就不删**"：
 * 只把引用从条目里去掉、文件留在盘上，并把原因告诉用户。
 *
 * @param evidence 两条保守信号，见 {@link MediaGcEvidence}
 */
function mayDeleteMediaFile(evidence: MediaGcEvidence): boolean {
  // 只认"**确实**只有一个面板窗口"这一种情况。其余全部不删：
  // - `null` = 问不到（不确定有没有别的窗口）；
  // - `0`    = 异常（至少应该有当前这一个窗口），异常值不当成"没有别人"；
  // - `> 1`  = 确实有别的窗口，它可能刚导入同一张图、引用还没落盘。
  if (evidence.panelCount !== 1) return false;
  // 见过别的窗口写数据 → 本窗口这份引用集合可能已经落后于盘 → 不删
  if (evidence.sawExternalChange) return false;
  return true;
}

/** 不删盘时给用户的解释。能删时返回 `null`。 */
function mediaGcHoldReason(evidence: MediaGcEvidence): string | null {
  if (evidence.panelCount === null || evidence.panelCount === 0) {
    return "不确定有没有别的窗口也在用这张图，文件先留着";
  }
  if (evidence.panelCount > 1) {
    return `还开着 ${evidence.panelCount} 个面板窗口，不确定别的窗口有没有引用它，文件先留着`;
  }
  if (evidence.sawExternalChange) {
    return "别的窗口刚改过数据，本窗口的引用可能不是最新的，文件先留着";
  }
  return null;
}

/**
 * **逐张**的判据。整个仓库里三个判据只存在于这一处。
 *
 * `planMediaDeletion` 是它唯一的调用者 —— 所以"两条路径共用同一套判据"这件事
 * 不是靠约定，而是结构上只有一份可共用。
 */
function gcHoldForOne(args: {
  /** 判"还有没有人引用"用的条目集合。 */
  items: readonly WithImages[];
  /**
   * 正在改动的那一条；**不传**表示传进来的 `items` 已经是"改完之后"的样子，
   * 不需要排除任何条目。
   *
   * 这个区别很重要：
   * - 图片/条目**正在**被改（数据还没落盘）→ 传 `fromItemId`，
   *   判据会把来源条目自己的引用排除掉，问的是"**别的**条目还在引用吗"；
   * - 调用方手里已经是**最终**数据（撤销后的快照、保存后重读的列表）→
   *   不传，问的是"**整份数据**里还有人引用吗"。
   */
  fromItemId?: string | null;
  imageId: string;
  /** 「撤销 / 取消」会还原回来的那些图片 id。 */
  undoIds: readonly string[];
  evidence: MediaGcEvidence;
}): MediaGcHold {
  const stillReferenced = args.fromItemId
    ? orphanedImageIds(args.items, args.fromItemId, [args.imageId]).length === 0
    : referencedImageIds(args.items).has(args.imageId);
  if (stillReferenced) return "still-referenced";
  if (args.undoIds.includes(args.imageId)) return "undoable";
  if (!mayDeleteMediaFile(args.evidence)) return "untrusted-memory";
  return "none";
}

/** 一批候选的删盘决策结果。 */
export interface MediaDeletionPlan {
  /** 真正可以从磁盘删掉的 id。 */
  deletable: string[];
  /**
   * 整批的说明。
   *
   * - `deletable` 非空时是 `"none"`（有东西真的删掉了，不需要解释）；
   * - 一张都删不了时是**第一个**拦住它们的理由，喂给
   *   {@link mediaDeletionNotice} 就能得到一句给用户看的话。
   */
  hold: MediaGcHold;
}

/**
 * **唯一**的删盘决策入口：这一批候选里，哪些可以从磁盘删掉。
 *
 * # 为什么三个判据要合成一个函数
 *
 * 它们各自都只回答一半的问题，**少用任何一个都会出真 bug**：
 * 1. `still-referenced`：别的条目还在引用（导入去重导致这很常见）——
 *    删了那边直接裂图；
 * 2. `undoable`：「撤销改动」会把这张图带回来 —— 删了之后用户一撤销，
 *    数据里的图回来了、文件没了，界面上是个"读不到"的格子；
 * 3. `untrusted-memory`：本窗口这份引用集合不能当权威（多窗口 / 见过外部改动 /
 *    问不到面板数）—— 删了可能命中别的窗口还没落盘的引用，**不可逆**。
 *
 * 分散在各个调用点写三遍的话，迟早有人只写前两条 —— 而那正是 RV4 报的那条
 * 不可逆问题。所以这里收成**一个**函数，四个调用点（图片单独移除、删整条条目、
 * 撤销/取消后的残留清理）都只判 `deletable` 里有没有它。
 *
 * # 候选集是调用方给的，但判据**由这里再验一遍**
 *
 * 调用方（例如 `orphanedByItemRemoval`）也会先筛一遍候选，那个筛选与本函数
 * 第一层判据其实出自同一个底层函数，所以两者不可能给出矛盾的答案。
 * 重复一次是**刻意的**：候选集是调用方算的，判据必须由决策函数再验一遍 ——
 * 否则调用方少算一步（比如忘了排除自己那一条）就没人兜底了。
 *
 * @param candidateIds 看起来没人引用的那些 id
 * @param undoIds 「撤销 / 取消」会还原回来的 id（删条目那条路传空数组）
 */
export function planMediaDeletion(args: {
  items: readonly WithImages[];
  /** 见 {@link gcHoldForOne} 的 `fromItemId`。 */
  fromItemId?: string | null;
  candidateIds: readonly string[];
  undoIds?: readonly string[];
  evidence: MediaGcEvidence;
}): MediaDeletionPlan {
  const undoIds = args.undoIds ?? [];
  const deletable: string[] = [];
  let hold: MediaGcHold = "none";

  for (const imageId of args.candidateIds) {
    const verdict = gcHoldForOne({
      items: args.items,
      fromItemId: args.fromItemId,
      imageId,
      undoIds,
      evidence: args.evidence,
    });
    if (verdict === "none") deletable.push(imageId);
    else if (hold === "none") hold = verdict;
  }

  return { deletable, hold };
}

/**
 * 按计划把文件删掉。
 *
 * # 为什么删除循环也要收在这里
 *
 * 四个调用点原来各自写一遍 `Promise.all(ids.map((id) => api.mediaDelete(id).catch(...)))`
 * —— 那句 `catch` 的语义（**清理残留失败不抛、不报错**）被复制了四份，
 * 改一处漏三处。收在这里之后，调用点只判 `plan.deletable`。
 *
 * 失败**一律吞掉**：这些都是"清理残留"，报错会让用户以为刚才那步操作失败了。
 * 留下的孤儿文件看不见、不影响使用，比一个假的失败提示好得多。
 *
 * `deleteFile` 由调用方注入（传 `api.mediaDelete`），所以这个函数不 import
 * `api.ts`，也就能被单测直接钉住 —— 测试里注入一个假删除器，
 * 断言"闸拦住时**一次都没被调**"。
 */
export async function applyMediaDeletion(args: {
  plan: MediaDeletionPlan;
  deleteFile: (id: string) => Promise<void>;
}): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const id of args.plan.deletable) {
    try {
      await args.deleteFile(id);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

/**
 * 这一批删除之后该跟用户说什么。不需要解释时返回 `null`。
 *
 * - 有东西真的删掉了 → `null`（调用方自己会说"已删除"/"已撤销改动"，不必叠一句）；
 * - 一张都没删掉、而且有理由 → 那句理由；
 * - 候选本来就是空的 → `null`（没有"没删掉"这回事）。
 *
 * ⚠️ 静默留着文件是**不行**的：用户点了删除、文件却还在，他会以为功能坏了。
 * 所以有理由时必须说。
 */
export function mediaDeletionNotice(
  plan: MediaDeletionPlan,
  evidence: MediaGcEvidence,
): string | null {
  if (plan.deletable.length > 0) return null;
  if (plan.hold === "none") return null;
  return mediaGcHoldNotice(plan.hold, evidence);
}


/**
 * 不删盘时给用户的那句话。`"none"` 返回 `null`（可以删，没什么好说的）。
 *
 * `untrusted-memory` 尽量说出**具体**原因（几个窗口 / 见过外部改动），
 * 说不出来才退回笼统说法 —— "文件留着了"而不说为什么，用户会以为是 bug。
 *
 * 一般不用直接调它：调用方判"这一批有没有真的删掉"应该用
 * {@link mediaDeletionNotice}（它替调用点处理了"删成功了就不必解释"）。
 */
export function mediaGcHoldNotice(
  hold: MediaGcHold,
  evidence: MediaGcEvidence,
): string | null {
  switch (hold) {
    case "none":
      return null;
    case "still-referenced":
      return "已从这条里移除；这张图别处也在用，文件留着了";
    case "undoable":
      return "已从这条里移除（撤销改动能带回来，文件先留着）";
    case "untrusted-memory":
      return mediaGcHoldReason(evidence) ?? "已从这条里移除，文件先留着";
  }
}


// ===============================================================
// 导入结果
// ===============================================================

export interface ImportOk<T extends ImageRefLike = ImageRefLike> {
  ok: true;
  media: T;
}

export interface ImportErr {
  ok: false;
  /** 给用户看的原因（Rust 侧给的就是中文人话，直接用）。 */
  error: string;
}

export type ImportOutcome<T extends ImageRefLike = ImageRefLike> = ImportOk<T> | ImportErr;

export interface ImportSummary<T extends ImageRefLike = ImageRefLike> {
  /** 真正新增进条目的图片（已按 id 去重）。 */
  added: T[];
  /** 本来就已经在这个条目里的张数（跳过，不重复加）。 */
  alreadyInItem: number;
  /** `added` 里那些**别的条目也在引用**的张数。 */
  sharedElsewhere: number;
  /** 失败原因，逐条人话。 */
  failed: string[];
}

export interface ImportContext {
  /** 当前条目已有的图片 id。 */
  inItem: readonly string[];
  /** **别的条目**引用到的图片 id。 */
  elsewhere: ReadonlySet<string>;
}

/**
 * 把一串导入结果汇总成"该跟用户说什么"。
 *
 * # 为什么重复导入必须说一句
 *
 * Rust 侧按内容 sha256 去重，同一张图第二次导入**直接返回已有引用**，
 * 不报错也不提示。那是对的（省磁盘），但用户看到的是
 * 「我明明又拖了一次，怎么没反应」—— 不解释就等于坏了。
 *
 * # 为什么"别处也在用"也要说
 *
 * 它解释了"为什么删了这张图，磁盘占用没降"：去重意味着同一份文件可能被
 * 好几条引用，删掉其中一条不会释放空间。不说的话，用户会觉得删除功能有 bug。
 */
export function summarizeImport<T extends ImageRefLike>(
  outcomes: readonly ImportOutcome<T>[],
  ctx: ImportContext,
): ImportSummary<T> {
  const inItem = new Set(ctx.inItem);
  const summary: ImportSummary<T> = {
    added: [],
    alreadyInItem: 0,
    sharedElsewhere: 0,
    failed: [],
  };

  // 同一次导入里也可能撞车（用户一次选了两个副本），所以边加边记
  const seen = new Set(inItem);

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      summary.failed.push(outcome.error);
      continue;
    }
    const id = outcome.media?.id;
    if (!id) {
      summary.failed.push("导入返回了一个没有 id 的图片");
      continue;
    }
    if (seen.has(id)) {
      summary.alreadyInItem += 1;
      continue;
    }
    seen.add(id);
    summary.added.push(outcome.media);
    if (ctx.elsewhere.has(id)) summary.sharedElsewhere += 1;
  }

  return summary;
}

/**
 * 把汇总结果拼成一句**能在 420px 面板里读完**的提示。没有任何事发生时返回 `null`。
 *
 * `kind` 只区分"要不要按警告样式显示更久"：只要有失败就用 `warn`
 * （用户必须读完才知道哪张没进来），否则用 `ok`。
 */
export function importNotice<T extends ImageRefLike>(
  summary: ImportSummary<T>,
): { text: string; kind: "ok" | "warn" } | null {
  const parts: string[] = [];

  if (summary.added.length > 0) parts.push(`已加 ${summary.added.length} 张`);
  if (summary.alreadyInItem > 0) {
    parts.push(
      summary.alreadyInItem === 1
        ? "这张图已经在里面了"
        : `${summary.alreadyInItem} 张已经在里面了`,
    );
  }
  if (summary.sharedElsewhere > 0) parts.push(`其中 ${summary.sharedElsewhere} 张别处也在用`);

  if (summary.failed.length === 1) {
    parts.push(summary.failed[0]);
  } else if (summary.failed.length > 1) {
    // 面板窄，失败原因只报第一条 + 总数。Rust 侧给的原因本身就带文件名/大小，
    // 全部拼上会把提示条撑成三行
    parts.push(`${summary.failed.length} 张失败：${summary.failed[0]}`);
  }

  if (parts.length === 0) return null;
  return { text: parts.join("；"), kind: summary.failed.length > 0 ? "warn" : "ok" };
}

// ===============================================================
// 导入时的两条文案（RV4 的 F3 / F7）
// ===============================================================

/**
 * 并发导入时用的提示。
 *
 * # 为什么这条文案必须存在（RV4 的 F7）
 *
 * 导入是**异步**的（读盘 → 落盘 → 读回原图 → canvas 缩略图 → 回填），
 * 一次拖五张图要好几秒。这期间用户再拖一批、或再按一次「剪贴板」，
 * 会被 `busy` 短路挡掉。
 *
 * 原来短路返回的是**空批次**，而调用点看到"什么都没有"就说
 * 「剪贴板里没有图片」—— 可那时**剪贴板里可能真的有图**，
 * 用户会跑去检查剪贴板、然后怀疑这个功能坏了。
 *
 * 所以短路时要带一条**真实原因**的警告，让调用点没有机会说那句假话。
 * 常量放在这里（而不是 `media-ui.tsx`）是为了让它能被测试钉住。
 */
export const CONCURRENT_IMPORT_WARNING = "上一次导入还没完成，请稍等再试";

/**
 * 一批导入结果算不算"真的什么都没有"。
 *
 * 调用点用它决定要不要说兜底文案（例如"剪贴板里没有图片"）。
 *
 * ⚠️ **必须**用这个函数，不要自己写 `outcomes.length === 0`：
 * 并发导入时 `outcomes` 也是空的，但它带着一条 `warnings`
 * （见 {@link CONCURRENT_IMPORT_WARNING}）—— 那种情况下说
 * "剪贴板里没有图片"就是谎话。把判断收在一处，以后改短路逻辑也不会漏改某个调用点。
 */
export function isImportBatchEmpty(batch: {
  outcomes: readonly unknown[];
  warnings: readonly string[];
}): boolean {
  return batch.outcomes.length === 0 && batch.warnings.length === 0;
}

/**
 * 被前端按扩展名筛掉的路径，该怎么说。
 *
 * # 为什么不能一律说"不是图片文件"（RV4 的 F3）
 *
 * 用户把一整个**文件夹**拖进来时，路径没有扩展名 → 被归进 `skipped`，
 * 而"不是图片文件"会让他以为"这个功能不支持文件夹"，于是去怀疑自己拖的方式。
 * 所以按 `classify_paths` 的结果把文件夹单独说清楚。
 *
 * @param kinds `classify_paths` 的结果（与 `skipped` 一一对应）。
 *   `null` 表示那次调用失败 —— 这时退回笼统说法，**不猜**（猜错比笼统更糟）。
 */
export function skippedNotice(
  skipped: readonly string[],
  kinds: readonly string[] | null,
): string {
  const total = skipped.length;
  if (total === 0) return "";

  const folders = kinds ? kinds.filter((k) => k === "folder").length : 0;

  if (folders === 0) {
    return total === 1 ? "拖进来的不是图片文件" : `${total} 个不是图片文件`;
  }
  if (folders === total) {
    return total === 1
      ? "这是一个文件夹，请把里面的图片文件拖进来"
      : `拖进来的是 ${total} 个文件夹，请把里面的图片文件拖进来`;
  }
  return `${total} 个不是图片文件（其中 ${folders} 个是文件夹）`;
}

// ===============================================================
// 体积文案
// ===============================================================

/**
 * 人类可读的体积。
 *
 * 用 KB / MB / GB 而不是"千字节/兆"：这三个单位在中文界面上是通行写法，
 * 而"兆字节"读起来像技术文档。数字**最多一位小数**，整数时不带小数点
 * （`12 MB` 而不是 `12.0 MB`）—— 面板窄，能省一个字就省一个。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units: [number, string][] = [
    [1024 * 1024 * 1024, "GB"],
    [1024 * 1024, "MB"],
    [1024, "KB"],
  ];
  for (const [step, unit] of units) {
    if (bytes >= step) {
      const value = bytes / step;
      const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
      // "12.0" → "12"：整数不带小数点更干净
      return `${text.endsWith(".0") ? text.slice(0, -2) : text} ${unit}`;
    }
  }
  return `${Math.round(bytes)} B`;
}

/** 媒体库占用的一行说明。没有图片时说人话，而不是"0 张 · 0 B"。 */
export function statsNotice(stats: { count: number; bytes: number }): string {
  if (!Number.isFinite(stats.count) || stats.count <= 0) return "还没有图片";
  return `图片 ${stats.count} 张 · ${formatBytes(stats.bytes)}`;
}

/**
 * 媒体库已经很大时的提醒。没到阈值返回 `null`。
 *
 * 只在**导入成功之后**问一次（不要放在渲染里轮询 IPC），
 * 而且只在越过阈值时出现 —— 每次导入都弹一句"你的图片很多了"会被无视。
 */
export function largeLibraryNotice(
  bytes: number,
  limit: number = LARGE_LIBRARY_BYTES,
): string | null {
  if (!Number.isFinite(bytes) || bytes < limit) return null;
  return `图片已占用 ${formatBytes(bytes)}，继续加会让备份文件变得很大`;
}

// ===============================================================
// 与文本的边界
// ===============================================================

/**
 * 这个条目算不算"有内容"。
 *
 * # 为什么需要它
 *
 * 「笔记」页原来有一条规矩：**正文为空就不写**（不存空壳）。图片是独立字段，
 * 加了图片之后"正文为空"不再等于"这条是空的"—— 一条只有图的笔记是合法的，
 * 而原来那句 `if (!draft.content.trim()) return;` 会让它**悄悄存不下来**：
 * 用户贴了一张图、点「完成」，回来发现图没了。
 *
 * 所以判据从"正文非空"换成"正文非空**或**有图片"。同时**不能**把
 * "真的空"（没文字也没图片）也放行 —— 那会重新引入空壳条目。
 *
 * 空白字符按空处理（与 `.trim()` 一致）：一串空格不算内容。
 */
export function hasAnyContent(
  text: string,
  images: readonly ImageRefLike[] | null | undefined,
): boolean {
  if (text.trim().length > 0) return true;
  return (images?.length ?? 0) > 0;
}

// ===============================================================
// 拖放路径
// ===============================================================

/** 路径的最后一段扩展名（小写，不带点）。没有扩展名返回空串。 */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 把拖进来的路径分成"像图片的"和"其余"。
 *
 * # 为什么前端也要筛一遍
 *
 * Rust 侧两道判据（扩展名 + 文件头）才是把关的，这里筛只是为了**省一次 IPC**
 * 并给出更快的提示：用户把一整个文件夹拖进来时，几十个非图片文件逐个往返
 * 会让界面卡住一下，而它们的结局本来都是"被拒绝"。
 *
 * ⚠️ 这里只按扩展名，**不能**当成安全边界 —— 真正决定收不收的是 Rust。
 */
export function imagePathsOnly(paths: readonly string[]): {
  images: string[];
  skipped: string[];
} {
  const images: string[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    if ((IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(path))) images.push(path);
    else skipped.push(path);
  }
  return { images, skipped };
}

/**
 * 从 `data:image/png;base64,xxxx` 里取出 `xxxx`。
 *
 * # 为什么必须剥前缀
 *
 * Rust 侧 `media_set_meta` 收到的是**纯 base64**，它的解码器遇到
 * `data:image/png;base64,` 里的 `:` 和 `;` 会**直接报错**
 * （见 `media::base64_decode` 的说明：非法字符不静默跳过）。
 * 不剥前缀的话，每一张图导入后回填缩略图都会失败，而且错误信息是
 * 「base64 里有非法字符」—— 和"我传的是个 data URL"这件事看不出关系。
 *
 * 不是 base64 data URL 时返回 `null`（调用方据此跳过回填，不报错）。
 */
export function dataUrlPayload(dataUrl: string): string | null {
  const marker = ";base64,";
  const at = dataUrl.indexOf(marker);
  if (at < 0) return null;
  const payload = dataUrl.slice(at + marker.length);
  return payload.length > 0 ? payload : null;
}
