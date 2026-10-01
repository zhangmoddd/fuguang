/**
 * 把「已经弹过、且需要重复」的备忘推进到下一次提醒时刻。
 *
 * # 为什么这件事不能只放在备忘页里做
 *
 * 原实现把它写在 `features/memo/index.tsx` 的挂载逻辑里，而主面板**只挂载当前页签**
 * （`PanelWindow.tsx` 渲染的是 `<Active />`），默认页签又是「文本片段」
 * （`registry.ts` 的 `DEFAULT_FEATURE_ID`）。于是只要用户没打开过备忘页：
 *
 * 1. Rust 的调度线程到点弹窗，并把 `firedFor` 记成 `remindAt`；
 * 2. 没有任何代码把 `remindAt` 推到下一次；
 * 3. `scheduler.rs` 的幂等判断 `fired_for == Some(at)` 从此**永远成立**。
 *
 * 结果：这条重复提醒永久静默，重启也不恢复（启动默认页签仍然不是备忘），
 * 直到用户某次手动打开备忘页，才一次跳到下一个未来时刻，中间错过的全被吞掉。
 *
 * 根因是「推进数据」这件事被交给了一个 UI 组件的挂载时机。它是数据层的职责，
 * 所以抽到这里，由应用入口 `main.tsx` 在每个窗口都跑一遍 ——
 * 悬浮球窗口是常驻的，等于一直在跑。
 *
 * # 多窗口并发是安全的
 *
 * 两个窗口从同一个 `remindAt` 出发算出的「下一次」必然相同，写回去也是同一个值，
 * 所以不需要跨窗口互斥。真正需要防的是同一个窗口内重复推进，
 * 那由下面的 `advancing` 集合负责。
 */
import { api, type Memo } from "./api";
import { firstOccurrence, nextOccurrence } from "./datetime";

/** 本窗口正在推进的备忘 id，避免同一次事件把同一条推两遍。 */
const advancing = new Set<string>();

/** 推进的结果。 */
export interface AdvanceResult {
  /** 真正被推进成功的那些备忘，调用方可以据此**局部**更新自己的列表 */
  saved: Memo[];
  /**
   * 有几条推进**写盘失败**了。
   *
   * 调用方（尤其是不传 `onError` 的后台调用方）必须靠这个数字决定要不要重试 ——
   * 只把它报给 `onError` 是不够的，后台路径根本没有 `onError`。
   */
  failed: number;
}

/**
 * 推进所有「已弹过且需要重复」的备忘。
 *
 * 触发条件是 `firedFor === remindAt`，也就是 Rust 侧已经为当前这个 `remindAt`
 * 弹过窗了。此时把它推到下一次并把 `firedFor` 清空，下一次到点时条件会重新成立。
 *
 * `repeat === "none"` 的笔记**刻意不动**：它只提醒一次，
 * 保持 `firedFor` 等于 `remindAt` 反而是好事 —— Rust 侧的幂等判断
 * 会因此永远不会为它再弹第二次。
 *
 * @param list    当前的全量备忘
 * @param onError 可选的错误回调。备忘页会把它接到界面提示上；
 *                后台调用方（应用入口）不传，改看返回的 `failed`。
 * @returns 成功推进的那些，以及失败条数
 */
export async function advanceRepeats(
  list: Memo[],
  onError?: (message: string) => void,
): Promise<AdvanceResult> {
  const due = list.filter(
    (m) =>
      m.remindAt !== null &&
      m.firedFor !== null &&
      m.firedFor === m.remindAt &&
      m.repeat !== "none" &&
      !advancing.has(m.id),
  );
  if (due.length === 0) return { saved: [], failed: 0 };

  const saved: Memo[] = [];
  let failed = 0;
  for (const memo of due) {
    advancing.add(memo.id);
    try {
      // `due` 是 filter 出来的新数组，TS 不会把里面的收窄带过来，
      // 所以这里再取一次局部变量做判空。同时也兜住极端情况：
      // 万一 remindAt 是 null（数据被手动改过），没有「上一次」可推，跳过就好。
      const current = memo.remindAt;
      if (current === null) continue;

      const next = nextOccurrence(current, memo.repeat);
      // 上面的 filter 已经排掉了 repeat === "none"，正常走不到这里；
      // 这一步是让类型收窄，同时兜住数据被手动改成非法组合的情况。
      if (next === null) continue;

      // 再过一道 firstOccurrence：如果系统时钟被往前调过（或休眠很久后
      // 一次醒来），算出来的「下一次」可能仍然在过去，直接写回去会立刻再弹一次。
      const updated: Memo = {
        ...memo,
        remindAt: firstOccurrence(next, memo.repeat),
        firedFor: null,
        updatedAt: Date.now(),
      };
      await api.memoSave(updated);
      saved.push(updated);
    } catch (err) {
      // 计数 + 回调，两条路都要走：回调给界面，计数给后台调用方
      failed += 1;
      onError?.(String(err));
    } finally {
      advancing.delete(memo.id);
    }
  }

  return { saved, failed };
}

/**
 * 拉一次全量备忘并推进。**给后台调用方用**（应用入口）。
 *
 * # 为什么必须重试
 *
 * 失败要重试，不能"下次再说"。因为 Rust 侧的幂等标记 `firedFor` **已经落盘**了：
 * 这次推进要是没写成功，`fired_for == remind_at` 就永远成立，调度线程再也不会
 * 为这条备忘触发 —— 不会产生新的 `memos` 事件，也就没有"下一次"可言。
 * 结果是这条重复提醒**永久静默**，界面上没有任何提示，只有重启才可能恢复。
 *
 * ⚠️ 要注意**重试的是哪一种失败**：`advanceRepeats` 内部的写盘失败是被它自己
 * `catch` 掉的（它会**正常返回**），所以只靠外层 `try/catch` 是重试不到的 ——
 * 必须看返回的 `failed`。这个坑真踩过：加了重试却一次都不会触发。
 */
export async function advanceRepeatsOnce(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { failed } = await advanceRepeats(await api.memosList());
      if (failed === 0) return;
    } catch {
      /* 读盘失败，和写盘失败一样走下面的退避 */
    }
    // 失败都是瞬时的（磁盘忙、被杀软占用），退避重试几次基本都能成
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}
