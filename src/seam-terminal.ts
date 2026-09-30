/**
 * dsh-remote-ide — 侧边栏终端的远程路由（0.1.7 subprocess seam wrapper）。
 *
 * 背景：Web 侧边栏终端由官方 terminalController 供数，它对每个会话经
 * `agent.ctx.get('subprocess')` 取 subprocess 服务并调 `spawnTerminal`，
 * spec.cwd = 会话工作区根（云端工作区 = 本地占位目录），argv = **本地**
 * 执行环境探测出的 shell（Windows 上是 pwsh/cmd 等——对远端无意义）。
 *
 * 方案：与 seam-fs 同理，在活实例上打 own-property 补丁，按 spec.cwd 路由：
 *   - cwd 落在 ~/.dsh/remote/<hostId>/… 下 → 打开该主机的 SSH PTY（远端
 *     登录 shell，cd 到工作区；argv/env 忽略——终端就是远端世界本身）；
 *   - 其余 → 原本地 node-pty 实现（本地会话零行为变化）。
 *
 * handle 复用 subprocess-ssh 的 SshTerminalHandle：0.1.7 契约新增的
 * resize/inspectActivity 已补齐（inspectActivity 恒报 unknown——只影响空闲
 * 自动回收，不影响正确性）。终端 settles "exited" 要求 done 落定且 output
 * 流结束——SshTerminalHandle 的 finish() 正是这两点。
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SshRuntime } from './ssh-service'
import { spawnSshTerminal, type SshTerminalHandle } from './subprocess-ssh'
import { debugLog } from './debug-log'
import { mapLocalTreeToRemote } from './workspace'

/** 远端终端清理宽限下限：TERM→KILL 跨网络 RTT，比本地 1s 默认更宽。 */
const MIN_REMOTE_GRACE_MS = 5000
/** pid 文件轮询间隔（与遗留适配器默认一致）。 */
const POLL_MS = 100

/**
 * 在 subprocess 服务实例上安装远程路由补丁（服务可用时经 ctx.inject 触发）。
 * `enabled` 为假时 spawnTerminal 透传本地实现（与插件总开关一致）。
 */
export function installRemoteTerminalSeam(ctx: Context, runtime: SshRuntime, enabled: () => boolean): void {
  ctx.inject(['subprocess'], (scope) => {
    const subprocess = scope.get('subprocess')
    if (subprocess === undefined) return
    const spawnTerminal = subprocess.spawnTerminal.bind(subprocess)
    const terminals = new Set<SshTerminalHandle>()
    let disposed = false

    // own-property 覆盖原型方法；卸载时 delete 恢复。
    subprocess.spawnTerminal = async (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
      if (!enabled()) return spawnTerminal(spec)
      const route = mapLocalTreeToRemote(spec.cwd)
      if (route === null) return spawnTerminal(spec)
      debugLog(`terminal seam: remote terminal → ${route.hostId}:${route.remotePath}`)
      // getConnectionFor 先建连/复用连接池；失败（主机不可达等）原样上抛，
      // 控制器把 create 失败透传给浏览器。
      const connection = await runtime.getConnectionFor(route.hostId)
      const terminal = await spawnSshTerminal(
        connection,
        {
          ...spec,
          // argv 是本地执行环境探测的 shell 路径，对远端无意义：空数组 =
          // 保留远端登录 shell（spawnSshTerminal 会 cd 到 spec.cwd）。
          // spec.env（DSH_SESSION_ID 等）不注入——PTY 保留登录环境。
          argv: [],
          cwd: route.remotePath,
          graceMs: Math.max(spec.graceMs, MIN_REMOTE_GRACE_MS),
        },
        posix.join('/tmp', 'dsh-ssh-terminals', randomUUID()),
        POLL_MS,
      )
      if (disposed) {
        await terminal.terminate()
        throw new Error('terminal seam: plugin disposed during terminal setup')
      }
      terminals.add(terminal)
      const release = (): void => { terminals.delete(terminal) }
      void terminal.done.then(release, release)
      return terminal
    }

    debugLog('terminal seam: remote routing installed (spawnTerminal)')
    scope.effect(() => async () => {
      disposed = true
      delete (subprocess as unknown as Record<string, unknown>).spawnTerminal
      await Promise.allSettled([...terminals].map(terminal => terminal.terminate()))
      debugLog('terminal seam: remote routing uninstalled')
    }, 'dsh-remote-ide: terminal seam teardown')
  })
}
