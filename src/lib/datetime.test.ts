/**
 * `datetime.ts` 的测试。
 *
 * # 为什么单独测这一个文件
 *
 * 这是全项目**最容易悄悄出错**的地方：重复提醒的日期推算要同时处理
 * 夏令时、月末溢出、跳过周末三件事。算错的表现是"某个提醒没响"
 * 或者"每月 31 日的提醒跑到 3 月 3 日去了"，用户很难察觉、更难复现。
 *
 * # 夏令时测试怎么做的
 *
 * 中国时区没有夏令时，如果在默认时区跑夏令时断言，测试会永远通过——
 * 那等于没测。所以：
 *
 * - 常规断言（规则本身对不对）在任何时区都跑
 * - 夏令时断言用 `describe.skipIf` 守卫，只在**当前时区确实有夏令时**时执行，
 *   并在跳过时打印原因，避免"静默不测"
 * - 用 `npm run test:dst` 会在 `America/New_York` 下再跑一遍，把夏令时断言真正执行到
 */
import { describe, expect, it } from "vitest";

import {
  combineLocal,
  dateKey,
  firstOccurrence,
  formatDateHuman,
  formatDuration,
  formatMoment,
  formatStopwatch,
  formatUntil,
  isRealDateKey,
  monthGrid,
  nextOccurrence,
  splitLocal,
  todayKey,
} from "./datetime";

/** 当前运行时所在时区是否实行夏令时。 */
function hasDst(): boolean {
  const jan = new Date(2026, 0, 15).getTimezoneOffset();
  const jul = new Date(2026, 6, 15).getTimezoneOffset();
  return jan !== jul;
}

const DST = hasDst();

/** 断言某个时刻的本地墙上时钟是几点几分。 */
function expectLocalTime(ms: number, hour: number, minute: number) {
  const d = new Date(ms);
  expect([d.getHours(), d.getMinutes()]).toEqual([hour, minute]);
}

// ===============================================================
// 时长格式化
// ===============================================================

describe("formatDuration", () => {
  it("不足一小时时省略小时段", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(1000)).toBe("00:01");
    expect(formatDuration(59_000)).toBe("00:59");
    expect(formatDuration(60_000)).toBe("01:00");
    expect(formatDuration(25 * 60_000)).toBe("25:00");
  });

  it("超过一小时时带上小时段", () => {
    expect(formatDuration(3_600_000)).toBe("01:00:00");
    expect(formatDuration(3_661_000)).toBe("01:01:01");
    expect(formatDuration(10 * 3_600_000)).toBe("10:00:00");
  });

  it("负数按零处理", () => {
    // 倒计时归零的瞬间可能算出极小的负数，不能显示成 "-00:01"
    expect(formatDuration(-1)).toBe("00:00");
    expect(formatDuration(-99_999)).toBe("00:00");
  });

  it("向下取整而不是四舍五入", () => {
    // 剩余 1.9 秒时应显示 00:01，显示 00:02 会让用户以为计时器不准
    expect(formatDuration(1_999)).toBe("00:01");
  });
});

describe("formatStopwatch", () => {
  it("带百分秒", () => {
    expect(formatStopwatch(0)).toBe("00:00.00");
    expect(formatStopwatch(1_234)).toBe("00:01.23");
    expect(formatStopwatch(61_000)).toBe("01:01.00");
  });

  it("超过一小时带上小时段", () => {
    expect(formatStopwatch(3_600_000)).toBe("01:00:00.00");
  });

  it("负数按零处理", () => {
    expect(formatStopwatch(-5)).toBe("00:00.00");
  });
});

// ===============================================================
// 本地时间与绝对时刻互转
// ===============================================================

