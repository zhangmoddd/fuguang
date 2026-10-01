/**
 * 提醒铃声的排布。
 *
 * # 为什么不打包一个 mp3
 *
 * 用户问的是「找个免费不会侵权的铃声」—— 最省事也最干净的答案是**自己合成**：
 * 不存在版权问题（不是任何人的作品），不增加发布体积（一段几十行的代码
 * 抵掉几百 KB 的音频文件），也不用处理资源路径。
 * 原来那两声「叮」就是这么来的，只是太短了（0.4 秒），
 * 当闹钟用根本叫不醒人。
 *
 * # 为什么把排布单独抽出来
 *
 * 「什么时候响、响多高、响多久」是**可以单测**的纯逻辑；
 * 而 `OscillatorNode` 那些没法测（跑不了音频、也没法断言听感）。
 * 所以这里只算出一张"什么时候该响哪一声"的表，
 * `AlertWindow` 照着表排振荡器就行 —— 和 `scheduler.rs` 里
 * 「纯逻辑 / IO 分层」是同一个思路。
 */

/** 一声「滴」。 */
export interface Bell {
  /** 相对响铃起点的秒数。 */
  at: number;
  /** 频率（Hz）。 */
  freq: number;
  /** 音量峰值（0~1）。 */
  peak: number;
  /** 起音时长（秒）。 */
  attack: number;
  /** 衰减时长（秒）。 */
  decay: number;
}

/** 相邻两声之间的间隔。0.2 秒 ≈ 每秒 5 声，是"急促"和"刺耳"之间的平衡点。 */
const BEEP_GAP = 0.2;
/** 一个「响铃」里有几声。六声 ≈ 1.2 秒，够形成一段可辨认的节奏。 */
const BEEPS_PER_RING = 6;
/** 响铃与响铃之间的静默。0.8 秒：留出"喘口气"的间隙，不连成一片噪音。 */
const RING_GAP = 0.8;

/** 一个完整「响铃 + 静默」周期的长度（秒）。 */
export const RING_CYCLE = BEEPS_PER_RING * BEEP_GAP + RING_GAP;

/**
 * 交替的两个音：A5 与 D6。
 *
 * 选纯五度而不是半音或三度：纯五度听感最"空"、最容易被从背景噪音里挑出来，
 * 而两个音都在 1kHz 上下，正好是人耳最敏感的一段（手机铃声都挑在这一带）。
 * 交替而不是单音重复，是因为**音高变化**比单纯重复更容易把人从睡意里拽出来。
 */
const TONES = [880, 1174.66];

/**
 * 满音量与「持续提醒」音量。
 *
 * 前几秒用满音量：那时候用户多半就在电脑前，一下就该注意到。
 * 之后降到三分之一：还响，但不至于让人非去关掉它不可
 * —— 闹钟"一直响到你来关"是对的，可 30 秒的高音量会让人直接去静音。
 */
const PEAK_LOUD = 0.22;
const PEAK_SOFT = 0.08;

/** 起音要短，否则听着"软"、不像铃；衰减长一点才有铃的余韵。 */
const ATTACK = 0.012;
const DECAY = 0.16;

/**
 * 排出整段铃声。
 *
 * 节奏是「六声急促的交替音 → 静默 0.8 秒 → 再来一遍」，一直排到
 * `totalSeconds` 为止。响铃本身在 `RING_CYCLE` 的整数倍处开始，
 * 所以最后一轮不会被截成半截。
 *
 * @param totalSeconds     整段铃声最长多少秒（到点自动停，见 AlertWindow 的说明）
 * @param loudUntilSeconds 从起点算起，多少秒之内用满音量
 */
export function ringSchedule(totalSeconds: number, loudUntilSeconds: number): Bell[] {
  if (!(totalSeconds > 0)) return [];

  // 只排完整的周期：截半轮的话最后会以半声结束，听着像卡住了
  const cycles = Math.floor(totalSeconds / RING_CYCLE);
  const bells: Bell[] = [];

  for (let c = 0; c < cycles; c += 1) {
    const cycleStart = c * RING_CYCLE;
    for (let i = 0; i < BEEPS_PER_RING; i += 1) {
      const at = cycleStart + i * BEEP_GAP;
      bells.push({
        at,
        freq: TONES[i % TONES.length],
        peak: at < loudUntilSeconds ? PEAK_LOUD : PEAK_SOFT,
        attack: ATTACK,
        decay: DECAY,
      });
    }
  }

  return bells;
}
