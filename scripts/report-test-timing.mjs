#!/usr/bin/env node
/**
 * Print the slowest test files from the incremental timing TSV.
 *
 * WHY A SCRIPT INSTEAD OF INLINE SHELL: the first attempt put this logic straight
 * into a `run:` block, and that CI run came back `failure` with both jobs still
 * `queued` and ZERO steps — i.e. the workflow was rejected before dispatch, so
 * nothing ran. The inline version mixed `${{ runner.temp }}` with `$F`, `$(...)`,
 * `$'\t'` and awk bodies full of `{...}`; a local `yaml` parse accepted it, but
 * "parses as YAML" is not "GitHub Actions accepts it". Moving the logic into a
 * plain Node script leaves the workflow with one trivial `run:` line and no
 * expression-vs-shell ambiguity at all.
 *
 * Usage: node scripts/report-test-timing.mjs <timing.tsv>
 * Input lines: TIMING\t<ms>\t<state>\t<path>
 */
import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log(`no timing data captured (${file ?? 'no path given'})`);
  process.exit(0);
}

const rows = readFileSync(file, 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('TIMING\t'))
  .map((l) => {
    const [, ms, state, path] = l.split('\t');
    return { ms: Number(ms) || 0, state: state ?? 'unknown', path: path ?? '?' };
  });

if (rows.length === 0) {
  console.log('timing file present but held no TIMING rows');
  process.exit(0);
}

const totalMs = rows.reduce((s, r) => s + r.ms, 0);
const fmt = (r) => `${(r.ms / 1000).toFixed(1).padStart(8)}s  ${r.state.padEnd(8)} ${r.path}`;

console.log(`files recorded: ${rows.length}`);
console.log(`summed file wall-clock: ${(totalMs / 60000).toFixed(1)} min (files run in parallel, so < job time)`);
console.log('');
console.log('=== slowest 40 ===');
for (const r of [...rows].sort((a, b) => b.ms - a.ms).slice(0, 40)) console.log(fmt(r));

const bad = rows.filter((r) => r.state !== 'passed');
console.log('');
console.log(`=== non-passing (${bad.length}) ===`);
for (const r of bad.sort((a, b) => b.ms - a.ms)) console.log(fmt(r));
