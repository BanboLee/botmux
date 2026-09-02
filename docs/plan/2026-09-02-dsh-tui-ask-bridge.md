# dsh / dsh-tui ask_user_question 飞书桥接实现计划

> 状态：计划已通过第二轮双 subagent review，并已获用户批准；进入实现阶段。  
> 分支基线：`master`，已 fast-forward 到 `origin/master @ f5fa07bff21174d0678b688cda8784018d538de9`。  
> 约束：在用户 review 明确通过前，**不得修改任何实现代码**；本文只描述后续实施计划。

## 0. 背景与当前事实

当前 master 已包含重要前置：`feat(dsh): 改用标准 DSH profile 机制，支持 Dashboard 选 profile 与独立 workspace`。

现状事实：

- `src/adapters/cli/dsh.ts` 已支持 `dshProfile`，`dsh-runner.ts` 启动 `dsh --profile <name>`。
- `src/dsh-runner.ts` 会自动创建默认 `~/.dsh/profiles/botmux` profile 骨架，但当前没有 question bridge。
- `src/adapters/cli/dsh-tui.ts` 仍是 PTY 驱动 `dsh-tui`，没有 `hookInstall`、没有 `asksViaHook`、没有 `user-questions/request` bridge。
- DSH/dsh-tui 的结构化提问 seam 是 `ctx.userQuestions.ask()`；新版 DSH 通过 Cordis waterfall 事件 `user-questions/request` 交给 UI/provider answerer。
- botmux 已有可复用 ask 链路：`botmux hook <cliId>` → `/api/asks` → `ask-broker` → 飞书卡片 → 答案 format 回 CLI。

本计划目标：**不修改 dsh-tui 仓库代码，通过 DSH profile `--patch` + botmux 生成的 Cordis 插件，把 DSH `ask_user_question` 转发到飞书，并把答案回写给 DSH。**

---

## 1. 计划目标：实现什么，不实现什么

### 1.1 要实现

1. **botmux 内置 DSH question bridge 插件**
   - botmux 生成一个内容寻址、只读 Cordis 插件文件。
   - 插件在 DSH runtime 内监听 `user-questions/request` waterfall。
   - 插件只处理可完整表示为 botmux ask 的 request；不可处理时按 runtime 模式 fallback 或显式失败。
   - 插件通过稳定的 `hookCommandParts(<cliId>)` 调用当前 botmux 实例的 `botmux hook dsh` / `botmux hook dsh-tui`。

2. **新增 DSH ask-hook adapter**
   - 新增 `src/core/ask-hook/dsh.ts`。
   - `parseQuestions()`：DSH `AskUserQuestionRequest` → botmux `AskQuestion[]`。
   - `formatAnswer()`：botmux `AskResult` → DSH `AskUserQuestionAnswer` JSON。
   - `passthrough()`：空 stdout，让 bridge 插件按 runtime 模式处理。
   - `registry.ts` 注册 `dsh` 与 `dsh-tui` 到同一 adapter。

3. **official `dsh` runner 与 `dsh-tui` 统一采用临时 `--patch=` 注入**
   - **统一策略**：bridge 不写入用户/默认 profile 的持久 `cordis.patch.yml`。
   - official dsh runner 启动：`dsh --profile <profile> --patch=<bridgePatch>`。
   - dsh-tui 启动：`dsh-tui --patch=<bridgePatch>`，由 launcher 透传给 `dsh --profile dsh-tui`。
   - 已存在 profile、自定义 profile、用户 patch 均不被覆盖；只在本次 botmux-spawn 的进程上叠加 overlay。

4. **实现 emergency kill switch**
   - 新增全局环境变量：`BOTMUX_DSH_ASK_BRIDGE=0` 禁用 bridge 生成与 `--patch` 注入。
   - 可选后续：per-bot `dshAskBridge: 'auto' | 'off'`；MVP 不新增 bot 配置，减少范围。
   - 关闭后新启动/重启的 dsh/dsh-tui 会话不再加载 bridge；已运行会话需 `/restart` 或重启 worker 才卸载已加载插件。

5. **只复用现有 botmux ask 公共链路**
   - 继续使用 daemon `/api/asks`、`ask-broker`、`ask-card`、nonce、canTalk、话题文字回复机制。
   - 不新增第二套飞书卡片系统。

6. **MVP 支持 options 型 request**
   - 支持单问单选、多问、多选。
   - 支持单问用户文字回复，映射为 DSH `custom`。
   - `header` / `detail` / option `description` 合并入 botmux card prompt，避免改公共 ask 类型。

7. **定义 official dsh 与 dsh-tui 的不同失败行为**
   - `dsh-tui`：有原生 UI answerer，可 `next()` fallback 到 TUI 面板。
   - official `dsh` runner：没有 TUI fallback；unsupported / bridge 失败必须返回 DSH tool error，让模型和用户看到明确失败原因，不得静默空答案或挂死。

### 1.2 不实现

