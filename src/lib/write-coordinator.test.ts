import { describe, expect, it } from "vitest";

import { WriteCoordinator } from "./write-coordinator";

describe("WriteCoordinator", () => {
  it("没有改动时不该发起写盘", () => {
    const c = new WriteCoordinator();
    expect(c.dirty).toBe(false);
    expect(c.begin()).toBeNull();
  });

  it("改动后能发起一次写盘，写成功就不再是脏的", () => {
    const c = new WriteCoordinator();
    c.markDirty();

    const writing = c.begin();
    expect(writing).not.toBeNull();

    // 写盘期间没有新改动 → 不需要再写
    expect(c.commit(writing as number)).toBe(false);
    expect(c.dirty).toBe(false);
    expect(c.begin()).toBeNull();
  });

  it("写盘飞行期间的新改动不会被吞掉（这就是原来的 bug）", () => {
    const c = new WriteCoordinator();
    c.markDirty(); // 第一次改动 A
    const writing = c.begin();

    c.markDirty(); // 写 A 的过程中用户又改了 → B

    // 关键：commit 必须告诉调用方"还得再写一次"。
    // 旧实现是 `dirty = false` 无条件清掉，于是 B 永远落不了盘。
    expect(c.commit(writing as number)).toBe(true);
    expect(c.dirty).toBe(true);

    // 再写一次，这次能写干净
    const second = c.begin();
    expect(second).not.toBeNull();
    expect(c.commit(second as number)).toBe(false);
    expect(c.dirty).toBe(false);
  });

  it("连续多次改动只写最后一版，且写完后彻底干净", () => {
    const c = new WriteCoordinator();
    c.markDirty();
    c.markDirty();
    c.markDirty();

    const writing = c.begin();
    expect(writing).toBe(3);

    // 三次改动被一次写盘覆盖掉，这是防抖的本意，不算丢数据
    expect(c.commit(writing as number)).toBe(false);
    expect(c.dirty).toBe(false);
  });

  it("写盘失败后调用 fail()，下一次还能重试", () => {
    const c = new WriteCoordinator();
    c.markDirty();
    const writing = c.begin();

    // 写失败：调用方必须调 fail() 解除"在飞"标记（只解标记，不动 written）
    c.fail();
    expect(c.dirty).toBe(true);
    expect(c.begin()).toBe(writing);
  });

  it("已经有写盘在飞时，第二次 begin 必须被挡住", () => {
    // 这是"两次写盘重叠"的入口。不挡住的话，两次 writeData 是两个并发 IPC，
    // **落盘顺序不保证**：旧值可能后落盘并永久覆盖新值，而 dirty 已被清成 false，
    // 再也不会重试 —— 那次编辑就永久丢了。
    const c = new WriteCoordinator();
    c.markDirty();
    expect(c.begin()).not.toBeNull();

    c.markDirty(); // 飞行期间用户又改了
    expect(c.begin()).toBeNull(); // 不放行第二次
  });

  it("串行化之后，最后一次写盘带的一定是最新版本", () => {
    const c = new WriteCoordinator();
    c.markDirty(); // rev1
    expect(c.begin()).toBe(1);

    c.markDirty(); // rev2，飞行期间
    expect(c.begin()).toBeNull();

    // 第一次写完，发现还有更新的没落盘 → 调用方必须再排一次
    expect(c.commit(1)).toBe(true);

    // 第二次写的是**最新**版本，而不是 rev1
    expect(c.begin()).toBe(2);
    expect(c.commit(2)).toBe(false);
    expect(c.dirty).toBe(false);
  });

  it("commit 一个更旧的版本号不会把 written 往回退", () => {
    // 理论上不该发生，但真发生了也不能让"已写"倒退，
    // 否则会凭空冒出一个永不消失的 dirty
    const c = new WriteCoordinator();
    c.markDirty();
    c.markDirty();
    const second = c.begin() as number;

    c.commit(1); // 迟到的旧版本回调
    expect(c.dirty).toBe(true); // 第 2 版还没写
    expect(c.commit(second)).toBe(false);
    expect(c.dirty).toBe(false);
  });
});
