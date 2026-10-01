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
import { WriteCoordinator } from "./write-coordinator";

/** 写入防抖延迟。太短会频繁写盘，太长会在异常退出时丢更多数据。 */
const WRITE_DEBOUNCE_MS = 400;

/**
 * 把一份数据绑定到磁盘上的一个 JSON 文件。
 *
 * @param file 数据文件名，例如 `snippets.json`
 * @param initial 文件不存在时使用的初始值
 * @param isShapeValid 可选的形状校验。返回 `false` 时**不采纳**磁盘上的值，
 *   而是保持 `initial` 并给一条明确的错误。见下面加载那段的说明。
 * @returns 当前数据、更新函数、是否仍在首次加载
 */
export function usePersistentState<T>(
  file: string,
  initial: T,
  isShapeValid?: (value: unknown) => boolean,
) {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 最新的值，供 flush 使用，避免闭包捕获旧值。 */
  const latest = useRef<T>(initial);
  /** 写盘版本协调：解决"写盘飞行期间的新改动被误清"（见 write-coordinator.ts）。 */
  const coord = useRef(new WriteCoordinator());
  /** 本地是否发生过改动。回读磁盘时用它判断"能不能拿磁盘盖掉本地"。 */
  const touched = useRef(false);
  /** 连续写失败次数：给重试做退避，并设个上限（磁盘真写不了时不能一直撞）。 */
  const failures = useRef(0);
  const timer = useRef<number | null>(null);
  /**
   * 形状校验函数放 ref 里，**不进加载 effect 的依赖**。
   *
   * 调用方多半写成内联箭头函数（`(v) => Array.isArray(v)`），每次渲染都是新的；
   * 进依赖的话加载 effect 会每渲染一次就重跑一次，等于不停地重读磁盘。
   */
  const shapeRef = useRef(isShapeValid);
  useEffect(() => {
    shapeRef.current = isShapeValid;
  });
  /**
   * 正在飞的那次写盘。
   *
   * `flush()` 要能**如实回答"存上了没有"**（片段编辑器靠它决定提示"已保存"
   * 还是"保存失败"），而"已经有写盘在飞"时 `begin()` 会返回 null ——
   * 那种情况下必须等这次飞行落地再回答，否则会撒一个"已保存"的谎。
   */
  const pending = useRef<Promise<boolean> | null>(null);

  /**
   * 立即把当前值写入磁盘。
   *
   * @returns **是否确实写成功了**。没有待写内容算成功；写失败算失败。
   *   调用方（例如"保存"按钮）必须等这个结果再告诉用户"已保存" ——
   *   原来它返回 void，于是界面只能无条件说成功。
   */
  const flush = useCallback(async (): Promise<boolean> => {
    // 已经有一次在飞：先等它落地。落地后如果还有新改动，下面会再写一次。
    const flying = pending.current;
    if (flying) {
      await flying;
      if (!coord.current.dirty) return true;
    }

    const writing = coord.current.begin();
    if (writing === null) {
      // 走到这里只有一种可能：`dirty` 为假（在飞的情况上面已经等过了）。
      // 也就是说磁盘上已经是最新的，算成功。
      //
      // 注意这里**不能**顺手把定时器清掉：清了之后，万一在飞的那次写失败
      // （它只调 fail()、不 commit），就再没有任何东西安排下一次写盘了 ——
      // 用户若就此不再改动并退出，最后一次编辑会永久丢失。
      return !coord.current.dirty;
    }

    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }

    const task = (async (): Promise<boolean> => {
      try {
        await api.writeData(file, latest.current);
        setError(null);
        failures.current = 0;
        // 写盘期间用户又改了：必须立刻再写一次。
        // 旧实现这里是无条件 `dirty = false`，那一次改动就永远落不了盘 ——
        // 而且 beforeunload / 窗口隐藏的兜底落盘走的也是这个函数，同样会早退。
        if (coord.current.commit(writing)) {
          timer.current = window.setTimeout(() => {
            void flush();
          }, 0);
        }
        return true;
      } catch (err) {
        // 写失败：解除"在飞"标记但不动版本号，于是 dirty 保持为真
        coord.current.fail();
        setError(String(err));

        // 而且必须**自己再排一次**：此刻 dirty 为真、却没有任何定时器在等
        // （`begin()` 早退那条路径已经把定时器清掉了）。只靠"下次 update 会排"
        // 是不够的 —— 用户可能就此不再改动，直接从托盘退出。
        // 加上限 + 递增间隔：磁盘真的写不了时不能每 400ms 撞一次。
        if (failures.current < 3) {
          failures.current += 1;
          timer.current = window.setTimeout(
            () => {
              void flush();
            },
            WRITE_DEBOUNCE_MS * failures.current,
          );
        }
        return false;
      }
    })();

    pending.current = task;
    try {
      return await task;
    } finally {
      // 只有队尾还是自己时才清，否则会把后来者的记录删掉
      if (pending.current === task) pending.current = null;
    }
  }, [file]);

  // 首次加载：从磁盘读，读不到就用 initial
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await api.readData<T>(file);
        if (cancelled) return;
        if (loaded !== null && loaded !== undefined && !touched.current) {
          /**
           * ⚠️ 形状校验不能省。
           *
           * `read_data` 返回的是 `serde_json::Value`，**只保证是合法 JSON，
           * 不保证是我们要的形状**；`api.readData<T>` 是纯类型断言，
           * 运行期零校验。而这个文件是纯文本、用户能手改 ——
           * 把它写成 `{"a":1}`（或者 `"[]"` 这种字符串），
           * 消费方一句 `snippets.filter(...)` 就在**渲染期**抛异常。
           *
           * 渲染期异常会把整棵 React 树掀掉（`main.tsx` 的 ErrorBoundary 兜着），
           * 而面板窗口是 `prevent_close` + `hide`、**组件不会卸载** ——
           * 于是用户看到的是 420×640 的一片空白，关掉面板再打开还是白的，
           * 只有杀掉进程才能恢复。
           *
           * 所以这里宁可不采纳：保持空数据 + 一条说明，界面还能用，
           * 用户也能看懂发生了什么（磁盘上的文件一个字节都没动）。
           */
          if (shapeRef.current && !shapeRef.current(loaded)) {
            setError(
              `${file} 的内容不是软件认识的形状（多半是被手改过）。` +
                `当前显示为空，磁盘上的文件没有被改动 —— 改回来或把它改名再重启即可。`,
            );
            return;
          }
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
        touched.current = true;
        coord.current.markDirty();

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
