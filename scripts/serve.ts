import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { readJson } from '../src/persistence.ts'
import { validateSetting, type WebSettings } from '../src/settings.ts'

// 后续部署用启动衔接，不安装服务、不改代理；配置文件绝不含Bot Token。
const config = JSON.parse(readFileSync(resolve(process.argv[2]!), 'utf8')) as {
  dshBin: string; patch: string; dataDir: string; host: string; port: number; publicOrigin: string
}
const saved = readJson<Partial<WebSettings>>(`${config.dataDir}/web-settings.json`) ?? {}
const host = validateSetting('host', saved.host ?? config.host, 30) as string
const port = validateSetting('port', saved.port ?? config.port, 30) as number
const origin = validateSetting('publicOrigin', saved.publicOrigin ?? config.publicOrigin, 30) as string
const args = ['--experimental-transform-types', config.dshBin, '--profile', 'web', '--patch', config.patch,
  '--no-open', '--host', host, '--port', String(port), '--trusted-host', new URL(origin).host]
if (process.argv[3] === '--check') {
  // 只检查/展示无凭据启动参数，不启动DSH或访问网络。
  console.log(JSON.stringify({ node: process.execPath, args, publicOrigin: origin }, null, 2))
  process.exit(0)
}
process.umask(0o077)
const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'pipe'] })
let ready = false
let failed = false
function stop(): void { failed = true; child.kill('SIGTERM') }
for (const stream of [child.stdout!, child.stderr!]) {
  const lines = createInterface({ input: stream })
  lines.on('line', line => {
    if (line === 'DSH_TELEGRAM_GATE_READY') ready = true
    if (line === 'DSH_TELEGRAM_GATE_UNLOADED') {
      console.error('Telegram gate unloaded; stopping DSH fail-closed.')
      stop(); return
    }
    // 含内存launch token的上游URL行一律吞掉，不写任何文件或日志。
    if (line.startsWith('dsh web: ')) {
      if (!ready) { console.error('Required Telegram gate did not activate; stopping DSH.'); stop(); return }
      console.log(`DSH Web ready; Telegram gate activated: ${origin}`)
    } else console.log(line)
  })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
child.on('error', () => { console.error('Cannot start DSH; check executable and paths.'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = failed ? 1 : code ?? 1 })
