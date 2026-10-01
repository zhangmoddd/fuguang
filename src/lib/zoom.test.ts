/**
 * 缩放档位的纯逻辑测试。
 *
 * 这些边界值得测的原因是：`settings.json` 是纯文本、用户可以手改，
 * 而一个越界的档位会让链接页一个图标占满整屏（或者小到点不中），
 * 表现像"功能坏了"，用户不会想到是自己改了那个数字。
 */
import { describe, expect, it } from "vitest";

import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoom } from "./zoom";

describe("clampZoom", () => {
  it("越界值夹到上下限", () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(-50)).toBe(ZOOM_MIN);
    expect(clampZoom(9999)).toBe(ZOOM_MAX);
  });

  it("对齐到步长", () => {
    // 手改数据文件写成 137 时落回 140，而不是卡在一个说不出是什么档的大小上
    expect(clampZoom(137)).toBe(140);
    expect(clampZoom(133)).toBe(130);
  });

  it("合法档位原样返回", () => {
    for (let v = ZOOM_MIN; v <= ZOOM_MAX; v += ZOOM_STEP) {
      expect(clampZoom(v)).toBe(v);
    }
  });

  it("非法数字退回默认档", () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_DEFAULT);
  });

  it("上下限本身也是合法档位", () => {
    // 这两个值必须能被步长整除，否则夹取之后再对齐会跑出区间
    expect(ZOOM_MIN % ZOOM_STEP).toBe(0);
    expect(ZOOM_MAX % ZOOM_STEP).toBe(0);
    expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX);
  });
});
