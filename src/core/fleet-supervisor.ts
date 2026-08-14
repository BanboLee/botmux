/**
 * Fleet supervisor — LIVE layer (owns spawn/kill/fs/timers). Replaces pm2's God
 * daemon for the multi-bot fleet. One `FleetSupervisor` process (the `__supervisor`
 * entry) spawns each bot's daemon as a `__daemon` child, monitors exits, and
 * applies the pure policy decisions (restart-with-backoff / stop / park). All
 * state goes through fleet-state-store (atomic + locked). Boot persistence stays
 * with systemd/launchd, which re-run `botmux start`.
 *
 * Safety decisions (graceful-exit, max_restarts, projection identity, idempotent
 * start, generation addressing) come from fleet-supervisor-policy — this layer
 * only does the I/O the policy tells it to.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolveEntrySpawn } from './self-spawn.js';
import {
  decideOnExit,
  freshProc,
  planStart,
  DEFAULT_RESTART_POLICY,
  type FleetProcState,
  type RestartPolicy,
  type ChildExit,
} from './fleet-supervisor-policy.js';
import { mutateFleetState, readFleetState } from './fleet-state-store.js';

export interface FleetBotSpec {
  /** botmux-<index> process name. */
  name: string;
  appId: string;
  /** 0-based bot index passed to the daemon via BOTMUX_BOT_INDEX. */
  botIndex: number;
}

export interface FleetSupervisorOptions {
  statePath: string;
  distDir: string;
  /** Base env every daemon child inherits (already scrubbed by the caller). */
  daemonEnv: NodeJS.ProcessEnv;
  cwd: string;
  policy?: RestartPolicy;
  /** ms to wait after SIGTERM before SIGKILL on stop (pm2 kill_timeout). */
  killTimeoutMs?: number;
  /** Node interpreter args (heap/diag) — Node path only; ignored in standalone. */
  daemonNodeArgs?: string[];
  /** Injected for tests; defaults to console. */
  log?: (msg: string) => void;
}

