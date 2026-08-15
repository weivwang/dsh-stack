import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { exportStack, formatStackJson, stackShareability } from './export.js'

/** Cordis plugin name shown by Harness diagnostics. */
export const name = 'dsh-stack'

/** Harness services required by the model-facing inspector. */
export const inject = ['tools']

/** Register the secret-safe profile inspection tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'stack_inspect',
    description:
      'Inspect an installed DeepSeek Harness profile as a secret-redacted portable Stackfile. '
      + 'Use summary for a compact portability report or stack when the user wants the complete JSON saved or shared.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Harness profile name, such as web or headless.' },
      detail: {
        type: 'string',
        enum: ['summary', 'stack'],
        description: 'summary returns a compact report; stack returns the complete integrity-sealed JSON.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const stack = exportStack({ profile: args.profile })
      if (args.detail === 'stack') return formatStackJson(stack)
      const shareability = stackShareability(stack)
      const external = stack.bundles.filter(bundle => bundle.sourceKind !== 'builtin')
      const lines = [
        `Stack: ${stack.name}`,
        `Source profile: ${stack.source.profile}`,
        `Harness: ${stack.source.harnessVersion ?? 'unknown'}`,
        `Bundles: ${stack.bundles.length} total, ${external.length} external`,
        `Shareability: ${shareability.score}/100 (${shareability.label})`,
        `Patch secrets: ${stack.profilePatch?.secrets.length ?? 0} redacted`,
      ]
      if (stack.warnings.length > 0) {
        lines.push('Warnings:', ...stack.warnings.map(warning => `- ${warning}`))
      }
      lines.push('Use detail="stack" to return the complete Stackfile JSON.')
      return lines.join('\n')
    },
  }))
}

export * from './core.js'