1. 不修改 `/data00/home/lixingxin/project/dsh-TUI/**`。
2. 不修改 `/data00/home/lixingxin/project/deepseek-harness/**`。
3. 不做 PTY 抓屏、屏幕 OCR、按键模拟 dsh-tui 问卷面板。
4. MVP 不支持 text-only 问题；后续单独扩展 botmux ask text input。
5. MVP 不接管 `intent.kind === 'plan-review'` 或 approval 语义。
6. 不改变 OpenCode、Claude、CoCo、TraeX 既有 ask-hook 行为。
7. 不改变现有 ask-broker/card 的 action key、nonce、canTalk/canOperate、文字回复语义，除非后续公共 ask 扩展任务单独批准。
8. 不持久修改用户 dsh/dsh-tui profile；bridge 一律通过临时 `--patch=` overlay 注入。

---

## 2. 计划范围：改变哪些，不改变哪些

### 2.1 允许新增文件

- `src/core/ask-hook/dsh.ts`
  - DSH question payload parse/format adapter。

- `src/adapters/dsh-question-bridge.ts`
  - 生成 bridge 插件与 patch 文件。
  - 提供：`ensureDshQuestionBridgePatch(cliId: 'dsh' | 'dsh-tui'): { patchPath, readonlyRoot } | null`。
  - kill switch 为 off 时返回 null。

- `test/ask-hook-dsh.test.ts`
- `test/dsh-question-bridge.test.ts`
- `test/dsh-question-bridge-cordis.test.ts`

### 2.2 允许修改文件

- `src/core/ask-hook/registry.ts`
  - 注册 `dsh` / `dsh-tui`。

- `src/dsh-runner.ts`
  - official dsh runner 追加临时 `--patch=<bridgePatch>`。
  - 不修改 profile `cordis.patch.yml` 持久内容。
  - 可向 child env 注入 `BOTMUX_DSH_ASK_RUNTIME=official` 与受控 ask timeout。

- `src/adapters/cli/dsh.ts`
  - 如需从 adapter 传入 bridge enable/disable 或 dshProfile，最小修改。

- `src/adapters/cli/dsh-tui.ts`
  - `buildArgs()` 追加 `--patch=<bridgePatch>`。
  - `sandboxReadonlyPaths()` 暴露 bridge root。
  - MVP 暂不设置 `asksViaHook: true`，除非 W0 确认 target 版本与 fallback 100% 稳定。

- `src/adapters/cli/fs-policy.ts`
  - 仅当 sandbox 验证显示需要额外只读规则时修改。

- `test/dsh-runner.test.ts`
- `test/worker-dsh-turn.integration.test.ts`
- `test/cli-adapters.test.ts`

- 文档：
  - `docs/design/2026-08-13-dsh-adapter.md`
  - `docs/TEST-GUIDE-ask-hooks.md`
  - 必要时 docs-site adapters 页面。

### 2.3 明确不改变文件

- 不改 dsh-TUI 仓库。
- 不改 deepseek-harness 仓库。
- 不改现有 OpenCode/Claude/CoCo/TraeX adapter 逻辑。
- 不改 `src/core/ask-broker.ts`、`src/im/lark/ask-card.ts`、`src/core/ask-types.ts`，除非 W3 公共 ask 扩展被单独批准；若触碰公共 ask，必须增加所有既有 adapter 回归。
- 不改 bot 配置 schema；MVP kill switch 只用 env。

### 2.4 范围控制规则

- W0 的 go/no-go 验证必须全部通过，且验证结论写回本文，才允许进入 W1。
- 任一实现发现必须扩大范围，先更新本文并重新双 review。
- 不用 `git add .`；只 stage 当前子任务允许文件。
- 每个子任务都必须有独立提交计划，并在子任务完成后形成独立 commit；但并行 subagent 不直接向 master 落未审 commit。
- 执行方式：subagent 产出 patch/分支/候选 diff → 主控 review 该子任务 diff → 运行该子任务列出的最小测试 → 由主控按子任务提交计划提交。
- 每个 wave 结束后主控再统一 rebase/冲突处理、运行 wave 测试，确认多个子任务 commit 集成后仍一致。
- 若公共 ask 链路被触碰，必须额外跑 OpenCode/CoCo/Claude 相关回归测试。

---

## 3. 目标架构与核心协议

### 3.1 统一注入策略：临时 overlay patch

**最终固定策略：official dsh 与 dsh-tui 都使用临时 `--patch=<bridgePatch>`，不写持久 profile。**

好处：

- 可用 `BOTMUX_DSH_ASK_BRIDGE=0` 立即对新会话回滚。
- 不污染用户 `~/.dsh/profiles/<name>/cordis.patch.yml`。
- 多 checkout 可通过内容 hash 隔离。
- dsh 与 dsh-tui 复用同一 bridge 生成器。

### 3.2 bridge 文件目录与并发安全

生成目录采用内容寻址：

```text
~/.botmux/dsh-question-bridge/<sha256>/
  bridge.mjs
  cordis.patch.yml
```

`sha256` 输入至少包含：

- bridge 模板内容版本号。
- `hookCommandParts(cliId)` 的 `{ cmd, args }`。
- 当前 botmux package version / git checkout path（能拿到则纳入）。
- cliId：`dsh` 或 `dsh-tui`。

写入规则：

- `mkdirSync(dir, { recursive: true, mode: 0o700 })`。
- 文件 mode：`bridge.mjs` / `cordis.patch.yml` 用 `0o600`。
- 原子写：先写临时文件再 rename。
- 内容相同跳过。
- 不同 checkout/版本/cliId 写到不同 hash 目录，避免互相覆盖。

