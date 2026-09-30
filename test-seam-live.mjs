"use strict";
/*
 * 真机验证：侧边栏 seam 的两条远程通路（对 store 里的 flex-1 执行）。
 *  [T] terminal seam — spawnSshTerminal(argv: []) 打开远端登录 shell：
 *      marker 引导、cd 到工作区、write 回显、resize、inspectActivity、
 *      output 异步迭代（控制器消费方式）、terminate 仲裁清理。
 *  [F] fs seam — 与 seam-fs 完全相同的 SFTP 调用形态：stat/lstat/readdir/
 *      readFile + 类型位判定。
 * 运行：node test-seam-live.mjs [alias]（默认 flex-1；需要 ~/.dsh 主机可连）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSshTerminal } from './lib/subprocess-ssh.js'

const ALIAS = process.argv[2] ?? 'flex-1'
const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')
const storeHosts = JSON.parse(readFileSync(storePath, 'utf8')).hosts ?? []
const entry = storeHosts.find(h => h.alias === ALIAS)
if (entry === undefined) { console.error(`no host "${ALIAS}" in store`); process.exit(1) }

const engineChunk = readdirSync('./lib').find(f => /^engine-.*\.js$/.test(f))
const { i: HostStore, t: SshEngine } = await import(`./lib/${engineChunk}`)
const engine = new SshEngine(new HostStore(storePath))

const HOME = (await engine.exec(ALIAS, 'printf %s "$HOME"')).stdout.trim()
const WS = HOME // 以远端 home 作为“工作区”做验证
console.log(`target: ${ALIAS} ${entry.host}:${entry.port} home=${HOME}`)

const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
])

// ------------------------------------------------------------------ [T]
// 以 engine 上的连接语义复刻 seam-terminal 的调用（SshConnection 形状）：
async function openRemoteTerminal() {
  const connection = {
    exec: (command, options) => engine.exec(ALIAS, command, options),
    execChannel: (command, options) => engine.openChannel(ALIAS, command, options),
    openShell: (cols, rows) => engine.openShell(ALIAS, cols, rows),
    ls: (path) => engine.ls(ALIAS, path),
    getSftp: () => engine.getSftp(ALIAS),
  }
  return spawnSshTerminal(
    connection,
    {
      argv: [],                 // ← 侧边栏路由形态：远端登录 shell
      cwd: WS,                  // ← cd 到“工作区”
      rows: 30, cols: 100,
      terminalType: 'xterm-256color',
      graceMs: 5000,
    },
    posix.join('/tmp', 'dsh-ssh-terminals', randomUUID()),
    100,
  )
}

async function runTerminalChecks() {
  const handle = await withTimeout(openRemoteTerminal(), 30_000, 'terminal bootstrap')
  let output = ''
  const collecting = (async () => {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    for await (const chunk of handle.output) {
      output += decoder.decode(chunk, { stream: true })
    }
  })()
  // 等 shell 提示符就绪后交互。
  await new Promise(r => setTimeout(r, 1200))
  await withTimeout(handle.write('printf "SEAM_PWD=%s\\n" "$(pwd)"\n'), 10_000, 'write')
  await new Promise(r => setTimeout(r, 1500))
  assert.match(output, new RegExp(`SEAM_PWD=${WS.replace(/\//g, '\\/')}`), 'login shell must start in the workspace')
  await withTimeout(handle.resize(120, 40), 10_000, 'resize')
  const activity = await handle.inspectActivity()
  assert.equal(activity.state, 'unknown')
  assert.ok(handle.pid > 0, 'pid published')
  await withTimeout(handle.terminate(), 30_000, 'terminate')
  await withTimeout(collecting, 15_000, 'output end after terminate')
  const outcome = await withTimeout(handle.done, 15_000, 'done settles')
  assert.ok(outcome.exitCode === null || typeof outcome.exitCode === 'number', 'outcome carries exitCode')
  console.log(`PASS  terminal seam (pid=${handle.pid}, cwd=${WS}, exit=${outcome.exitCode}, output ${output.length} bytes)`)
}

// ------------------------------------------------------------------ [F]
async function runFsChecks() {
  const sftp = await engine.getSftp(ALIAS)
  const call = (invoke) => new Promise((resolve, reject) => invoke((err, value) => { if (err) reject(err); else resolve(value) }))
  // stat / lstat / readdir / readFile —— seam-fs 的调用形态
  const stats = await call(cb => sftp.stat(WS, cb))
  assert.ok(stats.isDirectory(), 'stat(workspace) is a directory')
  const kind = stats.mode & 0o170000
  assert.equal(kind, 0o040000, 'mode type bits: directory')
  const listed = await call(cb => sftp.readdir(WS, cb))
  assert.ok(Array.isArray(listed) && listed.length > 0, 'readdir returns entries')
  const entryTypes = listed.map(e => e.attrs.mode & 0o170000)
  assert.ok(entryTypes.every(k => [0o040000, 0o100000, 0o120000].includes(k)), 'entry mode kinds map to file/dir/symlink')
  // 读一个真实文本文件（远程 /etc/hostname 一定存在且是文本）
  const hostname = await call(cb => sftp.readFile('/etc/hostname', cb))
  assert.ok(hostname.length > 0 && !hostname.subarray(0, 256).includes(0), 'readFile returns text bytes')
  // 缺失路径 → stat 抛错且消息可判 not-found（seam-fs 靠它返回 undefined）
  let missing = false
  try { await call(cb => sftp.stat('/definitely/not/here', cb)) } catch (e) { missing = /no such file/i.test(e.message) }
  assert.ok(missing, 'missing path rejects with no-such-file')
  console.log(`PASS  fs seam SFTP shapes (readdir ${listed.length} entries, hostname=${hostname.toString().trim().slice(0, 30)})`)
}

let failed = 0
try { await runTerminalChecks() } catch (e) { failed++; console.log(`FAIL  terminal seam — ${e.message}`) }
try { await runFsChecks() } catch (e) { failed++; console.log(`FAIL  fs seam — ${e.message}`) }
engine.dispose()
process.exit(failed === 0 ? 0 : 1)
