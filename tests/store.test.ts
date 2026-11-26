/**
 * HostStore unit tests: CRUD, persistence, ssh-config parsing, secret-free
 * summaries. Uses a temp store file so the real ~/.dsh store is untouched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostStore, httpProxyFromProxyCommand, parseSshConfig, proxyJumpFromValue } from '../src/store'

const dirs: string[] = []

function makeStore(): { store: HostStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-ide-test-'))
  dirs.push(dir)
  return { store: new HostStore(join(dir, 'hosts.json')), dir }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('HostStore CRUD', () => {
  it('upserts and lists entries sorted by alias', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'beta', host: '10.0.0.2', user: 'root', auth: { kind: 'password', password: 's3cret' } })
    store.upsert({ alias: 'alpha', host: 'example.com', port: 2222, user: 'dev', auth: { kind: 'key', keyPath: '~/.ssh/id_ed25519' }, tags: ['prod'] })
    const list = store.list()
    expect(list.map(e => e.alias)).toEqual(['alpha', 'beta'])
    expect(list[0]!.port).toBe(2222)
  })

  it('keeps stored secrets on update when auth is omitted', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'h', host: 'h.example.com', user: 'u', auth: { kind: 'password', password: 'secret' } })
    store.upsert({ alias: 'h', host: 'h2.example.com', user: 'u2' })
    const entry = store.get('h')!
    expect(entry.host).toBe('h2.example.com')
    expect(entry.auth).toEqual({ kind: 'password', password: 'secret' })
  })

  it('rejects invalid entries', () => {
    const { store } = makeStore()
    expect(() => store.upsert({ alias: '', host: 'x', user: 'u' })).toThrow('alias')
    expect(() => store.upsert({ alias: 'a', host: '', user: 'u' })).toThrow('host')
    expect(() => store.upsert({ alias: 'a', host: 'x', user: '' })).toThrow('user')
    expect(() => store.upsert({ alias: 'a', host: 'x', user: 'u', auth: { kind: 'password', password: '' } })).toThrow('password')
    expect(() => store.upsert({ alias: 'a', host: 'x', user: 'u', auth: { kind: 'key' } })).toThrow('keyPath')
  })

  it('拒绝原型污染别名（__proto__ / constructor / prototype）', () => {
    const { store } = makeStore()
    for (const alias of ['__proto__', 'constructor', 'prototype']) {
      expect(() => store.upsert({ alias, host: 'x', user: 'u', auth: { kind: 'password', password: 'p' } }))
        .toThrow(/unsafe host alias/)
      expect(store.get(alias)).toBeUndefined()
    }
  })

  it('removes entries', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'h', host: 'x', user: 'u', auth: { kind: 'password', password: 'p' } })
    expect(store.remove('h')).toBe(true)
    expect(store.remove('h')).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('persists to disk (0600 semantics on POSIX)', () => {
    const { store, dir } = makeStore()
    store.upsert({ alias: 'h', host: 'x', user: 'u', auth: { kind: 'password', password: 'p' } })
    const raw = readFileSync(join(dir, 'hosts.json'), 'utf8')
    const parsed = JSON.parse(raw) as { hosts: Array<{ alias: string }> }
    expect(parsed.hosts).toHaveLength(1)
    expect(parsed.hosts[0]!.alias).toBe('h')

    // Reopen: entries survive.
    const reopened = new HostStore(join(dir, 'hosts.json'))
    expect(reopened.list()).toHaveLength(1)
  })
})

describe('parseSshConfig', () => {
  it('parses host blocks with hostname/port/user/identity', () => {
    const text = [
      'Host prod',
      '  HostName 10.0.0.1',
      '  Port 2222',
      '  User deploy',
      '  IdentityFile ~/.ssh/prod_key',
      '',
      'Host dev',
      '  HostName dev.example.com',
    ].join('\n')
    const blocks = parseSshConfig(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ name: 'prod', hostName: '10.0.0.1', port: 2222, user: 'deploy', identityFile: '~/.ssh/prod_key' })
    expect(blocks[1]).toMatchObject({ name: 'dev', hostName: 'dev.example.com' })
  })

  it('skips blocks without a concrete hostname', () => {
    const text = [
      'Host *',
      '  User generic',
      '',
      'Host special',
      '  HostName special.example.com',
    ].join('\n')
    const blocks = parseSshConfig(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.name).toBe('special')
  })

  it('tolerates comments, blanks and unknown keys', () => {
    const text = [
      '# comment',
      '',
      'Host x',
      '  HostName x.example.com',
      '  Compression yes',
      '  ServerAliveInterval 30',
    ].join('\n')
    const blocks = parseSshConfig(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.hostName).toBe('x.example.com')
  })
})

describe('HostStore summaries', () => {
  it('never leaks secrets to the summary', () => {
    const { store } = makeStore()
    store.upsert({ alias: 'h', host: 'x', user: 'u', auth: { kind: 'password', password: 'top-secret' } })
    const summary = store.summarize(store.get('h')!)
    expect(JSON.stringify(summary)).not.toContain('top-secret')
    expect(summary.auth).toBe('password')
  })
})

describe('ssh-config proxy translation', () => {
  it('parses ProxyCommand / ProxyJump raw values', () => {
    const text = [
      'Host via-ncat',
      '  HostName 10.0.0.1',
      '  IdentityFile "C:\\Users\\me\\.ssh\\id_ed25519"',
      '  ProxyCommand "C:\\Program Files (x86)\\Nmap\\ncat.exe" --proxy proxyspl.huawei.com:8080 --proxy-type http --proxy-auth "u:p" %h %p',
      'Host via-jump',
      '  HostName 10.0.0.2',
      '  ProxyJump bastion, extra',
    ].join('\n')
    const blocks = parseSshConfig(text)
    // A value quoted as a whole loses its quotes (Windows paths with spaces);
    // a ProxyCommand with only its program quoted keeps the inner quotes.
    expect(blocks[0]!.identityFile).toBe('C:\\Users\\me\\.ssh\\id_ed25519')
    expect(blocks[0]!.proxyCommand).toContain('--proxy proxyspl.huawei.com:8080')
    expect(blocks[0]!.proxyCommand).toMatch(/^"C:\\Program Files/)
    expect(blocks[1]!.proxyJump).toBe('bastion, extra')
  })

  it('translates the ncat HTTP-proxy ProxyCommand (quoted Windows path, Basic auth)', () => {
    const cmd = '"C:\\Program Files (x86)\\Nmap\\ncat.exe" --proxy proxyspl.huawei.com:8080 --proxy-type http --proxy-auth "x00968307:GoodXP.2026A" %h %p'
    expect(httpProxyFromProxyCommand(cmd)).toEqual({ host: 'proxyspl.huawei.com', port: 8080, username: 'x00968307', password: 'GoodXP.2026A' })
  })

  it('accepts inline (--opt=value) ncat forms and a bare proxy host', () => {
    expect(httpProxyFromProxyCommand('ncat --proxy-type=http --proxy=cache.corp:3128 %h %p')).toEqual({ host: 'cache.corp', port: 3128 })
    expect(httpProxyFromProxyCommand('ncat --proxy cache.corp --proxy-type http %h %p')).toEqual({ host: 'cache.corp', port: 8080 })
    expect(httpProxyFromProxyCommand('ncat --proxy cache.corp:8080 --proxy-type http --proxy-auth onlyuser %h %p')).toEqual({ host: 'cache.corp', port: 8080, username: 'onlyuser' })
  })

  it('recognises OpenBSD nc (HTTP CONNECT) and connect.exe', () => {
    expect(httpProxyFromProxyCommand('nc -X connect -x proxy.corp:3128 %h %p')).toEqual({ host: 'proxy.corp', port: 3128 })
    expect(httpProxyFromProxyCommand('connect.exe -H proxy.corp:8080 %h %p')).toEqual({ host: 'proxy.corp', port: 8080 })
  })

  it('leaves non-HTTP or unrecognised ProxyCommands alone', () => {
    // SOCKS ncat, SOCKS nc (no -X), ssh -W (that is ProxyJump territory), corkscrew.
    expect(httpProxyFromProxyCommand('ncat --proxy socks.corp:1080 --proxy-type socks5 %h %p')).toBeUndefined()
    expect(httpProxyFromProxyCommand('ncat --proxy socks.corp:1080 --proxy-type socks4 %h %p')).toBeUndefined()
    expect(httpProxyFromProxyCommand('nc -x socks.corp:1080 %h %p')).toBeUndefined()
    expect(httpProxyFromProxyCommand('ssh -W %h:%p bastion')).toBeUndefined()
    expect(httpProxyFromProxyCommand('corkscrew proxy.corp 8080 %h %p')).toBeUndefined()
    expect(httpProxyFromProxyCommand('')).toBeUndefined()
    // Malformed endpoint must not produce a half proxy.
    expect(httpProxyFromProxyCommand('ncat --proxy :99999 --proxy-type http %h %p')).toBeUndefined()
  })

  it('keeps only ProxyJump aliases that name an imported block', () => {
    const known = new Set(['bastion', 'target'])
    expect(proxyJumpFromValue('bastion', known)).toEqual(['bastion'])
    expect(proxyJumpFromValue('bastion, ghost', known)).toEqual(['bastion'])
    expect(proxyJumpFromValue('*.corp', known)).toEqual([])
    expect(proxyJumpFromValue('none', known)).toEqual([])
    expect(proxyJumpFromValue(undefined, known)).toEqual([])
  })

  it('importSshConfig turns -inter ncat hosts and ProxyJump into native proxy settings', () => {
    const { store } = makeStore()
    const text = [
      'Host flex-1',
      '  HostName 47.117.143.162',
      '  User root',
      '  Port 30995',
      '  IdentityFile ~/.ssh/flex_key',
      'Host flex-1-inter',
      '  HostName 47.117.143.162',
      '  User root',
      '  Port 30995',
      '  IdentityFile ~/.ssh/flex_key',
      '  ProxyCommand "C:\\Program Files (x86)\\Nmap\\ncat.exe" --proxy proxyspl.huawei.com:8080 --proxy-type http --proxy-auth "x00968307:GoodXP.2026A" %h %p',
      'Host bastion',
      '  HostName bastion.corp',
      '  User ops',
      'Host target',
      '  HostName 10.1.1.1',
      '  User root',
      '  ProxyJump bastion',
      'Host dangling',
      '  HostName 10.1.1.2',
      '  User root',
      '  ProxyJump ghost',
    ].join('\n')
    const result = store.importSshConfig(text)
    expect(result).toMatchObject({ parsed: 5, added: 5, skipped: 0 })

    const direct = store.get('flex-1')!
    expect(direct.httpProxy).toBeUndefined()
    expect(direct.proxyJump).toEqual([])

    const viaProxy = store.get('flex-1-inter')!
    expect(viaProxy.host).toBe('47.117.143.162')
    expect(viaProxy.port).toBe(30995)
    expect(viaProxy.httpProxy).toEqual({ host: 'proxyspl.huawei.com', port: 8080, username: 'x00968307', password: 'GoodXP.2026A' })
    expect(viaProxy.tags).toContain('ssh-config')

    expect(store.get('target')!.proxyJump).toEqual(['bastion'])
    expect(store.get('dangling')!.proxyJump).toEqual([])

    // The imported proxy password is a secret: never in the summary projection.
    const summary = store.summarize(viaProxy)
    expect(JSON.stringify(summary)).not.toContain('GoodXP.2026A')
    expect(summary.httpProxy).toEqual({ host: 'proxyspl.huawei.com', port: 8080, hasAuth: true })
  })

  it('importSshConfig is idempotent (already-imported aliases are skipped, proxy untouched)', () => {
    const { store } = makeStore()
    const text = ['Host a', '  HostName a.example.com', '  User u', '  ProxyCommand ncat --proxy p:8080 --proxy-type http %h %p'].join('\n')
    expect(store.importSshConfig(text).added).toBe(1)
    const second = store.importSshConfig(text)
    expect(second.added).toBe(0)
    expect(second.skippedNames).toEqual(['a'])
    expect(store.get('a')!.httpProxy).toEqual({ host: 'p', port: 8080 })
  })
})
