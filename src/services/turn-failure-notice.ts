/**
 * Which turn failures deserve a user-visible, actionable notice — and which of
 * those may offer a retry button.
 *
 * Two independent questions, deliberately kept apart:
 *
 * 1. **Should we notify at all?** A `failed` terminal always warrants a notice.
 *    An `ambiguous` one does NOT: that bucket mixes genuine breakage the user
 *    cannot see (the CLI process died, an input write threw) with interruptions
 *    the user performed themselves (Esc → `*_turn_aborted`). Notifying on a
 *    user's own Esc would manufacture exactly the alert noise this feature
 *    exists to reduce, so proven user aborts stay silent.
 *
 * 2. **May we offer retry, and with what warning?** `retryable === true` is
 *    single-sourced today (the Claude transcript classifier is its only
 *    producer; every other CLI leaves it `undefined`), so a cross-CLI retry
 *    affordance cannot lean on it. What generalises instead is whether the
 *    failure is *pre-execution*: an input that never reached the CLI has no
 *    side effects to duplicate, so re-sending it is unconditionally safe.
 *
 *    A turn that died mid-execution (`cli_exit`) is the harder case. It is NOT
 *    safe-by-construction — the CLI may already have edited files, pushed a
 *    commit or sent a message before dying, and `/retry` re-injects the ORIGINAL
 *    input verbatim (unlike the recovery path, which sends a checkpoint-aware
 *    prompt). Hiding retry there would strand the user; offering it silently
 *    would risk duplicate side effects. So it is offered as `caveated`, and the
 *    card must say so — the user is the only one who can judge whether the
 *    partial work is safe to redo.
 *
 * Keeping this as pure functions (no session, no IPC) makes the policy testable
 * without a live worker and gives the card builder and the click handler one
 * shared source of truth — a button that renders must be one the handler
 * honours.
 */

/** Terminal statuses that can carry a failure. Mirrors `turn_terminal`. */
export type FailureNoticeStatus = 'failed' | 'ambiguous' | 'completed' | 'cancelled';

/**
 * Error codes proving the USER deliberately stopped this turn. These arrive as
 * `ambiguous` because a stop can land after side effects began, so the audit
 * semantics stay uncertain — but the user already knows the turn ended, so a
 * notice would be pure noise.
 *
 * Membership requires direct evidence that the code is user-initiated: each of
 * these is documented as an Esc/interrupt in its transcript adapter (see
 * `pi-transcript.ts` "user interrupt (Esc)"). Codes that merely *sound*
 * cancel-like are deliberately excluded — `provider_cancelled`, for instance,
 * can be a server-side cancellation rather than a human keypress, and today it
 * does produce a notice. Suppressing it on a guess would delete a real alert.
 */
const USER_ABORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'pi_turn_aborted',
  'omp_turn_aborted',
  'rpc_turn_aborted',
]);

/**
 * Error codes proving the turn's input never reached the CLI. Nothing executed,
 * so re-sending duplicates no external side effect.
 */
const PRE_EXECUTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'write_input_threw',
  'adopt_write_input_threw',
  'raw_input_write_failed',
  'zmx_recovery_blocked_before_write',
  'terminal_bridge_unavailable',
  // Both recovery-handoff failures are pre-execution by construction: the
  // continuation was never accepted (enqueue) or never reached the worker
  // (delivery, see failOrdinaryImDelivery). Note the deliberate ABSENCE of
  // `recovery_dispatch_interrupted` — the daemon restarted mid-handoff, so the
  // turn's execution state is genuinely unknown and must stay caveated.
  'recovery_enqueue_failed',
  'recovery_delivery_failed',
]);

export interface TurnFailureNoticeInput {
  status: FailureNoticeStatus;
  errorCode?: string;
}

/**
 * Whether this terminal deserves a user-visible failure notice.
 *
 * `failed` always qualifies. `ambiguous` qualifies unless it is a proven user
 * abort: `cli_exit`, `write_input_threw` and friends are invisible today (the
 * card silently returns to idle, indistinguishable from success), which is the
 * gap this predicate closes.
 */
