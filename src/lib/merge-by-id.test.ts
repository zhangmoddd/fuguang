/**
 * `merge-by-id.ts` 的测试。
 *
 * 合并错了**不会报错**，只会静默丢数据 —— 而且丢的是"另一个窗口刚存下的东西"，
 * 用户完全没有线索。所以这里按情形穷举，并且**钉行为**（"B 新加的那条在 A 写盘
 * 之后还在"），不是钉实现细节。
 *
 * 最要紧的一组是「远端删除」和「本地新增」的歧义：两者看起来都是"id 只出现在
 * 一边"，分不清就会把对方删掉的条目**复活**、或者把对方新加的条目**删掉**。
 * 分开它们的唯一依据是 `base` 的成员关系。
 */
import { describe, expect, it } from "vitest";

import { isIdItem, mergeById, sameValue, type HasId } from "./merge-by-id";

/** 造一条记录。只有 id 参与"是不是同一条"，`text` 代表内容。 */
function row(id: string, text: string): HasId & { text: string } {
  return { id, text };
}

const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe("sameValue", () => {
  it("基本类型按值比较", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue(true, true)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(1, 2)).toBe(false);
    expect(sameValue("a", "b")).toBe(false);
    expect(sameValue(null, false)).toBe(false);
    expect(sameValue(0, null)).toBe(false);
  });

  it("NaN 与 NaN 算相同", () => {
    // `NaN === NaN` 是 false，但两条记录里都是 NaN 时它们并没有差别；
    // 不特判的话每一条都会被判成"改过了"
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
  });

  it("数组按长度和逐项比较", () => {
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue([], [])).toBe(true);
    expect(sameValue([1], 1)).toBe(false);
  });

  it("对象**不看键的顺序**", () => {
    // 同一个对象经过 `{...x, title: "..."}` 之后键顺序就可能变了。
    // 用 JSON.stringify 比较的话这里会返回 false，于是"只有远端改了"被误判成
    // "本地也改了"，白白丢掉远端的修改。
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue({ a: 1 }, { b: 1 })).toBe(false);
  });

  it("嵌套结构也逐层比较", () => {
    expect(sameValue({ a: { b: [1, { c: "x" }] } }, { a: { b: [1, { c: "x" }] } })).toBe(true);
    expect(sameValue({ a: { b: [1, { c: "x" }] } }, { a: { b: [1, { c: "y" }] } })).toBe(false);
  });

  it("自己和自己（同一引用）永远是相同的", () => {
    const value = { a: [1, 2] };
    expect(sameValue(value, value)).toBe(true);
  });
});

describe("isIdItem", () => {
  it("只认带字符串 id 的对象", () => {
    expect(isIdItem({ id: "a" })).toBe(true);
    expect(isIdItem({ id: "" })).toBe(true);
    expect(isIdItem({ id: 1 })).toBe(false);
    expect(isIdItem({ name: "a" })).toBe(false);
    expect(isIdItem(null)).toBe(false);
    expect(isIdItem("a")).toBe(false);
    expect(isIdItem([])).toBe(false);
  });
});

