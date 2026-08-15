import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyStack, type ApplyRuntime } from '../src/apply.js'
import { redactPatch } from '../src/patch.js'
import { makeStack, writeProfile } from './fixtures.js'

describe('transactional apply', () => {
  it('installs, orders, hydrates, verifies, and retains a backup', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-apply-'))
    const profileDir = writeProfile({ home, bundles: ['@deepseek-ai/dsh-base'] })
    const patch = redactPatch('- id: alpha\n  config:\n    apiKey: source-secret\n', { dshHome: '/source/.dsh' })
    const stack = makeStack({
      bundles: [
        { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
        { name: 'dsh-alpha', sourceKind: 'registry', specifier: '1.2.3', installedVersion: '1.2.3' },
      ],
      patch,
    })
    const result = applyStack(stack, {
      profile: 'web',
      dshHome: home,
      yes: true,
      env: { DSH_STACK_SECRET_API_KEY: 'target-secret' },
      now: new Date('2026-08-15T00:00:00.000Z'),
    }, installRuntime(profileDir, false))

    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-alpha'])
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('target-secret')
    expect(result.changedBundles).toEqual(['dsh-alpha'])
    expect(readFileSync(join(result.backupDir, 'package.json'), 'utf8')).toContain('dsh-profile-web')
  })

  it('restores profile files when verification fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-apply-'))
    const profileDir = writeProfile({ home, bundles: ['@deepseek-ai/dsh-base'] })
    const beforeManifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const beforePatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const stack = makeStack({ bundles: [
      { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
      { name: 'dsh-alpha', sourceKind: 'registry', specifier: '1.2.3', installedVersion: '1.2.3' },
    ] })

    expect(() => applyStack(stack, {
      profile: 'web',
      dshHome: home,
      yes: true,
      now: new Date('2026-08-15T00:00:00.000Z'),
    }, installRuntime(profileDir, true))).toThrow(/verify composed profile/)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(beforeManifest)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(beforePatch)
  })
})

function installRuntime(profileDir: string, failVerification: boolean): ApplyRuntime {
  return {
    run(_binary, args) {
      if (args.includes('add')) {
        const manifestPath = join(profileDir, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          dependencies: Record<string, string>
          dsh: { profile: { bundles: string[] } }
        }
        manifest.dependencies['dsh-alpha'] = '1.2.3'
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        const packageDir = join(profileDir, 'node_modules', 'dsh-alpha')
        mkdirSync(packageDir, { recursive: true })
        writeFileSync(join(packageDir, 'package.json'), '{"name":"dsh-alpha","version":"1.2.3"}\n')
        return { status: 0, stdout: '', stderr: '' }
      }
      if (args.includes('--dump-config')) {
        return failVerification
          ? { status: 1, stdout: '', stderr: 'invalid composition' }
          : { status: 0, stdout: '# composed\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  }
}
