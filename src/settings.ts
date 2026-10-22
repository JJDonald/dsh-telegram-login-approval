import { isIP } from 'node:net'
import { readJson, savePrivate } from './persistence.ts'

export interface WebSettings {
  host: string
  port: number
  publicOrigin: string
  sessionDays: number
  approvalSeconds: number
  failureCooldownSeconds: number
}
export type Setting = keyof WebSettings

export function validateSetting(key: Setting, value: unknown, maxSessionDays: number): string | number {
  if (key === 'host') {
    if (typeof value !== 'string' || isIP(value) === 0 || value.includes('%')) {
      throw new Error('绑定地址须为具体 IPv4/IPv6 地址，推荐 127.0.0.1；不支持域名、方括号或 %zone')
    }
    const address = isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname : value
    if (address === '0.0.0.0' || address === '[::]' || address === '[::ffff:0:0]') {
      throw new Error('DSH 不支持通配绑定地址（0.0.0.0、:: 及其 IPv4-mapped 形式）；请改用 127.0.0.1 或本机具体接口地址')
    }
    return value
  }
  if (key === 'publicOrigin') {
    if (typeof value !== 'string') throw new Error('publicOrigin：请输入 HTTPS origin')
    let url: URL
    try { url = new URL(value) } catch { throw new Error('publicOrigin：请输入合法 HTTPS origin，无路径或尾斜杠') }
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.hostname.length > 253 ||
      url.hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('publicOrigin：请输入规范 HTTPS 域名 origin，可带端口，不含路径、查询或尾斜杠')
    }
    return value
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  const ranges: Record<string, [number, number]> = {
    port: [1, 65535], sessionDays: [1, maxSessionDays], approvalSeconds: [30, 3600], failureCooldownSeconds: [60, 86400],
  }
  const [min, max] = ranges[key]!
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`)
  return n
}

export function loadSettings(file: string, defaults: WebSettings, maxDays: number): WebSettings {
  const stored = readJson<Partial<WebSettings>>(file)
  const settings = { ...defaults, ...stored }
  for (const key of Object.keys(defaults) as Setting[]) validateSetting(key, settings[key], maxDays)
  return settings
}

export class SettingsStore {
  value: WebSettings
  constructor(private readonly file: string, defaults: WebSettings, readonly maxDays: number) {
    this.value = loadSettings(file, defaults, maxDays)
  }
  set(key: Setting, input: string): void {
    const value = validateSetting(key, input, this.maxDays)
    const next = { ...this.value, [key]: value }
    savePrivate(this.file, JSON.stringify(next, null, 2) + '\n')
    this.value = next
  }
}
