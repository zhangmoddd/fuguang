#!/usr/bin/env node
/**
 * 校验版本号三处一致，并且 tag（如果这次是打 tag 触发的）与版本号相符。
 *
 * # 为什么需要它
 *
 * 安装包的文件名取自 `tauri.conf.json` 的 `version`，而 Release 标题取自 tag。
 * 两者不一致时会**静默**产出一个「标题写着 v0.2.0、里面挂的却是 0.1.0 安装包」
 * 的 Release —— 工作流里原本没有任何一步能拦住它，README 那句
 * 「三处要一致」全靠人肉记忆。
 *
 * 用法：
 *   node scripts/check-version.mjs            # 只校验三处一致
 *   node scripts/check-version.mjs v0.2.0     # 额外校验 tag 与版本号相符
 *
 * CI 里不用传参：GitHub 会自动设 `GITHUB_REF_TYPE` / `GITHUB_REF_NAME`。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 读三处的版本号。 */
function readVersions() {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const tauri = JSON.parse(
    readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ).version;

  // Cargo.toml 里只有 [package] 段那一个顶格 `version =`。
  // 依赖里的 `version = "2"` 都写在 `tauri = { version = ... }` 这种行内表里，
  // `rust-version = "1.77.2"` 也不以 `version` 开头，所以这个匹配是安全的。
  const cargoSrc = readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  const matched = cargoSrc.match(/^version\s*=\s*"([^"]+)"/m);
  if (!matched) {
    throw new Error("在 src-tauri/Cargo.toml 里找不到顶格的 version");
  }
  return { pkg, tauri, cargo: matched[1] };
}

const { pkg, tauri, cargo } = readVersions();
const tag =
  process.argv[2] ??
  (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : null);

console.log(`package.json    = ${pkg}`);
console.log(`tauri.conf.json = ${tauri}`);
console.log(`Cargo.toml      = ${cargo}`);
console.log(`tag             = ${tag ?? "(没有 tag，手动触发)"}`);

if (new Set([pkg, tauri, cargo]).size !== 1) {
  console.error("\n[错误] 三处版本号不一致，发版前请先统一（见 README 的发版步骤）。");
  process.exit(1);
}

if (tag && tag !== `v${tauri}`) {
  console.error(
    `\n[错误] tag 是 ${tag}，但版本号是 ${tauri} —— 安装包会叫 ${tauri}，标题却写 ${tag}。`,
  );
  console.error(`       要么改 tag，要么把三处版本号都改成 ${tag.replace(/^v/, "")}。`);
  process.exit(1);
}

console.log(`\n[通过] 三处版本号一致${tag ? "，且与 tag 相符。" : "。"}`);
