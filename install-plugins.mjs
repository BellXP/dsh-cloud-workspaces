"use strict";
/*
 * dsh 三插件通用远程部署器（任意 store 内主机，Linux/macOS）。
 *
 * 幂等：dsh 已装则跳过、仓库已存在则 fetch+reset（升级即重跑）、
 * 依赖/构建/布线/注册全程可重入；结束前可选无头启动冒烟（client.js 200
 * = 插件已加载，登录前即可验证）。
 *
 * 用法：
 *   node install-plugins.mjs <hostAlias> [选项]
 * 选项：
 *   --port N          冒烟端口（默认 8123）
 *   --dir PATH        插件部署目录（默认 $HOME/dsh-plugins）
 *   --dsh-version V   全局安装的 dsh 版本（默认 0.2.0-rc.2）
 *   --registry URL    npm 镜像（默认 npmmirror）
 *   --branch R=B      覆盖仓库 R 的分支（如 --branch dsh-cloud-workspaces=main）
 *   --keep-running    冒烟后不杀 dsh web
 *   --skip-boot-test  跳过启动冒烟
 * 示例：
 *   node install-plugins.mjs flex-1
 *   node install-plugins.mjs MANote-W8-00 --port 8200 --keep-running
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ------------------------------------------------------------------ 参数
const args = process.argv.slice(2)
const ALIAS = args.find((a) => !a.startsWith('--'))
if (ALIAS === undefined) { console.error('用法: node install-plugins.mjs <hostAlias> [--port N] [--dir PATH] [--dsh-version V] [--registry URL] [--branch repo=branch] [--keep-running] [--skip-boot-test]'); process.exit(1) }
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const PORT = flag('port', '8123')
const DSH_VERSION = flag('dsh-version', '0.2.0-rc.2')
const REGISTRY = flag('registry', 'https://registry.npmmirror.com')
const KEEP = args.includes('--keep-running')
const SKIP_BOOT = args.includes('--skip-boot-test')
const BRANCH_OVERRIDES = Object.fromEntries(args.filter((a) => a.startsWith('--branch=')).map((a) => a.slice(9).split('=')))
for (let i = args.indexOf('--branch'); i !== -1; i = args.indexOf('--branch', i + 1)) {
  const pair = args[i + 1]
  if (pair !== undefined && pair.includes('=')) { const [r, b] = pair.split('='); BRANCH_OVERRIDES[r] = b }
}

const REPOS = [
  { name: 'dsh-cloud-workspaces', url: 'https://github.com/BellXP/dsh-cloud-workspaces', branch: 'fork/dsh-0.1.7', build: true },
  { name: 'dsh-session-manager', url: 'https://github.com/BellXP/dsh-session-manager', branch: 'main', linkDeps: true },
  { name: 'dsh-solarized-themes', url: 'https://github.com/BellXP/dsh-solarized-themes', branch: 'main' },
]
for (const repo of REPOS) if (BRANCH_OVERRIDES[repo.name] !== undefined) repo.branch = BRANCH_OVERRIDES[repo.name]

// ------------------------------------------------------------------ 引擎
const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')
const rawStore = JSON.parse(readFileSync(storePath, 'utf8'))
const entry = (rawStore.hosts ?? []).find?.((h) => h.alias === ALIAS) ?? (rawStore.hosts ?? {})[ALIAS]
if (entry === undefined) { console.error(`store 中没有主机 "${ALIAS}"`); process.exit(1) }

const engineChunk = readdirSync('./lib').find(f => /^engine-.*\.js$/.test(f))
const { i: HostStore, t: SshEngine } = await import(`./lib/${engineChunk}`)
const engine = new SshEngine(new HostStore(storePath))

let failed = 0
const run = async (label, command, { timeoutMs = 60_000, critical = true } = {}) => {
  console.log(`\n===== ${label} =====`)
  const r = await engine.exec(ALIAS, command, { timeoutMs })
  if (r.stdout !== '') console.log(r.stdout.replace(/\n$/, '').slice(0, 4000))
  if (r.stderr !== '') console.log(`[stderr] ${r.stderr.slice(0, 600).replace(/\n$/, '')}`)
  if (!r.success || r.timedOut) {
    console.log(`[exit=${r.exitCode} timedOut=${r.timedOut}]`)
    if (critical) { console.error(`✘ 阶段失败：${label}`); failed += 1 }
  }
  return r
}
const out = async (command, timeoutMs = 30_000) => (await engine.exec(ALIAS, command, { timeoutMs })).stdout.trim()

console.log(`部署目标: ${ALIAS} → ${entry.host}:${entry.port}（${entry.user}）`)

// ------------------------------------------------- 1) node（缺失则自举）
let HOME = await out('printf %s "$HOME"')
console.log(`HOME=${HOME}`)
const DEPLOY_DIR = flag('dir', `${HOME}/dsh-plugins`).replace(/^~/, HOME)
let nodeOk = (await out('node -v 2>/dev/null || true')) !== ''
if (!nodeOk) {
  await run('node 自举（npmmirror，arch 自适应）', [
    'set -e',
    'arch=$(uname -m) && [ "$arch" = "x86_64" ] && arch=x64 || arch=arm64',
    `curl -fsSL -o /tmp/node-dist.tar.xz "https://cdn.npmmirror.com/binaries/node/v22.20.0/node-v22.20.0-linux-$arch.tar.xz"`,
    'mkdir -p /usr/local/node && tar -xJf /tmp/node-dist.tar.xz -C /usr/local/node --strip-components=1',
    'for b in node npm npx; do ln -sf /usr/local/node/bin/$b /usr/local/bin/$b; done',
    'rm -f /tmp/node-dist.tar.xz',
    'node -v && npm -v',
  ].join('\n'), { timeoutMs: 5 * 60_000 })
  nodeOk = true
}

// ------------------------------------------- 2) dsh + pnpm（缺失则安装+PATH）
// npm 全局前缀因机而异（nvm/.npm-global/系统目录）——一切以 `npm prefix -g` 为准。
let NPM_BIN = await out('npm prefix -g 2>/dev/null').then(p => (p === '' ? '' : `${p}/bin`))
await run('dsh 检测/安装', `export PATH="${NPM_BIN}:$PATH"; if command -v dsh >/dev/null 2>&1; then dsh --version; else npm install -g @deepseek-ai/dsh@${DSH_VERSION} --registry=${REGISTRY} --no-audit --no-fund --loglevel=error 2>&1 | tail -3; dsh --version; fi`,
  { timeoutMs: 15 * 60_000 })
await run('pnpm 检测/安装（dsh plugin 命令的前置）', `export PATH="${NPM_BIN}:$PATH"; if command -v pnpm >/dev/null 2>&1; then pnpm --version; else npm install -g pnpm --registry=${REGISTRY} --no-audit --no-fund --loglevel=error 2>&1 | tail -2; pnpm --version; fi`,
  { timeoutMs: 5 * 60_000 })
// 清理可能残留的悬空 /usr/local/bin/dsh（此前脚本假设前缀造成的），再正确链接。
await run('dsh PATH 修复', `export PATH="${NPM_BIN}:$PATH"
[ -L /usr/local/bin/dsh ] && [ ! -e /usr/local/bin/dsh ] && rm -f /usr/local/bin/dsh || true
if command -v dsh >/dev/null 2>&1 && [ -w /usr/local/bin ] && [ "${NPM_BIN}" != "/usr/local/bin" ]; then ln -sf "${NPM_BIN}/dsh" /usr/local/bin/dsh 2>/dev/null || true; fi
command -v dsh && dsh --version`)
const DSH_ENV = `export PATH="${NPM_BIN}:$PATH"`

// --------------------------------------------------- 3) 仓库（clone/更新）
await run('部署目录', `mkdir -p ${DEPLOY_DIR} && echo ok`)
for (const repo of REPOS) {
  const dir = `${DEPLOY_DIR}/${repo.name}`
  const r = await run(`仓库 ${repo.name}@${repo.branch}`,
    `if [ -d ${dir}/.git ]; then git -C ${dir} fetch -q origin && git -C ${dir} reset -q --hard origin/${repo.branch} && git -C ${dir} clean -qfd; else git clone -q -b ${repo.branch} ${repo.url} ${dir}; fi && git -C ${dir} log --oneline -1`,
    { timeoutMs: 5 * 60_000 })
  if (!r.success) process.exit(1)
}

// ------------------------------------- 4) 依赖：构建型 / link 型 / 无依赖
const cloud = `${DEPLOY_DIR}/dsh-cloud-workspaces`
await run('cloud-workspaces: npm install', `cd ${cloud} && npm install --legacy-peer-deps --no-audit --no-fund --loglevel=error --registry=${REGISTRY} 2>&1 | tail -3`, { timeoutMs: 10 * 60_000 })
await run('cloud-workspaces: 构建（tsc + tsdown）', `cd ${cloud} && npm run build 2>&1 | tail -4 && ls lib/index.js`, { timeoutMs: 5 * 60_000 })

const sm = `${DEPLOY_DIR}/dsh-session-manager`
// link-dsh-deps.sh：优先 autodetect（能找到扁平的 dsh 安装树；npm -g 的嵌套布局
// <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/... 不是它的约定形态）。
// 事后校验链接确实可解析，断链才报错。
await run('session-manager: link-dsh-deps（autodetect）',
  `cd ${sm} && bash scripts/link-dsh-deps.sh 2>&1 | tail -4`)
await run('session-manager: 链接校验', `test -e ${sm}/node_modules/@deepseek-ai/dsh-typert-protocol && echo "链接可用: $(readlink ${sm}/node_modules/@deepseek-ai)" || echo 链接断裂`)

// ------------------------------------------------------- 5) 注册进 profile
for (const repo of REPOS) {
  await run(`注册 ${repo.name}`, `${DSH_ENV}; dsh plugin --profile web add link:${DEPLOY_DIR}/${repo.name} 2>&1 | tail -3`)
}
await run('profile 清单', `cat ${HOME}/.dsh/profiles/web/package.json 2>/dev/null | head -40`)

// ------------------------------------------------------ 6) 启动冒烟（可选）
// pkill 必须与启动**分阶段**执行：启动命令自身含 "dsh web" 字样，同一条命令里
// pkill 会把承载它的远程 shell 一起杀掉（两次真机踩坑）。括号技巧只在纯 kill
// 阶段有效（命令里不含明文 "dsh web"）。
if (!SKIP_BOOT) {
  await run('清理旧实例', `pkill -f "[d]sh web" 2>/dev/null; sleep 1; echo cleaned`)
  await run(`dsh web --port ${PORT} 启动`, `${DSH_ENV}; nohup dsh web --port ${PORT} >/tmp/dsh-plugin-smoke.log 2>&1 & sleep 9; echo started`)
  // 0.2.0 起根路径带鉴权：从启动日志取 token → 换会话 cookie（303 重定向，须 -L）
  // → boot 清单里应含每个插件的 <id>/client.js。
  await run('client bundle 加载验证（token + boot 清单）', `
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /tmp/dsh-plugin-smoke.log | head -1 | cut -d= -f2)
if [ -z "$TOKEN" ]; then echo '无 token（鉴权未开？）'; CODE=$(curl -s -o /tmp/dsh-smoke-root.html -w '%{http_code}' http://127.0.0.1:${PORT}/); echo "plain /: $CODE"; else
  curl -sL -c /tmp/dsh-smoke-cookies -o /tmp/dsh-smoke-root.html -w '首页: %{http_code} %{size_download}B\\n' "http://127.0.0.1:${PORT}/?token=$TOKEN"
fi
for p in ${REPOS.map(r => r.name).join(' ')}; do printf '%s: ' $p; grep -q "$p/client.js" /tmp/dsh-smoke-root.html && echo LOADED || echo MISSING; done`)
  await run('启动日志关键行', `grep -E 'skipping profile bundle|host half loaded|error|Error' /tmp/dsh-plugin-smoke.log | head -12; true`)
  if (!KEEP) {
    await run('停止冒烟实例', `pkill -f "[d]sh web" 2>/dev/null; sleep 1; echo stopped`)
  } else {
    console.log(`\n（--keep-running：dsh web --port ${PORT} 保持运行——从日志取 token URL 访问：grep -oE 'http[^ ]+token=[^ ]+' /tmp/dsh-plugin-smoke.log）`)
  }
}

console.log(`\n${failed === 0 ? '✔ 部署完成（请核对上方各阶段输出）' : `✘ ${failed} 个阶段失败`}`)
process.exit(failed === 0 ? 0 : 1)