### 3.3 hook command 定位

bridge 生成器必须使用现有稳定机制：

```ts
import { hookCommandParts } from './hook-command.js';
const parts = hookCommandParts(cliId);
```

禁止：

- 手写 `dist/cli.js` 路径。
- 依赖全局 `botmux` shim。
- 用 shell 字符串执行。
- 在 generated plugin 里 split quoted command。

原因：`hookCommandParts()` 已处理 Node 态 / standalone Bun 编译态，避免 `$bunfs`、multi-checkout、global shim 漂移。

生成模板内联：

```js
const CMD = "/abs/current/process-or-binary"
const ARGS = ["...", "hook", "dsh-tui"]
```

spawn：

```js
spawn(CMD, ARGS, { stdio: ['pipe', 'pipe', 'ignore'] })
```

### 3.4 Cordis patch 结构

默认 patch 使用绝对 file URL，避免相对路径基准歧义：

```yaml
- insert:
    - id: botmux-dsh-question-bridge
      name: 'file:///abs/path/to/bridge.mjs'
```

W0 必须验证：

- `file://` plugin name 能被 DSH/Cordis loader import。
- root `insert` row 能挂载插件。
- 插件里 `ctx.on('user-questions/request', ..., { prepend: true })` 语义有效。
- id 不与已有 row 冲突；若冲突，使用 hash 后缀 id：`botmux-dsh-question-bridge-<shortHash>`。

### 3.5 bridge plugin 行为

bridge plugin 伪代码：

```js
export const name = 'botmux-dsh-question-bridge'

export function apply(ctx) {
  const mode = process.env.BOTMUX_DSH_ASK_RUNTIME // 'official' | 'tui'
  if (!isBotmuxSessionEnv(process.env)) return
  if (process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return

  ctx.on('user-questions/request', async (request, next) => {
    if (!isWaterfallRequest(request)) return next()

    const classification = classifyRequest(request)
    if (!classification.bridgeable) {
      return handleBridgeFailure('unsupported', classification.reason, next, mode)
    }

    const stdout = await invokeBotmuxHook({ request, signal: request.signal })
    if (!stdout.ok) {
      return handleBridgeFailure(stdout.reason, stdout.detail, next, mode)
    }

    try {
      return validateDshAnswer(JSON.parse(stdout.text), request)
    } catch (error) {
      return handleBridgeFailure('malformed-answer', String(error), next, mode)
    }
  }, { prepend: true })
}
```

`handleBridgeFailure()`：

- `mode === 'tui'`：`return next()`，让 dsh-tui 原生 UI 接手。
- `mode === 'official'`：throw transportable `UserQuestionError`-like error，message 清楚说明 botmux bridge 无法处理该问题。

### 3.6 security / route boundary

- bridge payload 不允许携带 `sessionId`、`chatId`、`rootMessageId`、`larkAppId` 等路由身份。
- `botmux hook dsh` / `dsh-tui` 只从 worker 注入的 env 与 capability relay 中绑定身份。
- `/api/asks` 继续由 daemon 根据 authenticated session 绑定实际 chat/root，忽略请求体自选身份（沿用现有 `/api/asks` 窄孔姿态）。
- DSH profile 内其它恶意插件若能读取同一进程 env，也能主动运行 `botmux hook` 或 `botmux ask`；这属于同进程插件信任边界，不由本 bridge 解决。计划中必须在文档说明：**bridge 不提升对不可信 DSH 插件的隔离能力**。
- 仍需测试恶意 payload 字段不会改变路由：payload 内塞 fake `chatId/sessionId` 时，hook 端必须忽略。

### 3.7 request 支持规则

一个 `user-questions/request` 要么整体 bridge，要么整体 fallback/error；不做部分接管。

整体 bridge 条件：

- `request.questions` 是非空数组。
- 每一题都：
  - 有非空 `id`。
  - 有非空 `question`。
  - 无 `intent.kind === 'plan-review'`。
  - `options` 是数组且长度 >= 2。
  - 每个 option 有非空单行 label。
  - label 去重后数量等于原数量。
  - label 长度在安全上限内（建议 <= 200 字符）。
- request 不混合 unsupported 题；只要一题 unsupported，整个 request 不 bridge。

重复/非法 label 行为：

- dsh-tui runtime：fallback 原生 UI。
- official runtime：throw visible `UserQuestionError`，提示“botmux bridge cannot represent this question; duplicate/invalid labels”。

### 3.8 timeout、并发、资源控制

bridge invoke hook 规则：

- 每个 request 单独 spawn 一个 hook child，互不共享状态。
- 不做插件层重试；daemon restart 重试交给 `cli.ts#runHook()` 内部稳定 requestId 机制。
- stdout 上限：例如 1 MiB，超过立即 kill child 并 failure。
- hook child backstop timeout：
  - default = `BOTMUX_DSH_ASK_TIMEOUT_MS` 或 `BOTMUX_ASK_TIMEOUT_MS`。
  - official dsh runner 必须将 ask timeout 限制为 `turnTimeoutMs - 5s`，避免 runner watchdog 先杀进程。
  - dsh-tui 可使用较长默认，但仍需有限 backstop。
