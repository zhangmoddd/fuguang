/**
 * 设置。
 *
 * 这里不是"功能"，但复用了功能模块注册表：多一个页签的成本，
 * 换来不需要在主面板里另开一套导航机制。
 *
 * 各项设置的默认值都在 Rust 侧 `models::Settings` 里定义，
 * 前端不重复声明默认值，避免两处不一致。
 */
import { useEffect, useState } from "react";
import {
  BellRing,
  ClipboardCheck,
  Command,
  FolderOpen,
  Info,
  Pin,
  Power,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";

import { api, type Settings } from "../../lib/api";
import type { FeatureModule } from "../registry";

import "./settings.css";

/** 单独的修饰键，不能作为热键的"主键"。 */
const MODIFIER_KEYS = ["Control", "Alt", "Shift", "Meta", "AltGraph"];

/**
 * 把浏览器 `KeyboardEvent.key` 转成 Rust 侧认识的名字。
 *
 * 两边必须对得上：对不上时 Rust 会明确报"不认识的按键"，
 * 所以这里宁可原样传过去让它报错，也不要猜。
 */
function normalizeKeyName(key: string): string | null {
  if (MODIFIER_KEYS.includes(key)) return null;
  switch (key) {
    case " ":
      return "Space";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [exePath, setExePath] = useState("");
  /** 开机自启以注册表为准，不以内存里的设置为准。 */
  const [autostart, setAutostart] = useState(false);
  /** 当前**实际生效**的热键（可能因为冲突而为 null）。 */
  const [activeHotkey, setActiveHotkey] = useState<string | null>(null);
  /** 是否正在录制热键。 */
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, dir, exe, auto, hk] = await Promise.all([
          api.settingsGet(),
          api.dataDirPath(),
          api.currentExe(),
          api.autostartGet(),
          api.hotkeyCurrent(),
        ]);
        setSettings(s);
        setDataDir(dir);
        setExePath(exe);
        setAutostart(auto);
        setActiveHotkey(hk);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, []);

  // 提示语两秒后自动消失，避免一直挂在那里
  useEffect(() => {
    if (!savedHint) return;
    const t = window.setTimeout(() => setSavedHint(null), 2000);
    return () => window.clearTimeout(t);
  }, [savedHint]);

  /** 保存一项设置。 */
  const patch = async (changes: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...changes };
    setSettings(next);
    try {
      await api.settingsSave(next);
      setSavedHint("已保存");
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * 切换开机自启。
   *
   * 这个开关和别的设置不一样：它真正写入注册表，可能失败（权限、被杀软拦）。
   * 所以失败时要把界面状态回滚，不能显示成"已开启"而注册表里其实没有。
   */
  const toggleAutostart = async (enabled: boolean) => {
    try {
      await api.autostartSet(enabled);
      setAutostart(enabled);
      setSavedHint(enabled ? "已设为开机自启" : "已取消开机自启");
      setError(null);
    } catch (err) {
      setError(`设置开机自启失败：${err}`);
      // 回读真实状态，而不是乐观地认为成功了
      try {
        setAutostart(await api.autostartGet());
      } catch {
        // 回读也失败就保持原值，至少不会显示成成功
      }
    }
  };

  /**
   * 应用一个热键组合。
   *
   * 注册可能失败（组合键被别的程序占用、或属于系统保留），
   * 这时必须把原因显示出来。否则用户会以为热键开着，
   * 然后一直按一直没反应，完全不知道发生了什么。
   */
  const applyHotkey = async (enabled: boolean, combo: string) => {
    try {
      await api.hotkeyApply(enabled, combo);
      setError(null);
      setSavedHint(enabled ? `热键已设为 ${combo}` : "已关闭全局热键");
      // 回读真实生效的组合，而不是乐观地显示我们请求的那个
      setActiveHotkey(await api.hotkeyCurrent());
      if (settings) setSettings({ ...settings, hotkeyEnabled: enabled, hotkey: combo });
    } catch (err) {
      setError(String(err));
      try {
        setActiveHotkey(await api.hotkeyCurrent());
      } catch {
        // 回读失败就保持原值
      }
    }
  };

  /** 录制热键时的键盘处理。 */
  const onRecorderKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;

    // 必须拦住：面板的全局快捷键监听在 window 上，
    // 不拦的话录热键时会顺手切换页签、甚至按 Esc 把面板收起来。
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setRecording(false);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Win");

    const key = normalizeKeyName(e.key);
    // 只按下修饰键时不算一个完整组合，继续等
    if (!key) return;
    parts.push(key);

    setRecording(false);
    void applyHotkey(true, parts.join("+"));
  };

  if (!settings) {
    return (
      <div className="settings">
        {error ? <div className="settings__error">{error}</div> : <div className="settings__loading">正在读取设置…</div>}
      </div>
    );
  }

  return (
    <div className="settings">
      {error && <div className="settings__error">{error}</div>}
      {savedHint && <div className="settings__saved">{savedHint}</div>}

      <section className="settings__group">
        <h4 className="settings__group-title">启动</h4>

        <label className="settings__row">
          <Power size={15} className="settings__icon" />
          <span className="settings__label">
            开机自动启动
            <em className="settings__hint">
              会写入当前用户的注册表启动项，可在「任务管理器 → 启动」里查看或关闭
            </em>
          </span>
          <input
            type="checkbox"
            className="settings__switch"
            checked={autostart}
            onChange={(e) => void toggleAutostart(e.target.checked)}
          />
        </label>

        <div className="settings__note">
          开机启动的是这个文件：
          <code className="settings__code">{exePath}</code>
          {/* 开发模式下这个路径指向 target\debug，勾选自启会启动调试版，
              不提醒的话用户会以为正式版自启了 */}
          {exePath.includes("target") && (
            <span className="settings__warn">
              注意：当前是开发模式，路径指向编译产物目录。正式安装后再开这个开关才指向安装目录。
            </span>
          )}
        </div>
      </section>

      <section className="settings__group">
        <h4 className="settings__group-title">唤出</h4>

        <label className="settings__row">
          <Command size={15} className="settings__icon" />
          <span className="settings__label">
            全局热键
            <em className="settings__hint">
              在任何程序里按下就能展开/收起主面板，不用去点小球
            </em>
          </span>
          <input
            type="checkbox"
            className="settings__switch"
            checked={settings.hotkeyEnabled}
            onChange={(e) => void applyHotkey(e.target.checked, settings.hotkey)}
          />
        </label>

        {settings.hotkeyEnabled && (
          <div className="settings__hotkey">
            <button
              type="button"
              className={`settings__recorder${recording ? " settings__recorder--recording" : ""}`}
              onClick={() => setRecording(true)}
              onKeyDown={onRecorderKeyDown}
              onBlur={() => setRecording(false)}
              title="点一下，然后按下你想用的组合键"
            >
              {recording ? "请按下组合键…（Esc 取消）" : settings.hotkey}
            </button>

            <button
              type="button"
              className="iconbtn"
              title="恢复默认（Ctrl+Shift+Space）"
              onClick={() => void applyHotkey(true, "Ctrl+Shift+Space")}
            >
              <RotateCcw size={13} />
            </button>
          </div>
        )}

        {/* 显示"实际生效"的组合，而不是设置里存的那个。
            两者可能不一致——注册失败时设置存着却没生效。 */}
        {settings.hotkeyEnabled && (
          <div className="settings__note">
            {activeHotkey ? (
              <>
                当前生效：<code className="settings__code settings__code--inline">{activeHotkey}</code>
              </>
            ) : (
              <span className="settings__warn">
                热键没有生效。可能是组合键被别的程序占用，或属于系统保留的组合，换一个再试。
              </span>
            )}
          </div>
        )}
      </section>

      <section className="settings__group">
        <h4 className="settings__group-title">提醒</h4>

        <label className="settings__row">
          <BellRing size={15} className="settings__icon" />
          <span className="settings__label">
            提醒时播放提示音
            <em className="settings__hint">计时结束和日程提醒都会响；关掉后只弹窗</em>
          </span>
          <input
            type="checkbox"
            className="settings__switch"
            checked={settings.alertSound}
            onChange={(e) => void patch({ alertSound: e.target.checked })}
          />
        </label>
      </section>

      <section className="settings__group">
        <h4 className="settings__group-title">粘贴</h4>

        <label className="settings__row">
          <ClipboardCheck size={15} className="settings__icon" />
          <span className="settings__label">
            还原剪贴板的等待时间
            <em className="settings__hint">
              点「粘贴」时会临时借用剪贴板，粘完再把你原来的内容还回去。
              调大能兼容更慢的程序，但会占用剪贴板更久
            </em>
          </span>
          <span className="settings__number">
            <input
              type="number"
              min={0}
              max={2000}
              step={20}
              value={settings.pasteRestoreDelayMs}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v <= 2000) {
                  void patch({ pasteRestoreDelayMs: v });
                }
              }}
            />
            <span className="settings__unit">毫秒</span>
          </span>
        </label>
      </section>

      <section className="settings__group">
        <h4 className="settings__group-title">面板</h4>

        <label className="settings__row">
          <Pin size={15} className="settings__icon" />
          <span className="settings__label">
            面板保持置顶
            <em className="settings__hint">关闭后主面板会被其他窗口盖住</em>
          </span>
          <input
            type="checkbox"
            className="settings__switch"
            checked={settings.panelAlwaysOnTop}
            onChange={(e) => {
              void patch({ panelAlwaysOnTop: e.target.checked });
              void api.setAlwaysOnTop("panel", e.target.checked);
            }}
          />
        </label>
      </section>

      <section className="settings__group">
        <h4 className="settings__group-title">数据</h4>

        <div className="settings__note">
          所有数据都存在这个文件夹里，纯 JSON 文本，可以直接打开看、手动改、拷走备份：
          <code className="settings__code">{dataDir}</code>
        </div>

        <button className="btn" onClick={() => void api.openDataDir()}>
          <FolderOpen size={13} />
          打开数据文件夹
        </button>

        <div className="settings__note settings__note--warn">
          <Info size={13} />
          <span>
            数据<strong>没有加密</strong>。标记为敏感的文本片段只有列表遮罩这一层视觉保护，
            JSON 里是明文。这是刻意的取舍：加密意味着一旦忘记密码，数据就永久找不回来了。
          </span>
        </div>
      </section>
    </div>
  );
}

export const SettingsFeature: FeatureModule = {
  id: "settings",
  title: "设置",
  description: "开机自启、提示音、粘贴行为、数据位置",
  icon: SettingsIcon,
  order: 90,
  component: SettingsPanel,
};
