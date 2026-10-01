/**
 * dsh-remote-ide — 侧边栏文件树的远程路由（0.1.7 fs seam wrapper）。
 *
 * 背景：Web 侧边栏文件树 / 文件预览由官方 `workspaceFiles` typert 服务供数，
 * 它全部经 `ctx.fs` 读取（resolve/lstat/stat/listDir/streamText/readBytes/
 * readByteRange/watch）。云端（SSH）工作区的会话根是本地占位目录
 * （~/.dsh/remote/<hostId>/<base64url>），官方本地 fs 后端只会看到空目录。
 *
 * 方案：不替换 cordis 服务（0.1.7 拒绝重复注册 'fs'），而是在**活实例**上
 * 以 own-property 覆盖原型方法，按「路径是否落在占位树内」路由：
 *   - 占位树内 → 该 hostId 的 SSH 连接（SshEngine 连接池）+ SFTP；
 *   - 其余 → 原本地实现原样透传（本地会话零行为变化）。
 *
 * targetKey 语义（关键设计）：远端分支的 targetKey/displayPath 一律是**占位
 * 形态的本地路径**（工作区内 = 占位 cwd + 相对；工作区外的远端绝对路径 =
 * <root>/<hostId>/<encode(该路径)> 单独编码段）。这样未打补丁的
 * processPath/fileUrl/contains（纯字符串操作：pathToFileURL + path.relative）
 * 对远端 target 天然层级正确，侧边栏的树键、相对路径推导、contains 围栏
 * 全部照常工作。canonical 性质是词法的（不解析远端 symlink——文档注明）。
 *
 * 契约要点（对照 workspaceFiles 实现核实）：
 * - stat/lstat 缺失路径返回 undefined（唯一 not-found 信号，绝不抛）；
 * - FS_NOT_TEXT / FS_TOO_LARGE 以 `.code` 字符串鸭子匹配（跨包不认类身份）；
 * - watch 对远端 target 走伪 watch（mtime/attrs 指纹轮询，content-free
 *   changed()）；连续失败达上限才 changed(error) 自停 → 官方 changes()
 *   映射为 workspace-file/watch-unsupported（侧边栏降级为手动刷新）；
 * - listDir 条目带 {name,type,target,size?}（version 会被 wire 层剥掉）。
 */

import path from 'node:path'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { SFTPWrapper, Stats as SftpStats } from 'ssh2'
import type { SshRuntime } from './ssh-service'
import { debugLog } from './debug-log'
import { encodeRemotePath, mapLocalTreeToRemote, remoteRoot, resolveRemotePath } from './workspace'

/** streamText 的读取上限：对齐 workspace-files 的整文件上限（32 MiB）留余量。 */
const STREAM_TEXT_MAX_BYTES = 33 * 1024 * 1024
/** 文本 NUL 采样窗口（与 fs-ssh 一致）。 */
const BINARY_SAMPLE_BYTES = 8192
/** 读链 stat 微缓存 TTL（毫秒）：侧栏 resolve→lstat→stat→read 在数毫秒内
 *  重复 stat 同一目标，远端每跳都是 SFTP RTT（与 fs-ssh 同款）。 */
const STAT_CACHE_TTL_MS = 2500
/** stat 微缓存容量上限（超限时先做过期清扫）。 */
const STAT_CACHE_MAX_ENTRIES = 256
/** 伪 watch 轮询间隔（毫秒）——SFTP 无 inotify，指纹轮询是唯一选择。 */
const WATCH_POLL_MS = 3000
/** 伪 watch 连续失败上限：达到即 changed(error) 上报并自停（订阅方回退
 *  官方 watch-unsupported 行为）。 */
const WATCH_FAILURE_LIMIT = 5

/** ssh2 回调风格 → Promise（ssh2 的 err 形参是 `Error | undefined`）。 */
function sftpCall<T>(invoke: (cb: (error: Error | undefined, value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((error, value) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    })
  })
}

/** SFTP 错误的「路径不存在」判定（跨实现消息匹配）。 */
function isMissingPath(error: unknown): boolean {
  return /no such file|ENOENT|not found/i.test(error instanceof Error ? error.message : String(error))
}

