/**
 * 渲染期异常的兜底。
 *
 * # 为什么必须有
 *
 * 面板窗口是 `prevent_close` + `hide`（见 `src-tauri/src/lib.rs`）——
 * **组件不会卸载**。所以任何一次渲染期异常都会把这棵树永久停在那里：
 * 用户看到 420×640 的一片空白，关掉面板再打开还是白的，
 * 只有杀掉进程才能恢复。而最典型的触发源恰恰是用户自己能造成的：
 * 手改坏 `%APPDATA%\浮光\*.json`。
 *
 * 前端已经对已知的几处做了形状校验（见 `usePersistentState` 的 `isShapeValid`），
 * 但校验只能覆盖"想得到"的形状；这一层是兜底，保证**任何**没想到的异常
 * 至少能变成一句人话 + 一个能重来的按钮。
 *
 * # 为什么是 class
 *
 * React 只支持 class 组件做错误边界（`getDerivedStateFromError`），
 * 至今没有等价的 Hook。
 */
import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 正式版没有 stderr（`windows_subsystem = "windows"`），
    // 但 WebView 的控制台在开发模式下（Ctrl+Shift+I）仍然看得到
    console.error("[浮光] 界面渲染出错：", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="panel">
        <div className="placeholder">
          <h3>界面出错了</h3>
          <p>{error.message || String(error)}</p>
          <p>
            数据本身一般还在。如果刚手改过 <code>%APPDATA%\浮光\</code> 里的{" "}
            <code>.json</code>，把它改回来（或者改名）再点下面的按钮。
          </p>
          <button
            className="btn btn--primary"
            onClick={() => {
              // 整页重载而不是只清 error：要重新走一遍"读数据 → 渲染"。
              // 只清 error 的话下一次渲染还是拿同一份坏数据，必然立刻再炸，
              // 用户看到的是按钮"点了没反应"。
              window.location.reload();
            }}
          >
            重新加载界面
          </button>
        </div>
      </div>
    );
  }
}
