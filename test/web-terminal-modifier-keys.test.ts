import { describe, expect, it } from 'vitest';
import { modifierKeySequence, modifierKeySequenceSource } from '../src/utils/web-terminal-modifier-keys.js';
import type { ModifierKeyEvent } from '../src/utils/web-terminal-modifier-keys.js';

// 「底栏输入框里的修饰键 → 终端字节序列」映射表。
//
// 这张表同时驱动两份运行时（见最后一组用例）：源码里的实现，和真正嵌进终端页
// 的那份 onType.toString() —— 页面代码住在 worker.ts 的模板字符串里，import 不
// 进去，所以只能一份实现两处跑；表跑两遍才证明它们没有分叉。
//
// 值对齐 xterm.js 5.5.0 evaluateKeyboardEvent：
//   case 'default' 的 `!ctrl||shift||alt||meta` 分支 → Ctrl+字母/`_`/`@`；
//   纯 Ctrl 分支 → keyCode 65..90 → 0x01..0x1a、32 → 0x00、51..55 → 0x1b..0x1f、
//   219..221 → ESC/FS/GS；case 37..40 → CSI 1;N{D,C,A,B}（N = 1 + 修饰位）。

const ESC = String.fromCharCode(27);

type Key = ModifierKeyEvent;

const ctrl = (key: string, extra: Key = {}): Key => ({ key, ctrlKey: true, ...extra });
const alt = (key: string, extra: Key = {}): Key => ({ key, altKey: true, ...extra });

interface Case {
  name: string;
  event: Key;
  hasDraft?: boolean;
  composing?: boolean;
  expected: string | null;
}

const CASES: Case[] = [];

// ── Ctrl+a..z → 0x01..0x1a ──────────────────────────────────────────────────
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(97 + i);
  const value = String.fromCharCode(i + 1);
  CASES.push({
    name: `Ctrl+${letter} → 0x${(i + 1).toString(16).padStart(2, '0')}`,
    event: ctrl(letter),
    expected: value,
  });
  // CapsLock（key 是大写、shiftKey 为假）走的是同一个字节：xterm 看的是物理
  // keyCode 65..90，大小写不参与判定。
  CASES.push({
    name: `Ctrl+${letter.toUpperCase()}(CapsLock) → 0x${(i + 1).toString(16).padStart(2, '0')}`,
    event: ctrl(letter.toUpperCase()),
    expected: value,
  });
}

// ── Ctrl+Space / Ctrl+标点 ──────────────────────────────────────────────────
CASES.push(
  { name: 'Ctrl+Space → 0x00 (NUL)', event: ctrl(' '), expected: String.fromCharCode(0) },
  { name: 'Ctrl+Space+Shift 不转发', event: ctrl(' ', { shiftKey: true }), expected: null },
  { name: 'Ctrl+[ → 0x1b (ESC)', event: ctrl('['), expected: String.fromCharCode(27) },
  { name: 'Ctrl+\\ → 0x1c (FS)', event: ctrl('\\'), expected: String.fromCharCode(28) },
  { name: 'Ctrl+] → 0x1d (GS)', event: ctrl(']'), expected: String.fromCharCode(29) },
  // ^ 与 _ 在 US 布局上要按着 Shift 才打得出来，字符本身就是映射的输入：
  // 这两个必须忽略 shiftKey，否则 Ctrl+^ 永远到不了 0x1e。
  { name: 'Ctrl+^ → 0x1e (RS)', event: ctrl('^'), expected: String.fromCharCode(30) },
  { name: 'Ctrl+Shift+6(^) → 0x1e (RS)', event: ctrl('^', { shiftKey: true }), expected: String.fromCharCode(30) },
  { name: 'Ctrl+_ → 0x1f (US)', event: ctrl('_'), expected: String.fromCharCode(31) },
  { name: 'Ctrl+Shift+-( _ ) → 0x1f (US)', event: ctrl('_', { shiftKey: true }), expected: String.fromCharCode(31) },
  { name: 'Ctrl+Shift+[ ({) 不转发', event: ctrl('{', { shiftKey: true }), expected: null },
  // xterm 对 Ctrl+Shift+字母 什么都不发；这里同样留给输入框（Ctrl+Shift+Z 是重做）。
  { name: 'Ctrl+Shift+A 不转发', event: ctrl('a', { shiftKey: true }), expected: null },
);

// ── Alt+可打印字符 → ESC + 字符 ─────────────────────────────────────────────
CASES.push(
  { name: 'Alt+a → ESC a', event: alt('a'), expected: ESC + 'a' },
  { name: 'Alt+A（Shift）→ ESC A', event: alt('A', { shiftKey: true }), expected: ESC + 'A' },
  { name: 'Alt+1 → ESC 1', event: alt('1'), expected: ESC + '1' },
  { name: 'Alt+. → ESC .', event: alt('.'), expected: ESC + '.' },
  { name: 'Alt+Space → ESC 空格', event: alt(' '), expected: ESC + ' ' },
  { name: 'Alt+箭头上（未覆盖）不转发', event: alt('ArrowUp'), expected: null },
  { name: 'Alt+非 ASCII（é）不转发', event: alt('é'), expected: null },
  { name: 'Alt+Dead 键不转发', event: alt('Dead'), expected: null },
);