- single-settle：child close/error/timeout/abort/stdout-overflow 只能 resolve 一次。
- abort：`request.signal` abort 时 kill child，并抛 `ASK_ABORTED`（official）或 `next()`/交还原生（tui，若未 abort 到原生也会自行处理）。
- 并发：Cordis 可能并发多个 ask；每个 invocation 自有 hook process、自有 requestId；输出只回本 invocation。

---

## 4. Failure Matrix

| 场景 | dsh-tui runtime | official dsh runtime | 测试要求 |
|---|---|---|---|
| 非 botmux env | bridge no-op | bridge no-op | 插件 apply 不 spawn |
| `BOTMUX_DSH_ASK_BRIDGE=0` | 不注入 patch / 插件 no-op | 不注入 patch / 插件 no-op | adapter args 无 `--patch` |
| DSH 只支持 legacy provider | 不接管；原生 TUI | 可选 legacy provider only if no provider；否则 visible error | W0 capability test |
| request text-only | `next()` 原生 UI | throw visible unsupported error | 单测 |
| request plan-review | `next()` 原生 UI | throw visible unsupported error | 单测 |
| 多问中有一题 unsupported | 整体 `next()` | 整体 visible error | 单测 |
| duplicate/empty/long label | `next()` | visible error | 单测 |
| hook command missing / spawn error | `next()` | visible error | bridge test |
| daemon 不可达且 runHook 判定非可恢复 | 空 stdout → `next()` | visible error | bridge test |
| `/api/asks` 用户超时 | 空 stdout → `next()`（原生 UI 会再次问） | visible timeout error | fake hook test |
| malformed hook stdout | try/catch → `next()` | visible malformed error | bridge test |
| stdout 超上限 | kill → `next()` | visible stdout overflow error | bridge test |
| request.signal abort | kill child；交还/abort | throw ASK_ABORTED | bridge test |
| sandbox deny patch file | 无 patch 或启动失败要明确 | 无 patch 或启动失败要明确 | sandbox integration |
| 重复点击/文字回复 | 由 ask-broker 保证一次 settle | 同左 | 公共 ask 回归 |
| daemon restart during ask | runHook requestId retry / ask-broker persist | 同左，受 backend survival 约束 | 复用现有 hook restart 测试或新增 |

---

## 5. 子任务拆分与提交计划

> 执行治理：子任务可以由 subagent 并行实现，但 **每个 wave 结束由主控统一 review diff、解决冲突、运行该 wave 测试后提交**。如确需子任务负责人提交，必须在独立 worktree/branch 形成候选 commit，主控审核后 cherry-pick/squash；不得让未集成验收的并行 commit 直接落主线。

### Wave 0：硬性 go/no-go 验证（并行 5 个子任务）

> W0 任一失败，停止实现，更新计划或重新设计；不得进入 W1。

#### W0-T1：dsh-tui launcher `--patch=` 透传验证

**目标**：确认 `dsh-tui --patch=/abs/path` 能到达 `dsh --profile dsh-tui` 的 launcher 选项层，不被 workspace/resume 普通参数吞掉。

**验证项**：

- `--patch=/abs/path` 单 token。
- `--patch /abs/path` 双 token 是否误判 workspace（记录结果）。
- 与 `--resume`、`--resume=<id>`、workspace target 并存的顺序。
- 多个 `--patch=` 的合并顺序。
- 是否有可退出验证路径：`--dump-config`、`--help` 或受控 fake dsh。

**产物**：验证结论写回本文 “W0 结果” 小节。

**提交计划**：只提交文档验证结论：

```bash
git add docs/plan/2026-09-02-dsh-tui-ask-bridge.md
git commit -m "docs(dsh): 记录 dsh-tui patch 透传验证结论"
```

#### W0-T2：Cordis patch schema / plugin path / prepend 验证

**目标**：确认 patch 写法可真实加载 bridge 插件。

**验证项**：

- `name: 'file:///abs/bridge.mjs'` 可加载。
- 如不用 file URL，确认 `./bridge.mjs` 的解析基准；但 MVP 默认 file URL。
- root `- insert:` 追加 row 可挂载。
- id 冲突行为。
- `ctx.on(..., { prepend: true })` 确实先于 dsh-tui/native answerer。
- agent-scoped `user-questions/request` 能被 root listener 收到。

**提交计划**：若新增测试：

```bash
git add test/dsh-question-bridge-cordis.test.ts docs/plan/2026-09-02-dsh-tui-ask-bridge.md
git commit -m "test(dsh): 验证 question bridge cordis patch 语义"
```

#### W0-T3：DSH user-questions API 能力检测

**目标**：确认目标 DSH 版本支持 waterfall；legacy provider 的行为被识别并门控。

**验证项**：

- `ctx.on('user-questions/request')` 是否被 `ctx.userQuestions.ask()` 调用。
- legacy `registerProvider()` 是否存在。
- official dsh profile 中是否无已有 provider，从而 bridge 可在 legacy 下注册 provider（仅 official）。
- dsh-tui legacy 下若已有 QuestionStore provider，bridge 不接管。

**实现要求**：

- bridge 插件启动时必须做 runtime capability probe。
- 不能确认可接管时不 spawn hook。
- `asksViaHook` MVP 默认不置 true；等 capability 证据稳定后再考虑。

**提交计划**：

