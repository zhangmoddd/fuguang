/**
 * `store.ts` 的跨窗口同步判定与「读-合并-写」。
 *
 * 为什么测这些、不测别的：`usePersistentState` 剩下那部分全是 React + IPC，
 * 在 node 环境下跑不起来（这个项目的 vitest 跑在 `environment: "node"`，
 * 没有 jsdom）。而跨窗口这一层判错了**不会报错**，只会表现成
 * "我刚存的东西莫名其妙没了"，几乎无法复现。
 *
 * 所以凡是"判错了会静默丢数据"的判断都抽成了纯函数放在这个文件里：
 * - `decideExternalChange`：收到广播该不该重新拉取；
 * - `planWrite`：这次写盘该写什么（快路径不读盘 / 慢路径读-合并-写）；
 * - `shouldAdoptMerge`：合并结果该不该采纳进界面；
 * - `discardPendingWrite`：导入备份时怎么取消挂起的写盘。
 */
import { describe, expect, it } from "vitest";

import {
  decideExternalChange,
  decideReload,
  discardPendingWrite,
  flushAll,
  planWrite,
  registerFlush,
  shouldAdoptMerge,
  type DataChangedPayload,
} from "./store";
import { WriteCoordinator } from "./write-coordinator";

const FILE = "snippets.json";
const SELF = "panel";

/** 造一条广播载荷。默认是"另一个窗口写完了 snippets.json"。 */
function payload(over: Partial<DataChangedPayload> = {}): DataChangedPayload {
  return { file: FILE, from: "panel-2", ...over };
}

/** 造一条记录。只有 id 参与"是不是同一条"，`text` 代表内容。 */
function row(id: string, text: string): { id: string; text: string } {
  return { id, text };
}

const ids = (list: { id: string }[]) => list.map((item) => item.id);

/** 一个会数自己被调了几次的假 `readData`。 */
function fakeRead<T>(value: T | null, opts: { throws?: boolean } = {}) {
  let calls = 0;
  const read = async (_file: string): Promise<T | null> => {
    calls += 1;
    if (opts.throws) throw new Error("磁盘读不了");
    return value;
  };
  return { read, calls: () => calls };
}

describe("decideExternalChange", () => {
  it("没收到载荷就什么都不做", () => {
    expect(decideExternalChange(null, FILE, false, SELF)).toBe("ignore");
    expect(decideExternalChange(undefined, FILE, false, SELF)).toBe("ignore");
  });

  it("别的文件的广播与我无关", () => {
    // 每个 usePersistentState 只订阅自己那份文件；串了会把别处的数据当成自己的
    expect(decideExternalChange(payload({ file: "memos.json" }), FILE, false, SELF)).toBe(
      "ignore",
    );
  });

  it("通配符 `*` 表示「全部文件都变了」（导入备份）", () => {
    expect(decideExternalChange(payload({ file: "*" }), FILE, false, SELF)).toBe("reload");
  });

  it("自己发的广播要忽略", () => {
    // `emit` 是广播给所有窗口的，发消息的窗口自己也会收到。
    // 不忽略的话本窗口会把自己的写盘当成"别处的改动"，白读一次盘
    expect(decideExternalChange(payload({ from: SELF }), FILE, false, SELF)).toBe("ignore");
  });

  it("本地没有未落盘的改动 → 立刻重拉", () => {
    // 绝大多数情况：别处写完了盘，我们手里那份已经陈旧，直接采纳磁盘上的值
    expect(decideExternalChange(payload(), FILE, false, SELF)).toBe("reload");
  });

  it("本地有未落盘的改动 → 推迟到落盘之后再拉", () => {
    // 直接覆盖会把用户正在敲的东西删掉；不管又会保留陈旧数据
    // （下次任何一次 update 都会把别处的改动整份盖回去）
    expect(decideExternalChange(payload(), FILE, true, SELF)).toBe("defer");
  });

  it("用户明确要求覆盖（导入备份）时，本地未落盘的改动让位", () => {
    // 他刚在确认框上点了「覆盖导入，无法撤销」——
    // 这时候保住本地那份反而违背他的意图
    expect(decideExternalChange(payload({ force: true }), FILE, true, SELF)).toBe("reload");
  });

  it("force 也不能让别的文件越界", () => {
    expect(
      decideExternalChange(payload({ file: "memos.json", force: true }), FILE, true, SELF),
    ).toBe("ignore");
  });

  it("发送者身份取不到时不会误判（最坏只是白读一次盘）", () => {
    // `currentWindowLabel()` 在脱离 Tauri 单独跑前端时返回空串。
    // 这时自己的广播会被当成外部变更 —— 只是多读一次盘，不影响正确性。
    expect(decideExternalChange(payload({ from: "" }), FILE, false, "")).toBe("reload");
  });
});

