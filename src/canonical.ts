import { createHash } from 'node:crypto'

/** Return a SHA-256 digest with an explicit algorithm prefix. */
export function sha256(value: string): string {
  return `sha256-${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

/**
 * Serialize JSON with recursively sorted object keys while retaining array
 * order. The Stackfile digest uses this form so formatting cannot alter trust.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortJson(record[key])]))
}
