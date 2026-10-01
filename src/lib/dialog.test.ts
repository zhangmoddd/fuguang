/**
 * 文件选择框返回值收窄的测试。
 *
 * 为什么值得测：这两个函数是「用户选了什么」和「到底加进去几条」之间
 * 唯一的转换点。`allPaths` 少返回一条，用户选的第十个文件就**静默消失**，
 * 而界面还会说「已添加 9 个链接」—— 用户只能自己数才发现少了，
 * 不会想到是代码把返回值丢了。
 *
 * 而 `open()` 的返回类型随插件版本变过（`string` / `string[]` / `null`），
 * 所以这里刻意用 `unknown` 喂各种形状进去。
 */
import { describe, expect, it } from "vitest";

import { allPaths, firstPath } from "./dialog";

describe("allPaths", () => {
  it("单个字符串返回一个元素的数组", () => {
    // 单选模式下插件返回的是裸字符串，不是数组
    expect(allPaths("C:\\a\\b.exe")).toEqual(["C:\\a\\b.exe"]);
  });

  it("多选返回的数组原样保留（不截断）", () => {
    const picked = ["C:\\a.exe", "C:\\b.lnk", "C:\\c\\d"];
    expect(allPaths(picked)).toEqual(picked);
  });

  it("取消（null / undefined）返回空数组", () => {
    expect(allPaths(null)).toEqual([]);
    expect(allPaths(undefined)).toEqual([]);
  });

  it("空数组与空串都算「没选」", () => {
    expect(allPaths([])).toEqual([]);
    // 空串是条死路径，加进去只会得到一个点开就报「找不到文件」的格子
    expect(allPaths("")).toEqual([]);
    expect(allPaths(["C:\\a.exe", "", "C:\\b.exe"])).toEqual(["C:\\a.exe", "C:\\b.exe"]);
  });

  it("数组里混进非字符串时只丢那一个，不整体作废", () => {
    // 不能因为一个坏元素把用户选的另外两个也丢掉
    expect(allPaths(["C:\\a.exe", 42, null, { path: "x" }, "C:\\b.exe"])).toEqual([
      "C:\\a.exe",
      "C:\\b.exe",
    ]);
  });

  it("完全认不出来的形状返回空数组而不是抛错", () => {
    // 插件以后换了返回形状时，最坏结果应该是「什么都没加上」，
    // 而不是一个异常把「添加」按钮彻底打哑
    expect(allPaths({ files: ["a"] })).toEqual([]);
    expect(allPaths(0)).toEqual([]);
    expect(allPaths(false)).toEqual([]);
  });
});

describe("firstPath", () => {
  it("单选与多选都能取出第一个", () => {
    expect(firstPath("a")).toBe("a");
    expect(firstPath(["a", "b"])).toBe("a");
  });

  it("取不到时返回 null", () => {
    expect(firstPath(null)).toBeNull();
    expect(firstPath([])).toBeNull();
    expect(firstPath([7])).toBeNull();
    expect(firstPath(undefined)).toBeNull();
  });
});
