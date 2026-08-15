import { homedir } from 'node:os'
import { isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml'
import { sha256 } from './canonical.js'
import { StackError } from './errors.js'
import type { StackProfilePatch, StackSecretReference } from './types.js'

const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string): string => value,
}

const SENSITIVE_KEY_ENDINGS = [
  'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'SIGNING_KEY', 'CLIENT_SECRET', 'ACCESS_TOKEN',
  'REFRESH_TOKEN', 'AUTH_TOKEN', 'PASSWORD', 'PASSWD', 'SECRET', 'TOKEN', 'COOKIE',
  'AUTHORIZATION', 'WEBHOOK_URL',
] as const

const SENSITIVE_LITERALS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
] as const

/** Inputs used to remove secrets and machine-local home paths from YAML. */
export interface RedactPatchOptions {
  /** Harness home represented by `{{DSH_HOME}}`. */
  dshHome: string
  /** OS home represented by `{{HOME}}`. */
  home?: string
}

/** Convert a profile patch into a share-safe, hydratable YAML artifact. */
export function redactPatch(raw: string, options: RedactPatchOptions): StackProfilePatch {
  const doc = parsePatch(raw)
  const secrets: StackSecretReference[] = []
  const secretIds = new Set<string>()
  const allocated = new Map<string, number>()
  const homes = normalizeHomes(options.dshHome, options.home ?? homedir())

  walkNode(doc.contents, [], false, (node, path, forcedSensitive) => {
    if (!isScalar(node)) return
    if (typeof node.value === 'string') {
      for (const id of existingSecretIds(node.value)) {
        if (secretIds.has(id)) continue
        secretIds.add(id)
        secrets.push({ id, env: `DSH_STACK_SECRET_${id}`, path: formatPath(path) })
      }
    }
    if (forcedSensitive && !isPortableReference(node)) {
      const reference = allocateSecret(path, allocated, secretIds)
      secrets.push(reference)
      node.value = `{{DSH_STACK_SECRET:${reference.id}}}`
      delete node.tag
      return
    }
    if (typeof node.value !== 'string') return
    if (containsSensitiveLiteral(node.value)) {
      const reference = allocateSecret(path, allocated, secretIds, 'LITERAL')
      secrets.push(reference)
      node.value = `{{DSH_STACK_SECRET:${reference.id}}}`
      delete node.tag
      return
    }
    node.value = makePathPortable(node.value, homes)
  })

  const content = scrubResidualLiterals(String(doc))
  return { content, sha256: sha256(content), secrets }
}

/** Restore home paths and environment-supplied secrets into portable YAML. */
export function hydratePatch(
  patch: StackProfilePatch,
  options: { dshHome: string; home?: string; env?: NodeJS.ProcessEnv },
): string {
  const env = options.env ?? process.env
  const missing = patch.secrets.filter(secret => env[secret.env] === undefined)
  if (missing.length > 0) {
    throw new StackError(
      'MISSING_SECRETS',
      `Set the required environment variable${missing.length === 1 ? '' : 's'} before applying: `
      + missing.map(secret => secret.env).join(', '),
    )
  }
  const values = new Map(patch.secrets.map(secret => [secret.id, env[secret.env] as string]))
  const doc = parsePatch(patch.content)
  walkNode(doc.contents, [], false, (node) => {
    if (!isScalar(node) || typeof node.value !== 'string') return
    node.value = node.value
      .replaceAll('{{DSH_HOME}}', options.dshHome)
      .replaceAll('{{HOME}}', options.home ?? homedir())
      .replace(/\{\{DSH_STACK_SECRET:([A-Z0-9_]+)\}\}/g, (_placeholder, id: string) => {
        const value = values.get(id)
        if (value === undefined) throw new StackError('INVALID_PATCH', `No value was declared for secret placeholder ${id}.`)
        return value
      })
  })
  return String(doc)
}

/** Return whether a patch is an empty top-level list. */
export function isEmptyPatch(raw: string): boolean {
  const doc = parsePatch(raw)
  return isSeq(doc.contents) && doc.contents.items.length === 0
}

