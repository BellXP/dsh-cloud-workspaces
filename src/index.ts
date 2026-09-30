/**
 * dsh-remote-ide — host half.
 *
 * 免 preset 的「云端工作区」模式：工作区选择器（client 半双 tab）选定远程
 * 目录后，会话内官方同名工具（bash/read/write/edit/glob/grep）经 agent/created
 * 钩子在 agent scope 遮蔽为 SSH 实现（session-tools），另有全局 ssh_* 工具
 * （tools）、设置卡主机管理（host-settings + typert）。0.1.7 起 Web 侧边栏
 * 文件树与终端经 seam 路由（seam-fs / seam-terminal）同样落远程；
 * agent-presets/remote-legacy 保留整服务替换路线作参考，不再部署。
 *
 * Host entries live in ~/.dsh/dsh-remote-ide.json (0600, import from
 * ~/.ssh/config) plus the settings namespace the web settings card edits.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import SshRuntime from './ssh-service'
import { sshExecTool, sshListTool, sshLsTool, sshReadTool, sshWorkspaceTool, sshWriteTool } from './tools'
import { HOST_TYPERT_CONTRIBUTION, REMOTE_SERVICE, SshRemoteService } from './typert'
import { installSessionRouting, sessionSectionText } from './session-tools'
import { installRemoteFsSeam } from './seam-fs'
import { installRemoteTerminalSeam } from './seam-terminal'
import { routeByCwd } from './workspace'
import { debugLog } from './debug-log'

/** Re-exported for consumers that dial HTTP CONNECT proxies directly. */
export { connectHttpProxy } from './engine'
/** Seam 路由纯函数（离线/真机验证脚本与消费方共用同一份逻辑）。 */
export { routeFsPath, routeFsTarget, placeholderKeyFor } from './seam-fs'
export { mapLocalTreeToRemote } from './workspace'

/** Stable cordis plugin name. */
export const name = 'remote-ide'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (tools). */
  enabled?: boolean
  /** Remote file read cap for ssh_read (bytes). */
  maxReadBytes?: number
  /** When true, announce the remote tools to the agent via a prompt section. */
  announceToAgent?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxReadBytes: z.number().min(64 * 1024).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
  announceToAgent: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true

/** Model-facing announcement: plugin presence and limits. */
export const REMOTE_GUIDANCE = '本机已安装 dsh-remote-ide（远程工作区）：在「添加工作区」里选「云端（SSH）」即可把服务器目录绑定为工作区——该会话的 bash/read/write/edit/glob/grep 与 ssh_* 工具会自动在该服务器上执行，和本地一样。也可用 ssh_list 列出已配置主机、ssh_workspace 绑定远程目录。长命令（安装/构建/测试套件）用 bash 或 ssh_exec 的 run_in_background:true 起后台，随后 job_output/job_list 轮询、job_kill 终止。限制：需先在 设置 → SSH 连接 配置主机；远程命令消耗真实服务器资源；密码以明文存在用户主目录私有文件（0600）。用户提到「SSH / 远程服务器 / 远程开发 / 云端工作区」时即指本插件。'

/** Tool-guidance band order. */
const SECTION_ORDER = 150

