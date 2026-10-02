/**
 * 提醒铃声的排布。
 *
 * # 为什么不打包一个 mp3
 *
 * 最省事也最干净的答案是**自己合成**：不存在版权问题（不是任何人的作品），
 * 不增加发布体积（一段几十行的代码抵掉几百 KB 的音频文件），
 * 也不用处理资源路径。
 *
 * # 音色：为什么不是纯正弦
 *
 * 第一版是纯正弦波交替两个音（880 / 1174 Hz，每 0.2 秒一下）。
 * 用户听完的评价是「不好听」—— 这个评价是对的，原因也很具体：
 *
 * 1. **纯正弦没有泛音**，听感又薄又尖，像电子表的报警音，不像"铃声"；
 * 2. **两声间隔 0.2 秒、衰减 0.16 秒**，几乎不留空隙，
 *    连起来是一片"嗡嗡"的颤音，而不是一个个能听出来的音；
 * 3. 交替纯五度（A5→D6）来回只有两个音，没有旋律走向。
 *
 * 现在按打击乐器（钟 / 马林巴）的通用配方来做：
 * **一个基频 + 两个泛音**，而且**高次泛音衰减得更快** ——
 * 这是"敲一下"的听感来源，纯正弦再怎么调包络也做不出来。
 *
 * # 旋律：上行大调琶音
 *
 * G 大调琶音（G5 → B5 → D6 → G6），四个音上行。
 * 选大调琶音是因为它是最不容易听腻的组合；选**上行**是因为
 * 音高往上走天然带"注意这里"的意味，适合提醒而不显得刺耳。
 *
 * # 为什么把排布单独抽出来
 *
 * 「什么时候响、响哪些频率、响多高、响多久」是**可以单测**的纯逻辑；
 * 而 `OscillatorNode` 那些没法测（跑不了音频、也没法断言听感）。
 * 所以这里只算出一张表，`AlertWindow` 照着表排振荡器。
 */
/** 一个音符里的一个分音（泛音）。 */
export interface Partial {
  /** 相对基频的倍数。`1` 是基频，`2` 是高八度，`3` 是十二度。 */
  ratio: number;
  /** 相对音量。**同一个音符里所有分音的 gain 加起来必须 ≤ 1**，否则会削顶。 */
  gain: number;
  /** 衰减到听不见所需的秒数。 */
  decay: number;
}

/** 一个音符。 */
export interface Note {
  /** 相对铃声起点的秒数。 */
  at: number;
  /** 基频（Hz）。 */
  freq: number;
  /** 这个音符的总音量峰值（0~1）。 */
  peak: number;
  /** 起音时长（秒）。 */
  attack: number;
  /** 分音表。 */
  partials: Partial[];
}

/**
 * 音色配方：基频 + 八度 + 十二度。
 *
 * 三个 gain 加起来是 1.0 —— 这样"音符的 peak"就是它真正的峰值，
 * 多一个泛音也不会把音量顶上去。高次泛音的衰减刻意更短：
 * 敲击的瞬间泛音最丰富，之后快速消失、只剩基频在响，
 * 这正是"钟"和"电子音"的分界。
 */
const PARTIALS: Partial[] = [
  { ratio: 1, gain: 0.6, decay: 0.62 },
  { ratio: 2, gain: 0.27, decay: 0.38 },
  { ratio: 3, gain: 0.13, decay: 0.24 },
];

/**
 * 旋律：G 大调琶音 G5 → B5 → D6 → G6。
 *
 * 频率是十二平均律算出来的（A4 = 440Hz），不是随手填的整数。
 */
const MOTIF = [783.99, 987.77, 1174.66, 1567.98];

/** 相邻两个音之间隔多久。0.17 秒 ≈ 每分钟 350 个音，是"从容"和"急促"的中间。 */
const NOTE_GAP = 0.17;
/** 一个琶音走完之后静默多久。 */
const MOTIF_GAP = 0.72;

/** 一个完整「琶音 + 静默」周期的长度（秒）。 */
export const RING_CYCLE = MOTIF.length * NOTE_GAP + MOTIF_GAP;

/**
 * 音量随时间降档：`[从第几秒起, 峰值]`。
 *
 * 手机闹钟是**恒定音量一直响到你处理**（iOS 约 15 分钟、
 * Android（Google 时钟）默认「静音时间」10 分钟）。
 * 桌面软件照搬有个问题：提醒窗是置顶的，用户可能就在旁边，
 * 恒定音量响十分钟会让人直接去关掉系统声音 —— 那比不提醒更糟。
 *
 * 所以这里做成**先抓住注意力、再退成背景音**：
 * 前 30 秒满音量（该注意到的时候一定要注意到），之后降到一半，
 * 3 分钟还没人理就降到很低、但仍在响。
 * 「一直响到你处理」这条手机逻辑保住了，代价只是后面的音量。
 */
const VOLUME_STEPS: readonly (readonly [number, number])[] = [
  [0, 0.22],
  [30, 0.1],
  [180, 0.05],
];

