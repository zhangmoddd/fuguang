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
