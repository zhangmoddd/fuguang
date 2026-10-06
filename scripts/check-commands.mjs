#!/usr/bin/env node
/**
 * 校验 `src/lib/api.ts` 里用到的每一条 IPC 命令名，在 Rust 侧的
 * `invoke_handler` 里都**真的注册过**。
 *
 * # 为什么需要它（这是一类"全绿但坏了"的错）
 *
 * `invoke("media_import_path")` 里的命令名**只是一个字符串**：
 *
 * - **tsc 抓不到** —— 泛型参数给了类型，字符串本身没有任何类型约束；
 * - **单元测试也抓不到** —— 测试里 `api` 整个是 mock 的，命令名写错了
 *   mock 照样"成功"返回；
 * - 于是表现是：**编译全绿、测试全绿、点下去什么都没发生**，
 *   控制台里只有一条 `Command media_import_path not found`。
 *
 * 这类错只能靠"拿前端用的名字去 Rust 侧查一遍"来堵。手工核过一次
 * （58/58 命中），但手工核对只保证"当时对"：下一个人加一条命令、
 * 或者改一个名字，没人会再核一遍。所以固化成这条命令。
 *
 * # 为什么是单向检查（前端 → Rust）
 *
 * 只查"api.ts 用到的，Rust 必须有"，**不查**"Rust 注册了但前端没用"。
 * 后者是**正常情况**而不是错：`alert_current`、`hotkey_validate`、
 * `snippet_bump_use` 这些命令有的只被某个窗口在特定时机调用，
 * 有的干脆是留给内部/后续用的。把"前端暂时没用"当错误，
 * 只会逼着人写一堆假调用去骗过检查，或者把好命令删掉。
 *
 * 反过来，前端用了而 Rust 没有 = **那条功能 100% 是坏的**，必须报错。
 *
 * # 为什么用正则/手写扫描而不是 TypeScript 编译器
 *
 * 这个仓库里 `invoke` 的调用形态很规整，扫一遍字符串就够；
 * 引 TypeScript 编译器会把这条检查从**毫秒**变成**秒**（要加载整个
 * 编译器 + 解析全部依赖），CI 上不划算，本地也不会有人愿意跑。
 *
 * 代价是"解析器自己可能写坏"，所以有两条防线：
 * 1. 抽不到任何命令 = **直接报错**（而不是"没找到问题 = 通过"）；
 * 2. `--selftest` 用内联样例把多行写法、注释、嵌套泛型这些形态钉住。
 *
 * 用法：
 *   node scripts/check-commands.mjs              # 校验（CI 与 npm run check 用这个）
 *   node scripts/check-commands.mjs --selftest   # 只跑解析器自检
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 前端唯一允许写 IPC 的地方（见 api.ts 文件头的约定）。 */
const API_FILE = path.join("src", "lib", "api.ts");
/** 注册命令的地方。 */
const LIB_FILE = path.join("src-tauri", "src", "lib.rs");

// ===============================================================
// 解析
// ===============================================================

/**
 * 把注释换成空格（**保留换行与总长度**）。
 *
 * # 为什么必须去注释
 *
 * `api.ts` 的注释里就写着 `invoke("xxx")` 这个**反例**（文件头那句
 * "前端任何地方都不直接写 invoke(...)"）。不去注释的话，扫描会把
 * `xxx` 当成一条真命令，然后报"Rust 里没有 xxx" —— 一个必然的假阳性。
 *
 * # 为什么保留长度和换行
 *
 * 这样后面的偏移量与原文件**逐字节对齐**，报错时能直接给出真实行号。
 * 字符串字面量要原样留着（命令名就在里面），所以这里是个小状态机：
 * 行注释、块注释、单/双引号与模板字符串都要分别处理，
 * 否则字符串里的 `//`（例如某个 URL）会把后面的代码"注释"掉。
 */
function stripComments(source) {
  let out = "";
  let state = "code"; // code | line | block | single | double | template
  let i = 0;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') state = "double";
      else if (c === "'") state = "single";
      else if (c === "`") state = "template";
      out += c;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    // 字符串内部：转义符要连它后面那个字符一起吃，否则 `\"` 会被当成结束引号
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }
    if (
      (state === "double" && c === '"') ||
      (state === "single" && c === "'") ||
      (state === "template" && c === "`")
    ) {
      state = "code";
    }
    out += c;
    i += 1;
  }

  return out;
}

