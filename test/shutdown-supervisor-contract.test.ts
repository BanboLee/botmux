import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS,
  DAEMON_SHUTDOWN_MAX_MS,
  DAEMON_SHUTDOWN_OVERHEAD_MS,
  DAEMON_WORKER_EXIT_GRACE_MS,
  FLEET_DAEMON_EXIT_WAIT_MS,
  FLEET_SUCCESSOR_SETTLE_MS,
  PM2_DAEMON_KILL_TIMEOUT_MS,
  PM2_DAEMON_RESTART_DELAY_MS,
  RIFF_ADMISSION_RESTORE_TIMEOUT_MS,
  RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS,
  RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS,
  RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS,
} from '../src/core/shutdown-budgets.js';
import { DAEMON_GRACEFUL_EXIT_CODE } from '../src/core/supervisor-shutdown-protocol.js';
import { PM2_GRACEFUL_EXIT_CODE } from '../src/pm2-graceful-exit.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const fleetShutdown = readFileSync(new URL('../src/cli/fleet-shutdown.ts', import.meta.url), 'utf8');
const ipcServer = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const pm2Preflight = readFileSync(new URL('../src/cli/pm2-preflight.ts', import.meta.url), 'utf8');
const botsStore = readFileSync(new URL('../src/setup/bots-store.ts', import.meta.url), 'utf8');
const bundledPm2God = readFileSync(new URL('../node_modules/pm2/lib/God.js', import.meta.url), 'utf8');

