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
  const links = listed.filter((entry) => isSymlinkMode(entry.attrs.mode))
  const followed = new Map<string, SftpStatsLike>()
  await Promise.all(links.map(async (entry) => {
    try {
      followed.set(entry.filename, await sftpCall<SftpStatsLike>((cb) => sftp.stat(posix.join(path, entry.filename), cb)))
    } catch {
      // 悬空链接、ELOOP、EACCES：条目照常列出，类型留给调用方按 other 报。
    }
  }))
  return listed.map((entry) => {
    const isLink = isSymlinkMode(entry.attrs.mode)
    const target = followed.get(entry.filename)
    return {
      name: entry.filename,
      attrs: entry.attrs,
      isLink,
      ...(isLink && target !== undefined ? { followed: target } : {}),
    }
  })
}