/** 跳过空白（含换行）——`invoke` 的调用可以写成多行。 */
function skipWhitespace(source, i) {
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

/**
 * 从 `<` 跳到与它配对的 `>` 之后，返回新位置；不配对时返回 -1。
 *
 * # 为什么要数括号而不是找第一个 `>`
 *
 * `invoke<MediaRef | null>("media_read")` 这种还好，但
 * `invoke<Partial<Settings>>(...)`、`invoke<Record<string, number>>(...)`
 * 里第一个 `>` 只是**内层**泛型的收尾。按"第一个 `>`"切会从中间断开，
 * 于是这条命令被静默漏掉 —— 而"漏掉"是最坏的失败方式：检查全绿，
 * 命令名写错了也没人知道。所以这里按层数配对，并且跳过字符串。
 *
 * `=>` 里的 `>` 不是泛型收尾（函数类型的泛型参数），也要跳过。
 */
function skipGenerics(source, i) {
  let depth = 0;
  let j = i;

  while (j < source.length) {
    const c = source[j];
    if (c === '"' || c === "'" || c === "`") {
      const literal = readString(source, j);
      if (!literal) return -1;
      j = literal.end;
      continue;
    }
    if (c === "=" && source[j + 1] === ">") {
      j += 2;
      continue;
    }
    if (c === "<") depth += 1;
    else if (c === ">") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }

  return -1;
}

/** 读一个字符串字面量，返回 `{ value, end }`；不是字面量时返回 null。 */
function readString(source, i) {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;

  let value = "";
  let j = i + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === "\\") {
      value += source[j + 1] ?? "";
      j += 2;
      continue;
    }
    if (c === quote) return { value, end: j + 1 };
    value += c;
    j += 1;
  }
  return null;
}