describe("mergeById 基本情形", () => {
  it("两边都没改 → 原样", () => {
    const base = [row("a", "1"), row("b", "2")];
    const merged = mergeById(base, base, base);
    expect(ids(merged)).toEqual(["a", "b"]);
    expect(merged[0].text).toBe("1");
  });

  it("本地新增 → 保留", () => {
    const base = [row("a", "1")];
    const local = [row("b", "本地新加"), row("a", "1")];
    const merged = mergeById(base, local, base);
    expect(ids(merged)).toEqual(["b", "a"]);
    expect(merged[0].text).toBe("本地新加");
  });

  it("远端新增 → 采纳（这就是「另一个窗口存了一条」）", () => {
    const base = [row("a", "1")];
    const remote = [row("b", "远端新加"), row("a", "1")];
    const merged = mergeById(base, base, remote);
    expect(ids(merged)).toEqual(["a", "b"]);
    expect(merged[1].text).toBe("远端新加");
  });

  it("本地删除 → 删掉（远端没动过它）", () => {
    const base = [row("a", "1"), row("b", "2")];
    const local = [row("a", "1")];
    expect(ids(mergeById(base, local, base))).toEqual(["a"]);
  });

  it("远端删除 → 删掉（本地没动过它）", () => {
    const base = [row("a", "1"), row("b", "2")];
    const remote = [row("a", "1")];
    expect(ids(mergeById(base, base, remote))).toEqual(["a"]);
  });

  it("两边都删了 → 删掉", () => {
    const base = [row("a", "1"), row("b", "2")];
    const local = [row("a", "1")];
    const remote = [row("a", "1")];
    expect(ids(mergeById(base, local, remote))).toEqual(["a"]);
  });

  it("本地修改 → 本地那份赢（远端没动过）", () => {
    const base = [row("a", "旧")];
    const local = [row("a", "本地改的")];
    const merged = mergeById(base, local, base);
    expect(merged[0].text).toBe("本地改的");
  });

  it("远端修改 → 采纳远端那份（本地没动过）", () => {
    const base = [row("a", "旧")];
    const remote = [row("a", "远端改的")];
    const merged = mergeById(base, base, remote);
    expect(merged[0].text).toBe("远端改的");
  });

  it("两边改同一条、**都没有 updatedAt** → 本地赢", () => {
    // ⚠️ 这一条**只**验证"没有时间戳时退回本地赢"这条兜底规则。
    // 它原来叫「两边改同一条 → 本地赢」，名字说的是 A、实际验的是 B ——
    // 那时上面「靠 updatedAt 分先后」的规则还没写，后来规则变了它照样绿，
    // 因为这两条记录根本没有 `updatedAt`。**真正验新规则的是下面那一组**
    // （describe「两边都改过同一条：靠 updatedAt 分先后」）。
    const base = [row("a", "旧")];
    const local = [row("a", "本地改的")];
    const remote = [row("a", "远端改的")];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });

  it("两边各自新增了同一个 id → 本地赢", () => {
    const base: (HasId & { text: string })[] = [];
    const local = [row("x", "本地的")];
    const remote = [row("x", "远端的")];
    expect(mergeById(base, local, remote)[0].text).toBe("本地的");
  });

  it("空数组边界：三边都空", () => {
    expect(mergeById([], [], [])).toEqual([]);
  });

  it("空数组边界：base 空（首次同步后立刻分岔）", () => {
    // base 为空时"谁新加的"由 local / remote 各自带出，两边都有就本地赢
    const merged = mergeById([], [row("a", "本地的")], [row("b", "远端的")]);
    expect(ids(merged)).toEqual(["a", "b"]);
  });

  it("空数组边界：本地被清空（用户全删了）", () => {
    const base = [row("a", "1"), row("b", "2")];
    // 远端没动过 → 跟着删
    expect(mergeById(base, [], base)).toEqual([]);
  });

  it("空数组边界：远端被清空", () => {
    const base = [row("a", "1")];
    expect(mergeById(base, base, [])).toEqual([]);
  });

  it("结果里的元素就是传进来的那些对象（不是复制出来的）", () => {
    // 断言这一点是因为 `store.ts` 的 `mergeValues` 里有一处类型断言，
    // 它的正当性完全建立在这条性质上
    const base = [row("a", "1")];
    const local = [row("b", "2")];
    const merged = mergeById(base, local, base);
    expect(merged[0]).toBe(local[0]);
  });
});

describe("「远端删除」与「本地新增」的歧义", () => {
  it("id 在 base 里 → 是「被远端删了」，不是「本地新增」", () => {
    // 分不清就会把对方删掉的条目复活
    const base = [row("a", "1"), row("gone", "曾经存在")];
    const local = base; // 本地没动
    const remote = [row("a", "1")]; // 远端删了 gone
    expect(ids(mergeById(base, local, remote))).toEqual(["a"]);
  });

  it("id 不在 base 里 → 是「本地新增」，不是「被远端删了」", () => {
    // 分不清就会把本地刚加的那条删掉（表现是"我加的东西自己没了"）
    const base = [row("a", "1")];
    const local = [row("new", "本地刚加的"), row("a", "1")];
    const remote = [row("a", "1")]; // 远端只是没看到这一条
    expect(ids(mergeById(base, local, remote))).toEqual(["new", "a"]);
  });

  it("两个方向在同一组数据上同时成立", () => {
    // 一个 id 被远端删掉、另一个 id 是本地新加的：两条规则必须各归各位
    const base = [row("keep", "1"), row("deletedByRemote", "2")];
    const local = [row("keep", "1"), row("deletedByRemote", "2"), row("addedLocally", "3")];
    const remote = [row("keep", "1")];
    expect(ids(mergeById(base, local, remote))).toEqual(["keep", "addedLocally"]);
  });

  it("远端删除 vs 本地修改：本地改过就保住本地那份", () => {
    // 谁跟 base 不同谁赢；两边都不同（远端删了 = 不同）时本地赢
    const base = [row("a", "旧")];
    const local = [row("a", "本地改的")];
    const remote: (HasId & { text: string })[] = [];
    expect(ids(mergeById(base, local, remote))).toEqual(["a"]);
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });

  it("本地删除 vs 远端修改：本地赢（删除是用户明确的动作）", () => {
    const base = [row("a", "旧")];
    const local: (HasId & { text: string })[] = [];
    const remote = [row("a", "远端改的")];
    expect(mergeById(base, local, remote)).toEqual([]);
  });
});