/** 某个时刻该用多大的音量峰值。 */
export function peakAt(seconds: number): number {
  let peak = VOLUME_STEPS[0][1];
  for (const [from, p] of VOLUME_STEPS) {
    if (seconds >= from) peak = p;
  }
  return peak;
}

/** 起音要短（长了听着"软"、不像敲出来的），但也必须有，否则会有咔哒声。 */
const ATTACK = 0.008;

/**
 * 排出 `[fromSeconds, totalSeconds)` 这一段里的音符。
 *
 * 节奏是「四个音的上行琶音 → 静默 0.72 秒 → 再来一遍」。
 *
 * # 为什么按"音符窗口"取，而不是按"完整周期"截断
 *
 * 一开始是按完整周期截的（"别让最后一轮旋律剩半截"），结果**分段排时会漏音**：
 * 第 1 段排到第 13 轮为止，第 14 轮的前三个音既不在第 1 段（被截掉）、
 * 也不在第 2 段（它们早于第 2 段的起点）—— 每 20 秒就出现半秒的空洞。
 * 这个 bug 是"分段不重不漏"那条测试抓出来的。
 *
 * 现在就是老老实实取落在窗口里的音符：不重不漏。
 * 代价是整段铃声的最后可能剩半截旋律 —— 无所谓，
 * 它本来就是循环的，用户点掉就停。
 *
 * # 为什么要分段
 *
 * 响 10 分钟 = 428 轮 × 4 个音 = 1712 个音符，每个音符三个泛音 ——
 * 一次全排出来是**五千多个**音频节点，光是建出来就会卡一下，
 * 而绝大多数提醒几秒内就被处理掉了。所以调用方每次只排 20 秒、
 * 排完用定时器续下一段（见 `AlertWindow`）。
 *
 * @param totalSeconds 整段铃声最长多少秒
 * @param fromSeconds  从第几秒开始排（这一秒之前的音符直接跳过）
 */
export function ringSchedule(totalSeconds: number, fromSeconds = 0): Note[] {
  if (!(totalSeconds > 0)) return [];

  const notes: Note[] = [];
  // 轮数上界由 totalSeconds 定死，循环一定结束
  for (let c = 0; c * RING_CYCLE < totalSeconds; c += 1) {
    const cycleStart = c * RING_CYCLE;
    MOTIF.forEach((freq, i) => {
      const at = cycleStart + i * NOTE_GAP;
      if (at >= totalSeconds) return;
      if (at < fromSeconds) return;
      notes.push({ at, freq, peak: peakAt(at), attack: ATTACK, partials: PARTIALS });
    });
  }

  return notes;
}

/**
 * 把排布渲染成一段 PCM 采样，用来生成**试听文件**。
 *
 * 为什么要它：铃声好不好听只能靠耳朵判断，而"改代码 → 编译五分钟 → 设个闹钟"
 * 这个反馈环太长了。这个函数把同一张排布表算成波形、写成 wav，
 * 机主可以先听再决定要不要装。
 *
 * 复刻的是 `AlertWindow` 里的包络算法：`exponentialRampToValueAtTime`
 * 在**幅度**上是按指数走的（等价于线性分贝），所以这里是
 * `amp(t) = peak * (0.0001/peak) ^ (t/decay)` —— 和 WebAudio 的行为一致。
 *
 * @param notes      `ringSchedule` 的结果
 * @param sampleRate 采样率
 * @param seconds    渲染多少秒
 */
export function renderPcm(notes: Note[], sampleRate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(sampleRate * seconds));
  // WebAudio 里增益从 0.0001 起（`exponentialRamp` 到不了 0），这里保持一致
  const FLOOR = 0.0001;

  for (const note of notes) {
    const noteStart = note.at;
    for (const p of note.partials) {
      const amp = note.peak * p.gain;
      if (amp <= FLOOR) continue;
      const freq = note.freq * p.ratio;
      const decayStart = noteStart + note.attack;
      const decayEnd = decayStart + p.decay;
      // 从第几个采样开始算（负数表示起音在 0 之前，跳过）
      const from = Math.max(0, Math.floor(noteStart * sampleRate));
      const to = Math.min(out.length, Math.ceil((decayEnd + 0.02) * sampleRate));

      for (let i = from; i < to; i += 1) {
        const t = i / sampleRate;
        let env: number;
        if (t < noteStart) continue;
        if (t < decayStart) {
          // 起音段：从 FLOOR 指数升到 amp
          const k = (t - noteStart) / note.attack;
          env = FLOOR * Math.pow(amp / FLOOR, k);
        } else {
          const k = Math.min(1, (t - decayStart) / p.decay);
          env = amp * Math.pow(FLOOR / amp, k);
        }
        out[i] += env * Math.sin(2 * Math.PI * freq * t);
      }
    }
  }

  return out;
}

/** 把一个浮点波形编成 16 位单声道 wav 的字节。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    // 夹一下再转：万一叠起来超过 1.0，宁可削顶也不要绕回成噪音
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}
