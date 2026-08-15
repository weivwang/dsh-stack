import { canonicalJson, sha256 } from './canonical.js'
import { StackError } from './errors.js'
import {
  STACK_FORMAT,
  STACK_FORMAT_VERSION,
  type BundleSourceKind,
  type DshStack,
  type StackBundle,
  type StackProfilePatch,
  type StackSecretReference,
} from './types.js'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i
const PROFILE_NAME = /^(?!node_modules$)[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const SECRET_PLACEHOLDER = /\{\{DSH_STACK_SECRET:([A-Z0-9_]+)\}\}/g
const SOURCE_KINDS = new Set<BundleSourceKind>(['builtin', 'registry', 'git', 'local', 'other'])

/** Compute the integrity field for a Stackfile. */
export function computeStackIntegrity(stack: Omit<DshStack, 'integrity'>): string {
  return sha256(canonicalJson(stack))
}

/** Return a complete Stackfile with a fresh integrity digest. */
export function sealStack(stack: Omit<DshStack, 'integrity'>): DshStack {
  return { ...stack, integrity: computeStackIntegrity(stack) }
}

/** Parse and fully validate untrusted Stackfile JSON. */
export function parseStackJson(raw: string): DshStack {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new StackError('INVALID_JSON', 'Stackfile is not valid JSON.')
  }
  return validateStack(parsed)
}

/** Validate an untrusted JavaScript value as a v1 Stackfile. */
export function validateStack(value: unknown): DshStack {
  const root = expectRecord(value, 'Stackfile')
  expectExactKeys(root, [
    'format', 'formatVersion', 'name', 'description', 'createdAt', 'source', 'bundles',
    'profilePatch', 'warnings', 'integrity',
  ], 'Stackfile')
  if (root.format !== STACK_FORMAT) throw invalid('Stackfile format must be "dsh-stack".')
  if (root.formatVersion !== STACK_FORMAT_VERSION) {
    throw new StackError(
      'UNSUPPORTED_VERSION',
      `Stackfile format version ${String(root.formatVersion)} is not supported; expected ${STACK_FORMAT_VERSION}.`,
    )
  }
  const name = expectBoundedString(root.name, 'Stackfile name', 1, 120)
  const description = root.description === undefined
    ? undefined
    : expectBoundedString(root.description, 'Stackfile description', 1, 2_000)
  const createdAt = expectBoundedString(root.createdAt, 'createdAt', 1, 80)
  if (Number.isNaN(Date.parse(createdAt))) throw invalid('createdAt must be an ISO-8601 timestamp.')

  const sourceRecord = expectRecord(root.source, 'source')
  expectExactKeys(sourceRecord, ['profile', 'harnessVersion'], 'source')
  const profile = expectProfileName(sourceRecord.profile)
  const harnessVersion = sourceRecord.harnessVersion === undefined
    ? undefined
    : expectBoundedString(sourceRecord.harnessVersion, 'harnessVersion', 1, 80)

  if (!Array.isArray(root.bundles) || root.bundles.length === 0 || root.bundles.length > 1_000) {
    throw invalid('bundles must contain between 1 and 1000 entries.')
  }
  const bundles = root.bundles.map((entry, index) => validateBundle(entry, index))
  const names = new Set<string>()
  for (const bundle of bundles) {
    if (names.has(bundle.name)) throw invalid(`Bundle ${bundle.name} appears more than once.`)
    names.add(bundle.name)
  }

  const profilePatch = root.profilePatch === undefined ? undefined : validateProfilePatch(root.profilePatch)
  if (!Array.isArray(root.warnings) || root.warnings.length > 1_000) throw invalid('warnings must be an array.')
  const warnings = root.warnings.map((warning, index) =>
    expectBoundedString(warning, `warnings[${index}]`, 1, 2_000))
  const integrity = expectBoundedString(root.integrity, 'integrity', 71, 71)
  if (!/^sha256-[0-9a-f]{64}$/.test(integrity)) throw invalid('integrity must be a SHA-256 digest.')

  const withoutIntegrity: Omit<DshStack, 'integrity'> = {
    format: STACK_FORMAT,
    formatVersion: STACK_FORMAT_VERSION,
    name,
    ...(description === undefined ? {} : { description }),
    createdAt,
    source: { profile, ...(harnessVersion === undefined ? {} : { harnessVersion }) },
    bundles,
    ...(profilePatch === undefined ? {} : { profilePatch }),
    warnings,
  }
  const expected = computeStackIntegrity(withoutIntegrity)
  if (integrity !== expected) {
    throw new StackError('INTEGRITY_MISMATCH', 'Stackfile integrity check failed; the file may be incomplete or modified.')
  }
  return { ...withoutIntegrity, integrity }
}

/** Validate a profile name before joining it to the Harness home. */
export function expectProfileName(value: unknown): string {
  const profile = expectBoundedString(value, 'profile', 1, 120)
  if (!PROFILE_NAME.test(profile)) throw invalid(`Invalid profile name ${JSON.stringify(profile)}.`)
  return profile
}

