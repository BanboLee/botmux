/**
 * Incremental per-file timing reporter for the CI test-cost investigation.
 *
 * WHY A CUSTOM REPORTER: vitest's `json` reporter writes its file only at the END
 * of a run, and every attempt so far died before that — locally the suite was
 * OOM-killed twice (no json), and in CI the job was cancelled at the 20-minute
 * timeout, which ALSO discards the job logs (verified: the logs API returns
 * BlobNotFound for a cancelled job). A reporter that only speaks at the end cannot
 * answer the question.
 *
 * This one appends ONE LINE PER FILE the moment that file finishes, to stdout and
 * to BOTMUX_TEST_TIMING_FILE, so a run killed partway still leaves the ranking of
 * everything that completed.
 *
 * Hook choice: `onTestModuleEnd` is vitest 4's per-module completion hook (the
 * hook names were read out of vitest's own dist rather than assumed — an earlier
 * draft guessed `onTaskUpdate`/`onFinished` signatures and emitted nothing).
 *
 * Line format (stable, greppable, sortable):  TIMING\t<ms>\t<state>\t<path>
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

export default class IncrementalTimingReporter {
  onInit() {
    this.out = process.env.BOTMUX_TEST_TIMING_FILE || '';
    this.root = process.cwd();
    this.seen = new Set();
  }

  /** vitest 4: called as each test module finishes. */
  onTestModuleEnd(testModule) {
    const filepath = testModule?.moduleId ?? testModule?.filepath;
    if (!filepath || this.seen.has(filepath)) return;
    this.seen.add(filepath);

    // Duration lives on the module's diagnostic in v4; fall back to result.
    const diag = typeof testModule.diagnostic === 'function' ? testModule.diagnostic() : undefined;
    const ms = Math.round(diag?.duration ?? testModule?.result?.().duration ?? 0);
    let state = 'unknown';
    try {
      const r = typeof testModule.state === 'function' ? testModule.state() : testModule.state;
      state = typeof r === 'string' ? r : (r?.state ?? 'unknown');
    } catch { /* keep unknown */ }

    const line = `TIMING\t${ms}\t${state}\t${relative(this.root, filepath)}`;
    console.log(line);
    if (this.out) {
      try { appendFileSync(this.out, `${line}\n`); } catch { /* best effort */ }
    }
  }
}