describe("两边都改过同一条：靠 updatedAt 分先后", () => {
  /** 造一条带时间戳的记录（只有片段与备忘有这个字段）。 */
  function timed(id: string, text: string, updatedAt: number) {
    return { id, text, updatedAt };
  }

  it("远端那次编辑更新 → 远端赢（与写盘顺序无关）", () => {
    // 只按"本地赢"的话，谁留下取决于**谁后写盘**；两边都带 updatedAt 时
    // 应该由"谁编辑得更晚"决定
    const base = [timed("a", "旧", 100)];
    const local = [timed("a", "本地改的", 200)];
    const remote = [timed("a", "远端改的", 300)];
    expect(mergeById(base, local, remote)[0].text).toBe("远端改的");
  });

  it("本地那次编辑更新 → 本地赢", () => {
    const base = [timed("a", "旧", 100)];
    const local = [timed("a", "本地改的", 300)];
    const remote = [timed("a", "远端改的", 200)];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });

  it("时间戳一样新 → 分不出先后，本地赢", () => {
    const base = [timed("a", "旧", 100)];
    const local = [timed("a", "本地改的", 200)];
    const remote = [timed("a", "远端改的", 200)];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });

  it("只有一边带 updatedAt → 分不出先后，本地赢", () => {
    // `mergeById` 是通用的，不能要求所有调用方都提供这个字段
    const base = [row("a", "旧")];
    const local = [{ id: "a", text: "本地改的", updatedAt: 300 }];
    const remote = [row("a", "远端改的")];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });

  it("updatedAt 不是数字（被手改成字符串/null）→ 分不出先后，本地赢", () => {
    // 数据文件是纯文本、用户能手改，所以"类型不对"要当成"分不出先后"而不是崩掉
    type Timed = { id: string; text: string; updatedAt: number | string | null };
    const base: Timed[] = [{ id: "a", text: "旧", updatedAt: 100 }];
    const local: Timed[] = [{ id: "a", text: "本地改的", updatedAt: "刚刚" }];
    const remote: Timed[] = [{ id: "a", text: "远端改的", updatedAt: 300 }];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");

    const nulled: Timed[] = [{ id: "a", text: "本地改的", updatedAt: null }];
    expect(mergeById(base, nulled, remote)[0].text).toBe("本地改的");
  });

  it("只有一边改过时，updatedAt 不参与判断（改过的那边赢）", () => {
    // 本地改过、远端没动：即使本地的时间戳更旧，也留本地改的那份
    const base = [timed("a", "旧", 100)];
    const local = [timed("a", "本地改的", 50)];
    const remote = [timed("a", "旧", 100)];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });

  it("两边都没改过 → 不因为时间戳不同而改选（内容本来就一样）", () => {
    const base = [timed("a", "内容", 100)];
    const local = [timed("a", "内容", 100)];
    const remote = [timed("a", "内容", 100)];
    expect(mergeById(base, local, remote)[0].text).toBe("内容");
  });
});

describe("挪文件夹 vs 改内容：没刷时间戳的那一侧不会被当成旧版本", () => {
  /** 造一条笔记。`folderId` 代表"被拖进/拖出了文件夹"。 */
  function note(id: string, text: string, folderId: string | null, updatedAt: number) {
    return { id, text, folderId, updatedAt };
  }

  it("本地刚把条目拖进文件夹 → 远端的正文改动不会把拖拽吃掉", () => {
    // 真实序列：本地拖了一下（`moveTo` **刻意不刷 updatedAt**，见 features/snippets）
    // → 另一窗口后来改了同一条正文 → 两边都"改过"。
    // 没有"两边都真刷过"这个前提的话会取远端那份（`folderId: null`），
    // 于是条目自己跳回原位、拖拽被写回磁盘，而且没有任何提示 —— 静默丢用户的操作。
    const base = [note("a", "正文", null, 100)];
    const local = [note("a", "正文", "f1", 100)]; // 拖进 f1，时间戳没变
    const remote = [note("a", "改过的正文", null, 300)]; // 另一窗口改了内容

    expect(mergeById(base, local, remote)[0].folderId).toBe("f1");
  });

  it("镜像：远端只挪了文件夹 → 本地的正文改动不会被远端的旧版本吃掉", () => {
    // 这个方向上"本地赢"正好也保住了本地的内容编辑
    const base = [note("a", "正文", null, 100)];
    const local = [note("a", "本地改的正文", null, 300)]; // 本地改内容
    const remote = [note("a", "正文", "f1", 100)]; // 远端只挪了文件夹

    expect(mergeById(base, local, remote)[0].text).toBe("本地改的正文");
  });

  it("两边都只挪了文件夹（时间戳都没变）→ 本地赢", () => {
    const base = [note("a", "正文", null, 100)];
    const local = [note("a", "正文", "f1", 100)];
    const remote = [note("a", "正文", "f2", 100)];
    expect(mergeById(base, local, remote)[0].folderId).toBe("f1");
  });

  it("两边都改了内容（时间戳都真刷过）→ 较新者赢 —— **规则本身没被削弱**", () => {
    // 这一条是 F1 修法的"不许破坏"档：内容对内容仍然是较晚的那次编辑赢
    const base = [note("a", "旧", null, 100)];
    const local = [note("a", "本地改的", null, 200)];
    const remote = [note("a", "远端改的", null, 300)];
    expect(mergeById(base, local, remote)[0].text).toBe("远端改的");
  });

  it("时间戳倒退（比 base 还旧）→ 当成分不出先后，本地赢", () => {
    // 系统时钟被改、或数据被手改过时会走到这里；按一个不可信的先后去覆盖更危险
    const base = [note("a", "旧", null, 200)];
    const local = [note("a", "本地改的", null, 300)];
    const remote = [note("a", "远端改的", null, 100)];
    expect(mergeById(base, local, remote)[0].text).toBe("本地改的");
  });
});

