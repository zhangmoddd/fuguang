/**
 * 防抖写盘的版本协调。
 *
 * # 它解决什么
 *
 * 原来 `store.ts` 用一个布尔 `dirty` 同时表示两件事：
 * 「有未落盘的改动」和「正在写盘」。写盘 `await` 返回后无条件把它清成 `false`，
 * 于是**飞行期间到达的新改动被一起清掉了**：新定时器到点时 `flush()` 第一行就早退，
 * 连 `beforeunload` / 窗口隐藏的兜底落盘走的也是同一个函数、同样早退 ——
 * 那次编辑就永远丢在 WebView 内存里，关掉软件即丢。
 *
 * 实测（审查时用可控 resolve 的 `writeData` 真跑过这个 hook）：
 * ```
 * [对照组] 写盘不与输入重叠: ["A"], ["A","B"]     ← 两次都落盘
 * [R2]     写盘跨越一次输入: ["A"]                ← ["A","B"] 一次都没落
 * ```
 *
 * 换成「版本号」就清楚了：写盘前记下要写哪一版，写完后**只有版本没变**才允许清 dirty；
 * 变了就说明期间有新改动，必须再写一次。
 *
 * # 为什么抽成独立的类
 *
 * 这段判断是"防丢数据"的关键，而它周围全是 React 与 IPC，在 node 环境下跑不起来。
 * 抽成不依赖任何东西的纯逻辑，就能直接单测（见 `write-coordinator.test.ts`）。
 */
export class WriteCoordinator {
  /**
   * 改动版本号：每有一次改动 +1。
   *
   * 名字不叫 `revision` 是因为下面有一个**同名的只读 getter**：
   * 同名的实例字段和访问器会让 TypeScript 直接报
   * `TS2300: Duplicate identifier 'revision'`（**两处**），根本编不过。
   * 所以必须换名 —— 不是"编译器不报错、运行期静默遮蔽"，那种写法压根写不出来。
   */
  private rev = 0;
  /** 已经成功写盘的版本号。 */
  private written = 0;
  /** 是否已经有一次写盘在飞。**同一时刻只允许一次**，见 `begin`。 */
  private inFlight = false;

  /** 记一次改动。 */
  markDirty(): void {
    this.rev += 1;
  }

  /**
   * 本地改动版本号，**只增不减**。
   *
   * 调用方（`store.ts` 的 `reload`）用它判断"读盘期间本地到底有没有新改动"。
   * 为什么不能只看 `dirty` 布尔：读盘期间若本地那次改动**已经落盘**，`dirty`
   * 会变回假 —— 于是"期间真的改过"这件事被布尔值掩盖掉了，而读回来的内容
   * 可能比刚落盘的数据还旧，采纳它会让用户刚敲的字从界面上消失。
   */
  get revision(): number {
    return this.rev;
  }

  /** 还有没有未落盘的改动。 */
  get dirty(): boolean {
    return this.written < this.rev;
  }

  /**
   * 开始一次写盘。
   *
   * @returns 本次要写的版本号；**已经有写盘在飞**或没有待写内容时返回 `null`
   *
   * # 为什么必须挡住"两次写盘重叠"
   *
   * 只靠版本号是不够的。设想 rev1 的写盘 A 起飞后、用户又改了 rev2 并触发写盘 B：
   * 两次 `write_data` 是两个并发 IPC，**落盘顺序不保证**。若 B 先落、A 后落，
   * 磁盘最终是旧值；而两次 `commit` 已经把 `written` 推到 2、`dirty` 变 false，
   * **再也不会重试** —— 那次编辑就永久丢了。
   *
   * 所以这里要求写盘严格串行：有在飞的就不放行，等它 `commit` 时若发现 `dirty`
   * 仍为真，调用方会再排一次，那一次写的必然是 `latest`（最新值）。
   */
  begin(): number | null {
    if (this.inFlight) return null;
    if (!this.dirty) return null;
    this.inFlight = true;
    return this.revision;
  }

  /**
   * 报告一次写盘**成功**。
   *
   * @param writing `begin()` 返回的版本号
   * @returns `true` 表示还有更新的改动没落盘，调用方必须再写一次
   */
  commit(writing: number): boolean {
    this.inFlight = false;
    if (writing > this.written) this.written = writing;
    return this.dirty;
  }

  /**
   * 报告一次写盘**失败**。
   *
   * 只解除在飞标记，不动 `written` —— 于是 `dirty` 保持为真，下一次 `flush()`
   * 会自然重试。
   */
  fail(): void {
    this.inFlight = false;
  }
}
