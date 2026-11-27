/**
 * SFTP 在「会说话的 shell」和「READDIR 会死的服务端」上的两道保险：
 *   - sftp-preamble.ts：VERSION 包之前的字节一律丢弃，安静的 shell 零影响；
 *   - sftp-list.ts 的 readdir 兜底：READDIR 无应答/会话类错误 → 改走 shell（find），之后都走 shell，
 *     真错误（不存在、无权限）照常报；兜底给出的条目不再触发 stat（那时 SFTP 会话已经死了）。
 * 现场：华为云 ModelArts 的 Ascend 镜像（dmtp-debug）——登录 shell 往 stdout 打印横幅、
 * 每个会话先花 15 秒 import torch，且列 home 目录必然让 sftp-server 进程死掉。
 */
import { describe, expect, it, vi } from 'vitest'

import { findVersionPacket, gatePreamble } from '../src/sftp-preamble'
import {
  FIND_LISTING_FORMAT,
  findListingCommand,
  installResilientReaddir,
  isSymlinkMode,
  listFollowingSymlinks,
  parseFindListing,
  shellEntriesToListing,
  type SftpListing,
  type SftpListingEntry,
  type SftpStatsLike,
} from '../src/sftp-list'

function versionPacket(extensions = ''): Buffer {
  const body = Buffer.concat([Buffer.from([2]), Buffer.from([0, 0, 0, 3]), Buffer.from(extensions, 'latin1')])
  return Buffer.concat([Buffer.from([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255]), body])
}

const BANNER = Buffer.from(
  ' __  __               _          _                      _         \n' +
    '|  \\/  |             | |        | |     /\\             | |        \n' +
    'Using user ma-user\nHuawei Cloud EulerOS 2.0 (aarch64), CANN-9.1.0\nTips:\n1) Navigate to the target conda environment.\r\n',
  'latin1',
)

describe('sftp preamble skip (gatePreamble / findVersionPacket)', () => {
  it('finds the VERSION packet after a text banner, in one chunk', () => {
    const data = Buffer.concat([BANNER, versionPacket()])
    expect(findVersionPacket(data)).toBe(BANNER.length)
  })

  it('buffers while the packet is incomplete, then passes the rest starting at the packet', () => {
    const gate = { synced: false, pending: Buffer.alloc(0) }
    const first = Buffer.concat([BANNER, versionPacket().subarray(0, 5)])
    expect(gatePreamble(gate, first)).toEqual({ kind: 'buffer' })
    const rest = versionPacket().subarray(5)
    const result = gatePreamble(gate, Buffer.concat([rest, Buffer.from('next', 'latin1')]))
    expect(result.kind).toBe('pass')
    expect(gate.synced).toBe(true)
    // exactly the VERSION packet followed by the later bytes; the banner is gone
    expect(Buffer.compare((result as { data: Buffer }).data, Buffer.concat([versionPacket(), Buffer.from('next')]))).toBe(0)
  })

  it('is a no-op for a quiet server: the first bytes already are the packet', () => {
    const gate = { synced: false, pending: Buffer.alloc(0) }
    const packet = versionPacket('posix-rename@openssh.com')
    const result = gatePreamble(gate, packet)
    expect(result.kind).toBe('pass')
    expect(Buffer.compare((result as { data: Buffer }).data, packet)).toBe(0)
  })

  it('passes everything straight through once synced', () => {
    const gate = { synced: true, pending: Buffer.alloc(0) }
    const data = Buffer.from('anything\0\0\x02', 'latin1')
    const result = gatePreamble(gate, data)
    expect(result.kind).toBe('pass')
    expect((result as { data: Buffer }).data).toBe(data)
  })

  it('gives up after 256 KiB of non-packet bytes instead of buffering forever', () => {
    const gate = { synced: false, pending: Buffer.alloc(0) }
    expect(gatePreamble(gate, Buffer.alloc(256 * 1024 + 1, 0x41))).toEqual({ kind: 'overflow' })
  })

  it('does not mistake banner text for a packet: ASCII text has no 0x00 bytes', () => {
    expect(findVersionPacket(BANNER)).toBe(-1)
    expect(findVersionPacket(Buffer.from('\x00\x00\x04\x03\x00\x00\x00\x03', 'latin1'))).toBe(-1) // type 3 = OPEN, not VERSION
  })
})

