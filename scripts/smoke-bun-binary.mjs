#!/usr/bin/env node
/**
 * Smoke-test a compiled Bun single-file botmux binary.
 *
 * WHY THIS EXISTS: the release job used to smoke-test the binary with
 * `capabilities --json` alone. That is a static feature-flag document — it
 * proves the CLI module graph loads, and NOTHING about the parts the Bun
 * migration actually breaks. Two real regressions shipped past it:
 *   • the dashboard crashlooped in the compiled binary because a deep
 *     `require('qrcode-terminal/vendor/QRCode')` was never embedded, and
 *   • the dashboard was not launched at all (no supervisor member for it).
 * Both were invisible to `capabilities --json`. This script exercises the
 * layers that carry real risk under `bun build --compile`:
 *
 *   1. capabilities   — CLI graph loads at all (cheap canary, kept).
 *   2. self-spawn     — the `__supervisor` hidden entry re-execs THIS binary
 *                       (the /$bunfs argv[1] path), starts a fleet, and the
 *                       supervisor stays alive.
 *   3. dashboard      — the supervisor spawns the `__dashboard` member, it
 *                       BOOTS (embedded qrcode vendor tree resolves) and
 *                       reaches `online` in fleet-state instead of crashlooping.
 *   4. http listen    — that dashboard actually serves (a response, any status,
 *                       proves the server bound rather than the process merely
 *                       existing).
 *
 * Deliberately NOT covered: anything needing Feishu credentials or a real bot.
 * Everything here runs against an empty `bots.json` in a scratch HOME, so it is
 * safe on a CI runner and on a developer machine.
 *
 * Usage:  node scripts/smoke-bun-binary.mjs <path-to-binary>
 * Exit 0 = all checks passed; non-zero + a diagnostic on the first failure.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.argv[2];
if (!binary) {
  console.error('usage: node scripts/smoke-bun-binary.mjs <path-to-binary>');
  process.exit(2);
}
if (!existsSync(binary)) {
  console.error(`smoke: binary not found: ${binary}`);
  process.exit(2);
}

/** Ports well clear of the default bases (7950/8800/7891) so a smoke run can
 *  never collide with a real fleet on the same machine. */
const PORTS = { ipc: 19950, proxy: 19800, dashboard: 19891 };
const DASHBOARD_ONLINE_TIMEOUT_MS = 30_000;
/** Separate budget for "the HTTP listener is bound": fleet-state `online` only
 *  proves the process spawned, so this waits on the socket after that. */
const DASHBOARD_HTTP_TIMEOUT_MS = 20_000;

const home = mkdtempSync(join(tmpdir(), 'botmux-bun-smoke-'));
mkdirSync(join(home, '.botmux'), { recursive: true });
// An EMPTY bot list: the fleet has no bots, but the dashboard is an
// unconditional supervisor member, so this is exactly the "operator opens the
// dashboard to add their first bot" state — and it needs no credentials.
writeFileSync(join(home, '.botmux', 'bots.json'), '[]');

const childEnv = {
  ...process.env,
  HOME: home,
  BOTMUX_DAEMON_IPC_BASE_PORT: String(PORTS.ipc),
  BOTMUX_WEB_PROXY_BASE_PORT: String(PORTS.proxy),
  BOTMUX_DASHBOARD_PORT: String(PORTS.dashboard),
};

