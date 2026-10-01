/**
 * 闹钟的钟点换算与「每天重复」的推进。
 *
 * # 闹钟为什么不是"另一种倒计时"
 *
 * 倒计时设的是**多久之后**，闹钟设的是**几点**。到点之后的收尾两者完全一样
 * （Rust 侧共用一套），区别全在"下一次该在什么时候响"：
 *
 * - 倒计时：`now + durationMs`，纯算术，Rust 也能算；
 * - 闹钟：今天是这个钟点就今天，过了就明天 —— 这是**日历运算**，
 *   而且「明天同一时刻」不等于「加 86400000 毫秒」（夏令时那天只有 23 小时）。
 *
 * 所以按项目一贯的分工（见 `src-tauri/src/models.rs` 顶部）：前端算绝对时刻，
 * Rust 只负责到点弹窗。Rust 侧响完之后只标记 `fired`，由这里推进下一次。
 *
 * # 推进必须放在应用入口，不能放在计时页里
 *
 * 与备忘录的重复提醒完全同一个坑（见 `lib/repeat-advance.ts` 的详细说明）：
 * 主面板只挂载当前页签，默认页签不是计时页。推进要是挂在计时页的挂载逻辑上，
 * 用户不开计时页时推进永远不发生 —— Rust 侧的 `fired` 从此一直是 true，
 * 这个闹钟**永久静默**，重启也不恢复。
 *
 * 所以由 `main.tsx` 在每个窗口都跑一遍，小球窗口是常驻的，等于一直在跑。
 */
import { api, emitTimersChanged, type Timer } from "./api";
import { combineLocalSkippingGap, dateKey, firstOccurrence } from "./datetime";

/** 一天的分钟数。 */
const MINUTES_PER_DAY = 24 * 60;

/**
 * 把「从本地零点起的分钟数」格式化成 `HH:MM`。
 *
 * 先归一取模：数据文件是纯文本、用户可以手改，塞进 `99999` 或 `-90`
 * 都不该让界面显示出 `-1:-30` 这种没法看的东西。
 * `NaN` 也要兜 —— 它会一路传到 `padStart` 变成 `NaN:NaN`。
 */
export function formatClock(minutes: number): string {
  if (!Number.isFinite(minutes)) return "00:00";
  const total =
    ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 把 `HH:MM` 解析成「从本地零点起的分钟数」。
 *
 * 只认 `H:MM` 与 `HH:MM` 两种写法：`<input type="time">` 给的永远是后者，
 * 用户手打时前者很自然。其余形状（`7`、`0730`、`7:5`、`24:00`、`7:60`）
 * 一律返回 `null`，由调用方决定退回什么 —— 静默当成 0 点会让人设出一个
 * 自己都不知道的闹钟。
 */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 算出「下一次响铃」的绝对时刻：今天这个钟点还没到就是今天，已经过了就是明天。
 *
 * 两个细节都不能省：
 *
 * 1. 用 `combineLocalSkippingGap` 而不是 `combineLocal` —— 夏令时春季跳变那天
 *    那个钟点**根本不存在**，引擎会把它悄悄归一化成别的钟点。用户的闹钟钟点
 *    是规则，不该被改掉（详见 `datetime.ts`）。
 * 2. 用 `firstOccurrence(..., "daily")` 而不是手写 `+ 86400000` ——
 *    后者在夏令时那天会把钟点挪走一小时。它同时也保证了返回值**严格大于**
 *    `now`：等于 `now` 会让调度线程下一个 tick 立刻判定"到点"，
 *    变成弹窗风暴（`firstOccurrence` 的注释里记着这条不变量）。
 */
export function nextAlarmAt(minutes: number, now: number = Date.now()): number {
  const todayAt = combineLocalSkippingGap(dateKey(new Date(now)), formatClock(minutes));
  return firstOccurrence(todayAt, "daily", now);
}

/** 本窗口正在推进的闹钟 id，避免同一次事件把同一条推两遍。 */
const advancing = new Set<string>();

/** 推进的结果。`failed` 是给不传 `onError` 的后台调用方看的。 */
export interface AdvanceAlarmsResult {
  /** 真正被推进成功的那些，调用方可以据此**局部**更新自己的列表。 */
  saved: Timer[];
  /** 有几条推进写盘失败了。 */
  failed: number;
}

/**
 * 推进所有「已经响过、且设了每天重复」的闹钟。
 *
 * 触发条件是 `fired === true`（Rust 已经为这一轮响过）+ `alarmDaily`。
 * 只响一次的闹钟刻意**不动**：它就该停在「已完成」，
 * 保持 `fired` 为真反而让调度线程永远不会为它再响。
 *
 * @param list    当前的全量计时器
 * @param onError 可选的错误回调；后台调用方不传，改看返回的 `failed`
 */
export async function advanceAlarms(
  list: Timer[],
  onError?: (message: string) => void,
): Promise<AdvanceAlarmsResult> {
  const due = list.filter(
    (t) =>
      t.kind === "alarm" &&
      t.alarmDaily &&
      t.fired &&
      // Rust 响过之后会把 endsAt 清空。它不是空的话说明这一轮还没响
      // （或数据被手改过），别去动它
      t.endsAt === null &&
      !advancing.has(t.id),
  );
  if (due.length === 0) return { saved: [], failed: 0 };

  const saved: Timer[] = [];
  let failed = 0;

  for (const alarm of due) {
    advancing.add(alarm.id);
    try {
      const next: Timer = {
        ...alarm,
        // 重新算而不是"在上一次的基础上 +1 天"：算出来的一定落在未来，
        // 所以休眠很久、系统时钟被回拨过都不会推出一个过去时刻
        endsAt: nextAlarmAt(alarm.alarmMinutes),
        remainingMs: null,
        fired: false,
      };
      await api.timerSave(next);
      saved.push(next);
    } catch (err) {
      failed += 1;
      onError?.(String(err));
    } finally {
      advancing.delete(alarm.id);
    }
  }

  // 写成功了才广播。广播的作用见 `emitTimersChanged` 的说明 ——
  // 少了它，主面板会一直显示「已完成」，而且用户随手一次「移动到文件夹」
  // 就能把这份推进结果整份冲掉，闹钟从此永久不响。
  if (saved.length > 0) {
    try {
      await emitTimersChanged();
    } catch {
      // 广播失败只影响"别的窗口多久之后才看到新状态"，数据已经落盘了，
      // 不该因此把推进算成失败（那会触发一次没有意义的重试）
    }
  }

  return { saved, failed };
}

/**
 * 拉一次全量计时器并推进。**给后台调用方用**（应用入口）。
 *
 * 必须重试，理由和 `advanceRepeatsOnce` 完全一样：Rust 侧的 `fired` **已经落盘**，
 * 这次推进要是没写成功，`fired` 就一直是 true —— 调度线程不会再为它产生新事件，
 * 也就没有"下一次"可言，这个闹钟永久静默，只有重启才可能恢复。
 *
 * ⚠️ 重试的是 `advanceAlarms` **返回的 `failed`**，不是它抛出的异常：
 * 它内部把每条写盘失败都 `catch` 掉了并正常返回，只靠外层 `try/catch`
 * 一次都重试不到（备忘录那边踩过这个坑，见 `repeat-advance.ts`）。
 */
export async function advanceAlarmsOnce(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { failed } = await advanceAlarms(await api.timersList());
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
