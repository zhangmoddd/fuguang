/**
 * 数据持久化。
 *
 * 数据存在 `%APPDATA%\浮光\*.json`，纯文本、可手动编辑、可直接备份。
 * 刻意不用数据库：这个体量（几千条文本）用 JSON 完全够，而且用户能自己打开看、自己抢救。
 *
 * 写入策略是「防抖批量写」：用户连续敲字时不会每敲一个字符就写一次磁盘，
 * 但会在停顿 400ms 后落盘，并且切换页面/关闭窗口时强制立即落盘，保证不丢数据。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";

/** 写入防抖延迟。太短会频繁写盘，太长会在异常退出时丢更多数据。 */
const WRITE_DEBOUNCE_MS = 400;

/**
 * 把一份数据绑定到磁盘上的一个 JSON 文件。
 *
 * @param file 数据文件名，例如 `snippets.json`
 * @param initial 文件不存在时使用的初始值
 * @returns 当前数据、更新函数、是否仍在首次加载
 */
export function usePersistentState<T>(file: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 最新的值，供 flush 使用，避免闭包捕获旧值。 */
  const latest = useRef<T>(initial);
  /** 是否有未落盘的改动。 */
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  /** 立即把当前值写入磁盘。 */
  const flush = useCallback(async () => {
    if (!dirty.current) return;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      await api.writeData(file, latest.current);
      dirty.current = false;
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [file]);

  // 首次加载：从磁盘读，读不到就用 initial
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await api.readData<T>(file);
        if (cancelled) return;
        if (loaded !== null && loaded !== undefined) {
          setValue(loaded);
          latest.current = loaded;
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  /** 更新数据并安排一次防抖写入。 */
  const update = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next =
          typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
        latest.current = next;
        dirty.current = true;

        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          void flush();
        }, WRITE_DEBOUNCE_MS);

        return next;
      });
    },
    [flush],
  );

  // 窗口关闭/隐藏前强制落盘，避免防抖窗口内退出导致丢数据
  useEffect(() => {
    const onHide = () => {
      void flush();
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
      // 组件卸载（例如面板被销毁）时也要落盘
      void flush();
    };
  }, [flush]);

  return { value, update, loading, error, flush };
}

/** 生成一个足够唯一的 id。不引入 uuid 依赖，因为本地单机场景时间戳+随机数已足够。 */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