/** True if a pid is alive (kill -0). pid<=1 is never a real supervised child. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class FleetSupervisor {
  private readonly children = new Map<string, ChildProcess>();
  /** Per-name generation the live child was spawned with — guards stale exits. */
  private readonly liveGeneration = new Map<string, number>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopping = false;
  private readonly policy: RestartPolicy;
  private readonly killTimeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: FleetSupervisorOptions) {
    this.policy = opts.policy ?? DEFAULT_RESTART_POLICY;
    this.killTimeoutMs = opts.killTimeoutMs ?? 8000;
    this.log = opts.log ?? ((m) => console.error(`[fleet-supervisor] ${m}`));
  }

  /** Start (or reconcile) the fleet: spawn every configured bot not already
   *  alive. Idempotent — an already-live child (per state + kill -0) is left be.
   *  This is both the initial start and the resurrect path. */
  start(bots: readonly FleetBotSpec[]): void {
    const specByName = new Map(bots.map((b) => [b.name, b]));
    // Record our supervisor identity + reconcile the persisted proc set against
    // reality before deciding what to (re)spawn.
    mutateFleetState(this.opts.statePath, (cur) => {
      cur.supervisorPid = process.pid;
      cur.supervisorStartedAt = cur.supervisorStartedAt || new Date().toISOString();
      // Drop procs no longer configured; mark dead 'online' procs as such so
      // planStart re-spawns them (reconcile after a supervisor restart).
      cur.procs = cur.procs.filter((p) => specByName.has(p.name));
      for (const p of cur.procs) {
        if (p.status === 'online' && !pidAlive(p.pid)) { p.pid = 0; p.status = 'stopped'; }
      }
      return cur;
    });

    const current = readFleetState(this.opts.statePath)?.procs ?? [];
    const toStart = planStart([...specByName.keys()], current, (p) => p.status === 'online' && pidAlive(p.pid));
    for (const name of toStart) {
      const spec = specByName.get(name);
      if (spec) this.spawnBot(spec, /* isRestart */ false);
    }
  }

  private spawnBot(spec: FleetBotSpec, isRestart: boolean): void {
    if (this.stopping) return;
    const { command, args } = resolveEntrySpawn('daemon', this.opts.distDir);
    // node_args (heap/diag) apply only to the Node path; a compiled binary has
    // no separate interpreter args. resolveEntrySpawn already picks the shape;
    // we prepend node_args only when the command is a node/JS invocation.
    const isStandalone = args.length > 0 && args[0].startsWith('__');
    const nodeArgs = isStandalone ? [] : (this.opts.daemonNodeArgs ?? []);
    const child = spawn(command, [...nodeArgs, ...args], {
      cwd: this.opts.cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...this.opts.daemonEnv, BOTMUX_BOT_INDEX: String(spec.botIndex) },
      windowsHide: true,
    });
    const now = new Date().toISOString();

    // Persist the new generation + pid atomically, bumping generation on restart.
    const generation = mutateFleetState(this.opts.statePath, (cur) => {
      const existing = cur.procs.find((p) => p.name === spec.name);
      if (existing) {
        existing.pid = child.pid ?? 0;
        existing.generation += 1;
        existing.status = 'online';
        existing.startedAt = now;
        existing.lastExitCode = null;
        // restarts is bumped by the exit handler's decision, not here.
      } else {
        cur.procs.push({ ...freshProc(spec.name, spec.appId, child.pid ?? 0, now) });
      }
      return cur;
    }).procs.find((p) => p.name === spec.name)!.generation;

    this.children.set(spec.name, child);
    this.liveGeneration.set(spec.name, generation);
    this.log(`${isRestart ? 'restarted' : 'started'} ${spec.name} (pid ${child.pid}, gen ${generation})`);

    child.on('exit', (code, signal) => this.onChildExit(spec, generation, { code, signal }));
    child.on('error', (err) => {
      this.log(`${spec.name} spawn error: ${err.message}`);
      this.onChildExit(spec, generation, { code: 1, signal: null });
    });
  }

  private onChildExit(spec: FleetBotSpec, generation: number, exit: ChildExit): void {
    // Generation guard: ignore an exit from a child we already replaced. A stale
    // exit must never mutate the newer generation's row or trigger a double spawn.
    if (this.liveGeneration.get(spec.name) !== generation) return;
    this.children.delete(spec.name);
    if (this.stopping) return;

    const current = readFleetState(this.opts.statePath)?.procs.find((p) => p.name === spec.name);
    const decision = decideOnExit({ restarts: current?.restarts ?? 0 }, exit, this.policy);

    if (decision.action === 'stop') {
      this.log(`${spec.name} exited cleanly (graceful); not restarting`);
      this.markStopped(spec.name, exit, 'stopped');
      return;
    }
    if (decision.action === 'park') {
      this.log(`${spec.name} exceeded max_restarts (${decision.atRestarts}); parking errored`);
      this.markStopped(spec.name, exit, 'errored');
      return;
    }
    // restart: record the bump, then respawn after the backoff.
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === spec.name);
      if (p) { p.restarts = decision.nextRestarts; p.status = 'launching'; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.log(`${spec.name} crashed (code=${exit.code} signal=${exit.signal}); restart ${decision.nextRestarts}/${this.policy.maxRestarts} in ${this.policy.restartDelayMs}ms`);
    const timer = setTimeout(() => { this.restartTimers.delete(spec.name); this.spawnBot(spec, true); }, this.policy.restartDelayMs);
    timer.unref?.();
    this.restartTimers.set(spec.name, timer);
  }

  private markStopped(name: string, exit: ChildExit, status: 'stopped' | 'errored'): void {
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === name);
      if (p) { p.status = status; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.liveGeneration.delete(name);
  }

  /** Graceful stop of the whole fleet: SIGTERM each child, then SIGKILL any that
   *  outlast kill_timeout. Cancels pending restart timers first so a mid-backoff
   *  crash can't respawn during shutdown. Resolves when all children are gone. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    const pending = [...this.children.entries()];
    await Promise.all(pending.map(([name, child]) => this.stopOne(name, child)));
  }

  private stopOne(name: string, child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(killTimer); resolve(); };
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, this.killTimeoutMs);
      killTimer.unref?.();
      child.once('exit', finish);
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }
}
