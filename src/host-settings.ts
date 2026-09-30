/**
 * dsh-remote-ide — SSH 主机配置形状（wire 契约）。
 *
 * 0.1.7 迁移注记：dsh-settings 0.1.7 移除了 installSettingsSection/settingsNamespace，
 * 本插件的 settings 镜像层随之退役。HostStore（~/.dsh/dsh-remote-ide.json，0600）
 * 自本版起是唯一权威存储：typert 主机 CRUD 直接读写它，浏览器仍只看到脱敏投影。
 * 此文件只保留 client 半 ↔ host 半的 wire 形状与 schema 描述。
 */

import z from 'schemastery'

/** 一台 SSH 主机（client 表单提交/主机卡展示的同一契约；口令 write-only）。 */
export interface SshHostConfig {
  /** 稳定 id（= alias，占位目录路径依赖）。 */
  id: string
  /** 显示名。 */
  name?: string
  /** 主机名或 IP。 */
  host: string
  /** SSH 端口。 */
  port: number
  /** 登录用户。 */
  user: string
  /** 认证方式。 */
  authType: 'key' | 'password'
  /** 私钥路径（key 认证；缺省走 ssh-agent）。 */
  privateKeyPath?: string
  /** 口令（password 认证；write-only，保存后不回传，留空沿用已存值）。 */
  password?: string
  /** 跳板链（ProxyJump）：本地别名按序穿过。 */
  proxyJump?: string[]
  /** HTTP CONNECT 代理（首跳拨号走它；password 同样 write-only）。 */
  httpProxy?: {
    host: string
    port: number
    username?: string
    password?: string
  }
  /** 备注。 */
  description?: string
}

/** schemastery schema（client 表单提交的同一契约；仅用于描述符文档化）。 */
export const HostConfigSchema: z<SshHostConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  host: z.string().required(),
  port: z.number().min(1).max(65535).default(22),
  user: z.string().required(),
  authType: z.union([z.const('key'), z.const('password')]).default('key'),
  privateKeyPath: z.string(),
  password: z.string().role('secret'),
  proxyJump: z.array(z.string()),
  httpProxy: z.object({
    host: z.string().required(),
    port: z.number().min(1).max(65535).default(8080),
    username: z.string(),
    password: z.string().role('secret'),
  }),
  description: z.string(),
})