describe('parseFindListing', () => {
  const format = FIND_LISTING_FORMAT
  it('the format separates fields with tabs and records with NUL', () => {
    expect(format).toContain('\\t%P\\t%l\\0')
    expect(findListingCommand('/home/ma user')).toBe(`find -L '/home/ma user' -mindepth 1 -maxdepth 1 -printf '${format}'`)
    expect(findListingCommand("/it's")).toContain(`'/it'\\''s'`)
  })

  it('reads a listing with a banner in front, CRLF from the pty, every entry kind, and odd names', () => {
    const out =
      ' __  __   welcome\r\nTips:\r\n1) be careful\r\n' +
      'd\t4096\t1795696790.278123456\t755\twork\t\0' +
      'f\t1704\t1795696790.123400000\t600\t.bashrc\t\0' +
      'd\t4096\t1795696790.000000000\t755\tanaconda\t/home/ma-user/anaconda3/envs/PyTorch-2.9.0\0' +
      'l\t11\t1795696790.5\t777\tdangling\t/nowhere\0' +
      'f\t12\t1795696790.5\t644\ta\tname with tab\t\0' +
      'f\t1\t1795696790.5\t644\ttrailing-cr\r\0'
    const entries = parseFindListing(out)
    expect(entries.map((e) => [e.name, e.kind, e.target])).toEqual([
      ['work', 'd', ''],
      ['.bashrc', 'f', ''],
      ['anaconda', 'd', '/home/ma-user/anaconda3/envs/PyTorch-2.9.0'],
      ['dangling', 'l', '/nowhere'],
      ['a\tname with tab', 'f', ''],
      ['trailing-cr', 'f', ''],
    ])
    expect(entries[0]?.perms).toBe(0o755)
    expect(entries[1]?.size).toBe(1704)
  })

  it('drops junk that does not have the record shape', () => {
    expect(parseFindListing('just text\nmore text\n')).toEqual([])
    expect(parseFindListing('')).toEqual([])
  })

  it('turns records into readdir-shaped entries that need no further stat', () => {
    const entries = shellEntriesToListing(parseFindListing(
      'd\t4096\t1795696790.0\t755\tlink-to-dir\t/target\0' +
      'l\t11\t1795696790.0\t777\tdangling\t/nowhere\0' +
      'f\t5\t1795696790.0\t644\tplain\t\0',
    ))
    const [link, dangling, plain] = entries as [SftpListingEntry, SftpListingEntry, SftpListingEntry]
    expect(isSymlinkMode(link.attrs.mode)).toBe(true)
    expect(link.symlink).toBe(true)
    expect(link.followed?.isDirectory()).toBe(true)
    expect(dangling.symlink).toBe(true)
    expect(dangling.followed).toBeUndefined()
    expect(plain.symlink).toBeUndefined()
    expect(plain.attrs.isFile()).toBe(true)
    expect(entries.every((e) => e.statResolved === true)).toBe(true)
  })

  it('listFollowingSymlinks does not touch SFTP for entries that are already resolved', async () => {
    const stat = vi.fn()
    const entries = shellEntriesToListing(parseFindListing('d\t1\t1.0\t755\tlink\t/t\0l\t1\t1.0\t777\tgone\t/x\0'))
    const sftp: SftpListing = {
      readdir: (_p, cb) => cb(null, entries),
      stat,
    }
    const listed = await listFollowingSymlinks(sftp, '/home/u')
    expect(stat).not.toHaveBeenCalled()
    expect(listed.map((e) => [e.name, e.isLink, e.followed?.isDirectory()])).toEqual([
      ['link', true, true],
      ['gone', true, undefined],
    ])
  })
})

