"use strict";
/*
 * Sandbox-safe validation of the BUILT plugin lib (no esbuild/vitest spawn):
 *  1. connectHttpProxy tunnels through a fake CONNECT proxy to an echo target.
 *  2. Non-200 CONNECT answers reject.
 *  3. CR/LF in the target host is rejected (request splitting).
 *  4. HostStore httpProxy write-only password semantics + redacted summary.
 * Run from the repo root:  node test-built-lib.mjs
 */
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { connectHttpProxy, routeFsPath, placeholderKeyFor, mapLocalTreeToRemote } from './lib/index.js'      // stable public re-export
import { readdirSync } from 'node:fs'
// HostStore lives in the hashed engine chunk — resolve it by pattern.
const engineChunk = readdirSync('./lib').find((f) => /^engine-.*\.js$/.test(f))
const { i: HostStore } = await import(`./lib/${engineChunk}`)

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

async function test1_tunnel() {
  const target = net.createServer((s) => s.on('data', (d) => s.write(d)))
  const targetPort = await listen(target)
  let seenAuth = ''
  const proxy = http.createServer((_q, res) => res.writeHead(500).end())
  proxy.on('connect', (req, clientSocket, head) => {
    seenAuth = String(req.headers['proxy-authorization'] ?? '')
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const up = net.connect(targetPort, '127.0.0.1')
    up.on('connect', () => { if (head.length) up.write(head); clientSocket.pipe(up); up.pipe(clientSocket) })
    up.on('error', () => clientSocket.destroy())
  })
  const proxyPort = await listen(proxy)
  try {
    const sock = await connectHttpProxy({ host: '127.0.0.1', port: proxyPort, username: 'u', password: 'p' }, 'target.example', 22, 5000)
    const echoed = await new Promise((resolve, reject) => {
      sock.once('error', reject)
      sock.once('data', (d) => resolve(d.toString()))
      sock.write('ping')
    })
    assert.equal(echoed, 'ping')
    assert.equal(seenAuth, `Basic ${Buffer.from('u:p', 'utf8').toString('base64')}`)
    sock.destroy()
  } finally { proxy.close(); target.close() }
}

async function test2_non200() {
  const proxy = http.createServer((_q, res) => res.writeHead(500).end())
  proxy.on('connect', (_q, cs) => { cs.write('HTTP/1.1 403 Denied\r\n\r\n'); cs.destroy() })
  const proxyPort = await listen(proxy)
  try {
    await connectHttpProxy({ host: '127.0.0.1', port: proxyPort }, 'target.example', 22, 5000)
    throw new Error('expected rejection')
  } catch (e) {
    assert.match(e.message, /403/)
  } finally { proxy.close() }
}

async function test3_crlf() {
  await assert.rejects(
    () => connectHttpProxy({ host: '127.0.0.1', port: 1 }, 'evil\r\nX: y', 22, 1000),
    /CR\/LF/,
  )
}

function test4_store() {
  const storePath = './.tmp-test-store.json'
  for (const p of [storePath, storePath + '.tmp']) { try { fs.unlinkSync(p) } catch { /* absent */ } }
  const store = new HostStore(storePath)
  store.upsert({ alias: 'a', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: { host: 'proxy', port: 8080, username: 'pu', password: 'pp' } })
  assert.deepEqual(store.get('a').httpProxy, { host: 'proxy', port: 8080, username: 'pu', password: 'pp' })
  store.upsert({ alias: 'a', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: { host: 'proxy2', port: 3128 } })
  assert.deepEqual(store.get('a').httpProxy, { host: 'proxy2', port: 3128, username: 'pu', password: 'pp' }, 'omitted password must inherit')
  store.upsert({ alias: 'a', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: null })
  assert.equal(store.get('a').httpProxy, undefined, 'null must clear')
  store.upsert({ alias: 'a', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: { host: 'p', port: 2, username: 'u1', password: 's3' } })
  assert.deepEqual(store.summarize(store.get('a')).httpProxy, { host: 'p', port: 2, hasAuth: true }, 'summary must not leak password')
  let threw = false
  try { store.upsert({ alias: 'a', host: 'h', port: 22, user: 'u', auth: { kind: 'password', password: 'x' }, httpProxy: { host: 'p\r\nX', port: 8080 } }) } catch { threw = true }
  assert.ok(threw, 'CR/LF in proxy host must throw')
}

function test5_seamRouting() {
  // 占位树文件级路由（侧边栏文件树 targetKey 的映射核心）。
  // 用确定性 DSH_REMOTE_ROOT + node:path 构造路径：平台中立（win32/posix 分隔符自适应）。
  const { encodeRemotePath } = { encodeRemotePath: (p) => Buffer.from(p, 'utf8').toString('base64url') }
  const prevRoot = process.env.DSH_REMOTE_ROOT
  const root = path.join(os.tmpdir(), 'dsh-seam-routing-test-root')
  process.env.DSH_REMOTE_ROOT = root
  try {
    const hostId = 'flex-1'
    const encodedRoot = encodeRemotePath('/home/u/proj')
    const placeholder = (...segments) => path.join(root, hostId, encodedRoot, ...segments)
    const remoteTree = mapLocalTreeToRemote(placeholder('src', 'main.py'))
    assert.ok(remoteTree, 'placeholder-tree path must route')
    assert.equal(remoteTree.hostId, hostId)
    assert.equal(remoteTree.remotePath, '/home/u/proj/src/main.py')
    assert.equal(remoteTree.remoteRootPath, '/home/u/proj')

    // 相对路径解析：cwd = 占位根。
    const route = routeFsPath('src/main.py', placeholder())
    assert.ok(route, 'relative path under placeholder cwd must route')
    assert.equal(route.hostId, hostId)
    assert.equal(route.remotePath, '/home/u/proj/src/main.py')
    // 绝对占位路径（侧边栏回传的树键形态）。
    const absRoute = routeFsPath(placeholder('src'), undefined)
    assert.equal(absRoute?.remotePath, '/home/u/proj/src')
    // 工作区外的远端绝对路径 → key 落到单独编码段（两段形态）。
    const outside = routeFsPath('/etc/hosts', placeholder())
    assert.equal(outside?.remotePath, '/etc/hosts')
    const outsideKey = placeholderKeyFor(outside, outside.remotePath)
    assert.equal(outsideKey, path.join(root, hostId, encodeRemotePath('/etc/hosts')))
    // 工作区内远端路径 → key = 占位 cwd + 相对（与 targetKey 往返一致）。
    const insideKey = placeholderKeyFor(route, route.remotePath)
    assert.equal(insideKey, placeholder('src', 'main.py'))
    // 普通本地路径不路由（透传本地实现）。
    const localDir = path.join(os.tmpdir(), 'dsh-seam-routing-local')
    assert.equal(routeFsPath('main.py', localDir), undefined)
    assert.equal(routeFsPath(path.join(localDir, 'main.py'), undefined), undefined)
    assert.equal(mapLocalTreeToRemote(root), null)
  } finally {
    if (prevRoot === undefined) delete process.env.DSH_REMOTE_ROOT
    else process.env.DSH_REMOTE_ROOT = prevRoot
  }
}

const tests = [
  ['connectHttpProxy tunnels + auth', test1_tunnel],
  ['non-200 CONNECT rejects', test2_non200],
  ['CR/LF target host rejected', test3_crlf],
  ['HostStore httpProxy semantics', test4_store],
  ['fs seam path routing', test5_seamRouting],
]
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS  ${name}`) } catch (e) { failed++; console.log(`FAIL  ${name} — ${e.message}`) }
}
process.exit(failed === 0 ? 0 : 1)
