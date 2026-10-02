/**
 * 把铃声渲染成 wav，供人**试听**。
 *
 * # 为什么要这个东西
 *
 * 「铃声好不好听」只能靠耳朵判断，而"改代码 → 编译五分钟 → 设个闹钟等它响"
 * 这个反馈环太长了：调一次音色要等一次完整构建。这个脚本用**同一张排布表**
 * （`src/lib/ringtone.ts` 的 `ringSchedule`）算成波形写盘，先听、再决定要不要编译。
 *
 * ⚠️ 波形必须是**同一份代码**算出来的，不能在这里复制一遍合成逻辑 ——
 * 那样试听的就不是软件里放的那个声音了，白白骗自己。
 *
 * 用法（先用 esbuild 打包成 js，再用 node 跑）：
 *
 *     node_modules\@esbuild\win32-x64\esbuild.exe scripts\ringtone-preview.ts \
 *       --bundle --platform=node --format=esm --outfile=%TEMP%\ring.js
 *     node %TEMP%\ring.js --out="%USERPROFILE%\Desktop\浮光铃声试听.wav" --seconds=12
 */
import { writeFileSync } from "node:fs";

import { encodeWav, renderPcm, ringSchedule } from "../src/lib/ringtone";

/** 命令行参数：`--out=路径`、`--seconds=秒数`。 */
function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const out = arg("out", "ringtone-preview.wav");
const seconds = Number(arg("seconds", "12"));

// 用和软件里**完全一样**的参数：前 8 秒满音量，之后降下来
const notes = ringSchedule(seconds, 8);
const pcm = renderPcm(notes, 44100, seconds);

writeFileSync(out, encodeWav(pcm, 44100));

let peak = 0;
for (const v of pcm) peak = Math.max(peak, Math.abs(v));
console.log(`已写出 ${out}`);
console.log(`  时长 ${seconds} 秒，音符 ${notes.length} 个，采样峰值 ${peak.toFixed(3)}`);
