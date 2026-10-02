/**
 * 闹钟的钟点换算与「每天重复」推进的测试。
 *
 * # 为什么这些边界非测不可
 *
 * 闹钟出错的三种表现，用户都很难察觉、更难复现：
 *
 * 1. **钟点漂了**（夏令时那天 +1 小时）—— 用户只会觉得"这闹钟不准"；
 * 2. **永久静默**（`fired` 推进没写成功，Rust 侧的幂等判断从此永远成立）——
 *    界面上没有任何提示，重启也不恢复；
 * 3. **弹窗风暴**（推进算出一个过去时刻）—— 调度线程每 500ms 判定一次"到点"。
 *
 * 这三条都是"跑一次看着没问题"的类型，只能靠断言钉死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Timer } from "./api";

// `vi.mock` 会被提升到文件顶部，所以 mock 必须用 `vi.hoisted` 定义
const { timerAdvanceAlarm, timersList, emitTimersChanged } = vi.hoisted(() => ({
  timerAdvanceAlarm: vi.fn(),
  timersList: vi.fn(),
  emitTimersChanged: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { timerAdvanceAlarm, timersList },
  emitTimersChanged,
}));

import { advanceAlarms, advanceAlarmsOnce, formatClock, nextAlarmAt, parseClock } from "./alarm";
import { splitLocal } from "./datetime";

/** 当前运行时所在时区是否实行夏令时。和 datetime.test.ts 用同一套判据。 */
function hasDst(): boolean {
  const jan = new Date(2026, 0, 15).getTimezoneOffset();
  const jul = new Date(2026, 6, 15).getTimezoneOffset();
  return jan !== jul;
}

const DST = hasDst();

/** 本地时刻 → 绝对毫秒。测试里一律用它构造基准，换时区跑也稳。 */
function local(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/** 造一条闹钟。默认是「刚响过、等着推进下一次」的状态。 */
function alarm(over: Partial<Timer> = {}): Timer {
  return {
    id: "a1",
    name: "起床",
    kind: "alarm",
    endsAt: null,
    remainingMs: null,
    durationMs: null,
    phase: null,
    focusMinutes: 25,
    breakMinutes: 5,
    rounds: 0,
    elapsedMs: 0,
    runningSince: null,
    laps: [],
    alarmMinutes: 7 * 60 + 30,
    alarmDaily: true,
    lastFiredAt: null,
    // Rust 响过之后留下的就是这一组：fired 为真、endsAt 清空
    fired: true,
    folderId: null,
    createdAt: 0,
    ...over,
  };
}

// ===============================================================
// 钟点格式化与解析
// ===============================================================

describe("formatClock", () => {
  it("补足两位", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(9)).toBe("00:09");
    expect(formatClock(7 * 60 + 30)).toBe("07:30");
    expect(formatClock(12 * 60)).toBe("12:00");
    expect(formatClock(23 * 60 + 59)).toBe("23:59");
  });

  it("超过一天按取模算，不显示 25:00 这种钟点", () => {
    // 数据文件可以被手改，塞进 1440 不该让界面出现不存在的钟点
    expect(formatClock(24 * 60)).toBe("00:00");
    expect(formatClock(24 * 60 + 90)).toBe("01:30");
    expect(formatClock(99999)).toBe(formatClock(99999 % 1440));
  });

  it("负数也取模到合法钟点", () => {
    // 不归一的话 -90 会算出 "-1:-30"，那不是钟点
    expect(formatClock(-1)).toBe("23:59");
    expect(formatClock(-90)).toBe("22:30");
    expect(formatClock(-1440)).toBe("00:00");
  });

  it("NaN / Infinity 退回零点而不是拼出 NaN:NaN", () => {
    expect(formatClock(Number.NaN)).toBe("00:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("00:00");
    expect(formatClock(Number.NEGATIVE_INFINITY)).toBe("00:00");
  });

  it("小数向下取整", () => {
    expect(formatClock(90.9)).toBe("01:30");
  });
});

