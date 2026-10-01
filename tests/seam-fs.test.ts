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

interface FakeNode { kind: 'file' | 'dir'; mtime: number; content?: Buffer }

/** 计数 + 内存节点的假 SFTP。 */
function makeSftpHarness() {
  const nodes = new Map<string, FakeNode>()
  const calls = { lstat: 0, stat: 0, readdir: 0 }
  const state = { breakLstat: false }
  const statsOf = (n: FakeNode) => ({
    size: n.kind === 'file' ? (n.content?.length ?? 0) : 0,
    mode: n.kind === 'file' ? 0o100644 : 0o040755,
    mtime: n.mtime,
    isFile: () => n.kind === 'file',
    isDirectory: () => n.kind === 'dir',
  })
  const missing = () => new Error('No such file')
  const sftp = {
    lstat(p: string, cb: (e: Error | undefined, s?: unknown) => void) {
      calls.lstat += 1
      if (state.breakLstat) { cb(new Error('Channel closed')); return }
      const n = nodes.get(p)
      n === undefined ? cb(missing()) : cb(undefined, statsOf(n))
    },
    stat(p: string, cb: (e: Error | undefined, s?: unknown) => void) {
      calls.stat += 1
      const n = nodes.get(p)
      n === undefined ? cb(missing()) : cb(undefined, statsOf(n))
    },
    readdir(p: string, cb: (e: Error | undefined, list?: Array<{ filename: string; attrs: unknown }>) => void) {
      calls.readdir += 1
      if (!nodes.has(p)) { cb(missing()); return }
      const prefix = p.endsWith('/') ? p : `${p}/`
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
      const n = nodes.get(p)
      n?.content === undefined ? cb(missing()) : cb(undefined, n.content)
    },
    createReadStream(p: string) {
      const n = nodes.get(p)
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
