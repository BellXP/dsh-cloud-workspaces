/**
 * 目录列表的符号链接处理（`engine.ls` 与 `seam-fs.listDir` 共用）。
 *
 * SFTP 的 readdir 只给出目录项自身的属性：符号链接的 mode 是 S_IFLNK，
 * 既不是文件也不是目录。官方本地 fs 后端列目录时对每个条目做 stat
 * （跟随链接），所以指向目录的链接在侧栏文件树里就是一个可展开的目录。
 * 远端若原样报 `other`，这些目录就展不开，工作区选择器也进不去——
 * 「软链接目录里看不到内容」即由此而来。
 *
 * 做法：readdir 之后只对符号链接条目补一次 stat（并行），其余条目沿用
 * readdir 的属性，不多花往返。悬空链接、链接环或无权限跟随时 `followed`
 * 为 undefined，调用方按 `other` 处理：一个坏链接不该拖垮整次列表。
 *
 * 列不出目录时的兜底见文末「readdir 兜底」：有的镜像上 SFTP 的 READDIR 会让
 * 服务端进程直接死掉（华为云 ModelArts 的 Ascend 镜像，列 home 目录必死），
 * 这类节点不该为了客户端改自己，于是改走 shell 列目录。
 */

import { posix } from 'node:path'

/** readdir / stat 条目里用得到的那部分属性（ssh2 `Stats` 的结构子集）。 */
export interface SftpStatsLike {
  size: number
  mtime: number
  mode: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface SftpListingEntry {
  filename: string
  attrs: SftpStatsLike
  /**
   * 这一项是符号链接——由已经把链接解析清楚的列表给出（shell 兜底），
   * 这样调用方不必再对它 stat；attrs 仍是 lstat 语义（mode 带 S_IFLNK）。
   */
  symlink?: boolean
  /** 链接指向的对象；与 `symlink` 一起给出时不再补 stat。 */
  followed?: SftpStatsLike
  /** 这一条的属性已完整，不要再 stat（含悬空链接：它没有 followed）。 */
  statResolved?: boolean
}

/** 列目录与 stat 所需的最小 SFTP 面（ssh2 回调风格）。 */
export interface SftpListing {
  readdir(p: string, cb: (err: Error | undefined | null, list: SftpListingEntry[]) => void): void
  stat(p: string, cb: (err: Error | undefined | null, stats: SftpStatsLike) => void): void
}

/** 一个目录项：自身的属性，以及（仅符号链接）它指向的对象。 */
export interface ListedEntry {
  name: string
  /** 目录项自身的属性（lstat 语义；符号链接的 mode 是 S_IFLNK）。 */
  attrs: SftpStatsLike
  /** 这一项本身是符号链接。 */
  isLink: boolean
  /** 符号链接指向的对象；悬空或无法跟随时为 undefined。 */
  followed?: SftpStatsLike
}

export function isSymlinkMode(mode: number): boolean {
  return (mode & 0o170000) === 0o120000
}

function sftpCall<T>(invoke: (cb: (err: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((err, value) => {
      if (err !== undefined && err !== null) reject(err)
      else resolve(value)
    })
  })
}

/**
 * 列出 `path`，并跟随其中的符号链接。
 *
 * readdir 本身失败（目录不存在、不是目录、无权限）时原样抛出，由调用方
 * 决定措辞；跟随单个链接失败只影响那一条。
 */
export async function listFollowingSymlinks(sftp: SftpListing, path: string): Promise<ListedEntry[]> {
  const listed = await sftpCall<SftpListingEntry[]>((cb) => sftp.readdir(path, cb))
  const links = listed.filter((entry) => entry.symlink === true || isSymlinkMode(entry.attrs.mode))
  // 已经把链接解析清楚的条目（shell 兜底给的）不再 stat——兜底触发时 SFTP 会话多半已经死了。
  const followed = new Map<string, SftpStatsLike>()
  await Promise.all(links
    .filter((entry) => entry.statResolved !== true)
    .map(async (entry) => {
      try {
        followed.set(entry.filename, await sftpCall<SftpStatsLike>((cb) => sftp.stat(posix.join(path, entry.filename), cb)))
      } catch {
        // 悬空链接、ELOOP、EACCES：条目照常列出，类型留给调用方按 other 报。
      }
    }))
  return listed.map((entry) => {
    const isLink = entry.symlink === true || isSymlinkMode(entry.attrs.mode)
    const target = entry.followed ?? (isLink ? followed.get(entry.filename) : undefined)
    return {
      name: entry.filename,
      attrs: entry.attrs,
      isLink,
      ...(isLink && target !== undefined ? { followed: target } : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// readdir 兜底：经 shell 列目录
// ---------------------------------------------------------------------------

/** `find` 一条记录：`%y` 类型、`%s` 大小、`%T@` mtime（epoch 秒，小数）、`%m` 权限、`%P` 名字、`%l` 链接目标。 */
export interface ShellListedEntry {
  name: string
  /** find 的 `%y`：d 目录、f 文件、l 悬空链接（`-L` 下能跟随的链接已报成 d/f）。 */
  kind: string
  size: number
  /** epoch 秒。 */
  mtime: number
  /** 权限位（无类型位），如 0o755。 */
  perms: number
  /** 非空即符号链接，值为目标路径。 */
  target: string
}

/**
 * GNU find 的输出格式：字段用 tab 分、记录用 NUL 分。
 * `-L` 让能跟随的链接直接报出目标类型，`%l` 仍给出目标路径用来标出「这是链接」。
 * 制表符和 NUL 不会出现在欢迎横幅、警告文字里，pty 的 CRLF 翻译也碰不到它们。
 */
export const FIND_LISTING_FORMAT = '%y\\t%s\\t%T@\\t%m\\t%P\\t%l\\0'

/** 单引号安全化：`'` → `'\''`。 */
function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 列 `path` 一层（含隐藏项）的 find 命令。 */
export function findListingCommand(path: string): string {
  return `find -L ${quoteForShell(path)} -mindepth 1 -maxdepth 1 -printf '${FIND_LISTING_FORMAT}'`
}

/** 记录必须从行首开始、以类型字母开头：横幅、警告这类文字没有 NUL，会被粘到下一条记录前面，于是被跳过。 */
const RECORD = /(?:^|[\r\n])([dflocbps])\t(\d+)\t(\d+(?:\.\d+)?)\t([0-7]{3,6})\t(.*)$/s

/**
 * 解析 `findListingCommand` 的输出。容忍三类噪声：前缀文字（横幅、motd）、
 * pty 把 `\n` 翻成 `\r\n`、以及混进 stdout 的 stderr 文字——不合形状的记录一律丢弃。
 * 名字里的 tab 靠「最后一个 tab 之后是链接目标」切分，所以名字可以含 tab，目标不能。
 */
export function parseFindListing(stdout: string): ShellListedEntry[] {
  const entries: ShellListedEntry[] = []
  for (const record of stdout.split('\0')) {
    const match = RECORD.exec(record)
    if (match === null) continue
    const [, kind, size, mtime, perms, rest] = match
    const lastTab = rest.lastIndexOf('\t')
    const name = (lastTab === -1 ? rest : rest.slice(0, lastTab)).replace(/\r+$/, '')
    const target = lastTab === -1 ? '' : rest.slice(lastTab + 1).replace(/\r+$/, '')
    if (name === '' || name === '.' || name === '..') continue
    entries.push({ name, kind, size: Number(size), mtime: Number(mtime), perms: parseInt(perms, 8), target })
  }
  return entries
}

const TYPE_BITS: Record<string, number> = { d: 0o040000, f: 0o100000, l: 0o120000 }

function shellStats(kind: string, perms: number, size: number, mtime: number, linkBits: boolean): SftpStatsLike {
  const mode = (linkBits ? 0o120000 : TYPE_BITS[kind] ?? 0o060000) | (perms & 0o7777)
  const isFile = !linkBits && kind === 'f'
  const isDirectory = !linkBits && kind === 'd'
  return { size, mtime, mode, isFile: () => isFile, isDirectory: () => isDirectory }
}

/** 把 find 的记录变成 readdir 形状的条目；链接的 `attrs` 是 lstat 语义，`followed` 是目标。 */
export function shellEntriesToListing(entries: ShellListedEntry[]): SftpListingEntry[] {
  return entries.map((entry) => {
    const isLink = entry.target !== ''
    const dangling = isLink && entry.kind === 'l'
    return {
      filename: entry.name,
      attrs: shellStats(dangling ? 'l' : entry.kind, entry.perms, entry.size, entry.mtime, isLink),
      ...(isLink ? { symlink: true } : {}),
      ...(isLink && !dangling ? { followed: shellStats(entry.kind, entry.perms, entry.size, entry.mtime, false) } : {}),
      statResolved: true,
    }
  })
}

/** 读不出目录的「真」错误（不存在、不是目录、无权限）：原样报给调用方，不触发兜底。 */
const SESSION_FAILURE = /packet length|exceeds max length|message too long|connection (closed|lost|reset)|econnreset|socket hang up|not connected|channel (closed|error)|destroyed|eof/i

/** ssh2 的错误文案有时只有一个 code（如 `'ECONNRESET'`）。 */
function isSessionFailure(error: Error | undefined | null): boolean {
  if (error === undefined || error === null) return false
  const text = `${error.message ?? ''} ${(error as Error & { code?: string }).code ?? ''}`
  return SESSION_FAILURE.test(text)
}

export interface ResilientReaddirOptions {
  /** READDIR 多久没有应答就放弃这条 SFTP 会话、改走 shell（毫秒）。 */
  timeoutMs: number
  /** 经 shell 列 `path`；失败时 reject。 */
  listViaShell(path: string): Promise<ShellListedEntry[]>
  /** 这台主机是否已经确定走 shell 列目录。 */
  useShell(): boolean
  /** 第一次确定这台主机要走 shell 列目录。 */
  onShellMode(): void
  /** SFTP 会话被判死：所有者应当丢弃它并在下次用时重开。 */
  onSessionBroken(): void
}

type ReaddirCallback = (err: Error | undefined | null, list: SftpListingEntry[]) => void

/**
 * 把一个 SFTP 实例的 `readdir` 换成带兜底的版本：
 *
 * - 正常时原样转调，行为不变；
 * - READDIR 以会话类错误失败、或 `timeoutMs` 内没有应答（服务端进程死掉时 ssh2 不会回调），
 *   就记下「这台主机走 shell」，让所有者丢掉这条会话，然后用 `listViaShell` 的结果回调；
 * - 之后这台主机的 readdir 直接走 shell，不再碰 SFTP；
 * - 不存在、无权限这类真错误照常报，不触发兜底。
 */
export function installResilientReaddir(sftp: SftpListing, options: ResilientReaddirOptions): boolean {
  // The seam only matters for listing; an SFTP face without readdir (a narrow test double)
  // has nothing to harden.
  if (typeof sftp.readdir !== 'function') return false
  const original = sftp.readdir.bind(sftp)
  let shellMode = options.useShell()
  const viaShell = (path: string, cb: ReaddirCallback): void => {
    options.listViaShell(path).then(
      (entries) => cb(undefined, shellEntriesToListing(entries)),
      (error: unknown) => cb(error instanceof Error ? error : new Error(String(error)), []),
    )
  }
  // ssh2 的 readdir 是分页的：取完一批后它在内部再次调用 `this.readdir(where, opts, cb)` 续读
  // （opts 是带句柄状态的对象）。那不是新的列表请求——超时与兜底由最外层那次调用负责——
  // 所以第二个参数不是函数时原样转调，不拦。
  sftp.readdir = ((path: string, optsOrCb: ReaddirCallback | unknown, maybeCb?: ReaddirCallback) => {
    if (typeof optsOrCb !== 'function') {
      (original as (...args: unknown[]) => void)(path, optsOrCb, maybeCb)
      return
    }
    const cb = optsOrCb as ReaddirCallback
    if (shellMode) {
      viaShell(path, cb)
      return
    }
    let settled = false
    const giveUp = (cause: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      shellMode = true
      options.onShellMode()
      options.onSessionBroken()
      options.listViaShell(path).then(
        (entries) => cb(undefined, shellEntriesToListing(entries)),
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          cb(new Error(`readdir(${path}): ${cause.message}; listing it through the shell failed too: ${detail}`), [])
        },
      )
    }
    const timer = setTimeout(() => {
      giveUp(new Error(`SFTP server did not answer READDIR within ${options.timeoutMs} ms`))
    }, options.timeoutMs)
    timer.unref?.()
    original(path, (error, list) => {
      if (settled) return
      if (error !== undefined && error !== null && isSessionFailure(error)) {
        giveUp(error)
        return
      }
      settled = true
      clearTimeout(timer)
      cb(error, (list ?? []) as SftpListingEntry[])
    })
  }) as SftpListing['readdir']
  return true
}
