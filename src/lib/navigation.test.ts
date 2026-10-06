/**
 * `navigation.ts` 的测试。
 *
 * 重点在**匹配与序号判定**上：这段逻辑错了不会抛异常，只会表现成
 * 「有时候按回车没反应」「同一条搜两次只跳一次」—— 都是最难排查的那类 bug，
 * 所以用固定数据把它钉死。
 */
import { describe, expect, it } from "vitest";

import {
  actionForKey,
  featureOfKind,
  focusTargetOf,
  makeFocusTarget,
  nextFocusSeq,
  paletteActions,
  paletteKeyOf,
  shouldDeliverFocus,
  type FocusTarget,
  type PaletteKey,
} from "./navigation";
import type { SearchHit } from "./search";

/** 造一条请求。 */
function target(over: Partial<FocusTarget> = {}): FocusTarget {
  return { featureId: "snippets", id: "s1", seq: 1, ...over };
}

describe("nextFocusSeq", () => {
  it("单调递增", () => {
    // 消费方的判定是 `seq > lastSeq`，不递增就永远不会被再次交付
    expect(nextFocusSeq(0)).toBe(1);
    expect(nextFocusSeq(1)).toBe(2);
    expect(nextFocusSeq(41)).toBe(42);
  });
});

describe("makeFocusTarget", () => {
  it("带上传进去的字段与序号", () => {
    expect(makeFocusTarget({ featureId: "memo", id: "m1", date: "2026-09-25" }, 7)).toEqual({
      featureId: "memo",
      id: "m1",
      date: "2026-09-25",
      seq: 7,
    });
  });

  it("同一条连续请求两次，产出的是**两个不同的对象**", () => {
    // 这是 E1/E2 依赖的语义：用户本来就在那个页签上时组件不会重挂
    // （`setActiveId` 是 no-op），`useEffect(..., [target])` 只有靠 identity 变化
    // 才会再跑一次。做成同一个引用的话，同一条搜第二次就再也不触发了。
    const input = { featureId: "snippets", id: "s1", folderId: "f1" };
    const first = makeFocusTarget(input, nextFocusSeq(0));
    const second = makeFocusTarget(input, nextFocusSeq(1));

    expect(first).not.toBe(second);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    // 内容一致（除了序号）—— 也就是说 identity 不同**不是**因为字段变了
    expect({ ...first, seq: second.seq }).toEqual(second);
  });

  it("不修改传进来的那个对象", () => {
    // `{...input, seq}` 而不是 `Object.assign(input, { seq })`：
    // 后者会把调用方手里那份也改掉，而且两次请求会变成同一个引用
    const input = { featureId: "snippets", id: "s1" };
    makeFocusTarget(input, 3);
    expect(input).toEqual({ featureId: "snippets", id: "s1" });
    expect("seq" in input).toBe(false);
  });
});

describe("shouldDeliverFocus", () => {
  it("没有请求时什么都不交付", () => {
    expect(shouldDeliverFocus(null, "snippets", 0)).toBe(false);
  });

  it("类型对得上才交付", () => {
    // 备忘的请求不能交给片段页：交错了会去片段列表里找一个不存在的 id
    expect(shouldDeliverFocus(target({ featureId: "memo" }), "snippets", 0)).toBe(false);
    expect(shouldDeliverFocus(target({ featureId: "memo" }), "memo", 0)).toBe(true);
  });

  it("序号不比已消费的大就不交付", () => {
    expect(shouldDeliverFocus(target({ seq: 3 }), "snippets", 3)).toBe(false);
    expect(shouldDeliverFocus(target({ seq: 2 }), "snippets", 3)).toBe(false);
    expect(shouldDeliverFocus(target({ seq: 4 }), "snippets", 3)).toBe(true);
  });

  it("同一条被搜第二次（新序号）仍然交付", () => {
    // 用户本来就在这个页签上时组件不会重挂，只有新 identity 能让 effect 再跑
    const first = target({ id: "s1", seq: 1 });
    const again = target({ id: "s1", seq: 2 });
    expect(shouldDeliverFocus(first, "snippets", 0)).toBe(true);
    expect(shouldDeliverFocus(again, "snippets", 1)).toBe(true);
  });
});

describe("featureOfKind", () => {
  it("片段在注册表里叫 snippets（复数）", () => {
    // 写错的表现是"按回车什么都不发生"：setActiveId 收到一个不存在的 id，
    // 面板会退回第一个页签，用户以为搜索坏了
    expect(featureOfKind("snippet")).toBe("snippets");
  });

  it("其余三类与注册表 id 同名", () => {
    expect(featureOfKind("memo")).toBe("memo");
    expect(featureOfKind("timer")).toBe("timer");
    expect(featureOfKind("link")).toBe("links");
  });
});

