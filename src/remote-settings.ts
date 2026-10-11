import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { MiniLogger } from './util.ts'

const SETTINGS_ID = '@deepseek-ai/dsh-client-ui-settings'
// DSH 0.2.0-rc.2: only this module's single persistence selector is adapted.
// Also recognizes the existing one-origin manual condition, replacing (not extending) it.
const SELECTOR = /const persistence = ctx\.remote\.\$host\.isLoopback(?: \|\| globalThis\.location\?\.origin === "[^"\r\n]+")? \? "host" : "memory";/g

export function settingsSource(bundle: Buffer, origin: string): Buffer | undefined {
  const source = bundle.toString('utf8')
  if (!source.startsWith(`window.__ModuleLoader__.load({\n\tid: "${SETTINGS_ID}",`) ||
    [...source.matchAll(SELECTOR)].length !== 1 ||
    !source.includes('const mirror = new SettingsDescribeMirror(ctx, persistence);') ||
    !source.includes('new ConfigForms(ctx, {')) return undefined
  return Buffer.from(source.replace(SELECTOR,
    `const persistence = (ctx.remote.$host.isLoopback || globalThis.location?.origin === ${JSON.stringify(origin)}) ? "host" : "memory";`))
}

interface Entry { id: string; rev: string; url: string; [key: string]: unknown }
interface Baseline { mtimeMs: number; ctimeMs: number; size: number }
interface RecordRow { entry: Entry; bundle: Buffer; meta: { clientPath: string }; baseline: Baseline }
interface Registry {
  table: Map<string, RecordRow>
  composed: unknown
  compose(): unknown
  rebuilt(id: string): string | undefined
  captureArtifactBaseline(path: string): Baseline
  readSourceMap(path: string): unknown
  rebuildListeners: Set<(id: string, rev: string) => void>
  notifyGraphChanged(): void
  ctx: { logger: { error(error: unknown): void } }
}
interface Adapted { row: RecordRow; entry: Entry; bundle: Buffer; patchedBundle: Buffer }
function reference(rev: string): string { return `plugins/??${SETTINGS_ID}/client.js&rev=${rev}` }

