/**
 * 离线复现侧栏文件树 not-found：按 seam-fs 完全相同的调用链，
 * 用构建产物的引擎 + 路由纯函数对 MANote-W8-00 的真实占位路径走一遍。
 * 用法：node repro-sidebar-notfound.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mapLocalTreeToRemote, routeFsPath, routeFsTarget, placeholderKeyFor } from './lib/index.js'

const ALIAS = 'MANote-W8-00'
const PLACEHOLDER = 'C:\\Users\\x00968307\\.dsh\\remote\\MANote-W8-00\\L2hvbWUvbWEtdXNlci94MDA5NjgzMDc'
const storePath = join(homedir(), '.dsh', 'dsh-remote-ide.json')

// ---- 1) 纯函数路由（与 seam 完全一致）
const mapped = mapLocalTreeToRemote(PLACEHOLDER)
console.log('[1] mapLocalTreeToRemote:', JSON.stringify(mapped))
const route = routeFsPath('', PLACEHOLDER) // 侧栏根：path='' cwd=占位
console.log('[2] routeFsPath("", placeholder):', JSON.stringify(route))
const target = { targetKey: PLACEHOLDER, displayPath: PLACEHOLDER }
console.log('[3] routeFsTarget(root):', JSON.stringify(routeFsTarget(target)))

// ---- 2) 引擎连接 + SFTP（与 seam 的 sftpFor/stat/lstat/readdir 完全同形）
const storeHosts = JSON.parse(readFileSync(storePath, 'utf8')).hosts ?? []
const entry = storeHosts.find(h => h.alias === ALIAS)
console.log('[4] store entry:', JSON.stringify({ alias: entry?.alias, host: entry?.host, port: entry?.port, auth: entry?.auth?.kind, proxyJump: entry?.proxyJump?.length, httpProxy: entry?.httpProxy ? 'yes' : 'no' }))

const engineChunk = readdirSync('./lib').find(f => /^engine-.*\.js$/.test(f))
const { i: HostStore, t: SshEngine } = await import(`./lib/${engineChunk}`)
const engine = new SshEngine(new HostStore(storePath))

const sftpCall = (invoke) => new Promise((resolve, reject) => {
  invoke((error, value) => { if (error !== undefined && error !== null) reject(error); else resolve(value) })
})

const sftp = await engine.getSftp(ALIAS)
console.log('[5] SFTP ready')
const path = route?.remotePath ?? '/home/ma-user/x00968307'
try {
  const stats = await sftpCall(cb => sftp.lstat(path, cb))
  console.log('[6] SFTP lstat OK:', JSON.stringify({ size: stats.size, mtime: stats.mtime, mode: stats.mode?.toString(8) }))
} catch (error) {
  console.log('[6] SFTP lstat FAILED:', error?.message ?? String(error))
}
try {
  const listed = await sftpCall(cb => sftp.readdir(path, cb))
  console.log('[7] SFTP readdir OK:', listed.length, 'entries,', listed.slice(0, 5).map(e => e.filename).join(', '), '...')
} catch (error) {
  console.log('[7] SFTP readdir FAILED:', error?.message ?? String(error))
}
process.exit(0)
