/**
 * dsh 契约探针的 vitest 守卫：升级 devDeps（dsh 包）后 pnpm test 在此变红，
 * 失败输出直接报出断开的契约名——按名字去 src/ 对应位置修，而不是线上排障。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

describe('dsh 契约探针（升级雷达）', () => {
  it('对 devDeps 树无断开（client 包记 SKIP 属预期）', () => {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-dsh-contract.mjs')
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    expect(output).toContain('契约通过')
    expect(output).not.toContain('[FAIL]')
  }, 180_000)
})