/** Same native metadata revision used by the supported registry's rebuilt() method. */
function artifactRevision(baseline: Baseline): string {
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const value of [baseline.mtimeMs, baseline.ctimeMs, baseline.size]) {
    const part = String(value)
    hash.update(`${Buffer.byteLength(part)}:`).update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

/** Operates on Cordis' original registry, never the transient facade or global prototype. */
export function adaptSettings(registry: Registry, origin: string, log: MiniLogger): () => void {
  if (!(registry?.table instanceof Map) || !(registry.rebuildListeners instanceof Set) ||
    typeof registry.compose !== 'function' || typeof registry.rebuilt !== 'function' ||
    typeof registry.captureArtifactBaseline !== 'function' || typeof registry.notifyGraphChanged !== 'function' ||
    typeof registry.readSourceMap !== 'function') throw new Error('unsupported clientModules registry')
  const compose = registry.compose
  const rebuilt = registry.rebuilt
  const descriptors = new Map(['compose', 'rebuilt'].map(key => [key, Object.getOwnPropertyDescriptor(registry, key)]))
  let adapted: Adapted | undefined
  let diagnostic = ''
  function status(message: string, enabled: boolean): void {
    if (diagnostic === message) return
    diagnostic = message
    if (enabled) log.info(`remoteSettings: ${message}`)
    else log.warn(`remoteSettings 未启用: ${message}；登录门禁不受影响`)
  }
  function restoreRow(): void {
    if (adapted && registry.table.get(SETTINGS_ID) === adapted.row && adapted.row.bundle === adapted.patchedBundle) {
      adapted.row.entry = adapted.entry
      adapted.row.bundle = adapted.bundle
    }
    adapted = undefined
  }
  Object.defineProperty(registry, 'compose', { configurable: true, writable: true, value: function (this: Registry) {
    const row = this.table.get(SETTINGS_ID)
    if (!row) {
      adapted = undefined
      status('原生 settings 模块尚未注册，等待其正常加载', false)
    } else if (row !== adapted?.row || row.bundle !== adapted.patchedBundle) {
      // Reconcile and HMR supply new native bytes; unknown source stays untouched.
      const patchedBundle = settingsSource(row.bundle, origin)
      adapted = undefined
      if (patchedBundle) {
        const rev = createHash('sha256').update('dsh-remote-settings-v1\0').update(origin).update('\0').update(patchedBundle).digest('hex').slice(0, 12)
        const patchedEntry = { ...row.entry, rev, url: reference(rev) }
        adapted = { row, entry: row.entry, bundle: row.bundle, patchedBundle }
        row.entry = patchedEntry
        row.bundle = patchedBundle
        status(`原生 settings host 持久配置已适配，仅 ${origin}（及上游原有loopback）`, true)
      } else status('settings 客户端源码不符合 0.2.0-rc.2 适配点，保留上游源码；请检查DSH升级', false)
    }
    // Each compose captures its own map reader. Old revisioned maps remain correct
    // after HMR/unload; transformed code uses native identity-map composition.
    const readMap = this.readSourceMap
    const transformedPath = adapted?.row.meta.clientPath
    this.readSourceMap = path => path === transformedPath ? undefined : readMap(path)
    try { return compose.call(this) }
    finally { this.readSourceMap = readMap }
  } })
  Object.defineProperty(registry, 'rebuilt', { configurable: true, writable: true, value: function (this: Registry, id: string) {
    if (id !== SETTINGS_ID) return rebuilt.call(this, id)
    const row = this.table.get(id)
    if (!row) return undefined
    const baseline = this.captureArtifactBaseline(row.meta.clientPath)
    const nativeRev = artifactRevision(baseline)
    const nativeEntry = adapted?.row === row ? adapted.entry : row.entry
    if (nativeRev === nativeEntry.rev) return row.entry.rev
    // The supported native rebuilt algorithm, scoped to this one row. Publishing
    // the adapted rev is essential: native notifications otherwise announce old bytes.
    const bundle = readFileSync(row.meta.clientPath)
    row.baseline = baseline
    row.entry = { ...nativeEntry, rev: nativeRev, url: reference(nativeRev) }
    row.bundle = bundle
    this.composed = this.compose()
    for (const notify of this.rebuildListeners) {
      try { notify(id, row.entry.rev) } catch (error) { this.ctx.logger.error(error) }
    }
    this.notifyGraphChanged()
    return row.entry.rev
  } })
  const dispose = (): void => {
    restoreRow()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(registry, key, descriptor)
      else delete (registry as unknown as Record<string, unknown>)[key]
    }
    registry.composed = compose.call(registry)
    registry.notifyGraphChanged()
  }
  try {
    registry.composed = registry.compose()
    registry.notifyGraphChanged()
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}

/** Optional child fiber: missing/incompatible UI services must not hold up the gate. */
export function installRemoteSettings(ctx: unknown, origin: string, log: MiniLogger): void {
  const context = ctx as { inject?: (services: string[], callback: (child: any) => void) => unknown }
  if (typeof context.inject !== 'function') {
    log.warn('remoteSettings 未启用: ctx.inject 不可用；登录门禁不受影响')
    return
  }
  log.info('remoteSettings: 注册可选clientModules适配，登录门禁不等待该服务')
  context.inject(['clientModules'], child => {
    // Cordis exposes the original service through this shared symbol; wrappers
    // on that single original object are visible to every consumer facade.
    const registry = child.clientModules[Symbol.for('cordis.original')]
    try {
      child.effect(() => adaptSettings(registry, origin, log), 'telegram-login-approval: remoteSettings')
    } catch {
      log.warn('remoteSettings 未启用: clientModules 接口不兼容/适配失败，请检查DSH版本；登录门禁不受影响')
    }
  })
}
