/**
 * 计时器编辑规则的测试。
 *
 * 重点全在"改了设置之后，原来跑到哪一步了该怎么办"——
 * 这几种组合手点很难点全（要先把倒计时跑起来、再改时长、再看它有没有被打断），
 * 而搞错了的后果是"正在跑的计时器被悄悄重置"或者"改完闹钟还是老时间响"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Timer, TimerKind } from "./api";

const { newId } = vi.hoisted(() => ({ newId: vi.fn(() => "new-id") }));
vi.mock("./api", () => ({ newId }));

import { applyTimerEdit, createTimer, type TimerDraft } from "./timer-edit";

/** 基准时刻：固定值，测试不会随运行时间漂移。 */
const NOW = new Date(2026, 4, 20, 9, 0, 0, 0).getTime();

function timer(over: Partial<Timer> = {}): Timer {
  return {
    id: "t1",
    name: "原名",
    kind: "countdown",
    endsAt: null,
    remainingMs: null,
    durationMs: 5 * 60_000,
    phase: null,
    focusMinutes: 25,
    breakMinutes: 5,
    rounds: 0,
    elapsedMs: 0,
    runningSince: null,
    laps: [],
    alarmMinutes: 450,
    alarmDaily: false,
    fired: false,
    folderId: null,
    createdAt: 1,
    ...over,
  };
}

function draft(over: Partial<TimerDraft> = {}): TimerDraft {
  return {
    name: "原名",
    kind: "countdown",
    durationMs: 5 * 60_000,
    focusMinutes: 25,
    breakMinutes: 5,
    alarmMinutes: 450,
    alarmDaily: false,
    ...over,
  };
}

describe("applyTimerEdit", () => {
  beforeEach(() => newId.mockClear());

  it("只改名字时，正在跑的倒计时一点都不能动", () => {
    // 用户给一个跑了两小时的倒计时改个名字，结果它被重置了 —— 那是事故
    const running = timer({ endsAt: NOW + 3_600_000, durationMs: 7_200_000 });
    const next = applyTimerEdit(running, draft({ name: "新名字", durationMs: 7_200_000 }), NOW);

    expect(next.name).toBe("新名字");
    expect(next.endsAt).toBe(running.endsAt);
    expect(next.durationMs).toBe(running.durationMs);
    expect(next.remainingMs).toBeNull();
  });

  it("旧数据带毫秒尾巴时，打开编辑框直接保存不会重置它", () => {
    // 表单只有时/分/秒。一个手改出来的 90500ms 在表单里是 1:30:00，
    // 按毫秒比较会判成"改过" → 用户什么都没动却把正在跑的计时器重置了。
    // 所以比较要按秒。
    const running = timer({ endsAt: NOW + 60_000, durationMs: 90_500 });
    const next = applyTimerEdit(running, draft({ durationMs: 90_000 }), NOW);

    expect(next.endsAt).toBe(running.endsAt);
    expect(next.durationMs).toBe(90_500);
  });

  it("改了倒计时时长 → 回到未开始", () => {
    const running = timer({ endsAt: NOW + 60_000, durationMs: 5 * 60_000 });
    const next = applyTimerEdit(running, draft({ durationMs: 10 * 60_000 }), NOW);

    expect(next.durationMs).toBe(10 * 60_000);
    expect(next.endsAt).toBeNull();
    expect(next.remainingMs).toBeNull();
    expect(next.fired).toBe(false);
  });

  it("暂停中的倒计时改了时长也会回到未开始", () => {
    // 不清 remainingMs 的话，卡片会显示「已暂停」+ 旧剩余时间，
    // 点「继续」跑的还是旧时长
    const paused = timer({ remainingMs: 30_000, durationMs: 5 * 60_000 });
    const next = applyTimerEdit(paused, draft({ durationMs: 60_000 }), NOW);

    expect(next.remainingMs).toBeNull();
    expect(next.endsAt).toBeNull();
  });

  it("时长填成和原来一样时什么都不动", () => {
    // 用户只是打开看了看又保存，不该把正在跑的计时器重置掉
    const running = timer({ endsAt: NOW + 60_000 });
    const next = applyTimerEdit(running, draft(), NOW);
    expect(next).toEqual(running);
  });

  it("只改名字时，正在跑的番茄钟也不能动", () => {
    const running = timer({
      kind: "pomodoro",
      phase: "break",
      endsAt: NOW + 60_000,
      rounds: 3,
    });
    const next = applyTimerEdit(running, draft({ kind: "pomodoro", name: "新" }), NOW);

    expect(next.name).toBe("新");
    expect(next.phase).toBe("break");
    expect(next.endsAt).toBe(running.endsAt);
    expect(next.rounds).toBe(3);
  });

  it("改了番茄钟节奏 → 回到专注未开始", () => {
    const running = timer({ kind: "pomodoro", phase: "break", endsAt: NOW + 60_000, rounds: 3 });
    const next = applyTimerEdit(
      running,
      draft({ kind: "pomodoro", focusMinutes: 50, breakMinutes: 10 }),
      NOW,
    );

    expect(next.focusMinutes).toBe(50);
    expect(next.breakMinutes).toBe(10);
    expect(next.phase).toBe("focus");
    expect(next.endsAt).toBeNull();
    // 轮数是"这一次的成绩"，不该因为改节奏被清掉
    expect(next.rounds).toBe(3);
  });

  it("正排着的闹钟改了钟点 → 按新钟点重排", () => {
    // 不重排的话，用户改完时间会发现第二天还是老时间响
    const armed = timer({
      kind: "alarm",
      alarmMinutes: 450, // 07:30
      endsAt: new Date(2026, 4, 21, 7, 30).getTime(),
    });
    const next = applyTimerEdit(armed, draft({ kind: "alarm", alarmMinutes: 8 * 60 }), NOW);

    expect(next.alarmMinutes).toBe(480);
    expect(next.endsAt).not.toBeNull();
    const d = new Date(next.endsAt as number);
    expect([d.getHours(), d.getMinutes()]).toEqual([8, 0]);
    // 今天 8 点还没到（基准是 9 点）→ 排到明天
    expect(next.endsAt as number).toBeGreaterThan(NOW);
  });

  it("停掉的闹钟改了钟点不会自己排上", () => {
    // 用户明确停过它。悄悄替他排上，第二天会被一个他没开的闹钟吵醒
    const stopped = timer({ kind: "alarm", alarmMinutes: 450, endsAt: null, fired: false });
    const next = applyTimerEdit(stopped, draft({ kind: "alarm", alarmMinutes: 8 * 60 }), NOW);

    expect(next.alarmMinutes).toBe(480);
    expect(next.endsAt).toBeNull();
  });

  it("已响过的闹钟改了钟点也不会自己排上", () => {
    const done = timer({ kind: "alarm", alarmMinutes: 450, endsAt: null, fired: true });
    const next = applyTimerEdit(done, draft({ kind: "alarm", alarmMinutes: 8 * 60 }), NOW);

    expect(next.endsAt).toBeNull();
    // 「已响过」这个状态要保留，用户自己会点「再响一次」
    expect(next.fired).toBe(true);
  });

  it("只把闹钟从「只响一次」改成「每天」也算改动 → 正排着就重排", () => {
    const armed = timer({
      kind: "alarm",
      alarmMinutes: 450,
      alarmDaily: false,
      endsAt: new Date(2026, 4, 21, 7, 30).getTime(),
    });
    const next = applyTimerEdit(armed, draft({ kind: "alarm", alarmDaily: true }), NOW);

    expect(next.alarmDaily).toBe(true);
    expect(next.endsAt).not.toBeNull();
  });

  it("秒表只改名字，计时一秒都不能丢", () => {
    const running = timer({ kind: "stopwatch", elapsedMs: 12_345, runningSince: NOW - 5_000, laps: [1, 2] });
    const next = applyTimerEdit(running, draft({ kind: "stopwatch", name: "跑步" }), NOW);

    expect(next.name).toBe("跑步");
    expect(next.elapsedMs).toBe(12_345);
    expect(next.runningSince).toBe(running.runningSince);
    expect(next.laps).toEqual([1, 2]);
  });

  it("不改动 kind：表单里没有这个入口，传进来也不认", () => {
    // 换类型等于换一条计时器，字段语义全不一样。真要做应该是"删掉重建"。
    const c = timer({ kind: "countdown" });
    const next = applyTimerEdit(c, draft({ kind: "alarm", alarmMinutes: 100 }), NOW);
    expect(next.kind).toBe("countdown");
    // 钟点也不会被写进去（倒计时根本不用它）
    expect(next.alarmMinutes).toBe(c.alarmMinutes);
  });

  it("不动运行状态之外的字段（分类、创建时间、id）", () => {
    const t = timer({ folderId: "f1", createdAt: 999 });
    const next = applyTimerEdit(t, draft({ name: "x" }), NOW);
    expect(next.id).toBe(t.id);
    expect(next.folderId).toBe("f1");
    expect(next.createdAt).toBe(999);
  });
});

