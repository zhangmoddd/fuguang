/**
 * `link-health.ts` 的测试。
 *
 * 重点钉两件事：
 *
 * 1. **「没确认」不能被说成「坏了」** —— 冤枉一条好好的链接，比漏报一条
 *    坏链接更糟：用户看到红角标、点开又是正常的，很快就会连真的失效也一起无视。
 * 2. **每一种失效状态都要有各自的说法** —— 全都落到"打不开"就等于让用户
 *    自己去猜是盘没插还是文件被删了，而那正是这次要解决的问题。
 */
import { describe, expect, it } from "vitest";

import type { LinkItem, LinkStatus, TargetState } from "./api";
import {
  brokenReason,
  driveOf,
  formatBytes,
  formatWhen,
  healthBadge,
  healthOf,
  mergeStatuses,
  parentOf,
  pickerStartDir,
  probeSignature,
  pruneStatuses,
  shortenFrom,
  wantsDirectory,
} from "./link-health";

/** 造一个核对结果。测试只关心状态，其余字段给固定值。 */
function s(state: TargetState, extra: Partial<LinkStatus> = {}): LinkStatus {
  return { id: "a", state, resolved: "C:\\a\\b.exe", lnkTarget: null, ...extra };
}

/** 造一条链接。 */
function l(id: string, target: string, kind: LinkItem["kind"] = "file"): LinkItem {
  return { id, name: id, target, args: null, kind, order: 0, folderId: null, createdAt: 0 };
}

describe("healthOf", () => {
  it("确定打不开的状态算「坏了」", () => {
    for (const state of ["missing", "noParent", "noDrive", "denied", "lnkBroken", "empty"] as const) {
      expect(healthOf(state), state).toBe("broken");
    }
  });

  it("能用和没确认分开", () => {
    expect(healthOf("ok")).toBe("ok");
    expect(healthOf("url")).toBe("ok");
    // 这两条是刻意的：没能确认不等于坏了
    expect(healthOf("network")).toBe("unknown");
    expect(healthOf("unknown")).toBe("unknown");
  });
});

describe("healthBadge", () => {
  it("每种失效都有自己的短标签", () => {
    expect(healthBadge("noDrive")).toBe("盘未连接");
    expect(healthBadge("noParent")).toBe("文件夹没了");
    expect(healthBadge("denied")).toBe("没权限");
    expect(healthBadge("lnkBroken")).toBe("快捷方式失效");
    expect(healthBadge("empty")).toBe("没填目标");
    expect(healthBadge("missing")).toBe("已失效");
  });
});

describe("parentOf / driveOf", () => {
  it("取上一级", () => {
    expect(parentOf("C:\\a\\b.exe")).toBe("C:\\a");
    expect(parentOf("C:\\a\\b\\c")).toBe("C:\\a\\b");
    expect(parentOf("C:\\a")).toBe("C:");
    // 正斜杠也要认（用户从网址栏复制来的路径）
    expect(parentOf("D:/x/y.txt")).toBe("D:/x");
  });

  it("取不出来时给空串，不给出半截路径", () => {
    expect(parentOf("b.exe")).toBe("");
    expect(parentOf("")).toBe("");
    // `C:` 这种没有分隔符的，上一级不该是空字符串以外的怪东西
    expect(parentOf("\\a")).toBe("");
  });

  it("只认盘符形态", () => {
    expect(driveOf("E:\\a\\b")).toBe("E:");
    expect(driveOf("e:/a")).toBe("E:");
    expect(driveOf("\\\\srv\\share")).toBe("");
    expect(driveOf("https://a.com")).toBe("");
    expect(driveOf("ab:\\x")).toBe("");
    expect(driveOf("")).toBe("");
  });
});

describe("brokenReason", () => {
  it("每种状态都说清「为什么」和「怎么办」", () => {
    expect(brokenReason(s("missing"), "脚本")).toContain("没有东西了");
    expect(brokenReason(s("missing"), "脚本")).toContain("C:\\a\\b.exe");

    // 盘没连上：必须点出是哪个盘，用户才知道该插哪个
    const noDrive = brokenReason(s("noDrive", { resolved: "E:\\a\\b.exe" }), "工具");
    expect(noDrive).toContain("E:");
    expect(noDrive).toContain("U 盘");

    // 快捷方式：必须把**真实目标**说出来，否则用户去修一个明明存在的 .lnk
    const lnk = brokenReason(
      s("lnkBroken", { lnkTarget: "D:\\soft\\x.exe" }),
      "豆包",
    );
    expect(lnk).toContain("D:\\soft\\x.exe");

    // 没权限：要给出「以管理员身份运行」这条路
    expect(brokenReason(s("denied"), "工具")).toContain("管理员");

    // 空目标
    expect(brokenReason(s("empty", { resolved: "" }), "空的")).toContain("没有填目标");
  });

  it("lnkTarget 缺失时也不能吐出 null", () => {
    const text = brokenReason(s("lnkBroken", { lnkTarget: null }), "豆包");
    expect(text).not.toContain("null");
    expect(text).toContain("豆包");
  });

  it("上一级取不出来时退回完整路径，不留空档", () => {
    const text = brokenReason(s("noParent", { resolved: "b.exe" }), "x");
    expect(text).toContain("b.exe");
    expect(text).not.toContain("：。");
  });
});

