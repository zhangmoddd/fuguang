/**
 * 提醒弹窗窗口。
 *
 * 第一版只用于「计时结束」和「粘贴失败」这类即时提示，
 * 备忘录的定时提醒在后续版本复用同一个窗口。
 *
 * 内容通过 URL query 传入（由 Rust 侧 `show_alert` 拼接），
 * 这样连续弹出多个提醒时不会因为共享全局状态而串内容。
 */
import { useEffect, useState } from "react";
import { Bell, Check } from "lucide-react";

import { api } from "../lib/api";

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

  // hash 变化时刷新内容（同一个窗口被复用弹出第二条提醒时）
  useEffect(() => {
    const onHash = () => setInfo(readParams());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** 播放提示音。
   *  用 WebAudio 合成而不是打包音频文件：省掉几百 KB 体积，
   *  而且不需要处理资源路径，用户也不会看到额外的 mp3 文件。 */
  useEffect(() => {
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
  }, []);

  const close = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  };

  return (
    <div className="alert">
      <div className="alert__icon">
        <Bell size={20} />
      </div>
      <div className="alert__content">
        <div className="alert__title">{info.title}</div>
        {info.body && <div className="alert__body">{info.body}</div>}
      </div>
      <button className="alert__ok" onClick={() => void close()}>
        <Check size={14} />
        知道了
      </button>
      <button className="alert__x" onClick={() => void api.quit()} title="退出浮光" hidden />
    </div>
  );
}