describe('installResilientReaddir', () => {
  function stats(mode: number): SftpStatsLike {
    return { size: 1, mtime: 1, mode, isFile: () => (mode & 0o170000) === 0o100000, isDirectory: () => (mode & 0o170000) === 0o040000 }
  }

  function harness(opts: { hang?: boolean; useShell?: boolean } = {}) {
    const real = vi.fn((path: string, cb: (err: Error | null, list: SftpListingEntry[]) => void) => {
      if (opts.hang === true && path === '/home/u') return // server died: never answers
      if (path === '/missing') {
        cb(Object.assign(new Error('no such file'), { code: 2 }), [])
        return
      }
      cb(null, [{ filename: 'from-sftp', attrs: stats(0o100644) }])
    })
    const sftp = { readdir: real, stat: vi.fn() }
    const shell = vi.fn(async () => parseFindListing('f\t7\t2.0\t644\tfrom-shell\t\0'))
    const state = { shellMode: opts.useShell === true }
    const onShellMode = vi.fn(() => { state.shellMode = true })
    const onSessionBroken = vi.fn()
    installResilientReaddir(sftp as unknown as SftpListing, {
      timeoutMs: 30,
      listViaShell: shell,
      useShell: () => state.shellMode,
      onShellMode,
      onSessionBroken,
    })
    return { sftp, real, shell, onShellMode, onSessionBroken }
  }
  const read = (sftp: { readdir: (p: string, cb: (e: Error | null | undefined, l: SftpListingEntry[]) => void) => void }, path: string) =>
    new Promise<{ err?: Error | null; list: SftpListingEntry[] }>((resolve) => sftp.readdir(path, (err, l) => resolve({ err, list: l })))

  it('a healthy READDIR is passed through untouched', async () => {
    const h = harness()
    const r = await read(h.sftp, '/tmp')
    expect(r.err).toBeNull()
    expect(r.list.map((e) => e.filename)).toEqual(['from-sftp'])
    expect(h.shell).not.toHaveBeenCalled()
    expect(h.onSessionBroken).not.toHaveBeenCalled()
  })

  it('a READDIR that never answers falls back to the shell, drops the session, and sticks to the shell afterwards', async () => {
    const h = harness({ hang: true })
    const started = Date.now()
    const r = await read(h.sftp, '/home/u')
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    expect(r.err).toBeUndefined()
    expect(r.list.map((e) => e.filename)).toEqual(['from-shell'])
    expect(h.onSessionBroken).toHaveBeenCalledTimes(1)
    expect(h.onShellMode).toHaveBeenCalledTimes(1)
    const before = h.real.mock.calls.length
    const again = await read(h.sftp, '/home/u')
    expect(again.list.map((e) => e.filename)).toEqual(['from-shell'])
    expect(h.real.mock.calls.length).toBe(before) // SFTP is not consulted any more
    expect(h.shell).toHaveBeenCalledTimes(2)
  })

  it('a session-type error (packet length / connection lost) triggers the same fallback', async () => {
    const real = vi.fn((_p: string, cb: (e: Error) => void) => cb(new Error('Packet length 543121184 exceeds max length of 262144')))
    const sftp = { readdir: real, stat: vi.fn() }
    const shell = vi.fn(async () => [])
    const onSessionBroken = vi.fn()
    installResilientReaddir(sftp as unknown as SftpListing, { timeoutMs: 1000, listViaShell: shell, useShell: () => false, onShellMode: () => {}, onSessionBroken })
    const r = await read(sftp, '/home/u')
    expect(r.err).toBeUndefined()
    expect(onSessionBroken).toHaveBeenCalledTimes(1)
  })

  it('a real error (no such file) is reported as is, without fallback', async () => {
    const h = harness()
    const r = await read(h.sftp, '/missing')
    expect(r.err?.message).toBe('no such file')
    expect(h.shell).not.toHaveBeenCalled()
    expect(h.onSessionBroken).not.toHaveBeenCalled()
  })

  it('when the shell listing fails too, the error names both causes', async () => {
    const sftp = { readdir: vi.fn(), stat: vi.fn() }
    const shell = vi.fn(async () => { throw new Error('find: not found') })
    installResilientReaddir(sftp as unknown as SftpListing, { timeoutMs: 20, listViaShell: shell, useShell: () => true, onShellMode: () => {}, onSessionBroken: () => {} })
    const r = await read(sftp, '/home/u')
    expect(r.err?.message).toMatch(/find: not found/)
  })

  it('a host already known to need the shell never touches SFTP for listing', async () => {
    const h = harness({ useShell: true })
    const r = await read(h.sftp, '/tmp')
    expect(r.list.map((e) => e.filename)).toEqual(['from-shell'])
    expect(h.real).not.toHaveBeenCalled()
    expect(h.onSessionBroken).not.toHaveBeenCalled()
  })

  it("leaves ssh2's own paginated continuation calls — readdir(path, optsObject, cb) — alone", async () => {
    // ssh2's readdir fetches a directory page by page by re-invoking `this.readdir(where, opts, cb)`
    // with a state-carrying options object. Intercepting that call as a fresh listing (and treating
    // the options object as the callback) crashed with "cb is not a function" on the real node.
    type Cb = (e: Error | null, l: SftpListingEntry[]) => void
    const shell = vi.fn(async () => [])
    const original = vi.fn(function (this: SftpListing, path: string, optsOrCb: Cb | { continuation: boolean }, maybeCb?: Cb) {
      if (typeof optsOrCb === 'function') {
        // first page arrived; ssh2 asks for the next page through the instance method
        this.readdir(path, { continuation: true }, optsOrCb)
        return
      }
      ;(maybeCb as Cb | undefined)?.(null, [{ filename: 'second-page', attrs: stats(0o100644) }])
    })
    const sftp: SftpListing = { readdir: original as SftpListing['readdir'], stat: vi.fn() }
    installResilientReaddir(sftp, { timeoutMs: 1000, listViaShell: shell, useShell: () => false, onShellMode: () => {}, onSessionBroken: () => {} })
    const r = await read(sftp, '/home/u')
    expect(r.err).toBeNull()
    expect(r.list.map((e) => e.filename)).toEqual(['second-page'])
    expect(original).toHaveBeenCalledTimes(2)
    expect(shell).not.toHaveBeenCalled()
  })
})
