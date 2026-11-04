import type { CliId } from '../adapters/cli/types.js';

type DshRuntime = 'official' | 'tui';

/** Effective CLI reported by the LIVE worker generation, keyed by botmux
 *  session id. Memory-only by design: a workerless session must fall back to
 *  the live bot config, and a failed spawn must not leave a ghost runtime. */
const activeWorkerCli = new Map<string, { cliId: CliId; pid: number | undefined }>();

/** Runtime sampled for the next generation. Keeping it between prompt build
 *  and fork makes that boundary a single sample; it is cleared once the worker
 *  reports ready (or whenever the generation dies). */
const pendingDshRuntime = new Map<string, DshRuntime>();

export function setActiveWorkerCliId(sessionId: string, cliId: CliId | undefined, pid?: number): void {
  if (!cliId) activeWorkerCli.delete(sessionId);
  else activeWorkerCli.set(sessionId, { cliId, pid });
}

/** Fenced clear: an older worker that exits late must not delete a newer
 *  generation's entry. Omit pid only when the caller owns the whole session. */
export function clearActiveWorkerCliId(sessionId: string, pid?: number): void {
  const current = activeWorkerCli.get(sessionId);
  if (!current) return;
  if (pid !== undefined && current.pid !== pid) return;
  activeWorkerCli.delete(sessionId);
}

export function getActiveWorkerCliId(sessionId: string): CliId | undefined {
  return activeWorkerCli.get(sessionId)?.cliId;
}

export function setPendingDshRuntime(sessionId: string, runtime: DshRuntime): void {
  pendingDshRuntime.set(sessionId, runtime);
}

export function getPendingDshRuntime(sessionId: string): DshRuntime | undefined {
  return pendingDshRuntime.get(sessionId);
}

/** Resolve the ready generation's adapter from the worker report, falling back
 *  to the prompt-builder sample when an older worker omits the field. */
export function resolveReadyWorkerCliId(
  reported: CliId | undefined,
  pending: DshRuntime | undefined,
): CliId | undefined {
  if (reported) return reported;
  return pending === 'tui' ? 'dsh-tui' : pending === 'official' ? 'dsh' : undefined;
}

export function clearPendingDshRuntime(sessionId: string): void {
  pendingDshRuntime.delete(sessionId);
}

/** Retire both memory-only pieces when a generation is detached/aborted.
 *  Call before the daemon drops the worker reference so the exit guard cannot
 *  skip cleanup. */
export function retireDshRuntimeGeneration(sessionId: string): void {
  activeWorkerCli.delete(sessionId);
  pendingDshRuntime.delete(sessionId);
}

export function __testOnly_resetActiveWorkerCliIds(): void {
  activeWorkerCli.clear();
  pendingDshRuntime.clear();
}
