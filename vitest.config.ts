import { defineConfig } from "vitest/config";

/**
 * 测试配置。
 *
 * 单独建一个文件而不是往 `vite.config.ts` 里塞 `test` 字段：
 * 那个配置是给**打包**用的（改它会影响发布产物），
 * 而这里是给测试用的。两者目的不同，混在一起容易误伤。
 *
 * 环境用 `node` 而不是 `jsdom`：目前测的都是纯逻辑（日期推算），
 * 不需要 DOM。将来要测组件再按文件切换环境。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // 日期测试会大量构造 Date，跑得快，但给个宽裕的上限避免 CI 上偶发超时
    testTimeout: 10_000,
  },
});