```bash
git add test/dsh-question-bridge-cordis.test.ts docs/plan/2026-09-02-dsh-tui-ask-bridge.md
git commit -m "test(dsh): 锁定 userQuestions bridge 能力检测"
```

#### W0-T4：sandbox / executable 可达性验证

**目标**：确认 bridge 文件与 hook command 在 sandbox 下可读可执行。

**验证项**：

- bridge 生成目录在 `sandboxReadonlyPaths()` 下真实 bind。
- `hookCommandParts()` 里的 `cmd` 在 sandbox 中可执行：
  - Node 源码态；
  - standalone Bun 二进制态；
  - 多 checkout 下不落到错误 global shim。
- `PATH` 缺失/污染时仍用绝对 cmd + argv 成功。
- `BOTMUX_SEND_RELAY` / capability env 能被 hook 读取并通过 `/api/asks` 鉴权。

**提交计划**：

```bash
git add test/cli-adapters.test.ts test/plugin-registry-sandbox-read.test.ts docs/plan/2026-09-02-dsh-tui-ask-bridge.md
git commit -m "test(dsh): 验证 question bridge 沙盒执行边界"
```

#### W0-T5：DSH answer schema 与 option label 语义验证

**目标**：确认 DSH answer 是否确实使用 option label；固定非法 label 行为。

**验证项**：

- `AskUserQuestionAnswerItem.selected` 是否应为 label。
- label 重复时 DSH 自身 UI 如何处理。
- label 含换行/超长/Markdown 时是否可接受。
- 是否存在 hidden value/index；若存在，优先用稳定 value/index 映射。

**MVP 默认**：若未发现稳定 value，使用 label；重复/空/多行/超长 label 整体 unsupported。

**提交计划**：

```bash
git add test/ask-hook-dsh.test.ts docs/plan/2026-09-02-dsh-tui-ask-bridge.md
git commit -m "test(dsh): 固定 question answer label 映射规则"
```

### Wave 1：hook adapter 与 bridge 生成器（并行 2 个子任务）

#### W1-T1：实现 DSH ask-hook adapter

**文件**：
- 新增：`src/core/ask-hook/dsh.ts`
- 修改：`src/core/ask-hook/registry.ts`
- 新增：`test/ask-hook-dsh.test.ts`

**工作内容**：

- 解析 `hook_event_name: 'user-questions/request'`。
- 整体判断 request 是否 bridgeable；任何一题 unsupported → parsed null。
- header/detail/description 拼 prompt。
- format DSH `{ answers }`。
- custom reply 只支持单问；多问 custom-only 返回 passthrough/invalid，按测试固定。
- payload 中身份字段全部忽略。

**核心代码片段**：

```ts
const dshAdapter: HookAskAdapter = {
  parseQuestions(payload) {
    if (!isRecord(payload) || payload.hook_event_name !== 'user-questions/request') return null;
    const rawQuestions = readRawQuestions(payload);
    if (!rawQuestions?.length) return null;
    const parsed = rawQuestions.map(parseOneDshQuestion);
    if (parsed.some(q => q === null)) return null;
    return { questions: parsed as AskQuestion[], raw: { rawQuestions } };
  },
  formatAnswer(answersByQuestion, parsed, comment) {
    return JSON.stringify({ answers: toDshAnswers(answersByQuestion, parsed, comment) });
  },
  passthrough() { return ''; },
};
```

**Wave-level commit**：

```bash
git add src/core/ask-hook/dsh.ts src/core/ask-hook/registry.ts test/ask-hook-dsh.test.ts
git commit -m "feat(dsh): 增加 userQuestions ask hook 适配器"
```

#### W1-T2：实现 bridge 文件生成器

**文件**：
- 新增：`src/adapters/dsh-question-bridge.ts`
- 新增：`test/dsh-question-bridge.test.ts`

**工作内容**：

- 使用 `hookCommandParts(cliId)` 生成 argv。
- content hash 目录隔离。
- 原子写、0600 文件权限。
- 生成 file URL patch。
- kill switch off 返回 null。
- 测试 Node/standalone 通过注入参数或 mock 验证 command parts 不走 global shim。

**核心代码片段**：

```ts
export function ensureDshQuestionBridgePatch(cliId: 'dsh' | 'dsh-tui'): DshQuestionBridgePatch | null {
  if (process.env.BOTMUX_DSH_ASK_BRIDGE === '0') return null;
  const parts = hookCommandParts(cliId);
  const content = buildBridgePlugin({ cmd: parts.cmd, args: parts.args, runtime: cliId === 'dsh-tui' ? 'tui' : 'official' });
  const hash = sha256(content + '\n' + JSON.stringify(parts)).slice(0, 16);
  const root = join(homedir(), '.botmux', 'dsh-question-bridge', hash);
  atomicWriteFileSync(join(root, 'bridge.mjs'), content, 0o600);
  atomicWriteFileSync(join(root, 'cordis.patch.yml'), buildPatch(pathToFileURL(join(root, 'bridge.mjs')).href), 0o600);
  return { patchPath: join(root, 'cordis.patch.yml'), readonlyRoot: root };
}
```

**Wave-level commit**：

```bash
git add src/adapters/dsh-question-bridge.ts test/dsh-question-bridge.test.ts
git commit -m "feat(dsh): 生成 question bridge profile patch"
```