describe("parseClock", () => {
  it("认 HH:MM 与 H:MM", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("7:30")).toBe(450);
    expect(parseClock("23:59")).toBe(1439);
  });

  it("容忍前后空格", () => {
    expect(parseClock("  07:30  ")).toBe(450);
  });

  it("非法输入返回 null，而不是悄悄当成 0 点", () => {
    // 静默当成 00:00 会让人设出一个自己都不知道的闹钟
    expect(parseClock("")).toBeNull();
    expect(parseClock("7")).toBeNull();
    expect(parseClock("0730")).toBeNull();
    expect(parseClock("7:5")).toBeNull();
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("07:60")).toBeNull();
    expect(parseClock("-1:00")).toBeNull();
    expect(parseClock("07:30:00")).toBeNull();
    expect(parseClock("七点半")).toBeNull();
    expect(parseClock("07：30")).toBeNull();
  });

  it("与 formatClock 往返一致", () => {
    for (let m = 0; m < 1440; m += 7) {
      expect(parseClock(formatClock(m))).toBe(m);
    }
  });
});

// ===============================================================
// 下一次响铃时刻
// ===============================================================

describe("nextAlarmAt", () => {
  it("今天这个钟点还没到就是今天", () => {
    const now = local(2026, 5, 20, 6, 0);
    const at = nextAlarmAt(7 * 60 + 30, now);
    expect(splitLocal(at)).toEqual({ date: "2026-05-20", time: "07:30" });
  });

  it("今天已经过了就是明天", () => {
    const now = local(2026, 5, 20, 9, 0);
    const at = nextAlarmAt(7 * 60 + 30, now);
    expect(splitLocal(at)).toEqual({ date: "2026-05-21", time: "07:30" });
  });

  it("恰好等于现在时推到下一次，不返回当下", () => {
    // 返回一个等于 now 的时刻，调度线程下一个 tick 就会判定"到点"，
    // 而前端还没写完就又被判定一次 —— 弹窗风暴
    const now = local(2026, 5, 20, 7, 30);
    const at = nextAlarmAt(7 * 60 + 30, now);
    expect(at).toBeGreaterThan(now);
    expect(splitLocal(at)).toEqual({ date: "2026-05-21", time: "07:30" });
  });

  it("任何钟点 × 任何时刻都严格落在未来", () => {
    // 这条不变量是硬约束：破坏了就是每 500ms 弹一次的弹窗风暴
    const base = local(2026, 5, 20, 0, 0);
    for (const minutes of [0, 1, 7 * 60 + 30, 12 * 60, 23 * 60 + 59, 1440, 99999, -90]) {
      for (let step = 0; step < 24 * 4; step += 1) {
        const now = base + step * 15 * 60_000;
        expect(nextAlarmAt(minutes, now)).toBeGreaterThan(now);
      }
    }
  });

  it("结果保留用户设的钟点", () => {
    for (const hhmm of ["00:00", "07:30", "12:00", "23:59"]) {
      const minutes = parseClock(hhmm) as number;
      const now = local(2026, 5, 20, 13, 37);
      expect(splitLocal(nextAlarmAt(minutes, now)).time).toBe(hhmm);
    }
  });

  it("非法钟点也能算出一个未来时刻，不会卡死", () => {
    const now = local(2026, 5, 20, 13, 37);
    const at = nextAlarmAt(Number.NaN, now);
    expect(at).toBeGreaterThan(now);
    // NaN 归一成 00:00，所以下一次是明天零点
    expect(splitLocal(at)).toEqual({ date: "2026-05-21", time: "00:00" });
  });
});

