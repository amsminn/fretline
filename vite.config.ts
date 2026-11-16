import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { alphaTab } from '@coderline/alphatab-vite';

export default defineConfig(({ mode }) => {
  if (mode === 'main') {
    return {
      publicDir: false,
      build: {
        outDir: 'out/main',
        target: 'node24',
        lib: {
          entry: resolve('src/main/index.ts'),
          formats: ['es'],
          fileName: () => 'index.js',
        },
        rollupOptions: {
          external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
        },
      },
    };
  }
  if (mode === 'preload') return {
    publicDir: false,
    build: {
      outDir: 'out/preload',
      target: 'node24',
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          export: resolve('src/preload/export.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)],
      },
    },
  };
  return {
    root: 'src/renderer',
    base: 'app://fretline/',
    // alphaTab 1.9 detects Vite through this legacy build marker.
    define: { __BASE__: JSON.stringify('app://fretline/') },
    publicDir: resolve('out/local-assets'),
    plugins: [react(), tailwindcss(), alphaTab()],
    worker: {
      format: 'es',
      // App workers parse/project scores; only the renderer creates alphaTab workers/worklets.
      plugins: () => [alphaTab({ webWorkers: false, audioWorklets: false })],
    },
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      target: 'chrome144',
      rollupOptions: {
        input: {
          main: resolve('src/renderer/index.html'),
          export: resolve('src/renderer/export.html'),
        },
      },
    },
  };
});
