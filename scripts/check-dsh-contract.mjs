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
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
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

  // 全链路：ToolRuntime 执行 → result.meta（结算态 diff 卡的数据源，见 v0.7.0 修复）
  try {
    // 经 dsh-tools 的解析链取同树 cordis / system-prompt，保证实例一致。
    const anchored = createRequire(path.join(tree, 'dsh-tools', 'lib', 'index.js'))
    const { Context: Ctx } = anchored('@deepseek-ai/cordis')
    const systemPromptPkg = anchored('@deepseek-ai/dsh-system-prompt')
    const ctx = new Ctx()
    await ctx.plugin(systemPromptPkg.SystemPrompt, {})
    await ctx.plugin(tools.ToolRuntime, {})
    ctx.tools.register(probe)
    const result = await ctx.tools.execute({
      callId: 'probe', name: 'contract_probe',
      arguments: { a: 'x' }, signal: new AbortController().signal,
    })
    check('host/dsh-tools: ToolRuntime 执行结果携带 meta.diffs（结算态 diff 卡数据源）',
      result.isError !== true && result.meta !== undefined && JSON.stringify(result.meta).includes('diffs'),
      result.isError === true ? '执行报错' : '')
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
    typeof fsPkg.FsError === 'function' && typeof fsPkg.FsTargetKey === 'function' && fsPkg.FsVersion !== undefined)
} catch (error) {
  check('host/dsh-fs: 可加载', false, String(error instanceof Error ? error.message : error))
}

try {
  const sub = loadPkg('dsh-subprocess')
  check('host/dsh-subprocess: SubprocessRuntime 服务类导出',
    typeof sub.SubprocessRuntime === 'function')
} catch (error) {
  check('host/dsh-subprocess: 可加载', false, String(error instanceof Error ? error.message : error))
}

try {
  const typert = loadPkg('dsh-typert-protocol')
  check('host/dsh-typert-protocol: bindTypertRemote 导出',
    typeof typert.bindTypertRemote === 'function')
} catch (error) {
  check('host/dsh-typert-protocol: 可加载', false, String(error instanceof Error ? error.message : error))
}

for (const dep of ['dsh-settings', 'dsh-system-prompt', 'dsh-workspace', 'dsh-jobs']) {
  check(`host/${dep}: peer 可解析`, readPkg(dep) !== undefined)
}

// ------------------------------------------------------------ client 契约
// client 侧无法 require（浏览器 bundle），对 dist 做字符串契约探测。
// 包缺席 → SKIP（devDeps 只装 host 包）；在树但不可读 → FAIL。

const clientProbe = (name, id, assert) => {
  if (!existsSync(pkgDir(name))) {
    results.push({ id, ok: true, skip: true, detail: `client/${name} 不在本树（devDeps 仅 host 包）` })
    return
  }
  const text = distText(name, 'lib/client.js', 'lib/index.js')
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
]
for (const [pkg, key, note] of SLOT_KEYS) {
  clientProbe(pkg, `client/slot: ${key}（${note}）`, (t) =>
    t.includes(`"${key}"`) || t.includes(`'${key}'`) || t.includes(key))
}

clientProbe('dsh-client-ui-tool', 'client/ui-tool: edit/write 行按名分发（key "edit"/"write"）',
  (t) => t.includes('key: "edit"') && t.includes('key: "write"'))
clientProbe('dsh-client-ui-tool', 'client/ui-tool: 结算态 diff 需要 meta.diffs（v0.7.0 契约）',
  (t) => t.includes('meta.diffs') || /\.meta\b[\s\S]{0,80}\.diffs/.test(t) || t.includes('appliedDiffs'))
clientProbe('dsh-client-ui-tool', 'client/ui-tool: 运行态 diff 从参数推导（old_string/new_string）',
  (t) => t.includes('old_string') && t.includes('new_string'))
clientProbe('dsh-client-ui-workspace', 'client/ui-workspace: workspaces.rename（自动起名用）',
  (t) => t.includes('.rename(') || t.includes('renameWorkspace'))
clientProbe('dsh-client-ui-workspace', 'client/ui-workspace: 主会话判定 retainedBy.mainView',
  (t) => t.includes('retainedBy.mainView'))
clientProbe('dsh-client-ui-conversation', 'client/ui-conversation: input.for 会话寻址面',
  (t) => t.includes('input.for(') || t.includes('input.for ('))
clientProbe('dsh-client-ui-conversation', 'client/ui-conversation: insertText + draftRev CAS 草稿插入',
  (t) => t.includes('insertText') && t.includes('draftRev'))
clientProbe('dsh-api-session-controller', 'client/sessions: scope(id) 会话作用域',
  (t) => t.includes('scope(') || t.includes('scope ('))
clientProbe('dsh-api-session-controller', 'client/sessions: list store byId + retainedBy',
  (t) => t.includes('byId') && t.includes('retainedBy'))
clientProbe('dsh-client-ui-primitives', 'client/ui-primitives: PathLabel 导出（标签美化目标组件）',
  (t) => t.includes('PathLabel'))
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
