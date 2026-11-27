/**
 * sftp-list（列目录时跟随符号链接）测试：内存 SFTP 桩件，不碰网络。
 *
 * 覆盖：指向目录/文件的链接按指向的对象给出 followed；悬空链接与 ELOOP
 * 不拖垮整次列表；非链接条目不多花一次 stat；readdir 自身失败原样抛出。
 */

import { describe, expect, it } from 'vitest'
import { isSymlinkMode, listFollowingSymlinks, type SftpListing, type SftpStatsLike } from '../src/sftp-list'

interface Node { kind: 'file' | 'dir' | 'link'; target?: string; size?: number; mtime?: number }

const DIR = 0o040755
const FILE = 0o100644
const LINK = 0o120777

function makeSftp(initial: Record<string, Node>) {
  const nodes = new Map<string, Node>(Object.entries(initial))
  const calls = { readdir: 0, stat: 0 }
  const missing = (p: string) => Object.assign(new Error(`No such file: ${p}`), { code: 2 })
  const statsOf = (n: Node): SftpStatsLike => ({
    size: n.kind === 'file' ? (n.size ?? 0) : n.kind === 'link' ? 1 : 0,
    mtime: n.mtime ?? 1700000000,
    mode: n.kind === 'file' ? FILE : n.kind === 'link' ? LINK : DIR,
    isFile: () => n.kind === 'file',
    isDirectory: () => n.kind === 'dir',
  })
  /** 跟随链接（最多 8 跳，之后视作链接环）。 */
  const follow = (p: string): string | undefined => {
    let current = p
    for (let hop = 0; hop < 8; hop += 1) {
      const node = nodes.get(current)
      if (node === undefined) return undefined
      if (node.kind !== 'link') return current
      if (node.target === undefined) return undefined
      current = node.target
    }
    return undefined
  }
  const sftp: SftpListing = {
    readdir(p, cb) {
      calls.readdir += 1
      const real = nodes.get(p)?.kind === 'link' ? follow(p) : p
      if (real === undefined || nodes.get(real)?.kind !== 'dir') {
        cb(missing(p))
        return
      }
      const prefix = real.endsWith('/') ? real : `${real}/`
      const out = [...nodes]
        .filter(([k]) => k !== real && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(([k, n]) => ({ filename: k.slice(prefix.length), attrs: statsOf(n) }))
      cb(undefined, out)
    },
    stat(p, cb) {
      calls.stat += 1
      if (p === '/loop/a') {
        cb(Object.assign(new Error('Too many levels of symbolic links'), { code: 31 }))
        return
      }
      const real = follow(p)
      const node = real === undefined ? undefined : nodes.get(real)
      if (node === undefined) {
        cb(missing(p))
        return
      }
      cb(undefined, statsOf(node))
    },
  }
  return { sftp, nodes, calls }
}

describe('isSymlinkMode', () => {
  it('recognizes only S_IFLNK among the type bits', () => {
    expect(isSymlinkMode(LINK)).toBe(true)
    expect(isSymlinkMode(0o121200)).toBe(true)
    expect(isSymlinkMode(DIR)).toBe(false)
    expect(isSymlinkMode(FILE)).toBe(false)
  })
})

describe('listFollowingSymlinks', () => {
  it('reports what each symlink points at; plain entries keep their readdir attributes', async () => {
    const h = makeSftp({
      '/proj': { kind: 'dir' },
      '/proj/src': { kind: 'dir' },
      '/proj/README.md': { kind: 'file', size: 12 },
      '/proj/public': { kind: 'link', target: '/srv/public' },
      '/srv/public': { kind: 'dir' },
      '/proj/latest.log': { kind: 'link', target: '/var/log/app.log' },
      '/var/log/app.log': { kind: 'file', size: 4096, mtime: 1700000123 },
    })

    const listed = await listFollowingSymlinks(h.sftp, '/proj')
    const byName = new Map(listed.map((entry) => [entry.name, entry]))

    expect(listed.map((entry) => entry.name).sort()).toEqual(['README.md', 'latest.log', 'public', 'src'])

    expect(byName.get('src')?.isLink).toBe(false)
    expect(byName.get('src')?.followed).toBeUndefined()
    expect(byName.get('src')?.attrs.isDirectory()).toBe(true)

    expect(byName.get('public')?.isLink).toBe(true)
    expect(byName.get('public')?.attrs.mode && isSymlinkMode(byName.get('public')!.attrs.mode)).toBe(true)
    expect(byName.get('public')?.followed?.isDirectory()).toBe(true)

    expect(byName.get('latest.log')?.followed?.isFile()).toBe(true)
    expect(byName.get('latest.log')?.followed?.size).toBe(4096)
    expect(byName.get('latest.log')?.followed?.mtime).toBe(1700000123)

    // Only the two links cost a stat; the other entries rode on readdir.
    expect(h.calls.stat).toBe(2)
    expect(h.calls.readdir).toBe(1)
  })

  it('a dangling link or a link loop is listed without a target instead of failing the listing', async () => {
    const h = makeSftp({
      '/proj': { kind: 'dir' },
      '/proj/gone': { kind: 'link', target: '/deleted' },
      '/proj/a': { kind: 'link', target: '/proj/b' },
      '/proj/b': { kind: 'link', target: '/proj/a' },
    })

    const listed = await listFollowingSymlinks(h.sftp, '/proj')

    expect(listed).toHaveLength(3)
    for (const entry of listed) {
      expect(entry.isLink).toBe(true)
      expect(entry.followed).toBeUndefined()
    }
  })

  it('a stat the server refuses (ELOOP) leaves the entry without a target', async () => {
    const h = makeSftp({
      '/loop': { kind: 'dir' },
      '/loop/a': { kind: 'link', target: '/loop/a' },
    })

    const listed = await listFollowingSymlinks(h.sftp, '/loop')

    expect(listed).toEqual([{ name: 'a', attrs: expect.objectContaining({ mode: LINK }), isLink: true }])
  })

  it('propagates a failing readdir so the caller can word it', async () => {
    const h = makeSftp({ '/proj': { kind: 'dir' } })

    await expect(listFollowingSymlinks(h.sftp, '/missing')).rejects.toThrow(/No such file/)
    expect(h.calls.stat).toBe(0)
  })

  it('resolves a link that points through another link', async () => {
    const h = makeSftp({
      '/proj': { kind: 'dir' },
      '/proj/alias': { kind: 'link', target: '/proj/real' },
      '/proj/real': { kind: 'link', target: '/data/real' },
      '/data/real': { kind: 'dir' },
    })

    const listed = await listFollowingSymlinks(h.sftp, '/proj')
    const alias = listed.find((entry) => entry.name === 'alias')

    expect(alias?.followed?.isDirectory()).toBe(true)
  })
})
