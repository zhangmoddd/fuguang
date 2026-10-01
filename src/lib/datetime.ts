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
  // 年份必须补足四位。年份 100–999 时不补零会产出 `100-01-01` 这种非 4 位键，
  // 而 `isRealDateKey` 的正则要求 4 位 —— 自己产出的键自己认不出来。
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今天的日期键。 */
export function todayKey(): string {
  return dateKey(new Date());
}

/**
 * 校验一个 `YYYY-MM-DD` 字符串是不是**真实存在**的日期。
 *
 * 光靠正则挡不住 `2026-02-30`、`2026-13-01` 这类值：格式是对的，日期不存在。
 * 做法是构造出来再比对——`new Date(2026, 1, 30)` 会被自动进位成 3 月 2 日，
 * 年月日三个字段有一个对不上，就说明原来那个日期不存在。
 *
 * 用户手打日期时靠它决定「采纳还是退回原值」（见 features/memo/Calendar.tsx）。
 *
 * # 为什么年份 < 100 直接判非法
 *
 * JS 会把 0–99 的年份当成 19xx（`new Date(26, 8, 25)` 拿到的是 **1926** 年），
 * 所以下面的回环比对必然对不上，`0026-09-25` 会被静默退回 —— 用户看到的是
 * "打了没反应"，不知道原因。与其"支持"一个年份只有两位数的日期
 * （那样 `dateKey` 会产出非 4 位的键、日历翻页会跳到 1926 年），不如明确拒绝。
 *
 * 内部日期运算仍有年份安全的构造（见 `localDate`），那是给老数据/手改文件兜底的，
 * 不是给用户输入放行的理由。
 */
export function isRealDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 100) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 月历网格里的一个格子。 */
export interface MonthCell {
  /** `YYYY-MM-DD`，可以直接当作选中值写回去。 */
  key: string;
  /** 日号（1~31），用于显示。 */
  day: number;
  /** 是否属于目标月份。`false` 表示这是上月末或下月初的补位。 */
  inMonth: boolean;
}

/**
 * 生成月历网格：固定 6 行 × 7 列 = 42 格，**周一开头**。
 *
 * @param year - 四位年份
 * @param month - 月份，**0 基**（和 JS `Date` 一致，1 月是 0）
 *
 * 为什么固定 42 格而不是"够用就行"：**翻月时高度不能跳**。
 * 高度一跳，鼠标底下的「下个月」按钮就会移位，连点两下很容易点空。
 *
 * 上月末与下月初的补位也会一并返回，怎么显示交给调用方——
 * 日历里把它们淡化但仍然可点，点了就直接跳过去。
 */
