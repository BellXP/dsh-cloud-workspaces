/**
 * dsh-remote-ide — 远程后台任务生产者（ctx.jobs seam 的 SSH 实现）。
 *
 * 设计（docs/07）：registry 永不下远程（官方 E2B 先例），远程性=本模块。
 * 常驻 exec 通道跑 wrapper `printf %s $$ > pidfile && exec bash -c '<cmd>' > log 2>&1`
 * ——sshd 为每条通道建独立进程组，`$$`（exec 前后不变）即 pgid。
 * - done：通道 close 的 (code, signal) 是唯一权威退出事实（零轮询）；
 *   非零码=completed+detail（对齐官方），signal=killed，无码无号=传输断，
 *   探测 kill -0 后如实报告孤儿可能（pid/log 路径），不谎称工作已停。
 * - output：dsh 0.2.x 的 JobHooks 没有 readOutput——日志经 JobOutputSource
 *   拉源交给 registry 按自己的节奏泵入输出环（`read(fromByte)` 返回自该
 *   偏移起的新增文本与下次续读偏移）。拉源内部仍是异步预取泵（3s 间隔 +
 *   调用驱动）：`tail -c +N | head -c 64KiB | base64 -w0` 按字节偏移拉远端
 *   日志（base64 传输让字节游标与多字节字符都不受 exec 通道 UTF-8 解码影响；
 *   0.1.x 的 dd 块对齐在块未写满时会跳过该块剩余字节——按字节游标没有这个
 *   洞），续读偏移只落在 UTF-8 字符边界，已交付字节在本地即时裁剪，内存有界。
 * - cancel：同步幂等标记 + fire-and-forget 杀进程组（TERM→5s→KILL）。
 * 流式 job 的 done 不带 output（dsh-jobs d.ts：stream jobs leave it unset）。
 */

import { randomUUID } from 'node:crypto'
import type { JobHooks, JobOutcome, JobOutputSource, JobRegistry, JobSourceRead, JobSpec } from '@deepseek-ai/dsh-jobs'
import type { SshEngine } from './engine'
import { quoteSh } from './engine'
import { debugLog } from './debug-log'

/** 声明合并扩 kind：id 前缀 ssh-<uuid>。 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    ssh: 'ssh'
  }
}

export interface JobRunnerDeps {
  engine: SshEngine
  /** index.ts 经 ctx.get('jobs') 解析；缺失=能力不可用（官方同款报错）。 */
  jobs: JobRegistry | undefined
}

export interface RemoteJobSpec {
  hostId: string
  /** 用户命令原文（与前台执行同一信任边界）。 */
  command: string
  /** 远程工作目录（省略=连接默认目录）。 */
  cwd?: string
  /** 归属会话（exec.agent.id，官方 bash 同款 owner 传法）；省略=无主 job。 */
  owner?: NonNullable<JobSpec['owner']>
}

/**
 * 工具执行上下文的最小形状（dsh-tools ToolRunContext 的结构子集）：只取
 * 归属 agent 的会话 id——0.2.x 的 JobSpec.owner 是 SessionId（官方 bash 同款
 * 传 exec.agent.id），不再是 0.1.x 的 agent 本体。
 */
export interface JobExecLike {
  agent?: { id: NonNullable<JobSpec['owner']> } | undefined
}

/** 从工具执行上下文取后台 job 的归属会话字段（无 agent = 无主 job）。 */
export function jobOwnerOf(exec: JobExecLike | undefined): { owner?: NonNullable<JobSpec['owner']> } {
  return exec?.agent !== undefined ? { owner: exec.agent.id } : {}
}

const READ_CHUNK = 65536
const OUTPUT_LIMIT_BYTES = 8192
const KILL_ESCALATION_MS = 5_000
const PUMP_INTERVAL_MS = 3_000
/** 已交付字节在本地的保留余量（裁剪线 = 调用方游标 - 余量）。 */
const RETAINED_BEHIND_CURSOR_BYTES = 64 * 1024

export function startRemoteJob(deps: JobRunnerDeps, spec: RemoteJobSpec): { kind: 'background'; jobId: string } {
  const { engine, jobs } = deps
  if (jobs === undefined) {
    throw new Error('background jobs unavailable — load @deepseek-ai/dsh-jobs (dsh-base)')
  }
  const runId = randomUUID()
  const pidPath = `/tmp/dsh-job-${runId}.pid`
  const logPath = `/tmp/dsh-job-${runId}.log`
  const log = new RemoteLogSource(engine, spec.hostId, logPath)
  const jobId = jobs.start({
    kind: 'ssh',
    label: spec.command,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    ...(spec.owner !== undefined ? { owner: spec.owner } : {}),
    output: [log],
    run: () => buildHooks(engine, spec, pidPath, logPath, log),
  })
  return { kind: 'background', jobId }
}

