/**
 * 限额状态机单测：扫屏门控 + 结构化限流的粘性重发。
 *
 * 背景：worker 的扫屏判定在 working/analyzing 帧被门控抑制（误报根治），
 * 但 Claude/Codex 的结构化限流是「一次性 emit + UUID 去重」的权威信号。
 * 若结构化限流命中后 CLI 仍被阻塞，而 worker 状态在 prompt 检测生效前
 * 投影为 working（projectRuntimeScreenStatus 在 promptReady=false 时的
 * 默认值就是 working），daemon 侧的 working 帧自愈会把这条权威限额清掉，
 * 且 Claude 家族的扫屏 rate 判定被 suppressRateKind 关闭，再也不会重新
 * 上报——真限流卡片被静默吞掉。因此结构化限额必须在本轮内逐帧重发，
 * 让 daemon 的「新鲜 usageLimit 优先」分支始终生效。
 *
 * Run: pnpm vitest run test/usage-limit-tracker.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { detectCliUsageLimit } from '../src/utils/cli-usage-limit.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';

function structuredLimit(): CliUsageLimitState {
  return {
    limited: true,
    kind: 'rate',
    retryAtMs: Date.now() + 60_000,
    retryLabel: '5-10 min',
    retryReady: false,
  };
}

describe('usage-limit tracker — 结构化限流粘性重发', () => {
  it('结构化限流命中后，working 帧仍重发 limited（防 daemon 自愈误清）', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    const seq = tracker.beginTurn('');
    const limit = structuredLimit();
    tracker.noteStructuredLimit(limit);

    // 屏幕上没有任何限流文案、CLI 还在 working：扫屏门控会抑制，但权威
    // 结构化限额必须原样重发，daemon 收到新鲜 usageLimit 就不会自愈清除。
    const working = tracker.classify('模型正在输出业务 429 的排查结论', 'working');
    expect(working.status).toBe('limited');
    expect(working.usageLimit).toBe(limit);

    // idle 帧同样保持：CLI 被阻塞落到 idle，卡片不回落。
    const idle = tracker.classify('rate limit reached', 'idle');
    expect(idle.status).toBe('limited');
    expect(idle.usageLimit).toBe(limit);

    expect(tracker.detectedThisTurn(seq)).toBe(true);
  });

  it('analyzing 帧同样重发结构化限流', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('thinking', 'analyzing').status).toBe('limited');
  });

  it('下一轮 beginTurn 后停止重发：限额卡片随新轮次清除', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('anything', 'working').status).toBe('limited');

    tracker.beginTurn('');
    expect(tracker.classify('anything', 'working').status).toBe('working');
    expect(tracker.classify('anything', 'idle').status).toBe('idle');
  });

  it('扫屏命中保持一次性：不在后续帧重发（误报由 daemon 自愈兜底）', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    // idle 抖动帧扫屏命中。
    const detected = tracker.classify('429 Too Many Requests', 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit).toBeDefined();
    // 下一帧屏幕已无该文案（或状态变化）：不重发，daemon 可自愈清除。
    expect(tracker.classify('plain output', 'idle').status).toBe('idle');
    expect(tracker.classify('plain output', 'working').status).toBe('working');
  });

  it('扫屏门控保持不变：working 帧不出限额结论', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    expect(tracker.classify('429 Too Many Requests', 'working').status).toBe('working');
    expect(tracker.classify('429 Too Many Requests', 'analyzing').status).toBe('analyzing');
    // idle/stalled 帧维持原判定，真实限流（CLI 被阻塞）仍可检出。
    expect(tracker.classify('429 Too Many Requests', 'idle').status).toBe('limited');
    expect(tracker.classify('429 Too Many Requests', 'stalled').status).toBe('limited');
  });

  it('suppressRateKind 语义在结构化重发之外保持不变', () => {
    // Claude 家族：rate 被抑制，usage 仍检出；结构化重发不受影响。
    const suppressed = createUsageLimitTracker({ isRateKindSuppressed: () => true });
    suppressed.beginTurn('');
    expect(suppressed.classify('429 Too Many Requests', 'idle').status).toBe('idle');
    expect(suppressed.classify("You've hit your usage limit. Try again at 10:36 PM.", 'idle').status).toBe('limited');
    // 结构化限流即使在 suppressRateKind 下也重发。
    suppressed.noteStructuredLimit(structuredLimit());
    expect(suppressed.classify('output', 'working').status).toBe('limited');
  });
});

describe('usage-limit tracker — adopted 会话本地恢复后清除结构化 latch', () => {
  it('本地 turn 成功完成（noteTurnCompleted）后不再重发旧限额', () => {
    // 场景：adopted Claude/Codex 会话命中结构化限流（latch 置位），用户在本地
    // 终端直接恢复——不触发 beginTurn()。daemon 的 final_output handler 已清
    // ds.usageLimit，但 tracker 的 activeStructured latch 仍在；若不清，下次
    // periodic / prompt-ready classify 会重发旧限额，把卡片/Dashboard 重新钉住。
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    const seq = tracker.beginTurn('');
    const limit = structuredLimit();
    tracker.noteStructuredLimit(limit);
    // 恢复前：working 帧仍重发（防 daemon 自愈误清的既有保护）。
    expect(tracker.classify('anything', 'working').status).toBe('limited');

    // bridge 收获到本地 turn 的 final_output → noteTurnCompleted（与 daemon
    // final_output handler 清 ds.usageLimit 同一恢复路径）。
    tracker.noteTurnCompleted();

    // 恢复后：不再重发旧限额。
    expect(tracker.classify('anything', 'working').status).toBe('working');
    expect(tracker.classify('anything', 'idle').status).toBe('idle');
    // 历史事实保留：本轮确实命中过限额（detectedThisTurn 供 submit-confirmation
    // recheck 读取），latch 清除不影响该标记。
    expect(tracker.detectedThisTurn(seq)).toBe(true);
  });

  it('noteTurnCompleted 后下一轮 beginTurn 行为不变', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    tracker.noteTurnCompleted();
    // 新一轮正常开始：扫屏判定恢复工作。
    tracker.beginTurn('');
    expect(tracker.classify('429 Too Many Requests', 'idle').status).toBe('limited');
  });

  it('未命中结构化限流时 noteTurnCompleted 是 no-op', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteTurnCompleted(); // 不应抛错，也不影响普通判定。
    expect(tracker.classify('plain output', 'idle').status).toBe('idle');
  });
});

describe('usage-limit tracker — outputActive 门控（working 不等于输出在进展）', () => {
  const blocked429Screen = 'exceeded retry limit, last status: 429 Too Many Requests, request id: req_x';

  it('working + outputActive=false 仍检出阻塞 429（非结构化 CLI 卡死错误屏）', () => {
    // 非结构化 CLI（codex/grok/traex/pi）的限额错误屏不渲染配置的 ready
    // prompt，idle detector 永不转 idle，状态一直是 working（只有 Codex App
    // 会 project stalled）。outputActive=false 表示 PTY 已静默（CLI 被阻塞，
    // 不是在产出），扫屏判定必须运行——真实阻塞 429 不能被无限抑制。
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => false,
    });
    tracker.beginTurn('');
    const blocked = tracker.classify(blocked429Screen, 'working');
    expect(blocked.status).toBe('limited');
    expect(blocked.usageLimit?.kind).toBe('rate');
  });

  it('working + outputActive=true 保持抑制（输出进展中 = CLI 自己的输出）', () => {
    // PTY 活跃（模型正在输出）时屏幕上的 429 文案是业务输出/内部重试，仍抑制。
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => true,
    });
    tracker.beginTurn('');
    expect(tracker.classify(blocked429Screen, 'working').status).toBe('working');
  });

  it('未注入 isOutputActive 时保持保守默认（working 一律抑制）', () => {
    // 纯单测/无输出活动信号的调用方保持既有行为。
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    expect(tracker.classify(blocked429Screen, 'working').status).toBe('working');
  });

  it('analyzing + outputActive=false 同样检出', () => {
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => false,
    });
    tracker.beginTurn('');
    expect(tracker.classify(blocked429Screen, 'analyzing').status).toBe('limited');
  });

  it('outputActive 门控不影响结构化限流重发', () => {
    // 结构化限流是权威信号，重发不受 outputActive 影响（P1#1 的粘性保护）。
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => true,
      isOutputActive: () => true,
    });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('output', 'working').status).toBe('limited');
  });
});

describe('usage-limit tracker — 屏幕上的旧限额横幅不得每轮重新钉住卡片', () => {
  // 线上真实横幅（Codex）。关键性质有两条：
  //  ① 只带钟点不带日期 ⟹ detectCliUsageLimit 对「已过去的 PM 时间」刻意留在
  //     今天（见其注释），所以一天里 20:45 之前的任意时刻，这条隔夜横幅都被
  //     解析成「今天 20:45」这个未来时刻 ⟹ retryReady === false。
  //  ② Codex 整个 pane 只打印一次就一直留在 viewport 里（实测 261 个 live
  //     tmux 会话、-S -20000 深回滚，没有任何 pane 出现第二次），所以它不是
  //     「CLI 又拒了一次」的活证据，而是一块不会消失的旧背景。
  // 二者叠加：若过期横幅抑制只在 retryReady 时武装，它就恰好在最需要它的场景
  // 里失效——每开一轮新会话都被同一条陈旧文案重新判成限额。
  const STALE_BANNER = "■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:45 PM.";

  // 把时钟钉在 8:45 PM 之前，让 retryReady 稳定为 false（回归的前提条件）。
  // 不钉时钟的话，这个用例在每天 20:45 之后会因为 retryReady 变 true 而
  // 「自己变绿」——那是最坏的一种假绿：它会在 CI 的某些时段掩盖真回归。
  const beforeReset = new Date('2026-08-29T10:00:00-07:00');
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(beforeReset); });
  afterEach(() => { vi.useRealTimers(); });

  function codexTracker() {
    // codex：emitsStructuredRateLimit ⟹ suppressRateKind=true（rate 走结构化，
    // 扫屏只留 usage 判定）；限额错误屏上 PTY 已静默 ⟹ outputActive=false。
    return createUsageLimitTracker({
      isRateKindSuppressed: () => true,
      isOutputActive: () => false,
    });
  }

  it('前提校验：这条横幅在重置时刻之前确实解析为 retryReady=false', () => {
    // 这不是被测行为，而是「上面两条性质」的自证。如果哪天解析规则改了、
    // 这条横幅变成 retryReady=true，下面的回归用例就不再覆盖它声称的场景
    // （会退化成一个恒真断言），必须由这条前提用例先红出来。
    const detected = detectCliUsageLimit(STALE_BANNER);
    expect(detected.limited).toBe(true);
    expect((detected as CliUsageLimitState).kind).toBe('usage');
    expect((detected as CliUsageLimitState).retryReady).toBe(false);
  });

  it('新一轮开始时屏幕上就有横幅 ⟹ 本轮不再判限额（回归）', () => {
    const tracker = codexTracker();
    // 第 1 轮：真限额命中（canary——若这里就不 limited，本用例什么都没测到）。
    tracker.beginTurn('');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');

    // 第 2 轮：用户重新发消息。daemon 的 beginNewTurn 已清 ds.usageLimit，
    // 但屏幕上那条横幅还在（Codex 不会重印、也不会自己消失）。
    const seq2 = tracker.beginTurn(STALE_BANNER);
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    expect(tracker.detectedThisTurn(seq2)).toBe(false);
  });

  it('CLI 正常答完一轮后，后续 idle tick 也不会被旧横幅重新钉住', () => {
    // 完整还原线上症状：自愈路径（noteTurnCompleted + daemon 侧
    // clearUsageLimitState）全都执行了，卡片却又被扫屏重新钉回 limited。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted();
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    expect(tracker.classify(STALE_BANNER, 'stalled').status).toBe('stalled');
  });

  it('抑制严格按 episode 收敛：干净开局时中途出现的限额仍要检出', () => {
    // 反向校准：这条修法不能把「真限额」一起抑制掉。
    const tracker = codexTracker();
    tracker.beginTurn('干净屏幕，完全没有限额文案');
    const detected = tracker.classify(STALE_BANNER, 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit?.kind).toBe('usage');
  });

  it('抑制只认同一 episode：换成另一个重置钟点即视为新限额', () => {
    // usageLimitStateKey 含 retryAtMs + label，所以「另一次限额」自带不同 key。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    const newEpisode = STALE_BANNER.replace('8:45 PM', '11:15 PM');
    const detected = tracker.classify(newEpisode, 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit?.retryLabel).toBe('11:15 PM');
  });

  it('已抑制的 episode 不影响结构化限流重发', () => {
    // 结构化信号是权威的：屏幕上有陈旧横幅时，它照样要能把卡片钉住。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify(STALE_BANNER, 'working').status).toBe('limited');
  });

  it('working + 输出在进展时的既有门控不受影响', () => {
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => true,
      isOutputActive: () => true,
    });
    tracker.beginTurn('干净屏幕');
    expect(tracker.classify(STALE_BANNER, 'working').status).toBe('working');
  });
});
