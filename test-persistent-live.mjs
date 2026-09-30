"use strict";
/*
 * 真机验证：常驻 shell 会话（B 方案）。对 store 里的主机（默认 flex-1）验证：
 *  [1] 初始 cwd / cd 持久化 / 显式 workdir 覆盖 / 无 workdir 沿用当前目录
 *  [2] 环境变量跨命令持久（export → echo）
 *  [3] stdout/stderr 分离 + 无换行结尾的精确字节 + 多行脚本
 *  [4] 退出码传播（子 shell exit 7）
 *  [5] 超时 → 杀通道 → 下一条命令自动重建并恢复目录
 *  [6] 性能：热连接一次性 exec vs 常驻 shell 的每命令延迟
 * 运行：node test-persistent-live.mjs [alias]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const ALIAS = process.argv[2] ?? 'flex-1'
const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')
// 解析当前构建真正引用的 engine chunk（入口 ssh-service.js 的 import 为准）。
const sshService = readFileSync('./lib/ssh-service.js', 'utf8')
const engineChunk = /engine-[A-Za-z0-9_-]+\.js/.exec(sshService)?.[0]
if (engineChunk === undefined) { console.error('cannot resolve engine chunk'); process.exit(1) }
const { i: HostStore, t: SshEngine } = await import(`./lib/${engineChunk}`)
const engine = new SshEngine(new HostStore(storePath))

const HOME = (await engine.exec(ALIAS, 'printf %s "$HOME"')).stdout.trim()
console.log(`target: ${ALIAS}, home=${HOME}`)
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
])

let failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`) }
  catch (e) { failed++; console.log(`FAIL  ${name} — ${e.message}`) }
}

const shell = await withTimeout(engine.openShellSession(ALIAS, { initialCwd: HOME }), 30_000, 'open')

await check('initial cwd + cd/env persistence + workdir override', async () => {
  const pwd1 = await shell.run('pwd')
  assert.equal(pwd1.exitCode, 0)
  assert.equal(pwd1.stdout.trim(), HOME)
  await shell.run('export DSH_PERSIST_TEST=hello42')
  await shell.run('cd /tmp')
  const pwd2 = await shell.run('pwd')
  assert.equal(pwd2.stdout.trim(), '/tmp', 'cd must persist')
  const env = await shell.run('echo $DSH_PERSIST_TEST')
  assert.equal(env.stdout.trim(), 'hello42', 'export must persist')
  const forced = await shell.run('pwd', { cwd: '/etc' })
  assert.equal(forced.stdout.trim(), '/etc', 'explicit cwd must force cd')
  const after = await shell.run('pwd')
  assert.equal(after.stdout.trim(), '/etc', 'forced cwd must stick afterwards')
})

await check('stdout/stderr separation + exact bytes + multiline', async () => {
  const r = await shell.run('echo out; echo err 1>&2; printf tail-no-newline')
  assert.equal(r.exitCode, 0)
  assert.equal(r.stdout, 'out\ntail-no-newline')
  assert.equal(r.stderr, 'err\n')
  const multi = await shell.run('for i in 1 2 3; do echo line$i; done')
  assert.equal(multi.stdout, 'line1\nline2\nline3\n')
})

await check('exit code propagation', async () => {
  const r = await shell.run('bash -c "exit 7"')
  assert.equal(r.exitCode, 7)
  assert.equal(r.success, false)
  // shell 本身仍然活着
  const alive = await shell.run('echo alive')
  assert.equal(alive.stdout.trim(), 'alive')
})

await check('timeout kills channel, next command rebuilds + resumes cwd', async () => {
  const started = Date.now()
  const r = await shell.run('sleep 10', { timeoutMs: 1500 })
  const elapsed = Date.now() - started
  assert.equal(r.timedOut, true)
  assert.ok(elapsed < 4000, `timeout should settle near 1.5s, took ${elapsed}ms`)
  const back = await shell.run('pwd && echo revived')
  assert.equal(back.exitCode, 0)
  assert.match(back.stdout, /revived/)
  assert.match(back.stdout, /etc/, 'cwd must resume after rebuild')
})

await check('performance: persistent vs one-shot exec', async () => {
  const oneShot = []
  for (let i = 0; i < 5; i++) { const s = Date.now(); await engine.exec(ALIAS, 'true'); oneShot.push(Date.now() - s) }
  const persist = []
  for (let i = 0; i < 5; i++) { const s = Date.now(); await shell.run('true'); persist.push(Date.now() - s) }
  const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
  console.log(`      one-shot avg ${avg(oneShot)} ms  vs  persistent avg ${avg(persist)} ms`)
  assert.ok(avg(persist) < avg(oneShot), 'persistent should be faster than one-shot exec')
})

await shell.dispose()
engine.dispose()
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