/**
 * 远端日志的拉源（JobOutputSource）：registry 按自己的节奏调用
 * `read(fromByte)`，本方返回自该字节偏移起的新增文本与下次续读偏移。
 * 预取泵独立于读取节奏（3s 定时 + 每次 read 触发一次），已交付字节在本地
 * 裁剪，`lossy` 如实上报请求偏移早于本地保留窗口的情况。
 */
export class RemoteLogSource implements JobOutputSource {
  /** 连续原始字节块（自 `start` 起）。 */
  private chunks: Buffer[] = []
  /** chunks[0] 的绝对字节偏移。 */
  private start = 0
  /** 已接收字节的绝对末端。 */
  private total = 0
  /** 远端拉取游标（绝对字节偏移；`tail -c +N` 的 N = cursor + 1）。 */
  private cursor = 0
  /** 在途拉取（同一时刻最多一条；undefined = 空闲）。 */
  private inflight: Promise<void> | undefined
  /** 上次拉到整块：下次 read 附带「完整日志在远端」提示。 */
  private hintPending = false
  private stopped = false
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly engine: SshEngine,
    private readonly hostId: string,
    private readonly logPath: string,
  ) {
    this.timer = setInterval(() => { this.pump() }, PUMP_INTERVAL_MS)
    this.timer.unref?.()
    // 不在构造里立刻拉取：日志文件此刻多半尚未生成，首拉交给定时器与
    // registry 的首次 read（与 0.1.x 泵的启动时机一致）。
  }

  /** job 结算后停泵（结算前的最终 drain 见 drainFinal）。 */
  dispose(): void {
    this.stopped = true
    clearInterval(this.timer)
  }

  /**
   * 结算前的最终排水：等在途拉取落定后再拉一轮，让 registry 结算时的最后
   * 一次 read 看到进程退出前写下的尾部输出（否则最后 ≤3s 的输出会丢）。
   * 失败静默——排水是尽力而为，done 不因此 reject。
   */
  async drainFinal(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    try {
      await this.inflight
      await this.pump(true)
    } catch { /* 尽力而为 */ }
  }

  /** @inheritdoc */
  read(fromByte: number): JobSourceRead {
    this.pump()
    // 已交付（早于调用方游标）的字节裁掉，保留小段余量兜底重复读。
    const floor = Math.max(this.start, fromByte - RETAINED_BEHIND_CURSOR_BYTES)
    while (this.chunks.length > 0 && this.start + this.chunks[0]!.length <= floor) {
      this.start += this.chunks.shift()!.length
    }
    // 续读偏移只落在 UTF-8 字符边界：块尾被劈开的多字节字符留到下次。
    const end = this.charBoundaryBefore(this.total)
    let text = this.sliceBytes(fromByte, end).toString('utf8')
    if (this.hintPending) {
      text += `\n[more output; full log: ${this.logPath}]`
      this.hintPending = false
    }
    return { text, nextOffset: end, lossy: fromByte < this.start }
  }

  /**
   * ≤ offset 的最大 UTF-8 字符边界：块尾若劈开了多字节字符（前导字节 + 若干
   * 续字节，序列尚不完整），边界退到该字符的前导字节之前；孤立续字节（非法
   * 序列）原样交付，交由解码器按替换字符处理。
   */
  private charBoundaryBefore(offset: number): number {
    let continuations = 0
    while (continuations < 3 && offset - continuations > this.start) {
      const byte = this.byteAt(offset - continuations - 1)
      if (byte === undefined || (byte & 0xC0) !== 0x80) break
      continuations += 1
    }
    if (continuations === 0) return offset
    const lead = this.byteAt(offset - continuations - 1)
    if (lead === undefined) return offset - continuations
    const expected = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 0
    if (expected === 0 || continuations + 1 >= expected) return offset
    return offset - continuations - 1
  }

  private byteAt(offset: number): number | undefined {
    let position = this.start
    for (const chunk of this.chunks) {
      if (offset < position + chunk.length) return chunk[offset - position]
      position += chunk.length
    }
    return undefined
  }

  /** [fromByte, end) 的原始字节（早于本地窗口的按窗口起点截）。 */
  private sliceBytes(fromByte: number, end: number): Buffer {
    const from = Math.max(fromByte, this.start)
    const stop = Math.min(end, this.total)
    if (stop <= from) return Buffer.alloc(0)
    const parts: Buffer[] = []
    let offset = this.start
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length
      if (chunkEnd > from && offset < stop) {
        const lo = Math.max(0, from - offset)
        const hi = Math.min(chunk.length, stop - offset)
        parts.push(chunk.subarray(lo, hi))
      }
      offset = chunkEnd
      if (offset >= stop) break
    }
    return Buffer.concat(parts)
  }

  /**
   * 拉取远端日志的下一个 ≤64KiB 块（base64 传输保证字节精确；失败下轮再拉）。
   * 同一时刻只有一条在途拉取；结算后的最终排水（drainFinal）以 force 例外。
   */
  private pump(force = false): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    if (this.stopped && !force) return Promise.resolve()
    const run = this.engine.exec(this.hostId,
      `tail -c +${this.cursor + 1} ${quoteSh(this.logPath)} 2>/dev/null | head -c ${READ_CHUNK} | base64 -w0`)
      .then((r) => {
        if (!r.success || r.stdout === '') return
        const bytes = Buffer.from(r.stdout.trim(), 'base64')
        if (bytes.length === 0) return
        this.cursor += bytes.length
        this.chunks.push(bytes)
        this.total += bytes.length
        // 整块 = 远端大概率还有更多：下次 read 带上完整日志路径提示。
        if (bytes.length >= READ_CHUNK) this.hintPending = true
      })
      .catch(() => { /* 日志未生成/断连：下轮再拉 */ })
      .finally(() => { this.inflight = undefined })
    this.inflight = run
    return run
  }
}

