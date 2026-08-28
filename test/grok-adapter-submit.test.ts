import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// Grok submit delivery + verification.
//
// Root cause this file guards (verified on grok 1.0.5): a multi-KB body sent
// per-byte via `send-keys -l` takes the TUI seconds to ingest, and an Enter
// sent 200ms later is consumed as a soft newline INSIDE the burst instead of
// submitting — the composer sits idle holding the full un-submitted text.
// The worker's flush retry then re-ran writeInput, which RE-PASTED the whole
// body each time; a later manual Enter submitted one giant prompt with the
// message stacked N times.
//
// The fix under test: (1) deliver via bracketed pasteText so the body lands
// atomically; (2) when the composer already holds this exact body from an
// unconfirmed attempt on the same handle, retry with Enter ONLY — never stack
// another copy. The mock composer below mirrors the real failure: a
// "swallowed" Enter appends a soft newline instead of submitting, and a
// committing Enter appends the composer content to prompt_history.jsonl the
// way grok records real submits.

const SID = '00000000-0000-7000-8000-00000000aaaa';
const CWD = '/fake/grok-project';

let grokHome: string;
let previousGrokHome: string | undefined;
let previousScale: string | undefined;

function historyPath(): string {
  return join(grokHome, 'sessions', encodeURIComponent(CWD), 'prompt_history.jsonl');
}

function appendPrompt(sid: string, prompt: string): void {
  mkdirSync(join(grokHome, 'sessions', encodeURIComponent(CWD)), { recursive: true });
  appendFileSync(
    historyPath(),
    `${JSON.stringify({ timestamp: '2026-08-28T00:00:00Z', session_id: sid, prompt, is_bash: false })}\n`,
  );
}

/** A pty whose composer behaves like grok 1.0.5: pasted text accumulates; a
 *  "swallowed" Enter becomes a soft newline in the composer (the mid-ingest
 *  failure mode); a committing Enter records the WHOLE composer content in
 *  prompt_history.jsonl and clears it. */
function makePty(opts: { cwd?: string; sid?: string; swallowEnters?: number } = {}): PtyHandle & {
  pasteText: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendSpecialKeys: ReturnType<typeof vi.fn>;
  composer(): string;
} {
  let composer = '';
  let swallowLeft = opts.swallowEnters ?? 0;
  return {
    write: vi.fn(),
    cliCwd: opts.cwd ?? CWD,
    composer: () => composer,
    pasteText: vi.fn((text: string) => { composer += text; }),
    sendText: vi.fn(),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key !== 'Enter') return;
      if (swallowLeft > 0) {
        swallowLeft -= 1;
        composer += '\n'; // the swallowed Enter lands as a soft newline
        return;
      }
      if (!composer) return; // Enter on an empty idle composer is a no-op
      appendPrompt(opts.sid ?? SID, composer);
      composer = '';
    }),
  };
}

describe.sequential('grok adapter submit delivery (prompt_history.jsonl)', () => {
  beforeEach(() => {
    previousGrokHome = process.env.GROK_HOME;
    previousScale = process.env.BOTMUX_TIME_SCALE;
    grokHome = mkdtempSync(join(tmpdir(), 'grok-adapter-'));
    process.env.GROK_HOME = grokHome;
    process.env.BOTMUX_TIME_SCALE = '0.01';
  });

  afterEach(() => {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(grokHome, { recursive: true, force: true });
  });

  it('delivers the body via bracketed pasteText (never send-keys -l) and confirms with the owning sid', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty();

    const result = await adapter.writeInput(pty, '第一条多行消息\n第二行');

    expect(result).toEqual({ submitted: true, cliSessionId: SID });
    expect(pty.pasteText).toHaveBeenCalledTimes(1);
    expect(pty.pasteText).toHaveBeenCalledWith('第一条多行消息\n第二行');
    expect(pty.sendText).not.toHaveBeenCalled();
  });

  it('confirms the very first submit of a lazy-created bucket (history file did not exist yet)', async () => {
    // baseByte snapshots 0 for a missing file; the probe re-stats base as 0
    // when the file appears mid-poll.
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty();

    const result = await adapter.writeInput(pty, 'fresh bucket prompt');

    expect(result).toMatchObject({ submitted: true });
  });

  it('returns submitted:false + recheck when the Enter is swallowed; a later submit flips the recheck', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ swallowEnters: Infinity as unknown as number });

    const result = await adapter.writeInput(pty, 'stuck in composer');

    expect(result).toMatchObject({ submitted: false });
    expect(typeof (result as any).recheck).toBe('function');
    // The human (or a later flush retry) eventually submits the parked text —
    // with the soft newline the swallowed Enter left behind.
    appendPrompt(SID, 'stuck in composer\n');
    expect(await (result as any).recheck()).toEqual({ submitted: true, cliSessionId: SID });
  });

  it('REGRESSION: an identical flush retry sends Enter only — it never stacks a second copy', async () => {
    // Enter #1 is swallowed mid-ingest (soft newline); Enter #2 commits. If the
    // retry re-pasted, the committed prompt would be the body doubled and the
    // verify below could never match — this is exactly the incident where a
    // Lark alert card was submitted tripled after 3 flush retries.
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ swallowEnters: 1 });
    const body = '[卡片: critical 报警]\n多行正文 padding';

    const first = await adapter.writeInput(pty, body);
    expect(first).toMatchObject({ submitted: false });
    expect(pty.composer()).toBe(`${body}\n`); // parked, one copy + swallowed-Enter newline

    const retry = await adapter.writeInput(pty, body);

    expect(retry).toEqual({ submitted: true, cliSessionId: SID });
    expect(pty.pasteText).toHaveBeenCalledTimes(1); // body pasted exactly once across both calls
  });

  it('re-pastes on a fresh backend handle (restart cleared the composer)', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const stuck = makePty({ swallowEnters: Infinity as unknown as number });
    await adapter.writeInput(stuck, 'same body');

    const fresh = makePty();
    const result = await adapter.writeInput(fresh, 'same body');

    expect(result).toMatchObject({ submitted: true });
    expect(fresh.pasteText).toHaveBeenCalledTimes(1);
  });

  it('a recheck confirmation clears the composer memory so an identical NEW message pastes again', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ swallowEnters: 1 });

    const first = await adapter.writeInput(pty, '合并部署');
    expect(first).toMatchObject({ submitted: false });
    // A flush retry's Enter submits the parked text; the deferred recheck sees it.
    (pty.sendSpecialKeys as any)('Enter');
    expect(await (first as any).recheck()).toEqual({ submitted: true, cliSessionId: SID });

    // The user sends the exact same text again tomorrow: the composer is empty,
    // so this MUST paste — an Enter-only shortcut here would silently no-op.
    const again = await adapter.writeInput(pty, '合并部署');
    expect(again).toMatchObject({ submitted: true });
    expect(pty.pasteText).toHaveBeenCalledTimes(2);
  });

  it('fails closed without cliCwd but still delivers via bracketed paste', async () => {
    const adapter = createGrokAdapter('/bin/grok');
    const pty = makePty({ cwd: undefined });
    (pty as any).cliCwd = undefined;

    const result = await adapter.writeInput(pty, 'no cwd body');

    expect(result).toEqual({ submitted: false });
    expect(pty.pasteText).toHaveBeenCalledWith('no cwd body');
    expect(pty.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });
});
