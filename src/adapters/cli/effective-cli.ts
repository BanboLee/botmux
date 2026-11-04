import type { CliId } from './types.js';

/** The CLI whose adapter capabilities/prompts apply for a configured CLI.
 *  `dsh` has two runtimes; the worker resolves `dshRuntime=tui` to the real
 *  PTY `dsh-tui` adapter at spawn time, so every prompt/envelope decision must
 *  use this same effective id instead of the persisted `dsh` identity. */
export function resolveEffectiveCliId(
  cliId: CliId | undefined,
  dshRuntime: 'official' | 'tui' | undefined,
): CliId | undefined {
  return cliId === 'dsh' && dshRuntime === 'tui' ? 'dsh-tui' : cliId;
}
