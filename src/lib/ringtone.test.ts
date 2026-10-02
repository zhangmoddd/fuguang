/**
 * 铃声排布与波形渲染的测试。
 *
 * 分两层：
 *
 * 1. **排布**（`ringSchedule`）—— 什么时候响哪个音、响多高。
 *    这些错了的表现是"声音难听/连成一片/突然炸一下"，而听感本身测不了，
 *    所以只能把"会让人听着难受"的那些**结构性**错误钉死。
 * 2. **波形**（`renderPcm` / `encodeWav`）—— 试听文件用的。
 *    它必须是**同一份排布**算出来的，否则"试听的"和"软件里响的"不是一个声音。
 */
import { describe, expect, it } from "vitest";

import { RING_CYCLE, encodeWav, peakAt, renderPcm, ringSchedule } from "./ringtone";

describe("ringSchedule", () => {
  it("时长非正数时排空表，不抛错", () => {
    // 设置被手改成 0 或负数时不该让提醒窗崩掉
    expect(ringSchedule(0)).toEqual([]);
    expect(ringSchedule(-5)).toEqual([]);
    expect(ringSchedule(Number.NaN)).toEqual([]);
  });

  it("所有音符都排在总时长之内", () => {
    const notes = ringSchedule(30);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.at).toBeLessThan(30);
    // 最后一声的余韵可能拖过总时长 —— 那是**故意的**：
    // 到点窗口就被关掉（`ctx.close()`），尾音被掐掉好过提前静音。
    // 这里只要求"起音落在窗口内"，不要求整声都装得下。
    const last = notes[notes.length - 1];
    expect(last.at + last.attack).toBeLessThanOrEqual(30);
  });

  it("每四个音是一轮上行琶音，轮与轮之间回到低音", () => {
    // 取前 8 个音（两整轮）来验旋律形状。用"完整周期"当窗口，
    // 这样边界落在轮的接缝上，不受"按音符窗口取"的影响
    const notes = ringSchedule(RING_CYCLE * 2);
    expect(notes.length).toBe(8);
    for (const base of [0, 4]) {
      const motif = notes.slice(base, base + 4).map((n) => n.freq);
      expect(motif[1]).toBeGreaterThan(motif[0]);
      expect(motif[2]).toBeGreaterThan(motif[1]);
      expect(motif[3]).toBeGreaterThan(motif[2]);
    }
    expect(notes[4].freq).toBe(notes[0].freq);
  });

  it("每个琶音都是上行的，下一轮从头开始", () => {
    // 上行是刻意的：音高往上走天然带"注意这里"的意味。
    // 写反了会变成下行 —— 那听着像"结束/放松"，当闹钟不合适。
    const notes = ringSchedule(10);
    for (let c = 0; c * 4 + 4 <= notes.length; c += 1) {
      const motif = notes.slice(c * 4, c * 4 + 4).map((n) => n.freq);
      for (let i = 1; i < motif.length; i += 1) {
        expect(motif[i]).toBeGreaterThan(motif[i - 1]);
      }
      // 一轮的最后一个音之后，下一轮的第一个音要更低（旋律回到起点）
      if (c * 4 + 4 < notes.length) {
        expect(notes[c * 4 + 4].freq).toBeLessThan(motif[motif.length - 1]);
      }
    }
  });

  it("时间严格递增，没有任何两个音同时开始", () => {
    // 同时开始的两个音会叠加成两倍音量，听感是"破音"而不是"更响"
    const notes = ringSchedule(30);
    for (let i = 1; i < notes.length; i += 1) {
      expect(notes[i].at).toBeGreaterThan(notes[i - 1].at);
    }
  });

  it("每个音的泛音 gain 加起来不超过 1", () => {
    // 超过 1 的话"音符峰值"就不再是它真正的峰值，几个泛音叠起来会削顶 ——
    // 听感是刺耳的爆音，而这是**配方本身**的错，不是音量设大了
    for (const note of ringSchedule(10)) {
      const sum = note.partials.reduce((a, p) => a + p.gain, 0);
      expect(sum).toBeLessThanOrEqual(1.0001);
      expect(sum).toBeGreaterThan(0.9);
    }
  });

  it("高次泛音衰减得比基频快", () => {
    // 这是"敲一下"的听感来源：敲击瞬间泛音最丰富，之后快速消失、只剩基频。
    // 反过来（泛音比基频活得久）会一直嗡嗡响，就是"电子音"的味道
    const [first] = ringSchedule(10);
    const sorted = [...first.partials].sort((a, b) => a.ratio - b.ratio);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].decay).toBeLessThan(sorted[i - 1].decay);
    }
  });

  it("音量按时间降档，而且降完不再升回去", () => {
    // 手机闹钟是恒定音量响到你处理；桌面软件照搬会让人直接去关系统声音，
    // 所以做成"先抓住注意力、再退成背景音"（见 VOLUME_STEPS 的说明）。
    expect(peakAt(0)).toBe(0.22);
    expect(peakAt(29.9)).toBe(0.22);
    expect(peakAt(30)).toBe(0.1);
    expect(peakAt(179)).toBe(0.1);
    expect(peakAt(180)).toBe(0.05);
    expect(peakAt(3600)).toBe(0.05);
  });

  it("排出来的音符音量随时间单调不增", () => {
    // 出现"响着响着又变响"会把人吓一跳
    const notes = ringSchedule(400);
    for (let i = 1; i < notes.length; i += 1) {
      expect(notes[i].peak).toBeLessThanOrEqual(notes[i - 1].peak);
    }
    // 三档都要真的出现过，否则等于没降
    expect(new Set(notes.map((n) => n.peak)).size).toBe(3);
  });

  it("分段排出来的音符不重不漏", () => {
    // 响十分钟不能一次排完（五千多个节点），所以是分段的。
    // 分段最容易出的错是**接缝处**：要么漏一个音（听着断一下），
    // 要么重复排一个音（同一时刻两个振荡器，音量翻倍）。
    // 模拟调用方：第 n 段的总时长是 20/40/60，起点是上一段的终点
    const whole = ringSchedule(60);
    const chunks = [ringSchedule(20, 0), ringSchedule(40, 20), ringSchedule(60, 40)].flat();

    expect(chunks.map((n) => n.at)).toEqual(whole.map((n) => n.at));
    expect(chunks.map((n) => n.freq)).toEqual(whole.map((n) => n.freq));
  });

  it("分段排时，起点之前的音符一个都不排", () => {
    const second = ringSchedule(60, 20);
    expect(second.length).toBeGreaterThan(0);
    expect(Math.min(...second.map((n) => n.at))).toBeGreaterThanOrEqual(20);
  });

  it("起音很短但必须大于 0", () => {
    // 没有起音会"咔哒"一声；起音太长听着是"吹"出来的，不像敲出来的
    for (const note of ringSchedule(10)) {
      expect(note.attack).toBeGreaterThan(0);
      expect(note.attack).toBeLessThan(0.03);
    }
  });

  it("音量峰值都在 0~1 之间", () => {
    for (const note of ringSchedule(30)) {
      expect(note.peak).toBeGreaterThan(0);
      expect(note.peak).toBeLessThanOrEqual(1);
    }
  });

  it("排出来的表规模受控", () => {
    // 一分钟 = 42 轮 × 4 音 = 168 个音符（每个音符 3 个振荡器，共 504 个节点）。
    // 有人把总时长改成一个离谱的值时，这条能挡住"排出几十万个节点"。
    // 每个音符 3 个振荡器：一分钟 ≈ 516 个节点，十分钟 ≈ 5148 个 ——
    // 所以调用方必须分段排（见 CHUNK_SECONDS）
    expect(ringSchedule(60).length).toBeGreaterThan(160);
    expect(ringSchedule(60).length).toBeLessThan(180);
    expect(ringSchedule(600).length).toBeGreaterThan(1700);
    expect(ringSchedule(600).length).toBeLessThan(1740);
  });
});