/** Return all secret placeholder ids present in YAML content. */
export function secretPlaceholderIds(content: string): string[] {
  return [...content.matchAll(SECRET_PLACEHOLDER)].map(match => match[1] as string)
}

function validateBundle(value: unknown, index: number): StackBundle {
  const bundle = expectRecord(value, `bundles[${index}]`)
  expectExactKeys(bundle, ['name', 'specifier', 'installedVersion', 'sourceKind'], `bundles[${index}]`)
  const name = expectBoundedString(bundle.name, `bundles[${index}].name`, 1, 214)
  if (!PACKAGE_NAME.test(name)) throw invalid(`Invalid bundle package name ${JSON.stringify(name)}.`)
  const sourceKind = expectBoundedString(bundle.sourceKind, `bundles[${index}].sourceKind`, 1, 20) as BundleSourceKind
  if (!SOURCE_KINDS.has(sourceKind)) throw invalid(`Unsupported source kind ${JSON.stringify(sourceKind)}.`)
  const specifier = bundle.specifier === undefined
    ? undefined
    : expectBoundedString(bundle.specifier, `bundles[${index}].specifier`, 1, 2_000)
  const installedVersion = bundle.installedVersion === undefined
    ? undefined
    : expectBoundedString(bundle.installedVersion, `bundles[${index}].installedVersion`, 1, 120)
  if (sourceKind === 'builtin' && specifier !== undefined) {
    throw invalid(`Built-in bundle ${name} must not declare a specifier.`)
  }
  if (sourceKind !== 'builtin' && specifier === undefined) {
    throw invalid(`Bundle ${name} must declare a specifier.`)
  }
  if (specifier !== undefined) assertSafeSpecifier(name, specifier)
  return {
    name,
    ...(specifier === undefined ? {} : { specifier }),
    ...(installedVersion === undefined ? {} : { installedVersion }),
    sourceKind,
  }
}

function assertSafeSpecifier(name: string, specifier: string): void {
  if (/\s|[&|;<>()`$]/.test(specifier)) {
    throw invalid(`Bundle ${name} has a dependency specifier containing unsafe shell characters.`)
  }
  if (/(?:https?|git\+https):\/\/[^/@]+:[^/@]+@/i.test(specifier)
    || /[?&](?:token|key|secret|password)=/i.test(specifier)) {
    throw invalid(`Bundle ${name} must not embed credentials in its dependency specifier.`)
  }
}

function validateProfilePatch(value: unknown): StackProfilePatch {
  const patch = expectRecord(value, 'profilePatch')
  expectExactKeys(patch, ['content', 'sha256', 'secrets'], 'profilePatch')
  const content = expectBoundedString(patch.content, 'profilePatch.content', 1, 524_288)
  const digest = expectBoundedString(patch.sha256, 'profilePatch.sha256', 71, 71)
  if (digest !== sha256(content)) throw invalid('profilePatch digest does not match its content.')
  if (!Array.isArray(patch.secrets) || patch.secrets.length > 1_000) {
    throw invalid('profilePatch.secrets must be an array.')
  }
  const secrets = patch.secrets.map((secret, index) => validateSecret(secret, index))
  const ids = new Set<string>()
  for (const secret of secrets) {
    if (ids.has(secret.id)) throw invalid(`Secret id ${secret.id} appears more than once.`)
    ids.add(secret.id)
  }
  const placeholders = secretPlaceholderIds(content)
  if (placeholders.some(id => !ids.has(id)) || secrets.some(secret => !placeholders.includes(secret.id))) {
    throw invalid('profilePatch secret references and placeholders must match exactly.')
  }
  return { content, sha256: digest, secrets }
}

function validateSecret(value: unknown, index: number): StackSecretReference {
  const secret = expectRecord(value, `profilePatch.secrets[${index}]`)
  expectExactKeys(secret, ['id', 'env', 'path'], `profilePatch.secrets[${index}]`)
  const id = expectBoundedString(secret.id, 'secret id', 1, 80)
  if (!/^[A-Z][A-Z0-9_]*$/.test(id)) throw invalid(`Invalid secret id ${JSON.stringify(id)}.`)
  const env = expectBoundedString(secret.env, 'secret env', 1, 120)
  if (env !== `DSH_STACK_SECRET_${id}`) throw invalid(`Secret ${id} has an invalid environment variable name.`)
  const path = expectBoundedString(secret.path, 'secret path', 1, 1_000)
  return { id, env, path }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function expectExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${label} contains unsupported field ${JSON.stringify(key)}.`)
  }
}

function expectBoundedString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) {
    throw invalid(`${label} must be a string between ${min} and ${max} characters.`)
  }
  return value
}

function invalid(message: string): StackError {
  return new StackError('INVALID_STACK', message)
}