### Wave 2：official dsh 与 dsh-tui 接入（并行 2 个子任务）

#### W2-T1：official dsh runner 接入临时 patch

**文件**：
- 修改：`src/dsh-runner.ts`
- 修改：`test/dsh-runner.test.ts`
- 修改：`test/fixtures/fake-dsh-server.mjs`（仅为断言 argv/env）

**工作内容**：

- runner resolve config 时调用 bridge 生成器。
- 启动 child：

```ts
const dshArgs = ['--profile', profileName];
if (bridgePatch) dshArgs.push(`--patch=${bridgePatch.patchPath}`);
spawn(dshBin, dshArgs, { env: { ...process.env, BOTMUX_DSH_ASK_RUNTIME: 'official', BOTMUX_DSH_ASK_TIMEOUT_MS: String(Math.max(1000, args.turnTimeoutMs - 5000)) } });
```

- 确认不修改 `~/.dsh/profiles/<name>/cordis.patch.yml`。
- official unsupported / timeout / malformed 必须作为 visible tool error，不 fallback 到不存在的 UI。

**Wave-level commit**：

```bash
git add src/dsh-runner.ts test/dsh-runner.test.ts test/fixtures/fake-dsh-server.mjs
git commit -m "feat(dsh): runner 通过临时 patch 注入 question bridge"
```

#### W2-T2：dsh-tui adapter 接入临时 patch

**文件**：
- 修改：`src/adapters/cli/dsh-tui.ts`
- 修改：`test/cli-adapters.test.ts`

**工作内容**：

- `buildArgs()` 中：

```ts
const bridge = ensureDshQuestionBridgePatch('dsh-tui');
if (bridge) args.push(`--patch=${bridge.patchPath}`);
```

- 确认 `--patch=` 与 `--resume` 顺序通过 W0-T1 固定；如果 W0 发现必须前置，则按 W0 结论执行。
- sandbox readonly paths 返回 bridge readonly root；若 root 内容寻址，生成器需提供 stable parent 或 adapter 缓存 latest roots。
- MVP 不设置 `asksViaHook`，除非 W0/W2 证明 all supported + unsupported fallback 不会阻塞。

**Wave-level commit**：

```bash
git add src/adapters/cli/dsh-tui.ts test/cli-adapters.test.ts
git commit -m "feat(dsh-tui): 通过临时 profile patch 注入 question bridge"
```

### Wave 3：公共 ask 保护与文档（并行 2 个子任务）

#### W3-T1：公共 ask 链路回归保护

**默认目标**：不改公共 ask 类型/card。

如果任何实现触碰以下文件：

- `src/core/ask-types.ts`
- `src/core/ask-api.ts`
- `src/core/ask-broker.ts`
- `src/im/lark/ask-card.ts`

必须补充回归：

- OpenCode / OpenCode2 hook adapter parse/format。
- CoCo picker key 计算与 daemon 下发。
- Claude ask hook parse/format。
- ask-card action key、nonce、canTalk、文字回复。

**Wave-level commit**：

```bash
git add <公共ask文件> <对应测试>
git commit -m "test(ask): 补充 dsh bridge 公共链路回归"
```

若未触碰公共 ask，则本任务只记录“未改公共 ask，无需提交”。

#### W3-T2：文档更新

**文件**：
- `docs/design/2026-08-13-dsh-adapter.md`
- `docs/TEST-GUIDE-ask-hooks.md`
- 必要时 docs-site adapters 页面

**内容**：

- bridge 架构。
- failure matrix。
- kill switch：`BOTMUX_DSH_ASK_BRIDGE=0`。
- dsh/dsh-tui 最低版本或 capability 检测说明。
- dsh/dsh-tui smoke 矩阵。

**Wave-level commit**：

```bash
git add docs/design/2026-08-13-dsh-adapter.md docs/TEST-GUIDE-ask-hooks.md docs-site/docs/zh/adapters.md docs-site/docs/en/adapters.md
git commit -m "docs(dsh): 补充 question bridge 设计与验证说明"
```

### Wave 4：集成测试与真实 smoke（串行补漏）

#### W4-T1：fake 集成测试

**目标**：无真实 DSH API key 也能证明 bridge 数据流。

**文件**：
- `test/worker-dsh-turn.integration.test.ts`
- `test/fixtures/fake-dsh-server.mjs`
- 必要 fake bridge helper

**覆盖**：

- official dsh runner argv 包含 `--patch=`。
- fake runtime 记录 patch env/path。
- hook adapter + bridge 单测已证明 question 能到 `/api/asks`。

**Wave-level commit**：

```bash
git add test/worker-dsh-turn.integration.test.ts test/fixtures/fake-dsh-server.mjs
git commit -m "test(dsh): 覆盖 question bridge worker 集成"
```

#### W4-T2：真实 smoke 矩阵

**矩阵**：

| runtime | sandbox | case |
|---|---|---|
| official dsh | off | 单问单选 |
| official dsh | on | 单问单选 |
| dsh-tui | off | 单问单选 |
| dsh-tui | on | 单问单选 |
| dsh-tui | off | unsupported text-only fallback 原生 UI |
| dsh-tui | off | abort / 超时行为 |

如果成本允许再加：多选、多问、长 detail、重复 label。

**提交计划**：

- 真实 smoke 只记录到 PR 描述；若需要文档化：