describe("combineLocal / splitLocal", () => {
  it("能往返转换", () => {
    const ms = combineLocal("2026-09-19", "14:35");
    const back = splitLocal(ms);
    expect(back).toEqual({ date: "2026-09-19", time: "14:35" });
  });

  it("按本地时区解释而不是 UTC", () => {
    // 这是最容易错的地方：`new Date("2026-09-19T14:35")` 在不同引擎里
    // 对无时区后缀字符串的处理不一致，所以实现里用的是
    // `new Date(y, m-1, d, hh, mm)`。这里断言两者一致。
    const ms = combineLocal("2026-09-19", "14:35");
    const expected = new Date(2026, 8, 19, 14, 35, 0, 0).getTime();
    expect(ms).toBe(expected);
  });

  it("午夜不会被解析成前一天", () => {
    const ms = combineLocal("2026-01-01", "00:00");
    expect(splitLocal(ms)).toEqual({ date: "2026-01-01", time: "00:00" });
  });

  it("dateKey 与 splitLocal 对同一天给出一致结果", () => {
    const ms = combineLocal("2026-12-31", "23:59");
    expect(splitLocal(ms).date).toBe("2026-12-31");
    expect(dateKey(new Date(ms))).toBe("2026-12-31");
  });

  it("todayKey 与当前时间一致", () => {
    expect(todayKey()).toBe(dateKey(new Date()));
  });
});

// ===============================================================
// 重复规则
// ===============================================================

describe("nextOccurrence 基本规则", () => {
  it("不重复时返回 null", () => {
    // 调用方靠这个 null 判断"不该推进"，返回一个时间会导致它无限重复
    expect(nextOccurrence(combineLocal("2026-09-19", "09:00"), "none")).toBeNull();
  });

  it("每天推进一天且保持同一钟点", () => {
    const base = combineLocal("2026-09-19", "09:00");
    const next = nextOccurrence(base, "daily")!;

    expect(splitLocal(next)).toEqual({ date: "2026-09-20", time: "09:00" });
  });

  it("每周推进七天", () => {
    const base = combineLocal("2026-09-19", "09:00"); // 周六
    const next = nextOccurrence(base, "weekly")!;

    expect(splitLocal(next)).toEqual({ date: "2026-09-26", time: "09:00" });
    expect(new Date(next).getDay()).toBe(6);
  });

  it("每月推进一个月", () => {
    const base = combineLocal("2026-09-15", "09:00");
    const next = nextOccurrence(base, "monthly")!;

    expect(splitLocal(next)).toEqual({ date: "2026-10-15", time: "09:00" });
  });

  it("跨年也能正确推进", () => {
    const base = combineLocal("2026-12-31", "23:30");
    expect(splitLocal(nextOccurrence(base, "daily")!)).toEqual({
      date: "2027-01-01",
      time: "23:30",
    });
    expect(splitLocal(nextOccurrence(base, "monthly")!)).toEqual({
      date: "2027-01-31",
      time: "23:30",
    });
  });
});

describe("nextOccurrence 月末夹取", () => {
  it("1月31日加一个月夹到2月28日（平年）", () => {
    // 不夹的话 JS 会溢出成 3 月 3 日，用户设的"每月 31 日"就跑到下下个月去了
    const base = combineLocal("2026-01-31", "09:00");
    const next = nextOccurrence(base, "monthly")!;

    expect(splitLocal(next)).toEqual({ date: "2026-02-28", time: "09:00" });
  });

  it("1月31日加一个月夹到2月29日（闰年）", () => {
    const base = combineLocal("2024-01-31", "09:00");
    const next = nextOccurrence(base, "monthly")!;

    expect(splitLocal(next)).toEqual({ date: "2024-02-29", time: "09:00" });
  });

  it("3月31日加一个月夹到4月30日", () => {
    const base = combineLocal("2026-03-31", "09:00");
    const next = nextOccurrence(base, "monthly")!;

    expect(splitLocal(next)).toEqual({ date: "2026-04-30", time: "09:00" });
  });

  it("夹取之后不会永久丢掉原来的日号", () => {
    // 2月被夹到 28 日之后，下一个月应该回到 31 日，
    // 而不是从此一直在 28 号附近漂移
    const jan = combineLocal("2026-01-31", "09:00");
    const feb = nextOccurrence(jan, "monthly")!;
    expect(splitLocal(feb).date).toBe("2026-02-28");

    // 注意：实现是"从上一次的日期加一个月"，所以 2月28日之后会变成 3月28日。
    // 这是刻意的取舍——记不住原始日号，但保证时间不会倒退或跳过整月。
    const mar = nextOccurrence(feb, "monthly")!;
    expect(splitLocal(mar).date).toBe("2026-03-28");
  });

  it("30 天的月份加一个月不会溢出到下下个月", () => {
    const base = combineLocal("2026-05-30", "09:00");
    expect(splitLocal(nextOccurrence(base, "monthly")!).date).toBe("2026-06-30");
  });
});