/** 操作失败的统一包装（保留 FsError 原样透传）。 */
function wrapError(operation: string, displayPath: string, error: unknown): FsError {
  if (error instanceof FsError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new FsError(`ssh fs ${operation} "${displayPath}" failed: ${message}`, 'FS_IO_ERROR', { cause: error as Error })
}

/** 版本令牌（不透明；mtime 秒级粒度对侧边栏新鲜度足够）。 */
function versionOf(remotePath: string, stats: SftpStats): FsVersion {
  return FsVersion(`ssh:${remotePath}:${stats.size}:${stats.mtime}:${stats.mode}`)
}

/** SFTP mode 的三态/四态类型。 */
function typeOf(stats: SftpStats, allowSymlink = false): FsInfo['type'] | 'symlink' {
  const kind = stats.mode & 0o170000
  if (kind === 0o040000) return 'directory'
  if (kind === 0o100000) return 'file'
  if (allowSymlink && kind === 0o120000) return 'symlink'
  return 'other'
}

/** 相对/绝对路径解析后的路由结论。 */
export interface RouteInfo {
  hostId: string
  /** 解析后的远端绝对路径（词法规范化）。 */
  remotePath: string
  /** 会话工作区的远端根（key 映射回占位形态的锚点）。 */
  remoteRootPath: string
  /** 会话工作区的占位本地路径。 */
  placeholderCwd: string
}

/**
 * 路径解析路由（纯函数）：cwd（或绝对 path 本身）落在占位树内 → remote。
 * cwd 优先（会话根语义）；绝对占位路径兜底（侧边栏回传的树键）。其余 →
 * undefined = 透传本地实现。
 */
export function routeFsPath(p: string, cwd?: string): RouteInfo | undefined {
  const base = cwd !== undefined ? mapLocalTreeToRemote(cwd) : null
  if (base !== null) {
    return {
      hostId: base.hostId,
      remotePath: posix.normalize(resolveRemotePath(p, base.remotePath, cwd)),
      remoteRootPath: base.remoteRootPath,
      placeholderCwd: cwd as string,
    }
  }
  if (path.isAbsolute(p) || posix.isAbsolute(p)) {
    const mapped = mapLocalTreeToRemote(p)
    if (mapped !== null) {
      return {
        hostId: mapped.hostId,
        remotePath: mapped.remotePath,
        remoteRootPath: mapped.remoteRootPath,
        placeholderCwd: mapped.placeholderRoot,
      }
    }
  }
  return undefined
}

/** targetKey（占位形态）→ 路由（纯函数）；非占位 key 返回 undefined。 */
export function routeFsTarget(target: FsTarget): { hostId: string; remotePath: string; key: string } | undefined {
  const key = String(target.targetKey)
  const mapped = mapLocalTreeToRemote(key)
  if (mapped === null) return undefined
  return { hostId: mapped.hostId, remotePath: mapped.remotePath, key }
}

/** 远端绝对路径 → 占位形态 key（纯函数）：工作区内 = 占位 cwd + 相对；外 = 单独编码段。 */
export function placeholderKeyFor(info: RouteInfo, remoteAbs: string): string {
  const rel = posix.relative(info.remoteRootPath, remoteAbs)
  if (rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel)) {
    return path.join(info.placeholderCwd, ...rel.split('/'))
  }
  return path.join(remoteRoot(), info.hostId, encodeRemotePath(remoteAbs))
}

/**
 * 在 fs 服务实例上安装远程路由补丁（服务可用时经 ctx.inject 触发）。
 * `enabled` 为假时全部方法透传本地实现（与插件总开关一致）。
 */
