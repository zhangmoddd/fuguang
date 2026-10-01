/**
 * 「把已弹过的重复提醒推进到下一次」的测试。
 *
 * # 为什么这个文件非有不可
 *
 * 这段逻辑被独立审查抓出过**两次**：
 *
 * 1. 它原本只在前端备忘页的挂载逻辑里跑，而主面板只挂载当前页签、默认页签不是备忘 ——
 *    用户不打开备忘页时推进永远不发生，**重复提醒永久静默**；
 * 2. 搬到这里之后加了"失败退避重试"，但 `advanceRepeats` 把写盘异常吞掉后
 *    **正常返回**，外层 `try/catch` 根本捕获不到 —— 重试一次都不会触发，
 *    而它注释里承诺的正是"没写成功就重试几次"。
 *
 * 两次都是"没有测试兜住契约"的直接后果，所以这里把契约钉死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Memo } from "./api";

// `vi.mock` 会被提升到文件顶部，所以 mock 必须用 `vi.hoisted` 定义
const { memoSave, memosList } = vi.hoisted(() => ({
  memoSave: vi.fn(),
  memosList: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { memoSave, memosList },
}));

import { advanceRepeats, advanceRepeatsOnce } from "./repeat-advance";

/** 造一条"已经被 Rust 弹过窗、且需要重复"的备忘。 */
function dueMemo(over: Partial<Memo> = {}): Memo {
  // 固定在一个明确的过去时刻：断言不看"今天"，换时区跑也稳
  const at = Date.UTC(2026, 0, 1, 9, 0);
  return {
    id: "m1",
    date: "2026-01-01",
    title: "测试备忘",
    body: "",
    tags: [],
    remindAt: at,
    repeat: "daily",
    // firedFor === remindAt 就是"Rust 已经为这个时刻弹过窗了"的标志
    firedFor: at,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

describe("advanceRepeats", () => {
  beforeEach(() => {
    memoSave.mockReset();
    memosList.mockReset();
    memoSave.mockResolvedValue(undefined);
  });

  it("没有到期的重复提醒时什么都不做", async () => {
    // firedFor 为 null 表示还没弹过，不该推进
    const result = await advanceRepeats([dueMemo({ firedFor: null })]);
    expect(result).toEqual({ saved: [], failed: 0 });
    expect(memoSave).not.toHaveBeenCalled();
  });

  it("把已弹过且需要重复的推进到下一次，并清掉 firedFor", async () => {
    const result = await advanceRepeats([dueMemo()]);

    expect(result.failed).toBe(0);
    expect(result.saved).toHaveLength(1);

    const sent = memoSave.mock.calls[0][0] as Memo;
    expect(sent.firedFor).toBeNull();
    expect(sent.remindAt).toBeGreaterThan(Date.now());
    expect(sent.remindAt).not.toBe(dueMemo().remindAt);
  });

  it("只提醒一次的备忘刻意不动", async () => {
    // repeat === "none" 时保持 firedFor === remindAt 反而是好事：
    // Rust 侧的幂等判断会因此永远不会为它再弹第二次
    const result = await advanceRepeats([dueMemo({ repeat: "none" })]);
    expect(result).toEqual({ saved: [], failed: 0 });
    expect(memoSave).not.toHaveBeenCalled();
  });

  it("恰好推进一个周期，不是两个", async () => {
    // 基准用"刚刚过去"而不是固定的远期过去时刻：后者会让 firstOccurrence
    // 把结果再往前滚很多天，于是"推一个周期"和"推两个周期"算出来**同一个值** ——
    // 变异验证时把代码改成连推两次，测试全绿（那对这个规则是等价变换）。
    // 基准贴近现在，结果就正好落在一个周期之后，多推一次看得出来。
    const base = Date.now() - 1000;
    const result = await advanceRepeats([
      dueMemo({ remindAt: base, firedFor: base }),
    ]);
    expect(result.failed).toBe(0);

    const sent = memoSave.mock.calls[0][0] as Memo;
    expect(sent.remindAt).not.toBeNull();
    const delta = (sent.remindAt as number) - base;
    const hour = 3600 * 1000;
    // 每日规则的一个周期是 23/24/25 小时（夏令时），留足余量；
    // 推两个周期会是 ~48 小时，落不进来
    expect(delta).toBeGreaterThan(20 * hour);
    expect(delta).toBeLessThan(28 * hour);
  });

  it("写盘失败必须计数，不能只是交给 onError", async () => {
    // 后台调用方（应用入口）**不传** onError，它只能靠 `failed` 知道要重试。
    // 只报 onError 的话，重试永远不会触发 —— 上一批就是这么错的。
    memoSave.mockRejectedValue(new Error("磁盘忙"));
    const onError = vi.fn();

    const result = await advanceRepeats([dueMemo()], onError);

    expect(result.saved).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("一条失败不影响其余几条的推进", async () => {
    memoSave
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValue(undefined);

    const result = await advanceRepeats([
      dueMemo({ id: "a" }),
      dueMemo({ id: "b" }),
    ]);

    expect(result.failed).toBe(1);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].id).toBe("b");
  });
});

describe("advanceRepeatsOnce（后台调用方）", () => {
  beforeEach(() => {
    memoSave.mockReset();
    memosList.mockReset();
  });

  it("没有失败时只跑一次", async () => {
    memosList.mockResolvedValue([dueMemo()]);
    memoSave.mockResolvedValue(undefined);

    await advanceRepeatsOnce();

    expect(memosList).toHaveBeenCalledTimes(1);
    expect(memoSave).toHaveBeenCalledTimes(1);
  });

  it("写盘失败会真的重试（这是上一批没做到的那条）", async () => {
    memosList.mockResolvedValue([dueMemo()]);
    memoSave
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValue(undefined);

    await advanceRepeatsOnce();

    // 第一次失败 → 退避 500ms 后重试 → 成功
    expect(memosList).toHaveBeenCalledTimes(2);
    expect(memoSave).toHaveBeenCalledTimes(2);
  });
});