```bash
git add docs/TEST-GUIDE-ask-hooks.md
git commit -m "docs(dsh): 记录 question bridge smoke 验证矩阵"
```

---

## 6. 验收计划：五类并行 subagent gate

> 规则：任何代码变更后，都必须重新并行运行以下 5 个验收 subagent。5 个同一轮全部通过，计划实现才算完成。任一失败，需要修复、提交，再重新同时跑 5 个验收。

### Gate A：代码质量与简洁性

检查：

- bridge 生成器职责是否单一。
- generated plugin 是否短小、无 shell、无全局 shim 依赖。
- hook adapter 是否只 parse/format，不混 daemon/worker。
- failure handling 是否显式且不吞掉真实问题。
- 是否避免 speculative abstraction。

建议 subagent prompt：

```text
请只审查代码质量与简洁性，不改文件。范围：dsh/dsh-tui question bridge 相关提交。检查过度抽象、职责混乱、重复逻辑、错误处理、生成代码安全与现有风格。输出 pass/fail。
```

### Gate B：编译与基础测试

命令：

```bash
bun run build
bun test test/ask-hook-dsh.test.ts
bun test test/dsh-question-bridge.test.ts
bun test test/dsh-question-bridge-cordis.test.ts
bun test test/dsh-runner.test.ts
bun test test/cli-adapters.test.ts
bun test test/worker-dsh-turn.integration.test.ts
```

如仓库实际测试 runner 用 vitest：

```bash
bunx vitest run test/ask-hook-dsh.test.ts test/dsh-question-bridge.test.ts test/dsh-question-bridge-cordis.test.ts test/dsh-runner.test.ts test/cli-adapters.test.ts test/worker-dsh-turn.integration.test.ts
```

建议 subagent prompt：

```text
请只做编译与测试验收，不改文件。运行构建和关键测试，记录命令、退出码和关键输出。失败时判断实现问题、环境问题还是既有问题。输出 pass/fail。
```

### Gate C：计划漂移与范围控制

检查：

- 是否修改 dsh-TUI/deepseek-harness：必须没有。
- 是否改持久 dsh profile：默认不得改，除非明确用户操作。
- 是否遵守统一临时 `--patch=` 策略。
- 是否引入计划外 bot config/dashboard 改动。
- 是否触碰公共 ask；若触碰，是否补回归。
- commit 是否按 wave/subtask 范围。

建议 subagent prompt：

```text
请只审查实现是否偏离 docs/plan/2026-09-02-dsh-tui-ask-bridge.md，不改文件。列出 git diff 和提交历史中的超范围、漏实现、持久配置污染或公共链路风险。输出 pass/fail。
```

### Gate D：架构合理性与安全路由

检查：

- 是否走 DSH `user-questions/request` seam，而非 PTY 抓屏。
- hook command 是否用 `hookCommandParts()`，覆盖 standalone/multi-checkout/sandbox。
- `/api/asks` 身份是否仍由 env/capability 绑定，payload 不能伪造路由。
- official vs dsh-tui failure behavior 是否清楚。
- sandbox readonly/executable 是否合理。
- 并发/timeout/abort/single-settle 是否有实现与测试。

建议 subagent prompt：

```text
请做架构和安全审查，不改文件。重点检查 seam 选择、路由鉴权、hook 命令定位、sandbox、failure matrix、并发/超时/abort。输出 pass/fail。
```

### Gate E：测试充分性

检查：

- hook adapter：单问/多问/多选/custom/unsupported/重复 label。
- bridge：success/empty stdout/nonzero/malformed/timeout/abort/stdout overflow。
- dsh-tui：`--patch=` argv、resume/workspace 交互、sandbox readonly。
- official dsh：`--patch=` argv、turnTimeout 与 askTimeout 关系、visible error。
- 公共 ask 回归：OpenCode/CoCo/Claude/ask-card 关键用例。
- smoke：official/dsh-tui × sandbox on/off。

建议 subagent prompt：

```text
请只审查测试充分性，不改文件。对照计划和实现，找未覆盖边界，特别是 fallback、abort、sandbox、argv、custom reply、public ask regressions、multi-checkout/standalone。输出 pass/fail。
```

---

## 7. Todo List

### 计划与 review 阶段

- [x] 拉取并确认 `origin/master` 最新状态。
- [x] 确认 master 尚未实现 dsh/dsh-tui ask bridge。
- [x] 确认 master 新增 DSH profile 机制，可加速插件化实现。
- [x] 创建本计划文档 v1。
- [x] 第一轮两个 plan review subagent 均返回 FAIL。
- [x] 修订计划 v2：补回滚、统一注入、runtime failure、sandbox、hook 定位、failure matrix、安全、并发、公共回归与提交治理。
- [x] 第二轮并行启动两个 plan review subagent。
- [x] 两个 review subagent 同一轮均 PASS。
- [x] 将计划白话摘要发送给用户 review。
- [x] 用户明确通过后，才能开始改实现代码。

### W0 硬门禁 Todo

