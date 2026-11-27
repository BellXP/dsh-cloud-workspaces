/**
 * seam-fs（侧栏远程路由缝）测试 —— 轻量桩件：计数 SFTP + 内存远端节点 +
 * LocalFs 原型（本地分支透传标记），覆盖 0.6.0 的两个新能力：
 * 读链 stat 微缓存 与 伪 watch 指纹轮询。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SshRuntime } from '../src/ssh-service'
import { installRemoteFsSeam } from '../src/seam-fs'
import { encodeRemotePath, remoteRoot } from '../src/workspace'

// ------------------------------------------------------------------ 桩件

/** 本地 fs 服务：原型方法全部抛标记错误（远端路由命中时不应触达）。 */
class LocalFs {
  async resolve(..._args: unknown[]): Promise<never> { throw new Error('local:resolve') }
  async lstat(..._args: unknown[]): Promise<never> { throw new Error('local:lstat') }
  async stat(..._args: unknown[]): Promise<never> { throw new Error('local:stat') }
  async listDir(..._args: unknown[]): Promise<never> { throw new Error('local:listDir') }
  async streamText(..._args: unknown[]): Promise<never> { throw new Error('local:streamText') }
  async readBytes(..._args: unknown[]): Promise<never> { throw new Error('local:readBytes') }
}

/** `link` 节点：`target` 指向另一个节点的绝对路径（悬空链接的 target 不存在）。 */
interface FakeNode { kind: 'file' | 'dir' | 'link'; mtime: number; content?: Buffer; target?: string }

/** 计数 + 内存节点的假 SFTP。 */
function makeSftpHarness() {
  const nodes = new Map<string, FakeNode>()
  const calls = { lstat: 0, stat: 0, readdir: 0 }
  const state = { breakLstat: false }
  const statsOf = (n: FakeNode) => ({
    size: n.kind === 'file' ? (n.content?.length ?? 0) : n.kind === 'link' ? 1 : 0,
    mode: n.kind === 'file' ? 0o100644 : n.kind === 'link' ? 0o120777 : 0o040755,
    mtime: n.mtime,
    isFile: () => n.kind === 'file',
    isDirectory: () => n.kind === 'dir',
  })
  const missing = () => new Error('No such file')
  /** 跟随路径上任意一段符号链接（最多 8 跳）；悬空或成环返回 undefined。 */
  const follow = (p: string, hops = 0): string | undefined => {
    if (hops > 8) return undefined
    const parts = p.split('/').filter((part) => part !== '')
    let current = ''
    for (let index = 0; index < parts.length; index += 1) {
      current = `/${parts.slice(0, index + 1).join('/')}`
      const n = nodes.get(current)
      if (n?.kind === 'link') {
        if (n.target === undefined) return undefined
        const rest = parts.slice(index + 1)
        return follow(`${n.target}${rest.length > 0 ? '/' : ''}${rest.join('/')}`, hops + 1)
      }
    }
    return p.startsWith('/') ? p : `/${p}`
  }
  const sftp = {
    lstat(p: string, cb: (e: Error | undefined, s?: unknown) => void) {
      calls.lstat += 1
      if (state.breakLstat) { cb(new Error('Channel closed')); return }
      const n = nodes.get(p)
      n === undefined ? cb(missing()) : cb(undefined, statsOf(n))
    },
    stat(p: string, cb: (e: Error | undefined, s?: unknown) => void) {
      calls.stat += 1
      // stat 语义：跟随符号链接。
      const real = follow(p)
      const n = real === undefined ? undefined : nodes.get(real)
      n === undefined ? cb(missing()) : cb(undefined, statsOf(n))
    },
    readdir(p: string, cb: (e: Error | undefined, list?: Array<{ filename: string; attrs: unknown }>) => void) {
      calls.readdir += 1
      const real = follow(p)
      if (real === undefined || nodes.get(real)?.kind !== 'dir') { cb(missing()); return }
      const prefix = real.endsWith('/') ? real : `${real}/`
      const out: Array<{ filename: string; attrs: unknown }> = []
      for (const [k, n] of nodes) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length)
        if (rest.includes('/')) continue
        out.push({ filename: rest, attrs: statsOf(n) })
      }
      cb(undefined, out)
    },
    readFile(p: string, cb: (e: Error | undefined, b?: Buffer) => void) {
      const real = follow(p)
      const n = real === undefined ? undefined : nodes.get(real)
      n?.content === undefined ? cb(missing()) : cb(undefined, n.content)
    },
    createReadStream(p: string) {
      const real = follow(p)
      const n = real === undefined ? undefined : nodes.get(real)
      return Readable.from([n?.content ?? Buffer.alloc(0)])
    },
  }
  return { sftp, nodes, calls, state }
}

