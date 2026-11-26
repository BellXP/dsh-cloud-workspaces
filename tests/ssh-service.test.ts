/**
 * SshRuntime 生命周期测试 —— 参照官方 E2BRuntime 的测试模式
 * （.research/dsh-source/deepseek-harness-master/packages/e2b/e2b/tests/e2b.spec.ts）：
 * vi.mock('ssh2') + FakeClient fixture，验证惰性连接、句柄复用、broken 自动
 * 重建与 disposal 竞态。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SshRuntime from '../src/ssh-service'
import { HostStore } from '../src/store'

/** 可编程的 ssh2 假实现：事件注册 + 测试辅助触发。 */
const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  class MiniEmitter {
    private listeners = new Map<string, Handler[]>()

    on(event: string, cb: Handler) {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }

    once(event: string, cb: Handler) {
      const wrapper: Handler = (...args) => {
        this.remove(event, wrapper)
        cb(...args)
      }
      const list = this.listeners.get(event) ?? []
      list.push(wrapper)
      this.listeners.set(event, list)
      return this
    }

    remove(event: string, cb: Handler) {
      const list = this.listeners.get(event)
      if (!list) return
      const index = list.indexOf(cb)
      if (index >= 0) list.splice(index, 1)
    }

    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
      return this
    }
  }

  class FakeStream extends MiniEmitter {
    stderr = new MiniEmitter()
    close() {
      this.emit('close', 0)
    }
  }

  class FakeClient extends MiniEmitter {
    static instances: FakeClient[] = []
    /** 下一次 connect 的行为：ready（默认）或 error（模拟临时不可达）。 */
    static nextConnectBehavior: 'ready' | 'error' = 'ready'
    /** 全部 exec 命令记录（登录环境快照的自动触发断言用）。 */
    static execLog: string[] = []
    /** 捕获命令（__DSH_ENV_BEGIN__）的响应延迟/文本：模拟慢 profile 主机的后台捕获。 */
    static captureDelayMs = 0
    static captureText = 'ok'
    exec = vi.fn()
    shell = vi.fn()
    sftp = vi.fn()
    end = vi.fn()

    constructor() {
      super()
      FakeClient.instances.push(this)
      // 默认 exec：模拟一条成功命令（输出 'ok'，退出码 0）；捕获命令按静态配置延迟/定制文本。
      this.exec.mockImplementation((command: string, cb: (err: unknown, stream: FakeStream) => void) => {
        FakeClient.execLog.push(command)
        const isCapture = command.includes('__DSH_ENV_BEGIN__')
        const text = isCapture ? FakeClient.captureText : 'ok'
        const delay = isCapture ? FakeClient.captureDelayMs : 0
        const stream = new FakeStream()
        const deliver = () => {
          cb(null, stream)
          stream.emit('data', Buffer.from(text))
          stream.emit('close', 0)
        }
        if (delay > 0) setTimeout(deliver, delay)
        else queueMicrotask(deliver)
        return this
      })
    }

    /** engine.connectClient 调用的入口：异步触发 ready 或 error。 */
    connect() {
      setImmediate(() => {
        if (FakeClient.nextConnectBehavior === 'ready') this.trigger('ready')
        else this.trigger('error', new Error('connect refused'))
      })
      return this
    }

    /** 测试辅助：模拟底层连接失败 / 被关闭。 */
    trigger(event: string, ...args: unknown[]) {
      this.emit(event, ...args)
      return this
    }
  }

  return { FakeClient }
})

vi.mock('ssh2', () => ({ Client: fake.FakeClient }))

type Fiber = Awaited<ReturnType<Context['plugin']>>

/** 唯一 store 文件，隔离各测试的持久化。 */
let storeCounter = 0
function tmpStoreFile(): string {
  storeCounter += 1
  return join(tmpdir(), `dsh-remote-ide-ssh-service-${process.pid}-${storeCounter}.json`)
}

