import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetSupervisor, pidAlive, type FleetBotSpec } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'fleet-sup-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a fake distDir whose index-daemon.js behaves per FLEET_TEST_MODE, so the
 *  supervisor's real `node dist/index-daemon.js` spawn path is exercised. */
function fakeDist(root: string, body: string): string {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index-daemon.js'), body);
  return dist;
}

const STAY = `
console.log('daemon pid=' + process.pid + ' idx=' + process.env.BOTMUX_BOT_INDEX);
process.on('SIGTERM', () => process.exit(90));
setInterval(() => {}, 1000);
`;

const bots: FleetBotSpec[] = [
  { name: 'botmux-0', appId: 'cli_a', botIndex: 0 },
  { name: 'botmux-1', appId: 'cli_b', botIndex: 1 },
];

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (fn()) return true; await delay(50); }
  return fn();
}

describe('FleetSupervisor (live, integration)', () => {
  it('starts all bots online, idempotent re-start is a no-op', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {} });
    sup.start(bots);
    await waitFor(() => (readFleetState(statePath)?.procs.filter((p) => p.status === 'online').length ?? 0) === 2);
    const s1 = readFleetState(statePath)!;
    expect(s1.procs.filter((p) => p.status === 'online')).toHaveLength(2);
    const pids1 = s1.procs.map((p) => p.pid).sort();
    expect(pids1.every((pid) => pidAlive(pid))).toBe(true);

    // idempotent: a second start must NOT respawn (same pids)
    sup.start(bots);
    await delay(300);
    const pids2 = readFleetState(statePath)!.procs.map((p) => p.pid).sort();
    expect(pids2).toEqual(pids1);

    await sup.stopAll();
  });

  it('autorestarts a crashed child (new pid, restart count bumped)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online');
    const oldPid = readFleetState(statePath)!.procs[0].pid;

    // Kill the underlying child (simulate crash: SIGKILL → non-graceful)
    process.kill(oldPid, 'SIGKILL');
    // supervisor should observe exit, bump restarts, respawn with a new pid
    const restarted = await waitFor(() => {
      const p = readFleetState(statePath)?.procs[0];
      return !!p && p.status === 'online' && p.pid !== oldPid && p.pid > 1 && p.restarts >= 1;
    });
    expect(restarted).toBe(true);
    expect(pidAlive(readFleetState(statePath)!.procs[0].pid)).toBe(true);

    await sup.stopAll();
  });

  it('does NOT restart a child that exits 90 (graceful)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const GRACEFUL = `console.log('bye'); process.exit(90);`;
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, GRACEFUL), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([bots[0]]);
    // it exits 90 right away → should end up 'stopped', restarts stays 0
    const stopped = await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'stopped');
    expect(stopped).toBe(true);
    await delay(300); // give any (wrong) restart a chance to happen
    const p = readFleetState(statePath)!.procs[0];
    expect(p.status).toBe('stopped');
    expect(p.restarts).toBe(0);
    expect(p.lastExitCode).toBe(90);

    await sup.stopAll();
  });

  it('parks a proc errored after exceeding max_restarts', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const CRASH = `process.exit(1);`;
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, CRASH), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 3, restartDelayMs: 20 }, log: () => {},
    });
    sup.start([bots[0]]);
    const parked = await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'errored', 8000);
    expect(parked).toBe(true);
    // exactly maxRestarts crash-restarts happened before parking
    expect(readFleetState(statePath)!.procs[0].restarts).toBe(3);

    await sup.stopAll();
  });

  it('stopAll gracefully stops running children', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {}, killTimeoutMs: 2000 });
    sup.start(bots);
    await waitFor(() => (readFleetState(statePath)?.procs.filter((p) => p.status === 'online').length ?? 0) === 2);
    const pids = readFleetState(statePath)!.procs.map((p) => p.pid);

    await sup.stopAll();
    await delay(200);
    // all children gone
    expect(pids.every((pid) => !pidAlive(pid))).toBe(true);
  });
});
