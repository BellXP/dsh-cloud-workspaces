#!/usr/bin/env node
/**
 * dsh-cloud-workspaces — dsh 契约探针（升级雷达）。
 *
 * 逐条检查本插件依赖的每个 dsh 表面（host API 形状 + client dist 内嵌契约），
 * 任何一条断掉都会在 harness 升级时第一时间报出**名字**，而不是线上症状。
 *
 * 用法：
 *   node scripts/check-dsh-contract.mjs                            # 检查本仓库 devDeps（host 包）
 *   node scripts/check-dsh-contract.mjs <dsh树/@deepseek-ai目录>    # 升级前预检完整 dsh 树
 *   例：node scripts/check-dsh-contract.mjs "$LOCALAPPDATA/npm-cache/_npx/<hash>/node_modules/@deepseek-ai"
 *
 * devDeps 树只装 host 包：client 包缺席记 SKIP。升级预检请对完整安装树再跑一遍。
 * 退出码：0 = 无断开；1 = 有 FAIL。tests/dsh-contract.test.ts 调用本脚本，
 * 升级 devDeps 后 pnpm test 即红绿可见。
 *
 * 0.2.2-rc.5 适配注记：
 * - ToolRuntime 自身不再执行（tool-executor-plugins）：全链路探针改装
 *   @deepseek-ai/dsh-tool-executor-native，并用批量调用形状 calls[]。
 * - dsh-fs 基类新增 readByteRange/patchText/deleteFile/moveFile 抽象成员、
 *   dsh-subprocess 新增 terminalEnvironment——按 .d.ts 文本探测，断开即报。
 * - PathLabel 组件包（dsh-client-ui-primitives）不再随安装树发布，改探插件真正
 *   依赖的 DOM 契约 data-path-label（web 前端 dist 内）。
 * - 工作区选择器多出第三洞 workspace.picker.directoryFlow；本机目录选择
 *   pickDirectory 从 workspaces 面迁到 uiWorkspace 服务。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const tree = path.resolve(process.argv[2] ?? path.join(repo, 'node_modules', '@deepseek-ai'))

const results = []
const check = (id, ok, detail = '') => results.push({ id, ok: ok === true, detail })

if (!existsSync(tree)) {
  console.error(`dsh tree not found: ${tree}`)
  process.exit(1)
}
const pkgDir = (name) => path.join(tree, name)
const readPkg = (name) => {
  try { return JSON.parse(readFileSync(path.join(pkgDir(name), 'package.json'), 'utf8')) } catch { return undefined }
}
const distText = (name, ...files) => {
  for (const file of files) {
    try { return readFileSync(path.join(pkgDir(name), file), 'utf8') } catch { /* 下一个 */ }
  }
  return undefined
}
/** 某目录下第一个匹配 glob 前缀的文件文本（如 web 前端 dist 的 index-<hash>.js）。 */
const distGlobText = (name, dir, prefix, suffix) => {
  const full = path.join(pkgDir(name), dir)
  if (!existsSync(full)) return undefined
  for (const entry of readdirSync(full)) {
    if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
      try { return readFileSync(path.join(full, entry), 'utf8') } catch { /* 下一个 */ }
    }
  }
  return undefined
}

console.log(`dsh 契约探针 — 树: ${tree}`)
const versions = ['dsh-tools', 'dsh-fs', 'dsh-subprocess', 'dsh-typert-protocol']
  .map((name) => `${name}@${readPkg(name)?.version ?? '?'}`).join(' ')
console.log(`版本: ${versions}\n`)

// ------------------------------------------------------------- host 契约

const anchoredRequire = createRequire(path.join(repo, 'scripts', 'check-dsh-contract.mjs'))
/** 按绝对路径加载树内包（裸名会沿 node_modules 上溯而错过 @deepseek-ai 兄弟目录）。 */
const loadPkg = (name) => {
  const entry = path.join(pkgDir(name), 'lib', 'index.js')
  if (!existsSync(entry)) throw new Error(`entry missing: ${entry}`)
  return anchoredRequire(entry)
}
/** .d.ts 文本里是否声明了某成员（抽象成员在运行时无痕迹，只能看类型面）。file 相对 lib/types/。 */
const dtsHas = (name, file, pattern) => {
  const text = distText(name, `lib/types/${file}.d.ts`)
  if (text === undefined) return undefined
  return pattern.test(text)
}
const dtsProbe = (name, file, id, pattern) => {
  const probe = dtsHas(name, file, pattern)
  if (probe === undefined) {
    results.push({ id, ok: true, skip: true, detail: `${name}: lib/types/${file}.d.ts 不在本树` })
    return
  }
  check(id, probe)
}

