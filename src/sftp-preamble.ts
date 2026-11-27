/**
 * SFTP 前缀同步：丢掉服务端 VERSION 包之前的所有字节。
 *
 * sshd 经用户的登录 shell 启动 SFTP 子系统（`$SHELL -c sftp-server`），而登录 shell 可能往
 * **stdout** 打印东西——欢迎横幅、使用提示、任何脚本输出。SFTP 没有文本的概念：ssh2 把收到的
 * 前 4 个字节当包长度读，于是报 `Packet length 543121184 exceeds max length of 262144`
 * （OpenSSH 的 sftp 报 `Received message too long … Ensure the remote shell produces no output`）。
 *
 * 节点不该为了客户端改自己的 shell，所以由客户端同步：真正的 SFTP 服务端开口第一个包必然是
 * `SSH_FXP_VERSION`，在它之前的一律丢弃。安静的 shell 一个字节都不会丢，行为与原来完全一致。
 *
 * 挂载点是 ssh2 的 `SFTP.prototype.push`——该实例所有入站数据都经这一个方法解析。
 * 拿不到这个内部形状时（ssh2 换了布局）直接放弃，退回原来的报错，不做任何猜测性的修补。
 */

import { createRequire } from 'node:module'

/** 超过这么多字节还没见到 VERSION 包，就不是横幅了：按错误处理，不无限缓存。 */
const MAX_PREAMBLE_BYTES = 256 * 1024

/** `push()` 所在实例里用得到的那部分状态（ssh2 `SFTP` 的结构子集）。 */
interface PreambleTarget {
  /** -1 直到 VERSION 处理完；之后的入站数据直接放行。 */
  _version: number
  _dshGate?: PreambleGate
  emit(event: string, error: Error): boolean
}

export interface PreambleGate {
  synced: boolean
  pending: Buffer
}

export type GateResult =
  | { kind: 'pass'; data: Buffer }
  | { kind: 'buffer' }
  | { kind: 'overflow' }

/**
 * `buf` 里第一个格式正确的 `SSH_FXP_VERSION` 包的偏移，找不到返回 -1。
 * 包头：uint32 长度（≥5，≤256 KiB）、byte 2（VERSION）、uint32 版本号（3–6）。
 * 文本横幅里不会出现 0x00，所以第一个 `00 00` 开头且满足上述形状的位置就是它。
 */
export function findVersionPacket(buf: Buffer): number {
  for (let i = 0; i + 9 <= buf.length; i += 1) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue
    const length = buf.readUInt32BE(i)
    if (length < 5 || length > 262_144) continue
    if (buf[i + 4] !== 2) continue
    const version = buf.readUInt32BE(i + 5)
    if (version < 3 || version > 6) continue
    return i
  }
  return -1
}

/** 一步门控：放行、继续攒、或者放弃（前缀超过上限）。 */
export function gatePreamble(gate: PreambleGate, data: Buffer): GateResult {
  if (gate.synced) return { kind: 'pass', data }
  const buffered = gate.pending.length === 0 ? data : Buffer.concat([gate.pending, data])
  const start = findVersionPacket(buffered)
  if (start === -1) {
    if (buffered.length > MAX_PREAMBLE_BYTES) return { kind: 'overflow' }
    gate.pending = buffered
    return { kind: 'buffer' }
  }
  gate.synced = true
  gate.pending = Buffer.alloc(0)
  return { kind: 'pass', data: start === 0 ? buffered : buffered.subarray(start) }
}

let installed: boolean | undefined

/**
 * 给 ssh2 的 SFTP 装上前缀同步（幂等）。返回是否装上；没装上时一切如旧。
 * 从 `engine.ts` 的模块加载处调用——哪一个 bundle 里有 SshEngine，哪一个就需要它。
 */
export function installSftpPreambleSkip(): boolean {
  if (installed !== undefined) return installed
  installed = false
  let proto: { push(this: PreambleTarget, data: Buffer): void } | undefined
  try {
    // ssh2 没有 exports 映射，深引到协议实现；同一个包实例，与 `import { Client } from 'ssh2'` 共享。
    const require = createRequire(import.meta.url)
    const protocol = require('ssh2/lib/protocol/SFTP.js') as {
      SFTP?: { prototype: { push(this: PreambleTarget, data: Buffer): void } }
    }
    proto = protocol.SFTP?.prototype
  } catch {
    return false
  }
  if (proto === undefined || typeof proto.push !== 'function') return false
  const originalPush = proto.push
  proto.push = function push(this: PreambleTarget, data: Buffer): void {
    // VERSION 已被解析（_version ≥ 0）之后的数据原样交给 ssh2；流结束（null）同理。
    if (data === null || this._version >= 0) {
      originalPush.call(this, data)
      return
    }
    // 门在实例第一次收到数据时现建：构造函数没有可挂的钩子。
    const gate = (this._dshGate ??= { synced: false, pending: Buffer.alloc(0) })
    const result = gatePreamble(gate, data)
    if (result.kind === 'buffer') return
    if (result.kind === 'overflow') {
      // 不是横幅：停止同步，让 ssh2 用它自己的报错（包长度超限）如实说出来。
      gate.synced = true
      originalPush.call(this, gate.pending)
      return
    }
    this._dshGate = undefined
    originalPush.call(this, result.data)
  }
  installed = true
  return true
}