/** 把 seam 装到假 scope 上；返回被补丁的 fs 实例与 effect 卸载器。 */
function install(h: ReturnType<typeof makeSftpHarness>) {
  const fs = new LocalFs()
  const disposers: Array<() => unknown> = []
  const scope = {
    get: (name: string) => (name === 'fs' ? fs : undefined),
    effect: (fn: () => unknown) => { const d = fn(); disposers.push(d); return d },
  }
  const ctx = { inject: (_deps: string[], cb: (s: unknown) => void) => { cb(scope) } } as unknown as Context
  const runtime = { getConnectionFor: async () => ({ getSftp: async () => h.sftp }) } as unknown as SshRuntime
  installRemoteFsSeam(ctx, runtime, () => true)
  return { fs, disposers }
}

const HOST = 'host1'
const REMOTE_PROJ = '/home/dev/proj'
/** 占位形态 key（工作区外的单独编码段形式）。 */
const keyOf = (remoteAbs: string) => join(remoteRoot(), HOST, encodeRemotePath(remoteAbs))
const targetOf = (remoteAbs: string): FsTarget => {
  const key = keyOf(remoteAbs)
  return { targetKey: FsTargetKey(key), displayPath: key }
}

// ------------------------------------------------------------ stat 微缓存

describe('seam-fs stat 微缓存', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('同目标重复 stat 只发一次 SFTP 往返', async () => {
    const h = makeSftpHarness()
    h.nodes.set(REMOTE_PROJ, { kind: 'dir', mtime: 1 })
    const { fs } = install(h)
    const target = targetOf(REMOTE_PROJ)
    const first = await fs.stat(target)
    const second = await fs.stat(target)
    expect(h.calls.stat).toBe(1)
    expect(first?.type).toBe('directory')
    expect(second).toEqual(first)
  })

  it('TTL 过期后重新取数', async () => {
    const h = makeSftpHarness()
    h.nodes.set(REMOTE_PROJ, { kind: 'dir', mtime: 1 })
    const { fs } = install(h)
    const target = targetOf(REMOTE_PROJ)
    await fs.stat(target)
    await vi.advanceTimersByTimeAsync(2600)
    await fs.stat(target)
    expect(h.calls.stat).toBe(2)
  })

  it('lstat 与 stat 分开缓存（符号链接语义不同）', async () => {
    const h = makeSftpHarness()
    h.nodes.set(REMOTE_PROJ, { kind: 'dir', mtime: 1 })
    const { fs } = install(h)
    const key = keyOf(REMOTE_PROJ)
    await fs.lstat(key)
    await fs.stat(targetOf(REMOTE_PROJ))
    expect(h.calls.lstat).toBe(1)
    expect(h.calls.stat).toBe(1)
  })

  it('MISSING 走负缓存：重复查询不再打远端', async () => {
    const h = makeSftpHarness()
    const { fs } = install(h)
    const target = targetOf('/home/dev/proj/absent.txt')
    await expect(fs.stat(target)).resolves.toBeUndefined()
    await expect(fs.stat(target)).resolves.toBeUndefined()
    expect(h.calls.stat).toBe(1)
  })

  it('非占位 target 透传本地实现', async () => {
    const h = makeSftpHarness()
    const { fs } = install(h)
    const local: FsTarget = { targetKey: FsTargetKey('C:\\work\\local'), displayPath: 'C:\\work\\local' }
    await expect(fs.stat(local)).rejects.toThrow('local:stat')
    expect(h.calls.stat).toBe(0)
  })

  it('readBytes 预检共享 stat 缓存条目', async () => {
    const h = makeSftpHarness()
    h.nodes.set(`${REMOTE_PROJ}/a.txt`, { kind: 'file', mtime: 1, content: Buffer.from('hello') })
    const { fs } = install(h)
    const target = targetOf(`${REMOTE_PROJ}/a.txt`)
    const bytes = await fs.readBytes(target, undefined, 1024)
    expect(Buffer.from(bytes).toString()).toBe('hello')
    await fs.stat(target)
    expect(h.calls.stat).toBe(1) // readBytes 预检 + 后续 stat 共享同一跳
  })
})