describe("createTimer", () => {
  beforeEach(() => newId.mockClear());

  it("倒计时建好即开始，且把设定时长单独存下来", () => {
    const t = createTimer(draft({ kind: "countdown", durationMs: 90_000, name: "煮蛋" }), NOW);
    expect(t.endsAt).toBe(NOW + 90_000);
    expect(t.durationMs).toBe(90_000);
    expect(t.name).toBe("煮蛋");
    expect(t.fired).toBe(false);
    expect(t.folderId).toBeNull();
    expect(t.createdAt).toBe(NOW);
  });

  it("闹钟建好即开始，排在下一个该响的时刻", () => {
    // 基准 09:00，闹钟 07:30 → 今天已经过了，排到明天
    const t = createTimer(draft({ kind: "alarm", alarmMinutes: 450, alarmDaily: true }), NOW);
    const d = new Date(t.endsAt as number);
    expect([d.getHours(), d.getMinutes()]).toEqual([7, 30]);
    expect(t.endsAt as number).toBeGreaterThan(NOW);
    expect(t.alarmMinutes).toBe(450);
    expect(t.alarmDaily).toBe(true);
  });

  it("番茄钟和秒表建出来是未开始", () => {
    for (const kind of ["pomodoro", "stopwatch"] as TimerKind[]) {
      const t = createTimer(draft({ kind }), NOW);
      expect(t.endsAt).toBeNull();
      expect(t.remainingMs).toBeNull();
    }
  });

  it("番茄钟的节奏写进去，别的模式给默认值", () => {
    const p = createTimer(draft({ kind: "pomodoro", focusMinutes: 50, breakMinutes: 10 }), NOW);
    expect(p.focusMinutes).toBe(50);
    expect(p.breakMinutes).toBe(10);
    expect(p.phase).toBe("focus");

    const c = createTimer(draft({ kind: "countdown" }), NOW);
    expect(c.focusMinutes).toBe(25);
    expect(c.breakMinutes).toBe(5);
    expect(c.durationMs).toBe(5 * 60_000);
  });

  it("闹钟的钟点只对闹钟生效", () => {
    const c = createTimer(draft({ kind: "countdown", alarmMinutes: 100 }), NOW);
    expect(c.alarmMinutes).toBe(0);
    expect(c.alarmDaily).toBe(false);
  });
});