describe("planWrite：快路径不读盘", () => {
  it("没收到过外部变更时，写下去的就是本地那一份**本身**，且一次盘都不读", async () => {
    // 这一条是"单窗口场景零风险"的证据：行为与加合并之前逐字节相同
    const local = [row("a", "1")];
    const spy = fakeRead([row("other", "别处的")]);

    const plan = await planWrite({
      file: FILE,
      base: [row("a", "1")],
      local,
      externalSeen: false,
      read: spy.read,
    });

    expect(plan.value).toBe(local); // 同一个引用，不是复制出来的
    expect(spy.calls()).toBe(0);
  });

  it("快路径下 localAtMerge 是 null —— 调用方据此知道「不用做采纳判断」", async () => {
    const plan = await planWrite({
      file: FILE,
      base: [],
      local: [],
      externalSeen: false,
      read: fakeRead([]).read,
    });
    expect(plan.localAtMerge).toBeNull();
  });

  it("快路径不看磁盘上有什么，哪怕磁盘多了东西也不合并", async () => {
    // 没收到广播就说明"没人在我们背后改这个文件"；这时读盘是纯浪费，
    // 而且会把磁盘上的内容莫名其妙混进来
    const local = [row("a", "1")];
    const plan = await planWrite({
      file: FILE,
      base: [],
      local,
      externalSeen: false,
      read: fakeRead([row("disk-only", "磁盘上的")]).read,
    });
    expect(ids(plan.value)).toEqual(["a"]);
  });
});

describe("planWrite：慢路径读-合并-写", () => {
  it("收到过外部变更时，读盘 + 合并（B 新加的条目在写下去的内容里）", async () => {
    const base = [row("a", "1")];
    const local = [row("c", "A 正在打的"), row("a", "1")];
    const disk = [row("b", "B 存的"), row("a", "1")];
    const spy = fakeRead(disk);

    const plan = await planWrite({ file: FILE, base, local, externalSeen: true, read: spy.read });

    expect(spy.calls()).toBe(1);
    expect(ids(plan.value)).toEqual(["c", "a", "b"]);
    expect(plan.localAtMerge).toBe(local);
  });

  it("磁盘上那条被删掉了时不会把它复活", async () => {
    const base = [row("a", "1"), row("dead", "B 删了它")];
    const local = [row("c", "A 新加的"), row("a", "1"), row("dead", "B 删了它")];
    const plan = await planWrite({
      file: FILE,
      base,
      local,
      externalSeen: true,
      read: fakeRead([row("a", "1")]).read,
    });
    expect(ids(plan.value)).toEqual(["c", "a"]);
  });

  it("读盘失败 → 退回现状（写自己那份），不能因为合并失败就不写", async () => {
    const local = [row("a", "1")];
    const plan = await planWrite({
      file: FILE,
      base: [],
      local,
      externalSeen: true,
      read: fakeRead<{ id: string; text: string }[]>(null, { throws: true }).read,
    });
    expect(plan.value).toBe(local);
    expect(plan.localAtMerge).toBe(local);
  });

  it("文件不存在（读回 null）→ 退回现状", async () => {
    const local = [row("a", "1")];
    const plan = await planWrite({
      file: FILE,
      base: [],
      local,
      externalSeen: true,
      read: fakeRead<{ id: string; text: string }[]>(null).read,
    });
    expect(plan.value).toBe(local);
  });

  it("磁盘内容形状不对 → 退回现状（不拿它去合并）", async () => {
    // `readData<T>` 是纯类型断言、运行期零校验，所以磁盘上真可能是别的形状。
    // 这里用一个"对合法数据也返回 false"的校验函数来走这条分支 ——
    // 关键是"校验不过就不合并"，与那个值长什么样无关。
    const local = [row("a", "1")];
    const plan = await planWrite({
      file: FILE,
      base: [],
      local,
      externalSeen: true,
      read: fakeRead([row("b", "2")]).read,
      isShapeValid: () => false,
    });
    expect(plan.value).toBe(local);
  });
});

