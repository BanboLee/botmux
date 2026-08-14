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
import { resolveEntrySpawn } from './self-spawn.js';
import { readFleetState } from './fleet-state-store.js';

const CONFIG_DIR = join(homedir(), '.botmux');
const HEAPSHOT_DIR = join(CONFIG_DIR, 'heapshots');
const ENV_FILE = join(CONFIG_DIR, '.env');

/** Path to the fleet state file (replaces pm2 jlist/dump). */
export function fleetStatePath(): string {
  return join(CONFIG_DIR, 'fleet-state.json');
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

