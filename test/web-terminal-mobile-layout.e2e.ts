import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

function waitForReady(
  child: ChildProcess,
  logs: string[],
): Promise<Extract<WorkerToDaemon, { type: 'ready' }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`worker ready timeout\n${logs.join('')}`));
    }, 15_000);
    child.on('message', raw => {
      const message = raw as WorkerToDaemon;
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolvePromise(message);
      } else if (message.type === 'error') {
        clearTimeout(timer);
        rejectPromise(new Error(`worker error: ${message.message}\n${logs.join('')}`));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`worker exited before ready (${code ?? signal})\n${logs.join('')}`));
    });
  });
}

describe('mobile web terminal real geometry', () => {
  let root = '';
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-mobile-layout-'));
    const dataDir = join(root, 'session');
    const configDir = join(root, '.botmux');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.dashboard-secret'), 'mobile-layout-secret', { mode: 0o600 });

    const fakeCli = join(root, 'fake-claude');
    writeFileSync(fakeCli, `#!/usr/bin/env node
for (let i = 1; i <= 80; i++) process.stdout.write('terminal line ' + i + '\\r\\n');
process.stdout.write('PROMPT> type here');
process.stdin.setRawMode?.(true);
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const logs: string[] = [];
    const sessionId = `mobile-layout-${Date.now()}`;
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH: join(root, 'control.ndjson'),
        LARK_APP_ID: 'app_mobile_layout',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_mobile_layout',
      rootMessageId: 'om_mobile_layout',
      workingDir: dataDir,
      cliId: 'claude-code',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_mobile_layout',
      larkAppSecret: 'secret',
    };
    child.send(init);
    const ready = await waitForReady(child, logs);

    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
    });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => {
      const barHeight = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--mobile-bar-h'),
      );
      return Boolean(document.querySelector('.xterm-screen') && barHeight > 0 && window.term?.rows > 0);
    });
    await page.waitForTimeout(600);
  }, 60_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('fits the rendered xterm screen entirely above the mobile input bar', async () => {
    const geometry = await page!.evaluate(() => {
      const screen = document.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
      const bar = document.getElementById('mobile-input-bar')!.getBoundingClientRect();
      const sampleY = Math.min(screen.bottom - 7, innerHeight - 11);
      const hit = document.elementFromPoint(innerWidth / 2, sampleY);
      return {
        rows: window.term.rows,
        overlap: screen.bottom - bar.top,
        hitInsideBar: Boolean(hit?.closest('#mobile-input-bar')),
      };
    });

    expect(geometry.rows).toBeGreaterThan(0);
    expect(geometry.overlap).toBeLessThanOrEqual(0.5);
    expect(geometry.hitInsideBar).toBe(false);
  });

  it('keeps a wide empty composer aligned with its mode and send buttons', async () => {
    const geometry = await page!.evaluate(() => {
      const rect = (id: string) => {
        const value = document.getElementById(id)!.getBoundingClientRect();
        return { top: value.top, bottom: value.bottom, width: value.width, height: value.height };
      };
      const row = document.getElementById('mobile-bar-row')!;
      return {
        directChildren: Array.from(row.children).map(element => element.id),
        shortcutIds: Array.from(document.querySelectorAll('#mobile-bar-keys button')).map(element => element.id),
        mode: rect('mobile-mode'),
        input: rect('mobile-input'),
        send: rect('mobile-send'),
        placeholder: (document.getElementById('mobile-input') as HTMLTextAreaElement).placeholder,
      };
    });

    expect(geometry.directChildren).toEqual(['mobile-mode', 'mobile-input-wrap', 'mobile-send']);
    expect(geometry.shortcutIds).toEqual(expect.arrayContaining(['mobile-up', 'mobile-bs', 'mobile-down']));
    expect(geometry.placeholder).toBe('输入命令…');
    expect(geometry.input.width).toBeGreaterThanOrEqual(240);
    expect(Math.abs(geometry.input.top - geometry.mode.top)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(geometry.input.top - geometry.send.top)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(geometry.input.bottom - geometry.mode.bottom)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(geometry.input.bottom - geometry.send.bottom)).toBeLessThanOrEqual(0.5);
    expect(geometry.input.height).toBe(42);
  });

  // ── 焦点归属 + 修饰键转发（真实浏览器）─────────────────────────────────────
  // 上面两条是几何；下面两条是这次回归的行为面：点一下终端之后按键还能不能到
  // 终端。鼠标点击必须把焦点留在 xterm，触摸点一下才把焦点交给底栏 textarea，
  // 但两种情况都要在 WS 上看到同一个 {"type":"input","data":"\u0001"}。
  //
  // 合成 KeyboardEvent 带不出 keyCode（xterm 的映射按 keyCode 分支），所以走
  // xterm 那条路时显式补一个 65；走底栏那条路时页面读的是 e.key，不需要补。
  const activeElementInfo = (): Promise<{ id: string; className: string }> =>
    page!.evaluate(() => {
      const active: Element | null = document.activeElement;
      return { id: active?.id ?? '', className: active?.className?.toString() ?? '' };
    });
  const pressComposerCtrlA = async (): Promise<void> => {
    await page!.evaluate(() => {
      document.getElementById('mobile-input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
  };
  const armFrameRecorder = async (): Promise<void> => {
    await page!.evaluate(() => {
      const store = window as unknown as { ws_: { send(data: string): void }; __frames?: string[] };
      if (!store.__frames) {
        store.__frames = [];
        const original = store.ws_.send.bind(store.ws_);
        store.ws_.send = (data: string): void => {
          (store.__frames as string[]).push(data);
          return original(data);
        };
      }
      store.__frames.length = 0;
    });
  };
  const recordedFrames = (): Promise<string[]> =>
    page!.evaluate(() => (window as unknown as { __frames?: string[] }).__frames ?? []);

  it('鼠标点击终端不抢走 xterm 焦点，紧接着的 Ctrl+A 仍然到达终端', async () => {
    await page!.waitForFunction(
      () => !(document.getElementById('mobile-input') as HTMLTextAreaElement).disabled,
    );
    await armFrameRecorder();

    const screen = (await page!.locator('.xterm-screen').boundingBox())!;
    await page!.mouse.click(screen.x + 24, screen.y + 12);

    // 回归点：旧监听对任何 click 都 showKeyboard()，这里会变成 mobile-input。
    const active = await activeElementInfo();
    expect(active.id, JSON.stringify(active)).not.toBe('mobile-input');
    expect(active.className, JSON.stringify(active)).toContain('xterm');

    await page!.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { get: () => 65 });
      (document.activeElement ?? document.body).dispatchEvent(event);
    });

    expect(await recordedFrames()).toContain(JSON.stringify({ type: 'input', data: '\x01' }));
  });

  it('触摸点一下终端把焦点交给底栏，空框 Ctrl+A 由底栏转发同样到达终端', async () => {
    const screen = (await page!.locator('.xterm-screen').boundingBox())!;
    await page!.touchscreen.tap(screen.x + 24, screen.y + 12);
    await page!.waitForFunction(() => document.activeElement?.id === 'mobile-input');

    // 空框（无草稿）才是终端语义：Ctrl+A → \x01。
    await armFrameRecorder();
    await page!.evaluate(() => { (document.getElementById('mobile-input') as HTMLTextAreaElement).value = ''; });
    await pressComposerCtrlA();
    expect(await recordedFrames()).toContain(JSON.stringify({ type: 'input', data: '\x01' }));

    // 有草稿时同一个键留在输入框（全选），一条字节都不许发。
    await armFrameRecorder();
    await page!.evaluate(() => { (document.getElementById('mobile-input') as HTMLTextAreaElement).value = 'ls -la'; });
    await pressComposerCtrlA();
    expect(await recordedFrames()).toEqual([]);
  });
});
