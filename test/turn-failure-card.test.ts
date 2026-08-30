/**
 * Unit tests for the turn-failure notice policy and the failure card it drives.
 *
 * Two things are being pinned here, and they are different in kind:
 *
 *  1. `turn-failure-notice.ts` — the POLICY. Which terminals deserve a notice,
 *     and which of those may offer retry. This is where the user-visible
 *     tradeoffs live (don't nag on a user's own Esc; don't silently invite a
 *     re-run of work that may already have shipped a commit).
 *  2. `buildTurnFailedCard` — the RENDER. Crucially, it must never advertise an
 *     affordance the policy denied: a button that renders is a button the
 *     handler will honour, so builder and handler read the same predicate.
 *
 * Run: npx vitest run test/turn-failure-card.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildTurnFailedCard, type TurnFailedCardOpts } from '../src/im/lark/card-builder.js';
import {
  shouldNotifyTurnFailure,
  turnRetryOffer,
  mayOfferTurnRetry,
  userAbortErrorCodes,
  preExecutionErrorCodes,
} from '../src/services/turn-failure-notice.js';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';

let cardTestHome: string;
beforeEach(() => {
  cardTestHome = mkdtempSync(join(tmpdir(), 'botmux-turn-failed-'));
  vi.stubEnv('HOME', cardTestHome);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  invalidateGlobalConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(cardTestHome, { recursive: true, force: true });
});

// ─── Policy: which failures get a notice ────────────────────────────────────

describe('shouldNotifyTurnFailure', () => {
  it('notifies on every failed terminal', () => {
    expect(shouldNotifyTurnFailure({ status: 'failed' })).toBe(true);
    expect(shouldNotifyTurnFailure({ status: 'failed', errorCode: 'pi_turn_error' })).toBe(true);
  });

  it('notifies on ambiguous terminals that the user cannot see', () => {
    // This is the gap the feature exists to close: today these post NOTHING,
    // so a dead CLI is indistinguishable from a clean finish.
    for (const errorCode of ['cli_exit', 'write_input_threw', 'adopt_write_input_threw',
      'raw_input_write_failed', 'zmx_recovery_blocked_before_write']) {
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode })).toBe(true);
    }
  });

  it('stays silent on a user-initiated abort', () => {
    // The user pressed Esc. They know. A card here would be pure noise — and
    // noise is the thing this feature is meant to reduce.
    for (const errorCode of userAbortErrorCodes()) {
      expect(shouldNotifyTurnFailure({ status: 'ambiguous', errorCode })).toBe(false);
    }
  });

  it('notifies on an ambiguous terminal with no error code', () => {
    // Unattributable: cannot prove the user did it, so surface rather than swallow.
    expect(shouldNotifyTurnFailure({ status: 'ambiguous' })).toBe(true);
  });

  it('never notifies on completed or cancelled', () => {
    expect(shouldNotifyTurnFailure({ status: 'completed' })).toBe(false);
    expect(shouldNotifyTurnFailure({ status: 'cancelled' })).toBe(false);
  });
});

// ─── Policy: when may we offer retry, and how loudly ────────────────────────

describe('turnRetryOffer', () => {
  it('offers a plain retry when the input never reached the CLI', () => {
    for (const errorCode of preExecutionErrorCodes()) {
      expect(turnRetryOffer({ status: 'ambiguous', errorCode })).toBe('safe');
    }
  });

  it('offers a plain retry when the CLI explicitly authorised it', () => {
    // provider_server_error / unexpected_eof — Claude's classifier said retryable.
    expect(turnRetryOffer({ status: 'failed', errorCode: 'provider_server_error', retryable: true }))
      .toBe('safe');
  });

  it('refuses retry when the CLI explicitly said it cannot help', () => {
    // Auth/permission/invalid-request: re-sending the same bytes cannot succeed.
    for (const errorCode of ['provider_authentication_failed', 'provider_permission_denied',
      'provider_invalid_request', 'provider_cancelled']) {
      expect(turnRetryOffer({ status: 'failed', errorCode, retryable: false })).toBe('none');
    }
  });

  it('caveats retry for a turn that may have already executed', () => {
    // cli_exit is the motivating case: the CLI may have pushed a commit before
    // dying. We still offer the button (hiding it strands the user) but the
    // card must warn — /retry re-sends the ORIGINAL input verbatim.
    expect(turnRetryOffer({ status: 'ambiguous', errorCode: 'cli_exit' })).toBe('caveated');
    expect(turnRetryOffer({ status: 'failed', errorCode: 'pi_turn_error' })).toBe('caveated');
  });

  it('treats both recovery-handoff failures as safe but a mid-handoff restart as caveated', () => {
    // enqueue/delivery failures prove the continuation never ran. A daemon
    // restart DURING the handoff proves nothing — the turn may have been
    // executing — so it must not be advertised as safe.
    expect(turnRetryOffer({ status: 'failed', errorCode: 'recovery_enqueue_failed' })).toBe('safe');
    expect(turnRetryOffer({ status: 'failed', errorCode: 'recovery_delivery_failed' })).toBe('safe');
    expect(turnRetryOffer({ status: 'failed', errorCode: 'recovery_dispatch_interrupted' }))
      .toBe('caveated');
  });

  it('never offers retry for something it would not even notify about', () => {
    expect(turnRetryOffer({ status: 'completed' })).toBe('none');
    for (const errorCode of userAbortErrorCodes()) {
      expect(turnRetryOffer({ status: 'ambiguous', errorCode })).toBe('none');
    }
  });

  it('explicit refusal outranks the pre-execution heuristic', () => {
    // A code that looks pre-execution but whose CLI said "do not retry" must
    // not be upgraded to safe by the whitelist.
    expect(turnRetryOffer({
      status: 'failed', errorCode: 'terminal_bridge_unavailable', retryable: false,
    })).toBe('none');
  });

  it('mayOfferTurnRetry agrees with turnRetryOffer', () => {
    const cases = [
      { status: 'failed' as const, errorCode: 'cli_exit' },
      { status: 'ambiguous' as const, errorCode: 'write_input_threw' },
      { status: 'completed' as const },
      { status: 'ambiguous' as const, errorCode: 'pi_turn_aborted' },
    ];
    for (const c of cases) {
      expect(mayOfferTurnRetry(c)).toBe(turnRetryOffer(c) !== 'none');
    }
  });

  it('the two policy whitelists do not overlap', () => {
    // An abort code that also counted as pre-execution would make a silenced
    // failure sprout a retry button — contradictory. Pin the disjointness.
    const aborts = new Set(userAbortErrorCodes());
    for (const code of preExecutionErrorCodes()) expect(aborts.has(code)).toBe(false);
  });
});

// ─── Render ─────────────────────────────────────────────────────────────────

const BASE: TurnFailedCardOpts = {
  rootId: 'om_root_fail',
  sessionId: 'sess-fail',
  cliId: 'claude-code',
  cliName: 'Claude',
  status: 'failed',
  retryOffer: 'safe',
  retryTurnId: 'turn-abc123',
};

function build(over: Partial<TurnFailedCardOpts> = {}): any {
  return JSON.parse(buildTurnFailedCard({ ...BASE, ...over }));
}

function actions(card: any): any[] {
  return card.elements.find((e: any) => e.tag === 'action')?.actions ?? [];
}

function bodyText(card: any): string {
  return card.elements.filter((e: any) => e.tag === 'markdown')
    .map((e: any) => e.content).join('\n');
}

describe('buildTurnFailedCard', () => {
  it('renders a retry button pinned to the failing turn', () => {
    const btn = actions(build()).find((a: any) => a.value?.action === 'retry_turn');
    expect(btn).toBeTruthy();
    // The turnId pin IS the one-shot credential: without it a stale card could
    // resubmit a turn the session has long moved past.
    expect(btn.value.turn_id).toBe('turn-abc123');
    expect(btn.value.session_id).toBe('sess-fail');
    expect(btn.value.root_id).toBe('om_root_fail');
  });

  it('omits the retry button when the policy denied retry', () => {
    const card = build({ retryOffer: 'none' });
    expect(actions(card).find((a: any) => a.value?.action === 'retry_turn')).toBeUndefined();
    expect(bodyText(card)).toContain('无法成功');
  });

  it('omits the retry button when there is no input to re-send', () => {
    // buildFailedTurnRecord returns undefined for a turn that died before its
    // prompt was wrapped — a button would 100% fail on click.
    const card = build({ retryTurnId: undefined });
    expect(actions(card).find((a: any) => a.value?.action === 'retry_turn')).toBeUndefined();
    expect(bodyText(card)).toContain('没有可重发的输入');
  });

  it('warns about duplicate side effects when the retry is caveated', () => {
    const card = build({ retryOffer: 'caveated', errorCode: 'cli_exit' });
    const btn = actions(card).find((a: any) => a.value?.action === 'retry_turn');
    expect(btn).toBeTruthy();
    // A possibly-destructive action must not be the visual default.
    expect(btn.type).toBe('default');
    expect(bodyText(card)).toContain('可能已经执行了一部分');
  });

  it('makes a provably-safe retry the primary action', () => {
    const btn = actions(build({ retryOffer: 'safe' }))
      .find((a: any) => a.value?.action === 'retry_turn');
    expect(btn.type).toBe('primary');
    expect(bodyText(build({ retryOffer: 'safe' }))).toContain('可以安全重试');
  });

  it('shows the raw error code', () => {
    // ordinary_recovery_non_retryable is an unconditional fallback branch, so a
    // daemon-restart reconciliation renders as "cannot retry safely" too. The
    // code is the only thing that distinguishes them — it must be visible.
    expect(bodyText(build({ errorCode: 'recovery_dispatch_interrupted' })))
      .toContain('recovery_dispatch_interrupted');
  });

  it('falls back to the status when no error code exists', () => {
    expect(bodyText(build({ errorCode: undefined, status: 'ambiguous' })))
      .toContain('ambiguous');
  });

  it('mentions the human in the markdown body, not the plain_text title', () => {
    const card = build({ mentionOpenId: 'ou_human' });
    // plainTitle() strips <at> markup, so a mention in the header is a no-op.
    expect(JSON.stringify(card.header)).not.toContain('ou_human');
    expect(bodyText(card)).toContain('<at id=ou_human></at>');
  });

  it('omits the mention entirely when there is nobody safe to mention', () => {
    expect(bodyText(build({ mentionOpenId: undefined }))).not.toContain('<at');
  });

  it('escapes a task string so it cannot forge a mention', () => {
    const card = build({ task: '<at id=ou_victim></at> pwned', mentionOpenId: undefined });
    expect(bodyText(card)).not.toContain('<at id=ou_victim></at>');
  });

  it('escapes the error code and reason too', () => {
    const card = build({ errorCode: '<at id=ou_x></at>', reason: '<at id=ou_y></at>' });
    const body = bodyText(card);
    expect(body).not.toContain('<at id=ou_x></at>');
    expect(body).not.toContain('<at id=ou_y></at>');
  });

  it('keeps underscores in an error code readable', () => {
    // Error codes are closed-set constants and almost all contain underscores.
    // Markdown-escaping them surfaced visible backslashes ("recovery\_dispatch\_…"),
    // which is why they render as inline code instead. Assert the raw code is
    // present verbatim — a regression to escapeMd() would break this.
    const body = bodyText(build({ errorCode: 'recovery_dispatch_interrupted' }));
    expect(body).toContain('recovery_dispatch_interrupted');
    expect(body).not.toContain('\\_');
  });

  it('strips mention markup from a CLI name in the header', () => {
    const card = build({ cliName: '<at id=ou_z></at>Claude' });
    expect(JSON.stringify(card.header)).not.toContain('ou_z');
  });

  it('softens the title for an ambiguous terminal', () => {
    // "failed" would overclaim: we genuinely do not know whether it ran.
    const amb = build({ status: 'ambiguous' }).header.title.content;
    const failed = build({ status: 'failed' }).header.title.content;
    expect(amb).not.toBe(failed);
    expect(amb).toContain('异常中断');
  });

  it('reports the auto-continuation count when a recovery ladder gave up', () => {
    expect(bodyText(build({ continuations: 2 }))).toContain('2');
  });

  it('omits the continuation line when no continuations ran', () => {
    expect(bodyText(build({ continuations: 0 }))).not.toContain('已自动续跑');
    expect(bodyText(build({ continuations: undefined }))).not.toContain('已自动续跑');
  });

  it('truncates a long task instead of pasting a whole prompt into the card', () => {
    const body = bodyText(build({ task: 'x'.repeat(400) }));
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(400);
  });

  it('offers the terminal button only when a URL exists', () => {
    expect(actions(build({ terminalUrl: 'https://example.com/t' })).length).toBe(2);
    expect(actions(build({ terminalUrl: undefined })).length).toBe(1);
  });

  it('uses a red header so a failure is scannable in a busy chat', () => {
    expect(build().header.template).toBe('red');
  });

  it('renders valid English too', () => {
    const card = build({ locale: 'en', retryOffer: 'caveated' });
    const body = bodyText(card);
    // A missing en key silently falls back to Chinese — catch that here.
    expect(body).toMatch(/may have partially executed/i);
    expect(card.header.title.content).toMatch(/[A-Za-z]/);
    expect(card.header.title.content).not.toMatch(/[一-龥]/);
  });
});
