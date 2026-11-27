/**
 * SshEngine 上的两段接线：
 *   - readdir 兜底如何落到连接记录（`listingViaShell`）——之后 `ls()` 不再先开 SFTP；
 *   - 常驻辅助 shell（`UtilityShell`）的哨兵协议——命令串行、超时即关闭并在下次调用重开。
 * 用可编程的 ssh2 假实现，不连任何真机。现场见 sftp-resilience.test.ts 的文件头。
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshEngine } from '../src/engine'
import { HostStore } from '../src/store'
import { findListingCommand } from '../src/sftp-list'

const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
  class Emitter {
    private listeners = new Map<string, Handler[]>()
    on(event: string, cb: Handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]); return this }
    once(event: string, cb: Handler) {
      const wrapper: Handler = (...args) => { this.off(event, wrapper); cb(...args) }
      return this.on(event, wrapper)
    }
    off(event: string, cb: Handler) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((h) => h !== cb)) }
    removeListener(event: string, cb: Handler) { this.off(event, cb) }
    emit(event: string, ...args: unknown[]) { for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args); return this }
  }

  /** 一条可编程的 exec 通道：测试往通道写命令，决定何时回什么。 */
  class FakeChannel extends Emitter {
    stderr = new Emitter()
    written = ''
    onWrite?: (data: string) => void
    write(data: string) { this.written += data; this.onWrite?.(data) }
    close() { this.emit('close', 0) }
    /** 模拟远端执行一条命令并打出哨兵。 */
    answer(output: string, code = 0) { this.emit('data', Buffer.from(`${output}\n__DSH_REMOTE_IDE_EXIT__${code}__\n`)) }
  }

  class FakeClient extends Emitter {
    static last: FakeClient
    channels: FakeChannel[] = []
    sftpCb: ((cb: (err: unknown, sftp: unknown) => void) => void) | undefined
    constructor() { super(); FakeClient.last = this }
    connect() { setImmediate(() => this.emit('ready')); return this }
    end() {}
    /** 默认的 exec：立刻回数据并关闭（connect() 解析 HOME 的那条命令需要）。 */
    exec(_command: string, cb: (err: unknown, stream: FakeChannel) => void) {
      const channel = new FakeChannel()
      this.channels.push(channel)
      queueMicrotask(() => { cb(null, channel); channel.emit('data', Buffer.from('/home/root')); channel.emit('close', 0) })
      return this
    }
    sftp(cb: (err: unknown, sftp: unknown) => void) { this.sftpCb?.(cb) ?? cb(new Error('no fake sftp')) }
  }
  return { FakeClient, FakeChannel }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

function newEngine(): SshEngine {
  const storeFile = join(tmpdir(), `dsh-remote-ide-resilience-${process.pid}-${Math.random()}.json`)
  const store = new HostStore(storeFile)
  store.upsert({ alias: 'dev', host: '10.0.0.1', user: 'root', auth: { kind: 'password', password: 'secret' } })
  return new SshEngine(store, { sftpReaddirTimeoutMs: 40 })
}

type UtilityRunner = (alias: string, command: string, timeoutMs: number) => Promise<{ success: boolean; exitCode: number | null; stdout: string; timedOut: boolean; error?: string }>
const runner = (engine: SshEngine): UtilityRunner => (engine as unknown as { runUtility: UtilityRunner }).runUtility.bind(engine)

/** 让 exec 起一条常驻的辅助 shell：每条写入的命令立刻按哨兵协议应答。 */
function scriptableShell(client: InstanceType<typeof fake.FakeClient>, respond: (command: string) => { out: string; code?: number } | undefined): fake.FakeChannel[] {
  const opened: fake.FakeChannel[] = []
  client.exec = ((_command: string, cb: (err: unknown, stream: fake.FakeChannel) => void) => {
    const channel = new fake.FakeChannel()
    opened.push(channel)
    channel.onWrite = (data) => {
      const command = /^(.*); printf/.exec(data)?.[1] ?? ''
      const reply = respond(command)
      if (reply !== undefined) channel.answer(reply.out, reply.code ?? 0)
    }
    queueMicrotask(() => cb(null, channel))
    return client
  }) as typeof client.exec
  return opened
}