describe("nextOccurrence 工作日规则", () => {
  it("周五的下一个是周一", () => {
    const base = combineLocal("2026-09-18", "09:00"); // 周五
    const next = nextOccurrence(base, "weekday")!;

    expect(splitLocal(next).date).toBe("2026-09-21"); // 周一
  });

  it("周六的下一个是周一", () => {
    const base = combineLocal("2026-09-19", "09:00"); // 周六
    const next = nextOccurrence(base, "weekday")!;

    expect(splitLocal(next).date).toBe("2026-09-21");
  });

  it("周日的下一个是周一", () => {
    const base = combineLocal("2026-09-20", "09:00"); // 周日
    const next = nextOccurrence(base, "weekday")!;

    expect(splitLocal(next).date).toBe("2026-09-21");
  });

  it("周一的下一个是周二（不跳过工作日）", () => {
    const base = combineLocal("2026-09-21", "09:00"); // 周一
    const next = nextOccurrence(base, "weekday")!;

    expect(splitLocal(next).date).toBe("2026-09-22");
  });

  it("连续推进一个月都落在工作日", () => {
    // 这是"跳过周末"最容易出错的地方：连续推进时状态会不会丢
    let cursor = combineLocal("2026-09-18", "09:00");
    for (let i = 0; i < 30; i++) {
      const next = nextOccurrence(cursor, "weekday");
      expect(next).not.toBeNull();
      const day = new Date(next!).getDay();
      expect(day, `第 ${i + 1} 次推进落到了周末：${splitLocal(next!).date}`).not.toBe(0);
      expect(day, `第 ${i + 1} 次推进落到了周末：${splitLocal(next!).date}`).not.toBe(6);
      // 必须严格向前推进，否则会陷入死循环
      expect(next!).toBeGreaterThan(cursor);
      cursor = next!;
    }
  });
});

// ===============================================================
// 首次提醒时刻
// ===============================================================

describe("firstOccurrence", () => {
  const now = combineLocal("2026-09-19", "12:00");

  it("未来时刻原样返回", () => {
    const wanted = combineLocal("2026-09-19", "15:00");
    expect(firstOccurrence(wanted, "none", now)).toBe(wanted);
    expect(firstOccurrence(wanted, "daily", now)).toBe(wanted);
  });

  it("不重复且时刻已过时原样返回（让它立刻提醒）", () => {
    // 用户明确要在这个时刻提醒，既然已经过了，就应该马上告诉他，
    // 而不是悄悄丢掉
    const wanted = combineLocal("2026-09-19", "09:00");
    expect(firstOccurrence(wanted, "none", now)).toBe(wanted);
  });

  it("每天且时刻已过时顺延到明天", () => {
    const wanted = combineLocal("2026-09-19", "09:00");
    const first = firstOccurrence(wanted, "daily", now);

    expect(first).toBeGreaterThan(now);
    expect(splitLocal(first)).toEqual({ date: "2026-09-20", time: "09:00" });
  });

  it("工作日且时刻已过时顺延到下一个工作日", () => {
    // 2026-09-19 是周六，顺延后应该是周一
    const wanted = combineLocal("2026-09-19", "09:00");
    const first = firstOccurrence(wanted, "weekday", now);

    expect(first).toBeGreaterThan(now);
    expect(splitLocal(first).date).toBe("2026-09-21");
  });

  it("每月且时刻已过时顺延到下个月", () => {
    const wanted = combineLocal("2026-09-15", "09:00");
    const first = firstOccurrence(wanted, "monthly", now);

    expect(first).toBeGreaterThan(now);
    expect(splitLocal(first)).toEqual({ date: "2026-10-15", time: "09:00" });
  });

  it("结果永远落在未来（除非是不重复）", () => {
    // 兜住"时钟被回拨""长期休眠后唤醒"这类情况
    for (const repeat of ["daily", "weekly", "monthly", "weekday"] as const) {
      for (const [date, time] of [
        ["2020-01-01", "09:00"],
        ["2026-09-19", "09:00"],
        ["2030-12-31", "23:59"],
      ]) {
        const first = firstOccurrence(combineLocal(date, time), repeat, now);
        if (first > now) continue;
        throw new Error(`${repeat} 规则下 ${date} ${time} 没有落到未来：${splitLocal(first)}`);
      }
    }
  });

  it("多年前的陈旧提醒也能跳到未来", () => {
    // 这条是回归测试，对应一个真实缺陷：
    // 实现里原本有 400 次循环上限，对 2020 年的每日提醒（距今两千多天）
    // 跳不到未来，会返回一个**过去的时刻**。
    // 后果很严重：调度线程每 500ms 检查一次"到点没到点"，
    // 于是提醒会反复触发，变成弹窗风暴。
    for (const repeat of ["daily", "weekly", "monthly", "weekday"] as const) {
      const first = firstOccurrence(combineLocal("2020-01-01", "09:00"), repeat, now);
      expect(first, `${repeat} 的陈旧提醒没有跳到未来`).toBeGreaterThan(now);
    }
  });

  it("极端陈旧的提醒（20 年前）也不会返回过去时刻", () => {
    // 循环上限之外还有兜底，这里验证兜底真的生效
    for (const repeat of ["daily", "weekly", "monthly", "weekday"] as const) {
      const first = firstOccurrence(combineLocal("2006-01-01", "09:00"), repeat, now);
      expect(first, `${repeat} 在极端陈旧输入下返回了过去时刻`).toBeGreaterThan(now);
    }
  });
});