describe("顺序", () => {
  it("以本地的顺序为准，远端新增的接在后面", () => {
    // snippets.json 的顺序本身没有语义（界面会按收藏/使用次数/最近更新重排），
    // 所以这里只求**稳定**：同一个窗口连续两次合并不会让列表跳来跳去
    const base = [row("a", "1")];
    const local = [row("c", "3"), row("a", "1"), row("b", "2")];
    const remote = [row("z", "远端新加"), row("a", "1")];
    expect(ids(mergeById(base, local, remote))).toEqual(["c", "a", "b", "z"]);
  });

  it("合并两次的结果与合并一次相同（幂等）", () => {
    const base = [row("a", "1")];
    const local = [row("b", "2"), row("a", "1")];
    const remote = [row("c", "3"), row("a", "1")];
    const once = mergeById(base, local, remote);
    // 第二次用同一份 remote 再合一次（现实中就是"又收到一次广播"）
    expect(ids(mergeById(base, once, remote))).toEqual(ids(once));
  });
});

describe("跨窗口的真实时序（行为）", () => {
  /**
   * 复现用户报的那条路径：
   * 1. A、B 两个窗口都从同一份数据开始；
   * 2. B 存了一条 → 写盘（磁盘变成 B 那份）；
   * 3. A 一直在打字（本地新增了一条），收到广播时是 dirty → 走"读-合并-写"；
   * 4. 断言：**B 新加的那条在 A 写盘之后还在**。
   */
  it("B 新加的条目在 A 写盘后还在", () => {
    const onDisk = [row("a", "1")];
    const base = onDisk; // A 上次与磁盘一致时的样子
    const bSaved = [row("b", "B 存的"), row("a", "1")]; // 磁盘现在是这样
    const aLocal = [row("c", "A 正在打的"), row("a", "1")]; // A 内存里那份

    const toWrite = mergeById(base, aLocal, bSaved);
    expect(ids(toWrite)).toEqual(["c", "a", "b"]);
    // B 的东西还在，A 的东西也在
    expect(toWrite.map((x) => x.text)).toContain("B 存的");
    expect(toWrite.map((x) => x.text)).toContain("A 正在打的");
  });

  it("A 打字期间 B 连续存了两条，两条都还在", () => {
    const base = [row("a", "1")];
    const aLocal = [row("c", "A 正在打的"), row("a", "1")];
    const disk = [row("b1", "B 第一条"), row("b2", "B 第二条"), row("a", "1")];
    expect(ids(mergeById(base, aLocal, disk))).toEqual(["c", "a", "b1", "b2"]);
  });

  it("B 删掉一条时 A 不会把它复活", () => {
    const base = [row("a", "1"), row("dead", "B 删了它")];
    const aLocal = [row("c", "A 新加的"), row("a", "1"), row("dead", "B 删了它")];
    const disk = [row("a", "1")]; // B 删掉并写盘
    expect(ids(mergeById(base, aLocal, disk))).toEqual(["c", "a"]);
  });

  it("合并写完之后再合一次不会重复累积（收敛）", () => {
    const base = [row("a", "1")];
    const aLocal = [row("c", "A 的"), row("a", "1")];
    const disk = [row("b", "B 的"), row("a", "1")];
    const first = mergeById(base, aLocal, disk);
    // 写盘后磁盘 == first；下一轮（base 没变、本地是 A 的最新那份）再合一次
    const second = mergeById(base, first, first);
    expect(ids(second)).toEqual(ids(first));
  });
});
