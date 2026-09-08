/**
 * Unit tests for the dsh-tui PTY adapter — pins the type-ahead / first-prompt
 * contract that keeps queued Lark messages flowing into the TUI even while it
 * is mid-turn.
 *
 * Regression: the dsh-tui adapter shipped readyPattern:/❯/ WITHOUT
 * supportsTypeAhead. The worker's input gate then required isPromptReady to
 * write a message, but the TUI's incremental renderer never re-emits the ❯
 * row while the screen is static — so idle was never detected and every
 * message after the first stayed queued forever (only the first message was
 * forced in by the first-prompt timeout).
 *
 * The TUI itself accepts input while busy: PromptInput.handleEnter routes a
 * non-empty draft through channel.steer (injected at the active turn's next
 * step boundary) instead of blocking, so writing while busy is safe — the
 * same contract codex/coco/claude rely on for type-ahead.
 *
 * Run:  pnpm vitest run --project unit test/dsh-tui-adapter.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createDshTuiAdapter } from '../src/adapters/cli/dsh-tui.js';
import { shouldWriteNow } from '../src/utils/input-gate.js';

describe('dsh-tui adapter', () => {
  it('supports type-ahead so queued messages are written while the TUI is busy', () => {
    expect(createDshTuiAdapter().supportsTypeAhead).toBe(true);
  });

  it('does not defer the soft first-prompt timeout (TUI boots in ~1-3s)', () => {
    expect(createDshTuiAdapter().deferFirstPromptTimeoutUntilReady).toBe(false);
  });

  it('input gate admits dsh-tui messages once the first prompt has been reached', () => {
    const adapter = createDshTuiAdapter();
    expect(
      shouldWriteNow({
        isPromptReady: false,
        isFlushing: false,
        supportsTypeAhead: adapter.supportsTypeAhead === true,
        awaitingFirstPrompt: false,
      }),
    ).toBe(true);
  });

  it('input gate still queues dsh-tui messages during the boot window', () => {
    const adapter = createDshTuiAdapter();
    expect(
      shouldWriteNow({
        isPromptReady: false,
        isFlushing: false,
        supportsTypeAhead: adapter.supportsTypeAhead === true,
        awaitingFirstPrompt: true,
      }),
    ).toBe(false);
  });
});
