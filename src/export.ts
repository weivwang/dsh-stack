import { redactPatch } from './patch.js'
import { StackError } from './errors.js'
import {
  classifySpecifier,
  discoverHarnessVersion,
  installedPackageVersion,
  isPinnedGitSpecifier,
  readInstalledProfile,
  resolveDshHome,
} from './profile.js'
import {
  DEFAULT_MAX_PATCH_BYTES,
  STACK_FORMAT,
  STACK_FORMAT_VERSION,
  type DshStack,
  type ExportStackOptions,
  type StackBundle,
} from './types.js'
import { sealStack, validateStack } from './validation.js'

/** Export an installed profile as a secret-safe, integrity-sealed Stackfile. */
export function exportStack(options: ExportStackOptions): DshStack {
  const dshHome = resolveDshHome(options.dshHome)
  const profile = readInstalledProfile(options.profile, {
    dshHome,
    maxPatchBytes: options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
  })
  if (profile === undefined) throw new Error('unreachable')
  const bundleNames = profile.manifest.dsh?.profile?.bundles ?? []
  if (bundleNames.length === 0) {
    throw new StackError('EMPTY_PROFILE', `Profile ${JSON.stringify(options.profile)} has no bundle layers to export.`)
  }
  const warnings: string[] = []
  const bundles = bundleNames.map((name): StackBundle => {
    const originalSpecifier = profile.manifest.dependencies?.[name]
    if (originalSpecifier === undefined) return { name, sourceKind: 'builtin' }
    const sourceKind = classifySpecifier(originalSpecifier)
    const installedVersion = installedPackageVersion(profile, name)
    const specifier = sourceKind === 'registry' && installedVersion !== undefined
      ? installedVersion
      : originalSpecifier
    if (sourceKind === 'local') {
      warnings.push(`${name} uses a machine-local dependency and cannot be applied elsewhere automatically.`)
    } else if (sourceKind === 'git' && !isPinnedGitSpecifier(specifier)) {
      warnings.push(`${name} uses a mutable git ref; pin a commit before publishing this Stackfile.`)
    } else if (sourceKind === 'other') {
      warnings.push(`${name} uses an unrecognized dependency source and requires manual review.`)
    }
    if (installedVersion === undefined) warnings.push(`Could not discover the installed version of ${name}.`)
    return {
      name,
      specifier,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      sourceKind,
    }
  })
  const harnessVersion = options.harnessVersion ?? discoverHarnessVersion()
  if (harnessVersion === undefined) warnings.push('Could not discover the installed DeepSeek Harness version.')
  const profilePatch = options.includePatch === false
    ? undefined
    : redactPatch(profile.patch, { dshHome })
  if (profilePatch !== undefined && profilePatch.secrets.length > 0) {
    warnings.push(
      `The profile patch requires ${profilePatch.secrets.length} secret environment variable`
      + `${profilePatch.secrets.length === 1 ? '' : 's'} when applied.`,
    )
  }

  return validateStack(sealStack({
    format: STACK_FORMAT,
    formatVersion: STACK_FORMAT_VERSION,
    name: options.name?.trim() || options.profile,
    ...(options.description?.trim() ? { description: options.description.trim() } : {}),
    createdAt: (options.now ?? new Date()).toISOString(),
    source: {
      profile: options.profile,
      ...(harnessVersion === undefined ? {} : { harnessVersion }),
    },
    bundles,
    ...(profilePatch === undefined ? {} : { profilePatch }),
    warnings,
  }))
}

/** Render a Stackfile as stable, review-friendly JSON. */
export function formatStackJson(stack: DshStack): string {
  return `${JSON.stringify(stack, null, 2)}\n`
}

/** Score how easily another machine can reproduce a Stackfile. */
export function stackShareability(stack: DshStack): { score: number; label: string } {
  let score = 100
  score -= Math.min(60, stack.bundles.filter(bundle => bundle.sourceKind === 'local').length * 30)
  score -= Math.min(30, stack.bundles.filter(bundle =>
    bundle.sourceKind === 'git' && bundle.specifier !== undefined && !isPinnedGitSpecifier(bundle.specifier)).length * 15)
  score -= Math.min(15, stack.bundles.filter(bundle => bundle.sourceKind === 'other').length * 10)
  if (stack.source.harnessVersion === undefined) score -= 5
  if (stack.profilePatch === undefined) score -= 5
  score = Math.max(0, score)
  const label = score >= 90 ? 'excellent' : score >= 70 ? 'good' : score >= 40 ? 'needs review' : 'local only'
  return { score, label }
}
