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
  Download,
  FolderOpen,
  Info,
  Palette,
  Pin,
  Power,
  RotateCcw,
  Settings as SettingsIcon,
  Type,
} from "lucide-react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";

import { api, emitSettingsChanged, type Settings } from "../../lib/api";
import { BALL_THEMES, applyBallTheme } from "../../lib/ball-theme";
import { todayKey } from "../../lib/datetime";
import { firstPath } from "../../lib/dialog";
import { FONT_SIZE_PRESETS, applyFontSize } from "../../lib/ui-scale";
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
  /**
   * 备份操作的提示。
   *
   * 和 `savedHint` 分开：它要显示完整路径、要留着让用户读完，
   * 不能像「已保存」那样两秒就消失。
   */
  const [backupNote, setBackupNote] = useState<string | null>(null);
  /** 备份 / 恢复进行中，用来禁用按钮防止连点。 */
  const [backupBusy, setBackupBusy] = useState(false);

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

  /**
   * 保存设置并广播给其他窗口。
   *
   * 广播这一步不能省：小球、主面板、提醒弹窗是**三个独立窗口**，
   * 各自有自己的 DOM。在主面板里改 CSS 变量，小球那个窗口完全不知道——
   * 实测就是这个原因导致"换了配色但球不变色"。
   */
  const saveSettings = async (next: Settings) => {
    await api.settingsSave(next);
    await emitSettingsChanged(next);
  };

  /** 保存一项设置。 */
  const patch = async (changes: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...changes };
    setSettings(next);
    try {
      await saveSettings(next);
      setSavedHint("已保存");
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * 导出全部数据。
   *
   * 路径交给系统保存对话框：让用户自己挑地方（U 盘、网盘同步目录…）
   * 比固定导到数据文件夹旁边有用得多——备份的意义就是"放到别处"。
   */
  const exportBackup = async () => {
    setBackupNote(null);
    try {
      const picked = await save({
        title: "导出全部数据",
        // 默认文件名带日期：攒了几份备份之后，一眼能看出哪份是什么时候的
        defaultPath: `浮光备份-${todayKey()}.json`,
        filters: [{ name: "浮光备份", extensions: ["json"] }],
      });
      // 用户取消时返回 null，这不是错误，什么都不用说
      if (!picked) return;

      setBackupBusy(true);
      await api.exportAll(picked);
      setBackupNote(`已导出到 ${picked}`);
    } catch (err) {
      setBackupNote(`导出失败：${String(err)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  /**
   * 从备份恢复。
   *
   * 三步：选文件 → **明确确认** → 导入后重载界面。
   * 中间那步不能省：它会覆盖全部数据，而且没有撤销。
   */
  const importBackup = async () => {
    setBackupNote(null);
    try {
      const picked = firstPath(
        await open({
          title: "选择浮光的备份文件",
          multiple: false,
          directory: false,
          filters: [{ name: "浮光备份", extensions: ["json"] }],
        }),
      );
      if (!picked) return;

      const confirmed = await ask(
        "导入会用备份里的内容覆盖当前的全部数据（文本片段、计时器、备忘、链接、文件夹、设置）。\n当前数据会被替换，无法撤销。要继续吗？",
        { title: "从备份恢复", kind: "warning", okLabel: "覆盖导入", cancelLabel: "取消" },
      );
      if (!confirmed) return;

      setBackupBusy(true);
      await api.importAll(picked);

      // 先把新设置广播给小球窗口——它不会跟着面板一起重载，不广播的话
      // 悬浮球会一直停在导入前的配色。
      await emitSettingsChanged(await api.settingsGet());

      // 再让面板整页重载：四个功能模块的内存状态都还是导入前那份，
      // 不重载就会显示已经不存在的数据（点了没反应，最难排查）。
      window.location.reload();
    } catch (err) {
      setBackupNote(`导入失败：${String(err)}`);
      setBackupBusy(false);
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

  /**
   * 改字号。
   *
   * 先本地套用再保存：改字号是"所见即所得"的操作，
   * 等一次 IPC 往返再变会有明显延迟感。
   */
  const setFontSize = async (px: number) => {
    applyFontSize(px);
    if (settings) setSettings({ ...settings, fontSizePx: px });
    try {
      await saveSettings({ ...settings!, fontSizePx: px });
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * 改悬浮球配色。
   *
   * 同样是先本地套用再保存——配色是"所见即所得"的操作，
   * 等一次 IPC 往返再变会有明显延迟感。
   */
  const setBallTheme = async (id: string) => {
    applyBallTheme(id);
    if (settings) setSettings({ ...settings, ballTheme: id });
    try {
      await saveSettings({ ...settings!, ballTheme: id });
      setError(null);
    } catch (err) {
      setError(String(err));
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
        <h4 className="settings__group-title">界面</h4>

        <div className="settings__row">
          <Type size={15} className="settings__icon" />
          <span className="settings__label">
            字体大小
            <em className="settings__hint">
              整个界面一起变：主面板、提醒弹窗、各个功能页。
              面板宽度是固定的，所以只给了几档试好的预设
            </em>
          </span>
        </div>

        <div className="settings__sizes">
          {FONT_SIZE_PRESETS.map((preset) => {
            const active = settings.fontSizePx === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                className={`settings__size${active ? " settings__size--active" : ""}`}
                onClick={() => void setFontSize(preset.value)}
                title={`${preset.value}px`}
              >
                {/* 每一档用它自己的字号显示，这样不用点就能看出差别 */}
                <span style={{ fontSize: `${preset.value}px` }}>{preset.label}</span>
                <em className="settings__size-px">{preset.value}px</em>
              </button>
            );
          })}
        </div>

        <div className="settings__row settings__row--spaced">
          <Palette size={15} className="settings__icon" />
          <span className="settings__label">
            悬浮球配色
            <em className="settings__hint">
              只影响屏幕上那个小球。深色底配白标志、浅色底配深标志，
              所以这里给的是成对的方案，不能单独挑颜色
            </em>
          </span>
        </div>

        <div className="settings__balls">
          {BALL_THEMES.map((theme) => {
            const active = settings.ballTheme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                className={`settings__ball${active ? " settings__ball--active" : ""}`}
                onClick={() => void setBallTheme(theme.id)}
                title={theme.label}
              >
                {/* 直接按配色画出小球本体，所见即所得 */}
                <span
                  className="settings__ball-dot"
                  style={{
                    background: theme.background,
                    borderColor: theme.border,
                  }}
                >
                  <span
                    className="settings__ball-mark"
                    style={{ backgroundColor: theme.mark }}
                  />
                </span>
              </button>
            );
          })}
        </div>
      </section>

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
          {/* 开发模式下这个路径指向 target\debug。调试版不内嵌前端，
              开机时连不上开发服务器就会显示浏览器的「无法访问此页面」，
              所以后端会直接拒绝开启，这里提前把原因说清楚，别让用户以为是软件坏了 */}
          {exePath.includes("target") && (
            <span className="settings__warn">
              注意：当前跑的是开发模式（调试版）。调试版没有把界面打包进 exe，
              开机时连不上开发服务器，小球和面板只会显示浏览器的「无法访问此页面」，
              所以这个开关在开发模式下会被拒绝。
              想要开机自启，请先跑一次 <code className="settings__code">2-重新编译.bat</code>，
              再用 <code className="settings__code">src-tauri\target\release\fuguang.exe</code> 启动本软件。
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

        <div className="settings__row settings__row--spaced">
          <Download size={15} className="settings__icon" />
          <span className="settings__label">
            导出 / 恢复
            <em className="settings__hint">
              把全部数据打成一个 JSON 文件。换电脑、重装系统之前导一份出来，
              以后用它一键恢复
            </em>
          </span>
          <button className="btn" disabled={backupBusy} onClick={() => void exportBackup()}>
            导出
          </button>
          <button className="btn" disabled={backupBusy} onClick={() => void importBackup()}>
            恢复
          </button>
        </div>

        {backupNote && (
          <div className="settings__note">
            <Info size={13} />
            <span>{backupNote}</span>
          </div>
        )}

        <div className="settings__note settings__note--warn">
          <Info size={13} />
          <span>
            数据<strong>没有加密</strong>。标记为敏感的文本片段只有列表遮罩这一层视觉保护，
            JSON 里是明文。这是刻意的取舍：加密意味着一旦忘记密码，数据就永久找不回来了。
          </span>
        </div>
      </section>

      <section className="settings__group">
        <h4 className="settings__group-title">退出</h4>

        {/*
          退出放在这里，而不是面板标题栏的 ✕。
          ✕ 在窗口里的惯例是"关掉这个窗口"，把它绑成"杀进程"会让用户
          按直觉点一下就丢掉整个软件（实测被用户踩到过）。
          这里、小球的右键菜单、托盘菜单，才是用户明确表达"我要退出"的地方。
        */}
        <div className="settings__note">
          退出后悬浮球和托盘图标都会消失，<strong>计时器和提醒也会停止</strong>。
          数据不会丢，下次启动照旧。
          <br />
          想再启动：开始菜单里搜「浮光」，或双击程序本体。
        </div>

        <button
          className="btn btn--danger"
          onClick={() => void api.quit()}
        >
          <Power size={13} />
          退出浮光
        </button>
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
