import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { hookCommandParts } from './hook-command.js';

const BRIDGE_VERSION = 1;
const BRIDGE_ROOT_DIR = '.botmux/dsh-question-bridge';
const DEFAULT_DSH_TUI_PROFILE = 'dsh-tui';

type DshBridgeCliId = 'dsh' | 'dsh-tui';

export interface DshQuestionBridgePatch {
  readonly patchPath: string;
  readonly readonlyRoot: string;
  readonly pluginPath: string;
}

interface HookCommandParts {
  readonly cmd: string;
  readonly args: readonly string[];
}

export interface EnsureDshQuestionBridgePatchOptions {
  readonly cliId: DshBridgeCliId;
  /** Test/packaging override. Defaults to os.homedir(). */
  readonly homeDir?: string;
  /** Profile directory used only for dsh-tui wrapper original-module resolution. */
  readonly dshTuiProfileDir?: string;
  /** Test override; production uses hookCommandParts(cliId). */
  readonly hookCommand?: HookCommandParts;
  /** Extra salt so different checkout/build identities cannot overwrite each other. */
  readonly buildSalt?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function jsonLiteral(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined').replace(/<\//g, '<\\/');
}

function dshConfigHome(homeDir: string): string {
  const configured = process.env.DSH_HOME?.trim();
  return configured ? resolve(configured) : join(homeDir, '.dsh');
}

function defaultDshTuiProfileDir(homeDir: string): string {
  return join(dshConfigHome(homeDir), 'profiles', DEFAULT_DSH_TUI_PROFILE);
}

function resolvePackageExportEntry(pkg: Record<string, unknown>): string {
  const exportsField = pkg.exports;
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const dot = (exportsField as Record<string, unknown>)['.'];
    if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
      const imp = (dot as Record<string, unknown>).import ?? (dot as Record<string, unknown>).default;
      if (typeof imp === 'string' && imp) return imp;
    }
    if (typeof dot === 'string' && dot) return dot;
  }
  if (typeof pkg.module === 'string' && pkg.module) return pkg.module;
  if (typeof pkg.main === 'string' && pkg.main) return pkg.main;
  return 'lib/types/index.js';
}

