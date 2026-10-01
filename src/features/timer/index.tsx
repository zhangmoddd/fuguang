/**
 * 计时器功能：倒计时 / 番茄钟 / 秒表 / 闹钟。
 *
 * # 为什么前端只管显示，不管计时
 *
 * 面板平时是隐藏的，隐藏的 WebView 里 `setInterval` 会被系统降频
 * （见 `src-tauri/src/scheduler.rs` 顶部的说明）。如果让前端自己数秒，
 * 倒计时会越走越慢、提醒会漏。
 *
 * 所以权威时钟在 Rust 侧，前端只做两件事：
 * 1. 把「开始 / 暂停 / 重置」算成**绝对时刻**写回去（`timerSave`）
 * 2. 每 100ms 用 `Date.now()` 重画一次剩余时间
 *
 * 两边共用同一个系统时钟，不做任何"剩余秒数"的传递，也就不会各算一套。
 *
 * # 四种模式共用一个 Timer 结构
 *
 * 靠 `kind` 区分，各自只用自己那部分字段（字段语义见 `src/lib/api.ts`）。
 * 它们混在同一个列表里，每条都有用户自己起的名字，运行中的排在最前面。
 *
 * # 闹钟与倒计时只差一个字段
 *
 * 倒计时设的是「多久之后」，闹钟设的是「几点」。到点之后的收尾两者完全一样，
 * 区别只在"下一次该在什么时候响"——那是日历运算，由 `lib/alarm.ts` 负责。
 * 闹钟刻意**不做暂停**：它的目标是墙上时钟的一个点，暂停一个绝对时刻没有意义，
 * 想今天不响就点「停止」。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlarmClock,
  Clock,
  Flag,
  FolderInput,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";

import { api, onStateChanged } from "../../lib/api";
import type { Folder as FolderItem, PomodoroPhase, Timer, TimerKind } from "../../lib/api";
import { formatClock, nextAlarmAt, parseClock } from "../../lib/alarm";
import { formatDuration, formatMoment, formatStopwatch } from "../../lib/datetime";
import {
  applyTimerEdit,
  createTimer as createTimerFrom,
  type TimerDraft,
} from "../../lib/timer-edit";
import { useDragSort } from "../../lib/drag-drop";
import {
  FolderBar,
  FolderEditor,
  FolderPicker,
  FolderTiles,
  useFolders,
} from "../../lib/folders-ui";
import { useZoom } from "../../lib/zoom";
import type { FeatureModule } from "../registry";

import "./timer.css";

/** 重画间隔。取 100ms 而不是 1s：秒表带百分秒，一秒一跳会明显发顿。 */
const TICK_MS = 100;

/**
 * 老数据（`durationMs` 为 null）的兜底时长。
 *
 * `durationMs` 是后补的字段：在它出现之前建的倒计时反序列化出来是 null，
 * 那种情况只能猜一个——暂停中的用剩余值，否则按 5 分钟算。
 * 新数据一律走 `durationMs`，不会再猜。
 */
const LEGACY_COUNTDOWN_MS = 5 * 60_000;

/** 卡片当前处于哪个状态。四种状态决定按钮组合，也决定排序。 */
type CardState = "idle" | "running" | "paused" | "done";

const KIND_LABEL: Record<TimerKind, string> = {
  countdown: "倒计时",
  pomodoro: "番茄钟",
  stopwatch: "秒表",
  alarm: "闹钟",
};

const STATE_LABEL: Record<CardState, string> = {
  idle: "未开始",
  running: "运行中",
  paused: "已暂停",
  done: "已完成",
};

/** 新建表单里的快捷时长，单位分钟。 */
const QUICK_MINUTES = [5, 10, 25, 60];

// ===============================================================
// 纯函数：状态判断与时间换算
// ===============================================================

/**
 * 这条计时器是否"正在走"。
 *
 * 秒表看 `runningSince`，倒计时与番茄钟看 `endsAt`。
 * `fired` 的倒计时在 Rust 侧已经把 `endsAt` 清空了，这里不用额外判断。
 */
function isRunning(t: Timer): boolean {
  if (t.kind === "stopwatch") return t.runningSince !== null;
  return t.endsAt !== null && !t.fired;
}

/** 排序：运行中的排最前，其余按创建时间倒序（刚新建的在上面）。 */
function sortTimers(list: Timer[]): Timer[] {
  return [...list].sort((a, b) => {
    const ra = isRunning(a) ? 1 : 0;
    const rb = isRunning(b) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return b.createdAt - a.createdAt;
  });
}

/** 把一条计时器并进列表：已存在就替换，否则插到最前面。 */
function upsert(list: Timer[], timer: Timer): Timer[] {
  return list.some((t) => t.id === timer.id)
    ? list.map((t) => (t.id === timer.id ? timer : t))
    : [timer, ...list];
}

/** 倒计时 / 番茄钟还剩多少毫秒：运行中按 `endsAt` 现算，暂停时用存下来的值。 */
function remainingOf(t: Timer, now: number): number {
  if (t.endsAt !== null) return Math.max(0, t.endsAt - now);
  return Math.max(0, t.remainingMs ?? 0);
}

/** 番茄钟当前阶段的时长。`phase` 为空按专注算（新建时写的就是 focus）。 */
function phaseMs(t: Timer): number {
  return (t.phase === "break" ? t.breakMinutes : t.focusMinutes) * 60_000;
}