export function monthGrid(year: number, month: number): MonthCell[] {
  // getDay() 是 0=周日，换算成"周一开头"的偏移量
  const offset = (localDate(year, month, 1).getDay() + 6) % 7;
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    // 让 Date 自己进位跨月，比手算天数安全（闰年、月末都对）
    const d = localDate(year, month, 1 - offset + i);
    cells.push({ key: dateKey(d), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return cells;
}

/**
 * 按本地时区构造一个日期，**并且不被 JS 的「0–99 年份」规则改写**。
 *
 * `new Date(26, 8, 25)` 拿到的是 **1926** 年 —— JS 规定 0–99 的年份一律加 1900。
 * 用户手打 `0026-09-25` 就会被悄悄挪到 1926 年：提醒立刻误弹、日历整年错位。
 *
 * 做法：先用一个**必定合法**的日期建对象，再 `setFullYear(y, m, d)` 一次把
 * 年月日全设掉。三个参数一起给，溢出（`day` 为 0、负数、或超过当月天数）
 * 会按**目标年份**的月长去算。
 *
 * ⚠️ 不能先 `new Date(2000, month, day)` 再 `setFullYear(year)`：
 * 那样溢出是在**2000 年**（闰年）算的，2 月的天数就和目标年份对不上 ——
 * 例如求"2026 年 3 月的第 0 天"会被 2000 年的闰年 2 月带成 3 月 1 日而不是 2 月 28 日。
 * 这条曾经真的写错过，被"每月 31 日夹到 2 月 28 日"的测试抓了出来。
 *
 * 这是本项目里**唯一**构造本地日期的地方，改这一处就够。
 */
function localDate(year: number, month: number, day: number, hh = 0, mm = 0): Date {
  const d = new Date(2000, 0, 1, hh, mm, 0, 0);
  d.setFullYear(year, month, day);
  return d;
}

/** 把 `YYYY-MM-DD` 与 `HH:MM` 组合成本地时区的绝对毫秒。 */
export function combineLocal(dateStr: string, timeStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  // 按本地时区构造，而不是解析字符串：
  // 后者在不同引擎里对 "YYYY-MM-DD" 的处理不一致。
  // 年份的安全性由 localDate 负责（见它的说明）。
  return localDate(y ?? 2000, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0).getTime();
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

/**
 * 把 `YYYY-MM-DD` 与 `HH:MM` 组合成本地时刻；**那天那个钟点不存在时
 * （夏令时春季跳变那一小时）往后找第一个存在的日期**。
 *
 * # 为什么创建路径需要它，而不只是推进路径
 *
 * 美东 2026-03-08 的 02:00–02:59 这个本地时刻**不存在**。`combineLocal` 会把它
 * 归一化成 03:30，而备忘录创建时**把这个 03:30 直接存进了 `remindAt`** ——
 * 于是"每天 02:30"从第一次起就变成"每天 03:30"。
 *
 * `atLocalTime` 在**推进**时确实会保住钟点，但它的职责是"别让钟点漂移"——
 * 基准在创建那一刻就已经被改掉了，它只是忠实地保持那个错的。
 *
 * 跳过那一天、保住钟点，与 `atLocalTime` 的策略一致：
 * 钟点是用户设的规则，任何情况下都不该被改掉。
 */
export function combineLocalSkippingGap(dateStr: string, timeStr: string): number {
  const first = combineLocal(dateStr, timeStr);
  // 钟点没被引擎改掉 → 那天它存在，直接用
  if (splitLocal(first).time === timeStr) return first;

  // 被归一化了 → 从那天正午起往后一天天找第一个"钟点存在"的日期。
  // 用正午做基准，避免基准自己又落在跳变区间里。
  const base = new Date(combineLocal(dateStr, "12:00"));
  for (let i = 1; i <= 370; i += 1) {
    const d = localDate(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const candidate = combineLocal(dateKey(d), timeStr);
    if (splitLocal(candidate).time === timeStr) return candidate;
  }
  // 兜底：一年都找不到（理论上不可能），退回归一化的那个
  return first;
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
 * 把「某个日期 + 规则里的钟点」合成绝对毫秒。
 *
 * # 为什么不能直接 `new Date(y, m, d, hh, mm)`
 *
 * 夏令时春季跳变当天，`02:30` 这个本地时刻**根本不存在**，
 * 引擎会悄悄把它归一化成 `03:30`。而本函数的调用方是拿**上一次的结果**
 * 反推钟点的 —— 一旦把归一化后的 `03:30` 存回去当成新基准，
 * 用户设的「每天 02:30」就**永久**变成「每天 03:30」，再也回不来。
 *
 * 所以这里检测归一化：钟点对不上就往后找第一个该钟点真实存在的日期。
 * 代价是跳变当天少提醒一次；但「少提醒一天」远好于「钟点被悄悄改掉」。
 */
function atLocalTime(
  year: number,
  month: number,
  day: number,
  hh: number,
  mm: number,
): number {
  for (let i = 0; i < 3; i += 1) {
    const d = localDate(year, month, day + i, hh, mm);
    if (d.getHours() === hh && d.getMinutes() === mm) return d.getTime();
  }
  // 夏令时缺口最多 1 小时，正常走不到这里；真到了也不抛错，返回最后一次结果
  return localDate(year, month, day, hh, mm).getTime();
}

/**
 * 已知的本次提醒时刻，算出下一次该提醒的时刻。
 *
 * @param current 刚刚触发的那一次提醒的绝对毫秒
 * @param repeat  重复规则
 * @returns 下一次的绝对毫秒；`none` 返回 null
 *
 * 实现要点：**钟点取自规则（`current` 的时分），日期单独往后推**，
 * 两者最后由 [`atLocalTime`] 合成。日期推进交给 `Date` 自己进位，
 * 比手算天数安全（闰年、月末都对）。
 */
export function nextOccurrence(current: number, repeat: RepeatValue): number | null {
  if (repeat === "none") return null;

  const base = new Date(current);
  const hour = base.getHours();
  const minute = base.getMinutes();
  const dayOfMonth = base.getDate();
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();

  switch (repeat) {
    case "daily":
      return atLocalTime(year, month, day + 1, hour, minute);

    case "weekly":
      return atLocalTime(year, month, day + 7, hour, minute);

    case "monthly": {
      // 先跳到下个月的同一天。JS 在"1月31日 + 1个月"时会溢出到 3 月 3 日，
      // 这里夹到目标月的最后一天（2 月 28/29 日），
      // 否则用户设的"每月 31 日提醒"会在 2 月变成 3 月 3 日，非常反直觉。
      const target = localDate(year, month + 1, 1);
      const lastDay = localDate(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      return atLocalTime(
        target.getFullYear(),
        target.getMonth(),
        Math.min(dayOfMonth, lastDay),
        hour,
        minute,
      );
    }

    case "weekday": {
      // 跳过周六周日。用循环而不是判断两次，跨周时更稳。
      const probe = localDate(year, month, day + 1);
      while (probe.getDay() === 0 || probe.getDay() === 6) {
        probe.setDate(probe.getDate() + 1);
      }
      return atLocalTime(probe.getFullYear(), probe.getMonth(), probe.getDate(), hour, minute);
    }

    default:
      return null;
  }
}

/**
 * 从"现在"出发，算出某个重复规则的首次提醒时刻。
 *
 * 用于两处：
 * 1. 用户刚设好提醒时 —— 如果填的时刻已经过了，按规则推到下一次，
 *    而不是立刻弹一条过期提醒
 * 2. 重复提醒推进时的兜底 —— 系统时钟被回拨或长期休眠后，
 *    `nextOccurrence` 的结果可能仍在过去
 *
 * # 不变量：返回结果必定在 `now` 之后（`repeat === "none"` 除外）
 *
 * 这条不变量不能破。因为调度线程每 500ms 检查一次"到点没到点"，
 * 一旦返回一个过去时刻，提醒就会**反复触发**——用户会看到弹窗风暴。
 *
 * 所以循环上限给得很宽（两万次，覆盖五十多年的每日提醒），
 * 且循环耗尽时还有一层兜底，绝不允许把过去时刻返回出去。
 *
 * # 代价（别低估）
 *
 * "单次循环一毫秒量级"这个说法是**错的**：实测跑满两万次要 **56–96ms**
 * （工作日规则最慢）。所以调用方**不要**在渲染路径上每帧调它 ——
 * 备忘编辑器的预览必须 `useMemo` 到「日期/时刻/重复规则」这三个字段上，
 * 否则在正文里每敲一个字都要重付一次。
 */
export function firstOccurrence(
  wanted: number,
  repeat: RepeatValue,
  now: number = Date.now(),
): number {
  if (wanted > now) return wanted;
  // 不重复的提醒没有"下一次"可言：用户既然要这个时刻，就让他立刻收到
  if (repeat === "none") return wanted;

  let candidate = wanted;
  for (let i = 0; i < 20_000; i++) {
    const next = nextOccurrence(candidate, repeat);
    if (next === null) break;
    candidate = next;
    if (candidate > now) return candidate;
  }

  // 兜底：从"现在"重新起算。仍然保证落在未来。
  const fromNow = nextOccurrence(now, repeat);
  return fromNow !== null && fromNow > now ? fromNow : now + 1;
}
