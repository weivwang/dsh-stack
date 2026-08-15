import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactPatch } from '../src/patch.js'
import { planStack } from '../src/plan.js'
import { makeStack, writeProfile } from './fixtures.js'

describe('apply planning', () => {
  it('separates installs, updates, matches, and built-in layers', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-plan-'))
    writeProfile({
      home,
      bundles: ['@deepseek-ai/dsh-base', 'dsh-alpha', 'dsh-same'],
      dependencies: { 'dsh-alpha': '1.0.0', 'dsh-same': '2.0.0' },
      installed: { 'dsh-alpha': '1.0.0', 'dsh-same': '2.0.0' },
    })
    const stack = makeStack({ bundles: [
      { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
      { name: 'dsh-alpha', sourceKind: 'registry', specifier: '1.2.0', installedVersion: '1.2.0' },
      { name: 'dsh-same', sourceKind: 'registry', specifier: '2.0.0', installedVersion: '2.0.0' },
      { name: 'dsh-new', sourceKind: 'registry', specifier: '3.0.0', installedVersion: '3.0.0' },
    ] })

    const plan = planStack(stack, { profile: 'web', dshHome: home })
    expect(plan.install.map(change => change.name)).toEqual(['dsh-new'])
    expect(plan.update.map(change => change.name)).toEqual(['dsh-alpha'])
    expect(plan.unchanged).toEqual(['dsh-same'])
    expect(plan.builtin).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('blocks local and mutable git sources by default', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-plan-'))
    const stack = makeStack({ bundles: [
      { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
      { name: 'dsh-local', sourceKind: 'local', specifier: 'link:../local' },
      { name: 'dsh-git', sourceKind: 'git', specifier: 'github:owner/repo#main' },
    ] })
    const plan = planStack(stack, { profile: 'new-profile', dshHome: home })
    expect(plan.errors).toHaveLength(2)
    expect(plan.errors.join('\n')).toMatch(/local path/)
    expect(plan.errors.join('\n')).toMatch(/mutable git ref/)
  })

  it('blocks mutable registry tags and ranges', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-plan-'))
    const stack = makeStack({ bundles: [
      { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
      { name: 'dsh-latest', sourceKind: 'registry', specifier: 'latest' },
    ] })
    expect(planStack(stack, { profile: 'new-profile', dshHome: home }).errors.join('\n'))
      .toMatch(/exact registry version/)
  })

  it('identifies a non-empty patch conflict before apply', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-stack-plan-'))
    writeProfile({ home, bundles: ['@deepseek-ai/dsh-base'], patch: '- id: local\n  disabled: true\n' })
    const portable = redactPatch('- id: shared\n  disabled: true\n', { dshHome: home })
    const plan = planStack(makeStack({ patch: portable }), { profile: 'web', dshHome: home })
    expect(plan.patch.action).toBe('replace')
    expect(plan.warnings.join('\n')).toMatch(/--replace-patch/)
  })
})