try {
  const tools = loadPkg('dsh-tools')
  check('host/dsh-tools: defineTool 可用', typeof tools.defineTool === 'function')
  const probe = tools.defineTool({
    name: 'contract_probe', description: '',
    parameters: { a: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { v: { type: 'string', required: true } } },
      render: () => [{ type: 'text', text: 'ok' }],
      presentationMeta: () => ({ diffs: [{ path: 'a', oldText: null, newText: 'b' }] }),
    },
    presentCall: () => ({ card: 'diff', title: 't', diffs: [] }),
    presentResult: () => undefined,
    async execute() { return { v: 'ok' } },
  })
  check('host/dsh-tools: defineTool 包装 presentationMeta',
    typeof probe.output?.presentationMeta === 'function')
  check('host/dsh-tools: defineTool 包装 presentCall/presentResult',
    typeof probe.presentCall === 'function' && typeof probe.presentResult === 'function')
  check('host/dsh-tools: presentationMeta 输出可无损 JSON（meta 投影前提）',
    JSON.stringify(probe.output.presentationMeta({ a: 'x' }, { v: 'ok' })).includes('diffs'))

  // 全链路：ToolRuntime + native 执行器 → result.meta（结算态 diff 卡的数据源，
  // 见 v0.7.0 修复）。0.2.1-rc.2 起 ToolRuntime 只做执行器选择，执行由
  // @deepseek-ai/dsh-tool-executor-native 承担，调用形状是批量 calls[]。
  try {
    // 经 dsh-tools 的解析链取同树 cordis / system-prompt / 执行器，保证实例一致。
    const anchored = createRequire(path.join(tree, 'dsh-tools', 'lib', 'index.js'))
    const { Context: Ctx } = anchored('@deepseek-ai/cordis')
    const systemPromptPkg = anchored('@deepseek-ai/dsh-system-prompt')
    const executor = anchored('@deepseek-ai/dsh-tool-executor-native')
    const ctx = new Ctx()
    await ctx.plugin(systemPromptPkg.SystemPrompt, {})
    await ctx.plugin(tools.ToolRuntime, {})
    await ctx.plugin(executor, {})
    ctx.tools.register(probe)
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: 'probe', name: 'contract_probe', arguments: JSON.stringify({ a: 'x' }) }],
      signal: new AbortController().signal,
    })
    const result = batch.results[0]?.result
    check('host/dsh-tools: ToolRuntime 执行结果携带 meta.diffs（结算态 diff 卡数据源）',
      result?.isError !== true && result?.meta !== undefined && JSON.stringify(result.meta).includes('diffs'),
      result?.isError === true ? '执行报错' : '')
  } catch (error) {
    check('host/dsh-tools: ToolRuntime 执行结果携带 meta.diffs（结算态 diff 卡数据源）',
      false, `装配失败: ${error instanceof Error ? error.message : String(error)}`)
  }
} catch (error) {
  check('host/dsh-tools: 可加载', false, String(error instanceof Error ? error.message : error))
}

