/**
 * Fleet runtime resolution — the single source of truth for what the supervisor
 * (and cmdStart) need to launch the fleet: the bot specs, the shared daemon env,
 * the node args, the dist dir, and the state-file path. Mirrors what the old
 * pm2 `ecosystemConfig` computed, minus pm2 itself.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import type { FleetBotSpec } from './fleet-supervisor.js';

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
