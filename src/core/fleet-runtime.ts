/**
 * Fleet runtime resolution — the single source of truth for what the supervisor
 * (and cmdStart) need to launch the fleet: the bot specs, the shared daemon env,
 * the node args, the dist dir, and the state-file path. Mirrors what the old
 * pm2 `ecosystemConfig` computed, minus pm2 itself.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, openSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { FleetBotSpec } from './fleet-supervisor.js';
import { pidAlive } from './fleet-supervisor.js';
import { resolveEntrySpawn } from './self-spawn.js';
import { readFleetState } from './fleet-state-store.js';
import type { FleetProcState, FleetState } from './fleet-supervisor-policy.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const HEAPSHOT_DIR = join(CONFIG_DIR, 'heapshots');
const ENV_FILE = join(CONFIG_DIR, '.env');

/** Path to the fleet state file (replaces pm2 jlist/dump). */
export function fleetStatePath(): string {
  return join(CONFIG_DIR, 'fleet-state.json');
}

/** Directory for per-bot daemon logs (daemon-<index>-out/err.log), the same
 *  LOG_DIR the old pm2 ecosystem wrote out_file/error_file into. */
export function fleetLogDir(): string {
  return LOG_DIR;
}

/** dist/ directory of THIS build (Node path). Under the standalone binary the
 *  spawner ignores it and re-execs the binary, so any value is fine there. */
export function fleetDistDir(): string {
  // dist/core/fleet-runtime.js → dist/
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Node interpreter args every daemon gets (heap ceiling + heap-snapshot dir).
 *  Matches the old ecosystem node_args; ignored for the standalone binary. */
export function fleetDaemonNodeArgs(): string[] {
  return ['--max-old-space-size=8192', `--diagnostic-dir=${HEAPSHOT_DIR}`];
}

/** The shared env every daemon child inherits. Loads the legacy global .env for
 *  backward compat (WEB_HOST etc.), same as index-daemon did via dotenv. */
export function resolveFleetDaemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Legacy: the daemon reads ~/.botmux/.env for global settings. We surface the
  // file's presence to the caller by NOT parsing here — index-daemon's own
  // dotenvConfig loads it. Keeping env pass-through avoids double-parsing.
  return env;
}

/** Build the fleet's bot specs from bots.json: name (botmux-<name|index>),
 *  appId, and the 0-based index the daemon reads via BOTMUX_BOT_INDEX. */
export function resolveFleetBots(): FleetBotSpec[] {
  const botsJson = join(CONFIG_DIR, 'bots.json');
  if (!existsSync(botsJson)) return [];
  let bots: unknown;
  try { bots = JSON.parse(readFileSync(botsJson, 'utf-8')); } catch { return []; }
  const list = Array.isArray(bots) ? bots : (bots as { bots?: unknown[] })?.bots;
  if (!Array.isArray(list)) return [];
  return list.map((b, index) => {
    const bot = (b ?? {}) as { name?: unknown; larkAppId?: unknown };
    const rawName = typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : String(index);
    // Match botProcessName: `botmux-<normalized name | index>`. We normalize the
    // same way (safe chars) to keep names stable + unique across restarts.
    const normalized = rawName.replace(/[^A-Za-z0-9._-]/g, '_');
    return {
      name: `botmux-${normalized}`,
      appId: typeof bot.larkAppId === 'string' ? bot.larkAppId : '',
      botIndex: index,
    };
  });
}

const LOG_DIR = join(CONFIG_DIR, 'logs');

/** True if a live fleet supervisor is already running (per fleet-state pid + kill -0). */
export function liveSupervisorPid(): number | undefined {
  const state = readFleetState(fleetStatePath());
  const pid = state?.supervisorPid ?? 0;
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try { process.kill(pid, 0); return pid; } catch { return undefined; }
}

export interface StartFleetResult {
  action: 'started' | 'already-running';
  supervisorPid: number;
  botCount: number;
}

/**
 * Launch the fleet supervisor as a detached, long-lived process (replaces
 * `pm2 start`). Single-supervisor guarantee: if a live supervisor already owns
 * the fleet, this is a no-op ('already-running') — the running supervisor is
 * itself idempotent and keeps the fleet reconciled. The spawned supervisor
 * outlives this CLI (detached + unref), with stdout/err to the botmux log dir;
 * boot persistence (systemd/launchd) re-invokes `botmux start` → here.
 *
 * NOTE: the caller must already hold the fleet-mutation file lock so two
 * concurrent `botmux start` invocations can't both pass the liveness check.
 */
export function startFleetViaSupervisor(): StartFleetResult {
  const bots = resolveFleetBots();
  const existing = liveSupervisorPid();
  if (existing !== undefined) {
    return { action: 'already-running', supervisorPid: existing, botCount: bots.length };
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'supervisor-out.log'), 'a');
  const err = openSync(join(LOG_DIR, 'supervisor-err.log'), 'a');
  const { command, args } = resolveEntrySpawn('supervisor', fleetDistDir());
  const nodeArgs = args.length > 0 && args[0].startsWith('__') ? [] : ['--enable-source-maps'];
  const child = spawn(command, [...nodeArgs, ...args], {
    cwd: CONFIG_DIR,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env },
  });
  child.unref();
  return { action: 'started', supervisorPid: child.pid ?? 0, botCount: bots.length };
}

const STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export interface StopFleetResult {
  action: 'stopped' | 'not-running' | 'timeout';
  supervisorPid: number;
}