describe("actionForKey", () => {
  it("回车一条备忘 → 打开（这是用户原始投诉的回归测试）", () => {
    // 用户原话："这个搜索不应该是直接打开这个东西所在位置并且打开吗？"
    // 上一轮的抱怨就是"按了没反应"。回车跳过去还要再按一次才打开，
    // 等于把同一个抱怨换个形式又犯一遍。
    expect(actionForKey("Enter", "memo")).toBe("open");
  });

  it("回车一条片段 / 计时器 → 打开", () => {
    expect(actionForKey("Enter", "snippet")).toBe("open");
    expect(actionForKey("Enter", "timer")).toBe("open");
  });

  it("回车一条链接 → 只定位，**不启动**外部程序", () => {
    // 启动是链接的主动作（Ctrl+回车）。让回车去启动的话，
    // 用户只是想看看那条链接在哪个文件夹，却把程序拉起来了
    expect(actionForKey("Enter", "link")).toBe("focus");
    expect(actionForKey("Enter", "link")).not.toBe("primary");
  });

  it("Ctrl+回车 → 执行主动作，四类都有", () => {
    for (const kind of ["snippet", "link", "memo", "timer"] as const) {
      expect(actionForKey("Ctrl+Enter", kind)).toBe("primary");
    }
  });

  it("Shift+回车 → 复制；备忘 / 计时器上是 none", () => {
    expect(actionForKey("Shift+Enter", "snippet")).toBe("copy");
    expect(actionForKey("Shift+Enter", "link")).toBe("copy");
    // 计时器的"内容"是个时间；复制它没有意义。列出来又按不动更糟
    expect(actionForKey("Shift+Enter", "memo")).toBe("none");
    expect(actionForKey("Shift+Enter", "timer")).toBe("none");
  });
});

describe("paletteKeyOf", () => {
  it("不按修饰键就是回车", () => {
    expect(paletteKeyOf({ ctrl: false, shift: false })).toBe("Enter");
  });

  it("Ctrl 优先于 Shift", () => {
    expect(paletteKeyOf({ ctrl: true, shift: false })).toBe("Ctrl+Enter");
    expect(paletteKeyOf({ ctrl: false, shift: true })).toBe("Shift+Enter");
    expect(paletteKeyOf({ ctrl: true, shift: true })).toBe("Ctrl+Enter");
  });
});

describe("paletteActions", () => {
  it("片段：回车定位并打开、Ctrl+回车键入到光标、Shift+回车复制正文", () => {
    expect(paletteActions("snippet")).toEqual([
      { id: "open", key: "Enter", label: "定位并打开" },
      { id: "primary", key: "Ctrl+Enter", label: "键入到光标" },
      { id: "copy", key: "Shift+Enter", label: "复制正文" },
    ]);
  });

  it("链接：回车只定位（它的主动作是启动，落在 Ctrl+回车）", () => {
    expect(paletteActions("link")).toEqual([
      { id: "focus", key: "Enter", label: "定位到它" },
      { id: "primary", key: "Ctrl+Enter", label: "打开链接" },
      { id: "copy", key: "Shift+Enter", label: "复制地址" },
    ]);
  });

  it("备忘 / 计时器只有两档，且都指向「打开编辑器」", () => {
    for (const kind of ["memo", "timer"] as const) {
      expect(paletteActions(kind)).toEqual([
        { id: "open", key: "Enter", label: "定位并打开" },
        { id: "primary", key: "Ctrl+Enter", label: "打开编辑器" },
      ]);
    }
  });

  it("提示条上列出的键，与 actionForKey 判为可用的键完全一致", () => {
    // 这是"同一个函数推导出来"的硬证据：两边各写一遍的话迟早不一致，
    // 表现成"提示条上写着能按、按下去却没反应"
    const keys: PaletteKey[] = ["Enter", "Ctrl+Enter", "Shift+Enter"];
    for (const kind of ["snippet", "link", "memo", "timer"] as const) {
      const fromTable = keys.filter((k) => actionForKey(k, kind) !== "none");
      expect(paletteActions(kind).map((a) => a.key)).toEqual(fromTable);
    }
  });

  it("Shift+回车 在备忘 / 计时器上不出现在提示条里", () => {
    for (const kind of ["memo", "timer"] as const) {
      expect(paletteActions(kind).some((a) => a.key === "Shift+Enter")).toBe(false);
    }
  });

  it("文案里不再出现「切到…页」这种降级说法", () => {
    // 那是"实现只做了切页签"时用来兜底的实话；现在定位真的带位置了
    for (const kind of ["snippet", "link", "memo", "timer"] as const) {
      for (const a of paletteActions(kind)) {
        expect(a.label).not.toContain("切到");
        expect(a.label).not.toBe("");
      }
    }
  });
});

describe("focusTargetOf", () => {
  /** 造一条搜索结果。 */
  function hit(over: Partial<SearchHit> = {}): SearchHit {
    return { kind: "snippet", id: "s1", title: "标题", detail: "", score: 1, ...over };
  }

  it("片段的文件夹被带进请求", () => {
    expect(focusTargetOf(hit({ folderId: "f1" }))).toEqual({
      featureId: "snippets",
      id: "s1",
      folderId: "f1",
    });
  });

  it("顶层条目带 folderId: null，而不是干脆不带", () => {
    // 消费方要"进到目标文件夹"，null 就是"回顶层"这个明确指令
    expect(focusTargetOf(hit({ folderId: null })).folderId).toBeNull();
  });

  it("备忘带日期、不带 folderId", () => {
    expect(focusTargetOf(hit({ kind: "memo", id: "m1", date: "2026-09-25" }))).toEqual({
      featureId: "memo",
      id: "m1",
      date: "2026-09-25",
    });
  });

  it("open 只在需要时出现", () => {
    // 不打开时连字段都不带：消费方写 `if (target.open)` 就够了
    expect("open" in focusTargetOf(hit())).toBe(false);
    expect(focusTargetOf(hit(), true).open).toBe(true);
  });

  it("链接映射到 links 这个页签 id", () => {
    expect(focusTargetOf(hit({ kind: "link", id: "l1" })).featureId).toBe("links");
  });
});
