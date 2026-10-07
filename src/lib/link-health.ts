/**
 * 「这条链接现在还能不能用」的纯逻辑。
 *
 * # 为什么单独一个模块
 *
 * 判"坏没坏"和把状态翻成人话，全是**纯函数**：给一个状态，出一段文案。
 * 塞在 `features/links/index.tsx` 里就得靠读代码来确认，
 * 而这里的每一条分支都对应一种真实的故障场景（文件被挪走、U 盘拔了、
 * 快捷方式指向的程序卸了……），值得被测试钉住。
 *
 * # 一条硬规矩：**"没确认"不等于"坏了"**
 *
 * 网络盘和查不出来的情况只能算「不知道」。把它们显示成失效会冤枉一批
 * 好好的链接 —— 用户看到红角标、点开又是正常的，很快就会连真的失效
 * 也一起无视掉。所以这里分成三档：能用 / 确定坏了 / 没确认。
 */
import type { LinkItem, LinkKind, LinkStatus, TargetState } from "./api";

/** 一条链接的健康度。 */
export type LinkHealth = "ok" | "broken" | "unknown";

/** 确定"点开一定失败"的状态。 */
const BROKEN_STATES: ReadonlySet<TargetState> = new Set<TargetState>([
  "missing",
  "noParent",
  "noDrive",
  "denied",
  "lnkBroken",
  "empty",
]);

/** 把 Rust 给的状态归成三档。 */
export function healthOf(state: TargetState): LinkHealth {
  if (BROKEN_STATES.has(state)) return "broken";
  // `network`（UNC / 映射盘，刻意没核对）和 `unknown`（查不出来）都算"没确认"
  if (state === "network" || state === "unknown") return "unknown";
  return "ok";
}

/**
 * 格子角上的短标签。
 *
 * 每个词都要能直接对上用户脑子里的那件事（"盘没插"、"文件夹没了"），
 * 写"目标不可用"这种话等于什么都没说。
 */
export function healthBadge(state: TargetState): string {
  switch (state) {
    case "noDrive":
      return "盘未连接";
    case "noParent":
      return "文件夹没了";
    case "denied":
      return "没权限";
    case "lnkBroken":
      return "快捷方式失效";
    case "empty":
      return "没填目标";
    default:
      return "已失效";
  }
}

/** 取路径的上一级。`C:\a\b.exe` → `C:\a`。取不出来返回空串。 */
export function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (cut <= 0) return "";
  return path.slice(0, cut);
}

/** 取盘符。`E:\a\b` → `E:`。不是"盘符 + 冒号"形态返回空串。 */
export function driveOf(path: string): string {
  if (path.length >= 2 && path[1] === ":" && /[a-z]/i.test(path[0])) {
    return `${path[0].toUpperCase()}:`;
  }
  return "";
}

/**
 * 一句话说清「为什么点不开、接下来该干什么」。
 *
 * `status.resolved` 用的是 Rust 归一化之后的路径（展开过环境变量、
 * 去过引号），比用户当初填的那一串更接近"系统实际去找的地方"。
 */
export function brokenReason(status: LinkStatus, name: string): string {
  const where = status.resolved;
  switch (status.state) {
    case "empty":
      return `「${name}」还没有填目标，编辑它填一个就能用。`;
    case "missing":
      return `「${name}」指向的位置已经没有东西了：${where}。它可能被移走、改名或删掉了。`;
    case "noParent":
      return `「${name}」上一级的文件夹不在了：${parentOf(where) || where}。`;
    case "noDrive": {
      const drive = driveOf(where);
      return `「${name}」在 ${drive || "某个"} 盘上，而这个盘现在没连上（U 盘没插、网络盘没挂、虚拟光驱没载入）。`;
    }
    case "denied":
      return `「${name}」还在，但没有权限打开它：${where}。可以试试「以管理员身份运行」。`;
    case "lnkBroken":
      return `「${name}」这个快捷方式本身在，但它指向的 ${status.lnkTarget ?? "程序"} 已经不在了。`;
    default:
      return `「${name}」现在打不开：${where}。`;
  }
}