describe('SshRuntime 连接生命周期', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
  })

  async function setup(): Promise<{ ctx: Context; fiber: Fiber; runtime: SshRuntime }> {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile: tmpStoreFile() })
    const service = context.ssh
    service.upsertHost({
      alias: 'dev',
      host: '10.0.0.1',
      user: 'root',
      auth: { kind: 'password', password: 'secret' },
    })
    return { ctx: context, fiber: f, runtime: service }
  }

  it('初始无激活连接：status disconnected，getConnection 拒绝', async () => {
    const { runtime } = await setup()
    expect(runtime.status().state).toBe('disconnected')
    await expect(runtime.getConnection()).rejects.toThrow(/no active connection/)
    expect(fake.FakeClient.instances).toHaveLength(0)
  })

  it('connect 建立连接，getConnection 复用同一句柄（同一底层连接）', async () => {
    const { fiber, runtime } = await setup()
    const status = await runtime.connect('dev')

    expect(status.state).toBe('connected')
    expect(runtime.status().home).toBe('ok')

    const first = await runtime.getConnection()
    const second = await runtime.getConnection()
    expect(first).toBe(second) // ready 缓存 → 同一引用
    expect(first.alias).toBe('dev')
    expect(first.home).toBe('ok')

    // 两次获取只建立一个底层 ssh2 连接。
    expect(fake.FakeClient.instances).toHaveLength(1)

    // 句柄上的操作委托到激活连接。
    const result = await first.exec('echo hi')
    expect(result.success).toBe(true)
    expect(result.stdout).toBe('ok')

    await fiber.dispose()
    expect(fake.FakeClient.instances[0]?.end).toHaveBeenCalled()
  })

  it('dispose 后 getConnection 拒绝（disposal 竞态防护）', async () => {
    const { fiber, runtime } = await setup()
    await runtime.connect('dev')

    await fiber.dispose()
    await expect(runtime.getConnection()).rejects.toThrow(/disposing/)
  })

  it('底层连接 broken 时 getConnection 自动重建', async () => {
    const { runtime } = await setup()
    await runtime.connect('dev')
    expect(fake.FakeClient.instances).toHaveLength(1)

    // 模拟传输层错误 → engine 将连接标记 broken。
    fake.FakeClient.instances[0]!.trigger('error', new Error('connection reset'))

    // getConnection 自动重建新连接，句柄指向新的底层连接。
    const connection = await runtime.getConnection()
    expect(connection.alias).toBe('dev')
    expect(connection.home).toBe('ok')
    expect(fake.FakeClient.instances).toHaveLength(2)
  })

  it('connect 未知主机不抛异常，状态置 failed', async () => {
    const { runtime } = await setup()
    const status = await runtime.connect('nope')

    expect(status.state).toBe('failed')
    expect(status.error).toMatch(/unknown host/)
    expect(fake.FakeClient.instances).toHaveLength(0)
  })

  it('切换目标：connect(新 alias) 后句柄指向新连接', async () => {
    const { runtime } = await setup()
    runtime.upsertHost({
      alias: 'prod',
      host: '10.0.0.2',
      user: 'deploy',
      auth: { kind: 'password', password: 'secret2' },
    })
    await runtime.connect('dev')
    const dev = await runtime.getConnection()
    expect(dev.alias).toBe('dev')

    await runtime.connect('prod')
    const prod = await runtime.getConnection()
    expect(prod.alias).toBe('prod')
    expect(prod).not.toBe(dev)
    expect(fake.FakeClient.instances).toHaveLength(2)
  })

  it('临时连接失败后不被陈旧 rejection 毒化：主机恢复后 getConnection 自愈', async () => {
    const { runtime } = await setup()
    fake.FakeClient.nextConnectBehavior = 'error'
    const failed = await runtime.connect('dev')
    expect(failed.state).toBe('failed')
    // connect 内部还会立即打开一次句柄（在途中）——等它同样落败，
    // 确保 ready 已是陈旧 rejection，之后的自愈只能靠重建。
    await new Promise((resolve) => setImmediate(resolve))
    const failedAttempts = fake.FakeClient.instances.length

    // 主机恢复可达——此前实现会永久缓存 rejected ready，每次 getConnection
    // 都抛陈旧错误；修复后应重建连接自愈。
    fake.FakeClient.nextConnectBehavior = 'ready'
    const connection = await runtime.getConnection()
    expect(connection.alias).toBe('dev')
    expect(fake.FakeClient.instances.length).toBe(failedAttempts + 1)
  })
})

