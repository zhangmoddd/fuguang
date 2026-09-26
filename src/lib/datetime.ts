/**
 * 日期与时长工具。
 *
 * # 为什么日期计算全放前端
 *
 * JS 的 `Date` 原生就按本地时区工作，`setHours` / `setDate` 会自动处理夏令时。
 * Rust 标准库没有日历能力，要么引 `chrono`，要么调 Windows 时区 API。
 * 所以约定：**前端算出绝对时刻，Rust 只负责到点弹窗**。
 *
 * # 夏令时的坑
 *
 * 「明天同一时刻」不等于「加 86400000 毫秒」——夏令时切换那天只有 23 或 25 小时。
 * 所以这里的做法统一是：先改日期，再**显式重设时分秒**，
 * 让墙上时钟的时间保持不变，而不是让毫秒数保持不变。
 */

/** 把毫秒时长格式化成 `HH:MM:SS`；不足一小时时省略小时段。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 秒表用的格式：`MM:SS.cc`（带百分秒）。 */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`
    : `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** 本地日期键，`YYYY-MM-DD`。 */
export function dateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今天的日期键。 */
export function todayKey(): string {
  return dateKey(new Date());
}

/** 把 `YYYY-MM-DD` 与 `HH:MM` 组合成本地时区的绝对毫秒。 */
export function combineLocal(dateStr: string, timeStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  // 用 new Date(y, m-1, d, hh, mm) 而不是解析字符串：
  // 前者明确按本地时区解释，后者在不同引擎里对 "YYYY-MM-DD" 的处理不一致
  return new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0).getTime();
}

/** 把绝对毫秒拆成 `{ date: "YYYY-MM-DD", time: "HH:MM" }`（本地时区）。 */
export function splitLocal(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: dateKey(d),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** 人类可读的日期，例如 `9月20日 周六`；今天/明天用相对说法。 */
export function formatDateHuman(dateStr: string): string {
  const today = todayKey();
  if (dateStr === today) return "今天";

  const d = new Date(`${dateStr}T00:00:00`);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateStr === dateKey(tomorrow)) return "明天";

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === dateKey(yesterday)) return "昨天";

  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${week[d.getDay()]}`;
}

/** 人类可读的时刻，例如 `09:00`；带日期时是 `9月20日 09:00`。 */
export function formatMoment(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = dateKey(d) === todayKey();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? time : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

/** 距离某个时刻还有多久，例如 `还有 2 小时 15 分`。 */
export function formatUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "已到期";

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `还有 ${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) {
    return restMin > 0 ? `还有 ${hours} 小时 ${restMin} 分` : `还有 ${hours} 小时`;
  }

  const days = Math.floor(hours / 24);
  return `还有 ${days} 天`;
}

/** 重复规则的取值集合，供界面渲染下拉框。 */
export const REPEAT_OPTIONS = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "weekday", label: "工作日（周一至周五）" },
] as const;

export type RepeatValue = (typeof REPEAT_OPTIONS)[number]["value"];

/**
 * 已知的本次提醒时刻，算出下一次该提醒的时刻。
 *
 * @param current 刚刚触发的那一次提醒的绝对毫秒
 * @param repeat  重复规则
 * @returns 下一次的绝对毫秒；`none` 返回 null
 *
 * 实现要点：先改日期再**显式重设时分秒**，
 * 这样夏令时切换当天墙上时钟依然指向同一个钟点。
 */
export function nextOccurrence(current: number, repeat: RepeatValue): number | null {
  if (repeat === "none") return null;

  const base = new Date(current);
  const hour = base.getHours();
  const minute = base.getMinutes();
  const dayOfMonth = base.getDate();

  const d = new Date(current);
  // 每次把秒与毫秒清零，避免第一次设定时带上的零头一直累加
  const reset = () => {
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };

  switch (repeat) {
    case "daily": {
      d.setDate(d.getDate() + 1);
      return reset();
    }
    case "weekly": {
      d.setDate(d.getDate() + 7);
      return reset();
    }
    case "monthly": {
      // 先跳到下个月的同一天。JS 在"1月31日 + 1个月"时会溢出到 3 月 3 日，
      // 这里检测到溢出就夹到目标月的最后一天（2 月 28/29 日），
      // 否则用户设的"每月 31 日提醒"会在 2 月变成 3 月 3 日，非常反直觉。
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dayOfMonth, lastDay));
      return reset();
    }
    case "weekday": {
      d.setDate(d.getDate() + 1);
      // 跳过周六周日。用循环而不是判断两次，跨周时更稳。
      while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() + 1);
      }
      return reset();
    }
    default:
      return null;
  }
}

/**
 * 从"现在"出发，算出某个重复规则的首次提醒时刻。
 *
 * 用于用户刚设好提醒时：如果填的时刻已经过了，就按规则推到下一次，
 * 而不是立刻弹一条过期提醒。
 */
export function firstOccurrence(
  wanted: number,
  repeat: RepeatValue,
  now: number = Date.now(),
): number {
  if (wanted > now) return wanted;
  if (repeat === "none") return wanted;

  // 从用户填的时刻开始往后推，直到落在未来
  let candidate = wanted;
  for (let i = 0; i < 400; i++) {
    const next = nextOccurrence(candidate, repeat);
    if (next === null) return wanted;
    candidate = next;
    if (candidate > now) return candidate;
  }
  return candidate;
}