- [x] W0-T1：验证 dsh-tui `--patch=/abs/path` 透传、顺序、多 patch、resume/workspace 交互。
- [x] W0-T2：验证 Cordis patch schema、file URL 插件加载、root insert、prepend、id 冲突。
- [ ] W0-T3：验证 DSH userQuestions waterfall / legacy 能力检测与门控。
- [ ] W0-T4：验证 sandbox 下 bridge 文件可读、hook command 可执行、capability 可用。
- [x] W0-T5：验证 DSH answer schema 与 option label/key 语义。
- [ ] 将 W0 验证结论写回本文；任一失败则停止后续实现。

### 实现 Todo

- [ ] W1-T1：实现 DSH ask-hook adapter。
- [ ] W1-T2：实现 content-addressed bridge 生成器。
- [ ] W2-T1：official dsh runner 通过临时 `--patch=` 注入 bridge。
- [ ] W2-T2：dsh-tui adapter 通过临时 `--patch=` 注入 bridge。
- [ ] W3-T1：公共 ask 链路回归保护；默认不改公共 ask。
- [ ] W3-T2：更新设计与测试文档。
- [ ] W4-T1：fake 集成测试。
- [ ] W4-T2：真实 smoke 矩阵。

### 回滚与运营 Todo

- [ ] 实现 `BOTMUX_DSH_ASK_BRIDGE=0` kill switch。
- [ ] 测试 kill switch 下 official dsh / dsh-tui args 均无 `--patch=`。
- [ ] 文档说明线上异常回滚步骤：设置 env → 重启 daemon/worker 或 `/restart` 会话。
- [ ] 确认 bridge 目录内容寻址，不会被多 checkout 覆盖。

### 验收 Todo

- [ ] 并行 Gate A：代码质量与简洁性。
- [ ] 并行 Gate B：编译与基础测试。
- [ ] 并行 Gate C：计划漂移与范围控制。
- [ ] 并行 Gate D：架构合理性与安全路由。
- [ ] 并行 Gate E：测试充分性。
- [ ] 若任一 Gate 失败：修复并重新并行运行 A-E。
- [ ] 五个 Gate 同轮全部通过后，整理最终交付说明。

---

## 8. W0 结果记录区

> 当前为空。进入实现前必须补齐。

- W0-T1：PASS。临时 fake `dsh` 探测确认：`dsh-tui --patch=/tmp/p1.yml --resume abc --patch=/tmp/p2.yml /tmp/workspace-target` 最终调用 `dsh --profile dsh-tui --patch=/tmp/p1.yml --patch=/tmp/p2.yml`，`--resume` 被 launcher 消费为 env，绝对 workspace target 不透传；双 token `--patch /tmp/p1.yml` 会只透传 `--patch`，路径被 launcher 当 workspace target 吃掉。因此实现必须使用单 token `--patch=/abs/path`，并由测试锁定。
- W0-T2：PASS。源码与 /tmp 临时脚本验证：顶层 `- insert:` 会插入 root entries；`name: file:///abs/bridge.mjs` 可被 Loader import；重复 id 会在 Loader group 层报 `duplicate loader entry id`，所以 bridge row id 必须使用包含短 hash 的唯一 id；`ctx.on(..., { prepend: true })` 通过 `unshift` 排在普通 listener 前；root/unscoped listener 能收到 agent-scoped `user-questions/request`，条件不接管时必须显式 `return next()`。相对 `./bridge.mjs` 也可按 overlay parser 锚定到 patch 目录，但 MVP 固定使用绝对 file URL 规避歧义。
- W0-T3：未执行。
- W0-T4：未执行。
- W0-T5：PASS。源码与临时脚本验证：DSH `AskUserQuestionAnswerItem.selected` 明确是 option label，不存在协议级 hidden value/index；推荐标记也是 label 文本的一部分。DSH 原生 UI/Store 对重复、空、多行、超长、Markdown label 基本不强校验，但 botmux bridge 为可表示性和回写确定性收紧：label 必须非空、非纯空白、单行、长度 <= 200、同一 question 内 exact string 唯一，并且 answer 回写原始 label 不 trim。text-only 是 DSH 原生能力但 MVP bridge unsupported；plan-review 语义特殊不接管；mixed request 无部分 claim 协议，整体 fallback/error。

---

## 9. 最低版本与检测失败提示

MVP 不硬编码版本号，采用运行时能力检测：

- 若能确认 `user-questions/request` waterfall 可 prepend 接管：启用 bridge。
- 若 official dsh legacy 且无其它 provider：可注册 legacy provider；必须测试。
- 若 dsh-tui legacy 已有原生 provider：不接管，保留原生 TUI。
- 检测失败时：bridge 不 spawn hook；必要时在 runner/display 中输出一次性提示，例如：

```text
[dsh] botmux question bridge disabled: current DSH user-questions API does not expose waterfall answerer; using native behavior.
```

提示必须限频，不能污染每一轮输出。

---

## 10. PR / 提交说明要求

最终 PR 描述必须包含：

1. 改了什么：bridge 插件、hook adapter、official dsh/dsh-tui 注入。
2. 为什么：让 DSH `ask_user_question` 能通过 botmux 飞书卡片作答。
3. 影响面：dsh/dsh-tui 适配器；公共 ask 链路是否未改或回归证据。
4. 回滚方式：`BOTMUX_DSH_ASK_BRIDGE=0` + 重启 daemon/worker 或 `/restart` 会话。
5. 测试命令与结果。
6. smoke 结果矩阵。
7. 不出现群内真人名或机器人花名。
