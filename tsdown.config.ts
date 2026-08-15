import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    cli: 'src/cli.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22.19',
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