/** Validate patch syntax without evaluating `!!js` expressions. */
export function assertPatchSyntax(raw: string): void {
  parsePatch(raw)
}

function parsePatch(raw: string): Document<Node, true> {
  const doc = parseDocument<Node, true>(raw, { customTags: [JS_TAG], keepSourceTokens: false })
  if (doc.errors.length > 0) {
    const position = doc.errors[0]?.linePos?.[0]
    const location = position === undefined ? '' : ` near line ${position.line}`
    throw new StackError('INVALID_PATCH', `Profile patch is not valid YAML${location}.`)
  }
  if (!isSeq(doc.contents)) throw new StackError('INVALID_PATCH', 'Profile patch must be a top-level YAML array.')
  return doc
}

type ScalarVisitor = (node: unknown, path: readonly (string | number)[], forcedSensitive: boolean) => void

function walkNode(
  node: unknown,
  path: readonly (string | number)[],
  forcedSensitive: boolean,
  visitScalar: ScalarVisitor,
): void {
  if (isScalar(node)) {
    visitScalar(node, path, forcedSensitive)
    return
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => walkNode(item, [...path, index], forcedSensitive, visitScalar))
    return
  }
  if (!isMap(node)) return
  for (const pair of node.items) {
    if (!isPair(pair)) continue
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
    const childPath = [...path, key]
    const sensitive = forcedSensitive || isSensitiveKey(key)
    walkNode(pair.value, childPath, sensitive, visitScalar)
  }
}

function normalizeHomes(dshHome: string, home: string): { token: string; path: string }[] {
  const entries = [
    { token: '{{DSH_HOME}}', path: trimTrailingSeparators(dshHome) },
    { token: '{{HOME}}', path: trimTrailingSeparators(home) },
  ]
  return entries.sort((left, right) => right.path.length - left.path.length)
}

function makePathPortable(value: string, homes: readonly { token: string; path: string }[]): string {
  let portable = value
  for (const home of homes) {
    if (home.path.length === 0) continue
    portable = portable.replace(new RegExp(`${escapeRegExp(home.path)}(?=$|[/\\\\])`, 'g'), home.token)
  }
  return portable
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return SENSITIVE_KEY_ENDINGS.some(ending => normalized === ending || normalized.endsWith(`_${ending}`))
}

function isPortableReference(node: { value: unknown; tag?: string }): boolean {
  if (typeof node.value !== 'string') return false
  return node.value.includes('{{DSH_STACK_SECRET:')
    || node.value.includes('process.env')
    || node.value.includes('ctx.credentials')
    || /^\$\{[A-Z0-9_]+\}$/.test(node.value)
}

function containsSensitiveLiteral(value: string): boolean {
  return SENSITIVE_LITERALS.some(pattern => pattern.test(value))
}

function allocateSecret(
  path: readonly (string | number)[],
  allocated: Map<string, number>,
  secretIds: Set<string>,
  fallback = 'SECRET',
): StackSecretReference {
  const reversedKeys = [...path].reverse().filter((part): part is string => typeof part === 'string')
  const lastKey = reversedKeys.find(isSensitiveKey) ?? reversedKeys[0]
  const base = String(lastKey ?? fallback)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || fallback
  let next = allocated.get(base) ?? 0
  let id: string
  do {
    next += 1
    id = next === 1 ? base : `${base}_${next}`
  } while (secretIds.has(id))
  allocated.set(base, next)
  secretIds.add(id)
  return { id, env: `DSH_STACK_SECRET_${id}`, path: formatPath(path) }
}

function existingSecretIds(value: string): string[] {
  return [...value.matchAll(/\{\{DSH_STACK_SECRET:([A-Z][A-Z0-9_]*)\}\}/g)].map(match => match[1] as string)
}

function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((result, part) =>
    typeof part === 'number' ? `${result}[${part}]` : `${result}.${part}`, '$')
}

function scrubResidualLiterals(content: string): string {
  let safe = content
  for (const pattern of SENSITIVE_LITERALS) safe = safe.replace(new RegExp(pattern.source, `${pattern.flags}g`), '[redacted]')
  return safe
}
