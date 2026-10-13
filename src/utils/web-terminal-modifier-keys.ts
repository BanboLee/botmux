/**
 * 底栏输入框（#mobile-input）里的「修饰键 → 终端字节序列」映射。
 *
 * 为什么需要它：xterm 只监听它自己的 textarea。焦点一旦在底栏这个 textarea 上，
 * xterm 整套键盘映射（evaluateKeyboardEvent）根本不会跑，而页面原有的转发分支只
 * 覆盖 Tab/Esc/方向键/空框 Backspace/Enter —— 于是一个 Ctrl+A 到了底栏就只剩
 * 「选中 textarea 里的空白」，终端一个字节都收不到。
 *
 * 映射逐值对齐 xterm.js 5.5.0 evaluateKeyboardEvent（可对照 lib/xterm.js）：
 *   • Ctrl+a..z        → 0x01..0x1a（xterm 看物理 keyCode 65..90，与大小写无关）
 *   • Ctrl+Space       → 0x00
 *   • Ctrl+[ \ ] ^ _   → 0x1b 0x1c 0x1d 0x1e 0x1f
 *   • Alt+可打印 ASCII → ESC + 该字符
 *   • Ctrl+箭头        → CSI 1;N{D,C,A,B}，N = 1 + shift + 2*alt + 4*ctrl
 *
 * 有意不做的三件事：
 *   • ⌘/Meta 一律不转发：macOS 用户对 ⌘A 的预期是全选，xterm 自己也只把它当本地
 *     全选（evaluateKeyboardEvent 里 metaKey 走 o.type=1 那条）。
 *   • Ctrl+Alt 同按不转发：Windows 上那是 AltGr（第三个字符层），不是组合键。
 *   • Alt+方向键不转发：xterm 对它是分平台映射（非 mac 把 Alt+箭头整体别名成
 *     [1;5X；mac 的 ←/→ 变 ESC b / ESC f），公式直算出来的 [1;3X 在 readline 里
 *     没有绑定，转发等于按键蒸发；要对齐得把 isMac 也引进来，收益不值。
 *   （Ctrl+@、Ctrl+3..7 这类 xterm 的旧 keyCode 映射同样不在覆盖范围内。）
 *
 * 草稿守卫：输入框非空时 Ctrl+A/C/V/X/Z 留给 textarea 自己（全选/复制/粘贴/剪切/
 * 撤销），与既有「空框 Backspace 才转发 ⌫」同一条哲学 —— 有草稿时这些键有本地
 * 语义，没草稿时它们才只能属于终端。其余修饰键不受草稿影响。
 *
 * 一份实现、两处运行：函数体必须**自给自足**（不引用任何外部标识符、不含反引号、
 * 不含美元花括号插值序列、不含任何一个反斜杠），因为终端页把
 * {@link modifierKeySequenceSource} 原样嵌进 worker.ts 的模板字符串 —— 单测跑这一份，
 * 页面跑的也是这一份。模板字面量会消费转义序列：反斜杠后跟空格会被吃成空格（注释里
 * 凭空少一个字符），反斜杠后跟 x / u / 数字这类非法转义则会让整份 worker.js 直接解析
 * 失败、终端页所有脚本一起失效（#884 记过的那类事故）。所以这条是硬约束不是风格偏好，
 * 单测用「原样包进模板字面量求值，结果必须与源码逐字相同」在机制上守住它。
 */

export interface ModifierKeyEvent {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

export interface ModifierKeyContext {
  /** 底栏输入框里有未上屏的草稿。 */
  readonly hasDraft?: boolean;
  /** 页面侧的 IME 组合态（mirror.composing）。 */
  readonly composing?: boolean;
}

export function modifierKeySequence(e: ModifierKeyEvent, ctx?: ModifierKeyContext): string | null {
  if (!e || e.metaKey) return null;
  if (e.isComposing || (ctx && ctx.composing)) return null;
  var ctrl = e.ctrlKey === true;
  var alt = e.altKey === true;
  if (!ctrl && !alt) return null;
  if (ctrl && alt) return null;
  var key = typeof e.key === 'string' ? e.key : '';
  if (!key) return null;
  var shifted = e.shiftKey === true;
  var code = key.length === 1 ? key.charCodeAt(0) : 0;
  if (ctrl) {
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      var n = 1 + (shifted ? 1 : 0) + 4;
      var final = key === 'ArrowLeft' ? 'D' : key === 'ArrowRight' ? 'C' : key === 'ArrowUp' ? 'A' : 'B';
      return String.fromCharCode(27) + '[1;' + n + final;
    }
    // CapsLock 下 key 是大写字母：按字符折成小写后映射，与 xterm 的 keyCode 判定一致。
    var lower = key.length === 1 ? key.toLowerCase() : '';
    if (!shifted && lower >= 'a' && lower <= 'z') {
      if (ctx && ctx.hasDraft && 'acvxz'.indexOf(lower) >= 0) return null;
      return String.fromCharCode(lower.charCodeAt(0) - 96);
    }
    if (!shifted && code === 32) return String.fromCharCode(0);
    // 91..95 恰好是 方括号 / 反斜杠 / 右方括号 / 脱字符 / 下划线 五个字符（^ 与 _
    // 本来就按着 Shift，所以不判 shift）。
    if (code >= 91 && code <= 95) return String.fromCharCode(code - 64);
    return null;
  }
  if (code >= 32 && code <= 126) return String.fromCharCode(27) + key;
  return null;
}

/** 终端页里那份内嵌映射的源码（见文件头：一份实现，两处运行）。 */
export const modifierKeySequenceSource = modifierKeySequence.toString();
