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
 * timer instead of stacking a second one. A fired timer remains the active
 * identity until its callback settles; if that callback re-arms the key, its
 * completion cannot delete the newer replacement. Weak activity explicitly
 * re-arms that key; every other outcome leaves no live timer behind.
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
    fn: () => void | Promise<void>,
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
  type Chain = {
    readonly token: symbol;
    readonly timer: ReturnType<typeof setTimeout>;
  };
  const chains = new Map<string, Chain>();

  return {
    schedule(key, delayMs, fn) {
      const encoded = submitFailureChainKeyOf(key);
      const existing = chains.get(encoded);
      if (existing !== undefined) clearTimeout(existing.timer);
      const token = Symbol(encoded);
      const timer = setTimeout(() => {
        void Promise.resolve(fn()).finally(() => {
          if (chains.get(encoded)?.token === token) chains.delete(encoded);
        });
      }, delayMs);
      chains.set(encoded, { token, timer });
      return { armed: existing === undefined, replaced: existing !== undefined };
    },

    cancel(key) {
      const encoded = submitFailureChainKeyOf(key);
      const existing = chains.get(encoded);
      if (existing === undefined) return false;
      clearTimeout(existing.timer);
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
      for (const chain of chains.values()) clearTimeout(chain.timer);
      chains.clear();
    },
  };
}
