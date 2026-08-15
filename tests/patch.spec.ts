import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { hydratePatch, isEmptyPatch, redactPatch } from '../src/patch.js'
import { StackError } from '../src/errors.js'

describe('profile patch portability', () => {
  it('redacts keyed and literal secrets without evaluating !!js', () => {
    const apiKey = `sk-${'a'.repeat(24)}`
    const githubToken = `ghp_${'b'.repeat(32)}`
    const raw = `# leaked ${apiKey}
- id: provider
  config:
    apiKey: ${apiKey}
    nested:
      authToken: first-secret-value
      token: second-secret-value
    literal: ${githubToken}
    managed: !!js process.env.DEEPSEEK_API_KEY
    path: /Users/alice/.dsh/cache
`
    const patch = redactPatch(raw, { dshHome: '/Users/alice/.dsh', home: '/Users/alice' })
    const serialized = JSON.stringify(patch)

    expect(serialized).not.toContain(apiKey)
    expect(serialized).not.toContain('first-secret-value')
    expect(serialized).not.toContain('second-secret-value')
    expect(serialized).not.toContain(githubToken)
    expect(patch.content).toContain('!!js process.env.DEEPSEEK_API_KEY')
    expect(patch.content).toContain('{{DSH_HOME}}/cache')
    expect(patch.secrets.map(secret => secret.id)).toEqual(['API_KEY', 'AUTH_TOKEN', 'TOKEN', 'LITERAL'])
  })

  it('hydrates secrets and target home paths safely', () => {
    const patch = redactPatch(
      '- id: demo\n  config:\n    apiKey: original\n    path: /Users/alice/work\n',
      { dshHome: '/Users/alice/.dsh', home: '/Users/alice' },
    )
    const hydrated = hydratePatch(patch, {
      dshHome: '/srv/dsh',
      home: '/home/bob',
      env: { DSH_STACK_SECRET_API_KEY: 'quote"and\nnewline' },
    })
    expect(parse(hydrated)[0].config.apiKey).toBe('quote"and\nnewline')
    expect(hydrated).toContain('/home/bob/work')
    expect(hydrated).not.toContain('{{DSH_STACK_SECRET')
  })

  it('redacts nested values under a sensitive object and preserves declared placeholders', () => {
    const patch = redactPatch(
      '- id: demo\n  config:\n    clientSecret:\n      value: nested-secret\n    token: "{{DSH_STACK_SECRET:EXISTING}}"\n',
      { dshHome: '/Users/alice/.dsh', home: '/Users/alice' },
    )

    expect(patch.content).not.toContain('nested-secret')
    expect(patch.secrets.map(secret => secret.id)).toEqual(['CLIENT_SECRET', 'EXISTING'])
  })

  it('does not rewrite a longer path that merely shares the home prefix', () => {
    const patch = redactPatch(
      '- id: demo\n  config:\n    one: /Users/alice/work\n    two: /Users/alice-other/work\n',
      { dshHome: '/Users/alice/.dsh', home: '/Users/alice' },
    )

    expect(patch.content).toContain('{{HOME}}/work')
    expect(patch.content).toContain('/Users/alice-other/work')
  })

  it('fails before mutation when required secrets are missing', () => {
    const patch = redactPatch('- id: demo\n  config:\n    password: secret\n', { dshHome: '/tmp/dsh' })
    expect(() => hydratePatch(patch, { dshHome: '/tmp/other', env: {} }))
      .toThrowError(new StackError('MISSING_SECRETS', 'Set the required environment variable before applying: DSH_STACK_SECRET_PASSWORD'))
  })

  it('recognizes only an empty top-level patch list', () => {
    expect(isEmptyPatch('# comment\n[]\n')).toBe(true)
    expect(isEmptyPatch('- insert: []\n')).toBe(false)
  })
})