/**
 * 倒计时的设定时长。
 *
 * 正常就是 `durationMs`——它是持久化字段，所以「重置」和「重新开始」
 * 都能拿回用户当初设的时长，软件重启也不会丢。
 * 只有老数据（该字段为 null）才需要临时猜一个值。
 */
function durationOf(t: Timer): number {
  if (t.durationMs !== null && t.durationMs > 0) return t.durationMs;
  if (t.remainingMs !== null && t.remainingMs > 0) return t.remainingMs;
  return LEGACY_COUNTDOWN_MS;
}

/** 秒表已用毫秒 = 已累计的那部分 + 正在跑的这一段。 */
function elapsedOf(t: Timer, now: number): number {
  const running = t.runningSince === null ? 0 : Math.max(0, now - t.runningSince);
  return t.elapsedMs + running;
}

/**
 * 判断卡片状态。
 *
 * 注意「未开始」和「暂停中」在字段上很像（都是 `endsAt` 为空），
 * 区别只在 `remainingMs` 有没有值：有值说明跑过一段、被暂停了。
 *
 * 闹钟只有三种状态：它没有「暂停」——目标是墙上时钟的一个绝对时刻，
 * 暂停它没有意义（要今天不响就点「停止」）。所以 `remainingMs` 对它无意义，
 * 响完之后必须停在「已完成」而不是被误判成「暂停」。
 */
function stateOf(t: Timer): CardState {
  if (t.kind === "stopwatch") {
    if (t.runningSince !== null) return "running";
    return t.elapsedMs > 0 ? "paused" : "idle";
  }
  if (t.kind === "alarm") {
    if (t.fired) return "done";
    return t.endsAt !== null ? "running" : "idle";
  }
  // fired 只对倒计时有意义：番茄钟到点时 Rust 会在同一个 tick 里
  // 把 phase / endsAt / fired 一起改好，不会停在"已完成"上
  // （见 src-tauri/src/scheduler.rs 的 Pomodoro 分支）。
  if (t.kind === "countdown" && t.fired) return "done";
  if (t.endsAt !== null) return "running";
  return t.remainingMs !== null ? "paused" : "idle";
}

/** 卡片中间那行大号时间。 */
function mainTime(t: Timer, state: CardState, now: number): string {
  if (t.kind === "stopwatch") return formatStopwatch(elapsedOf(t, now));
  if (t.kind === "alarm") {
    // 没在走的时候显示**用户设的那个钟点**——那才是这个闹钟的设定值，
    // 显示 00:00 什么也说明不了。走起来之后显示还要等多久，和倒计时一致。
    return state === "running" ? formatDuration(remainingOf(t, now)) : formatClock(t.alarmMinutes);
  }
  // 未开始的两种计时器显示"将会有多长"，比显示 00:00 有用：
  // 重置之后用户就是靠这个数字确认设定时长还在
  if (state === "idle") {
    return formatDuration(t.kind === "pomodoro" ? phaseMs(t) : durationOf(t));
  }
  return formatDuration(remainingOf(t, now));
}

/** 卡片上的小字：各模式自己有用的附加信息。 */
function metaOf(t: Timer, state: CardState): string {
  if (t.kind === "countdown") {
    // 把设定时长显示出来：用户重置之后能一眼确认"我要倒多久"没丢。
    // durationMs 为 null 的老数据不显示，免得把一个猜出来的值当成用户设定。
    const preset = t.durationMs === null ? "" : `设定 ${formatDuration(t.durationMs)}`;
    // 倒计时存的就是绝对结束时刻，运行中还要告诉用户"几点结束"
    if (state === "running" && t.endsAt !== null) {
      const ends = `结束于 ${formatMoment(t.endsAt)}`;
      return preset ? `${ends} · ${preset}` : ends;
    }
    if (state === "idle") return preset ? `${preset} · 尚未开始` : "";
    return preset;
  }
  if (t.kind === "pomodoro") {
    const phase = t.phase === "break" ? "休息" : "专注";
    return `${phase}阶段 · ${t.focusMinutes} 分专注 / ${t.breakMinutes} 分休息 · 已完成 ${t.rounds} 轮`;
  }
  if (t.kind === "alarm") {
    // 重复规则 + 钟点都要写出来：卡片上的大号数字在运行中会变成倒计时，
    // 不写这一行，用户就看不出自己当初设的是几点
    const rule = t.alarmDaily ? "每天" : "只响一次";
    const preset = `${rule} ${formatClock(t.alarmMinutes)}`;
    if (state === "running" && t.endsAt !== null) {
      return `${preset} · 响铃于 ${formatMoment(t.endsAt)}`;
    }
    if (state === "done") return `${preset} · 已响过`;
    return preset;
  }
  return t.laps.length > 0 ? `共 ${t.laps.length} 次计次` : "";
}

/** 用户没填名字时，按模式给一个能一眼看懂的名字。 */
function defaultName(
  kind: TimerKind,
  countdownMs: number,
  focusMinutes: number,
  breakMinutes: number,
  alarmMinutes: number,
): string {
  if (kind === "countdown") return `倒计时 ${formatDuration(countdownMs)}`;
  if (kind === "pomodoro") return `番茄钟 ${focusMinutes}/${breakMinutes}`;
  if (kind === "alarm") return `闹钟 ${formatClock(alarmMinutes)}`;
  return "秒表";
}

