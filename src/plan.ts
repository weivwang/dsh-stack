import { redactPatch, isEmptyPatch } from './patch.js'
import {
  discoverHarnessVersion,
  installedPackageVersion,
  isExactRegistryVersion,
  isPinnedGitSpecifier,
  readInstalledProfile,
  resolveDshHome,
} from './profile.js'
import type { DshStack, StackDependencyChange, StackPlan } from './types.js'
import { validateStack } from './validation.js'

/** Build a read-only installation plan against one target profile. */
export function planStack(
  stack: DshStack,
  options: { profile: string; dshHome?: string; skipPatch?: boolean },
): StackPlan {
  validateStack(stack)
  const dshHome = resolveDshHome(options.dshHome)
  const target = readInstalledProfile(options.profile, { dshHome, allowMissing: true })
  const install: StackDependencyChange[] = []
  const update: StackDependencyChange[] = []
  const unchanged: string[] = []
  const builtin: string[] = []
  const warnings = [...stack.warnings]
  const errors: string[] = []

  for (const bundle of stack.bundles) {
    if (bundle.sourceKind === 'builtin') {
      builtin.push(bundle.name)
      continue
    }
    const specifier = bundle.specifier as string
    const currentSpecifier = target?.manifest.dependencies?.[bundle.name]
    const currentVersion = target === undefined ? undefined : installedPackageVersion(target, bundle.name)
    const desired = desiredLabel(bundle)
    const matches = currentSpecifier !== undefined && dependencyMatches(bundle, currentSpecifier, currentVersion)
    if (!matches) {
      if (bundle.sourceKind === 'local') {
        errors.push(`${bundle.name} uses a local path and must be installed manually on the target machine.`)
      } else if (bundle.sourceKind === 'other') {
        errors.push(`${bundle.name} uses an unsupported dependency source: ${specifier}`)
      } else if (bundle.sourceKind === 'git' && !isPinnedGitSpecifier(specifier)) {
        errors.push(`${bundle.name} uses a mutable git ref; pin a commit or explicitly allow unpinned sources.`)
      } else if (bundle.sourceKind === 'registry' && !isExactRegistryVersion(desired)) {
        errors.push(`${bundle.name} does not name an exact registry version and cannot be reproduced safely.`)
      }
    }
    if (currentSpecifier === undefined) {
      install.push({ name: bundle.name, to: desired })
    } else if (matches) {
      unchanged.push(bundle.name)
    } else {
      update.push({
        name: bundle.name,
        from: currentVersion ?? currentSpecifier,
        to: desired,
      })
    }
  }

  const currentHarness = discoverHarnessVersion()
  if (stack.source.harnessVersion !== undefined && currentHarness !== undefined
    && stack.source.harnessVersion !== currentHarness) {
    warnings.push(
      `Stackfile was exported with Harness ${stack.source.harnessVersion}; target reports ${currentHarness}. `
      + 'Developer-preview compatibility is not guaranteed.',
    )
  }

  const patch = planPatch(stack, target?.patch, dshHome, options.skipPatch === true)
  if (patch.action === 'replace' && options.skipPatch !== true) {
    warnings.push('Target profile has a different non-empty patch; applying it requires --replace-patch or --skip-patch.')
  }

  return {
    profile: options.profile,
    profileExists: target !== undefined,
    install,
    update,
    unchanged,
    builtin,
    patch,
    warnings: unique(warnings),
    errors: unique(errors),
  }
}

/** Render a plan for human review. */
export function formatPlan(plan: StackPlan): string {
  const lines = [
    `Target profile: ${plan.profile}${plan.profileExists ? '' : ' (will be initialized)'}`,
    `Built-in layers: ${plan.builtin.length === 0 ? 'none' : plan.builtin.join(', ')}`,
  ]
  appendChanges(lines, 'Install', plan.install)
  appendChanges(lines, 'Update', plan.update)
  lines.push(`Already matching: ${plan.unchanged.length === 0 ? 'none' : plan.unchanged.join(', ')}`)
  lines.push(`Profile patch: ${plan.patch.action}`)
  if (plan.patch.requiredSecrets.length > 0) {
    lines.push(`Required environment: ${plan.patch.requiredSecrets.join(', ')}`)
  }
  if (plan.warnings.length > 0) {
    lines.push('', 'Warnings:')
    plan.warnings.forEach(warning => lines.push(`- ${warning}`))
  }
  if (plan.errors.length > 0) {
    lines.push('', 'Blocking issues:')
    plan.errors.forEach(error => lines.push(`- ${error}`))
  }
  return `${lines.join('\n')}\n`
}

function desiredLabel(bundle: DshStack['bundles'][number]): string {
  if (bundle.sourceKind === 'registry') return bundle.installedVersion ?? (bundle.specifier as string)
  return bundle.specifier as string
}

function dependencyMatches(
  bundle: DshStack['bundles'][number],
  currentSpecifier: string,
  currentVersion: string | undefined,
): boolean {
  if (bundle.sourceKind === 'registry') {
    const desiredVersion = bundle.installedVersion ?? bundle.specifier
    return currentVersion !== undefined && currentVersion === desiredVersion
  }
  return currentSpecifier === bundle.specifier
}

function planPatch(
  stack: DshStack,
  targetPatch: string | undefined,
  dshHome: string,
  skipPatch: boolean,
): StackPlan['patch'] {
  if (skipPatch || stack.profilePatch === undefined) return { action: 'none', requiredSecrets: [] }
  const requiredSecrets = stack.profilePatch.secrets.map(secret => secret.env)
  if (targetPatch === undefined) return { action: 'write', requiredSecrets }
  const targetPortable = redactPatch(targetPatch, { dshHome })
  if (targetPortable.sha256 === stack.profilePatch.sha256) return { action: 'unchanged', requiredSecrets }
  if (isEmptyPatch(targetPatch)) return { action: 'write', requiredSecrets }
  return {
    action: 'replace',
    requiredSecrets,
  }
}

function appendChanges(lines: string[], title: string, changes: readonly StackDependencyChange[]): void {
  if (changes.length === 0) {
    lines.push(`${title}: none`)
    return
  }
  lines.push(`${title}:`)
  for (const change of changes) {
    lines.push(`- ${change.name}${change.from === undefined ? '' : ` (${change.from})`} -> ${change.to}`)
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