function buildHooks(engine: SshEngine, spec: RemoteJobSpec, pidPath: string, logPath: string, log: RemoteLogSource): JobHooks {
  const q = quoteSh
  let settled = false
  let settle!: (o: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => { settle = resolve })

  // cancel 状态
  let cancelRequested = false
  let killStarted = false
  let channelReady = false
  let escalateTimer: NodeJS.Timeout | undefined

  const finish = (o: JobOutcome): void => {
    if (settled) return
    settled = true
    log.dispose()
    if (escalateTimer !== undefined) clearTimeout(escalateTimer)
    settle(o)
  }

  const killGroup = (sig: 'TERM' | 'KILL'): void => {
    engine.exec(spec.hostId, `bash -c ${q(`kill -${sig} -$(cat ${pidPath})`)}`)
      .catch((error) => { debugLog(`job kill -${sig} failed: ${error instanceof Error ? error.message : String(error)}`) })
  }
  const requestCancel = (): void => {
    if (killStarted) return
    killStarted = true
    killGroup('TERM')
    escalateTimer = setTimeout(() => { if (!settled) killGroup('KILL') }, KILL_ESCALATION_MS)
    escalateTimer.unref?.()
  }

  engine.openChannel(
    spec.hostId,
    `printf %s $$ > ${q(pidPath)} && exec bash -c ${q(spec.command)} > ${q(logPath)} 2>&1`,
    spec.cwd !== undefined ? { cwd: spec.cwd } : {},
  ).then((channel) => {
    channelReady = true
    channel.onClose((code, signal) => {
      // 先做最终排水（尾部输出不丢），再按通道 close 事实结算。
      void log.drainFinal().then(() => settleClosed(code, signal))
    })
    if (cancelRequested) requestCancel()
  }).catch((error: unknown) => {
    finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
  })

  return {
    cancel: (): void => {
      cancelRequested = true
      if (channelReady) requestCancel()
      // 通道未建立：open resolve 后补杀；reject 路径 finish 已兜底（远端未起进程）。
    },
    done,
  }

  /** 通道 close 的权威退出事实 → 结算（见模块头注释的三态）。 */
  function settleClosed(code: number | null, signal: string | null): void {
    if (settled) return
    if (code !== null) { finish({ status: 'completed', detail: `exit code: ${String(code)}` }); return }
    if (signal !== null) { finish({ status: 'killed', detail: signal }); return }
    // 无码无号=传输断。探测一次：进程还活着就如实报告孤儿，绝不谎称已停。
    engine.exec(spec.hostId, `bash -c ${q(`kill -0 $(cat ${pidPath})`)}`)
      .then((probe) => finish(probe.success
        ? { status: 'failed', detail: `connection lost; remote process may still be running (pid file ${pidPath}, log ${logPath})` }
        : { status: 'failed', detail: `exit status unknown (connection lost); log: ${logPath}` }))
      .catch(() => finish({ status: 'failed', detail: `connection lost; state of remote process unknown; log: ${logPath}` }))
  }
}