describe.skipIf(!DST)("闹钟跨夏令时（当前时区有夏令时，断言真实执行）", () => {
  it("钟点落在夏令时缺口里时跳过那一天，而不是挪到 03:30", () => {
    // 美东 2026-03-08 的 02:00~02:59 这个本地时刻不存在。
    // 引擎会把它归一化成 03:30 —— 那用户的「每天 02:30」就永久变成了 03:30。
    const now = local(2026, 3, 8, 0, 30);
    const at = nextAlarmAt(2 * 60 + 30, now);

    expect(splitLocal(at).time).toBe("02:30");
    expect(splitLocal(at).date).toBe("2026-03-09");
    expect(at).toBeGreaterThan(now);
  });

  it("跨夏令时切换日仍然响在同一个钟点", () => {
    // 2026-03-08 那天只有 23 小时，加 86400000 会把钟点推后一小时
    const now = local(2026, 3, 7, 8, 0);
    const at = nextAlarmAt(7 * 60 + 30, now);
    expect(splitLocal(at)).toEqual({ date: "2026-03-08", time: "07:30" });
  });

  it("夏令时结束那天（25 小时）钟点同样不变", () => {
    const now = local(2026, 11, 1, 0, 0);
    const at = nextAlarmAt(7 * 60 + 30, now);
    expect(splitLocal(at)).toEqual({ date: "2026-11-01", time: "07:30" });
  });
});

// ===============================================================
// 每天重复的推进
// ===============================================================

describe("advanceAlarms", () => {
  beforeEach(() => {
    timerAdvanceAlarm.mockReset();
    timersList.mockReset();
    emitTimersChanged.mockReset();
    timerAdvanceAlarm.mockResolvedValue(true);
    emitTimersChanged.mockResolvedValue(undefined);
  });

  it("每天重复且刚响过 → 写回下一次，并清掉 fired", async () => {
    const result = await advanceAlarms([alarm()]);

    expect(result.failed).toBe(0);
    expect(result.saved).toHaveLength(1);

    // 走的是 Rust 侧的条件更新命令，不是 timerSave 的整条覆盖写
    expect(timerAdvanceAlarm).toHaveBeenCalledTimes(1);
    const [id, endsAt] = timerAdvanceAlarm.mock.calls[0] as [string, number];
    expect(id).toBe("a1");
    expect(endsAt).toBeGreaterThan(Date.now());
    // 钟点必须还是用户设的那个
    expect(splitLocal(endsAt).time).toBe("07:30");

    // 本地状态也要跟上，否则调用方拿到的 saved 和盘上不一致
    expect(result.saved[0].fired).toBe(false);
    expect(result.saved[0].endsAt).toBe(endsAt);
    expect(result.saved[0].remainingMs).toBeNull();
    expect(result.saved[0].alarmMinutes).toBe(450);
  });

  it("Rust 说不用推进（用户已经停掉/删掉）时不算成功、也不广播", async () => {
    // 这是「用户的停止不会被吞掉」的前端一侧：权威判断在 Rust，
    // 它返回 false 时我们必须当这次推进没发生
    timerAdvanceAlarm.mockResolvedValue(false);

    const result = await advanceAlarms([alarm()]);

    expect(result).toEqual({ saved: [], failed: 0 });
    expect(emitTimersChanged).not.toHaveBeenCalled();
  });

  it("只响一次的闹钟刻意不动", async () => {
    // 它就该停在「已完成」。保持 fired 为真，调度线程才不会为它再响
    const result = await advanceAlarms([alarm({ alarmDaily: false })]);
    expect(result).toEqual({ saved: [], failed: 0 });
    expect(timerAdvanceAlarm).not.toHaveBeenCalled();
  });

  it("还没响过的闹钟不动", async () => {
    const result = await advanceAlarms([alarm({ fired: false })]);
    expect(result).toEqual({ saved: [], failed: 0 });
    expect(timerAdvanceAlarm).not.toHaveBeenCalled();
  });

  it("endsAt 还没清空的（这一轮还没结束）不动", async () => {
    const result = await advanceAlarms([alarm({ endsAt: Date.now() + 60_000 })]);
    expect(result).toEqual({ saved: [], failed: 0 });
    expect(timerAdvanceAlarm).not.toHaveBeenCalled();
  });

  it("别的类型一概不动", async () => {
    const others: Timer[] = [
      alarm({ id: "c", kind: "countdown", fired: true, durationMs: 60_000 }),
      alarm({ id: "p", kind: "pomodoro", fired: true }),
      alarm({ id: "s", kind: "stopwatch", fired: true }),
    ];
    const result = await advanceAlarms(others);
    expect(result).toEqual({ saved: [], failed: 0 });
    expect(timerAdvanceAlarm).not.toHaveBeenCalled();
  });

  it("写盘失败必须计数，不能只交给 onError", async () => {
    // 后台调用方不传 onError，它只能靠 `failed` 知道要重试
    timerAdvanceAlarm.mockRejectedValue(new Error("磁盘忙"));
    const onError = vi.fn();

    const result = await advanceAlarms([alarm()], onError);

    expect(result.saved).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("一条失败不影响其余几条的推进", async () => {
    timerAdvanceAlarm
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValue(true);

    const result = await advanceAlarms([alarm({ id: "a" }), alarm({ id: "b" })]);

    expect(result.failed).toBe(1);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].id).toBe("b");
  });

  it("推进成功要广播一次，否则主面板会把过期快照写回去", async () => {
    await advanceAlarms([alarm()]);
    expect(emitTimersChanged).toHaveBeenCalledTimes(1);
  });

  it("什么都没推进时不该广播（否则会来回刷）", async () => {
    await advanceAlarms([alarm({ alarmDaily: false })]);
    expect(emitTimersChanged).not.toHaveBeenCalled();
  });

  it("广播失败不算推进失败", async () => {
    // 数据已经落盘了。把它算成失败会触发一次没有意义的重试，
    // 而重试时 fired 已经是 false，什么都推不动
    emitTimersChanged.mockRejectedValue(new Error("没有窗口在监听"));

    const result = await advanceAlarms([alarm()]);

    expect(result.failed).toBe(0);
    expect(result.saved).toHaveLength(1);
  });
});