describe('SshEngine: the listing fallback lands on the connection record', () => {
  it('a READDIR that never answers switches the record to shell listing; later ls() calls skip SFTP', async () => {
    const engine = newEngine()
    await engine.connect('dev')
    const client = fake.FakeClient.last
    const deadSftp = { readdir: vi.fn(), stat: vi.fn(), end: vi.fn() }
    const sftpOpens = vi.fn()
    client.sftpCb = (cb) => { sftpOpens(); cb(null, deadSftp) }
    const shell = scriptableShell(client, (command) => {
      const dir = /^find -L '([^']+)'/.exec(command)?.[1]
      return dir === undefined ? undefined : { out: `d\t4096\t1700000000.0\t755\t${dir === '/home/u' ? 'work' : 'other'}\t\0` }
    })

    const started = Date.now()
    const first = await engine.ls('dev', '/home/u')
    expect(first.map((e) => e.name)).toEqual(['work'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(40) // the READDIR timeout was paid once
    expect(deadSftp.end).toHaveBeenCalledTimes(1) // the dead SFTP session was dropped
    const record = (engine as unknown as { pool: Map<string, { listingViaShell?: boolean; sftp?: unknown }> }).pool.get('dev')
    expect(record?.listingViaShell).toBe(true)
    expect(record?.sftp).toBeUndefined()

    // afterwards: no SFTP open, no second helper shell, no READDIR timeout
    const secondStarted = Date.now()
    const second = await engine.ls('dev', '/home/u')
    expect(second.map((e) => e.name)).toEqual(['work'])
    expect(Date.now() - secondStarted).toBeLessThan(40)
    expect(sftpOpens).toHaveBeenCalledTimes(1)
    expect(shell).toHaveLength(1)
    engine.dispose()
  })
})

describe('UtilityShell: one long-lived helper channel per connection', () => {
  it('runs commands one at a time, frames each with the exit sentinel, and reports stdout and code', async () => {
    const engine = newEngine()
    await engine.connect('dev')
    const run = runner(engine)
    const shell = scriptableShell(fake.FakeClient.last, (command) => {
      if (command === 'echo one') return { out: 'one\nwith two lines' }
      if (command === 'false') return { out: 'ok', code: 1 }
      if (command.startsWith('sleep')) return undefined // never answers: times out
      return { out: `ok:${command}` }
    })

    expect(await run('dev', 'echo one', 1000)).toMatchObject({ success: true, exitCode: 0, stdout: 'one\nwith two lines', timedOut: false })
    expect(await run('dev', 'false', 1000)).toMatchObject({ success: false, exitCode: 1, stdout: 'ok' })
    // two commands in flight run back to back, never interleaved
    const [c, d] = await Promise.all([run('dev', 'echo x', 1000), run('dev', 'echo y', 1000)])
    expect([c.stdout, d.stdout]).toEqual(['ok:echo x', 'ok:echo y'])
    expect(shell).toHaveLength(1) // still the same helper shell
    // a command that never answers closes the shell; the next call opens a fresh one
    expect(await run('dev', 'sleep 1000', 30)).toMatchObject({ success: false, timedOut: true })
    expect(await run('dev', 'echo again', 1000)).toMatchObject({ success: true, stdout: 'ok:echo again' })
    expect(shell).toHaveLength(2)
    engine.dispose()
  })

  it('reports a shell that closed before the command answered', async () => {
    const engine = newEngine()
    await engine.connect('dev')
    const shell = scriptableShell(fake.FakeClient.last, () => undefined)
    const pending = runner(engine)('dev', 'echo hi', 5000)
    await new Promise((resolve) => setTimeout(resolve, 10))
    shell[0]?.emit('close', 1)
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/closed/)
    engine.dispose()
  })
})
