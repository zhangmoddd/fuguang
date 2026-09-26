#!/usr/bin/env node
/**
 * 在指定时区下跑测试。
 *
 * # 为什么需要这个脚本
 *
 * 中国的时区没有夏令时。如果只在默认时区跑测试，那么
 * `datetime.test.ts` 里那些夏令时断言会永远通过 —— 那等于没测。
 *
 * 而 `TZ` 必须在**进程启动前**设好（Node 在初始化时读取它），
 * 在测试文件里改 `process.env.TZ` 来不及。
 *
 * npm script 里也没法跨平台地内联设置环境变量
 * （Windows 的 cmd 与 POSIX 的 sh 语法不同，`cross-env` 又是一个额外依赖）。
 *
 * 所以用这个脚本：设好 `TZ`，再启动一个子进程跑 vitest。
 *
 * 用法：
 *   node scripts/run-tests-in-tz.mjs                       # 默认 America/New_York
 *   node scripts/run-tests-in-tz.mjs Europe/London         # 换一个时区
 *   node scripts/run-tests-in-tz.mjs Asia/Shanghai         # 无夏令时的对照
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const tz = process.argv[2] ?? "America/New_York";
const extraArgs = process.argv.slice(3);

// 直接跑 vitest 的入口文件，而不是走 npx 或 .bin 里的包装脚本：
// 后者在 Windows 上是 .cmd、在 POSIX 上是 shell 脚本，
// 用 node 直接执行 .mjs 是唯一跨平台一致的做法。
const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");

console.log(`[浮光] 在 TZ=${tz} 下运行测试\n`);

const child = spawn(process.execPath, [vitestEntry, "run", ...extraArgs], {
  cwd: root,
  // 必须用 inherit：受限环境下管道捕获子进程输出会因无法创建命名管道而失败
  stdio: "inherit",
  env: { ...process.env, TZ: tz },
});

child.on("error", (err) => {
  console.error(`[浮光] 启动测试失败：${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[浮光] 测试被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