// ===============================================================
// 试听文件用的波形渲染
// ===============================================================

describe("renderPcm", () => {
  const SR = 8000; // 测试用低采样率，快一些

  it("长度正确、没有 NaN", () => {
    const pcm = renderPcm(ringSchedule(2), SR, 2);
    expect(pcm.length).toBe(SR * 2);
    for (const v of pcm) expect(Number.isFinite(v)).toBe(true);
  });

  it("确实出了声，而且没有削顶", () => {
    // 削顶（|v| > 1）在 wav 里会被夹平，听感是爆音。
    // 这条同时验证了"泛音 gain 加起来 ≤ 1"那个配方约束在波形上真的成立。
    const pcm = renderPcm(ringSchedule(2), SR, 2);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it("第一个音之前是静音的", () => {
    // 波形起点要干净，否则播放时第一下就是"啪"
    const pcm = renderPcm(ringSchedule(2), SR, 2);
    expect(Math.abs(pcm[0])).toBeLessThan(0.001);
  });

  it("满音量那段比降档之后响", () => {
    // 和 `peakAt` 的分档对得上 —— 两个函数不能各算各的。
    // 渲染 45 秒是为了跨过 30 秒那一档。
    const pcm = renderPcm(ringSchedule(45), SR, 45);
    const rms = (from: number, to: number) => {
      let s = 0;
      let n = 0;
      for (let i = from; i < to; i += 1) {
        s += pcm[i] * pcm[i];
        n += 1;
      }
      return Math.sqrt(s / n);
    };
    const loud = rms(0, SR * 25);
    const soft = rms(SR * 32, SR * 44);
    expect(loud).toBeGreaterThan(soft * 1.5);
  });

  it("空排布渲染出静音而不是崩掉", () => {
    const pcm = renderPcm([], SR, 1);
    expect(pcm.length).toBe(SR);
    expect(Math.max(...pcm)).toBe(0);
  });
});

describe("encodeWav", () => {
  it("头部字段正确", () => {
    const pcm = renderPcm(ringSchedule(1), 8000, 1);
    const wav = encodeWav(pcm, 8000);
    const view = new DataView(wav.buffer);
    const ascii = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));

    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(ascii(36)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1) // PCM;
    expect(view.getUint16(22, true)).toBe(1) // 单声道;
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16) // 16 位;
    // 长度：44 字节头 + 每个采样 2 字节
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  });

  it("超范围的采样被夹平而不是绕回", () => {
    // 不夹的话 1.5 会绕成负数，听感是"炸音"
    const loud = new Float32Array([1.5, -1.5, 0.5]);
    const view = new DataView(encodeWav(loud, 8000).buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
    expect(view.getInt16(48, true)).toBe(Math.round(0.5 * 32767));
  });
});