describe("shouldAdoptMerge：读盘期间的新改动不被覆盖", () => {
  it("引用没变 → 采纳", () => {
    const local = [row("a", "1")];
    expect(shouldAdoptMerge(local, local)).toBe(true);
  });

  it("引用变了（用户又敲了字）→ 不采纳", () => {
    const before = [row("a", "1")];
    const after = [row("a", "1"), row("c", "刚敲的")];
    expect(shouldAdoptMerge(before, after)).toBe(false);
  });

  it("时序：合并结果里没有那几个字，所以绝不能采纳", async () => {
    // 1) 开始写盘，合并看到的是 localAtMerge
    const base = [row("a", "1")];
    const localAtMerge = [row("c", "A 的"), row("a", "1")];
    const disk = [row("b", "B 的"), row("a", "1")];
    const plan = await planWrite({
      file: FILE,
      base,
      local: localAtMerge,
      externalSeen: true,
      read: fakeRead(disk).read,
    });

    // 2) 读盘/写盘期间用户又敲了一个字 —— 内存换成了新对象
    const localNow = [row("c2", "A 又敲的"), row("c", "A 的"), row("a", "1")];

    // 3) 合并结果里确实没有那几个字
    expect(plan.value.map((x) => x.text)).not.toContain("A 又敲的");
    // 4) 所以不能采纳
    expect(shouldAdoptMerge(plan.localAtMerge!, localNow)).toBe(false);

    // 5) 下一次写盘（base 保持不动、externalSeen 仍为真）会把两边都带上：
    //    B 的条目 + 用户刚敲的那个字，一个都不少
    const next = await planWrite({
      file: FILE,
      base,
      local: localNow,
      externalSeen: true,
      read: fakeRead(disk).read,
    });
    expect(next.value.map((x) => x.text)).toEqual(
      expect.arrayContaining(["B 的", "A 又敲的", "A 的"]),
    );
  });

  it("时序：引用没变 → 采纳，内存与磁盘重新一致", async () => {
    const base = [row("a", "1")];
    const local = [row("a", "1")];
    const disk = [row("b", "B 的"), row("a", "1")];
    const plan = await planWrite({
      file: FILE,
      base,
      local,
      externalSeen: true,
      read: fakeRead(disk).read,
    });
    expect(shouldAdoptMerge(plan.localAtMerge!, local)).toBe(true);
    expect(ids(plan.value)).toEqual(["a", "b"]);
  });
});

describe("discardPendingWrite：导入备份时取消挂起的写盘", () => {
  it("清掉之后 dirty 为假 —— flush() 会直接早退，不会再写盘", () => {
    const coord = new WriteCoordinator();
    coord.markDirty();
    expect(coord.dirty).toBe(true);

    expect(discardPendingWrite(coord)).toBe(true);
    // 这一条就是"挂起的写盘不再发生"的判据：`flush()` 里 `begin()` 会返回 null、
    // 第一行就 `return !dirty`，连 `writeData` 都不会调
    expect(coord.dirty).toBe(false);
  });

  it("有写盘正在飞时取消不掉，返回 false（那次飞行已经带着旧数据走了）", () => {
    const coord = new WriteCoordinator();
    coord.markDirty();
    coord.begin(); // 模拟一次写盘起飞
    expect(discardPendingWrite(coord)).toBe(false);
  });

  it("没有未落盘改动时也算取消成功（无事可做）", () => {
    expect(discardPendingWrite(new WriteCoordinator())).toBe(true);
  });
});

