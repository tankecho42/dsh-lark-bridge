import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_BACKUPS = 3

/**
 * Small synchronous logger for lifecycle paths where losing the final line is
 * worse than a tiny write cost. Rotation is size-based and logging is fail-safe.
 */
export function createFileLogger({ dataDir, maxBytes = DEFAULT_MAX_BYTES, backups = DEFAULT_BACKUPS }) {
  const logDir = join(dataDir, 'logs')
  const logPath = join(logDir, 'plugin.log')
  const byteLimit = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_MAX_BYTES)
  const backupCount = Math.max(1, Math.min(10, Math.floor(Number(backups) || DEFAULT_BACKUPS)))

  function rotateIfNeeded(incomingBytes) {
    let currentBytes = 0
    try { currentBytes = statSync(logPath).size } catch { /* first write */ }
    if (!currentBytes || currentBytes + incomingBytes <= byteLimit) return

    const oldest = `${logPath}.${backupCount}`
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let index = backupCount - 1; index >= 1; index--) {
      const source = `${logPath}.${index}`
      if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`)
    }
    if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`)
  }

  function log(message, data) {
    try {
      mkdirSync(logDir, { recursive: true })
      let suffix = ''
      if (data !== undefined) {
        try { suffix = ` ${JSON.stringify(data)}` } catch { suffix = ' [unserializable metadata]' }
      }
      const line = `[${new Date().toISOString()}] [plugin] ${message}${suffix}\n`
      rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      appendFileSync(logPath, line, 'utf8')
    } catch {
      // Logging must never take down message handling or plugin disposal.
    }
  }

  log.path = logPath
  return log
}

