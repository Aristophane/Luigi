import { build } from 'esbuild';

// Compile project modules once. Runtime packages remain normal Node dependencies;
// dynamic imports produce separate chunks for each job's implementation.
await build({
  entryPoints: ['src/worker.ts'],
  outdir: 'build/worker',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
  outExtension: { '.js': '.mjs' },
  tsconfig: 'tsconfig.json',
  plugins: [{
    name: 'worker-server-only',
    setup(plugin) {
      // This build only runs on the server; Next's browser import guard is unnecessary.
      plugin.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'empty' }));
      plugin.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
    },
  }],
});
