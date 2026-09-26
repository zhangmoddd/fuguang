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
  /** 用户是否在设置里关掉了提示音。 */
  const soundEnabled = useRef(true);

  // 读一次设置，决定要不要响
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.settingsGet();
        soundEnabled.current = s.alertSound;
      } catch {
        // 读不到设置就按"响"处理，提醒比安静更重要
      }
    })();
  }, []);

  // 接收复用窗口时推送的新内容
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onAlertContent((payload) => {
      setInfo({ title: payload.title, body: payload.body });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /** 播放提示音。
   *
   *  用 WebAudio 合成而不是打包音频文件：省掉几百 KB 体积，
   *  而且不需要处理资源路径，用户也不会看到额外的 mp3 文件。 */
  useEffect(() => {
    if (!soundEnabled.current) return;

    try {
      // 兼容旧 WebView2：AudioContext 缺失时退回 webkit 前缀版本
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctx = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();

      // 两声「叮」，比单声更容易被注意到
      const now = ctx.currentTime;
      [0, 0.22].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = i === 0 ? 880 : 1174;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.2);
      });

      return () => void ctx.close();
    } catch {
      // 音频不可用不影响提醒本身，静默忽略
    }
  }, [info.title, info.body]);

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
