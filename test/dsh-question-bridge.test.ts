import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

function makeDshTuiProfile(root: string): string {
  const profile = join(root, 'profile');
  const pkgRoot = join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  mkdirSync(join(pkgRoot, 'lib', 'types'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'profile' }) + '\n');
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-harness-tui/dsh-tui',
    type: 'module',
    exports: { '.': { import: './lib/types/index.js' } },
  }) + '\n');
  writeFileSync(join(pkgRoot, 'lib', 'types', 'index.js'), 'export const name="dsh-tui";\nexport const inject=[];\nexport function apply(){}\n');
  return profile;
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
});
