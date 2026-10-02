/**
 * 提醒弹窗窗口。
 *
 * 用于计时结束、番茄钟阶段切换、备忘录定时提醒、以及开机时补发错过的提醒。
 *
 * # 内容怎么来的
 *
 * 两条路径，缺一不可：
 * 1. **首次创建**时 Rust 把内容拼进 URL query，前端挂载时读一次。
 *    这是兜底：第一次弹窗时事件可能在前端挂载完成之前就发出来了。
 * 2. **窗口复用**时 Rust 通过 `alert:content` 事件推送新内容。
 *    窗口已存在时只调 `show()` 会显示上一条提醒的旧文字，所以必须走事件。
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, Check } from "lucide-react";

import { api, onAlertContent } from "../lib/api";
import { ringSchedule } from "../lib/ringtone";

/** 铃声最长响多少秒。到点自动停，避免用户不在时一直响（见播放那段的说明）。 */
const RING_SECONDS = 30;
/** 前多少秒用满音量，之后降到三分之一当"持续提醒"。 */
const LOUD_UNTIL_SECONDS = 8;

/** 从 hash 里解析 query 参数。 */
function readParams(): { title: string; body: string } {
  const hash = window.location.hash;
  const qIndex = hash.indexOf("?");
  if (qIndex === -1) return { title: "浮光提醒", body: "" };

  const params = new URLSearchParams(hash.slice(qIndex + 1));
  return {
    title: params.get("title") ?? "浮光提醒",
    body: params.get("body") ?? "",
  };
}

