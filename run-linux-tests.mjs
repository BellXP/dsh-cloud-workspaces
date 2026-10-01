"use strict";
/*
 * Linux 真机验证（POSIX 泛化的实测面）：把本仓库 git archive 打包 → SFTP 上传到
 * flex-1（经引擎，含 HTTP 代理链）→ npm install（npmmirror）→ vitest 全量 →
 * 契约探针。运行：node run-linux-tests.mjs [alias]（默认 flex-1）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ALIAS = process.argv[2] ?? 'flex-1'
const REMOTE_DIR = '/tmp/dcw-linux-test'
const TARBALL = 'dcw-linux-test.tar.gz'

const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')
const entry = JSON.parse(readFileSync(storePath, 'utf8')).hosts?.find?.(h => h.alias === ALIAS)
  ?? JSON.parse(readFileSync(storePath, 'utf8')).hosts?.[ALIAS]
if (entry === undefined) { console.error(`no host "${ALIAS}" in store`); process.exit(1) }

const engineChunk = readdirSync('./lib').find(f => /^engine-.*\.js$/.test(f))
const { i: HostStore, t: SshEngine } = await import(`./lib/${engineChunk}`)
const engine = new SshEngine(new HostStore(storePath))

const run = async (label, command, timeoutMs = 60_000) => {
  console.log(`\n===== ${label} =====`)
  const result = await engine.exec(ALIAS, command, { timeoutMs })
  if (result.stdout !== '') console.log(result.stdout.replace(/\n$/, ''))
  if (result.stderr !== '') console.log(`[stderr] ${result.stderr.slice(0, 2000).replace(/\n$/, '')}`)
  if (!result.success && !result.timedOut) console.log(`[exit ${result.exitCode}]`)
  return result
}

// 0) 环境探测
const probe = await run('环境探测', 'node -v && npm -v && df -h /tmp | tail -1 && (corepack --version 2>/dev/null || echo no-corepack)')
const nodeVer = probe.stdout.split('\n')[0] ?? ''
console.log(`\n→ 目标: ${entry.host}:${entry.port}  node=${nodeVer}`)

// 0.5) node 自举：裸容器缺 node 时从 npmmirror 装 v22 到 /usr/local（需 root；
//      x86_64 + glibc 已在探测期确认；xz 解压用 tar -xJ）。
if (!nodeVer.startsWith('v')) {
  console.log('\n→ 未找到 node，自举 v22.20.0（npmmirror）…')
  const boot = await run('node 自举', [
    'set -e',
    'arch=$(uname -m) && [ "$arch" = "x86_64" ] && arch=x64 || arch=arm64',
    'curl -fsSL -o /tmp/node-dist.tar.xz "https://cdn.npmmirror.com/binaries/node/v22.20.0/node-v22.20.0-linux-$arch.tar.xz"',
    'mkdir -p /usr/local/node && tar -xJf /tmp/node-dist.tar.xz -C /usr/local/node --strip-components=1',
    'ln -sf /usr/local/node/bin/node /usr/local/bin/node',
    'ln -sf /usr/local/node/bin/npm /usr/local/bin/npm',
    'ln -sf /usr/local/node/bin/npx /usr/local/bin/npx',
    'rm -f /tmp/node-dist.tar.xz',
    'node -v && npm -v',
  ].join('\n'), 5 * 60_000)
  if (!/v\d+\./.test(boot.stdout)) { console.error('node 自举失败，终止'); process.exit(1) }
}

// 1) 本地打包（干净树：HEAD，不带工作区杂物）
execFileSync('git', ['archive', '--format=tar.gz', '-o', TARBALL, 'HEAD'], { cwd: process.cwd() })
console.log(`\n本地打包完成: ${TARBALL}`)

// 2) 上传（SFTP fastPut，二进制安全）
const sftp = await engine.getSftp(ALIAS)
await new Promise((resolve, reject) => {
  sftp.fastPut(join(process.cwd(), TARBALL), `/tmp/${TARBALL}`, (error) => {
    if (error) reject(error); else resolve(undefined)
  })
})
rmSync(TARBALL)
console.log('上传完成 →', `/tmp/${TARBALL}`)

// 3) 解包
await run('解包', `rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR} && tar xzf /tmp/${TARBALL} -C ${REMOTE_DIR} && ls ${REMOTE_DIR} | head -5`)

// 4) 安装（npmmirror；engines 仅警告）
const install = await run('npm install（npmmirror，可能数分钟）',
  `cd ${REMOTE_DIR} && npm install --legacy-peer-deps --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com 2>&1 | tail -5`,
  20 * 60_000)
if (!install.success) { console.error('安装失败，终止'); process.exit(1) }

// 5) vitest 全量
const tests = await run('vitest 全量（POSIX 真机）',
  `cd ${REMOTE_DIR} && node node_modules/vitest/vitest.mjs run 2>&1 | tail -80`, 10 * 60_000)

// 6) 契约探针（对刚装出的树）
await run('契约探针（远端树）', `cd ${REMOTE_DIR} && node scripts/check-dsh-contract.mjs 2>&1 | head -40`)

// 7) 汇总 + 清理
const pass = /Tests\s+\d+ passed/.test(tests.stdout) && !/Tests\s+\d+ failed/.test(tests.stdout)
await run('清理', `rm -rf ${REMOTE_DIR} /tmp/${TARBALL}`)
console.log(`\n${pass ? '✔ LINUX 真机验证通过' : '✘ 有失败，见上方输出'}`)
process.exit(pass ? 0 : 1)
