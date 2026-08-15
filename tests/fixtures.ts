import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sealStack } from '../src/validation.js'
import { STACK_FORMAT, STACK_FORMAT_VERSION, type DshStack, type StackBundle } from '../src/types.js'

export function writeProfile(options: {
  home: string
  name?: string
  bundles: string[]
  dependencies?: Record<string, string>
  installed?: Record<string, string>
  patch?: string
}): string {
  const name = options.name ?? 'web'
  const dir = join(options.home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: { profile: { bundles: options.bundles } },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), options.patch ?? '[]\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  for (const [packageName, version] of Object.entries(options.installed ?? {})) {
    const packageDir = join(dir, 'node_modules', packageName)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ name: packageName, version })}\n`)
  }
  return dir
}

export function makeStack(options: {
  bundles?: StackBundle[]
  patch?: DshStack['profilePatch']
  warnings?: string[]
} = {}): DshStack {
  return sealStack({
    format: STACK_FORMAT,
    formatVersion: STACK_FORMAT_VERSION,
    name: 'Test Stack',
    createdAt: '2026-08-15T00:00:00.000Z',
    source: { profile: 'web' },
    bundles: options.bundles ?? [{ name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' }],
    ...(options.patch === undefined ? {} : { profilePatch: options.patch }),
    warnings: options.warnings ?? [],
  })
}
