/**
 * Build config for dsh-remote-ide (host-only edition): ESM node bundles for
 * the plugin entry (index), the remote-tools subpath (consumed by the
 * `remote` agent preset), and the remote capability services
 * (ssh-service / fs-ssh / subprocess-ssh — mounted by the preset composition,
 * never globally, so ctx.fs / ctx.subprocess stay local in ordinary sessions).
 * The `./invariant` companion entry went away with dsh 0.2.0-rc.2's removal
 * of the runtime-invariant registry (@deepseek-ai/dsh-invariants).
 * SDK peers resolve from the dsh profile at runtime, never bundled.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-remote-ide/host',
  entry: {
    index: './src/index.ts',
    tools: './src/tools.ts',
    'ssh-service': './src/ssh-service.ts',
    'job-runner': './src/job-runner.ts',
    'fs-ssh': './src/fs-ssh.ts',
    'subprocess-ssh': './src/subprocess-ssh.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  // tsc emits lib/types (declarations) first; tsdown must not wipe them
  // (the build script owns a full lib/ cleanup before tsc runs).
  clean: false,
  outExtensions: () => ({ js: '.js' }),
  // Resolved from the dsh profile tree at runtime, never bundled.
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-fs-patch',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-typert-protocol',
    '@deepseek-ai/dsh-workspace',
    '@deepseek-ai/dsh-jobs',
  ],
})
