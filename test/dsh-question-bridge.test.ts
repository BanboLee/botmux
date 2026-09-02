import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { ensureDshQuestionBridgePatch, resolveOriginalDshTuiEntryUrl } from '../src/adapters/dsh-question-bridge.js';

const tempDirs = new Set<string>();

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-dsh-bridge-test-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  delete process.env.BOTMUX_DSH_ASK_BRIDGE;
  delete process.env.DSH_HOME;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeDshTuiProfile(root: string, originalSource?: string): string {
  const profile = join(root, 'profile');
  const pkgRoot = join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  mkdirSync(join(pkgRoot, 'lib', 'types'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'profile' }) + '\n');
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-harness-tui/dsh-tui',
    type: 'module',
    exports: { '.': { import: './lib/types/index.js' } },
  }) + '\n');
  writeFileSync(join(pkgRoot, 'lib', 'types', 'index.js'), originalSource ?? 'export const name="dsh-tui";\nexport const inject=[];\nexport function apply(){}\n');
  return profile;
}

function makeHookScript(root: string, body: string): string {
  const file = join(root, 'hook.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe('DSH question bridge file generation', () => {
  it('honors BOTMUX_DSH_ASK_BRIDGE=0 kill switch', () => {
    process.env.BOTMUX_DSH_ASK_BRIDGE = '0';
    const home = tmp();
    expect(ensureDshQuestionBridgePatch({
      cliId: 'dsh',
      homeDir: home,
      hookCommand: { cmd: '/bin/botmux-current', args: ['hook', 'dsh'] },
    })).toBeNull();
  });

  it('writes an ordinary dsh bridge patch with argv hook command', () => {
    const home = tmp();
    const result = ensureDshQuestionBridgePatch({
      cliId: 'dsh',
      homeDir: home,
      hookCommand: { cmd: '/opt/current botmux/bin/node', args: ['/repo/dist/cli.js', 'hook', 'dsh'] },
      buildSalt: 'checkout-a',
    });
    expect(result).not.toBeNull();
    expect(existsSync(result!.pluginPath)).toBe(true);
    expect(existsSync(result!.patchPath)).toBe(true);
    expect(statSync(result!.pluginPath).mode & 0o777).toBe(0o600);
    expect(statSync(result!.patchPath).mode & 0o777).toBe(0o600);

    const plugin = readFileSync(result!.pluginPath, 'utf8');
    expect(plugin).toContain('const CMD = "/opt/current botmux/bin/node"');
    expect(plugin).toContain('"/repo/dist/cli.js","hook","dsh"');
    expect(plugin).toContain("const RUNTIME = \"official\"");
    expect(plugin).not.toContain('split(');

    const patch = readFileSync(result!.patchPath, 'utf8');
    expect(patch).toContain('- insert:');
    expect(patch).toContain('botmux-dsh-question-bridge-');
    expect(patch).toContain('file://');
    expect(patch).toContain('inject:\n        - userQuestions');
    expect(patch).not.toContain('id: dsh-tui');
  });

  it('writes a dsh-tui wrapper patch that disables the original row and preserves config lookup', () => {
    const home = tmp();
    const profile = makeDshTuiProfile(home);
    const result = ensureDshQuestionBridgePatch({
      cliId: 'dsh-tui',
      homeDir: home,
      dshTuiProfileDir: profile,
      hookCommand: { cmd: '/bin/current-botmux', args: ['hook', 'dsh-tui'] },
      buildSalt: 'checkout-b',
    });
    expect(result).not.toBeNull();
    const patch = readFileSync(result!.patchPath, 'utf8');
    expect(patch).toContain('- id: dsh-tui\n  disabled: true');
    expect(patch).toContain('botmux-dsh-tui-wrapper-');
    expect(patch).toContain('dsh-tui-wrapper.mjs');
    expect(patch).toContain('inject:\n        - agents\n        - userQuestions');

    const plugin = readFileSync(result!.pluginPath, 'utf8');
    expect(plugin).toContain('file://');
    expect(plugin).toContain('originalDshTuiConfig');
    expect(plugin).toContain("candidate.options.id === 'dsh-tui'");
    expect(plugin).toContain('wrapLegacyProvider');
    expect(plugin).toContain('const RUNTIME = "tui"');
    expect(plugin).toContain('"hook","dsh-tui"');
  });

  it('returns null for dsh-tui when original package cannot be resolved', () => {
    const home = tmp();
    const profile = join(home, 'missing-profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'missing' }) + '\n');
    expect(ensureDshQuestionBridgePatch({
      cliId: 'dsh-tui',
      homeDir: home,
      dshTuiProfileDir: profile,
      hookCommand: { cmd: '/bin/current-botmux', args: ['hook', 'dsh-tui'] },
    })).toBeNull();
  });

  it('resolves the original dsh-tui entry from a profile package context', () => {
    const home = tmp();
    const profile = makeDshTuiProfile(home);
    const url = resolveOriginalDshTuiEntryUrl(profile);
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain('/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/index.js');
  });

  it('generated ordinary bridge registers a legacy provider when the seat is empty', async () => {
    const home = tmp();
    const hook = makeHookScript(home, `
let input = '';
process.stdin.on('data', d => { input += d.toString('utf8'); });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ answers: [{ id: 'q', selected: ['Yes'] }] })));
`);
    process.env.BOTMUX_SESSION_ID = 's';
    process.env.BOTMUX_CHAT_ID = 'c';
    process.env.BOTMUX_LARK_APP_ID = 'app';
    const result = ensureDshQuestionBridgePatch({
      cliId: 'dsh',
      homeDir: home,
      hookCommand: { cmd: process.execPath, args: [hook] },
      buildSalt: 'legacy-official',
    })!;
    const mod = await import(`${pathToFileURL(result.pluginPath).href}?case=${Date.now()}`);
    const service: any = {
      provider: undefined,
      registerProvider(provider: any) { this.provider = provider; return () => { this.provider = undefined; }; },
    };
    mod.apply({ get: (name: string) => name === 'userQuestions' ? service : undefined, effect: () => undefined });
    const answer = await service.provider.ask({ questions: [{ id: 'q', question: 'Q?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
    expect(answer).toEqual({ answers: [{ id: 'q', selected: ['Yes'] }] });
    delete process.env.BOTMUX_SESSION_ID;
    delete process.env.BOTMUX_CHAT_ID;
    delete process.env.BOTMUX_LARK_APP_ID;
  });

  it('generated ordinary bridge does not take an occupied legacy provider seat', async () => {
    const home = tmp();
    const result = ensureDshQuestionBridgePatch({
      cliId: 'dsh',
      homeDir: home,
      hookCommand: { cmd: '/bin/current-botmux', args: ['hook', 'dsh'] },
      buildSalt: 'legacy-occupied',
    })!;
    process.env.BOTMUX_SESSION_ID = 's';
    process.env.BOTMUX_CHAT_ID = 'c';
    process.env.BOTMUX_LARK_APP_ID = 'app';
    const mod = await import(`${pathToFileURL(result.pluginPath).href}?case=${Date.now()}`);
    const existing = { ask: async () => ({ answers: [] }) };
    const service: any = {
      provider: existing,
      registerProvider() { throw Object.assign(new Error('duplicate'), { code: 'DUPLICATE_PROVIDER' }); },
    };
    mod.apply({ get: (name: string) => name === 'userQuestions' ? service : undefined, effect: () => undefined });
    expect(service.provider).toBe(existing);
    delete process.env.BOTMUX_SESSION_ID;
    delete process.env.BOTMUX_CHAT_ID;
    delete process.env.BOTMUX_LARK_APP_ID;
  });

  it('generated ordinary bridge claims waterfall requests through the hook command', async () => {
    const home = tmp();
    const hook = makeHookScript(home, `
let input = '';
process.stdin.on('data', d => { input += d.toString('utf8'); });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  process.stdout.write(JSON.stringify({ answers: [{ id: payload.tool_input.questions[0].id, selected: ['Yes'] }] }));
});
`);
    process.env.BOTMUX_SESSION_ID = 's';
    process.env.BOTMUX_CHAT_ID = 'c';
    process.env.BOTMUX_LARK_APP_ID = 'app';
    const result = ensureDshQuestionBridgePatch({
      cliId: 'dsh',
      homeDir: home,
      hookCommand: { cmd: process.execPath, args: [hook] },
      buildSalt: 'waterfall',
    })!;
    const mod = await import(`${pathToFileURL(result.pluginPath).href}?case=${Date.now()}`);
    let listener: ((request: any, next: () => Promise<any>) => Promise<any>) | undefined;
    mod.apply({
      get: () => undefined,
      on: (_name: string, fn: typeof listener) => { listener = fn; return () => true; },
    });
    const answer = await listener!({ questions: [{ id: 'q', question: 'Q?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, async () => ({ answers: [] }));
    expect(answer).toEqual({ answers: [{ id: 'q', selected: ['Yes'] }] });
    delete process.env.BOTMUX_SESSION_ID;
    delete process.env.BOTMUX_CHAT_ID;
    delete process.env.BOTMUX_LARK_APP_ID;
  });

  it('generated dsh-tui wrapper uses native provider fallback on hook passthrough', async () => {
    const home = tmp();
    const originalSource = `
export const name = 'dsh-tui';
export const inject = ['agents'];
export const Config = { marker: true };
export async function apply(ctx, config) {
  globalThis.__botmuxWrapperConfig = config;
  ctx.userQuestions.registerProvider({ ask: async (request) => ({ answers: [{ id: request.questions[0].id, selected: ['Native'] }] }) });
}
`;
    const profile = makeDshTuiProfile(home, originalSource);
    const hook = makeHookScript(home, `process.stdin.resume(); process.stdin.on('end', () => {});`);
    process.env.BOTMUX_SESSION_ID = 's';
    process.env.BOTMUX_CHAT_ID = 'c';
    process.env.BOTMUX_LARK_APP_ID = 'app';
    const result = ensureDshQuestionBridgePatch({
      cliId: 'dsh-tui',
      homeDir: home,
      dshTuiProfileDir: profile,
      hookCommand: { cmd: process.execPath, args: [hook] },
      buildSalt: 'wrapper-fallback',
    })!;
    const mod = await import(`${pathToFileURL(result.pluginPath).href}?case=${Date.now()}`);
    const service: any = {
      provider: undefined,
      registerProvider(provider: any) { this.provider = provider; return () => { this.provider = undefined; }; },
    };
    const originalEntryConfig = { provider: 'deepseek-official', fullscreen: true };
    const ctx: any = {
      userQuestions: service,
      get: (name: string) => name === 'userQuestions' ? service : undefined,
      effect: () => undefined,
      loader: { entries: function* () { yield { options: { id: 'dsh-tui', config: originalEntryConfig } }; } },
    };
    await mod.apply(ctx, {});
    const answer = await service.provider.ask({ questions: [{ id: 'q', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] });
    expect(answer).toEqual({ answers: [{ id: 'q', selected: ['Native'] }] });
    expect((globalThis as any).__botmuxWrapperConfig).toBe(originalEntryConfig);
    delete (globalThis as any).__botmuxWrapperConfig;
    delete process.env.BOTMUX_SESSION_ID;
    delete process.env.BOTMUX_CHAT_ID;
    delete process.env.BOTMUX_LARK_APP_ID;
  });
});