try {
  const fsPkg = loadPkg('dsh-fs')
  check('host/dsh-fs: FsError/FsTargetKey/FsVersion 导出',
    typeof fsPkg.FsError === 'function' && typeof fsPkg.FsTargetKey === 'function' && typeof fsPkg.FsVersion !== undefined)
} catch (error) {
  check('host/dsh-fs: 可加载', false, String(error instanceof Error ? error.message : error))
}
// fs-ssh 适配器必须实现齐基类的抽象成员（少一个 tsc 即红；探针保证升级先红）。
dtsProbe('dsh-fs', 'index', 'host/dsh-fs: FileSystem.readByteRange 抽象成员（fs-ssh 适配器实现面）',
  /abstract readByteRange\(/)
dtsProbe('dsh-fs', 'index', 'host/dsh-fs: FileSystem.patchText 抽象成员',
  /abstract patchText\(/)
dtsProbe('dsh-fs', 'index', 'host/dsh-fs: FileSystem.deleteFile 抽象成员',
  /abstract deleteFile\(/)
dtsProbe('dsh-fs', 'index', 'host/dsh-fs: FileSystem.moveFile 抽象成员', /abstract moveFile\(/)
dtsProbe('dsh-fs', 'index', 'host/dsh-fs: watch 为基类具体方法（seam/fs-ssh 以 override 遮蔽）', /\n\s+watch\(target: FsTarget/)
try {
  const patch = loadPkg('dsh-fs-patch')
  check('host/dsh-fs-patch: applyHunks 导出（patchText/moveFile 的 hunk 应用）', typeof patch.applyHunks === 'function')
} catch (error) {
  check('host/dsh-fs-patch: 可加载', false, String(error instanceof Error ? error.message : error))
}

try {
  const sub = loadPkg('dsh-subprocess')
  check('host/dsh-subprocess: SubprocessRuntime 服务类导出',
    typeof sub.SubprocessRuntime === 'function')
} catch (error) {
  check('host/dsh-subprocess: 可加载', false, String(error instanceof Error ? error.message : error))
}
dtsProbe('dsh-subprocess', 'index', 'host/dsh-subprocess: SubprocessRuntime.terminalEnvironment 抽象成员（subprocess-ssh 实现）',
  /abstract terminalEnvironment\(/)
dtsProbe('dsh-subprocess', 'types', 'host/dsh-subprocess: SubprocessHandle.control 成员（subprocess-ssh 实现面）',
  /readonly control: Duplex \| undefined/)
dtsProbe('dsh-subprocess', 'types', 'host/dsh-subprocess: 终端句柄 resize/inspectActivity（seam 终端补丁面）',
  /resize\(cols: number, rows: number\): Promise<void>/ && /inspectActivity\(\): Promise<SubprocessTerminalActivity>/)

try {
  const jobs = loadPkg('dsh-jobs')
  check('host/dsh-jobs: JobRegistry 服务类导出', typeof jobs.JobRegistry === 'function')
} catch (error) {
  check('host/dsh-jobs: 可加载', false, String(error instanceof Error ? error.message : error))
}
dtsProbe('dsh-jobs', 'types', 'host/dsh-jobs: JobSpec.output 拉源 + JobOutputSource.read（远程日志拉源契约）',
  /readonly output\?: readonly JobOutputSource\[\]/ && /read\(fromByte: number\): JobSourceRead/)
dtsProbe('dsh-jobs', 'types', 'host/dsh-jobs: JobHooks 无 readOutput（cancel/done 二元，流式 job 不折叠输出）',
  /interface JobHooks \{[\s\S]*?cancel\(reason\?: string\): void;[\s\S]*?done: Promise<JobOutcome>;\s*\}/)
dtsProbe('dsh-jobs', 'types', 'host/dsh-jobs: JobSpec.owner 是 SessionId（后台 job 归属会话，非 agent 本体）',
  /owner\?: SessionId;/)

try {
  const typert = loadPkg('dsh-typert-protocol')
  check('host/dsh-typert-protocol: bindTypertRemote 导出',
    typeof typert.bindTypertRemote === 'function')
} catch (error) {
  check('host/dsh-typert-protocol: 可加载', false, String(error instanceof Error ? error.message : error))
}
dtsProbe('dsh-typert-registry', 'types', 'host/dsh-typert-registry: TypertContribution{face, schemas, model, invocations}（host 半贡献类型）',
  /readonly face: TypertFace/ && /readonly model: TypertPackageModel/ && /readonly invocations: readonly InvocationDescriptor\[\]/)
dtsProbe('dsh-typert-registry', 'index', 'host/dsh-typert-registry: TypertRegistryContract.register 官方声明（本地声明合并已删）',
  /register\(contribution: TypertContribution\): TypertDisposer;/)

for (const dep of ['dsh-settings', 'dsh-system-prompt', 'dsh-workspace', 'dsh-jobs']) {
  check(`host/${dep}: peer 可解析`, readPkg(dep) !== undefined)
}

// ------------------------------------------------------------ client 契约
// client 侧无法 require（浏览器 bundle），对 dist 做字符串契约探测。
// 包缺席 → SKIP（devDeps 只装 host 包）；在树但不可读 → FAIL。

/** client 包的浏览器 bundle：常规是 lib/client.js；api-gateway 按 carrier 拆成 client.browser.js。 */
const clientProbe = (name, id, assert) => {
  if (!existsSync(pkgDir(name))) {
    results.push({ id, ok: true, skip: true, detail: `client/${name} 不在本树（devDeps 仅 host 包）` })
    return
  }
  const text = distText(name, 'lib/client.js', 'lib/client.browser.js', 'lib/index.js')
  if (text === undefined) {
    check(id, false, `client/${name}: dist 不可读`)
    return
  }
  check(id, assert(text))
}

const SLOT_KEYS = [
  ['dsh-cordis-client-runner', 'sidebar.right.tab.files.actions', '文件树头动作（快捷加对话预留）'],
  ['dsh-cordis-client-runner', 'sidebar.right.tab.document.actions', '预览头动作（@ 引用/选中段按钮）'],
  ['dsh-cordis-client-runner', 'tool.call.toolview', '工具行 keyed 分发'],
  ['dsh-cordis-client-runner', 'conversation.input.overlay', 'typert 挂载错误浮层'],
  ['dsh-cordis-client-runner', 'settings.section', '设置卡「SSH 连接」'],
  ['dsh-cordis-client-runner', 'sidebar.workspaces.directoryFlow', '工作区选择器（云端 tab）'],
  ['dsh-cordis-client-runner', 'conversation.hero.workspace.directoryFlow', '会话首页工作区选择器'],
  ['dsh-cordis-client-runner', 'workspace.picker.directoryFlow', '可复用工作区选择器 Factory 洞（0.2.2 第三洞）'],
]
for (const [pkg, key, note] of SLOT_KEYS) {
  clientProbe(pkg, `client/slot: ${key}（${note}）`, (t) => t.includes(key))
}
// 目录流三洞的 owner 契约：open/busy/onPicked/onCancel/onError（WorkspacePicker 的 props）。
clientProbe('dsh-cordis-client-runner', 'client/slot: directoryFlow owner 契约 open/busy/onPicked/onCancel/onError',
  (t) => /onPicked: \(path: string\) => void/.test(t) && /onError: \(message: string\) => void/.test(t))

clientProbe('dsh-client-ui-tool', 'client/ui-tool: edit/write 行按名分发（key "edit"/"write"，dist 引号形式不敏感）',
  (t) => /key:\s*["'`]edit["'`]/.test(t) && /key:\s*["'`]write["'`]/.test(t))
clientProbe('dsh-client-ui-tool', 'client/ui-tool: 结算态 diff 需要 meta.diffs（v0.7.0 契约）',
  (t) => t.includes('meta.diffs') || /\.meta\b[\s\S]{0,80}\.diffs/.test(t) || t.includes('appliedDiffs'))
clientProbe('dsh-client-ui-tool', 'client/ui-tool: 运行态 diff 从参数推导（old_string/new_string）',
  (t) => t.includes('old_string') && t.includes('new_string'))
clientProbe('dsh-client-ui-workspace', 'client/ui-workspace: workspaces.rename（自动起名用）',
  (t) => t.includes('.rename(') || t.includes('renameWorkspace'))
clientProbe('dsh-client-ui-workspace', 'client/ui-workspace: 主会话判定 retainedBy.mainView',
  (t) => t.includes('retainedBy.mainView'))
clientProbe('dsh-client-ui-workspace', 'client/ui-workspace: uiWorkspace 服务承载 pickDirectory（本机目录选择，0.2.2 迁入）',
  (t) => /super\(ctx,\s*["'`]uiWorkspace["'`]\)/.test(t) && /pickDirectory\(\)/.test(t))
clientProbe('dsh-client-ui-conversation', 'client/ui-conversation: input.for 会话寻址面',
  (t) => t.includes('input.for(') || t.includes('input.for ('))
clientProbe('dsh-client-ui-conversation', 'client/ui-conversation: insertText + draftRev CAS 草稿插入',
  (t) => t.includes('insertText') && t.includes('draftRev'))
clientProbe('dsh-api-session-controller', 'client/sessions: scope(id) 会话作用域',
  (t) => t.includes('scope(') || t.includes('scope ('))
clientProbe('dsh-api-session-controller', 'client/sessions: list store byId + retainedBy',
  (t) => t.includes('byId') && t.includes('retainedBy'))
clientProbe('dsh-api-gateway', 'client/api-gateway: remote.$mount + $on + strict 参数 codec 校验（typert 挂载面）',
  (t) => t.includes('$mount(') && t.includes('$on(') && t.includes('has no strict codec'))
// PathLabel 的 DOM 契约：组件本身不再随安装树发布（打进 web 前端 dist），
// 插件的标签美化只依赖 span[data-path-label] + title + 内层 directory/name 两 span。
{
  const id = 'client/web-frontend: PathLabel DOM 契约 data-path-label（标签美化目标）'
  const primitives = distText('dsh-client-ui-primitives', 'lib/client.js', 'lib/index.js')
  const text = primitives ?? distGlobText('dsh-web-frontend', path.join('dist', 'assets'), 'index-', '.js')
  if (text === undefined) {
    results.push({ id, ok: true, skip: true, detail: 'client/dsh-web-frontend 与 dsh-client-ui-primitives 均不在本树' })
  } else {
    check(id, text.includes('data-path-label') && /"data-path-label"|\['data-path-label'\]|data-path-label/.test(text))
  }
}
// spawnTerminal 由本地实现（dsh-subprocess-local）提供，seam 按实例 own-property 补丁。
clientProbe('dsh-subprocess-local', 'host/dsh-subprocess-local: spawnTerminal 终端分配面（seam 补丁目标）',
  (t) => t.includes('spawnTerminal('))

// ------------------------------------------------------------------ 报告

let failed = 0
let skipped = 0
for (const { id, ok, skip, detail } of results) {
  if (skip === true) skipped += 1
  if (!ok) failed += 1
  const tag = skip === true ? '[skip]' : ok ? '[ ok ]' : '[FAIL]'
  console.log(`${tag} ${id}${detail === '' || detail === undefined ? '' : ` — ${detail}`}`)
}
console.log(`\n${results.length - failed}/${results.length} 契约通过（${skipped} 条 SKIP）${failed === 0 ? '' : `，${failed} 条断开`}`)
process.exit(failed === 0 ? 0 : 1)