// --------------------------------------------------------------- 伪 watch

describe('seam-fs 伪 watch', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const watchOn = async (fs: LocalFs, target: FsTarget) => {
    const changed = vi.fn()
    const signal = new AbortController().signal
    // biome-ignore lint/suspicious/noExplicitAny: seam 以 duck 形式挂载 watch
    const close = await (fs as unknown as { watch: (t: FsTarget, c: (e?: Error) => void, s: AbortSignal) => Promise<() => Promise<void>> }).watch(target, changed, signal)
    return { changed, close }
  }

  it('文件 mtime 变化触发 changed()', async () => {
    const h = makeSftpHarness()
    const node = { kind: 'file' as const, mtime: 10, content: Buffer.from('v1') }
    h.nodes.set(`${REMOTE_PROJ}/a.txt`, node)
    const { fs } = install(h)
    const { changed, close } = await watchOn(fs, targetOf(`${REMOTE_PROJ}/a.txt`))
    node.mtime = 11
    node.content = Buffer.from('v2')
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).toHaveBeenCalledTimes(1)
    await close()
  })

  it('close 后停止轮询', async () => {
    const h = makeSftpHarness()
    const node = { kind: 'file' as const, mtime: 10, content: Buffer.from('v1') }
    h.nodes.set(`${REMOTE_PROJ}/a.txt`, node)
    const { fs } = install(h)
    const { changed, close } = await watchOn(fs, targetOf(`${REMOTE_PROJ}/a.txt`))
    await close()
    node.mtime = 11
    await vi.advanceTimersByTimeAsync(9000)
    expect(changed).not.toHaveBeenCalled()
  })

  it('absent → present（创建）触发 changed()', async () => {
    const h = makeSftpHarness()
    const { fs } = install(h)
    const { changed, close } = await watchOn(fs, targetOf(`${REMOTE_PROJ}/new.txt`))
    h.nodes.set(`${REMOTE_PROJ}/new.txt`, { kind: 'file', mtime: 3, content: Buffer.from('x') })
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).toHaveBeenCalledTimes(1)
    await close()
  })

  it('目录内容变化触发 changed()', async () => {
    const h = makeSftpHarness()
    h.nodes.set(REMOTE_PROJ, { kind: 'dir', mtime: 1 })
    const { fs } = install(h)
    const { changed, close } = await watchOn(fs, targetOf(REMOTE_PROJ))
    h.nodes.set(`${REMOTE_PROJ}/b.txt`, { kind: 'file', mtime: 2, content: Buffer.from('b') })
    await vi.advanceTimersByTimeAsync(3000)
    expect(changed).toHaveBeenCalledTimes(1)
    await close()
  })

  it('连续失败达上限：changed(error) 上报一次并自停', async () => {
    const h = makeSftpHarness()
    h.nodes.set(`${REMOTE_PROJ}/a.txt`, { kind: 'file', mtime: 10, content: Buffer.from('v1') })
    const { fs } = install(h)
    const { changed, close } = await watchOn(fs, targetOf(`${REMOTE_PROJ}/a.txt`))
    h.state.breakLstat = true
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(3000)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0]).toBeInstanceOf(Error)
    h.state.breakLstat = false
    await vi.advanceTimersByTimeAsync(6000)
    expect(changed).toHaveBeenCalledTimes(1) // 已自停，恢复也不再有事件
    await close()
  })

  it('本地 target 走原实现（无 watch 时按官方不支持拒绝）', async () => {
    const h = makeSftpHarness()
    const { fs } = install(h)
    const local: FsTarget = { targetKey: FsTargetKey('C:\\work\\local'), displayPath: 'C:\\work\\local' }
    const changed = vi.fn()
    // biome-ignore lint/suspicious/noExplicitAny: duck 视图
    const surface = fs as unknown as { watch: (t: FsTarget, c: (e?: Error) => void, s: AbortSignal) => Promise<() => Promise<void>> }
    await expect(surface.watch(local, changed, new AbortController().signal))
      .rejects.toThrow('Filesystem watching is not supported')
  })
})

// ------------------------------------------------- listDir 跟随符号链接

