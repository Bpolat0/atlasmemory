import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

// Resolve @atlasmemory/* imports directly to TS source files
const atlasResolvePlugin = {
    name: 'atlas-resolve',
    setup(build) {
        build.onResolve({ filter: /^@atlasmemory\// }, (args) => {
            const pkg = args.path.replace('@atlasmemory/', '');
            return { path: path.resolve(`packages/${pkg}/src/index.ts`) };
        });
        build.onResolve({ filter: /\.js$/ }, (args) => {
            if (args.importer && !args.path.includes('node_modules')) {
                const tsPath = path.resolve(path.dirname(args.importer), args.path.replace(/\.js$/, '.ts'));
                if (fs.existsSync(tsPath)) {
                    return { path: tsPath };
                }
            }
            return undefined;
        });
    },
};

if (!fs.existsSync('dist')) fs.mkdirSync('dist');

const result = await esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: 'dist/atlasmemory.js',
    plugins: [atlasResolvePlugin],
    external: [
        // Native modules
        'better-sqlite3',
        'tree-sitter',
        'tree-sitter-typescript',
        'tree-sitter-javascript',
        'tree-sitter-python',
        // CJS dependencies
        'commander',
        // MCP SDK
        '@modelcontextprotocol/sdk',
        '@modelcontextprotocol/sdk/*',
    ],
    sourcemap: true,
    minify: false,
    metafile: true,
});

// Prepend shebang to output
const content = fs.readFileSync('dist/atlasmemory.js', 'utf-8');
fs.writeFileSync('dist/atlasmemory.js', '#!/usr/bin/env node\n' + content);

const outSize = fs.statSync('dist/atlasmemory.js').size;
console.log(`Build complete: dist/atlasmemory.js (${(outSize / 1024).toFixed(1)} KB)`);
fs.writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