describe('graceful shutdown supervisor contract', () => {
  it('uses a nonzero daemon-only graceful sentinel because PM2 maps signal death to zero', () => {
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBeGreaterThan(0);
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBeLessThan(256);
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBe(PM2_GRACEFUL_EXIT_CODE);
    expect(bundledPm2God).toContain('God.handleExit(clu, code || 0, signal);');

    const ecosystemStart = cli.indexOf('function ecosystemConfig(');
    const daemonPolicy = cli.slice(ecosystemStart, cli.indexOf('const apps:', ecosystemStart));
    const dashboardPolicy = cli.slice(
      cli.indexOf("name: 'botmux-dashboard'", ecosystemStart),
      cli.indexOf('const cfg = { apps };', ecosystemStart),
    );
    expect(daemonPolicy).toContain('stop_exit_codes: managedExit.stopExitCodes');
    expect(daemonPolicy).not.toContain('stop_exit_codes: [0]');
    expect(dashboardPolicy).toContain('stop_exit_codes: managedExit.stopExitCodes');
    expect(cli.match(/\.\.\.managedExit\.env/g)).toHaveLength(2);

    const shutdownStart = daemon.indexOf('const shutdown = async () => {');
    const shutdownEnd = daemon.indexOf("process.on('SIGTERM'", shutdownStart);
    const shutdown = daemon.slice(shutdownStart, shutdownEnd);
    expect(shutdown).toContain('process.exit(gracefulProcessExitCode());');
    expect(shutdown).not.toContain('process.exit(0);');
    expect(cli).toContain('assertDaemonPm2GracefulExitPolicy(');
    expect(cli).toContain('`${operation}-handler-ready-pm2-policy`');

    const projectionStart = cli.indexOf('function toBotmuxPm2ProcessEntry(');
    const projectionEnd = cli.indexOf('function readVerifiedBotmuxPm2Projection(', projectionStart);
    const projection = cli.slice(projectionStart, projectionEnd);
    expect(projection).toContain(
      'stopExitCodes: normalizeRawPm2StopExitCodes(rawStopExitCodes)',
    );
    expect(projection).not.toContain('.map(code => parsePm2Integer(code))');
    expect(bundledPm2God).toContain(
      "stopExitCodes.map((strOrNum) => typeof strOrNum === 'string' ? parseInt(strOrNum, 10) : strOrNum)",
    );
    expect(bundledPm2God).toContain('proc.pm2_env.unstable_restarts >= max_restarts');
    expect(bundledPm2God).toContain('if (!stopping && !overlimit)');
    expect(fleetShutdown).toContain('isFleetEntryProvenTerminalAfterSignal(exactState)');
    expect(fleetShutdown).toContain('post-signal terminal proof');
    expect(fleetShutdown).toContain('latestTrackedPidByName.get(trackedEntry.name) === pid');
    expect(fleetShutdown).toContain('a later missing row is never success');
    expect(fleetShutdown).toContain('liveReplacementPublished');
    expect(fleetShutdown).toContain("replacement's own");
  });

  it('keeps outer supervisor budgets beyond both success and abort-restore paths', () => {
    expect(DAEMON_SHUTDOWN_MAX_MS).toBe(
      BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
      + RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
      + RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS
      + RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
      + Math.max(RIFF_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
      + DAEMON_SHUTDOWN_OVERHEAD_MS,
    );
    expect(DAEMON_SHUTDOWN_MAX_MS).toBeLessThanOrEqual(28_000);
    expect(PM2_DAEMON_KILL_TIMEOUT_MS).toBeGreaterThan(DAEMON_SHUTDOWN_MAX_MS);
    expect(FLEET_DAEMON_EXIT_WAIT_MS).toBeGreaterThan(PM2_DAEMON_KILL_TIMEOUT_MS);
    expect(FLEET_SUCCESSOR_SETTLE_MS).toBeGreaterThan(PM2_DAEMON_RESTART_DELAY_MS);
    expect(FLEET_DAEMON_EXIT_WAIT_MS)
      .toBeGreaterThan(DAEMON_SHUTDOWN_MAX_MS + FLEET_SUCCESSOR_SETTLE_MS);
    expect(FLEET_DAEMON_EXIT_WAIT_MS)
      .toBeGreaterThan(PM2_DAEMON_KILL_TIMEOUT_MS + FLEET_SUCCESSOR_SETTLE_MS);
  });

  it('public stop signals the supervisor and waits, under the fleet lock', () => {
    // Post-pm2: cmdStop no longer jlist-verifies + deletes per-row. It signals
    // the single supervisor (which SIGTERMs every daemon + finalizes state) and
    // waits for it to exit — all under the fleet-mutation lock.
    const start = cli.indexOf('async function cmdStop()');
    const end = cli.indexOf('async function cmdRestart()', start);
    const stop = cli.slice(start, end);
    const lock = stop.indexOf('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
    const call = stop.indexOf('stopFleet()', lock);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(lock);
    // The pm2 per-row jlist/stop/delete dance is gone.
    expect(stop).not.toContain("runPm2(['stop'");
    expect(stop).not.toContain("runPm2(['delete'");
    expect(stop).not.toContain("pm2Capture(['jlist'])");
    expect(stop).not.toContain('signalAndAwaitBotmuxProcesses');
    // Timeout is surfaced (SIGKILL escalation happens inside stopFleet).
    expect(stop).toContain("result.action === 'timeout'");
    expect(stop).toContain('stopPluginServicesForCli(undefined, { autoOnly: true })');
  });

  it('restart waits for the fleet decision before any PM2 delete', () => {
    const start = cli.indexOf('function deleteAllBotmuxProcesses(');
    const end = cli.indexOf('/**\n * One-time migration', start);
    const restart = cli.slice(start, end);
    const signal = restart.indexOf("signalAndAwaitBotmuxProcesses(entries, 'restart', home");
    const justInTime = restart.indexOf(
      "revalidateExactQuiescentRowBeforeMutation(\n        'restart-before-delete'",
      signal,
    );
    const remove = restart.indexOf("runPm2(['delete', String(exact.pmId)]", justInTime);
    expect(signal).toBeGreaterThanOrEqual(0);
    expect(justInTime).toBeGreaterThan(signal);
    expect(remove).toBeGreaterThan(justInTime);
    expect(restart).not.toContain("runPm2(['delete', ...exactIds]");
    expect(restart.indexOf("pm2Capture(['jlist'], home)", remove)).toBeGreaterThan(remove);
    expect(restart.indexOf("assertNoUnregisteredLiveDaemonDescriptors(\n      'restart-after-delete'", remove))
      .toBeGreaterThan(remove);
    expect(restart).toContain('PM2 delete left registry entries');
  });

  it('takes one Riff snapshot, batch-persists, then generation-checks and commits before service stop', () => {
    const start = daemon.indexOf('const shutdown = async () => {');
    const stop = daemon.indexOf('scheduler.stopScheduler();', start);
    const boundedGate = daemon.indexOf('tryWithBotTurnMutation(', start);
    const initialUnique = daemon.indexOf(
      'collectUniqueDaemonShutdownSessions(activeSessions.values())',
      boundedGate,
    );
    const prepareAll = daemon.indexOf('prepareRiffFleetForShutdown(riffCandidates', initialUnique);
    const persistAll = daemon.indexOf('persistPreparedRiffShutdownFleet(riffPrepared', prepareAll);
    const currentUnique = daemon.indexOf(
      'collectUniqueDaemonShutdownSessions(activeSessions.values())',
      initialUnique + 1,
    );
    const secondCheck = daemon.indexOf('const riffGenerationMismatch', persistAll);
    const commitAll = daemon.indexOf('commitPreparedRiffShutdown(ds, result)', secondCheck);
    const teardownUnique = daemon.indexOf(
      'for (const ds of currentShutdownFleet.sessions)',
      commitAll,
    );
    expect(boundedGate).toBeGreaterThan(start);
    expect(initialUnique).toBeGreaterThan(boundedGate);
    expect(prepareAll).toBeGreaterThan(initialUnique);
    expect(persistAll).toBeGreaterThan(prepareAll);
    expect(currentUnique).toBeGreaterThan(persistAll);
    expect(secondCheck).toBeGreaterThan(currentUnique);
    expect(commitAll).toBeGreaterThan(secondCheck);
    expect(teardownUnique).toBeGreaterThan(commitAll);
    expect(stop).toBeGreaterThan(commitAll);
    expect(daemon.slice(start, stop)).toContain('abortRiffShutdownFleet(');
    expect(daemon.slice(start, stop)).toContain('canAbortVerifiedExitedRiffPreparation(');
  });

  it('publishes shutdown capability only after both signal handlers are installed', () => {
    const descStart = daemon.indexOf('const desc: DaemonDescriptor = {');
    const firstDescriptorWrite = daemon.indexOf('writeDaemonDescriptor(desc);', descStart);
    const sigtermHandler = daemon.indexOf("process.on('SIGTERM'", firstDescriptorWrite);
    const sigintHandler = daemon.indexOf("process.on('SIGINT'", sigtermHandler);
    const capabilityCommit = daemon.indexOf(
      'desc.supervisorShutdownProtocol = SUPERVISOR_SHUTDOWN_PROTOCOL;',
      sigintHandler,
    );
    const ipcHandlerReady = daemon.indexOf('setSupervisorShutdownHandler({', sigintHandler);
    const attestedWrite = daemon.indexOf('writeDaemonDescriptor(desc);', capabilityCommit);

    expect(descStart).toBeGreaterThanOrEqual(0);
    expect(firstDescriptorWrite).toBeGreaterThan(descStart);
    expect(daemon.slice(descStart, firstDescriptorWrite))
      .not.toContain('supervisorShutdownProtocol: SUPERVISOR_SHUTDOWN_PROTOCOL');
    expect(sigtermHandler).toBeGreaterThan(firstDescriptorWrite);
    expect(sigintHandler).toBeGreaterThan(sigtermHandler);
    expect(ipcHandlerReady).toBeGreaterThan(sigintHandler);
    expect(capabilityCommit).toBeGreaterThan(ipcHandlerReady);
    expect(attestedWrite).toBeGreaterThan(capabilityCommit);
  });

  it('uses exact-id conditional PM2 start for proven-offline compensation, never public start/restart', () => {
    const start = cli.indexOf('startOffline: (offlineEntries, timeoutMs) =>');
    const endOffset = cli.slice(start).search(/\n\s+list,/);
    const end = endOffset < 0 ? -1 : start + endOffset;
    const compensation = cli.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(compensation).toContain('runExactPm2Starts(offlineEntries');
    expect(compensation).not.toContain("runPm2(['start'");
    expect(compensation).not.toContain("runPm2(['restart'");
  });

  it('serializes every core PM2 mutation surface on one async fleet lock', () => {
    const regions = [
      ['start', 'async function cmdStart()', '/**\n * Wipe stale dashboard-daemon descriptors'],
      ['stop', 'async function cmdStop()', 'async function cmdRestart()'],
      ['restart', 'async function cmdRestart()', '/** Observe botmux PM2 rows'],
      ['start-bot', 'async function ensureBotDaemonStarted(', '/**\n * `botmux start-bot'],
    ] as const;
    for (const [label, startMarker, endMarker] of regions) {
      const start = cli.indexOf(startMarker);
      const end = cli.indexOf(endMarker, start);
      const region = cli.slice(start, end);
      expect(start, label).toBeGreaterThanOrEqual(0);
      expect(end, label).toBeGreaterThan(start);
      expect(region, label).toContain('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
      expect(region, label).not.toContain('withFileLockSync(PM2_FLEET_MUTATION_LOCK_TARGET');
    }

    const exactHelper = cli.slice(
      cli.indexOf('async function cmdInternalPm2StartExact('),
      cli.indexOf('function runExactPm2Starts(', cli.indexOf('async function cmdInternalPm2StartExact(')),
    );
    expect(exactHelper).toContain('BOTMUX_PM2_FLEET_LOCK_OWNER_PID');
    expect(exactHelper).toContain('PM2_FLEET_MUTATION_LOCK_TARGET}.lock');
    expect(exactHelper).toContain('lockPid !== process.ppid');
  });

  it('fails closed before PM2 mutation on duplicate Gods, stale preflight, or unregistered descriptors', () => {
    const duplicateStart = cli.indexOf('function listSingletonPm2GodDaemonPidsForMutation(');
    const duplicateEnd = cli.indexOf('function runPm2(', duplicateStart);
    const duplicate = cli.slice(duplicateStart, duplicateEnd);
    expect(duplicate).toContain('multiple PM2 God daemons');
    expect(duplicate).not.toContain("process.kill(pid, 'SIGTERM')");
    expect(duplicate).not.toContain("process.kill(pid, 'SIGKILL')");

    const preflightStart = cli.indexOf('function preflightNodeSanity(');
    const preflightEnd = cli.indexOf('async function cmdStart()', preflightStart);
    const preflight = cli.slice(preflightStart, preflightEnd);
    expect(preflight).toContain('assertLinuxPm2GodExecutableUsable(pm2Pid)');
    expect(preflight).toContain('listPm2GodDaemonPids(home)');
    expect(preflight).not.toContain("join(PM2_HOME, 'pm2.pid')");
    expect(preflight).not.toContain("runPm2(['kill']");
    expect(preflight).not.toContain("'SIGKILL'");
    expect(pm2Preflight).toContain('拒绝自动清理');

    // The still-pm2 start-bot surface keeps the unregistered-descriptor fence.
    // The supervisor-managed start/stop/restart no longer inspect pm2 descriptors
    // (the supervisor owns the live proc set via fleet-state.json).
    for (const operation of ['start-bot', 'stop-bot']) {
      expect(cli).toContain(`assertNoUnregisteredLiveDaemonDescriptors('${operation}'`);
    }
  });

  it('restart stages intent, restarts the supervisor, verifies health, then commits the breadcrumb', () => {
    // Post-pm2 restart contract: consume any staged intent → write the attempt
    // breadcrumb → restartFleet() (stop old supervisor + start fresh) →
    // waitFleetOnline() health gate → commit the breadcrumb only after healthy.
    // On any failure the breadcrumb attempt is removed (no false restart summary).
    const start = cli.indexOf('async function cmdRestart()');
    const end = cli.indexOf('/** Observe botmux PM2 rows', start);
    const restart = cli.slice(start, end);
    const consume = restart.indexOf('consumeRestartIntentTo(');
    const writeIntent = restart.indexOf('writeRestartAttemptIntentTo(', consume);
    const restartFleet = restart.indexOf('restartFleet()', writeIntent);
    const health = restart.indexOf('waitFleetOnline(', restartFleet);
    const removeOnFail = restart.indexOf('removeRestartIntentAttemptTo(', health);
    const commit = restart.indexOf('commitRestartIntentAttemptTo(', health);
    expect(consume).toBeGreaterThanOrEqual(0);
    expect(writeIntent).toBeGreaterThan(consume);
    expect(restartFleet).toBeGreaterThan(writeIntent);
    expect(health).toBeGreaterThan(restartFleet);
    expect(removeOnFail).toBeGreaterThan(health); // failure path removes the attempt
    expect(commit).toBeGreaterThan(health);       // commit only after health gate
    // The whole restart is serialized on the fleet-mutation lock, and the pm2
    // transaction/rollback/ecosystem machinery is gone from this path.
    expect(restart).toContain('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
    expect(restart).not.toContain('runBoundedPm2StartTransaction(');
    expect(restart).not.toContain('rollbackPm2StartAttempt(');
    expect(restart).not.toContain("runPm2(['start'");
    expect(restart).not.toContain('ecosystemConfig(');
    // A failed health gate aborts the restart (throws), not a silent success.
    expect(restart).toContain('health.healthy');
  });

  it('bounds and freshly verifies the still-pm2 start-bot surface with compensation', () => {
    // start-bot is the last pm2-managed surface (single-bot spawn); cmdStart and
    // cmdRestart moved to the supervisor. Until start-bot migrates, it keeps the
    // bounded pm2 start transaction + fresh verify + rollback.
    expect(cli).toContain('const PM2_START_VERIFY_MIN_TIMEOUT_MS = 60_000;');
    expect(cli).toContain('pm2StartVerifyTimeoutMs(configuredNames.length)');
    const startBot = cli.slice(
      cli.indexOf('async function ensureBotDaemonStarted('),
      cli.indexOf('/**\n * `botmux start-bot'),
    );
    expect(startBot).toContain('runBoundedPm2StartTransaction(');
    expect(startBot).toContain('PM2_START_COMMAND_TIMEOUT_MS');
    expect(startBot).toContain('readAndAssertConfiguredFleetOnline(');
    expect(startBot).toContain('rollbackPm2StartAttempt(');
    expect(startBot).toContain('timeoutMs');
    // The supervisor-managed surfaces no longer carry the pm2 transaction.
    const cmdStart = cli.slice(
      cli.indexOf('async function cmdStart()'),
      cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors'),
    );
    const cmdRestart = cli.slice(
      cli.indexOf('async function cmdRestart()'),
      cli.indexOf('/** Observe botmux PM2 rows'),
    );
    expect(cmdStart).toContain('startFleetViaSupervisor()');
    expect(cmdStart).not.toContain('runBoundedPm2StartTransaction(');
    expect(cmdRestart).toContain('restartFleet()');
    expect(cmdRestart).not.toContain('runBoundedPm2StartTransaction(');
  });

  it('holds one bots.json generation for the still-pm2 start-bot surface', () => {
    expect(botsStore).toContain('withFileLockSync(botsJsonPath');
    // start-bot still renders the ecosystem under a bots.json snapshot lock.
    const startBot = cli.slice(
      cli.indexOf('async function ensureBotDaemonStarted('),
      cli.indexOf('/**\n * `botmux start-bot'),
    );
    expect(startBot).toContain('withFileLock(BOTS_JSON_FILE');
    expect(startBot).toContain('ecosystemConfig(');
    expect(startBot).toContain('configuredCoreProcessNames(');
    // Supervisor-managed start/restart still take the bots.json lock (start reads
    // it for the credential-snapshot guard; restart for the intent breadcrumb),
    // but no longer render an ecosystem — the supervisor re-reads bots.json itself.
    const cmdStart = cli.slice(
      cli.indexOf('async function cmdStart()'),
      cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors'),
    );
    const cmdRestart = cli.slice(
      cli.indexOf('async function cmdRestart()'),
      cli.indexOf('/** Observe botmux PM2 rows'),
    );
    expect(cmdStart).toContain('withFileLock(BOTS_JSON_FILE');
    expect(cmdStart).not.toContain('ecosystemConfig(');
    expect(cmdRestart).toContain('withFileLock(BOTS_JSON_FILE');
    expect(cmdRestart).not.toContain('ecosystemConfig(');
  });

  it('admits start-bot only through the exact configured fleet classifier', () => {
    const start = cli.indexOf('async function ensureBotDaemonStarted(');
    const end = cli.indexOf('/**\n * `botmux start-bot', start);
    const region = cli.slice(start, end);
    expect(region).toContain('classifyStartBotFleetAdmission(');
    expect(region).toContain("admission.state === 'already-online'");
    const alreadyOnline = region.slice(
      region.indexOf("admission.state === 'already-online'"),
      region.indexOf("admission.state === 'fleet-down'"),
    );
    expect(alreadyOnline).toContain("'start-bot-already-online-ready'");
    expect(alreadyOnline).toContain('readAndAssertConfiguredFleetOnline(');
    expect(region).toContain("admission.state === 'fleet-down'");
    expect(region).toContain("'start-bot-after-launch'");
    expect(region).toContain('preflightNodeSanity()');
  });

  it('idempotent start is a supervisor no-op when a live supervisor already owns the fleet', () => {
    // Post-pm2: cmdStart delegates to startFleetViaSupervisor(), which is
    // idempotent by construction — a live supervisor (fleet-state pid + kill-0,
    // under the mutation lock) short-circuits to 'already-running'. No pm2
    // exact-set re-verification dance; the running supervisor keeps reconciling.
    const start = cli.indexOf('async function cmdStart()');
    const end = cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors', start);
    const region = cli.slice(start, end);
    expect(region).toContain('startFleetViaSupervisor()');
    expect(region).toContain("result.action === 'already-running'");
    expect(region).not.toContain('readAndAssertConfiguredFleetOnline(');
    expect(region).not.toContain('assertConfiguredPm2FleetOnline(');
    expect(region).not.toContain('runBoundedPm2StartTransaction(');
  });

  it('discovers legacy Gods from the process table and rechecks duplicate Gods before mutation', () => {
    const start = cli.indexOf('function cleanupLegacyPm2(');
    const end = cli.indexOf('async function cmdStop()', start);
    const legacy = cli.slice(start, end);
    expect(legacy).toContain('listPm2GodDaemonPids(legacyHome)');
    expect(legacy).not.toContain("join(legacyHome, 'pm2.pid')");
    expect(legacy).toContain('assertNoDuplicatePm2GodDaemons(legacyHome)');
    expect(legacy).toContain('preflightNodeSanity(legacyHome)');

    expect(cli).not.toContain("runPm2(['kill']");
  });

  it('the legacy pm2 bootstrap-delete helper stays birth-id bound (used only by legacy cleanup)', () => {
    // The one-time pm2 God bootstrap-delete helper is retained for reaping a
    // pre-migration pm2 God (cleanupLegacyPm2), and must still verify each row's
    // process birth identity before deleting so it never kills a reused pid.
    const bootstrapStart = cli.indexOf('function bootstrapDeleteAllBotmuxProcesses(');
    const bootstrapEnd = cli.indexOf('/**\n * One-time migration', bootstrapStart);
    const bootstrap = cli.slice(bootstrapStart, bootstrapEnd);
    expect(bootstrap).toContain('readSupervisorProcessStartIdentity(entry.pid)');
    expect(bootstrap).toContain('current.pid !== original.pid');
    expect(bootstrap).toMatch(/runPm2\(\s*\['delete', String\(current\.pmId\)\]/);

    // cmdRestart no longer exposes pm2-specific bootstrap / include-pm2 flags —
    // there is no pm2 God to bootstrap or co-restart under the supervisor.
    const restartStart = cli.indexOf('async function cmdRestart()');
    const restartEnd = cli.indexOf('/** Observe botmux PM2 rows', restartStart);
    const restart = cli.slice(restartStart, restartEnd);
    expect(restart).not.toContain("process.argv.includes('--bootstrap-shutdown-protocol')");
    expect(restart).not.toContain("process.argv.includes('--include-pm2')");
    expect(restart).not.toContain('assertIncludePm2RestartAdmission');
    expect(restart).not.toContain('deleteAllBotmuxProcesses()');
  });

  it('attests the whole daemon fleet then uses exact IPC batch/successor requests', () => {
    const start = cli.indexOf('function signalAndAwaitBotmuxProcesses(');
    const end = cli.indexOf('/** Compensate only rows owned', start);
    const helper = cli.slice(start, end);
    const preflight = helper.indexOf('`${operation}-shutdown-capability-preflight`');
    const fleet = helper.indexOf('signalAndAwaitFleet(', preflight);
    const batch = helper.indexOf('requestAttestedDaemonShutdownBatch(', fleet);
    const successor = helper.indexOf('requestAttestedDaemonShutdown(', fleet);
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(fleet).toBeGreaterThan(preflight);
    expect(batch).toBeGreaterThan(fleet);
    expect(successor).toBeGreaterThan(fleet);
    expect(helper).toContain('signalInitial: targets =>');
    expect(helper).toContain('processStartByPid');
    expect(cli).toContain("return isBotmuxCoreProcessName(name) && name !== 'botmux-dashboard'");
  });

  it('keeps supervisor shutdown host-authenticated and exact boot/birth bound', () => {
    const route = ipcServer.slice(
      ipcServer.indexOf("ipcRoute('POST', SUPERVISOR_SHUTDOWN_ROUTE"),
      ipcServer.indexOf('export async function readJsonBody',
        ipcServer.indexOf("ipcRoute('POST', SUPERVISOR_SHUTDOWN_ROUTE")),
    );
    expect(route).toContain('isTrustedHostIpcRequest(req)');
    expect(route).toContain('isExactSupervisorShutdownRequest(registration, body)');
    expect(route).toContain('jsonRes(res, 202');
    expect(route.indexOf('jsonRes(res, 202')).toBeLessThan(route.indexOf('registration.shutdown()'));
  });
});