describe("WriteCoordinator.revision（reload 的判据）", () => {
  it("只增不减：每 markDirty 一次 +1，写盘落地也不回退", () => {
    const coord = new WriteCoordinator();
    expect(coord.revision).toBe(0);

    coord.markDirty();
    expect(coord.revision).toBe(1);

    const writing = coord.begin();
    if (writing === null) throw new Error("begin() 不该返回 null");
    coord.commit(writing);
    // 写盘落地只动 `written`，**不动版本号** —— 这正是它比 `dirty` 布尔好用的地方
    expect(coord.revision).toBe(1);
    expect(coord.dirty).toBe(false);

    coord.markDirty();
    expect(coord.revision).toBe(2);
  });

  it("写失败也不回退", () => {
    const coord = new WriteCoordinator();
    coord.markDirty();
    const writing = coord.begin();
    if (writing === null) throw new Error("begin() 不该返回 null");
    coord.fail();
    expect(coord.revision).toBe(1);
    expect(coord.dirty).toBe(true);
  });
});

describe("decideReload", () => {
  it("读盘期间什么都没发生 → 采纳", () => {
    expect(
      decideReload({ revisionAtRead: 3, revisionNow: 3, writeGenAtRead: 1, writeGenNow: 1 }),
    ).toBe("adopt");
  });

  it("读盘期间真的敲了字（版本号变了）→ 不采纳", () => {
    // 读到的值里没有那几个字，采纳等于把它们删掉
    expect(
      decideReload({ revisionAtRead: 3, revisionNow: 4, writeGenAtRead: 1, writeGenNow: 1 }),
    ).toBe("defer");
  });

  it("版本号没变、只是我们自己的写盘落地了 → 重读一次", () => {
    // 读在写之前发出、写却先落地：读到的内容比磁盘还旧，重读才能拿到可信的值
    expect(
      decideReload({ revisionAtRead: 3, revisionNow: 3, writeGenAtRead: 1, writeGenNow: 2 }),
    ).toBe("retry");
  });

  it("回归：只看 `dirty` 布尔会漏掉「期间改过、而且已经落盘」这种情况", () => {
    // 这是 F3 那条 finding 的核心。构造：读盘期间用户又敲了字，而且那次改动
    // 已经落盘 —— 此刻 `dirty` 是**假**的，布尔判据会认为"可以安全采纳"，
    // 于是采纳一份比磁盘还旧的值：用户刚敲的字从界面上消失，而且因为 `dirty`
    // 是假的，不会再补写一次（再编辑时还会以那份旧内容为基准，把刚写下去的覆盖掉）。
    const coord = new WriteCoordinator();
    coord.markDirty();
    const revisionAtRead = coord.revision;

    coord.markDirty(); // 读盘期间用户又敲了字
    const writing = coord.begin();
    if (writing === null) throw new Error("begin() 不该返回 null");
    coord.commit(writing); // ……而且已经落盘

    expect(coord.dirty).toBe(false); // 布尔判据在这里会被骗
    expect(
      decideReload({
        revisionAtRead,
        revisionNow: coord.revision,
        writeGenAtRead: 0,
        writeGenNow: 0,
      }),
    ).toBe("defer"); // 版本号不会
  });

  it("敲字与写盘落地同时发生 → 先保证不删掉刚敲的字", () => {
    expect(
      decideReload({ revisionAtRead: 3, revisionNow: 4, writeGenAtRead: 1, writeGenNow: 2 }),
    ).toBe("defer");
  });
});