/**
 * Stop the whole fleet by signaling the live supervisor and waiting for it to
 * exit (replaces `pm2 stop` + God teardown). SIGTERM triggers the supervisor's
 * own `stopAll()` — graceful SIGTERM→kill_timeout→SIGKILL of every daemon, plus
 * finalizing fleet-state (procs → stopped, supervisorPid → 0). We poll the pid
 * with kill-0 until it's gone; on timeout we escalate to SIGKILL of the
 * supervisor itself (its children still received SIGTERM and self-reap).
 *
 * NOTE: caller must hold the fleet-mutation lock (single stop/start/restart at
 * a time), same contract as startFleetViaSupervisor.
 */
export function stopFleet(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): StopFleetResult {
  const pid = liveSupervisorPid();
  if (pid === undefined) return { action: 'not-running', supervisorPid: 0 };
  try { process.kill(pid, 'SIGTERM'); } catch { return { action: 'not-running', supervisorPid: pid }; }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return { action: 'stopped', supervisorPid: pid };
    sleepSyncMs(STOP_POLL_INTERVAL_MS);
  }
  if (!pidAlive(pid)) return { action: 'stopped', supervisorPid: pid };
  // Supervisor outlasted its graceful window — hard-kill it. Its daemon children
  // already got SIGTERM from stopAll() and will exit on their own.
  try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
  return pidAlive(pid) ? { action: 'timeout', supervisorPid: pid } : { action: 'stopped', supervisorPid: pid };
}

export interface RestartFleetResult {
  stop: StopFleetResult;
  start: StartFleetResult;
}

/**
 * Restart the fleet: stop the live supervisor (if any), then start a fresh one.
 * Because startFleetViaSupervisor re-reads bots.json, this also picks up any
 * config change. Caller must hold the fleet-mutation lock.
 */
export function restartFleet(timeoutMs = DEFAULT_STOP_TIMEOUT_MS): RestartFleetResult {
  const stop = stopFleet(timeoutMs);
  const start = startFleetViaSupervisor();
  return { stop, start };
}

export interface FleetStatusRow {
  name: string;
  appId: string;
  pid: number;
  status: FleetProcState['status'];
  alive: boolean;
  restarts: number;
  lastExitCode: number | null;
  startedAt: string | null;
}

export interface FleetStatus {
  supervisorPid: number;
  supervisorAlive: boolean;
  supervisorStartedAt: string;
  rows: FleetStatusRow[];
}

/**
 * Project a raw FleetState into a status view, cross-checking each recorded pid
 * with a liveness probe so a stale 'online' row whose daemon actually died is
 * reported alive:false. Pure over (state, isAlive) — unit-testable without HOME.
 */
export function projectFleetStatus(
  state: FleetState | null,
  isAlive: (pid: number) => boolean = pidAlive,
): FleetStatus {
  const supervisorPid = state?.supervisorPid ?? 0;
  return {
    supervisorPid,
    supervisorAlive: isAlive(supervisorPid),
    supervisorStartedAt: state?.supervisorStartedAt ?? '',
    rows: (state?.procs ?? []).map((p) => ({
      name: p.name,
      appId: p.appId,
      pid: p.pid,
      status: p.status,
      alive: isAlive(p.pid),
      restarts: p.restarts,
      lastExitCode: p.lastExitCode,
      startedAt: p.startedAt,
    })),
  };
}

/**
 * Read the current fleet status from fleet-state.json (replaces `pm2 status`).
 * Cross-checks each recorded pid with kill-0 so a stale 'online' row whose
 * daemon actually died is reported alive:false — the supervisor reconciles it
 * on its next tick, but status should never lie about liveness in the meantime.
 */
export function readFleetStatus(statePath: string = fleetStatePath()): FleetStatus {
  return projectFleetStatus(readFleetState(statePath));
}

/** Block for `ms` without a busy-spin (one-shot CLI; stalling its loop is fine). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → no-op */ }
}

export interface WaitFleetOnlineResult {
  healthy: boolean;
  online: number;
  expected: number;
  /** Names not online+alive at timeout (empty when healthy). */
  pending: string[];
}

/**
 * Poll fleet-state until every configured bot shows online+alive, or timeout.
 * Replaces pm2's synchronous `readAndAssertConfiguredFleetOnline` health gate:
 * the supervisor spawns children asynchronously after a detached start, so the
 * CLI waits here for the fleet to converge before reporting success / committing
 * the restart-summary breadcrumb. Non-fatal by contract — the caller decides
 * what an unhealthy result means (warn vs. throw).
 */
export function waitFleetOnline(
  expectedNames: readonly string[],
  timeoutMs = 30_000,
  statePath: string = fleetStatePath(),
): WaitFleetOnlineResult {
  const expected = expectedNames.length;
  if (expected === 0) return { healthy: true, online: 0, expected: 0, pending: [] };
  const want = new Set(expectedNames);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let pending: string[] = [...want];
  for (;;) {
    const status = readFleetStatus(statePath);
    const onlineNames = new Set(
      status.rows.filter((r) => want.has(r.name) && r.status === 'online' && r.alive).map((r) => r.name),
    );
    pending = [...want].filter((n) => !onlineNames.has(n));
    if (pending.length === 0) return { healthy: true, online: expected, expected, pending: [] };
    if (Date.now() >= deadline) return { healthy: false, online: expected - pending.length, expected, pending };
    sleepSyncMs(250);
  }
}

/** Configured supervisor process names (botmux-<name|index>) for health checks. */
export function fleetBotNames(): string[] {
  return resolveFleetBots().map((b) => b.name);
}