// ── Ctrl/Alt + 方向键 → CSI 1;N{D,C,A,B} ───────────────────────────────────
CASES.push(
  { name: 'Ctrl+Left → CSI 1;5D', event: ctrl('ArrowLeft'), expected: ESC + '[1;5D' },
  { name: 'Ctrl+Right → CSI 1;5C', event: ctrl('ArrowRight'), expected: ESC + '[1;5C' },
  { name: 'Ctrl+Up → CSI 1;5A', event: ctrl('ArrowUp'), expected: ESC + '[1;5A' },
  { name: 'Ctrl+Down → CSI 1;5B', event: ctrl('ArrowDown'), expected: ESC + '[1;5B' },
  { name: 'Ctrl+Shift+Left → CSI 1;6D', event: ctrl('ArrowLeft', { shiftKey: true }), expected: ESC + '[1;6D' },
  { name: '裸方向键不转发（走页面既有分支）', event: { key: 'ArrowLeft' }, expected: null },
);

// ── 守卫 ────────────────────────────────────────────────────────────────────
CASES.push(
  { name: 'Meta+A（⌘A）不转发', event: { key: 'a', metaKey: true }, expected: null },
  { name: 'Ctrl+Meta+A 不转发', event: { key: 'a', ctrlKey: true, metaKey: true }, expected: null },
  { name: 'Meta+Left 不转发', event: { key: 'ArrowLeft', metaKey: true }, expected: null },
  { name: 'Ctrl+Alt+a（Windows AltGr）不转发', event: { key: 'a', ctrlKey: true, altKey: true }, expected: null },
  { name: 'Ctrl+Alt+@（AltGr 字符层）不转发', event: { key: '@', ctrlKey: true, altKey: true }, expected: null },
  { name: '组合态（isComposing）不转发', event: ctrl('a', { isComposing: true }), expected: null },
  { name: '组合态（mirror.composing）不转发', event: ctrl('a'), composing: true, expected: null },
  { name: '组合态里 Tab 之类也不经此路', event: ctrl('Tab'), composing: true, expected: null },
  // 草稿非空时 Ctrl+A/C/V/X/Z 留给输入框（全选/复制/粘贴/剪切/撤销），与「空框
  // Backspace 才转发 ⌫」同一条哲学；其余修饰键不受草稿影响。
  { name: '草稿非空：Ctrl+A 留给输入框', event: ctrl('a'), hasDraft: true, expected: null },
  { name: '草稿非空：Ctrl+C 留给输入框', event: ctrl('c'), hasDraft: true, expected: null },
  { name: '草稿非空：Ctrl+V 留给输入框', event: ctrl('v'), hasDraft: true, expected: null },
  { name: '草稿非空：Ctrl+X 留给输入框', event: ctrl('x'), hasDraft: true, expected: null },
  { name: '草稿非空：Ctrl+Z 留给输入框', event: ctrl('z'), hasDraft: true, expected: null },
  { name: '草稿非空：Ctrl+B 仍转发 0x02', event: ctrl('b'), hasDraft: true, expected: String.fromCharCode(2) },
  { name: '草稿非空：Ctrl+[ 仍转发 ESC', event: ctrl('['), hasDraft: true, expected: ESC },
  { name: '草稿非空：Alt+a 仍转发', event: alt('a'), hasDraft: true, expected: ESC + 'a' },
  // 无修饰键一律不碰：Tab/Esc/方向键/Enter 各有既有分支。
  { name: '裸 a 不转发', event: { key: 'a' }, expected: null },
  { name: '裸 Tab 不转发', event: { key: 'Tab' }, expected: null },
  { name: '裸 Escape 不转发', event: { key: 'Escape' }, expected: null },
  { name: 'Ctrl+Tab 不转发（浏览器保留）', event: ctrl('Tab'), expected: null },
  { name: '空事件不转发', event: {}, expected: null },
);

function runTable(impl: typeof modifierKeySequence, label: string): void {
  for (const item of CASES) {
    const actual = impl(item.event, { hasDraft: item.hasDraft, composing: item.composing });
    expect(actual, `${label}: ${item.name}`).toBe(item.expected);
  }
}

describe('底栏修饰键映射（纯函数）', () => {
  it('覆盖整张映射表与守卫', () => {
    runTable(modifierKeySequence, '源码');
  });
});

// 页面侧那份是「同一份源码的原样内嵌」：把导出源码当成一段 JS 表达式求值，再跑
// 同一张表。这样既证明它自给自足（不引用任何外部标识符），也证明两处不会分叉。
describe('嵌进终端页的那份源码', () => {
  const injected = new Function(`return (${modifierKeySequenceSource});`)() as typeof modifierKeySequence;

  it('源码可独立求值，且与源码实现逐条一致', () => {
    expect(typeof injected).toBe('function');
    runTable(injected, '内嵌');
  });

  it('不含反引号 / 美元花括号插值（会截断 worker.ts 的模板字符串）', () => {
    expect(modifierKeySequenceSource).not.toContain('`');
    expect(modifierKeySequenceSource).not.toContain('$' + '{');
  });

  // 「一份实现、两处运行」的机制断言：worker.ts 是把这段源码**原样拼进模板字面量**的，
  // 所以这里也把它原样包进模板字面量再求值，要求结果与源码逐字相同。
  // 挡的是「注入破坏源码」这一整类事故，而不是某个字符：反引号会提前结束模板；美元
  // 花括号会被当成插值（求值成别的字符串，或直接 ReferenceError）；反斜杠会被当转义
  // 序列消费 —— 后跟空格时凭空少一个字符，后跟 x / u / 数字这类非法转义时更会让整份
  // worker.js 解析失败、终端页所有脚本一起失效（#884 记过的那类事故）。
  it('原样包进模板字面量后逐字无损（注入不会破坏这段源码）', () => {
    const embedded = new Function('return `' + modifierKeySequenceSource + '`;')();
    expect(embedded).toBe(modifierKeySequenceSource);
  });
});