// ===============================================================
// 主界面
// ===============================================================

export function TimerPanel() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 新建表单是否打开。 */
  const [creating, setCreating] = useState(false);
  /**
   * 正在编辑的那条计时器。
   *
   * 和"新建"共用一个表单组件，靠这个字段区分：`null` = 新建。
   * 用户反馈「闹钟什么的都没法修改」—— 原来建好之后只能删了重建，
   * 连改个名字都没有入口。
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 文件夹弹层。`target` 为 `null` 表示新建，否则是改名/改备注。 */
  const [folderEditor, setFolderEditor] = useState<{
    open: boolean;
    target: FolderItem | null;
  }>({ open: false, target: null });
  /** 正在「移动到…」的那条计时器。 */
  const [movingId, setMovingId] = useState<string | null>(null);

  /**
   * 所有卡片共用的"现在"。
   *
   * 放在组件里统一推进，而不是每条卡片各自开一个定时器：
   * 同一个时刻重算，列表里几条计时器不会出现零点几秒的互相错位。
   */
  const [now, setNow] = useState(() => Date.now());

  /** 后端事件的退订函数。 */
  const unlisten = useRef<(() => void) | null>(null);

  /** 重新从后端拉全量列表。 */
  const reload = useCallback(async () => {
    try {
      setTimers(await api.timersList());
      setError(null);
    } catch (err) {
      setError(`读取失败：${String(err)}`);
    }
  }, []);

  // 首次加载 + 订阅后端变化
  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        const list = await api.timersList();
        if (!disposed) {
          setTimers(list);
          setError(null);
        }
      } catch (err) {
        if (!disposed) setError(`读取失败：${String(err)}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    // Rust 到点后会自己改数据（倒计时标记完成、番茄钟翻阶段），
    // 不订阅的话界面会一直停在旧状态，看起来像卡住了
    void onStateChanged((what) => {
      if (what.includes("timers")) void reload();
    }).then((off) => {
      // 订阅是异步的：回调到达时组件可能已经卸载，
      // 那就立刻退订，否则监听器会一直挂在后端上
      if (disposed) off();
      else unlisten.current = off;
    });

    return () => {
      disposed = true;
      unlisten.current?.();
      unlisten.current = null;
    };
  }, [reload]);

  // 每 100ms 推进一次"现在"，驱动所有卡片重画
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const ordered = useMemo(() => sortTimers(timers), [timers]);

  // ---- 文件夹与缩放 ----

  /**
   * 把本页签在 `from` 文件夹下的计时器改挂到 `to`。
   *
   * 只在删除文件夹时被调用。
   *
   * 这里刻意**先重新拉一次最新数据**再写：计时器在后台会被调度线程改
   * （倒计时到点标记完成、番茄钟翻阶段），拿界面上那份旧快照写回去
   * 会把那些改动冲掉——表现就是「到点了却又弹一次」。
   */
  const moveItems = useCallback(
    async (from: string, to: string | null) => {
      const fresh = await api.timersList();
      for (const t of fresh.filter((x) => x.folderId === from)) {
        await api.timerSave({ ...t, folderId: to });
      }
      await reload();
    },
    [reload],
  );

  const folders = useFolders("timer", { moveItems });
  const zoom = useZoom("timer");

  /**
   * 当前文件夹里的计时器。
   *
   * `folderId` 指向一个**不存在**的文件夹时按顶层处理：删文件夹中途失败、
   * 或用户手改过 JSON 都会留下这种条目。不兜的话它们会从界面上消失，
   * 而数据其实还在。
   */
  const visible = useMemo(() => {
    const known = new Set(folders.mine.map((f) => f.id));
    return ordered.filter((t) => {
      const folder = t.folderId && known.has(t.folderId) ? t.folderId : null;
      return folder === folders.currentId;
    });
  }, [ordered, folders.mine, folders.currentId]);

  /** 每个文件夹里有几条计时器，显示在文件夹卡片上（只算直接子级）。 */
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of timers) {
      if (t.folderId) counts[t.folderId] = (counts[t.folderId] ?? 0) + 1;
    }
    return counts;
  }, [timers]);

  /**
   * 每条计时器的写入队列。
   *
   * 每次 `timerSave` 带的是**完整快照**，而 Tauri 的 async 命令是在异步运行时上
   * 并发执行的：连续点「计次」连发两条命令时，后发的那条有可能先落库，
   * 于是后端留下旧快照（少一次计次）。按 id 串起来写，落库顺序就与点击顺序一致。
   */
  const writeQueue = useRef<Map<string, Promise<void>>>(new Map());

  /**
   * 落盘一条计时器。
   *
   * 先改本地再发命令：点「开始」要立刻看到变化，不能等一次 IPC 往返。
   * 万一命令失败，就把后端数据重新拉回来，避免界面显示一个其实没存下的状态。
   */
  const saveTimer = (timer: Timer) => {
    setTimers((prev) => upsert(prev, timer));

    const previous = writeQueue.current.get(timer.id) ?? Promise.resolve();
    const queued = previous
      // 上一条失败已经在自己的 catch 里处理过，这里只保证队列不断
      .catch(() => undefined)
      .then(() => api.timerSave(timer))
      .then(
        () => setError(null),
        (err) => {
          setError(`保存失败：${String(err)}`);
          void reload();
        },
      )
      .finally(() => {
        // 只有队尾还是自己时才清理，否则会把后来者的记录删掉
        if (writeQueue.current.get(timer.id) === queued) {
          writeQueue.current.delete(timer.id);
        }
      });

    writeQueue.current.set(timer.id, queued);
  };

  const removeTimer = async (id: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));

    // 删除必须排在同一个 id 的写入队列**后面**。
    //
    // 直接发命令的话，排队中的 `timerSave` 会在删除之后才落库，而
    // `timer_save` 是 upsert（找不到就 push）—— 已删除的计时器会**复活**：
    // 界面上看不到它（`timer_save` 不广播变化），但调度线程照样为它弹提醒，
    // 重启后它又回到列表里，用户还删不掉。
    // 触发条件很常见：连点两次「开始/计次」之后立刻点删除。
    const previous = writeQueue.current.get(id) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => api.timerRemove(id))
      .then(
        () => setError(null),
        (err) => {
          setError(`删除失败：${String(err)}`);
          void reload();
        },
      )
      .finally(() => {
        if (writeQueue.current.get(id) === queued) {
          writeQueue.current.delete(id);
        }
      });

    writeQueue.current.set(id, queued);
    await queued;
  };

  /**
   * 把一条计时器移到别的文件夹。`null` 表示移到顶层。
   *
   * 走 `saveTimer` 而不是直接调 `timerSave`：它带着按 id 串行的写入队列，
   * 和界面上的开始/暂停共用同一套落库顺序，失败时也会自动回滚界面状态。
   */
  const moveTo = (t: Timer, folderId: string | null) => {
    setMovingId(null);
    if ((t.folderId ?? null) === folderId) return;
    saveTimer({ ...t, folderId });
  };

  /**
   * 拖拽：把计时器放进文件夹，以及文件夹自己同级排序。
   *
   * **计时器之间不做手动排序**：这个列表的顺序是刻意自动排的
   * （运行中的在最前，其余按创建时间），正在跑的那条会自己往上冒。
   * 给某几条钉一个手动位置会和那套语义打架，所以这里用 `handleProps`
   * （能拖）而不是 `itemProps`（能当排序落点）。
   */
  const drag = useDragSort({
    axis: "vertical",
    onDrop: (draggedId, draggedKind, spot) => {
      if (draggedKind === "folder") {
        if (spot.kind === "item") void folders.reorder(draggedId, spot.id, spot.before);
        return;
      }
      if (spot.kind !== "folder") return;
      const target = timers.find((x) => x.id === draggedId);
      if (target) moveTo(target, spot.id);
    },
  });

  // ---- 倒计时 ----
  /**
   * 开始。也用于已完成（`fired`）的「重新开始」：两者都是"按设定时长重新跑一轮"。
   *
   * `fired` 必须清掉：Rust 只在 `fired === false` 时才会为这条再弹提醒。
   */
  const startCountdown = (t: Timer) => {
    saveTimer({
      ...t,
      endsAt: Date.now() + durationOf(t),
      remainingMs: null,
      fired: false,
    });
  };

  /**
   * 重置：回到「未开始」，但 `durationMs` 原样保留。
   *
   * 重置要清的是"这一轮的进度"，不是"用户当初设了多久"——
   * 丢掉时长的话，下次「开始」就只能瞎猜一个默认值。
   */
  const resetCountdown = (t: Timer) => {
    saveTimer({ ...t, endsAt: null, remainingMs: null, fired: false });
  };

  // ---- 倒计时与番茄钟共用的暂停 / 继续 ----

  /**
   * 暂停：把剩余毫秒写进 `remainingMs`，`endsAt` 置空。
   * 存"还剩多少"而不是"暂停了多久"，是因为继续时只需要拿它加当前时刻。
   */
  const pauseTimer = (t: Timer) => {
    const left = Math.max(0, (t.endsAt ?? Date.now()) - Date.now());
    saveTimer({ ...t, endsAt: null, remainingMs: left });
  };

  /** 继续：剩余毫秒换算成新的绝对结束时刻。 */
  const resumeTimer = (t: Timer) => {
    saveTimer({
      ...t,
      endsAt: Date.now() + Math.max(0, t.remainingMs ?? 0),
      remainingMs: null,
    });
  };

  // ---- 番茄钟 ----

  /**
   * 开始一个番茄钟。
   *
   * 只负责"从当前阶段开始跑"：阶段切换是 Rust 到点后自己做的
   * （见 `src-tauri/src/scheduler.rs`），前端绝不自己翻阶段，
   * 否则两边各翻一次会直接跳过休息。
   */
  const startPomodoro = (t: Timer) => {
    const phase: PomodoroPhase = t.phase ?? "focus";
    const length = (phase === "break" ? t.breakMinutes : t.focusMinutes) * 60_000;
    saveTimer({
      ...t,
      phase,
      endsAt: Date.now() + length,
      remainingMs: null,
      fired: false,
    });
  };

  /** 停止：回到「专注、未开始」。已完成轮数保留，它是这一次的成绩。 */
  const stopPomodoro = (t: Timer) => {
    saveTimer({ ...t, phase: "focus", endsAt: null, remainingMs: null, fired: false });
  };

  // ---- 闹钟 ----

  /**
   * 开始 / 重新响。
   *
   * 时刻由 `nextAlarmAt` 算：今天这个钟点还没到就是今天，过了就是明天。
   * 它保证结果**严格落在未来**——返回一个过去时刻会让调度线程每 500ms
   * 判定一次"到点"，变成弹窗风暴。
   */
  const startAlarm = (t: Timer) => {
    saveTimer({
      ...t,
      endsAt: nextAlarmAt(t.alarmMinutes),
      remainingMs: null,
      fired: false,
    });
  };

  /**
   * 停止：这一次不响了。
   *
   * 刻意**保留 `alarmMinutes`**：用户停的是"这一轮"，不是"把这个闹钟删了"，
   * 下次点「开始」还要用同一个钟点。
   */
  const stopAlarm = (t: Timer) => {
    saveTimer({ ...t, endsAt: null, remainingMs: null, fired: false });
  };

  // ---- 秒表 ----

  const startStopwatch = (t: Timer) => {
    saveTimer({ ...t, runningSince: Date.now() });
  };

  /**
   * 暂停秒表：把正在跑的这一段并进 `elapsedMs`。
   * `elapsedMs` 只存"已经攒下的"，正在跑的那段永远靠 `runningSince` 现算，
   * 这样即使界面被降频，恢复时也不会少算。
   */
  const pauseStopwatch = (t: Timer) => {
    const running = t.runningSince === null ? 0 : Math.max(0, Date.now() - t.runningSince);
    saveTimer({ ...t, elapsedMs: t.elapsedMs + running, runningSince: null });
  };

  /** 计次：把当前的已用时间记一笔。存的是累计值，不是分段差值。 */
  const lapStopwatch = (t: Timer) => {
    saveTimer({ ...t, laps: [...t.laps, elapsedOf(t, Date.now())] });
  };

  const resetStopwatch = (t: Timer) => {
    saveTimer({ ...t, elapsedMs: 0, runningSince: null, laps: [] });
  };

  /** 新建完成：收起表单并落盘。归属由面板决定（表单不知道用户在哪个文件夹里）。 */
  const createTimer = (draft: TimerDraft) => {
    setCreating(false);
    saveTimer({ ...createTimerFrom(draft, Date.now()), folderId: folders.currentId });
  };

  /**
   * 编辑完成：把表单结果应用到那条已有的计时器上。
   *
   * 规则（"改了设置之后原来跑到哪一步了怎么办"）全在 `applyTimerEdit` 里，
   * 有单测：只改名字不能打断正在跑的倒计时，改了时长要回到未开始，
   * 改闹钟钟点要按新钟点重排，等等。
   */
  const commitEdit = (draft: TimerDraft) => {
    const original = timers.find((t) => t.id === editingId);
    setEditingId(null);
    if (!original) return;
    saveTimer(applyTimerEdit(original, draft, Date.now()));
  };

  const editingTimer = editingId ? timers.find((t) => t.id === editingId) ?? null : null;

  return (
    <div
      className="tmr"
      // 滚轮监听挂在整页根节点上：鼠标停在工具栏、文件夹卡片上时也该能缩放。
      // 普通滚轮不受影响（见 lib/zoom.ts）。
      ref={zoom.ref}
      style={{ "--density": String(zoom.percent / 100) } as CSSProperties}
    >
      <div className="tmr__toolbar">
        <span className="tmr__count">
          {folders.currentId ? `本文件夹 ${visible.length} 条` : `共 ${timers.length} 条`}
        </span>
        <button
          className="btn btn--primary"
          onClick={() => {
            // 新建和编辑共用一个表单，别让两个同时开着
            setEditingId(null);
            setCreating((v) => !v);
          }}
        >
          <Plus size={13} />
          新建
        </button>
      </div>

      {creating && (
        <TimerCreator editing={null} onCancel={() => setCreating(false)} onSubmit={createTimer} />
      )}

      {/* 编辑表单挂在列表上方、滚动区外面：它在页面里是最要紧的东西，
          跟着列表滚上去会让用户找不到自己刚打开的表单 */}
      {editingTimer && (
        <TimerCreator
          // key 用 id：换一条编辑时强制重建表单，否则输入框里还是上一条的值
          key={editingTimer.id}
          editing={editingTimer}
          onCancel={() => setEditingId(null)}
          onSubmit={commitEdit}
        />
      )}

      {error && <div className="tmr__error">{error}</div>}

      {/* 当前路径。放在列表上方：先看到「我在哪」，再看这一层有什么 */}
      <div className="folderzone">
        <FolderBar
          trail={folders.trail}
          onEnter={folders.enter}
          onCreate={() => setFolderEditor({ open: true, target: null })}
        />

        {folderEditor.open && (
          <FolderEditor
            target={folderEditor.target}
            onSubmit={(name, note) =>
              folderEditor.target
                ? folders.update(folderEditor.target, name, note)
                : folders.create(name, note)
            }
            onClose={() => setFolderEditor({ open: false, target: null })}
          />
        )}
      </div>

      {folders.error && <div className="tmr__error">文件夹出错：{folders.error}</div>}

      <div className="tmr__list">
        {/* 子文件夹排在计时器前面，和资源管理器一致 */}
        <FolderTiles
          folders={folders.children}
          counts={folderCounts}
          dropTargetId={drag.over?.kind === "folder" ? drag.over.id : null}
          dragProps={(id) => drag.handleProps(id, "folder")}
          onEnter={folders.enter}
          onEdit={(f) => setFolderEditor({ open: true, target: f })}
          onRemove={(f) => void folders.remove(f)}
          variant="list"
        />

        {loading && <div className="tmr__empty">正在读取数据…</div>}

        {!loading && visible.length === 0 && folders.children.length === 0 && (
          <div className="tmr__empty">
            {timers.length === 0 ? (
              <>
                还没有任何计时器。
                <br />
                点右上角「新建」加一个：煮蛋的倒计时、一个番茄钟、一块秒表，
                或者一个到点叫你起床的闹钟。
              </>
            ) : (
              <>这个文件夹里还没有计时器。</>
            )}
          </div>
        )}

        {visible.map((t) => {
          const state = stateOf(t);
          const meta = metaOf(t, state);
          return (
            <article
              key={t.id}
              className={`card tmr__card${state === "running" ? " tmr__card--running" : ""}${
                drag.draggingId === t.id ? " drag-source" : ""
              }`}
              {...drag.handleProps(t.id)}
            >
              <div className="tmr__head">
                <span className="tmr__name">{t.name}</span>
                <span className="tmr__kind">{KIND_LABEL[t.kind]}</span>
                <span className={`tmr__state tmr__state--${state}`}>{STATE_LABEL[state]}</span>
              </div>

              <div className={`tmr__time tmr__time--${state}`}>{mainTime(t, state, now)}</div>

              {meta && <div className="tmr__meta">{meta}</div>}

              {t.kind === "stopwatch" && t.laps.length > 0 && (
                <div className="tmr__laps">
                  {/* 倒序取最近的几次：计时进行中，用户关心的是刚按下的那一次 */}
                  {t.laps
                    .slice(-5)
                    .reverse()
                    .map((ms, i) => (
                      <span key={t.laps.length - i} className="tmr__lap">
                        <em className="tmr__lap-index">#{t.laps.length - i}</em>
                        {formatStopwatch(ms)}
                      </span>
                    ))}
                </div>
              )}

              <div className="card__actions tmr__actions">
                {t.kind === "countdown" && (
                  <>
                    {state === "idle" && (
                      <button
                        className="btn btn--primary"
                        onClick={() => startCountdown(t)}
                        title="按设定的时长开始"
                      >
                        <Play size={12} />
                        开始
                      </button>
                    )}
                    {state === "running" && (
                      <>
                        <button className="btn" onClick={() => pauseTimer(t)} title="暂停，剩余时间会被记住">
                          <Pause size={12} />
                          暂停
                        </button>
                        <button className="btn" onClick={() => resetCountdown(t)} title="清空进度，回到未开始">
                          <RotateCcw size={12} />
                          重置
                        </button>
                      </>
                    )}
                    {state === "paused" && (
                      <>
                        <button className="btn btn--primary" onClick={() => resumeTimer(t)} title="从暂停处接着走">
                          <Play size={12} />
                          继续
                        </button>
                        <button className="btn" onClick={() => resetCountdown(t)} title="清空进度，回到未开始">
                          <RotateCcw size={12} />
                          重置
                        </button>
                      </>
                    )}
                    {state === "done" && (
                      <button
                        className="btn btn--primary"
                        onClick={() => startCountdown(t)}
                        title="按原来的时长再来一次"
                      >
                        <Play size={12} />
                        重新开始
                      </button>
                    )}
                  </>
                )}

                {t.kind === "pomodoro" && (
                  <>
                    {state === "idle" && (
                      <button
                        className="btn btn--primary"
                        onClick={() => startPomodoro(t)}
                        title="开始当前阶段，到点后由后端自动切换专注/休息"
                      >
                        <Play size={12} />
                        开始
                      </button>
                    )}
                    {state === "running" && (
                      <>
                        <button className="btn" onClick={() => pauseTimer(t)} title="暂停，剩余时间会被记住">
                          <Pause size={12} />
                          暂停
                        </button>
                        <button className="btn" onClick={() => stopPomodoro(t)} title="停止这一轮，回到专注阶段">
                          <Square size={12} />
                          停止
                        </button>
                      </>
                    )}
                    {state === "paused" && (
                      <>
                        <button className="btn btn--primary" onClick={() => resumeTimer(t)} title="从暂停处接着走">
                          <Play size={12} />
                          继续
                        </button>
                        <button className="btn" onClick={() => stopPomodoro(t)} title="停止这一轮，回到专注阶段">
                          <Square size={12} />
                          停止
                        </button>
                      </>
                    )}
                  </>
                )}

                {t.kind === "alarm" && (
                  <>
                    {state === "idle" && (
                      <button
                        className="btn btn--primary"
                        onClick={() => startAlarm(t)}
                        title="开始等这个钟点（今天已经过了就是明天）"
                      >
                        <Play size={12} />
                        开始
                      </button>
                    )}
                    {state === "running" && (
                      <button
                        className="btn"
                        onClick={() => stopAlarm(t)}
                        title="这一次不响了。钟点会留着，下次「开始」还用同一个时间"
                      >
                        <Square size={12} />
                        停止
                      </button>
                    )}
                    {state === "done" && (
                      <button
                        className="btn btn--primary"
                        onClick={() => startAlarm(t)}
                        title="按同一个钟点再排一次（今天已经过了就是明天）"
                      >
                        <AlarmClock size={12} />
                        再响一次
                      </button>
                    )}
                  </>
                )}

                {t.kind === "stopwatch" && (
                  <>
                    {state === "idle" && (
                      <button className="btn btn--primary" onClick={() => startStopwatch(t)} title="开始计时">
                        <Play size={12} />
                        开始
                      </button>
                    )}
                    {state === "running" && (
                      <>
                        <button className="btn" onClick={() => pauseStopwatch(t)} title="暂停计时">
                          <Pause size={12} />
                          暂停
                        </button>
                        <button className="btn" onClick={() => lapStopwatch(t)} title="记下当前用时">
                          <Flag size={12} />
                          计次
                        </button>
                      </>
                    )}
                    {state === "paused" && (
                      <>
                        <button className="btn btn--primary" onClick={() => startStopwatch(t)} title="接着计时">
                          <Play size={12} />
                          继续
                        </button>
                        <button className="btn" onClick={() => resetStopwatch(t)} title="清零并清空计次">
                          <RotateCcw size={12} />
                          重置
                        </button>
                      </>
                    )}
                  </>
                )}

                <button
                  className="iconbtn"
                  onClick={() => {
                    setCreating(false);
                    setEditingId(t.id);
                  }}
                  title="编辑名字、时长 / 钟点 / 节奏"
                >
                  <Pencil size={13} />
                </button>

                <button
                  className="iconbtn"
                  onClick={() => setMovingId(t.id)}
                  title="移动到文件夹"
                >
                  <FolderInput size={13} />
                </button>

                <button
                  className="iconbtn iconbtn--danger tmr__delete"
                  onClick={() => void removeTimer(t.id)}
                  title="删除"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {movingId && (
        <FolderPicker
          folders={folders.mine}
          current={timers.find((t) => t.id === movingId)?.folderId ?? null}
          onPick={(id) => {
            const target = timers.find((t) => t.id === movingId);
            if (target) moveTo(target, id);
            else setMovingId(null);
          }}
          onClose={() => setMovingId(null)}
        />
      )}
    </div>
  );
}

// ===============================================================
// 新建表单
// ===============================================================

/**
 * 新建计时器的表单。
 *
 * 四种模式共用一套输入框，靠 `kind` 决定显示哪几个：
 * 时长只在倒计时上有意义，节奏只在番茄钟上有意义，钟点只在闹钟上有意义，
 * 秒表只需要名字。
 *
 * 倒计时的时长会被写进 `durationMs`、闹钟的钟点会被写进 `alarmMinutes`，
 * 两者都持久化下来，所以「重置」「停止」之后再开始用的还是用户当初设的值，
 * 不靠任何内存记忆。
 */
function TimerCreator({
  editing,
  onSubmit,
  onCancel,
}: {
  /** 正在编辑的那条；`null` 表示新建。 */
  editing: Timer | null;
  /** 表单填好了。新建和编辑都走这一个出口，落地规则在 `lib/timer-edit.ts`。 */
  onSubmit: (draft: TimerDraft) => void;
  onCancel: () => void;
}) {
  // 编辑时把已有的设定填回输入框：打开表单看到的必须是"现在是什么样"，
  // 否则用户一保存就把没显示出来的值覆盖掉了。
  const [kind, setKind] = useState<TimerKind>(editing?.kind ?? "countdown");
  const [name, setName] = useState(editing?.name ?? "");
  // 时长用字符串存：输入框允许中途为空（清空重输），数字类型做不到这一点
  const initialMs = editing?.durationMs ?? 5 * 60_000;
  const [hours, setHours] = useState(String(Math.floor(initialMs / 3_600_000)));
  const [minutes, setMinutes] = useState(String(Math.floor((initialMs % 3_600_000) / 60_000)));
  const [seconds, setSeconds] = useState(String(Math.floor((initialMs % 60_000) / 1000)));
  const [focus, setFocus] = useState(String(editing?.focusMinutes ?? 25));
  const [rest, setRest] = useState(String(editing?.breakMinutes ?? 5));
  /** 闹钟的钟点，`HH:MM`（`<input type="time">` 给的就是这个形状）。 */
  const [alarmTime, setAlarmTime] = useState(
    formatClock(editing?.alarmMinutes ?? 7 * 60 + 30),
  );
  /** 闹钟是否每天重复。默认只响一次：默认每天响会让人被自己没设过的闹钟吵醒。 */
  const [alarmDaily, setAlarmDaily] = useState(editing?.alarmDaily ?? false);
  const nameRef = useRef<HTMLInputElement>(null);

  // 打开表单就聚焦名字：填名字是唯一的必填项
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  /** 把输入框里的字符串转成非负整数，空串或乱输入都算 0。 */
  const toInt = (value: string): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const countdownMs = (toInt(hours) * 3600 + toInt(minutes) * 60 + toInt(seconds)) * 1000;
  const focusMinutes = toInt(focus);
  const restMinutes = toInt(rest);
  // 输入框被清空时 `parseClock` 返回 null，这里退回 0 点只是为了有个数字可传；
  // 「创建」按钮由下面的 `valid` 拦住，不会真的建出一个 00:00 的闹钟
  const alarmMinutes = parseClock(alarmTime) ?? 0;

  const valid =
    kind === "countdown"
      ? countdownMs > 0
      : kind === "pomodoro"
        ? focusMinutes > 0 && restMinutes > 0
        : kind === "alarm"
          ? parseClock(alarmTime) !== null
          : true;

  /** 「创建」被禁用时告诉用户为什么。按钮可用时是空串（不给可用按钮挂误导性提示）。 */
  const invalidHint = valid
    ? ""
    : kind === "countdown"
      ? "时长需要大于 0"
      : kind === "alarm"
        ? "请填一个 00:00 ~ 23:59 的时间"
        : "";

  /** 快捷时长：直接改写时/分/秒三个输入框，用户还能接着微调。 */
  const useQuick = (totalMinutes: number) => {
    setHours(String(Math.floor(totalMinutes / 60)));
    setMinutes(String(totalMinutes % 60));
    setSeconds("0");
  };

  const submit = () => {
    onSubmit({
      name:
        name.trim() ||
        defaultName(kind, countdownMs, focusMinutes, restMinutes, alarmMinutes),
      kind,
      durationMs: countdownMs,
      focusMinutes,
      breakMinutes: restMinutes,
      alarmMinutes,
      alarmDaily,
    });
  };

  return (
    <div className="tmr__creator">
      <div className="tmr__creator-head">
        {editing ? `编辑计时器 · ${KIND_LABEL[kind]}` : "新建计时器"}
      </div>

      {/* 模式选择只在新建时给。编辑时不让换类型：换类型等于换一条计时器
          （字段语义全不一样：倒计时看时长、闹钟看钟点），真要做应该是删掉重建。 */}
      {!editing && (
        <div className="tmr__kinds">
          {(["countdown", "pomodoro", "stopwatch", "alarm"] as TimerKind[]).map((k) => (
            <button
              key={k}
              className={`btn tmr__kindbtn${k === kind ? " tmr__kindbtn--on" : ""}`}
              onClick={() => setKind(k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      <label className="field">
        <span className="field__label">
          名字
          <em className="field__hint">留空会按模式自动起一个</em>
        </span>
        <input
          ref={nameRef}
          className="field__input"
          value={name}
          placeholder="例如：煮蛋、开会、跑步"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      {kind === "countdown" && (
        <>
          <div className="field">
            <span className="field__label">
              时长
              <em className="field__hint">时 / 分 / 秒</em>
            </span>
            <div className="tmr__segment">
              <input
                className="field__input"
                type="number"
                min={0}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
              <span className="tmr__unit">时</span>
              <input
                className="field__input"
                type="number"
                min={0}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
              <span className="tmr__unit">分</span>
              <input
                className="field__input"
                type="number"
                min={0}
                value={seconds}
                onChange={(e) => setSeconds(e.target.value)}
              />
              <span className="tmr__unit">秒</span>
            </div>
          </div>

          <div className="tmr__quickrow">
            {QUICK_MINUTES.map((m) => (
              <button key={m} className="btn tmr__quick" onClick={() => useQuick(m)}>
                {m === 60 ? "1 小时" : `${m} 分钟`}
              </button>
            ))}
          </div>
        </>
      )}

      {kind === "pomodoro" && (
        <div className="field">
          <span className="field__label">
            节奏
            <em className="field__hint">到点后由后端自动在专注与休息之间循环</em>
          </span>
          <div className="tmr__segment">
            <span className="tmr__unit">专注</span>
            <input
              className="field__input"
              type="number"
              min={1}
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
            />
            <span className="tmr__unit">分 · 休息</span>
            <input
              className="field__input"
              type="number"
              min={1}
              value={rest}
              onChange={(e) => setRest(e.target.value)}
            />
            <span className="tmr__unit">分</span>
          </div>
        </div>
      )}

      {kind === "stopwatch" && (
        <div className="tmr__hint">秒表只需要一个名字，开始后可以随时计次。</div>
      )}

      {kind === "alarm" && (
        <>
          <label className="field">
            <span className="field__label">
              响铃时间
              <em className="field__hint">今天这个点已经过了就明天响</em>
            </span>
            <input
              className="field__input tmr__clock"
              type="time"
              value={alarmTime}
              onChange={(e) => setAlarmTime(e.target.value)}
            />
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={alarmDaily}
              onChange={(e) => setAlarmDaily(e.target.checked)}
            />
            <span>每天这个时间都响</span>
          </label>
        </>
      )}

      <div className="tmr__creator-actions">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn btn--primary"
          onClick={submit}
          disabled={!valid}
          title={invalidHint}
        >
          {/* 倒计时和闹钟是"建好即开始"，按钮上写清楚，
              免得用户以为还要再点一次开始。编辑时只是保存设置。 */}
          {editing
            ? "保存"
            : kind === "countdown" || kind === "alarm"
              ? "创建并开始"
              : "创建"}
        </button>
      </div>
    </div>
  );
}

/** 注册到功能表。 */
export const TimerFeature: FeatureModule = {
  id: "timer",
  title: "计时",
  description: "倒计时、番茄钟、秒表、闹钟",
  icon: Clock,
  order: 20,
  component: TimerPanel,
};
