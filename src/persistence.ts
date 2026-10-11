import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : undefined
}

/** 同步持久化：备份失败即停止；先 fsync 内容再原子替换，成功后才更新内存。 */
export function savePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak`)
    chmodSync(`${file}.bak`, 0o600)
    const backup = openSync(`${file}.bak`, 'r')
    try { fsyncSync(backup) } finally { closeSync(backup) }
  }
  const temp = `${file}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    chmodSync(temp, 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temp, file)
  const dir = openSync(dirname(file), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}
