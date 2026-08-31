import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * worker.ts 的 submit-failure 生命周期接线（结构化 source pin）：
 *   - scheduleSubmitFailureNotify 通过按 (turnId, dispatchAttempt, cliGeneration)
 *     键控的控制器调度/替换/取消重查，而不是裸 setTimeout 无限递归；
 *   - 强成功证据（structured-transcript / botmux-send）取消整条链，不再重查也不再告警；
 *   - 弱 pty-output 才重查，但只保留一条 live 链；
 *   - 确认 / stale generation / terminal / warning 都会清链。
 */

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionSlice(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('worker submit-failure lifecycle wiring', () => {
  it('routes the deferred recheck through a per-attempt chain controller', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    expect(schedule).toContain('submitFailureChains.schedule(');
    expect(schedule).toContain('submitFailureChains.cancel(');
    expect(schedule).toContain('turnIdentity?.turnId');
    expect(schedule).toContain('turnIdentity?.dispatchAttempt');
    expect(schedule).toContain('cliGenerationAtSchedule');
  });

  it('replaces an existing live chain instead of stacking a second timer', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const scheduleCall = schedule.indexOf('submitFailureChains.schedule(');
    expect(scheduleCall).toBeGreaterThanOrEqual(0);
    expect(schedule.slice(scheduleCall, schedule.indexOf(');', scheduleCall) + 2)).toContain('SUBMIT_DEFERRED_RECHECK_MS');
    expect(schedule).toContain('replaced');
  });

  it('cancels the chain on strong success evidence instead of re-arming', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const activeStart = schedule.indexOf("case 'suppress-active':");
    const activeEnd = schedule.indexOf("case 'notify-hard-failure':", activeStart);
    expect(activeStart).toBeGreaterThanOrEqual(0);
    expect(activeEnd).toBeGreaterThan(activeStart);
    const active = schedule.slice(activeStart, activeEnd);
    expect(active).toContain('structured-transcript');
    expect(active).toContain('botmux-send');
    expect(active).toContain('submitFailureChains.cancel(');
    // 强证据分支必须发生在递归重查之前
    const cancelIdx = active.indexOf('submitFailureChains.cancel(');
    const rearmIdx = active.indexOf('scheduleSubmitFailureNotify(');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(rearmIdx).toBeGreaterThan(cancelIdx);
  });

  it('clears the chain on stale, confirm, usage-limit and notify-stuck terminals', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const staleGuard = schedule.indexOf('if (settlement.stale)');
    expect(staleGuard).toBeGreaterThanOrEqual(0);
    const afterStale = schedule.slice(staleGuard);
    expect(afterStale).toContain('submitFailureChains.cancel(');
    expect(afterStale).toContain('persistCliSessionId(cliSessionId)');
    expect(afterStale).toContain("emitDurableTerminal('submit_usage_limit')");
    expect(afterStale).toContain("emitDurableTerminal('submit_unconfirmed')");
  });
});