// ===============================================================
// 人类可读格式化
// ===============================================================

describe("formatDateHuman", () => {
  it("今天和明天用相对说法", () => {
    expect(formatDateHuman(todayKey())).toBe("今天");

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(formatDateHuman(dateKey(tomorrow))).toBe("明天");
  });

  it("其他日期给出月日与星期", () => {
    // 刻意用一个**很远的固定日期**（2030-06-15 是周六，距今三年多）。
    //
    // 这里踩过一次坑：最初用的是 2026-09-25，结果在纽约时区跑时
    // 当地"今天"是 09-26，那天就成了"昨天"，函数返回"昨天"而不是日期，
    // 断言失败。凡是硬编码日期的测试都必须避开"今天/昨天/明天"这三档。
    const text = formatDateHuman("2030-06-15");
    expect(text).toContain("6月15日");
    expect(text).toContain("周六");
  });
});

describe("formatMoment", () => {
  it("今天只显示时刻", () => {
    const today = combineLocal(todayKey(), "08:05");
    expect(formatMoment(today)).toBe("08:05");
  });

  it("其他日期带上月日", () => {
    // 同样用远期日期，避免落进"今天"那一档（原因见 formatDateHuman 的测试）
    expect(formatMoment(combineLocal("2030-06-15", "08:05"))).toBe("6月15日 08:05");
  });
});

describe("formatUntil", () => {
  it("已过期", () => {
    expect(formatUntil(Date.now() - 1000)).toBe("已到期");
  });

  it("不到一分钟", () => {
    expect(formatUntil(Date.now() + 30_000)).toBe("不到 1 分钟");
  });

  it("分钟级", () => {
    expect(formatUntil(Date.now() + 5 * 60_000 + 5_000)).toBe("还有 5 分钟");
  });

  it("小时级带余分", () => {
    expect(formatUntil(Date.now() + (2 * 60 + 15) * 60_000 + 1_000)).toBe("还有 2 小时 15 分");
  });

  it("整小时不带余分", () => {
    expect(formatUntil(Date.now() + 3 * 3_600_000 + 1_000)).toBe("还有 3 小时");
  });

  it("天级", () => {
    expect(formatUntil(Date.now() + 2 * 86_400_000 + 1_000)).toBe("还有 2 天");
  });
});

// ===============================================================
// 夏令时
// ===============================================================