/**
 * Mount the shared SSH runtime and the remote-development tools.
 *
 * The SshRuntime (ctx.ssh) is the ONE connection owner on the host plane: the
 * ssh_* tools registered here and the preset-scoped adapters (fs-ssh /
 * subprocess-ssh, mounted by agent-presets/remote in an isolate realm that
 * injects `ssh`) all consume the same engine, so a connection established by
 * one is visible to the others.
 * @param ctx - host plugin context carrying tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  // The live source the surfaces read: the settings section once the web
  // settings surface is served, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): Config => ({
    enabled: current().enabled ?? DEFAULT_ENABLED,
    maxReadBytes: current().maxReadBytes,
    announceToAgent: current().announceToAgent ?? DEFAULT_ANNOUNCE,
  })

  // Host-plane shared SSH runtime; its own effect owns engine disposal.
  // Fetch via ctx.get (store read without the inject requirement): newer
  // cordis refuses direct ctx.ssh property access that is not declared in
  // `inject`, and `ssh` cannot be declared there — we provide it ourselves,
  // which would self-deadlock. ctx.plugin() alone returns the Fiber, not the
  // service instance.
  await ctx.plugin(SshRuntime, { maxReadBytes: resolve().maxReadBytes })
  const runtime = ctx.get('ssh')
  if (!runtime) throw new Error('dsh-remote-ide: SshRuntime did not provide ctx.ssh')

  const tools = [
    sshListTool(runtime),
    // 后台任务生产者：ctx.jobs 由 dsh-base 装入（可选服务，缺失=能力不可用）。
    sshExecTool(runtime, ctx.get('jobs') as JobRegistry | undefined),
    sshLsTool(runtime),
    sshReadTool(runtime),
    sshWriteTool(runtime),
    sshWorkspaceTool(runtime),
  ]
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let disposeSessionSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeSessionSection !== undefined) {
      disposeSessionSection()
      disposeSessionSection = undefined
    }
    const value = resolve()
    if (!value.enabled) return
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-remote-ide: tools',
    )
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-remote-ide',
        order: SECTION_ORDER,
        text: REMOTE_GUIDANCE,
      })
      // 会话级动态段：cwd 落在 ~/.dsh/remote/ 下的会话获得远程身份宣告；
      // 本地会话该函数返回空串，零注入（免 preset 透明模式的一半）。
      disposeSessionSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-remote-ide:session',
        order: SECTION_ORDER + 1,
        text: (context) => {
          const agent = (context as { agent?: { session?: { header?: { cwd?: string } } } }).agent
          return sessionSectionText(agent?.session?.header?.cwd)
        },
      })
    }
  }

  // Typert endpoints (设置卡片的数据面：主机 CRUD 直接读写 0600 的 HostStore)。
  // Mounted only when the official typert service exists (the web profile
  // supplies it; headless runs simply skip them — tools keep working via the
  // store).
  ctx.inject(['typert'], (scope) => {
    debugLog('typert service available — registering ssh-remote contribution')
    try {
      const remote = new SshRemoteService(scope, runtime)
      // 严格描述符注册（face:'host' + invocations）；gateway 的 claimsEndpoint
      // 按 local 注册表命中端点，SRC 回退无需装饰器。
      scope.typert.register(HOST_TYPERT_CONTRIBUTION)
      debugLog(`typert contribution registered: ssh-remote (${HOST_TYPERT_CONTRIBUTION.invocations.length} invocations)`)
      scope.logger?.info('[dsh-remote-ide] typert remote ' + REMOTE_SERVICE + ' registered')
    } catch (error) {
      debugLog(`typert registration FAILED: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  })

  // 免 preset 的透明会话路由（核心竞争力）：agent/created 看会话 cwd，占位
  // 工作区会话在 agent scope 注册与官方同名的 bash/read/write/edit/glob/grep
  // 遮蔽工具（经共享 SshEngine 落远程）。enabled 开关在事件时求值——设置面
  // 的启停即时生效。工具注册仍走上面的 sync()（announceToAgent 开关）。
  installSessionRouting(ctx, runtime, () => resolve().enabled === true, () => ctx.get('jobs') as JobRegistry | undefined)

  // 官方 UI seam 路由（0.1.7）：Web 侧边栏文件树/文件预览走 ctx.fs，侧边栏
  // 终端走 ctx.subprocess.spawnTerminal——路径/cwd 落在占位树下时路由到
  // SSH 引擎（SFTP / 远端 PTY），其余透传本地实现。服务可用时经 ctx.inject
  // 触发（web 组合必有；headless 缺失则静默跳过）。
  installRemoteFsSeam(ctx, runtime, () => resolve().enabled === true)
  installRemoteTerminalSeam(ctx, runtime, () => resolve().enabled === true)

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
