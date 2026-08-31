import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';

/**
 * submit_unconfirmed 文案只钉「机器消费」的接缝：
 *   - key 在 zh/en 两份字典都存在；
 *   - worker 传给 t() 的插值参数（{cliName}/{secs}/{transcriptLabel}/{preview}）
 *     在模板里必须仍然存在——参数被抽掉会在渲染时泄漏出裸 {param}；
 *   - 文案不再断言「没有到达模型的证据」（自动确认失败 ≠ 一定没执行）；
 *   - 文案与 worker 传入的 transcriptLabel 不再声称 JSONL 存储（OpenCode 查的是 SQLite）。
 * 不 pin 整段措辞。
 */

const UNCONFIRMED_KEYS = ['worker.submit_unconfirmed', 'worker.submit_unconfirmed_zmx'] as const;

const WORKER_PASSED_PARAMS = ['{cliName}', '{secs}', '{transcriptLabel}', '{preview}'] as const;

const OVERCLAIM_PHRASES = [
  '尚无请求到达模型的证据',
  'no evidence that the request reached the model',
  'There is no evidence that the request reached the model',
] as const;

describe('submit_unconfirmed wording seam', () => {
  it.each(UNCONFIRMED_KEYS)('both locales define %s', (key) => {
    expect(Object.prototype.hasOwnProperty.call(zhMessages, key)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(enMessages, key)).toBe(true);
    expect(zhMessages[key]).toBeTruthy();
    expect(enMessages[key]).toBeTruthy();
  });

  it.each(UNCONFIRMED_KEYS)('%s keeps every interpolation param the worker passes', (key) => {
    const zh = zhMessages[key];
    const en = enMessages[key];
    for (const param of WORKER_PASSED_PARAMS) {
      expect(zh).toContain(param);
      expect(en).toContain(param);
    }
  });

  it.each(UNCONFIRMED_KEYS)('%s no longer overclaims that the model never saw the message', (key) => {
    const zh = zhMessages[key];
    const en = enMessages[key];
    for (const phrase of OVERCLAIM_PHRASES) {
      expect(zh).not.toContain(phrase);
      expect(en).not.toContain(phrase);
    }
  });

  it.each(UNCONFIRMED_KEYS)('%s does not claim JSONL storage', (key) => {
    expect(zhMessages[key]).not.toContain('JSONL');
    expect(zhMessages[key]).not.toContain('jsonl');
    expect(enMessages[key]).not.toContain('JSONL');
    expect(enMessages[key]).not.toContain('jsonl');
  });

  it('worker passes a storage-agnostic transcriptLabel instead of 会话 JSONL', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain("'会话 JSONL'");
  });
});
