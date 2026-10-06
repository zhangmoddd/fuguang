/**
 * `panel-state.ts` 的测试。
 *
 * 重点在两件事上：
 *
 * 1. **键必须按窗口 label 分**。分不开的话窗口 A 切页签会把窗口 B 的位置也改掉，
 *    而表现是"我明明没动过这个窗口，它自己跳页了"—— 极难归因。
 * 2. **坏值不能抛异常**。这个键在开发者工具里一眼可见、能手改，
 *    而它是在组件首次渲染时读的：抛出去就是整个面板白屏。
 */
import { describe, expect, it } from "vitest";

import {
  PANEL_STATE_PREFIX,
  folderOf,
  panelStateKey,
  readPanelState,
  writePanelState,
  type StateStorage,
} from "./panel-state";

/** 内存版 localStorage。 */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage: StateStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
  return { storage, map };
}

describe("panelStateKey", () => {
  it("键里带窗口 label", () => {
    // 所有窗口共享同一个 origin，键不带 label 就会互相覆盖
    expect(panelStateKey("panel")).toBe(`${PANEL_STATE_PREFIX}panel`);
    expect(panelStateKey("panel-2")).toBe(`${PANEL_STATE_PREFIX}panel-2`);
    expect(panelStateKey("panel")).not.toBe(panelStateKey("panel-2"));
  });
});

describe("readPanelState", () => {
  it("没记过就是空对象", () => {
    expect(readPanelState("panel", fakeStorage().storage)).toEqual({});
  });

  it("读得回写进去的东西", () => {
    const { storage } = fakeStorage();
    writePanelState("panel", { featureId: "memo" }, storage);
    expect(readPanelState("panel", storage).featureId).toBe("memo");
  });

  it("两个窗口的状态互不影响", () => {
    const { storage } = fakeStorage();
    writePanelState("panel", { featureId: "memo" }, storage);
    writePanelState("panel-2", { featureId: "timer" }, storage);
    expect(readPanelState("panel", storage).featureId).toBe("memo");
    expect(readPanelState("panel-2", storage).featureId).toBe("timer");
  });

  it("坏 JSON 当成没记过，不抛异常", () => {
    // 这段值是在组件首次渲染时读的，抛出去就是整个面板白屏
    const { storage } = fakeStorage({ [panelStateKey("panel")]: "{不是 JSON" });
    expect(() => readPanelState("panel", storage)).not.toThrow();
    expect(readPanelState("panel", storage)).toEqual({});
  });

  it("不是对象的值也当成没记过", () => {
    for (const raw of ['"[]"', "[]", "null", "42", "true"]) {
      const { storage } = fakeStorage({ [panelStateKey("panel")]: raw });
      expect(readPanelState("panel", storage)).toEqual({});
    }
  });

  it("字段类型不对时只丢那一项，不丢整份", () => {
    const { storage } = fakeStorage({
      [panelStateKey("panel")]: JSON.stringify({
        featureId: 42,
        folders: { snippets: "f1", timer: 7, links: null },
      }),
    });
    const state = readPanelState("panel", storage);
    expect(state.featureId).toBeUndefined();
    // `timer: 7` 会被当成文件夹 id 传下去，必须丢掉；其余两项保留
    expect(state.folders).toEqual({ snippets: "f1", links: null });
  });

  it("空字符串的 featureId 不算记过", () => {
    const { storage } = fakeStorage({
      [panelStateKey("panel")]: JSON.stringify({ featureId: "" }),
    });
    expect(readPanelState("panel", storage).featureId).toBeUndefined();
  });

  it("拿不到存储时不抛异常", () => {
    expect(readPanelState("panel", null)).toEqual({});
  });

  it("存储自己抛异常时也不抛出去", () => {
    const broken: StateStorage = {
      getItem: () => {
        throw new Error("隐私模式");
      },
      setItem: () => {},
    };
    expect(readPanelState("panel", broken)).toEqual({});
  });
});

describe("writePanelState", () => {
  it("只改传进来的那一项，别的不动", () => {
    const { storage } = fakeStorage();
    writePanelState("panel", { featureId: "memo" }, storage);
    writePanelState("panel", { folders: { memo: null } }, storage);
    const state = readPanelState("panel", storage);
    expect(state.featureId).toBe("memo");
    expect(state.folders).toEqual({ memo: null });
  });

  it("写不进时不抛异常（隐私模式 / 配额满）", () => {
    const full: StateStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writePanelState("panel", { featureId: "memo" }, full)).not.toThrow();
  });
});

describe("folderOf", () => {
  it("没记过就是顶层", () => {
    expect(folderOf({}, "snippets")).toBeNull();
    expect(folderOf({ folders: {} }, "snippets")).toBeNull();
  });

  it("记着文件夹 id 就用它", () => {
    expect(folderOf({ folders: { snippets: "f1" } }, "snippets")).toBe("f1");
  });

  it("显式记着 null 表示顶层 —— 用户退回过顶层", () => {
    // 不写这一条的话：用户进过文件夹 A 又退回顶层，重启会重新钻进 A
    expect(folderOf({ folders: { snippets: null } }, "snippets")).toBeNull();
  });

  it("不同页签各自的文件夹互不干扰", () => {
    const state = { folders: { snippets: "f1", timer: "f2" } };
    expect(folderOf(state, "snippets")).toBe("f1");
    expect(folderOf(state, "timer")).toBe("f2");
    expect(folderOf(state, "links")).toBeNull();
  });
});
