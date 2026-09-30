/**
 * Typert 端点结果 JSON-safe 回归测试 —— 真机抓到的 bug：网关边界校验
 * （assertJsonValue）要求业务结果纯 JSON-safe，显式赋值的 `error: undefined`
 * 是 own property，会被拒绝（"business result failed boundary validation"）。
 * 8/28 验证时连接一直失败（error 为字符串能过校验），成功路径从未走过网关。
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { jsonSafe, SshRemoteService } from '../src/typert'
import type { SshHostConfig } from '../src/host-settings'

/** 轻量镜像网关断言：递归拒绝 undefined / 非有限数 / 非 plain object。 */
function assertJsonSafe(value: unknown, ancestors: Set<unknown> = new Set()): void {
  if (value === undefined) throw new TypeError('undefined is not JSON-safe')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number')
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${typeof value} is not JSON-safe`)
  if (ancestors.has(value)) throw new TypeError('cyclic value')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, ancestors)
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) throw new TypeError('non-plain object')
  for (const key of Object.keys(value)) {
    assertJsonSafe((value as Record<string, unknown>)[key], ancestors)
  }
}

describe('jsonSafe', () => {
  it('剥离 undefined own-values（嵌套对象与数组）', () => {
    const input = {
      ok: true,
      latencyMs: 42,
      error: undefined,
      nested: { present: 'yes', absent: undefined },
      list: [{ fine: 1, skip: undefined }, undefined, 'keep'],
    }
    const output = jsonSafe(input)
    expect(Object.hasOwn(output, 'error')).toBe(false)
    expect(Object.hasOwn((output as { nested: Record<string, unknown> }).nested, 'absent')).toBe(false)
    expect((output as { list: unknown[] }).list).toEqual([{ fine: 1 }, 'keep'])
    expect(output).toEqual({ ok: true, latencyMs: 42, nested: { present: 'yes' }, list: [{ fine: 1 }, 'keep'] })
  })

  it('原始值与 null 原样返回', () => {
    expect(jsonSafe('text')).toBe('text')
    expect(jsonSafe(0)).toBe(0)
    expect(jsonSafe(null)).toBe(null)
  })
})

describe('SshRemoteService 端点结果 JSON-safe', () => {
  interface EngineStub {
    testConfig?: (config: unknown) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>
    upsertHost?: (payload: unknown, existing?: string) => unknown
    removeHost?: (alias: string) => boolean
    getStoredEntry?: (alias: string) => { auth: { kind: string; password?: string; keyPath?: string } } | undefined
    list?: () => Array<{ alias: string; auth: string }>
  }

  /** 0.1.7+ 语义：settings 镜像已退役，主机清单/口令权威存储 = 0600 store。 */
  function setup(engineStub: EngineStub = {}) {
    const ctx = new Context()
    const upsertHost = engineStub.upsertHost ?? vi.fn(() => undefined)
    const runtimeStub = {
      getStoredEntry: engineStub.getStoredEntry
        ?? ((alias: string) => alias === 'vm'
          ? { auth: { kind: 'password', password: 'secret' }, proxyJump: [] }
          : undefined),
      engine: {
        upsertHost,
        removeHost: engineStub.removeHost ?? (() => true),
        testConfig: engineStub.testConfig ?? (async () => ({ ok: true, latencyMs: 5 })),
        list: engineStub.list ?? (() => [{ alias: 'vm', auth: 'password' }]),
      },
    }
    const service = new SshRemoteService(ctx, runtimeStub as never)
    return { service, upsertHost }
  }

  it('testConnection 成功：结果无 error own-key，整体 JSON-safe', async () => {
    const { service } = setup({ testConfig: async () => ({ ok: true, latencyMs: 123 }) })
    const result = await service.testConnection('vm', { host: '192.0.2.1', user: 'root' })
    expect(result.ok).toBe(true)
    expect(Object.hasOwn(result, 'error')).toBe(false)
    expect(Object.hasOwn(result, 'latencyMs')).toBe(true)
    assertJsonSafe(result)
  })

  it('testConnection 失败：error 字符串保留，整体 JSON-safe', async () => {
    const { service } = setup({ testConfig: async () => ({ ok: false, latencyMs: 7, error: 'auth failed' }) })
    const result = await service.testConnection('vm', { host: '192.0.2.1', user: 'root' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('auth failed')
    assertJsonSafe(result)
  })

  it('listHosts：脱敏视图 JSON-safe，secrets 来自 0600 store', () => {
    const { service } = setup()
    const result = service.listHosts()
    expect(result.secrets.vm).toBe(true)
    expect(Object.hasOwn(result.hosts.vm as Record<string, unknown>, 'password')).toBe(false)
    assertJsonSafe(result)
  })

  it('saveHost：口令只进 store（settings 镜像已退役，无第二落盘面）', async () => {
    const upsertHost = vi.fn(() => undefined)
    const { service } = setup({ upsertHost })
    await service.saveHost('vm', { host: '192.0.2.1', user: 'root', authType: 'password', password: 'newpw' })
    const payload = upsertHost.mock.calls[0]?.[0] as { auth: { kind: string; password?: string } }
    expect(payload.auth).toEqual({ kind: 'password', password: 'newpw' })
  })

  it('saveHost：口令留空 = 沿用 store 既有口令', async () => {
    const upsertHost = vi.fn(() => undefined)
    const { service } = setup({ upsertHost })
    await service.saveHost('vm', { host: '192.0.2.1', user: 'root', authType: 'password' })
    const payload = upsertHost.mock.calls[0]?.[0] as { auth: { kind: string; password?: string } }
    expect(payload.auth.password).toBe('secret')
  })

  // 迁移用例已随 settings 镜像退役移除：0.1.7 起 store 是唯一权威，
  // settings→store 的一次性迁移由启动路径负责，不在 SshRemoteService 面。
})
