/**
 * dsh-remote-ide — 设置卡片的 Typert 远程端点（host 半）。
 *
 * 官方跨半 RPC 通道（dsh-api-gateway + dsh-typert-registry + dsh-typert-protocol）：
 * host 半注册严格描述符（face:'host' + invocations，codec 用 src-json，
 * 真实校验在 settings schema / engine 内）到 ctx.typert.register；服务实例
 * 用 bindTypertRemote 提供 typertRemote 绑定（gateway validateBinding 的
 * 硬要求）。client 半 $mount 同形描述符（strict passthrough codec）后得到
 * ctx.remote.ssh-remote.<method>()。业务失败用返回值表达（gateway 只透传
 * error.message，结构化字段会丢）。
 *
 * 端点面 = 设置卡片的全部数据能力：主机 CRUD（读写 settings + 桥接
 * HostStore）、测试连接（engine.testConfig 直连探测）、远端目录浏览与
 * 占位工作区创建（复用 workspace.ts 与 engine.ls）。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import type { SshRuntime } from './ssh-service'
import type { SshHostConfig } from './host-settings'
import type { HostPayload } from './protocol'
import { createPlaceholderDir, listPlaceholders } from './workspace'
import { jsonSafe } from './jsonsafe'
import { debugLog } from './debug-log'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** ctx.workspaceRegistry 的形状（可选服务，经 ctx.get 读取，无 inject 要求）。 */
type WorkspaceRegistryLike = Pick<WorkspaceRegistry, 'create'> | undefined

/** npm 包名（描述符 id 前缀）。 */
export const REMOTE_PACKAGE = 'dsh-remote-ide'
/** Cordis service key。 */
export const REMOTE_SERVICE = 'ssh-remote'
/** wire 命名空间（client 侧 ctx.remote.<ns>.<method>）。 */
export const REMOTE_NAMESPACE = 'ssh-remote'

const SRC_JSON: TypertCodec = { mode: 'src-json' }

/** 一个 host 半 invocation 描述符（strict local 注册表形状）。 */
export interface HostInvocation {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: Array<{ name: string; wire: string; source: 'json'; codec: TypertCodec }>
  result: TypertCodec
}

function hostInvocation(method: string, parameters: string[]): HostInvocation {
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({ name, wire: name, source: 'json', codec: SRC_JSON })),
    result: SRC_JSON,
  }
}

/**
 * 网关边界校验（assertJsonValue）要求业务结果纯 JSON-safe：显式赋值的
 * `error: undefined` 也是 own property，网关直接拒绝（"business result
 * failed boundary validation"）。实现移至 ./jsonsafe（工具输出同用），
 * 此处 re-export 保持既有导入路径。
 */
export { jsonSafe } from './jsonsafe'

/** host 半贡献（ctx.typert.register 消费；face:'host' + invocations）。 */
export interface HostTypertContribution {
  package: string
  face: 'host'
  schemas: unknown[]
  invocations: HostInvocation[]
  model: undefined
}

/** host 半贡献：参数名（wire）与 SshRemoteService 方法参数一一对应。 */
export const HOST_TYPERT_CONTRIBUTION: HostTypertContribution = {
  package: REMOTE_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    hostInvocation('listHosts', []),
    hostInvocation('saveHost', ['id', 'patch']),
    hostInvocation('deleteHost', ['id']),
    hostInvocation('testConnection', ['hostId', 'cfg']),
    hostInvocation('listRemoteDir', ['hostId', 'path']),
    hostInvocation('mkdirRemote', ['hostId', 'path']),
    hostInvocation('removeRemote', ['hostId', 'path']),
    hostInvocation('createPlaceholder', ['hostId', 'remotePath']),
    hostInvocation('listPlaceholders', []),
    hostInvocation('refreshLoginEnv', ['hostId']),
  ],
  model: undefined,
}

/** 类型扩展：TypertRegistryContract 未导出 register，运行时存在。 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRegistryContract {
    register(contribution: HostTypertContribution): () => void
  }
}

/**
 * 设置卡片的远程服务。方法即端点（位置参数，与描述符 parameters 一一对应）。
 * ⚠️ 端点返回**裸业务值**：gateway 已用 {ok, value} 表达调用成败，若端点再
 * 自包一层 {ok, value} 会让 client 收到双层包装（unwrap 只解一层）。
 * 业务失败直接 throw（gateway 捕获转 {ok:false, error:{message}}）。
 * bindTypertRemote 绑定是 gateway validateBinding 的硬要求。
 */
export class SshRemoteService extends Service {
  private readonly runtime: SshRuntime
  /** 宿主 ctx（workspaceRegistry 等可选服务经 ctx.get 读取）。 */
  private readonly runtimeCtx: Context
  /** 绑定声明——gateway validateBinding 按此反射名检查，不可改名。 */
  readonly typertRemote: unknown