/**
 * 「重新定位」的文件选择框该不该选文件夹。
 *
 * 文件夹链接只能选文件夹，别的只能选文件 —— 选错了用户会挑到一个
 * 永远打不开的东西。
 */
export function wantsDirectory(kind: LinkKind): boolean {
  return kind === "folder";
}

/** 选择框的默认目录：从坏掉的那个目标所在的位置开始，省掉一路翻过去。 */
export function pickerStartDir(status: LinkStatus): string | undefined {
  const parent = parentOf(status.resolved);
  return parent || undefined;
}

/**
 * 把候选路径缩成相对「原来那个文件夹」的形式。
 *
 * 候选全都同名、又都在同一个父目录的子树里，完整路径的公共前缀很长
 * （`C:\Users\Administrator\Desktop\` 这类），照原样显示的话，
 * **真正有区别的那一段会被挤到看不见的地方**。缩成 `临时\run.bat` 之后，
 * 一眼就能看出"哦，被收进「临时」了"。
 *
 * 不在这个前缀下面的（换了盘、换了目录）原样返回 —— 硬凑一个相对路径
 * 只会让用户认不出来。
 */
export function shortenFrom(base: string, path: string): string {
  if (!base) return path;
  const prefix = base.endsWith("\\") || base.endsWith("/") ? base : `${base}\\`;
  // Windows 路径不区分大小写，所以比较也要不区分
  if (path.toLowerCase().startsWith(prefix.toLowerCase())) {
    return path.slice(prefix.length);
  }
  return path;
}

/**
 * 这批链接的"指纹"。
 *
 * 目标、类型、id 里任何一项变了，指纹就变 —— 组件用它决定要不要重新核对。
 * 用指纹而不是 `links` 数组本身：数组每次 `reload()` 都是新对象，
 * 直接当依赖会让核对跟着每一次渲染跑起来。
 *
 * # 必须先按 id 排序（这是一个实测抓到的漏洞）
 *
 * 不排序的话指纹**和数组顺序有关**，而拖动排序（`reorderLinks`）产出的正是
 * "内容一样、顺序不同"的新数组 —— 于是每拖一次格子都要白跑一轮全量核对
 * （逐条 `stat` + 解析 `.lnk`），还会让所有格子重渲染一次。
 * 排序之后指纹只跟"有哪些链接、各自指向哪"有关，跟它们在屏幕上怎么排无关。
 */
export function probeSignature(links: readonly LinkItem[]): string {
  return [...links]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => `${l.id}\u0000${l.kind}\u0000${l.target}`)
    .join("\u0001");
}

/**
 * 把字节数说成人话。
 *
 * 候选列表里要显示大小，为的是让用户分辨"哪个才是我要的那个"。
 * 用 1024 进制（和资源管理器一致），保留一位小数 —— 用户不需要在这里做算术。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 字节数不带小数（"1.0 B" 很怪），其它保留一位
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/**
 * 把修改时刻说成人话（`2026-09-29 09:26`）。
 *
 * 只到分钟：候选之间比的是"哪个更新"，秒没有意义，而且更占地方。
 * 用本地时间 —— 用户在资源管理器里看到的就是本地时间。
 */
export function formatWhen(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把一批核对结果并进已有的表里。 */
export function mergeStatuses(
  prev: ReadonlyMap<string, LinkStatus>,
  next: readonly LinkStatus[],
): Map<string, LinkStatus> {
  const merged = new Map(prev);
  for (const status of next) merged.set(status.id, status);
  return merged;
}

/**
 * 丢掉已经不在列表里的条目。
 *
 * 不丢的话，删掉再新建一条同名链接时可能读到一个陈旧的状态；
 * 而这张表会一直涨。
 */
export function pruneStatuses(
  statuses: ReadonlyMap<string, LinkStatus>,
  links: readonly LinkItem[],
): Map<string, LinkStatus> {
  const alive = new Set(links.map((l) => l.id));
  const kept = new Map<string, LinkStatus>();
  for (const [id, status] of statuses) {
    if (alive.has(id)) kept.set(id, status);
  }
  return kept;
}
