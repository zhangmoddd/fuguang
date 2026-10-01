/**
 * 铃声排布的测试。
 *
 * 这些断言不能证明"好听"（那是听感，测不了），但能挡住那几类
 * **用户会当成"坏了"** 的错误：声音叠在一起变成噪音、最后一轮被截成半声、
 * 该响的时候没排上、或者排出一段几十分钟的表把内存吃光。
 */
import { describe, expect, it } from "vitest";

import { RING_CYCLE, ringSchedule } from "./ringtone";

describe("ringSchedule", () => {
  it("时长非正数时排空表，不抛错", () => {
    // 设置被手改成 0 或负数时不该让提醒窗崩掉
    expect(ringSchedule(0, 8)).toEqual([]);
    expect(ringSchedule(-5, 8)).toEqual([]);
    expect(ringSchedule(Number.NaN, 8)).toEqual([]);
  });

  it("只排完整的周期，最后不会留半声", () => {
    // 截半轮的话最后以半声结束，听着像卡住了
    const bells = ringSchedule(30, 8);
    expect(bells.length % 6).toBe(0);

    const last = bells[bells.length - 1];
    expect(last.at).toBeLessThan(30);
    // 最后一声整声都要落在总时长之内
    expect(last.at + last.decay).toBeLessThanOrEqual(30);

    // 4 个完整周期（2 秒一轮）刚好 8 秒，第 5 轮排不进来
    expect(ringSchedule(9.9, 8).length).toBe(4 * 6);
    expect(ringSchedule(10, 8).length).toBe(5 * 6);
  });

  it("时间严格递增，没有任何两声同时开始", () => {
    // 同时开始的两声会叠加成两倍音量，听感是"破音"而不是"更响"
    const bells = ringSchedule(30, 8);
    for (let i = 1; i < bells.length; i += 1) {
      expect(bells[i].at).toBeGreaterThan(bells[i - 1].at);
    }
  });

  it("两声一交替，不会连着响同一个音", () => {
    const bells = ringSchedule(6, 8);
    for (let i = 1; i < bells.length; i += 1) {
      expect(bells[i].freq).not.toBe(bells[i - 1].freq);
    }
  });

  it("前几秒满音量，之后降下来当持续提醒", () => {
    const bells = ringSchedule(30, 8);
    const loud = bells.filter((b) => b.at < 8);
    const soft = bells.filter((b) => b.at >= 8);

    expect(loud.length).toBeGreaterThan(0);
    expect(soft.length).toBeGreaterThan(0);
    // 满音量那几声必须都在前面，否则"先轻后响"会把人吓一跳
    expect(Math.max(...loud.map((b) => b.at))).toBeLessThan(Math.min(...soft.map((b) => b.at)));
    expect(Math.max(...soft.map((b) => b.peak))).toBeLessThan(Math.min(...loud.map((b) => b.peak)));
  });

  it("每一声都是短促的，不会拖成一片", () => {
    // 衰减比间隔还长的话，相邻两声会叠在一起，听不出节奏
    for (const b of ringSchedule(30, 8)) {
      expect(b.attack).toBeGreaterThan(0);
      expect(b.attack).toBeLessThan(b.decay);
      expect(b.attack + b.decay).toBeLessThan(0.2);
    }
  });

  it("响铃与静默是分开的，中间有真正的间隙", () => {
    // 一个周期里最后一声之后，到下一个周期第一声之间要留出静默
    const bells = ringSchedule(6, 8);
    const firstOfSecondCycle = bells.find((b) => b.at >= RING_CYCLE);
    expect(firstOfSecondCycle).toBeDefined();
    expect(firstOfSecondCycle!.at).toBe(RING_CYCLE);

    const lastOfFirstCycle = bells[5];
    expect(firstOfSecondCycle!.at - lastOfFirstCycle.at).toBeGreaterThanOrEqual(1.0);
  });

  it("音量峰值都在 0~1 之间", () => {
    // 超过 1 会被削顶（WebAudio 会硬截），听感是刺耳的爆音
    for (const b of ringSchedule(30, 8)) {
      expect(b.peak).toBeGreaterThan(0);
      expect(b.peak).toBeLessThanOrEqual(1);
    }
  });

  it("排出来的表规模受控", () => {
    // 一分钟的铃声 = 30 轮 × 6 声 = 180 个振荡器，够用且不会失控。
    // 有人把总时长改成一个离谱的值时，这条能挡住"排出几十万个节点"。
    expect(ringSchedule(60, 8).length).toBe(180);
    expect(ringSchedule(600, 8).length).toBe(1800);
  });
});