/** 偏移量 → 1 起的行号（偏移与原文对齐，见 `stripComments`）。 */
function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function isIdentifierChar(c) {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/**
 * 从 `invoke` 的位置开始解析一次调用，返回 `{ name, end }`；不像调用时返回 null。
 */
function parseInvokeCall(source, at) {
  let i = skipWhitespace(source, at + "invoke".length);

  if (source[i] === "<") {
    const afterGenerics = skipGenerics(source, i);
    if (afterGenerics === -1) return null;
    i = skipWhitespace(source, afterGenerics);
  }
  if (source[i] !== "(") return null;

  i = skipWhitespace(source, i + 1);
  const literal = readString(source, i);
  if (!literal || literal.value.length === 0) return null;

  return { name: literal.value, end: literal.end };
}

/**
 * 从 api.ts 抽出全部 `invoke<...>("命令名")`。
 *
 * 支持多行写法（`invoke` 与命令名之间可以换行、泛型可以跨行），
 * 也支持省略泛型的 `invoke("x")`。
 *
 * # 为什么是一遍手写扫描，而不是在整份源码上跑正则
 *
 * 正则分不清"代码里的 invoke"和"字符串里的 invoke"。参数里出现
 * `{ value: 'invoke("nope")' }` 这种内容时，正则会把它当成一条命令，
 * 于是报一个**假的**"Rust 侧没有 nope" —— 假阳性会让这条检查很快被人
 * 用 `|| true` 绕过去。所以这里遇到字符串就整个跳过，只在代码上下文里找。
 *
 * 已知边界：模板字符串整体跳过，所以 `` `${invoke("x")}` `` 这种
 * "把 IPC 写在插值里"的写法扫不到。这个仓库没有这种写法，而且真写了
 * 也该先被 review 拦下来（api.ts 是唯一允许 invoke 的地方，不该有花活）。
 *
 * @returns `{ name, line }[]`
 */
function extractApiCommands(source) {
  const clean = stripComments(source);
  const found = [];

  let i = 0;
  while (i < clean.length) {
    const c = clean[i];

    // 字符串整个跳过：命令名本身也是字符串，但那是**参数**，
    // 由 `parseInvokeCall` 单独读，不走这里
    if (c === '"' || c === "'" || c === "`") {
      const literal = readString(clean, i);
      i = literal ? literal.end : i + 1;
      continue;
    }

    if (
      clean.startsWith("invoke", i) &&
      !isIdentifierChar(clean[i - 1]) &&
      clean[i - 1] !== "." &&
      !isIdentifierChar(clean[i + "invoke".length])
    ) {
      const call = parseInvokeCall(clean, i);
      if (call) {
        found.push({ name: call.name, line: lineOf(clean, i) });
        i = call.end;
        continue;
      }
    }

    i += 1;
  }

  return found;
}

/**
 * 从 lib.rs 的 `invoke_handler(generate_handler![...])` 里抽出注册的命令名。
 *
 * # 为什么"注册过"就等于"Rust 侧有这条命令"
 *
 * `generate_handler!` 要求每一项都是真的 `#[tauri::command]` 函数，
 * 名字对不上**编译就过不去**。所以这里只要看这张名单，不必再去
 * `commands.rs` 里核对函数是否存在（那是编译器的活）。
 *
 * 别名（`commands::a as b`）按**暴露出去的名字**算：Tauri 用的是
 * 函数名，而 `as` 会让暴露的名字变成别名，写错了同样是"点下去没反应"。
 */
function extractRustCommands(source) {
  const clean = stripComments(source);

  const handlerAt = clean.indexOf("invoke_handler");
  if (handlerAt === -1) {
    throw new Error(`在 ${LIB_FILE} 里找不到 invoke_handler`);
  }
  const macroAt = clean.indexOf("generate_handler!", handlerAt);
  if (macroAt === -1) {
    throw new Error(`在 ${LIB_FILE} 的 invoke_handler 里找不到 generate_handler!`);
  }

  const openAt = clean.indexOf("[", macroAt);
  if (openAt === -1) throw new Error("generate_handler! 后面没有 [");

  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < clean.length; i += 1) {
    if (clean[i] === "[") depth += 1;
    else if (clean[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  if (closeAt === -1) throw new Error("generate_handler![...] 的方括号没有闭合");

  const body = clean.slice(openAt + 1, closeAt);
  const names = [];
  const re = /commands::([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

  let match;
  while ((match = re.exec(body)) !== null) {
    names.push(match[2] ?? match[1]);
  }

  return names;
}

// ===============================================================
// 自检
//
// 解析器自己写坏是这条检查**唯一**的致命失效方式（那时它会安静地
// "全绿"）。所以把已知的写法钉成样例，`--selftest` 跑一遍。
// ===============================================================

function selftest() {
  const cases = [
    {
      why: "最普通的一行写法",
      source: `export const api = { x: () => invoke<void>("show_panel") };`,
      expect: ["show_panel"],
    },
    {
      why: "多行写法（泛型与命令名都换行）",
      source: `const a = invoke<\n  MediaRef | null\n>(\n  "media_import_clipboard",\n);`,
      expect: ["media_import_clipboard"],
    },
    {
      why: "嵌套泛型：不能按第一个 > 断开",
      source: `const a = invoke<Partial<Record<string, number>>>("settings_patch", {});`,
      expect: ["settings_patch"],
    },
    {
      why: "泛型里带函数类型（=> 里的 > 不是收尾）",
      source: `const a = invoke<(n: number) => void>("x");`,
      expect: ["x"],
    },
    {
      why: "省略泛型的写法",
      source: `const a = invoke("read_clipboard_text");`,
      expect: ["read_clipboard_text"],
    },
    {
      why: "行注释与块注释里的 invoke 都不算",
      source: `// invoke("fake_line")\n/* invoke("fake_block") */\ninvoke<void>("real");`,
      expect: ["real"],
    },
    {
      why: "字符串里的 // 不能把后面的代码注释掉",
      source: `const u = "https://a/b"; invoke<void>("after_url");`,
      expect: ["after_url"],
    },
    {
      why: "参数里的字符串不能被当成命令名（双引号，带转义）",
      source: String.raw`invoke<void>("write_data", { value: "invoke(\"nope\")" });`,
      expect: ["write_data"],
    },
    {
      why: "参数里的字符串不能被当成命令名（单引号里套双引号）",
      source: String.raw`invoke<void>("write_data", { value: 'invoke("nope")' });`,
      expect: ["write_data"],
    },
    {
      why: "成员调用 a.invoke(...) 不算，名字里含 invoke 的标识符也不算",
      source: `myinvoke("x"); obj.invoke("y"); invoke<void>("z");`,
      expect: ["z"],
    },
    {
      why: "同一行两条命令都要抽到",
      source: `invoke<void>("a"); invoke<void>("b");`,
      expect: ["a", "b"],
    },
    {
      why: "Rust 侧：普通注册与别名都按暴露的名字算",
      source: `.invoke_handler(tauri::generate_handler![\n  commands::a,\n  commands::b as c,\n])`,
      expect: ["a", "c"],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = c.source.includes("commands::")
      ? extractRustCommands(c.source)
      : extractApiCommands(c.source).map((f) => f.name);

    const ok = got.length === c.expect.length && got.every((v, i) => v === c.expect[i]);
    if (!ok) {
      failed += 1;
      console.error(`[自检失败] ${c.why}`);
      console.error(`           期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(got)}`);
    }
  }

  if (failed > 0) {
    console.error(`\n[错误] 解析器自检 ${failed}/${cases.length} 条不通过。`);
    console.error("       解析器坏了会让这条检查静默变成「永远通过」，先修它。");
    process.exit(1);
  }
  console.log(`[通过] 解析器自检 ${cases.length}/${cases.length} 条。`);
}

// ===============================================================
// 主流程
// ===============================================================

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

let apiSource;
let libSource;
try {
  apiSource = readFileSync(path.join(root, API_FILE), "utf8");
  libSource = readFileSync(path.join(root, LIB_FILE), "utf8");
} catch (err) {
  console.error(`[错误] 读不到源文件：${err.message}`);
  console.error("       这个脚本要在仓库根目录下跑（CI 里用默认工作目录即可）。");
  process.exit(1);
}

let apiCommands;
let rustCommands;
try {
  apiCommands = extractApiCommands(apiSource);
  rustCommands = extractRustCommands(libSource);
} catch (err) {
  console.error(`[错误] 解析失败：${err.message}`);
  process.exit(1);
}

// ⚠️ 抽到 0 条 = **解析器坏了**，不是"没有问题"。
// 少了这条防线，一个正则写错的脚本会永远返回成功 —— 那比没有检查更糟，
// 因为它会让人以为这个洞已经被堵上了。
if (apiCommands.length === 0) {
  console.error(`[错误] 在 ${API_FILE} 里一条 invoke(...) 都没抽到。`);
  console.error("       要么这个文件被搬走了，要么解析规则失效了 —— 请先修脚本。");
  process.exit(1);
}
if (rustCommands.length === 0) {
  console.error(`[错误] 在 ${LIB_FILE} 的 invoke_handler 里一条 commands::x 都没抽到。`);
  console.error("       同上：这几乎一定是解析规则失效，而不是「命令全没了」。");
  process.exit(1);
}

const registered = new Set(rustCommands);
const missing = apiCommands.filter((c) => !registered.has(c.name));

// 同一个命令名写了两遍（复制粘贴留下的）不是错误，但值得知道
const seen = new Map();
const duplicates = [];
for (const c of apiCommands) {
  if (seen.has(c.name)) duplicates.push(`${c.name}（${API_FILE}:${seen.get(c.name)} 与 :${c.line}）`);
  else seen.set(c.name, c.line);
}

if (missing.length > 0) {
  console.error(`[错误] ${missing.length} 条命令在 Rust 侧没有注册：`);
  for (const c of missing) {
    console.error(`  - ${c.name}（${API_FILE}:${c.line}）`);
  }
  console.error("");
  console.error("       Tauri 会用 `Command <名字> not found` 拒绝这次调用，");
  console.error("       而 tsc 与单元测试**都抓不到**（命令名只是个字符串）。");
  console.error(`       要么改 ${API_FILE} 里的名字，要么去 ${LIB_FILE} 的`);
  console.error("       invoke_handler 里补上 `commands::<函数名>,`。");
  process.exit(1);
}

// 单向检查：Rust 有、前端没用的命令**不报错**（理由见文件头）
const unused = rustCommands.filter((name) => !seen.has(name));

if (duplicates.length > 0) {
  console.warn(`[提示] 同一个命令名在 ${API_FILE} 里出现了两次：`);
  for (const d of duplicates) console.warn(`  - ${d}`);
}

console.log(
  `[通过] ${API_FILE} 的 ${seen.size} 条命令全部在 ${LIB_FILE} 的 invoke_handler 里注册` +
    `（Rust 另有 ${unused.length} 条前端未使用，单向检查不报错）。`,
);
