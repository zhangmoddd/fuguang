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
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, Check } from "lucide-react";

import { api, onAlertContent } from "../lib/api";

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

  /** 播放提示音。
   *
   *  用 WebAudio 合成而不是打包音频文件：省掉几百 KB 体积，
   *  而且不需要处理资源路径，用户也不会看到额外的 mp3 文件。
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

        // 两声「叮」，比单声更容易被注意到
        const now = audio.currentTime;
        [0, 0.22].forEach((offset, i) => {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.type = "sine";
          osc.frequency.value = i === 0 ? 880 : 1174;
          gain.gain.setValueAtTime(0.0001, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
          osc.connect(gain).connect(audio.destination);
          osc.start(now + offset);
          osc.stop(now + offset + 0.2);
        });
      } catch {
        // 音频不可用不影响提醒本身，静默忽略
      }
    })();

    return () => {
      cancelled = true;
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
