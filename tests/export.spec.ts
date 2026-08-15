import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportStack, formatStackJson, stackShareability } from '../src/export.js'
import { parseStackJson } from '../src/validation.js'
import { writeProfile } from './fixtures.js'

describe('profile export', () => {
  it('pins registry packages, marks local sources, and leaks no secret', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-export-'))
    writeProfile({
      home,
      bundles: ['@deepseek-ai/dsh-base', 'dsh-alpha', 'dsh-local'],
      dependencies: { 'dsh-alpha': '^1.0.0', 'dsh-local': 'link:../../local' },
      installed: { 'dsh-alpha': '1.4.2', 'dsh-local': '0.3.0' },
      patch: '- id: alpha\n  config:\n    apiKey: top-secret-value\n',
    })
    const stack = exportStack({
      profile: 'web',
      dshHome: home,
      harnessVersion: '0.1.0-rc.6',
      now: new Date('2026-08-15T00:00:00.000Z'),
    })

    expect(stack.bundles).toEqual([
      { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
      { name: 'dsh-alpha', specifier: '1.4.2', installedVersion: '1.4.2', sourceKind: 'registry' },
      { name: 'dsh-local', specifier: 'link:../../local', installedVersion: '0.3.0', sourceKind: 'local' },
    ])
    expect(formatStackJson(stack)).not.toContain('top-secret-value')
    expect(stack.warnings).toContain('dsh-local uses a machine-local dependency and cannot be applied elsewhere automatically.')
    expect(stackShareability(stack)).toEqual({ score: 70, label: 'good' })
    expect(parseStackJson(formatStackJson(stack))).toEqual(stack)
  })
})