export function resolveOriginalDshTuiEntryUrl(
  profileDir: string = defaultDshTuiProfileDir(homedir()),
): string | null {
  try {
    const requireFromProfile = createRequire(join(profileDir, 'package.json'));
    const pkgPath = requireFromProfile.resolve('@deepseek-harness-tui/dsh-tui/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const entry = resolve(dirname(pkgPath), resolvePackageExportEntry(pkg));
    if (!existsSync(entry)) return null;
    return pathToFileURL(entry).href;
  } catch {
    return null;
  }
}

function buildRuntimeBridgeSnippet(parts: HookCommandParts, runtime: DshBridgeCliId): string {
  return `
const CMD = ${jsonLiteral(parts.cmd)};
const ARGS = ${jsonLiteral([...parts.args])};
const RUNTIME = ${jsonLiteral(runtime === 'dsh-tui' ? 'tui' : 'official')};
const MAX_STDOUT_BYTES = 1024 * 1024;

function isBotmuxSessionEnv(env) {
  return !!(env.BOTMUX_SESSION_ID && env.BOTMUX_CHAT_ID && env.BOTMUX_LARK_APP_ID);
}

function bridgeError(code, message) {
  const err = new Error(message);
  err.name = 'UserQuestionError';
  err.code = code;
  return err;
}

function timeoutMs() {
  const raw = process.env.BOTMUX_DSH_ASK_TIMEOUT_MS || process.env.BOTMUX_ASK_TIMEOUT_MS || '3600000';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3600000;
}

function runHook(payload, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let child;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { signal && signal.removeEventListener && signal.removeEventListener('abort', onAbort); } catch {}
      resolve(result);
    };
    const onAbort = () => {
      try { child && child.kill(); } catch {}
      done({ ok: false, reason: 'aborted', detail: 'ask_user_question was aborted' });
    };
    try {
      child = spawn(CMD, ARGS, {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, BOTMUX_ASK_TIMEOUT_MS: String(timeoutMs()) },
      });
    } catch (error) {
      done({ ok: false, reason: 'spawn-error', detail: String(error && error.message || error) });
      return;
    }
    if (signal && signal.aborted) return onAbort();
    try { signal && signal.addEventListener && signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, reason: 'timeout', detail: 'botmux hook timed out' });
    }, timeoutMs() + 5000);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
      if (Buffer.byteLength(out, 'utf8') > MAX_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        done({ ok: false, reason: 'stdout-overflow', detail: 'botmux hook stdout exceeded 1MiB' });
      }
    });
    child.on('error', (error) => done({ ok: false, reason: 'child-error', detail: String(error && error.message || error) }));
    child.on('close', (code) => {
      if (code !== 0) done({ ok: false, reason: 'nonzero-exit', detail: 'botmux hook exited ' + code });
      else if (!out.trim()) done({ ok: false, reason: 'passthrough', detail: 'botmux hook returned empty stdout' });
      else done({ ok: true, text: out.trim() });
    });
    try { child.stdin.end(JSON.stringify(payload)); }
    catch (error) { done({ ok: false, reason: 'stdin-error', detail: String(error && error.message || error) }); }
  });
}

function handleBridgeFailure(result, next) {
  if (RUNTIME === 'tui') return next();
  throw bridgeError('BOTMUX_ASK_BRIDGE_UNAVAILABLE', 'botmux question bridge failed: ' + result.reason + (result.detail ? ' (' + result.detail + ')' : ''));
}

async function bridgeAsk(request, next) {
  const result = await runHook({ hook_event_name: 'user-questions/request', tool_input: request }, request && request.signal);
  if (!result.ok) return handleBridgeFailure(result, next);
  try { return JSON.parse(result.text); }
  catch (error) { return handleBridgeFailure({ reason: 'malformed-answer', detail: String(error && error.message || error) }, next); }
}

function installWaterfallBridge(ctx) {
  if (typeof ctx.on !== 'function') return undefined;
  return ctx.on('user-questions/request', (request, next) => bridgeAsk(request, next), { prepend: true });
}

function installLegacyOfficialProvider(ctx, service) {
  if (service.provider !== undefined) return undefined;
  const dispose = service.registerProvider({ ask: request => bridgeAsk(request, () => Promise.reject(bridgeError('BOTMUX_ASK_BRIDGE_UNAVAILABLE', 'botmux question bridge declined request'))) });
  try { ctx.effect(() => dispose, 'botmux-dsh-question-bridge.legacy-provider'); } catch {}
  return dispose;
}
`;
}

function buildOrdinaryBridgePlugin(parts: HookCommandParts): string {
  return `// botmux generated DSH question bridge v${BRIDGE_VERSION}
import { spawn } from 'node:child_process';
${buildRuntimeBridgeSnippet(parts, 'dsh')}
export const name = 'botmux-dsh-question-bridge';
export function apply(ctx) {
  if (!isBotmuxSessionEnv(process.env) || process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return;
  const service = ctx.get && ctx.get('userQuestions');
  if (service && typeof service.registerProvider === 'function') {
    installLegacyOfficialProvider(ctx, service);
    return;
  }
  installWaterfallBridge(ctx);
}
`;
}

function buildDshTuiWrapperPlugin(parts: HookCommandParts, originalDshTuiUrl: string): string {
  return `// botmux generated dsh-tui question wrapper v${BRIDGE_VERSION}
import { spawn } from 'node:child_process';
import * as original from ${jsonLiteral(originalDshTuiUrl)};
${buildRuntimeBridgeSnippet(parts, 'dsh-tui')}
export const name = original.name;
export const inject = original.inject;
export const Config = original.Config;
function rawService(service) {
  return service && service[Symbol.for('cordis.original')] || service;
}
function originalDshTuiConfig(ctx, wrapperConfig) {
  if (wrapperConfig && Object.keys(wrapperConfig).length > 0) return wrapperConfig;
  try {
    const entry = [...ctx.loader.entries()].find((candidate) => candidate.options && candidate.options.id === 'dsh-tui');
    return entry && entry.options && entry.options.config || {};
  } catch { return {}; }
}
function wrapLegacyProvider(service) {
  const target = rawService(service);
  if (!target || typeof target.registerProvider !== 'function') return () => {};
  const own = Object.getOwnPropertyDescriptor(target, 'registerProvider');
  const originalRegister = target.registerProvider.bind(target);
  let used = false;
  const restore = () => {
    try {
      if (own) Object.defineProperty(target, 'registerProvider', own);
      else delete target.registerProvider;
    } catch {}
  };
  target.registerProvider = (nativeProvider) => {
    if (used) return originalRegister(nativeProvider);
    used = true;
    const composite = {
      ask: async (request) => {
        try { return await bridgeAsk(request, () => nativeProvider.ask(request)); }
        catch (error) { throw error; }
      },
    };
    return originalRegister(composite);
  };
  return restore;
}
export async function apply(ctx, config) {
  if (!isBotmuxSessionEnv(process.env) || process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return original.apply(ctx, config);
  const service = ctx.get && ctx.get('userQuestions');
  const restore = service && typeof service.registerProvider === 'function'
    ? wrapLegacyProvider(service)
    : installWaterfallBridge(ctx);
  const effectiveConfig = originalDshTuiConfig(ctx, config);
  try { return await original.apply(ctx, effectiveConfig); }
  finally { try { restore && restore(); } catch {} }
}
`;
}

function buildOrdinaryBridgePatch(pluginUrl: string, hash: string): string {
  return [
    '- insert:',
    `    - id: botmux-dsh-question-bridge-${hash}`,
    `      name: ${yamlSingleQuoted(pluginUrl)}`,
    '',
  ].join('\n');
}

function buildDshTuiWrapperPatch(pluginUrl: string, hash: string): string {
  return [
    '- id: dsh-tui',
    '  disabled: true',
    '- insert:',
    `    - id: botmux-dsh-tui-wrapper-${hash}`,
    `      name: ${yamlSingleQuoted(pluginUrl)}`,
    '',
  ].join('\n');
}

export function ensureDshQuestionBridgePatch(
  opts: EnsureDshQuestionBridgePatchOptions,
): DshQuestionBridgePatch | null {
  if (process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return null;
  const hook = opts.hookCommand ?? hookCommandParts(opts.cliId);
  const runtime = opts.cliId === 'dsh-tui' ? 'tui' : 'official';
  const originalDshTuiUrl = runtime === 'tui'
    ? resolveOriginalDshTuiEntryUrl(opts.dshTuiProfileDir ?? defaultDshTuiProfileDir(opts.homeDir ?? homedir()))
    : undefined;
  if (runtime === 'tui' && !originalDshTuiUrl) return null;
  const content = runtime === 'tui'
    ? buildDshTuiWrapperPlugin(hook, originalDshTuiUrl!)
    : buildOrdinaryBridgePlugin(hook);
  const salt = opts.buildSalt ?? '';
  const hash = sha256(JSON.stringify({ version: BRIDGE_VERSION, cliId: opts.cliId, hook, originalDshTuiUrl, salt, content })).slice(0, 16);
  const root = join(opts.homeDir ?? homedir(), BRIDGE_ROOT_DIR, hash);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const pluginPath = join(root, runtime === 'tui' ? 'dsh-tui-wrapper.mjs' : 'bridge.mjs');
  const patchPath = join(root, 'cordis.patch.yml');
  atomicWriteFileSync(pluginPath, content, { mode: 0o600 });
  const pluginUrl = pathToFileURL(pluginPath).href;
  const patch = runtime === 'tui'
    ? buildDshTuiWrapperPatch(pluginUrl, hash)
    : buildOrdinaryBridgePatch(pluginUrl, hash);
  atomicWriteFileSync(patchPath, patch, { mode: 0o600 });
  return { patchPath, readonlyRoot: root, pluginPath };
}
