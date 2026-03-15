import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@atlasmemory/core': path.resolve(__dirname, 'packages/core/src'),
      '@atlasmemory/store': path.resolve(__dirname, 'packages/store/src'),
      '@atlasmemory/indexer': path.resolve(__dirname, 'packages/indexer/src'),
      '@atlasmemory/retrieval': path.resolve(__dirname, 'packages/retrieval/src'),
      '@atlasmemory/summarizer': path.resolve(__dirname, 'packages/summarizer/src'),
      '@atlasmemory/taskpack': path.resolve(__dirname, 'packages/taskpack/src'),
      '@atlasmemory/intelligence': path.resolve(__dirname, 'packages/intelligence/src'),
    },
  },
  plugins: [
    {
      name: 'resolve-js-to-ts',
      resolveId(source, importer) {
        if (source.endsWith('.js') && importer && !source.includes('node_modules')) {
          const tsSource = source.replace(/\.js$/, '.ts');
          const dir = path.dirname(importer);
          const tsPath = path.resolve(dir, tsSource);
          if (fs.existsSync(tsPath)) {
            return tsPath;
          }
        }
      },
    },
  ],
  test: {
    include: ['packages/*/src/__tests__/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});
