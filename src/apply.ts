import { spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { StackError } from './errors.js'
import { hydratePatch } from './patch.js'
import { formatPlan, planStack } from './plan.js'
import { profileDirectory, readInstalledProfile, resolveDshHome, type ProfileManifest } from './profile.js'
import type { ApplyStackOptions, ApplyStackResult, DshStack } from './types.js'

const BACKUP_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const

/** Injectable command boundary used by transaction tests. */
export interface ApplyRuntime {
  run(
    binary: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ): { status: number | null; stdout: string; stderr: string; error?: Error }
}

const defaultRuntime: ApplyRuntime = {
  run(binary, args, options) {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  },
}

/** Apply a Stackfile with review gates, backup, locking, and rollback. */
export function applyStack(
  stack: DshStack,
  options: ApplyStackOptions,
  runtime: ApplyRuntime = defaultRuntime,
): ApplyStackResult {
  if (!options.yes) {
    throw new StackError('CONFIRMATION_REQUIRED', 'Review the plan, then run apply again with --yes.')
  }
  const dshHome = resolveDshHome(options.dshHome, options.env)
  const env = { ...(options.env ?? process.env), DSH_HOME: dshHome }
  const plan = planStack(stack, {
    profile: options.profile,
    dshHome,
    ...(options.skipPatch === undefined ? {} : { skipPatch: options.skipPatch }),
  })
  const blocking = filterAllowedErrors(plan.errors, options.allowUnpinned === true)
  if (blocking.length > 0) {
    throw new StackError('UNSAFE_PLAN', `Stackfile cannot be applied safely:\n${blocking.map(error => `- ${error}`).join('\n')}`)
  }
  if (plan.patch.action === 'replace' && options.replacePatch !== true && options.skipPatch !== true) {
    throw new StackError(
      'PATCH_CONFLICT',
      'Target profile has a different non-empty patch. Re-run with --replace-patch or --skip-patch.',
    )
  }

  const hydratedPatch = stack.profilePatch === undefined || options.skipPatch === true
    ? undefined
    : hydratePatch(stack.profilePatch, { dshHome, env })
  const profileDir = profileDirectory(options.profile, dshHome)
  const stateDir = join(profileDir, '.dsh-stack')
  mkdirSync(stateDir, { recursive: true })
  const releaseLock = acquireLock(join(stateDir, 'apply.lock'), stack.integrity)
  let backup: Backup | undefined
  try {
    backup = createBackup(profileDir, stateDir, options.now ?? new Date(), stack.integrity)
    if (!plan.profileExists) {
      runDsh(runtime, options.dshBinary ?? 'dsh', ['plugin', '--profile', options.profile, 'root'], env, 'initialize profile')
    }
    const changes = [...plan.install, ...plan.update]
    if (changes.length > 0) {
      const bundleByName = new Map(stack.bundles.map(bundle => [bundle.name, bundle]))
      const specs = changes.map(change => {
        const bundle = bundleByName.get(change.name)
        if (bundle?.specifier === undefined) throw new StackError('INVALID_STACK', `Missing specifier for ${change.name}.`)
        const desired = bundle.sourceKind === 'registry'
          ? bundle.installedVersion ?? bundle.specifier
          : bundle.specifier
        return `${bundle.name}@${desired}`
      })
      runDsh(
        runtime,
        options.dshBinary ?? 'dsh',
        ['plugin', '--profile', options.profile, 'add', '--save-exact', ...specs],
        env,
        'install bundle dependencies',
      )
    }

    const installed = readInstalledProfile(options.profile, { dshHome })
    if (installed === undefined) throw new StackError('PROFILE_NOT_FOUND', 'Profile initialization did not create package.json.')
    const desiredOrder = stack.bundles.map(bundle => bundle.name)
    const existingOrder = installed.manifest.dsh?.profile?.bundles ?? []
    const extras = existingOrder.filter(name => !desiredOrder.includes(name))
    const manifest: ProfileManifest = {
      ...installed.manifest,
      dsh: {
        ...installed.manifest.dsh,
        profile: {
          ...installed.manifest.dsh?.profile,
          bundles: [...desiredOrder, ...extras],
        },
      },
    }
    atomicWrite(installed.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const patchChanged = hydratedPatch !== undefined && plan.patch.action !== 'unchanged' && plan.patch.action !== 'none'
    if (patchChanged) atomicWrite(installed.patchPath, hydratedPatch)

    const verification = runDsh(
      runtime,
      options.dshBinary ?? 'dsh',
      ['--profile', options.profile, '--dump-config'],
      env,
      'verify composed profile',
    ).stdout.trim()
    return {
      profile: options.profile,
      backupDir: backup.dir,
      changedBundles: changes.map(change => change.name),
      patchChanged,
      verification,
    }
  } catch (error) {
    if (backup !== undefined) restoreBackup(profileDir, backup)
    if (error instanceof StackError) throw error
    throw new StackError('APPLY_FAILED', `Stack application failed and profile files were restored: ${safeError(error)}`)
  } finally {
    releaseLock()
  }
}

/** Render the exact dry-run text used before `--yes`. */
export function previewApply(stack: DshStack, options: Omit<ApplyStackOptions, 'yes'>): string {
  return formatPlan(planStack(stack, {
    profile: options.profile,
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
    ...(options.skipPatch === undefined ? {} : { skipPatch: options.skipPatch }),
  }))
}

interface Backup {
  dir: string
  files: Record<(typeof BACKUP_FILES)[number], boolean>
}

function createBackup(profileDir: string, stateDir: string, now: Date, integrity: string): Backup {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const dir = join(stateDir, 'backups', `${stamp}-${integrity.slice(-8)}`)
  mkdirSync(dir, { recursive: true })
  const files = Object.fromEntries(BACKUP_FILES.map(filename => [filename, existsSync(join(profileDir, filename))])) as Backup['files']
  for (const filename of BACKUP_FILES) {
    if (files[filename]) copyFileSync(join(profileDir, filename), join(dir, filename))
  }
  writeFileSync(join(dir, 'backup.json'), `${JSON.stringify({ files }, null, 2)}\n`, { flag: 'wx' })
  return { dir, files }
}

function restoreBackup(profileDir: string, backup: Backup): void {
  for (const filename of BACKUP_FILES) {
    const target = join(profileDir, filename)
    if (backup.files[filename]) {
      copyFileSync(join(backup.dir, filename), target)
    } else {
      rmSync(target, { force: true })
    }
  }
}

function acquireLock(path: string, integrity: string): () => void {
  if (existsSync(path)) {
    const stale = readLockPid(path)
    if (stale !== undefined && !processExists(stale)) unlinkSync(path)
  }
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx')
  } catch {
    throw new StackError('APPLY_LOCKED', `Another dsh-stack apply is active. If it crashed, remove ${basename(path)} manually.`)
  }
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, integrity, startedAt: new Date().toISOString() })}\n`)
  return () => {
    closeSync(descriptor)
    try {
      unlinkSync(path)
    } catch {
      // A removed state directory already released this exact lock.
    }
  }
}

function readLockPid(path: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) ? value.pid : undefined
  } catch {
    return undefined
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function runDsh(
  runtime: ApplyRuntime,
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  action: string,
): { stdout: string; stderr: string } {
  const result = runtime.run(binary, args, { env })
  if (result.error !== undefined) {
    throw new StackError('COMMAND_FAILED', `Could not ${action}: ${safeError(result.error)}`)
  }
  if (result.status !== 0) {
    const diagnostic = scrubOutput(result.stderr || result.stdout, env.DSH_HOME).trim()
    throw new StackError(
      'COMMAND_FAILED',
      `Could not ${action}${diagnostic.length === 0 ? '.' : `:\n${diagnostic.slice(0, 4_000)}`}`,
    )
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

function atomicWrite(path: string, content: string): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.dsh-stack-${process.pid}-${randomBytes(4).toString('hex')}`,
  )
  try {
    writeFileSync(temp, content, { flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function filterAllowedErrors(errors: readonly string[], allowUnpinned: boolean): string[] {
  if (!allowUnpinned) return [...errors]
  return errors.filter(error => !error.includes('uses a mutable git ref'))
}

function scrubOutput(value: string, dshHome: string | undefined): string {
  let safe = value.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[redacted]@')
  safe = safe.replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
  if (dshHome !== undefined) safe = safe.replaceAll(dshHome, '$DSH_HOME')
  return safe
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, ' ').slice(0, 1_000)
  return String(error).replace(/[\r\n]+/g, ' ').slice(0, 1_000)
}