  constructor(ctx: Context, runtime: SshRuntime) {
    super(ctx, REMOTE_SERVICE)
    this.runtime = runtime
    this.runtimeCtx = ctx
    this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE)
  }

  private hosts(): Record<string, SshHostConfig> {
    // 0.1.7 迁移：settings 镜像退役，主机清单直接来自 0600 的 HostStore。
    const out: Record<string, SshHostConfig> = {}
    for (const summary of this.runtime.engine.list()) {
      const entry = this.runtime.getStoredEntry(summary.alias)
      if (entry === undefined) continue
      out[summary.alias] = {
        id: summary.alias,
        name: entry.description,
        host: entry.host,
        port: entry.port,
        user: entry.user,
        authType: entry.auth.kind,
        privateKeyPath: entry.auth.kind === 'key' ? entry.auth.keyPath ?? '' : '',
        proxyJump: [...entry.proxyJump],
        httpProxy: entry.httpProxy === undefined
          ? undefined
          : {
              host: entry.httpProxy.host,
              port: entry.httpProxy.port,
              ...(entry.httpProxy.username !== undefined ? { username: entry.httpProxy.username } : {}),
            },
        description: entry.description,
      }
    }
    return out
  }

  // ------------------------------------------------------------ endpoints

  /** 列出全部主机（脱敏）+ 口令已设标记（从 0600 store 权威读取）。 */
  listHosts(): { hosts: Record<string, Omit<SshHostConfig, 'password'>>; secrets: Record<string, boolean> } {
    const secrets: Record<string, boolean> = {}
    for (const summary of this.runtime.engine.list()) {
      secrets[summary.alias] = summary.auth === 'password'
    }
    const hosts = this.hosts()
    debugLog(`listHosts: ${Object.keys(hosts).length} host(s): ${Object.keys(hosts).join(', ') || '(none)'}`)
    return jsonSafe({ hosts, secrets })
  }

  /**
   * 创建或更新主机：**直接写 0600 的 dsh-remote-ide.json**（唯一权威存储）。
   * 口令/代理口令 write-only：提交留空 = 沿用 store 既有值。
   * httpProxy: 省略沿用；`null` 显式清除；对象口令留空 = 沿用 store 口令。
   */
  async saveHost(
    id: string,
    patch: Partial<Omit<SshHostConfig, 'httpProxy'>> & { httpProxy?: SshHostConfig['httpProxy'] | null },
  ): Promise<{ id: string }> {
    debugLog(`saveHost: enter id=${JSON.stringify(id)} patchKeys=${JSON.stringify(Object.keys(patch))}`)
    try {
      const stored = this.runtime.getStoredEntry(id)
      const host = (patch.host ?? stored?.host ?? '').trim()
      const user = (patch.user ?? stored?.user ?? '').trim()
      if (host === '' || user === '') {
        throw new Error('host and user are required')
      }
      const port = patch.port ?? stored?.port ?? 22
      const authType = patch.authType ?? stored?.auth.kind ?? 'key'
      // 口令解析：新提交的口令优先，否则沿用 0600 store 既有口令。
      let password: string | undefined
      if (typeof patch.password === 'string' && patch.password !== '') password = patch.password
      else if (stored?.auth.kind === 'password') password = stored.auth.password
      let auth: HostPayload['auth']
      if (authType === 'password') {
        auth = { kind: 'password', password: password ?? '' }
      } else {
        const keyPath = patch.privateKeyPath ?? (stored?.auth.kind === 'key' ? stored.auth.keyPath : undefined)
        if (keyPath === undefined || keyPath === '') throw new Error('privateKeyPath is required for key auth')
        auth = { kind: 'key', keyPath }
      }
      // 代理口令同样 write-only：patch 口令留空时 store 会沿用既有值。
      this.runtime.engine.upsertHost({
        alias: id,
        host,
        port,
        user,
        auth,
        proxyJump: patch.proxyJump ?? stored?.proxyJump ?? [],
        httpProxy: patch.httpProxy === undefined ? undefined : patch.httpProxy,
        description: patch.description ?? patch.name ?? stored?.description,
      }, id)
      debugLog(`saveHost: ok alias=${JSON.stringify(id)} host=${JSON.stringify(host)} port=${port} auth=${authType}`)
      return { id }
    } catch (error) {
      debugLog(`saveHost: FAILED id=${JSON.stringify(id)} — ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /** 删除主机：0600 store 权威删除（断开连接一并处理）。 */
  async deleteHost(id: string): Promise<{ id: string }> {
    if (this.runtime.getStoredEntry(id) === undefined) throw new Error(`host not found: ${id}`)
    this.runtime.engine.removeHost(id)
    return { id }
  }

  /**
   * 测试连接：用表单配置直连探测。对已保存主机（hostId 非空），密码/密钥
   * 从 0600 store 补回（UI 拿到的是脱敏视图，password 已被剥离——测试不带
   * 密码必然 "All configured authentication methods failed"）。
   */
  async testConnection(hostId: string, cfg: {
    host: string
    port?: number
    user: string
    authType?: 'key' | 'password'
    privateKeyPath?: string
    password?: string
    proxyJump?: string[]
    httpProxy?: { host: string; port: number; username?: string; password?: string }
  }): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    let password = cfg.password
    let privateKeyPath = cfg.privateKeyPath
    const stored = hostId === '' ? undefined : this.runtime.getStoredEntry(hostId)
    if (stored !== undefined) {
      if (stored.auth.kind === 'password' && (password === undefined || password === '')) {
        password = stored.auth.password
      }
      if (stored.auth.kind === 'key' && (privateKeyPath === undefined || privateKeyPath === '')) {
        privateKeyPath = stored.auth.keyPath
      }
    }
    // 代理口令同样 write-only：UI 提交缺口令时从 0600 store 补回。
    // cfg.httpProxy 整体缺省时同样回退到已保存代理：设置卡的测试按钮不回传
    // 代理字段，缺了这个回退，「仅代理可达」主机的测试会绕开代理直连，
    // 15 秒后报 "Timed out while waiting for handshake"（真机 flex-* 踩过）。
    let httpProxy = cfg.httpProxy
    if (httpProxy === undefined && stored?.httpProxy !== undefined) {
      httpProxy = stored.httpProxy
    }
    if (httpProxy !== undefined && (httpProxy.password === undefined || httpProxy.password === '') && stored?.httpProxy !== undefined) {
      httpProxy = { ...httpProxy, password: stored.httpProxy.password }
    }
    const result = await this.runtime.engine.testConfig({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      auth: cfg.authType === 'password' || (hostId !== '' && this.runtime.getStoredEntry(hostId)?.auth.kind === 'password')
        ? { kind: 'password', password }
        : { kind: 'key', keyPath: privateKeyPath },
      proxyJump: cfg.proxyJump,
      httpProxy,
    })
    // 成功时 error === undefined：必须剥离，否则网关边界校验拒绝整个结果。
    return jsonSafe({ ok: result.ok, latencyMs: result.latencyMs, error: result.error })
  }

  /** 列远端目录（工作区创建浏览；需主机已在 store，未保存先桥接）。 */
  async listRemoteDir(hostId: string, path: string): Promise<unknown> {
    return jsonSafe(await this.runtime.engine.ls(hostId, path))
  }

  /** 在远端创建目录（递归创建父级）。 */
  async mkdirRemote(hostId: string, path: string): Promise<{ path: string }> {
    await this.runtime.engine.mkdir(hostId, path)
    return { path }
  }

  /** 删除远端文件或空目录（非空目录请先清空内容）。 */
  async removeRemote(hostId: string, path: string): Promise<{ path: string }> {
    await this.runtime.engine.remove(hostId, path)
    return { path }
  }

  /** 创建占位工作区（返回本地占位路径，供用户选为 DSH 工作区）。 */
  async createPlaceholder(hostId: string, remotePath: string): Promise<{ localPath: string; hostId: string; remotePath: string }> {
    const created = await createPlaceholderDir({ hostId, remotePath })
    // 注册进 registry 只是「出现在选择列表」的锦上添花，绝不阻塞端点：
    // registry 启动依赖 sessionPersistence 完成引导，在部分作用域可能永远
    // 未就绪——await 它会让端点无限挂起（真机「卡退」的根因）。选择器流程
    // 由官方收养（onPicked → createWorkspace），这里的注册是设置页流程的补充。
    void this.registerWorkspace(created.localPath, `${hostId} / ${remotePath.split('/').filter(Boolean).pop() || 'root'}`)
    return created
  }

  /** 后台注册占位目录进 DSH 工作区注册表（5s 超时；失败静默——目录本身已可用）。 */
  private async registerWorkspace(localPath: string, title: string): Promise<void> {
    try {
      const registry = await Promise.race([
        Promise.resolve(this.runtimeCtx.get('workspaceRegistry') as WorkspaceRegistryLike),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
      ])
      if (registry !== undefined && typeof registry.create === 'function') {
        await registry.create(localPath, title)
      }
    } catch {
      // 注册失败不影响占位目录本身（用户仍可手动添加路径）。
    }
  }

  /** 列出全部占位工作区。 */
  async listPlaceholders(): Promise<Array<{ hostId: string; remotePath: string; localPath: string }>> {
    const listed = await listPlaceholders()
    return listed.map(w => ({ hostId: w.hostId, remotePath: w.remotePath, localPath: w.localPath }))
  }

  /**
   * 捕获/刷新登录环境快照（慢 profile 主机的终端/会话 shell 加速）：
   * 跑一次完整 `bash -lc` 采集变量/函数/alias/PS1，写远端快照并登记。
   * 慢主机可能需要数十秒——client 侧按钮带「进行中」状态与超时保护。
   */
  async refreshLoginEnv(hostId: string): Promise<{ remotePath: string; generatedAt: number; varCount: number }> {
    const record = await this.runtime.captureLoginEnv(hostId)
    return jsonSafe(record)
  }
}
