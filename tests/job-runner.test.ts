/**
 * job-runner 单测 —— fake engine（可编程通道/exec）+ fake JobRegistry（捕获 spec）。
 * 覆盖：background 返回、spec 形状（0.2.x：output 拉源而非 readOutput）、wrapper 协议、
 * done 三态（流式 job 无 output 字段，对齐 dsh-jobs d.ts「stream jobs leave it unset」）、
 * 日志拉源的字节游标/UTF-8 边界/整块提示/失败容忍、cancel 幂等与 TERM→KILL 升级、
 * jobs 缺失报错。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startRemoteJob } from '../src/job-runner'
import type { JobOutputSource, JobSpec } from '@deepseek-ai/dsh-jobs'

type CloseListener = (code: number | null, signal: string | null) => void
class FakeChannel {
  closeListeners: CloseListener[] = []
  onClose(l: CloseListener) { this.closeListeners.push(l) }
  fire(code: number | null, signal: string | null) { for (const l of [...this.closeListeners]) l(code, signal) }
}

const okResult = (stdout = '') => ({ success: true, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 1 })

function makeFakes() {
  const channel = new FakeChannel()
  const openChannel = vi.fn(async () => channel as never)
  const exec = vi.fn(async () => okResult())
  const engine = { openChannel, exec, homeOf: () => '/root' } as never
  let spec: JobSpec | undefined
  const jobs = { start: (s: JobSpec) => { spec = s; return 'ssh-1' } } as never
  return { channel, openChannel, exec, engine, jobs, spec: () => spec! }
}

/** 取第 n 次 exec 调用的命令串列表。 */
const execCommands = (exec: { mock: { calls: unknown[][] } }) =>
  exec.mock.calls.map(c => (c as [string, string])[1])

/** spec.output 里唯一的日志拉源（registry 的拉取面）。 */
const logSource = (f: { spec: () => JobSpec }): JobOutputSource => {
  const sources = f.spec().output
  expect(Array.isArray(sources)).toBe(true)
  return sources![0]!
}

/** openChannel 是异步的：等通道 onClose 监听器挂上再驱动 close 事件。 */
async function awaitChannel(f: { channel: FakeChannel }) {
  await vi.waitFor(() => expect(f.channel.closeListeners.length).toBe(1))
}

