import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('sandbox dispatch routing invariants', () => {
  it('relays dispatch before any source session-store lookup', () => {
    const start = cliSource.indexOf('async function cmdDispatch(');
    const end = cliSource.indexOf('async function cmdReport(', start);
    const source = cliSource.slice(start, end);
    expect(source.indexOf('await relayDispatch(rest, dispatchRelayDir)')).toBeGreaterThan(0);
    expect(source.indexOf('await relayDispatch(rest, dispatchRelayDir)'))
      .toBeLessThan(source.indexOf('const sessions = loadSessions()'));
  });

  it('fails sandbox send routing instead of silently dropping it', () => {
    const start = cliSource.indexOf('async function relaySend(');
    const end = cliSource.indexOf('async function relayDispatch(', start);
    const source = cliSource.slice(start, end);
    expect(source).toContain("['--chat-id', '--into', '--top-level']");
    expect(source).toContain("errorCode: 'ROUTING_NOT_SUPPORTED'");
    expect(source.indexOf("errorCode: 'ROUTING_NOT_SUPPORTED'"))
      .toBeLessThan(source.indexOf('writeFileSync(cfile, content)'));
  });

  it('emits verifiable source, target, transport and acceptance receipts', () => {
    const start = cliSource.indexOf('async function cmdDispatch(');
    const end = cliSource.indexOf('async function cmdReport(', start);
    const source = cliSource.slice(start, end);
    for (const field of [
      'sourceSessionId',
      'targetAppIds',
      'chatId',
      'threadRootId',
      'transportState',
      'acceptanceState',
      'errorCode',
    ]) {
      expect(source).toContain(field);
    }
  });

  it('persists accepted and timed-out lifecycle states for control-plane readers', () => {
    expect(cliSource).toContain('async function persistDispatchLifecycle(');
    expect(cliSource).toContain("status: 'dispatched' | 'accepted' | 'failed' | 'timed_out'");
    expect(cliSource).toContain("status: 'failed'");
    expect(cliSource).toContain("errorCode: 'TRANSPORT_FAILED'");
  });
});