describe('SshRuntime 登录环境快照（终端加速）', () => {
  beforeEach(() => {
    fake.FakeClient.instances.length = 0
    fake.FakeClient.execLog.length = 0
    fake.FakeClient.nextConnectBehavior = 'ready'
    fake.FakeClient.captureDelayMs = 0
    fake.FakeClient.captureText = 'ok'
  })

  /** 极简 exec 流：注册 data 即投递文本，注册 close 时按 code 结束。 */
  function streamOf(text: string, code = 0): unknown {
    return {
      stderr: { on() { return this } },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'data' && text !== '') cb(Buffer.from(text))
        if (event === 'close') queueMicrotask(() => cb(code, null))
        return this
      },
    }
  }

  const SNAPSHOT = [
    '__DSH_ENV_BEGIN__',
    'declare -x ATB_HOME="/usr/local/atb"',
    'declare -x SHLVL="2"',
    '',
    '__DSH_ENV_FUNCS__',
    '',
    '__DSH_ENV_ALIASES__',
    '',
    '__DSH_ENV_PS1__$ ',
  ].join('\n')

  /** 武装捕获：capture 命令回快照，探针按 probeOk，其余 'ok'；SFTP 记录写入。
   *  captureDelayMs > 0 时模拟慢 profile 主机：捕获输出延迟到达。 */
  function armCapture(
    client: { exec: ReturnType<typeof vi.fn>; sftp: ReturnType<typeof vi.fn> },
    opts: { probeOk?: boolean; written?: Array<{ path: string; content: string }>; captureDelayMs?: number; captureOk?: boolean },
  ): void {
    client.sftp.mockImplementation((cb: (err: unknown, sftp: unknown) => void) => {
      queueMicrotask(() => cb(null, {
        writeFile: (path: string, data: Buffer, done: (e?: Error) => void) => {
          opts.written?.push({ path, content: data.toString('utf8') })
          done()
        },
        stat: (_path: string, done: (e: Error | undefined, s: unknown) => void) => done(undefined, { size: 1, mtime: 1 }),
      }))
    })
    client.exec.mockImplementation((command: string, cb: (err: unknown, stream: unknown) => void) => {
      fake.FakeClient.execLog.push(command)
      const isCapture = command.includes('__DSH_ENV_BEGIN__')
      const isProbe = command.startsWith('test -f ')
      const captureText = opts.captureOk === false ? 'ok\n' : `${SNAPSHOT}\n`
      const text = isCapture ? captureText : isProbe && opts.probeOk === false ? '' : 'ok\n'
      const code = isProbe && opts.probeOk === false ? 1 : 0
      const deliver = () => cb(null, streamOf(text, code))
      if (isCapture && (opts.captureDelayMs ?? 0) > 0) setTimeout(deliver, opts.captureDelayMs)
      else queueMicrotask(deliver)
    })
  }

  async function setupHost(
    storeFile = tmpStoreFile(),
    extraConfig: Record<string, unknown> = {},
  ): Promise<{ fiber: Fiber; runtime: SshRuntime; storeFile: string }> {
    const context = new Context()
    const f = await context.plugin(SshRuntime, { storeFile, ...extraConfig })
    const service = context.ssh
    service.upsertHost({
      alias: 'dev',
      host: '10.0.0.1',
      user: 'root',
      auth: { kind: 'password', password: 'secret' },
    })
    return { fiber: f, runtime: service, storeFile }
  }

  it('首次连接自动触发后台捕获（无需手动预热）', async () => {
    const { fiber, runtime } = await setupHost()
    await runtime.connect('dev')
    // 默认 exec 返回 'ok'（解析必失败）——断言点在捕获命令确实被自动发出。
    await vi.waitFor(() => {
      expect(fake.FakeClient.execLog.some((command) => command.includes('__DSH_ENV_BEGIN__'))).toBe(true)
    })
    await fiber.dispose()
  })

  it('captureLoginEnv：捕获 → 写远端快照 + store 登记；loginEnvScriptFor 免探针返回路径', async () => {
    const { fiber, runtime } = await setupHost()
    await runtime.connect('dev')
    const client = fake.FakeClient.instances[0]!
    const written: Array<{ path: string; content: string }> = []
    armCapture(client, { written })

    const record = await runtime.captureLoginEnv('dev')
    expect(record.varCount).toBe(1) // SHLVL 等易变量被过滤
    expect(record.remotePath).toBe('ok/.cache/dsh-cloud-workspaces/login-env.sh')
    expect(written[0]?.path).toBe(record.remotePath)
    expect(written[0]?.content).toContain('declare -x ATB_HOME=')
    // 捕获即验证记账命中——直接返回路径，无额外探针往返。
    await expect(runtime.loginEnvScriptFor('dev')).resolves.toBe(record.remotePath)
    await fiber.dispose()
  })

  it('登记过但远端快照丢失 → 后台重捕；重捕成功则本次就走快路径（自愈）', async () => {
    const { fiber: f1, runtime: r1, storeFile } = await setupHost()
    await r1.connect('dev')
    armCapture(fake.FakeClient.instances[0]!, {})
    const old = await r1.captureLoginEnv('dev')
    await f1.dispose()

    // 新 runtime、同一 store：登记在、远端文件没了 → 探针失败 → 清登记 + 后台重捕 →
    // loginEnvScriptFor 等到重捕完成，返回新快照路径。
    const { fiber: f2, runtime: r2 } = await setupHost(storeFile)
    await r2.connect('dev') // 已登记且未过期 → 此时不自动重捕
    const client = fake.FakeClient.instances.at(-1)!
    fake.FakeClient.execLog.length = 0
    armCapture(client, { probeOk: false })
    await expect(r2.loginEnvScriptFor('dev')).resolves.toBe('ok/.cache/dsh-cloud-workspaces/login-env.sh')
    expect(fake.FakeClient.execLog.filter((c) => c.includes('__DSH_ENV_BEGIN__')).length).toBe(1)
    const fresh = await r2.engine.getEntry('dev')?.loginEnv
    expect(fresh?.remotePath).toBe(old.remotePath)
    expect(fresh?.generatedAt ?? 0).toBeGreaterThanOrEqual(old.generatedAt)
    await f2.dispose()
  })

  it('登记过但远端快照丢失且重捕失败 → 回退登录 shell（undefined），登记已清，下次连接会再试', async () => {
    const { fiber: f1, runtime: r1, storeFile } = await setupHost()
    await r1.connect('dev')
    armCapture(fake.FakeClient.instances[0]!, {})
    await r1.captureLoginEnv('dev')
    await f1.dispose()

    const { fiber: f2, runtime: r2 } = await setupHost(storeFile)
    await r2.connect('dev')
    const client = fake.FakeClient.instances.at(-1)!
    fake.FakeClient.execLog.length = 0
    armCapture(client, { probeOk: false, captureOk: false }) // 捕获输出不可解析 → 失败
    await expect(r2.loginEnvScriptFor('dev')).resolves.toBeUndefined()
    await vi.waitFor(() => {
      expect(fake.FakeClient.execLog.filter((c) => c.includes('__DSH_ENV_BEGIN__')).length).toBe(1)
    })
    expect(await r2.engine.getEntry('dev')?.loginEnv).toBeUndefined()
    await f2.dispose()
  })

  it('首开终端时后台捕获进行中：等捕获完成走快路径，而不是 3 s 后回退登录 shell', async () => {
    // 模拟慢 profile 主机：connect 触发的后台捕获 80 ms 后才产出快照。
    fake.FakeClient.captureDelayMs = 80
    fake.FakeClient.captureText = `${SNAPSHOT}\n`
    const { fiber, runtime } = await setupHost(tmpStoreFile(), { terminalPrewarmWaitMs: 2_000 })
    // getConnectionFor 与侧栏终端 seam 的调用顺序一致：先建连（内部触发后台捕获——
    // 捕获命令按 FakeClient.captureDelayMs 延迟产出），再武装 SFTP/探针，再取快照路径。
    await runtime.getConnectionFor('dev')
    armCapture(fake.FakeClient.instances[0]!, { captureDelayMs: 80 })
    const started = Date.now()
    await expect(runtime.loginEnvScriptFor('dev')).resolves.toBe('ok/.cache/dsh-cloud-workspaces/login-env.sh')
    expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    await fiber.dispose()
  })

  it('等待上限可配：terminalPrewarmWaitMs=20 时捕获未完成就回退（undefined），完成后即可用', async () => {
    fake.FakeClient.captureDelayMs = 150
    fake.FakeClient.captureText = `${SNAPSHOT}\n`
    const { fiber, runtime } = await setupHost(tmpStoreFile(), { terminalPrewarmWaitMs: 20 })
    await runtime.getConnectionFor('dev')
    armCapture(fake.FakeClient.instances[0]!, { captureDelayMs: 150 })
    await expect(runtime.loginEnvScriptFor('dev')).resolves.toBeUndefined()
    // 等后台捕获落地后，下一次取数拿到快照。
    await vi.waitFor(async () => {
      await expect(runtime.loginEnvScriptFor('dev')).resolves.toBe('ok/.cache/dsh-cloud-workspaces/login-env.sh')
    })
    await fiber.dispose()
  })

  it('快照年龄超过 loginEnvMaxAgeMs：连接时后台刷新一次，刷新期间旧快照照常可用；未过期则不刷新', async () => {
    const storeFile = tmpStoreFile()
    const seed = new HostStore(storeFile)
    seed.upsert({ alias: 'dev', host: '10.0.0.1', user: 'root', auth: { kind: 'password', password: 'secret' } })
    seed.setLoginEnv('dev', { remotePath: '/root/.cache/dsh-cloud-workspaces/login-env.sh', generatedAt: Date.now() - 48 * 3600_000, varCount: 3 })
    const { fiber, runtime } = await setupHost(storeFile, { loginEnvMaxAgeMs: 24 * 3600_000 })
    await runtime.connect('dev')
    await vi.waitFor(() => {
      expect(fake.FakeClient.execLog.some((command) => command.includes('__DSH_ENV_BEGIN__'))).toBe(true)
    })
    // 刷新期间旧快照（远端仍在）照常可用，不阻塞终端。
    await expect(runtime.loginEnvScriptFor('dev')).resolves.toBe('/root/.cache/dsh-cloud-workspaces/login-env.sh')
    await fiber.dispose()

    // 对照：未过期的登记 → 连接不触发捕获。
    fake.FakeClient.instances.length = 0
    fake.FakeClient.execLog.length = 0
    const fresh = tmpStoreFile()
    const seed2 = new HostStore(fresh)
    seed2.upsert({ alias: 'dev', host: '10.0.0.1', user: 'root', auth: { kind: 'password', password: 'secret' } })
    seed2.setLoginEnv('dev', { remotePath: '/root/.cache/dsh-cloud-workspaces/login-env.sh', generatedAt: Date.now(), varCount: 3 })
    const { fiber: f2, runtime: r2 } = await setupHost(fresh, { loginEnvMaxAgeMs: 24 * 3600_000 })
    await r2.connect('dev')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.FakeClient.execLog.some((command) => command.includes('__DSH_ENV_BEGIN__'))).toBe(false)
    await f2.dispose()
  })
})
