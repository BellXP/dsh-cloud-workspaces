/**
 * login-env（登录环境快照）测试 —— 捕获命令形状、快照解析/组装、
 * 易变变量过滤与远端路径拼接（纯函数，IO 在 engine/ssh-service 层）。
 */

import { describe, expect, it } from 'vitest'
import { LOGIN_ENV_CAPTURE_COMMAND, assembleLoginEnvScript, loginEnvRemotePath } from '../src/login-env'

/** 构造一份捕获输出（含可选的 profile 噪声前缀）。 */
function captureOutput(opts: {
  exports?: string
  funcs?: string
  aliases?: string
  ps1?: string
  noise?: string
} = {}): string {
  return [
    opts.noise ?? '',
    '__DSH_ENV_BEGIN__',
    opts.exports ?? 'declare -x ATB_HOME="/usr/local/atb"\ndeclare -x PATH="/usr/local/atb/bin:/usr/bin"',
    '',
    '__DSH_ENV_FUNCS__',
    opts.funcs ?? 'conda ()\n{\n    echo hi\n}',
    '',
    '__DSH_ENV_ALIASES__',
    opts.aliases ?? "alias ll='ls -l'",
    `__DSH_ENV_PS1__${opts.ps1 ?? '[\\u \\W]\\$ '}`,
  ].join('\n')
}

describe('login-env 快照', () => {
  it('捕获命令走 bash -lc 且四段标记齐全（分段解析的前提）', () => {
    expect(LOGIN_ENV_CAPTURE_COMMAND.startsWith('bash -lc')).toBe(true)
    expect(LOGIN_ENV_CAPTURE_COMMAND).toContain('export -p')
    expect(LOGIN_ENV_CAPTURE_COMMAND).toContain('declare -f')
    expect(LOGIN_ENV_CAPTURE_COMMAND).toContain('alias')
    for (const marker of ['__DSH_ENV_BEGIN__', '__DSH_ENV_FUNCS__', '__DSH_ENV_ALIASES__', '__DSH_ENV_PS1__']) {
      expect(LOGIN_ENV_CAPTURE_COMMAND).toContain(marker)
    }
  })

  it('解析并组装：变量 + 函数 + alias + PS1；profile 噪声被忽略', () => {
    const out = assembleLoginEnvScript(captureOutput({ noise: 'Welcome to ModelArts!\ntips: store data in /home/ma-user/work' }))
    expect(out).not.toBeUndefined()
    expect(out!.varCount).toBe(2)
    expect(out!.script).toContain('declare -x ATB_HOME=')
    expect(out!.script).toContain('conda ()')
    expect(out!.script).toContain("alias ll='ls -l'")
    expect(out!.script).toContain('export PS1=')
    expect(out!.script).not.toContain('Welcome to ModelArts')
  })

  it('易变变量被过滤（SSH_*/PWD/SHLVL/TERM/COLUMNS…）', () => {
    const out = assembleLoginEnvScript(captureOutput({
      exports: [
        'declare -x KEEP="1"',
        'declare -x SHLVL="3"',
        'declare -x PWD="/home/x"',
        'declare -x OLDPWD="/tmp"',
        'declare -x SSH_CONNECTION="1.2.3.4 5 6.7.8.9 22"',
        'declare -x SSH_AUTH_SOCK="/tmp/agent.sock"',
        'declare -x TERM="xterm-256color"',
        'declare -x COLUMNS="80"',
        'declare -x LINES="24"',
      ].join('\n'),
    }))
    expect(out).not.toBeUndefined()
    expect(out!.varCount).toBe(1)
    expect(out!.script).toContain('declare -x KEEP=')
    for (const volatile of ['SHLVL', 'PWD', 'OLDPWD', 'SSH_CONNECTION', 'SSH_AUTH_SOCK', 'TERM', 'COLUMNS', 'LINES']) {
      expect(out!.script).not.toContain(volatile)
    }
  })

  it('标记缺失或环境全被过滤 → undefined（调用方回退登录 shell）', () => {
    expect(assembleLoginEnvScript('profile noise without markers')).toBeUndefined()
    expect(assembleLoginEnvScript(captureOutput({ exports: 'declare -x SHLVL="1"' }))).toBeUndefined()
  })

  it('PS1 内的单引号被安全转义', () => {
    const out = assembleLoginEnvScript(captureOutput({ ps1: "it's> " }))
    expect(out!.script).toContain("export PS1='it'\\''s> '")
  })

  it('远端路径拼接（尾斜杠容忍）', () => {
    expect(loginEnvRemotePath('/home/ma-user')).toBe('/home/ma-user/.cache/dsh-cloud-workspaces/login-env.sh')
    expect(loginEnvRemotePath('/root/')).toBe('/root/.cache/dsh-cloud-workspaces/login-env.sh')
  })
})