let supervisor;
const cleanup = () => {
  if (supervisor && supervisor.exitCode === null) {
    try { supervisor.kill('SIGKILL'); } catch { /* already gone */ }
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
};
const fail = (step, detail) => {
  console.error(`smoke: FAIL [${step}] ${detail}`);
  cleanup();
  process.exit(1);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. capabilities: the CLI graph loads ─────────────────────────────────────
// Run from a scratch cwd with NO node_modules so a missing native/embedded
// module surfaces here instead of being masked by a sibling install.
try {
  const out = execFileSync(binary, ['capabilities', '--json'], {
    cwd: home, env: childEnv, encoding: 'utf-8', timeout: 60_000,
  });
  if (!out.includes('"schemaVersion"')) fail('capabilities', `unexpected output: ${out.slice(0, 200)}`);
  console.log('smoke: ✅ capabilities — CLI graph loads');
} catch (err) {
  fail('capabilities', err instanceof Error ? err.message : String(err));
}

// ── 2/3. self-spawn + dashboard boots and reaches online ─────────────────────
// `__supervisor` is the hidden self-re-exec entry: under a compiled binary this
// takes the /$bunfs argv[1] detection path, so a broken isStandaloneBinary() or
// entry dispatch fails here. The supervisor then spawns the dashboard member.
const statePath = join(home, '.botmux', 'fleet-state.json');
supervisor = spawn(binary, ['__supervisor'], {
  cwd: home, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let supervisorLog = '';
supervisor.stdout?.on('data', (d) => { supervisorLog += d.toString(); });
supervisor.stderr?.on('data', (d) => { supervisorLog += d.toString(); });
supervisor.on('error', (err) => fail('self-spawn', `supervisor spawn error: ${err.message}`));

const readDashboardRow = () => {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    return (state.procs ?? []).find((p) => p.name === 'botmux-dashboard');
  } catch { return undefined; }
};

const deadline = Date.now() + DASHBOARD_ONLINE_TIMEOUT_MS;
let row;
for (;;) {
  if (supervisor.exitCode !== null) {
    fail('self-spawn', `supervisor exited early (code ${supervisor.exitCode})\n--- log ---\n${supervisorLog.slice(-1500)}`);
  }
  row = readDashboardRow();
  if (row && row.status === 'online' && row.pid > 0) break;
  if (Date.now() >= deadline) {
    const errLog = (() => {
      const p = join(home, '.botmux', 'logs', 'dashboard-err.log');
      try { return readFileSync(p, 'utf-8').slice(-1500); } catch { return '(no dashboard-err.log)'; }
    })();
    fail(
      'dashboard',
      `dashboard never reached online within ${DASHBOARD_ONLINE_TIMEOUT_MS}ms `
      + `(row=${JSON.stringify(row ?? null)}). A crashloop here means the compiled `
      + `binary is missing an embedded module.\n--- dashboard-err.log ---\n${errLog}`,
    );
  }
  await delay(250);
}
console.log(`smoke: ✅ self-spawn — supervisor alive, spawned __dashboard (pid ${row.pid})`);
// restarts>0 means it crashed at least once before coming up: still a defect.
if ((row.restarts ?? 0) > 0) {
  fail('dashboard', `dashboard came online but had already restarted ${row.restarts}× (crashloop before settling)`);
}
console.log('smoke: ✅ dashboard — booted clean (0 restarts), embedded modules resolve');

// ── 4. the dashboard actually serves ────────────────────────────────────────
// ANY HTTP status proves the listener bound (an unauthenticated `/` legitimately
// answers 404). A connection error means the process exists but never listened.
//
// MUST POLL, not probe once: fleet-state `status: online` means the supervisor
// SPAWNED the child, not that the child finished binding its socket. A single
// fetch right after `online` loses that race (observed: connection refused, then
// HTTP 404 a moment later — the listener simply wasn't up yet).
const httpDeadline = Date.now() + DASHBOARD_HTTP_TIMEOUT_MS;
let served = null;
let lastHttpError = 'never attempted';
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.dashboard}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    served = res.status;
    break;
  } catch (err) {
    lastHttpError = err instanceof Error ? err.message : String(err);
  }
  if (supervisor.exitCode !== null) {
    fail('http', `supervisor died while waiting for the dashboard to serve\n--- log ---\n${supervisorLog.slice(-1500)}`);
  }
  if (Date.now() >= httpDeadline) {
    fail(
      'http',
      `dashboard port ${PORTS.dashboard} never served within ${DASHBOARD_HTTP_TIMEOUT_MS}ms `
      + `(last error: ${lastHttpError}). The process is online but its HTTP listener never bound.`,
    );
  }
  await delay(250);
}
console.log(`smoke: ✅ http — dashboard is serving (status ${served})`);

console.log('smoke: all checks passed');
cleanup();
process.exit(0);
