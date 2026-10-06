/**
 * `search.ts` 的测试。
 *
 * 重点在**排序**和**命中范围**这两件事上：
 *
 * - 排序错了不会报错，只会让用户觉得"这东西搜不准"，然后就不用了；
 * - 命中范围漏了一类字段（比如标签），表现是"明明有这条，就是搜不到"，
 *   而且用户根本无从判断是漏了还是真没有。
 *
 * 所以这里用固定数据把两者都钉死。
 */
import { describe, expect, it } from "vitest";

import { searchAll, type SearchData, type SearchableSnippet } from "./search";

/** 空数据集。每个测试只覆盖自己关心的那一类。 */
function data(partial: Partial<SearchData> = {}): SearchData {
  return { snippets: [], links: [], memos: [], timers: [], ...partial };
}

/** 造一条片段。测试只关心被搜的那几个字段。 */
function snip(id: string, over: Partial<SearchableSnippet> = {}): SearchableSnippet {
  return { id, title: id, content: "", note: "", tags: [], sensitive: false, ...over };
}

describe("searchAll 基本行为", () => {
  it("空查询返回空结果，而不是列出全部", () => {
    // 命令面板的定位是"找东西"，一打开就倒出几百条反而没法用
    const d = data({ links: [{ id: "a", name: "记事本", target: "notepad.exe" }] });
    expect(searchAll("", d)).toEqual([]);
    expect(searchAll("   ", d)).toEqual([]);
  });

  it("大小写不敏感", () => {
    const d = data({ links: [{ id: "a", name: "GitHub", target: "" }] });
    expect(searchAll("github", d)).toHaveLength(1);
    expect(searchAll("GITHUB", d)).toHaveLength(1);
  });

  it("四类数据都会被搜到", () => {
    const d = data({
      snippets: [snip("s", { title: "目标" })],
      links: [{ id: "l", name: "目标", target: "" }],
      memos: [{ id: "m", date: "2026-09-25", title: "目标", body: "", tags: [] }],
      timers: [{ id: "t", name: "目标", kind: "countdown" }],
    });
    expect(new Set(searchAll("目标", d).map((h) => h.kind))).toEqual(
      new Set(["snippet", "link", "memo", "timer"]),
    );
  });

  it("limit 生效", () => {
    const many = Array.from({ length: 10 }, (_, i) => snip(`s${i}`, { title: "同样的标题" }));
    expect(searchAll("同样", data({ snippets: many }), 3)).toHaveLength(3);
  });
});

describe("排序", () => {
  it("标题命中排在正文命中前面", () => {
    // 用户记得住的通常是自己起的名字，正文里偶然出现同一个词只是巧合
    const d = data({
      snippets: [
        snip("body-hit", { title: "别的", content: "里面提到 deploy" }),
        snip("title-hit", { title: "deploy 脚本", content: "" }),
      ],
    });
    expect(searchAll("deploy", d).map((h) => h.id)).toEqual(["title-hit", "body-hit"]);
  });

  it("词首命中比词中命中靠前", () => {
    const d = data({
      links: [
        { id: "mid", name: "digital", target: "" },
        { id: "start", name: "github", target: "" },
      ],
    });
    expect(searchAll("git", d).map((h) => h.id)).toEqual(["start", "mid"]);
  });

  it("同分时保持「片段 → 链接 → 备忘 → 计时器」的顺序", () => {
    // 靠 sort 的稳定性。不稳定的话每次打开面板结果顺序都在跳
    const d = data({
      snippets: [snip("s", { title: "同名" })],
      links: [{ id: "l", name: "同名", target: "" }],
    });
    expect(searchAll("同名", d).map((h) => h.kind)).toEqual(["snippet", "link"]);
  });
});

describe("多词搜索", () => {
  it("空格分开的词必须全部命中", () => {
    const d = data({
      snippets: [
        snip("both", { title: "github 账号" }),
        snip("only-one", { title: "github 仓库" }),
      ],
    });
    expect(searchAll("github 账号", d).map((h) => h.id)).toEqual(["both"]);
  });

  it("词的顺序不影响命中", () => {
    const d = data({ snippets: [snip("a", { title: "github 账号" })] });
    expect(searchAll("账号 github", d)).toHaveLength(1);
  });

  it("词可以分散在不同字段里", () => {
    // 「标签里有工作」+「正文里有周报」，两个词都命中，这条就该出来
    const d = data({
      snippets: [snip("a", { title: "无关", tags: ["工作"], content: "周报模板" })],
    });
    expect(searchAll("工作 周报", d)).toHaveLength(1);
  });
});

