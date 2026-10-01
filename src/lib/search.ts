/**
 * 全局搜索的纯逻辑。
 *
 * # 为什么单独抽出来
 *
 * 「`Ctrl+K` 搜一切」是命令面板的核心承诺，而「什么算命中、谁排前面」全是纯判断，
 * 最容易在改别处时被无意改坏——比如给某类数据加了个字段却忘了加进搜索范围，
 * 表现是"明明有这条，就是搜不到"，而且很难被发现。
 * 抽出来之后可以用固定数据把排序和命中范围钉死。
 *
 * # 打分规则
 *
 * 1. **标题 / 名字命中永远排在正文命中前面**。用户记得住的通常是自己起的名字，
 *    正文里偶然出现同一个词只是巧合。
 * 2. **词首命中额外加成**：搜 `git` 时 `github` 该比 `digital` 靠前。
 * 3. **空格分开的词必须全部命中**（顺序不限）。这样「github 账号」能收敛到
 *    那一条，而不是把含 `github` 的十条全倒出来。
 *
 * # 用结构化类型，不 import 功能模块
 *
 * 入参只声明「搜索真正用到的字段」。传完整对象也能用（TS 是结构化类型），
 * 但 `lib` 不需要知道功能模块里那些完整类型长什么样——
 * `lib` 反过来依赖 `features` 是倒过来的，以后拆模块会很难受。
 */

/** 结果来自哪一类数据。命令面板按它决定回车要做什么。 */
export type SearchKind = "snippet" | "link" | "memo" | "timer";

/** 一条搜索结果。只带显示需要的字段，完整对象由调用方按 `id` 去取。 */
export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** 列表里显示的主标题。 */
  title: string;
  /** 副标题：网址、日期、正文摘要等。 */
  detail: string;
  /** 分数越高越靠前。 */
  score: number;
}

export interface SearchableSnippet {
  id: string;
  title: string;
  content: string;
  note: string;
  tags: string[];
  sensitive: boolean;
}

export interface SearchableLink {
  id: string;
  name: string;
  target: string;
}

export interface SearchableMemo {
  id: string;
  date: string;
  title: string;
  body: string;
  tags: string[];
}

export interface SearchableTimer {
  id: string;
  name: string;
  kind: string;
}

/** 一次搜索要用到的全部数据。 */
export interface SearchData {
  snippets: SearchableSnippet[];
  links: SearchableLink[];
  memos: SearchableMemo[];
  timers: SearchableTimer[];
}

/**
 * 各类字段命中时的基础分。
 *
 * 数值本身没有意义，**相对大小**才有：标题 100 对正文 25，
 * 意思是"标题命中"至少顶四次正文命中。
 */
const WEIGHT = {
  title: 100,
  date: 70,
  tag: 55,
  target: 45,
  note: 40,
  body: 25,
} as const;

/** 词首命中的加成。乘而不是加，避免把"标题词中命中"顶到"正文词首命中"前面。 */
const PREFIX_BONUS = 1.3;

interface Field {
  text: string;
  weight: number;
}

/** 计时器四种模式的中文名。搜索结果里要显示人话，不能显示 `countdown`。 */
const TIMER_KIND_LABEL: Record<string, string> = {
  countdown: "倒计时",
  pomodoro: "番茄钟",
  stopwatch: "秒表",
  alarm: "闹钟",
};

/**
 * 算一条记录的得分。
 *
 * 任何一个词没命中就返回 `null`——**整条不算命中**。
 * 每个词取它在所有字段里的最高分，再把各词的分相加。
 */
function scoreRecord(tokens: string[], fields: Field[]): number | null {
  let total = 0;

  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      const at = field.text.toLowerCase().indexOf(token);
      if (at < 0) continue;
      const hit = at === 0 ? field.weight * PREFIX_BONUS : field.weight;
      if (hit > best) best = hit;
    }
    // 有一个词完全没出现，这条就不该出现在结果里
    if (best === 0) return null;
    total += best;
  }

  return total;
}

/** 把正文压成一行摘要。和列表里用的是同一套做法。 */
function summarize(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 敏感内容遮罩。
 *
 * 搜索结果里**必须**同样遮罩：不遮的话 `Ctrl+K` 就成了绕过列表遮罩的后门——
 * 那个遮罩存在的意义就是防录屏和防旁人扫一眼。
 */
function mask(text: string): string {
  const len = Math.min(Math.max(text.length, 6), 24);
  return "•".repeat(len);
}

/** 拼副标题，自动跳过空字段，避免出现 `2026-09-25 · ` 这种尾巴。 */
function joinDetail(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" · ");
}

/**
 * 跨四类数据搜索。
 *
 * @param query - 用户输入的原文，空串返回空结果（不返回"全部"）
 * @param data - 四类数据的快照
 * @param limit - 最多返回多少条。面板只有 640px 高，再多也看不完
 */
export function searchAll(query: string, data: SearchData, limit = 40): SearchHit[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // 空搜索返回空结果，而不是"列出全部"：命令面板的定位是"找东西"，
  // 一打开就倒出几百条反而没法用
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];

  for (const s of data.snippets) {
    const score = scoreRecord(tokens, [
      { text: s.title, weight: WEIGHT.title },
      ...s.tags.map((t) => ({ text: t, weight: WEIGHT.tag })),
      { text: s.note, weight: WEIGHT.note },
      { text: s.content, weight: WEIGHT.body },
    ]);
    if (score === null) continue;
    hits.push({
      kind: "snippet",
      id: s.id,
      title: s.title || summarize(s.content, 24) || "未命名",
      detail: s.sensitive ? mask(s.content) : summarize(s.content),
      score,
    });
  }

  for (const l of data.links) {
    const score = scoreRecord(tokens, [
      { text: l.name, weight: WEIGHT.title },
      { text: l.target, weight: WEIGHT.target },
    ]);
    if (score === null) continue;
    hits.push({ kind: "link", id: l.id, title: l.name, detail: l.target, score });
  }

  for (const m of data.memos) {
    const score = scoreRecord(tokens, [
      { text: m.title, weight: WEIGHT.title },
      ...m.tags.map((t) => ({ text: t, weight: WEIGHT.tag })),
      { text: m.date, weight: WEIGHT.date },
      { text: m.body, weight: WEIGHT.body },
    ]);
    if (score === null) continue;
    hits.push({
      kind: "memo",
      id: m.id,
      title: m.title || summarize(m.body, 24) || "未命名",
      detail: joinDetail([m.date, summarize(m.body)]),
      score,
    });
  }

  for (const t of data.timers) {
    const label = TIMER_KIND_LABEL[t.kind] ?? t.kind;
    const score = scoreRecord(tokens, [
      { text: t.name, weight: WEIGHT.title },
      { text: label, weight: WEIGHT.note },
    ]);
    if (score === null) continue;
    hits.push({ kind: "timer", id: t.id, title: t.name, detail: label, score });
  }

  // 分数相同的保持插入顺序（JS 的 sort 是稳定的）：
  // 于是并列时是「片段 → 链接 → 备忘 → 计时器」，不会每次打开都跳来跳去
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