describe.skipIf(!DST)("夏令时（当前时区有夏令时，断言真实执行）", () => {
  it("每天规则跨越夏令时开始日时保持同一钟点", () => {
    // 2026-03-08 是美东夏令时开始日。
    // 如果实现写成"加 86400000 毫秒"，钟点会变成 10:00 —— 这个断言就是为了抓它。
    const base = combineLocal("2026-03-07", "09:00");
    const next = nextOccurrence(base, "daily")!;

    expectLocalTime(next, 9, 0);
    expect(splitLocal(next).date).toBe("2026-03-08");
  });

  it("每天规则跨越夏令时结束日时保持同一钟点", () => {
    // 2026-11-01 是美东夏令时结束日，那天有 25 小时
    const base = combineLocal("2026-10-31", "09:00");
    const next = nextOccurrence(base, "daily")!;

    expectLocalTime(next, 9, 0);
    expect(splitLocal(next).date).toBe("2026-11-01");
  });

  it("连续推进一整年，每天的钟点都不变", () => {
    // 这是最强的断言：跨过两次夏令时切换，逐日检查
    let cursor = combineLocal("2026-01-01", "07:30");
    for (let i = 0; i < 365; i++) {
      const next = nextOccurrence(cursor, "daily")!;
      expectLocalTime(next, 7, 30);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it("工作日规则跨越夏令时也保持钟点", () => {
    // 2026-03-06 是周五，下一个工作日是 3-09（周一），中间跨过夏令时切换
    const base = combineLocal("2026-03-06", "08:00");
    const next = nextOccurrence(base, "weekday")!;

    expectLocalTime(next, 8, 0);
    expect(new Date(next).getDay()).toBe(1); // 周一
  });

  it("每周规则跨越夏令时也保持钟点", () => {
    const base = combineLocal("2026-03-05", "10:15");
    const next = nextOccurrence(base, "weekly")!;

    expectLocalTime(next, 10, 15);
  });
});

// 当前时区没有夏令时时，把"夏令时断言被跳过"这件事**说出来** ——
// 静默跳过会让"全绿"变成假象。想看真实断言请跑 `npm run test:dst`。
//
// 放在模块顶层而不是塞一个 `it`：原来那条 `it` 里写的是
// `expect(DST).toBe(false)`，而它外面正是 `describe.skipIf(DST)` ——
// 那个断言**不可能失败**，却计成"一条通过"，撑起了通过数。
if (!DST) {
  console.warn(
    "[浮光] 当前时区没有夏令时，夏令时断言已跳过。" +
      "用 `npm run test:dst` 在 America/New_York 下再跑一遍。",
  );
}

// ===============================================================
// 日期键校验
// ===============================================================

describe("isRealDateKey", () => {
  it("接受合法日期", () => {
    expect(isRealDateKey("2026-09-25")).toBe(true);
    expect(isRealDateKey("2024-02-29")).toBe(true); // 闰年的 2 月 29 日确实存在
    expect(isRealDateKey("2026-01-01")).toBe(true);
    expect(isRealDateKey("2026-12-31")).toBe(true);
  });

  it("拒绝格式不对的输入", () => {
    // 这些是手打日期时真实会出现的中间态（用户正打到一半就失焦了）
    expect(isRealDateKey("")).toBe(false);
    expect(isRealDateKey("2026-9-25")).toBe(false); // 月份没补零
    expect(isRealDateKey("2026/09/25")).toBe(false); // 用了斜杠
    expect(isRealDateKey("20260925")).toBe(false);
    expect(isRealDateKey("2026-09-25 ")).toBe(false); // 尾随空格
    expect(isRealDateKey("abc")).toBe(false);
  });

  it("拒绝格式对但日期不存在的值", () => {
    // 这一组是正则挡不住的：必须把日期构造出来再比对才能发现
    expect(isRealDateKey("2026-02-30")).toBe(false);
    expect(isRealDateKey("2026-02-29")).toBe(false); // 2026 不是闰年
    expect(isRealDateKey("2026-04-31")).toBe(false); // 4 月只有 30 天
    expect(isRealDateKey("2026-13-01")).toBe(false); // 没有 13 月
    expect(isRealDateKey("2026-00-10")).toBe(false); // 没有 0 月
    expect(isRealDateKey("2026-01-00")).toBe(false); // 没有 0 日
    expect(isRealDateKey("2026-01-32")).toBe(false); // 1 月只有 31 天
  });
});

// ===============================================================
// 月历网格
// ===============================================================

describe("monthGrid", () => {
  it("固定 42 格，周一开头", () => {
    // 2026-09-01 是周二，所以首格是 8 月 31 日（周一）
    const g = monthGrid(2026, 8);
    expect(g).toHaveLength(42);
    expect(g[0].key).toBe("2026-08-31");
    expect(g[41].key).toBe("2026-10-11");
  });

  it("标出哪些格子属于本月", () => {
    const own = monthGrid(2026, 8).filter((c) => c.inMonth);
    expect(own).toHaveLength(30); // 9 月 30 天
    expect(own[0].key).toBe("2026-09-01");
    expect(own[own.length - 1].key).toBe("2026-09-30");
  });

  it("1 号正好是周一时，首格就是 1 号本身", () => {
    // 2026-06-01 是周一，这是"不需要补位"的边界
    const g = monthGrid(2026, 5);
    expect(g[0].key).toBe("2026-06-01");
    expect(g[0].inMonth).toBe(true);
    expect(g.filter((c) => c.inMonth)).toHaveLength(30);
  });

  it("2 月按闰年取 29 天、平年取 28 天", () => {
    expect(monthGrid(2024, 1).filter((c) => c.inMonth)).toHaveLength(29);
    expect(monthGrid(2026, 1).filter((c) => c.inMonth)).toHaveLength(28);
  });

  it("键唯一，且 inMonth 与键所属月份一致", () => {
    // 跨月补位最容易出现"显示 1 号、键却是别的月份的 1 号"这类错位。
    // 注意 monthGrid 的月份是 0 基：传 11 拿到的是 12 月。
    const g = monthGrid(2026, 11);
    expect(new Set(g.map((c) => c.key)).size).toBe(42);
    for (const c of g) {
      expect(Number(c.key.slice(-2))).toBe(c.day);
      expect(c.key.startsWith("2026-12")).toBe(c.inMonth);
    }
  });

  it("年份小于 100 的输入被明确拒绝，内部构造也不会被挪到 1900 年代", () => {
    // 先把 JS 的既有行为钉住：new Date(26, 8, 25) 拿到的是 **1926** 年。
    // 不知道这一点，下面的断言就看不出是在防什么。
    expect(new Date(26, 8, 25).getFullYear()).toBe(1926);

    // 对外：**明确拒绝**，而不是静默退回原值让用户不知道为什么。
    // 与其"支持"两位数年份（dateKey 会产出非 4 位键、日历翻页跳到 1926），
    // 不如让用户改一个正常年份。
    expect(isRealDateKey("0026-09-25")).toBe(false);
    expect(isRealDateKey("1926-09-25")).toBe(true);
    expect(isRealDateKey("2026-02-30")).toBe(false);
    expect(isRealDateKey("2026-13-01")).toBe(false);

    // 对内：即便真的进来了（老数据 / 手改文件），构造也不能被悄悄挪走
    const d = new Date(combineLocal("0026-09-25", "08:00"));
    expect(d.getFullYear()).toBe(26);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(25);
    expect(monthGrid(26, 8).filter((c) => c.inMonth)).toHaveLength(30);
  });

  it("dateKey 的年份一定补足四位", () => {
    // 年份 100–999 不补零会产出 "100-01-01" 这种非 4 位键，
    // 而 isRealDateKey 的正则要求 4 位 —— 自己产出的键自己认不出来。
    expect(dateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dateKey(new Date(100, 0, 5))).toBe("0100-01-05");
    // 补零之后闭环成立：自己产出的键自己认得出
    expect(isRealDateKey(dateKey(new Date(100, 0, 5)))).toBe(true);
  });

});

// ===============================================================
// 夏令时跳变下的钟点稳定性
// ===============================================================

// 只在**真的有夏令时**的时区下跑。
//
// 在 Asia/Shanghai 下它恒成立（没有跳变就不可能有漂移）：把 `atLocalTime`
// 整个换成朴素实现它照样通过 —— 留着只会撑起通过数、给人"这条已被覆盖"的错觉。
// 跳过时上面那句 `console.warn` 会说明原因。
describe.skipIf(!DST)("夏令时跳变时的钟点稳定性", () => {
  it("连续推进时墙上时钟不会漂移", () => {
    // 美东 2026-03-08 的 02:00–02:59 这个本地时刻**不存在**：
    // 旧实现会被引擎归一化成 03:30，并把这个 03:30 当成新基准，
    // 于是"每天 02:30"被**永久**改成"每天 03:30"。
    // 钟点是用户设的规则，任何情况下都不该被改掉。
    let t = combineLocal("2026-03-06", "02:30");
    const times: string[] = [splitLocal(t).time];

    for (let i = 0; i < 10; i += 1) {
      const next = nextOccurrence(t, "daily");
      expect(next).not.toBeNull();
      t = next as number;
      times.push(splitLocal(t).time);
    }

    expect(new Set(times)).toEqual(new Set(["02:30"]));
  });
});