describe("wantsDirectory", () => {
  it("只有文件夹链接才去选文件夹", () => {
    expect(wantsDirectory("folder")).toBe(true);
    expect(wantsDirectory("file")).toBe(false);
    expect(wantsDirectory("program")).toBe(false);
    expect(wantsDirectory("url")).toBe(false);
  });
});

describe("pickerStartDir", () => {
  it("从坏掉的那个位置开始翻", () => {
    expect(pickerStartDir(s("missing"))).toBe("C:\\a");
    // 取不出来就不给默认目录（让系统用自己的），而不是给一个空串
    expect(pickerStartDir(s("missing", { resolved: "b.exe" }))).toBeUndefined();
  });
});

describe("shortenFrom", () => {
  it("缩掉公共前缀，把有区别的那一段露出来", () => {
    expect(shortenFrom("C:\\Users\\A\\Desktop", "C:\\Users\\A\\Desktop\\临时\\run.bat")).toBe(
      "临时\\run.bat",
    );
    // 大小写不敏感（Windows 的规矩）
    expect(shortenFrom("C:\\Users\\A\\Desktop", "c:\\users\\a\\desktop\\run.bat")).toBe("run.bat");
  });

  it("不在前缀下面的原样返回", () => {
    expect(shortenFrom("C:\\a", "D:\\b\\run.bat")).toBe("D:\\b\\run.bat");
    // 前缀只是"开头一样"但不在目录边界上时不能切
    expect(shortenFrom("C:\\a", "C:\\abc\\run.bat")).toBe("C:\\abc\\run.bat");
  });

  it("没有基准时原样返回", () => {
    expect(shortenFrom("", "C:\\a\\b.bat")).toBe("C:\\a\\b.bat");
  });

  it("前缀本身带分隔符时不会多切一个", () => {
    expect(shortenFrom("C:\\a\\", "C:\\a\\b.bat")).toBe("b.bat");
  });
});

describe("probeSignature", () => {
  it("目标、类型、id 任一变化都会换指纹", () => {
    const base = [l("a", "C:\\a.exe"), l("b", "C:\\b.txt")];
    expect(probeSignature(base)).toBe(probeSignature([...base]));

    expect(probeSignature(base)).not.toBe(probeSignature([l("a", "C:\\other.exe"), l("b", "C:\\b.txt")]));
    expect(probeSignature(base)).not.toBe(
      probeSignature([l("a", "C:\\a.exe", "program"), l("b", "C:\\b.txt")]),
    );
    expect(probeSignature(base)).not.toBe(probeSignature([l("b", "C:\\b.txt")]));
  });

  it("**与数组顺序无关** —— 拖动排序不能触发一轮白跑的全量核对", () => {
    // 这一条是实测抓出来的：不排序时指纹和顺序有关，于是每拖一次格子
    // 都会重跑一遍逐条 stat，还会让所有格子重渲染一次。
    const base = [l("a", "C:\\a.exe"), l("b", "C:\\b.txt"), l("c", "C:\\c.doc")];
    expect(probeSignature(base)).toBe(probeSignature([...base].reverse()));
    expect(probeSignature(base)).toBe(
      probeSignature([base[2], base[0], base[1]]),
    );
  });

  it("不会把两条链接粘成一个歧义指纹", () => {
    // 用分隔符而不是直接拼：`["ab","c"]` 和 `["a","bc"]` 必须给出不同指纹
    expect(probeSignature([l("a", "bc")])).not.toBe(probeSignature([l("ab", "c")]));
  });

  it("空列表也有稳定指纹", () => {
    expect(probeSignature([])).toBe("");
  });
});

describe("formatBytes", () => {
  it("按 1024 进制换算，和资源管理器一致", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4293)).toBe("4.2 KB");
    expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
  });

  it("非法输入给空串，不吐出 NaN", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("formatWhen", () => {
  it("到分钟为止的本地时间", () => {
    // 用本地时间构造，避免测试跟着时区变
    const d = new Date(2026, 8, 29, 9, 26, 55);
    expect(formatWhen(d.getTime())).toBe("2026-09-29 09:26");
  });

  it("补零，且非法输入给空串", () => {
    const d = new Date(2026, 0, 5, 3, 7);
    expect(formatWhen(d.getTime())).toBe("2026-01-05 03:07");
    expect(formatWhen(null)).toBe("");
    expect(formatWhen(0)).toBe("");
    expect(formatWhen(-5)).toBe("");
  });
});

describe("mergeStatuses / pruneStatuses", () => {
  it("按 id 覆盖，不动别的条目", () => {
    const prev = new Map([
      ["a", s("missing")],
      ["b", s("ok")],
    ]);
    const merged = mergeStatuses(prev, [s("ok", { id: "a" })]);
    expect(merged.get("a")?.state).toBe("ok");
    expect(merged.get("b")?.state).toBe("ok");
    // 不改原表：React 里原地改会让 memo 失效
    expect(prev.get("a")?.state).toBe("missing");
  });

  it("丢掉已经不存在的链接", () => {
    const statuses = new Map([
      ["a", s("ok")],
      ["gone", s("ok", { id: "gone" })],
    ]);
    const kept = pruneStatuses(statuses, [l("a", "C:\\a.exe")]);
    expect([...kept.keys()]).toEqual(["a"]);
  });
});