describe('startRemoteJob', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('返回 background 形状并以 kind=ssh/label=命令注册 spec（output = 日志拉源）', () => {
    const f = makeFakes()
    const out = startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'make build' })
    expect(out).toEqual({ kind: 'background', jobId: 'ssh-1' })
    const spec = f.spec()
    expect(spec.kind).toBe('ssh')
    expect(spec.label).toBe('make build')
    expect(typeof spec.run).toBe('function')
    expect(spec.outputLimitBytes).toBe(8192)
    expect(spec.owner).toBeUndefined() // 无归属会话 = 无主 job
    expect(Array.isArray(spec.output)).toBe(true)
    expect(spec.output).toHaveLength(1)
    expect(typeof spec.output![0]!.read).toBe('function')
  })

  it('归属会话：owner 透传为 SessionId（官方 bash 同款 exec.agent.id）', () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x', owner: 'session-7' as never })
    expect(f.spec().owner).toBe('session-7')
  })

  it('wrapper 协议：pidfile + exec bash -c + 日志重定向，路径 quoteSh', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: "echo it's", cwd: '/work' })
    const hooks = f.spec().run as () => unknown
    void hooks()
    const [alias, wrapper, opts] = f.openChannel.mock.calls[0] as [string, string, { cwd?: string }]
    expect(alias).toBe('dev')
    expect(opts.cwd).toBe('/work')
    expect(wrapper.startsWith("printf %s $$ > '/tmp/dsh-job-")).toBe(true)
    expect(wrapper).toContain(".pid' && exec bash -c ")
    expect(wrapper).toContain("'echo it'\\''s'")
    expect(wrapper).toMatch(/> '\/tmp\/dsh-job-[0-9a-f-]+\.log' 2>&1$/)
  })

  it('jobs 缺失 → throw 官方同款文案', () => {
    const f = makeFakes()
    expect(() => startRemoteJob({ engine: f.engine, jobs: undefined }, { hostId: 'dev', command: 'x' }))
      .toThrow(/background jobs unavailable/)
  })

  it('done：exit code 3 → completed + detail（流式 job 无 output 字段）', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(3, null)
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 3' })
  })

  it('done：signal → killed', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(null, 'SIGTERM')
    await expect(hooks.done).resolves.toEqual({ status: 'killed', detail: 'SIGTERM' })
  })

  it('done：无码无号 + kill -0 探测存活 → failed 带孤儿 pid/log 提示', async () => {
    const f = makeFakes()
    f.exec.mockImplementation(async (_a: string, cmd: string) => okResult(cmd.startsWith("bash -c 'kill -0") ? 'alive' : ''))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(null, null)
    const o = await hooks.done
    expect(o.status).toBe('failed')
    expect(String(o.detail)).toMatch(/may still be running/)
    expect(String(o.detail)).toMatch(/\/tmp\/dsh-job-.*\.log/)
  })

  it('done 只 settle 一次（close 后重复事件被忽略）', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await awaitChannel(f)
    f.channel.fire(0, null)
    f.channel.fire(1, null)
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'exit code: 0' })
  })

  it('output 拉源：异步泵取回块后续读交付；字节游标 tail -c +1 → +N', async () => {
    const f = makeFakes()
    let delivered = false
    f.exec.mockImplementation(async (_a: string, cmd: string) => {
      if (cmd.startsWith('tail -c ') && !delivered) { delivered = true; return okResult(Buffer.from('tick1\n').toString('base64')) }
      return okResult()
    })
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const source = logSource(f)
    expect(source.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false }) // 首调只启动泵，无积压
    let read = source.read(0)
    await vi.waitFor(() => {
      // 泵在推进；持续续读直到取回
      read = source.read(0)
      expect(read.text).toContain('tick1')
    })
    const tickBytes = Buffer.byteLength('tick1\n')
    expect(read.nextOffset).toBe(tickBytes)
    expect(read.lossy).toBe(false)
    // 自 nextOffset 续读：无新块 → 空文本、偏移不变
    expect(source.read(read.nextOffset)).toEqual({ text: '', nextOffset: tickBytes, lossy: false })
    const pulls = execCommands(f.exec).filter(c => c.startsWith('tail -c '))
    expect(pulls[0]).toMatch(/^tail -c \+1 '\/tmp\/dsh-job-[0-9a-f-]+\.log' 2>\/dev\/null \| head -c 65536 \| base64 -w0$/)
    expect(pulls.some(c => c.startsWith(`tail -c +${tickBytes + 1} `))).toBe(true)
  })

  it('output 拉源：exec 失败（断连/日志未生成）→ 空读不抛', async () => {
    const f = makeFakes()
    f.exec.mockRejectedValue(new Error('disconnected'))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const source = logSource(f)
    await vi.waitFor(() => expect(source.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false }))
  })

  it('output 拉源：整块附带完整日志提示；劈裂的 UTF-8 字符留到下次续读', async () => {
    const f = makeFakes()
    // 64KiB 整块，块尾劈开一个三字节字符「中」(e4 b8 ad) 的前两字节。
    const block = Buffer.alloc(65536, 0x61)
    block[65534] = 0xe4
    block[65535] = 0xb8
    f.exec.mockImplementation(async (_a: string, cmd: string) => {
      if (cmd.startsWith('tail -c +1 ')) return okResult(block.toString('base64'))
      if (cmd.startsWith('tail -c +65537 ')) return okResult(Buffer.from([0xad, 0x0a]).toString('base64'))
      return okResult()
    })
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const source = logSource(f)
    let read = source.read(0)
    await vi.waitFor(() => {
      read = source.read(0)
      expect(read.text).not.toBe('')
    })
    // 整块 → 提示；续读偏移退回到字符边界（65536 - 2）。
    expect(read.text.startsWith('a'.repeat(65534))).toBe(true)
    expect(read.text).toContain('[more output; full log: /tmp/dsh-job-')
    expect(read.text).not.toContain('\uFFFD')
    expect(read.nextOffset).toBe(65534)
    // 下一次自边界续读拿到完整字符 + 后续字节。
    await vi.waitFor(() => {
      read = source.read(65534)
      expect(read.text).toBe('中\n')
    })
    expect(read.nextOffset).toBe(65538)
    expect(read.lossy).toBe(false)
  })

  it('output 拉源：请求偏移早于本地保留窗口 → lossy 如实上报', async () => {
    const f = makeFakes()
    // 两个 64KiB 整块：'a' 块与 'b' 块（共 128KiB）。
    f.exec.mockImplementation(async (_a: string, cmd: string) => {
      if (cmd.startsWith('tail -c +1 ')) return okResult(Buffer.alloc(65536, 0x61).toString('base64'))
      if (cmd.startsWith('tail -c +65537 ')) return okResult(Buffer.alloc(65536, 0x62).toString('base64'))
      return okResult()
    })
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const source = logSource(f)
    await vi.waitFor(() => expect(source.read(0).nextOffset).toBe(131072))
    // 游标推进到末尾：本地只保留游标前 64KiB，首块被裁掉。
    source.read(131072)
    const stale = source.read(0)
    expect(stale.lossy).toBe(true)
    expect(stale.text.startsWith('b')).toBe(true)
    expect(stale.nextOffset).toBe(131072)
  })

  it('cancel：TERM 一次、幂等、5s 后升级 KILL', async () => {
    const f = makeFakes()
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { cancel(): void })()
    await awaitChannel(f)
    hooks.cancel()
    hooks.cancel()
    await vi.waitFor(() => {
      const kills = execCommands(f.exec).filter(c => c.includes('kill -'))
      expect(kills).toHaveLength(1)
      expect(kills[0]).toContain("kill -TERM -$(cat")
    })
    await vi.advanceTimersByTimeAsync(5_100)
    const escalated = execCommands(f.exec).filter(c => c.includes('kill -'))
    expect(escalated).toHaveLength(2)
    expect(escalated[1]).toContain("kill -KILL -$(cat")
  })

  it('通道建立失败 → done=failed（错误消息透传）', async () => {
    const f = makeFakes()
    f.openChannel.mockRejectedValue(new Error('unknown host: dev'))
    startRemoteJob({ engine: f.engine, jobs: f.jobs }, { hostId: 'dev', command: 'x' })
    const hooks = (f.spec().run as () => { done: Promise<Record<string, unknown>> })()
    await expect(hooks.done).resolves.toEqual({ status: 'failed', detail: 'unknown host: dev' })
  })
})
