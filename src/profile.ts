import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { StackError } from './errors.js'
import type { BundleSourceKind } from './types.js'
import { expectProfileName } from './validation.js'

/** Profile manifest fields used by dsh-stack. */
export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** Profile files and metadata resolved from a Harness home. */
export interface InstalledProfile {
  name: string
  dir: string
  manifestPath: string
  patchPath: string
  manifest: ProfileManifest
  patch: string
}

/** Resolve `$DSH_HOME`, falling back to `~/.dsh`. */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const selected = configured ?? (env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  return resolve(selected === '~' ? homedir() : selected.replace(/^~(?=[/\\])/, homedir()))
}

/** Resolve and validate one profile directory. */
export function profileDirectory(profile: string, dshHome = resolveDshHome()): string {
  return join(dshHome, 'profiles', expectProfileName(profile))
}

/** Read one initialized profile without evaluating any plugin code. */
export function readInstalledProfile(
  profile: string,
  options: { dshHome?: string; maxPatchBytes?: number; allowMissing?: boolean } = {},
): InstalledProfile | undefined {
  const dshHome = resolveDshHome(options.dshHome)
  const dir = profileDirectory(profile, dshHome)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    if (options.allowMissing === true) return undefined
    throw new StackError(
      'PROFILE_NOT_FOUND',
      `Profile ${JSON.stringify(profile)} does not exist under ${symbolicDshHome(dshHome)}/profiles.`,
    )
  }
  const manifest = readProfileManifest(manifestPath)
  const patchPath = join(dir, 'cordis.patch.yml')
  const maxPatchBytes = options.maxPatchBytes ?? 524_288
  let patch = '[]\n'
  if (existsSync(patchPath)) {
    const size = statSync(patchPath).size
    if (size > maxPatchBytes) {
      throw new StackError('PATCH_TOO_LARGE', `Profile patch exceeds the ${maxPatchBytes}-byte export limit.`)
    }
    patch = readFileSync(patchPath, 'utf8')
  }
  return { name: profile, dir, manifestPath, patchPath, manifest, patch }
}

/** Read the installed version for a package through the profile's Node lookup. */
export function installedPackageVersion(profile: InstalledProfile, packageName: string): string | undefined {
  for (const searchPath of createRequire(profile.manifestPath).resolve.paths(packageName) ?? []) {
    const manifestPath = join(searchPath, packageName, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
      return typeof manifest.version === 'string' ? manifest.version : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Classify a dependency specifier by portability and installer behavior. */
export function classifySpecifier(specifier: string): BundleSourceKind {
  if (/^(?:file|link|workspace):/i.test(specifier)
    || /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(specifier)) return 'local'
  if (/^(?:git\+|github:|gitlab:|bitbucket:)/i.test(specifier)
    || /^(?:https?|ssh):\/\/.*(?:\.git|github\.com|gitlab\.com)/i.test(specifier)) return 'git'
  if (/^(?:npm:)?(?:[~^<>=*]|v?\d|latest$|next$|beta$|canary$)/i.test(specifier)) return 'registry'
  return 'other'
}

/** Return whether a git source is pinned to an immutable commit hash. */
export function isPinnedGitSpecifier(specifier: string): boolean {
  return /#[0-9a-f]{7,64}(?:&.*)?$/i.test(specifier)
}

/** Return whether a registry source names one immutable semantic version. */
export function isExactRegistryVersion(specifier: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(specifier)
}

/** Ask the installed `dsh` binary for its version without booting a profile. */
export function discoverHarnessVersion(binary = 'dsh'): string | undefined {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0) return undefined
  const version = result.stdout.trim()
  return version.length > 0 && version.length <= 80 ? version : undefined
}

/** Make the configured home safe and stable in diagnostics. */
export function symbolicDshHome(dshHome: string): string {
  return resolve(dshHome) === resolve(join(homedir(), '.dsh')) ? '~/.dsh' : '$DSH_HOME'
}

function readProfileManifest(path: string): ProfileManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new StackError('INVALID_PROFILE', 'Profile package.json is not valid JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StackError('INVALID_PROFILE', 'Profile package.json must contain an object.')
  }
  const manifest = parsed as ProfileManifest
  if (manifest.dependencies !== undefined
    && (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies))) {
    throw new StackError('INVALID_PROFILE', 'Profile dependencies must be an object.')
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string'))) {
    throw new StackError('INVALID_PROFILE', 'Profile dsh.profile.bundles must be an array of package names.')
  }
  return manifest
}