describe("advanceAlarmsOnce（后台调用方）", () => {
  beforeEach(() => {
    timerAdvanceAlarm.mockReset();
    timersList.mockReset();
    emitTimersChanged.mockReset();
    emitTimersChanged.mockResolvedValue(undefined);
  });

  it("没有失败时只跑一次", async () => {
    timersList.mockResolvedValue([alarm()]);
    timerAdvanceAlarm.mockResolvedValue(true);

    await advanceAlarmsOnce();

    expect(timersList).toHaveBeenCalledTimes(1);
    expect(timerAdvanceAlarm).toHaveBeenCalledTimes(1);
  });

  it("写盘失败会真的重试", async () => {
    timersList.mockResolvedValue([alarm()]);
    timerAdvanceAlarm
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValue(true);

    await advanceAlarmsOnce();

    // 第一次失败 → 退避 500ms 后重试 → 成功
    expect(timersList).toHaveBeenCalledTimes(2);
    expect(timerAdvanceAlarm).toHaveBeenCalledTimes(2);
  });

  it("读盘失败也会重试，且不抛出去", async () => {
    // 后台调用方没有 try/catch，抛出去会变成一个未处理的 rejection
    timersList.mockRejectedValueOnce(new Error("文件被占用")).mockResolvedValue([]);

    await expect(advanceAlarmsOnce()).resolves.toBeUndefined();
    expect(timersList).toHaveBeenCalledTimes(2);
  });

  it("一直失败也不会无限重试", async () => {
    timersList.mockResolvedValue([alarm()]);
    timerAdvanceAlarm.mockRejectedValue(new Error("磁盘一直忙"));

    await advanceAlarmsOnce();

    expect(timersList).toHaveBeenCalledTimes(3);
  });
});