export function AlertWindow() {
  const [info, setInfo] = useState(readParams);
  /**
   * 首次渲染时 URL query 里的内容。
   *
   * 用来判断"主动拉回来的内容是不是同一条"：创建窗口时 query 已经带了内容，
   * 如果再无条件应用一次拉回来的同一个内容，就会**重复响铃**。
   */
  const initial = useRef(readParams());

  /**
   * 每收到一次推送就 +1，用来给提示音 effect 一个"这次是新的提醒"的信号。
   *
   * 不能让提示音只依赖 `info.title` / `info.body`：两条内容**完全相同**的提醒
   * （同一个每日提醒再次到点，或多条汇总时文案都是「N 条提醒」）会让依赖不变、
   * effect 不重跑 —— 表现为**只弹窗不响铃**，用户会以为提示音坏了。
   */
  const [arrival, setArrival] = useState(0);

  // 接收复用窗口时推送的新内容
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void onAlertContent((payload) => {
      setInfo({ title: payload.title, body: payload.body });
      setArrival((n) => n + 1);
    }).then((fn) => {
      // 订阅是异步建立的，可能还没建立组件就卸载了。
      // 这是全项目唯一一处曾经漏掉这个保护的地方（其余 5 处订阅都有），
      // 漏掉的后果是监听器永远不退订：StrictMode 下每次挂载都漏一个，热更新再漏一个。
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * 挂载时**主动拉一次**最近一条提醒的内容。
   *
   * # 为什么事件推送不够
   *
   * 提醒窗口是复用的，新内容靠 `alert:content` 事件推过来。但事件"发了就没了"：
   * 如果那一刻监听器还没注册好（第二条提醒赶在窗口刚建好、前端还没挂载完时到达），
   * 事件被丢弃。而调度线程**已经把 `fired_for` 落盘了** ——
   * 那条提醒再也不会补弹，用户少收一条，且没有任何地方能发现。
   *
   * 拉回来的内容如果和 URL query 里那条相同（首次创建的正常情况），
   * 就什么都不做 —— 否则会重复响铃。
   */
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const cur = await api.alertCurrent();
        if (disposed || !cur) return;
        if (
          cur.title === initial.current.title &&
          cur.body === initial.current.body
        ) {
          return;
        }
        setInfo({ title: cur.title, body: cur.body });
        setArrival((n) => n + 1);
      } catch {
        /* 拉不到就算了：URL query 已经兜住了首次创建那一条 */
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  /** 播放铃声。
   *
   *  用 WebAudio 合成而不是打包音频文件：不存在版权问题（不是任何人的作品），
   *  省掉几百 KB 体积，也不用处理资源路径、用户不会看到额外的 mp3 文件。
   *  排布本身在 `lib/ringtone.ts` 里，是可单测的纯逻辑。
   *
   *  # 为什么响 30 秒
   *
   *  最早是两声 0.2 秒的「叮」，一共 0.4 秒 —— 当闹钟用根本叫不醒人。
   *  第二版做成六声急促的交替音，用户听完的评价是「不好听」——
   *  纯正弦没有泛音（又薄又尖），两声之间几乎不留空隙（连成一片嗡嗡声），
   *  而且来回只有两个音（没有旋律走向）。
   *  现在的音色和旋律见 `lib/ringtone.ts`：钟/马林巴的泛音配方 + 上行大调琶音。
   *  一直响到用户点「知道了」为止（上限 30 秒）。
   *
   *  上限不能省：提醒窗是**置顶**的，用户可能正在开会、或者干脆不在电脑前，
   *  没有上限的话它能一直响下去。而前 8 秒满音量、之后降到三分之一，
   *  是为了"先抓住注意力、再变成持续但不烦人的提醒"。
   *
   *  # 为什么「读设置」必须写在同一个 effect 里面
   *
   *  原来是先用一个 effect 把设置读进 ref、再在这个 effect 里**同步**消费它。
   *  React 按声明顺序同步执行 effect，而 `settingsGet` 是一次跨进程往返，
   *  不可能在同一个 tick 里 resolve —— 所以这里读到的永远是 ref 的初始值 `true`。
   *  结果就是设置页里关掉「提醒时播放提示音」从来没有生效过。
   *
   *  而这个窗口点「知道了」会被真正销毁（`lib.rs` 只对主面板做 prevent_close），
   *  所以每一条提醒都是全新挂载 —— 等于**每一条提醒都会响**。
   */
  useEffect(() => {
    let cancelled = false;
    let ctx: AudioContext | null = null;

    void (async () => {
      let enabled = true;
      try {
        enabled = (await api.settingsGet()).alertSound;
      } catch {
        // 读不到设置就按"响"处理：提醒比安静更重要
      }
      // 等设置回来时组件可能已经卸载 / 内容已经换成下一条
      if (cancelled || !enabled) return;

      try {
        // 兼容旧 WebView2：AudioContext 缺失时退回 webkit 前缀版本
        const w = window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const Ctx = w.AudioContext ?? w.webkitAudioContext;
        if (!Ctx) return;
        const audio = new Ctx();
        // 记到外层，卸载时才能关掉；下面一律用 audio，
        // 因为 TS 不会把外层可变量在闭包里的赋值当成收窄
        ctx = audio;

        // 没有用户手势时上下文可能是挂起的，显式唤一次。
        // 唤不醒也没关系：那就和以前一样没声音，不该因此影响提醒本身。
        if (audio.state === "suspended") void audio.resume();

        // 整段铃声一次排完。用户点「知道了」→ 窗口销毁 → `ctx.close()`
        // 会把还没响的那些一起掐掉，不需要额外记定时器。
        //
        // 一个音符 = 一个基频 + 两个泛音，各起一个振荡器：
        // 这样每个泛音能有**自己的衰减曲线**（高次泛音衰减更快），
        // 而 `PeriodicWave` 只能给所有泛音同一条包络 —— 那正是"电子音"的味道。
        const start = audio.currentTime + 0.03;
        for (const note of ringSchedule(RING_SECONDS, LOUD_UNTIL_SECONDS)) {
          const at = start + note.at;
          for (const part of note.partials) {
            const amp = note.peak * part.gain;
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            osc.type = "sine";
            osc.frequency.value = note.freq * part.ratio;
            // `exponentialRamp` 到不了 0，所以两端都用 0.0001 这个极小值
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(amp, at + note.attack);
            gain.gain.exponentialRampToValueAtTime(
              0.0001,
              at + note.attack + part.decay,
            );
            osc.connect(gain).connect(audio.destination);
            osc.start(at);
            osc.stop(at + note.attack + part.decay + 0.02);
          }
        }
      } catch {
        // 音频不可用不影响提醒本身，静默忽略
      }
    })();

    return () => {
      cancelled = true;
      // `close()` 会停掉所有已排期但还没响的振荡器 —— 这就是"点知道了就闭嘴"
      void ctx?.close();
    };
    // `arrival` 必须在依赖里：内容完全相同的两条提醒只靠 title/body 是区分不出来的，
    // 依赖不变 → effect 不重跑 → 只弹窗不响铃（详见 arrival 的说明）。
  }, [info.title, info.body, arrival]);

  const close = async () => {
    await getCurrentWindow().close();
  };

  return (
    <div className="alert">
      {/* 标题行：图标 + 标题 */}
      <div className="alert__head">
        <div className="alert__icon">
          <Bell size={18} />
        </div>
        <div className="alert__title">{info.title}</div>
      </div>

      {/* 内容区可滚动：错过提醒的汇总可能列很多条 */}
      <div className="alert__content">
        {info.body && <div className="alert__body">{info.body}</div>}
      </div>

      <div className="alert__actions">
        <button className="alert__ok" onClick={() => void close()}>
          <Check size={14} />
          知道了
        </button>
      </div>
    </div>
  );
}