export function installRemoteFsSeam(ctx: Context, runtime: SshRuntime, enabled: () => boolean): void {
  ctx.inject(['fs'], (scope) => {
    const fs = scope.get('fs')
    if (fs === undefined) return

    /**
     * 0.1.1 类型面没有 readByteRange/watch（0.1.7 运行时实例有）——补丁
     * 经此 duck 视图读写；其余方法直接挂在强类型实例上。
     */
    const surface = fs as unknown as {
      readByteRange?: (target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal) => Promise<Uint8Array>
      watch?: (target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal) => Promise<() => Promise<void>>
    } & Record<string, unknown>

    // 原型方法先绑定（补丁存 own-property，卸载时 delete 恢复原型）。
    const original = {
      resolve: fs.resolve.bind(fs),
      lstat: fs.lstat.bind(fs),
      stat: fs.stat.bind(fs),
      listDir: fs.listDir.bind(fs),
      streamText: fs.streamText.bind(fs),
      readBytes: fs.readBytes.bind(fs),
      readByteRange: typeof surface.readByteRange === 'function' ? surface.readByteRange.bind(fs) : undefined,
      watch: typeof surface.watch === 'function' ? surface.watch.bind(fs) : undefined,
    }
    /** 本地后端不支持 watch 时的等价抛错（0.1.1 基类行为）。 */
    const unsupportedWatch = (): Promise<() => Promise<void>> =>
      Promise.reject(new FsError('Filesystem watching is not supported by this provider.', 'FS_IO_ERROR'))

    const sftpFor = (hostId: string): Promise<SFTPWrapper> =>
      runtime.getConnectionFor(hostId).then(connection => connection.getSftp())

    // ------------------------------------------------------- stat 微缓存
    // 键 = <op>:<hostId>:<remotePath>（lstat 与 stat 的符号链接语义不同，
    // 分开缓存；undefined = 负缓存，同样享受 TTL）。
    const statCache = new Map<string, { expires: number; info: FsPathInfo | FsInfo | undefined }>()
    const fetchStatInfo = (
      op: 'stat' | 'lstat',
      route: { hostId: string; remotePath: string },
      displayPath: string,
    ): Promise<FsPathInfo | FsInfo | undefined> => {
      const key = `${op}:${route.hostId}:${route.remotePath}`
      const now = Date.now()
      const hit = statCache.get(key)
      if (hit !== undefined && hit.expires > now) return Promise.resolve(hit.info)
      if (statCache.size >= STAT_CACHE_MAX_ENTRIES) {
        for (const [k, v] of statCache) if (v.expires <= now) statCache.delete(k)
      }
      const fetch = (async () => {
        try {
          const sftp = await sftpFor(route.hostId)
          const stats = await sftpCall<SftpStats>(cb =>
            op === 'lstat' ? sftp.lstat(route.remotePath, cb) : sftp.stat(route.remotePath, cb))
          debugLog(`fs seam ${op}: ${route.hostId}:${route.remotePath} ok`)
          return {
            version: versionOf(route.remotePath, stats),
            type: typeOf(stats, op === 'lstat'),
            ...(stats.isFile() ? { size: stats.size } : {}),
          } as FsPathInfo
        } catch (error) {
          if (isMissingPath(error)) {
            debugLog(`fs seam ${op}: ${route.hostId}:${route.remotePath} MISSING (${error instanceof Error ? error.message : String(error)})`)
            return undefined
          }
          debugLog(`fs seam ${op}: ${route.hostId}:${route.remotePath} ERROR ${error instanceof Error ? error.message : String(error)}`)
          throw wrapError(op, displayPath, error)
        }
      })()
      return fetch.then(info => {
        statCache.set(key, { expires: Date.now() + STAT_CACHE_TTL_MS, info })
        return info
      }, error => Promise.reject(error))
    }

    const resolveRoute = routeFsPath
    const routeOfTarget = routeFsTarget
    const placeholderKeyOf = placeholderKeyFor

    // ------------------------------------------------------------- resolve

    fs.resolve = async (p: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> => {
      if (!enabled()) return original.resolve(p, opts)
      opts?.signal?.throwIfAborted()
      if (typeof p !== 'string' || p.trim() === '') {
        throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
      }
      const route = resolveRoute(p, opts?.cwd)
      if (route === undefined) return original.resolve(p, opts)
      const key = placeholderKeyOf(route, route.remotePath)
      return { targetKey: FsTargetKey(key), displayPath: key }
    }

    // -------------------------------------------------------------- lstat

    fs.lstat = async (
      p: string,
      opts?: { cwd?: string },
      signal?: AbortSignal,
    ): Promise<FsPathInfo | undefined> => {
      if (!enabled()) return original.lstat(p, opts, signal)
      const route = resolveRoute(p, opts?.cwd)
      if (route === undefined) return original.lstat(p, opts, signal)
      signal?.throwIfAborted()
      return fetchStatInfo('lstat', route, p)
    }

    // --------------------------------------------------------------- stat

    fs.stat = async (target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> => {
      if (!enabled()) return original.stat(target, signal)
      const route = routeOfTarget(target)
      if (route === undefined) return original.stat(target, signal)
      signal?.throwIfAborted()
      // op 'stat' 的 typeOf 不放行 symlink（allowSymlink=false），值域即 FsInfo。
      return fetchStatInfo('stat', route, target.displayPath) as Promise<FsInfo | undefined>
    }

    // ------------------------------------------------------------- listDir

    fs.listDir = async (target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> => {
      if (!enabled()) return original.listDir(target, signal)
      const route = routeOfTarget(target)
      if (route === undefined) return original.listDir(target, signal)
      signal?.throwIfAborted()
      try {
        const sftp = await sftpFor(route.hostId)
        const listed = await sftpCall<Array<{ filename: string; attrs: SftpStats }>>(cb => sftp.readdir(route.remotePath, cb))
        debugLog(`fs seam listDir: ${route.hostId}:${route.remotePath} ok (${listed.length} entries)`)
        const entries: FsDirEntry[] = []
        for (const entry of listed) {
          const childKey = path.join(route.key, entry.filename)
          entries.push({
            name: entry.filename,
            type: typeOf(entry.attrs) as FsInfo['type'],
            target: { targetKey: FsTargetKey(childKey), displayPath: childKey },
            ...(entry.attrs.isFile() ? { size: entry.attrs.size } : {}),
          })
        }
        return entries.sort((left, right) => left.name.localeCompare(right.name))
      } catch (error) {
        if (isMissingPath(error)) {
          debugLog(`fs seam listDir: ${route.hostId}:${route.remotePath} MISSING (${error instanceof Error ? error.message : String(error)})`)
          throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
        }
        debugLog(`fs seam listDir: ${route.hostId}:${route.remotePath} ERROR ${error instanceof Error ? error.message : String(error)}`)
        throw wrapError('list', target.displayPath, error)
      }
    }

    // ----------------------------------------------------------- streamText

    fs.streamText = async (target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> => {
      if (!enabled()) return original.streamText(target, signal)
      const route = routeOfTarget(target)
      if (route === undefined) return original.streamText(target, signal)
      signal?.throwIfAborted()
      // 预检：缺失/非普通文件/超限（与本地后端错误码一致；走 stat 微缓存，
      // 与侧栏树形 stat 共享同一跳 RTT）。
      const info = await fetchStatInfo('stat', route, target.displayPath)
      if (info === undefined) {
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (info.size !== undefined && info.size > STREAM_TEXT_MAX_BYTES) {
        throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the streaming limit`, 'FS_TOO_LARGE')
      }
      const sftp = await sftpFor(route.hostId)
      const displayPath = target.displayPath
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
          const stream = sftp.createReadStream(route.remotePath)
          const decoder = new TextDecoder('utf-8', { fatal: true })
          let sampledBytes = 0
          let completed = false
          try {
            for await (const chunk of stream as AsyncIterable<Buffer>) {
              signal?.throwIfAborted()
              const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              if (sampledBytes < BINARY_SAMPLE_BYTES) {
                const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
                if (sample.includes(0)) {
                  throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
                }
                sampledBytes += sample.length
              }
              let text: string
              try {
                text = decoder.decode(bytes, { stream: true })
              } catch (error) {
                throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error as Error })
              }
              if (text.length > 0) yield text
            }
            try {
              decoder.decode()
            } catch (error) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error as Error })
            }
            completed = true
          } catch (error) {
            if (error instanceof FsError) throw error
            throw wrapError('read', displayPath, error)
          } finally {
            if (!completed) {
              try { stream.destroy() } catch { /* 提前停止后的销毁尽力而为 */ }
            }
          }
        },
      }
    }

    // ------------------------------------------------------------ readBytes

    fs.readBytes = async (target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> => {
      if (!enabled()) return original.readBytes(target, signal, maxBytes)
      const route = routeOfTarget(target)
      if (route === undefined) return original.readBytes(target, signal, maxBytes)
      signal?.throwIfAborted()
      const info = await fetchStatInfo('stat', route, target.displayPath)
      if (info === undefined) {
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (info.size !== undefined && info.size > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      const sftp = await sftpFor(route.hostId)
      try {
        const buffer = await sftpCall<Buffer>(cb => sftp.readFile(route.remotePath, cb))
        signal?.throwIfAborted()
        if (buffer.byteLength > maxBytes) {
          throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
        }
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      } catch (error) {
        if (error instanceof FsError) throw error
        if (isMissingPath(error)) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
        throw wrapError('read', target.displayPath, error)
      }
    }

    // -------------------------------------------------------- readByteRange

    const patchedReadByteRange = async (
      target: FsTarget,
      range: { offset: number; length: number },
      signal?: AbortSignal,
    ): Promise<Uint8Array> => {
      if (!enabled()) {
        if (original.readByteRange === undefined) {
          throw new FsError('readByteRange is not supported by this provider', 'FS_IO_ERROR')
        }
        return original.readByteRange(target, range, signal)
      }
      const route = routeOfTarget(target)
      if (route === undefined) {
        if (original.readByteRange === undefined) {
          throw new FsError('readByteRange is not supported by this provider', 'FS_IO_ERROR')
        }
        return original.readByteRange(target, range, signal)
      }
      signal?.throwIfAborted()
      if (range.length <= 0) return new Uint8Array(0)
      const sftp = await sftpFor(route.hostId)
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createReadStream(route.remotePath, { start: range.offset, end: range.offset + range.length - 1 })
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => resolve())
        stream.on('error', reject)
      })
      signal?.throwIfAborted()
      const buffer = Buffer.concat(chunks)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    }
    // 0.1.1 类型面没有该方法，但 0.1.7 运行时实例有——duck 写入。
    surface.readByteRange = patchedReadByteRange

    // --------------------------------------------------------------- watch

    surface.watch = async (
      target: FsTarget,
      changed: (error?: Error) => void,
      signal: AbortSignal,
    ): Promise<() => Promise<void>> => {
      if (!enabled()) return original.watch === undefined ? unsupportedWatch() : original.watch(target, changed, signal)
      const route = routeOfTarget(target)
      if (route === undefined) return original.watch === undefined ? unsupportedWatch() : original.watch(target, changed, signal)
      // 伪 watch（与 fs-ssh 同款）：SFTP 无 inotify，用 mtime/attrs 指纹轮询
      // 实现 content-free changed()。文件 = 1 RTT lstat 的 mtime+size；
      // 目录 = 1 RTT readdir 的 name+mtime+size 拼接；ENOENT 也是指纹
      // （观察创建/删除）。连续 WATCH_FAILURE_LIMIT 次失败才 changed(error)
      // 上报并自停（订阅方回退官方 watch-unsupported 手动刷新行为）。
      signal.throwIfAborted()
      let timer: ReturnType<typeof setInterval> | undefined
      let stopped = false
      let baseline: string | undefined
      let failures = 0

      const stop = (): void => {
        if (stopped) return
        stopped = true
        if (timer !== undefined) clearInterval(timer)
      }

      const fingerprint = async (): Promise<string> => {
        const sftp = await sftpFor(route.hostId)
        let stats: SftpStats
        try {
          stats = await sftpCall<SftpStats>(cb => sftp.lstat(route.remotePath, cb))
        } catch (error) {
          if (isMissingPath(error)) return 'absent'
          throw error
        }
        if (typeOf(stats, true) !== 'directory') return `f:${String(stats.mtime)}:${String(stats.size)}`
        const listed = await sftpCall<Array<{ filename: string; attrs: SftpStats }>>(cb => sftp.readdir(route.remotePath, cb))
        return `d:${listed
          .map(entry => `${entry.filename}:${String(entry.attrs.mtime)}:${String(entry.attrs.size)}`)
          .sort()
          .join('|')}`
      }

      const poll = async (): Promise<void> => {
        if (stopped || signal.aborted) return
        try {
          const next = await fingerprint()
          failures = 0
          if (baseline !== undefined && next !== baseline) {
            debugLog(`fs seam watch: ${route.hostId}:${route.remotePath} changed`)
            changed()
          }
          baseline = next
        } catch (error) {
          if (signal.aborted || stopped) return
          failures += 1
          if (failures >= WATCH_FAILURE_LIMIT) {
            stop()
            debugLog(`fs seam watch: ${route.hostId}:${route.remotePath} giving up after ${failures} failures`)
            changed(error instanceof Error ? error : new Error(String(error)))
          }
        }
      }

      // 初始化即观察就绪（契约：resolve 后 closeFn 才交还）。
      baseline = await fingerprint()
      if (signal.aborted) {
        stop()
        return async () => { stop() }
      }
      timer = setInterval(() => { void poll() }, WATCH_POLL_MS)
      timer.unref?.()
      return async () => { stop() }
    }

    debugLog('fs seam: remote routing installed (resolve/lstat/stat/listDir/streamText/readBytes/readByteRange/watch)')
    scope.effect(() => () => {
      for (const key of ['resolve', 'lstat', 'stat', 'listDir', 'streamText', 'readBytes', 'readByteRange', 'watch']) {
        delete (fs as unknown as Record<string, unknown>)[key]
      }
      debugLog('fs seam: remote routing uninstalled')
    }, 'dsh-remote-ide: fs seam teardown')
  })
}
