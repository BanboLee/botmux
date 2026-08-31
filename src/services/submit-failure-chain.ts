/**
 * Per-attempt deferred submit-failure chain controller.
 *
 * scheduleSubmitFailureNotify used to arm one bare setTimeout per call and
 * recursively re-arm on weak activity, so a single logical submission could
 * end up with several live 20s recheck chains that later each emitted their
 * own submit_unconfirmed warning — even after the turn had actually succeeded.
 *
 * This controller keeps at most ONE live chain per (turnId, dispatchAttempt,
 * cliGeneration): scheduling again for the same key REPLACES the existing
 * timer instead of stacking a second one. The worker cancels the chain on
 * confirmation, stale generation/attempt, terminal, strong success evidence
 * (structured transcript / botmux send), or warning — so a logical attempt
 * can never warn twice.
 */

export interface SubmitFailureChainKey {
  turnId?: string;
  dispatchAttempt?: number;
  cliGeneration: number;
}

export function submitFailureChainKeyOf(key: SubmitFailureChainKey): string {
  return `${key.turnId ?? '-'}|${key.dispatchAttempt ?? '-'}|${key.cliGeneration}`;
}

export interface SubmitFailureChainController {
  /** Arm a deferred recheck for a key. If a live chain already exists for the
   *  same key its timer is replaced (returned as `replaced: true`) so the
   *  attempt never owns two timers. The callback runs after `delayMs`. */
  schedule(
    key: SubmitFailureChainKey,
    delayMs: number,
    fn: () => void,
  ): { armed: boolean; replaced: boolean };
  /** Cancel and forget any live chain for the key. Returns true when one was
   *  cancelled. */
  cancel(key: SubmitFailureChainKey): boolean;
  /** True when a live chain exists for the key. */
  has(key: SubmitFailureChainKey): boolean;
  /** Number of live chains. */
  size(): number;
  /** Cancel and forget every live chain (e.g. on CLI generation change). */
  clear(): void;
}

export function createSubmitFailureChainController(): SubmitFailureChainController {
  const chains = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(key, delayMs, fn) {
      const encoded = submitFailureChainKeyOf(key);
      const existing = chains.get(encoded);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        // The chain fires exactly once; forget it before running the callback
        // so a re-arm inside the callback starts from a clean slate.
        chains.delete(encoded);
        fn();
      }, delayMs);
      chains.set(encoded, timer);
      return { armed: existing === undefined, replaced: existing !== undefined };
    },

    cancel(key) {
      const encoded = submitFailureChainKeyOf(key);
      const existing = chains.get(encoded);
      if (existing === undefined) return false;
      clearTimeout(existing);
      chains.delete(encoded);
      return true;
    },

    has(key) {
      return chains.has(submitFailureChainKeyOf(key));
    },

    size() {
      return chains.size;
    },

    clear() {
      for (const timer of chains.values()) clearTimeout(timer);
      chains.clear();
    },
  };
}