describe("registerFlush / flushAll（关窗口之前催落盘）", () => {
  it("把已登记的落盘回调都跑一遍", async () => {
    const calls: string[] = [];
    const offA = registerFlush(async () => {
      calls.push("a");
      return true;
    });
    const offB = registerFlush(async () => {
      calls.push("b");
      return true;
    });
    try {
      expect(await flushAll()).toBe(true);
      expect(calls.sort()).toEqual(["a", "b"]);
    } finally {
      offA();
      offB();
    }
  });

  it("注销之后不再被调用", async () => {
    // 面板被 `destroy()` 之后登记表里不该留着指向已卸载组件的回调
    let called = 0;
    const off = registerFlush(async () => {
      called += 1;
      return true;
    });
    off();
    await flushAll();
    expect(called).toBe(0);
  });

  it("单个失败不会拖垮其余的，结果如实返回 false", async () => {
    const calls: string[] = [];
    const offA = registerFlush(async () => {
      calls.push("a");
      return true;
    });
    const offB = registerFlush(async () => {
      calls.push("b");
      return false;
    });
    const offC = registerFlush(async () => {
      throw new Error("磁盘炸了");
    });
    try {
      // 一个失败不该让另一个面板的数据也不落盘，但失败必须如实报出来
      // （调用方靠它决定要不要提醒用户）
      expect(await flushAll()).toBe(false);
      expect(calls.sort()).toEqual(["a", "b"]);
    } finally {
      offA();
      offB();
      offC();
    }
  });

  it("没有登记任何东西时算成功", async () => {
    // 它只是"把已经挂起的写盘催一遍"，不该平白去读盘或写多余的东西
    expect(await flushAll()).toBe(true);
  });

  it("超时 → 返回 false，不把调用方永远卡住", async () => {
    // 真实后果：一次永不返回的写盘会让设置页的导入流程**永远停在 busy** ——
    // 用户点了「覆盖导入，无法撤销」，导入永远不开始、也没有任何提示。
    // 所以到点就放行，由调用方把"有东西没落盘"告诉用户（不许静默放行）。
    const off = registerFlush(() => new Promise<boolean>(() => {})); // 永不 settle
    try {
      expect(await flushAll(20)).toBe(false);
    } finally {
      off();
    }
  });

  it("超时只影响等待，不影响已经完成的那些落盘", async () => {
    const done: string[] = [];
    const offFast = registerFlush(async () => {
      done.push("fast");
      return true;
    });
    const offStuck = registerFlush(() => new Promise<boolean>(() => {}));
    try {
      expect(await flushAll(20)).toBe(false);
      // 快的那一个照样跑完了 —— 超时不是"取消"，只是"不再等"
      expect(done).toEqual(["fast"]);
    } finally {
      offFast();
      offStuck();
    }
  });
});

describe("导入备份（force）的时序", () => {
  it("取消挂起的写盘 + 本地换成导入后的那份 → B 的旧条目不会再被写出去", async () => {
    // 1) B 有未落盘的改动
    const coord = new WriteCoordinator();
    coord.markDirty();

    // 2) 收到 force 广播 → 取消这次写
    expect(discardPendingWrite(coord)).toBe(true);
    expect(coord.dirty).toBe(false);

    // 3) 本地与 base 都换成导入后的那一份，externalSeen 清掉
    const imported = [row("i", "导入的")];
    const spy = fakeRead(imported);
    const plan = await planWrite({
      file: FILE,
      base: imported,
      local: imported,
      externalSeen: false,
      read: spy.read,
    });

    // 下一次写盘走快路径、写的就是导入的那份，**不含** B 导入前的旧条目
    expect(ids(plan.value)).toEqual(["i"]);
    expect(spy.calls()).toBe(0);
  });

  it("如果**不**取消（也就是加了合并之后放着不管会怎样）：B 挂起的改动被合并回来", async () => {
    // 这一条是"为什么必须取消"的证据，不是"期望的行为"。
    //
    // ⚠️ 注意精确的行为：被合并回来的**不是**"导入前的所有旧条目"，而是
    // **B 挂起的那几处改动**（改过的 + 新加的）。B 没碰过的条目在导入里"不存在"，
    // 对合并来说就是"远端删了、本地也没动过" → 正确地跟着删。
    // 但对用户来说两者是一回事：他点了「覆盖导入，无法撤销」，结果自己导入前的
    // 编辑又冒出来了。
    const imported = [row("i", "导入的")];
    const staleBase = [row("a", "1")];
    const staleLocal = [row("a", "B 改的"), row("new", "B 新加的")];

    const plan = await planWrite({
      file: FILE,
      base: staleBase,
      local: staleLocal,
      externalSeen: true,
      read: fakeRead(imported).read,
    });

    expect(ids(plan.value)).toEqual(["a", "new", "i"]);
    expect(plan.value.map((x) => x.text)).toContain("B 改的");
  });

  it("B 没碰过的旧条目不会因为合并而复活（远端删了、本地也没动过 → 跟着删）", async () => {
    // 与上一条配对：说明"合并会把导入前的东西带回来"这句话的边界在哪，
    // 免得后人以为合并会把整份旧数据都捞回来
    const imported = [row("i", "导入的")];
    const staleBase = [row("untouched", "导入前的、B 没碰过")];

    const plan = await planWrite({
      file: FILE,
      base: staleBase,
      local: staleBase,
      externalSeen: true,
      read: fakeRead(imported).read,
    });

    expect(ids(plan.value)).toEqual(["i"]);
  });
});

