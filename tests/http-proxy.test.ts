/**
 * HTTP CONNECT proxy support: the dial helper (connectHttpProxy) and the
 * store's write-only httpProxy credential semantics.
 */
import { describe, expect, it } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import { connectHttpProxy } from '../src/engine'
import { HostStore } from '../src/store'
import type { SshHostEntry } from '../src/protocol'

function makeEntry(patch: Partial<SshHostEntry>): SshHostEntry {
  return {
    alias: 't', host: 'example', port: 22, user: 'u',
    auth: { kind: 'key', keyPath: '/k' }, proxyJump: [], tags: [],
    createdAt: 0, updatedAt: 0, ...patch,
  }
}

describe('connectHttpProxy', () => {
  it('tunnels through a CONNECT proxy and reaches the target', async () => {
    // Target: a plain TCP echo server.
    const target = net.createServer((s) => s.on('data', (d) => s.write(d)))
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    const targetPort = (target.address() as net.AddressInfo).port

    // Fake CONNECT proxy: requires Basic auth, relays after "200".
    let seenAuth = ''
    const proxy = http.createServer((_req, res) => res.writeHead(500).end())
    proxy.on('connect', (req, clientSocket, head) => {
      seenAuth = String(req.headers['proxy-authorization'] ?? '')
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const upstream = net.connect(targetPort, '127.0.0.1')
      upstream.on('connect', () => {
        if (head.length) upstream.write(head)
        clientSocket.pipe(upstream)
        upstream.pipe(clientSocket)
      })
      upstream.on('error', () => clientSocket.destroy())
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const sock = await connectHttpProxy(
      { host: '127.0.0.1', port: proxyPort, username: 'u', password: 'p' },
      'target.example', 22, 5000,
    )
    const echoed = await new Promise<string>((resolve, reject) => {
      sock.once('error', reject)
      sock.once('data', (d) => resolve(d.toString()))
      sock.write('ping')
    })
    expect(echoed).toBe('ping')
    expect(seenAuth).toBe(`Basic ${Buffer.from('u:p', 'utf8').toString('base64')}`)
    sock.destroy()
    proxy.close()
    target.close()
  })

  it('rejects on a non-200 CONNECT answer', async () => {
    const proxy = http.createServer((_req, res) => res.writeHead(500).end())
    proxy.on('connect', (_req, clientSocket) => {
      clientSocket.write('HTTP/1.1 403 Denied\r\n\r\n')
      clientSocket.destroy()
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const proxyPort = (proxy.address() as net.AddressInfo).port

    await expect(connectHttpProxy(
      { host: '127.0.0.1', port: proxyPort }, 'target.example', 22, 5000,
    )).rejects.toThrow(/403/)
    proxy.close()
  })

  it('refuses CR/LF in the target host (request splitting)', async () => {
    await expect(connectHttpProxy(
      { host: '127.0.0.1', port: 1 }, 'evil\r\nX: y', 22, 1000,
    )).rejects.toThrow(/CR\/LF/)
  })
})

describe('HostStore httpProxy persistence', () => {
  it('keeps the stored password when an update omits it, clears on null', () => {
    const store = new HostStore(':memory:')
    store.upsert(makeEntry({}) as never, undefined)
    // Direct payload calls with a synthetic entry shape:
    store.upsert({
      alias: 'a', host: 'h', user: 'u',
      auth: { kind: 'password', password: 'sshpw' },
      httpProxy: { host: 'proxy', port: 8080, username: 'pu', password: 'pp' },
    })
    expect(store.get('a')?.httpProxy).toEqual({ host: 'proxy', port: 8080, username: 'pu', password: 'pp' })
    // Omitted password inherits; omitted object keeps whole proxy.
    store.upsert({ alias: 'a', host: 'h', user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: { host: 'proxy2', port: 3128 } })
    expect(store.get('a')?.httpProxy).toEqual({ host: 'proxy2', port: 3128, username: 'pu', password: 'pp' })
    store.upsert({ alias: 'a', host: 'h', user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: { host: 'proxy3', port: 1 } })
    expect(store.get('a')?.httpProxy).toEqual({ host: 'proxy3', port: 1, username: 'pu', password: 'pp' })
    // null clears.
    store.upsert({ alias: 'a', host: 'h', user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: null })
    expect(store.get('a')?.httpProxy).toBeUndefined()
    // Summary never leaks the password.
    const summary = store.summarize(store.get('a')!)
    expect(summary.httpProxy).toBeUndefined()
    store.upsert({ alias: 'a', host: 'h', user: 'u', auth: { kind: 'password', password: 'sshpw' }, httpProxy: { host: 'p', port: 2, username: 'u1', password: 's3' } })
    expect(store.summarize(store.get('a')!).httpProxy).toEqual({ host: 'p', port: 2, hasAuth: true })
  })

  it('rejects CR/LF in proxy fields', () => {
    const store = new HostStore(':memory:')
    expect(() => store.upsert({
      alias: 'a', host: 'h', user: 'u', auth: { kind: 'password', password: 'x' },
      httpProxy: { host: 'p\r\nX', port: 8080 },
    })).toThrow(/CR\/LF/)
  })
})
