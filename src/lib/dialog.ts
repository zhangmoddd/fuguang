/**
 * 文件选择框返回值的小工具。
 *
 * `@tauri-apps/plugin-dialog` 的 `open()` 返回类型会随版本变化
 * （`string` / `string[]` / `null`，新版本还可能是别的形状），
 * 所以这里用 `unknown` 收口再做**运行时**收窄——升级依赖时不会变成编译错误，
 * 也不会因为类型对不上就把真实路径丢掉。
 */

/** 从文件选择框的返回值里取一个路径；取不到返回 `null`（用户取消也会走到这里）。 */
export function firstPath(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const first: unknown = result[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

/**
 * 从文件选择框的返回值里取出**全部**路径（选择框允许多选时是一串）。
 *
 * 为什么不复用 `firstPath` 再取 `[0]`：多选是选择框自己给的能力，
 * 用户框了十个文件就期待十个都进来。只取第一个会把另外九个**静默丢掉**，
 * 而界面上只会提示「已添加 1 个链接」—— 用户得自己数才发现少了。
 *
 * 数组里混进非字符串元素时**跳过那一个**而不是整体作废：
 * 那个元素本来也用不了，丢掉它比丢掉用户选的另外九个要好。
 */
export function allPaths(result: unknown): string[] {
  if (typeof result === "string") return result ? [result] : [];
  if (Array.isArray(result)) {
    return result.filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  return [];
}