describe('seam-fs listDir 跟随符号链接', () => {
  /** `/xupeng/public -> /public` 这类共享目录：链接在文件树里必须是一个可展开的目录。 */
  const seedLinks = (h: ReturnType<typeof makeSftpHarness>) => {
    h.nodes.set(REMOTE_PROJ, { kind: 'dir', mtime: 1 })
    h.nodes.set(`${REMOTE_PROJ}/src`, { kind: 'dir', mtime: 1 })
    h.nodes.set(`${REMOTE_PROJ}/README.md`, { kind: 'file', mtime: 1, content: Buffer.from('hello world!') })
    h.nodes.set(`${REMOTE_PROJ}/public`, { kind: 'link', mtime: 1, target: '/srv/public' })
    h.nodes.set('/srv/public', { kind: 'dir', mtime: 2 })
    h.nodes.set('/srv/public/shared.tex', { kind: 'file', mtime: 2, content: Buffer.from('x') })
    h.nodes.set(`${REMOTE_PROJ}/latest.log`, { kind: 'link', mtime: 1, target: '/var/log/app.log' })
    h.nodes.set('/var/log/app.log', { kind: 'file', mtime: 3, content: Buffer.from('0123456789') })
    h.nodes.set(`${REMOTE_PROJ}/gone`, { kind: 'link', mtime: 1, target: '/deleted' })
  }

  it('指向目录/文件的软链接按指向的对象报类型，悬空链接才是 other', async () => {
    const h = makeSftpHarness()
    seedLinks(h)
    const { fs } = install(h)

    const entries = await fs.listDir(targetOf(REMOTE_PROJ))
    const byName = new Map(entries.map((entry) => [entry.name, entry]))

    expect(byName.get('src')?.type).toBe('directory')
    expect(byName.get('public')?.type).toBe('directory')
    expect(byName.get('latest.log')?.type).toBe('file')
    expect(byName.get('latest.log')?.size).toBe(10)
    expect(byName.get('gone')?.type).toBe('other')
    expect(byName.get('README.md')?.size).toBe(12)
    // 只有三个链接各花一次 stat；其余条目沿用 readdir 的属性。
    expect(h.calls.stat).toBe(3)
  })

  it('软链接目录可以展开：子条目的 key 落在链接路径下，读的是它指向的目录', async () => {
    const h = makeSftpHarness()
    seedLinks(h)
    const { fs } = install(h)

    const top = await fs.listDir(targetOf(REMOTE_PROJ))
    const publicEntry = top.find((entry) => entry.name === 'public')
    expect(publicEntry).toBeDefined()
    expect(publicEntry?.type).toBe('directory')

    const children = await fs.listDir(publicEntry!.target)
    expect(children.map((entry) => entry.name)).toEqual(['shared.tex'])
    expect(children[0]?.target.displayPath).toBe(join(publicEntry!.target.displayPath, 'shared.tex'))
    // 链接路径下的文件可读可写：路径在服务器一侧解析，key 仍是词法的链接形态。
    const bytes = await fs.readBytes(children[0]!.target, undefined, 1024)
    expect(Buffer.from(bytes).toString()).toBe('x')
    expect((await fs.stat(children[0]!.target))?.type).toBe('file')
  })

  it('lstat 仍如实报告 symlink（信任边界规则依赖它），stat 跟随', async () => {
    const h = makeSftpHarness()
    seedLinks(h)
    const { fs } = install(h)

    expect((await fs.lstat(keyOf(`${REMOTE_PROJ}/public`)))?.type).toBe('symlink')
    expect((await fs.stat(targetOf(`${REMOTE_PROJ}/public`)))?.type).toBe('directory')
    await expect(fs.stat(targetOf(`${REMOTE_PROJ}/gone`))).resolves.toBeUndefined()
  })

  it('目录不存在仍是 FS_NOT_FOUND', async () => {
    const h = makeSftpHarness()
    const { fs } = install(h)

    await expect(fs.listDir(targetOf('/home/dev/absent'))).rejects.toThrow(/not found/)
  })
})

// ---------------------------------------------------------------- teardown

describe('seam-fs 卸载', () => {
  it('effect 卸载器删除 own-property，恢复原型方法', async () => {
    const h = makeSftpHarness()
    const { fs, disposers } = install(h)
    expect(Object.prototype.hasOwnProperty.call(fs, 'stat')).toBe(true)
    for (const dispose of disposers) await dispose()
    expect(Object.prototype.hasOwnProperty.call(fs, 'stat')).toBe(false)
    expect(fs.stat).toBe(LocalFs.prototype.stat)
    await expect(fs.stat({ targetKey: FsTargetKey(keyOf(REMOTE_PROJ)), displayPath: keyOf(REMOTE_PROJ) }))
      .rejects.toThrow('local:stat')
  })
})