describe("命中范围", () => {
  it("标签参与搜索", () => {
    const d = data({ snippets: [snip("a", { title: "无关", tags: ["工作"] })] });
    expect(searchAll("工作", d)).toHaveLength(1);
  });

  it("备注参与搜索", () => {
    const d = data({ snippets: [snip("a", { title: "无关", note: "开会用" })] });
    expect(searchAll("开会", d)).toHaveLength(1);
  });

  it("链接的路径参与搜索", () => {
    const d = data({ links: [{ id: "a", name: "记事本", target: "C:\\Windows\\notepad.exe" }] });
    expect(searchAll("notepad", d)).toHaveLength(1);
  });

  it("备忘的日期与正文参与搜索", () => {
    const d = data({
      memos: [{ id: "m", date: "2026-09-25", title: "无关", body: "交材料", tags: [] }],
    });
    expect(searchAll("2026-09-25", d)).toHaveLength(1);
    expect(searchAll("交材料", d)).toHaveLength(1);
  });

  it("计时器可以用中文模式名搜到", () => {
    const d = data({ timers: [{ id: "t", name: "煮蛋", kind: "countdown" }] });
    expect(searchAll("倒计时", d)).toHaveLength(1);
    expect(searchAll("煮蛋", d)[0].detail).toBe("倒计时");
  });
});

describe("定位字段", () => {
  it("片段的 folderId 被带出来", () => {
    // 光有 id 定位不了：条目分散在文件夹里，目标页签切过去时可能停在别的文件夹，
    // 那条根本不在当前列表里 —— 用户看到的是"按了回车没反应"
    const d = data({ snippets: [snip("s", { title: "账号", folderId: "f1" })] });
    expect(searchAll("账号", d)[0].folderId).toBe("f1");
  });

  it("顶层条目的 folderId 是 null，不是 undefined", () => {
    // 让"顶层"始终是一个明确的值，调用方不用每处都写 `?? null`
    const d = data({ snippets: [snip("s", { title: "账号", folderId: null })] });
    expect(searchAll("账号", d)[0].folderId).toBeNull();
  });

  it("老数据没有 folderId 字段时也补成 null", () => {
    // `Snippet.folderId` 是后加字段，老数据里没有这一项，读出来是 undefined
    const d = data({ snippets: [snip("s", { title: "账号" })] });
    expect(searchAll("账号", d)[0].folderId).toBeNull();
  });

  it("链接的 folderId 被带出来", () => {
    const d = data({ links: [{ id: "l", name: "记事本", target: "", folderId: "f2" }] });
    expect(searchAll("记事本", d)[0].folderId).toBe("f2");
  });

  it("计时器的 folderId 被带出来", () => {
    const d = data({
      timers: [{ id: "t", name: "煮蛋", kind: "countdown", folderId: "f3" }],
    });
    expect(searchAll("煮蛋", d)[0].folderId).toBe("f3");
  });

  it("备忘带出结构化的日期，而不是只有拼好的显示文本", () => {
    // 原来日期只拼进 detail；定位要靠它，必须单独带一份
    const d = data({
      memos: [{ id: "m", date: "2026-09-25", title: "交材料", body: "带章", tags: [] }],
    });
    const [hit] = searchAll("交材料", d);
    expect(hit.date).toBe("2026-09-25");
    expect(hit.detail).toContain("2026-09-25");
  });

  it("备忘不带 folderId —— 它的组织维度是日期，没有文件夹", () => {
    const d = data({
      memos: [{ id: "m", date: "2026-09-25", title: "交材料", body: "", tags: [] }],
    });
    expect(searchAll("交材料", d)[0].folderId).toBeUndefined();
  });
});

describe("敏感内容", () => {
  it("敏感片段在搜索结果里同样被遮罩", () => {
    // 不遮的话 Ctrl+K 就成了绕过列表遮罩的后门，
    // 而那个遮罩存在的意义就是防录屏和防旁人扫一眼
    const d = data({
      snippets: [snip("secret", { title: "密码", content: "hunter2", sensitive: true })],
    });
    const [hit] = searchAll("密码", d);
    expect(hit.detail).not.toContain("hunter2");
    expect(hit.detail).toContain("•");
  });

  it("非敏感片段正常显示摘要", () => {
    const d = data({ snippets: [snip("a", { title: "邮箱", content: "me@example.com" })] });
    expect(searchAll("邮箱", d)[0].detail).toBe("me@example.com");
  });
});

describe("显示字段", () => {
  it("标题为空时退回正文摘要", () => {
    const d = data({ snippets: [snip("a", { title: "", content: "一段没有标题的正文" })] });
    expect(searchAll("没有标题", d)[0].title).toBe("一段没有标题的正文");
  });

  it("备忘的副标题把日期和正文拼起来，且不留空尾巴", () => {
    const withBody = data({
      memos: [{ id: "m", date: "2026-09-25", title: "交材料", body: "记得带章", tags: [] }],
    });
    expect(searchAll("交材料", withBody)[0].detail).toBe("2026-09-25 · 记得带章");

    const noBody = data({
      memos: [{ id: "m", date: "2026-09-25", title: "交材料", body: "", tags: [] }],
    });
    expect(searchAll("交材料", noBody)[0].detail).toBe("2026-09-25");
  });
});
