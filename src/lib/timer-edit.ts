/**
 * 计时器的"新建"与"编辑"。
 *
 * # 为什么编辑要单独一个纯函数
 *
 * 用户反馈「闹钟什么的都没法修改」—— 原来建好之后只能删了重建，连改个名字
 * 都没有入口。补编辑功能时最容易出错的地方**不是表单**，而是
 * "改了设置之后，那条计时器原来跑到哪一步了该怎么办"：
 *
 * - 只改名字 → 正在跑的倒计时**不能**被打断；
 * - 改了时长 → 正在跑的那一轮是按旧时长排的，留着它卡片上的「设定」
 *   和正在倒的数就对不上，得回到「未开始」；
 * - 改了闹钟钟点 → 正排着下一次的那条要按新钟点重排，
 *   否则用户改完时间发现第二天还是老时间响。
 *
 * 这些规则是**纯数据变换**，所以抽出来单测 —— 放在组件里就只能靠手点验证，
 * 而这几种组合恰恰是最难手点全的。
 */
import { nextAlarmAt } from "./alarm";
import { newId, type Timer, type TimerKind } from "./api";

/**
 * 新建 / 编辑表单里用户能填的那几项。
 *
 * 刻意不是整个 `Timer`：表单填不了"跑到哪一步了"，把运行状态混进表单里，
 * 保存时就会把用户填表单期间**后台刚更新过**的状态整份盖回去
 * （倒计时到点、番茄钟翻阶段都是 Rust 在改）。
 */
export interface TimerDraft {
  name: string;
  kind: TimerKind;
  /** 倒计时的设定时长（毫秒）；其它模式忽略。 */
  durationMs: number;
  /** 番茄钟的节奏（分钟）；其它模式忽略。 */
  focusMinutes: number;
  breakMinutes: number;
  /** 闹钟的钟点（从本地零点起的分钟数）；其它模式忽略。 */
  alarmMinutes: number;
  /** 闹钟是否每天重复；其它模式忽略。 */
  alarmDaily: boolean;
}

/**
 * 按表单新建一条计时器。
 *
 * 倒计时和闹钟是"建好即开始"：用户填了时长 / 挑好了钟点就是想让它开始等，
 * 再要求点一次「开始」是多余的一步。番茄钟和秒表新建出来是「未开始」。
 */
export function createTimer(draft: TimerDraft, now: number): Timer {
  const isAlarm = draft.kind === "alarm";
  return {
    id: newId(),
    name: draft.name,
    kind: draft.kind,
    endsAt:
      draft.kind === "countdown"
        ? now + draft.durationMs
        : isAlarm
          ? nextAlarmAt(draft.alarmMinutes, now)
          : null,
    remainingMs: null,
    // 倒计时的设定时长要单独存：重置、重新开始都要靠它拿回用户填的时长，
    // 而 remainingMs 到点后会被 Rust 清成 0，不能当设定值用
    durationMs: draft.kind === "countdown" ? draft.durationMs : null,
    phase: draft.kind === "pomodoro" ? "focus" : null,
    // 番茄钟之外的两种模式用不到这两个字段，给默认值即可
    focusMinutes: draft.kind === "pomodoro" ? draft.focusMinutes : 25,
    breakMinutes: draft.kind === "pomodoro" ? draft.breakMinutes : 5,
    rounds: 0,
    elapsedMs: 0,
    runningSince: null,
    laps: [],
    // 闹钟的钟点同样要单独存：停止、重新响都要靠它拿回用户设的时间
    alarmMinutes: isAlarm ? draft.alarmMinutes : 0,
    alarmDaily: isAlarm ? draft.alarmDaily : false,
    fired: false,
    // 归属由面板决定（只有它知道用户当前在哪个文件夹里）
    folderId: null,
    createdAt: now,
  };
}

/**
 * 把毫秒按**秒**取整（向下）。
 *
 * 编辑表单的精度就是秒（时/分/秒三个输入框），比较"用户改没改过"必须用
 * 同一个精度，否则一个带毫秒尾巴的旧值会被判成"改过"，
 * 用户打开编辑框什么都没动、一保存就把正在跑的计时器重置了。
 */
function toWholeSeconds(ms: number | null): number {
  return Math.floor((ms ?? 0) / 1000);
}

/**
 * 把编辑结果应用到一条已有的计时器上。
 *
 * 只改**用户真的改过的**东西，其余字段（尤其是运行状态）原样保留：
 * 保存的一瞬间后台可能刚好把倒计时标记成完成、或把番茄钟翻到休息阶段
 * （Rust 的调度线程每 500ms 一次），把它整份盖回去就会"到点了却又弹一次"。
 *
 * @param now 当前时刻。传进来而不是在函数里取，是为了能单测。
 */
export function applyTimerEdit(original: Timer, draft: TimerDraft, now: number): Timer {
  const next: Timer = { ...original, name: draft.name };

  switch (original.kind) {
    case "countdown": {
      // 时长没动就什么都别碰：只改名字时正在跑的那一轮必须继续跑。
      //
      // ⚠️ 比较要**按秒**，不能直接比毫秒：表单只有时/分/秒三个输入框，
      // 一个手改出来的 `durationMs: 90500` 在表单里会显示成 1:30:00，
      // 直接比毫秒就会判成"改了"—— 用户打开编辑框什么都没动、一保存，
      // 正在跑的计时器就被重置了。
      if (toWholeSeconds(original.durationMs) !== toWholeSeconds(draft.durationMs)) {
        next.durationMs = draft.durationMs;
        // 回到「未开始」。不重置的话卡片上会同时显示「设定 10:00」和
        // 一个按旧时长（5:00）在倒的数，用户没法判断到底哪个算数。
        next.endsAt = null;
        next.remainingMs = null;
        next.fired = false;
      }
      break;
    }

    case "pomodoro": {
      if (
        original.focusMinutes !== draft.focusMinutes ||
        original.breakMinutes !== draft.breakMinutes
      ) {
        next.focusMinutes = draft.focusMinutes;
        next.breakMinutes = draft.breakMinutes;
        // 同样回到「专注 · 未开始」。中途换节奏没有意义：
        // 当前这一轮该按旧节奏还是新节奏跑，说不清。
        next.phase = "focus";
        next.endsAt = null;
        next.remainingMs = null;
        next.fired = false;
      }
      break;
    }

    case "alarm": {
      const changed =
        original.alarmMinutes !== draft.alarmMinutes ||
        original.alarmDaily !== draft.alarmDaily;

      next.alarmMinutes = draft.alarmMinutes;
      next.alarmDaily = draft.alarmDaily;

      // 只有**正排着下一次**的那条才按新钟点重排。
      // 「未开始」和「已响过」本来就没排着，改了钟点也只是把设置存下来，
      // 用户点「开始」/「再响一次」时自然会用上新值 —— 悄悄替他排上，
      // 会让一个他明确停掉过的闹钟自己响起来。
      if (changed && original.endsAt !== null) {
        next.endsAt = nextAlarmAt(draft.alarmMinutes, now);
      }
      break;
    }

    case "stopwatch":
      // 秒表只有名字可改，运行状态一个字都不能动
      break;
  }

  return next;
}