export function shouldNotifyTurnFailure(turn: TurnFailureNoticeInput): boolean {
  if (turn.status === 'failed') return true;
  if (turn.status !== 'ambiguous') return false;
  // An abort with no code cannot be attributed to the user; surface the
  // unattributable case rather than swallowing it.
  return turn.errorCode === undefined || !USER_ABORT_ERROR_CODES.has(turn.errorCode);
}

/**
 * How a retry may be offered:
 * - `safe`     — input provably never executed, or the CLI's own classifier
 *                said retryable. No duplicate-side-effect risk to warn about.
 * - `caveated` — the turn may have executed before dying. Offer the button, but
 *                the card MUST warn that redoing it can repeat side effects.
 * - `none`     — do not offer retry (not a notifiable failure, or the CLI
 *                explicitly refused: re-sending cannot help).
 */
export type TurnRetryOffer = 'safe' | 'caveated' | 'none';

export function turnRetryOffer(
  turn: TurnFailureNoticeInput & { retryable?: boolean },
): TurnRetryOffer {
  if (!shouldNotifyTurnFailure(turn)) return 'none';
  // An explicit refusal (auth failure, invalid request) outranks every
  // heuristic below: re-sending the same input provably cannot succeed.
  if (turn.retryable === false) return 'none';
  if (turn.retryable === true) return 'safe';
  if (turn.errorCode !== undefined && PRE_EXECUTION_ERROR_CODES.has(turn.errorCode)) return 'safe';
  return 'caveated';
}

/** Convenience for call sites that only need "is there a button at all". */
export function mayOfferTurnRetry(
  turn: TurnFailureNoticeInput & { retryable?: boolean },
): boolean {
  return turnRetryOffer(turn) !== 'none';
}

/**
 * What to actually submit when the user presses the failure card's button.
 *
 * `safe` → re-send the original input verbatim. Nothing executed, so restating
 * the request is the cleanest, most predictable thing we can do; asking the
 * model to infer state would be strictly worse.
 *
 * `caveated` → the turn may have half-executed, so a verbatim re-send risks
 * repeating side effects. Submit a continue instruction instead: have the model
 * inspect the workspace and resume from the last verifiable checkpoint.
 *
 * Deliberately NOT reusing `ORDINARY_TURN_RECOVERY_PROMPT`: its first line
 * asserts "上一执行因暂态 provider 故障中止", which is false for the codes that
 * land here (`cli_exit` is a dead CLI process, not a provider fault). Telling
 * the model a wrong cause invites it to look in the wrong place.
 *
 * The original task text is EMBEDDED rather than assumed to survive: after a
 * `cli_exit` the worker forks a fresh CLI, and if transcript resume does not
 * restore context, a bare "continue" would leave the model with nothing to
 * continue. Including the task makes this degrade gracefully either way.
 */
export function buildTurnContinuePrompt(originalPrompt: string): string {
  return [
    '[BOTMUX_CONTINUE]',
    '上一轮执行被异常中断（CLI 进程退出或状态不明），可能已经完成了一部分工作。',
    '请先读取当前会话与工作区状态，判断哪些步骤已经完成，然后从最后一个可验证的 checkpoint 继续；',
    '不要重复已经完成的外部副作用（例如重复提交、重复发消息、重复写文件）。',
    '若无法安全判断已完成到哪一步，请停止并说明你看到的现场，交回人工决策。',
    '',
    '原任务：',
    originalPrompt,
  ].join('\n');
}

/** Test/introspection helpers. Copies, so callers cannot mutate the policy. */
export function userAbortErrorCodes(): string[] {
  return [...USER_ABORT_ERROR_CODES];
}

export function preExecutionErrorCodes(): string[] {
  return [...PRE_EXECUTION_ERROR_CODES];
}
