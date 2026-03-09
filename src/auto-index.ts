import { Store } from '@atlasmemory/store';
import { Indexer } from '@atlasmemory/indexer';
import { CardGenerator, FlowGenerator } from '@atlasmemory/summarizer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.atlas', 'dist', 'build',
    'coverage', 'out', '.cache', '.turbo', '.gemini',
]);

const EXCLUDED_PATTERNS = [/\.d\.ts$/, /\.map$/, /\.min\.[^./]+$/];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

export async function autoIndex(
    store: Store,
    rootDir: string,
    opts?: { onFile?: (path: string) => void }
): Promise<{ files: number; symbols: number }> {
    const indexer = new Indexer();
    const generator = new CardGenerator();
    const flowGenerator = new FlowGenerator(store);
    let fileCount = 0;
    let symbolCount = 0;

    async function walk(dir: string) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.resolve(dir, entry.name);

            if (entry.isDirectory()) {
                if (EXCLUDED_DIRS.has(entry.name)) continue;
                const lower = fullPath.replace(/\\/g, '/').toLowerCase();
                if (lower.includes('/synth-') || lower.includes('/reports/')) continue;
                await walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) continue;
                if (EXCLUDED_PATTERNS.some(p => p.test(entry.name))) continue;

                opts?.onFile?.(fullPath);

                const content = fs.readFileSync(fullPath, 'utf-8');
                const contentHash = crypto.createHash('sha256').update(content).digest('hex');
                const language = ext.startsWith('.ts') ? 'ts' : ext.startsWith('.js') ? 'js' : 'py';
                const loc = content.split('\n').length;

                const { symbols, anchors, imports, refs } = indexer.parse(fullPath, content);
                const fileId = store.addFile(fullPath, language, contentHash, loc, content);

                if (fileId) {
                    for (const sym of symbols) { sym.fileId = fileId; store.addSymbol(sym); }
                    for (const anchor of anchors) { anchor.fileId = fileId; store.upsertAnchor(anchor); }
                    for (const imp of imports) { imp.fileId = fileId; store.addImport(imp); }
                    for (const ref of refs) { store.addRef(ref); }

                    const flowCards = flowGenerator.rebuildAndStoreForFile(fileId);
                    const fileCard = await generator.generateFileCard(
                        fileId, fullPath, symbols, content, anchors, flowCards
                    );
                    store.addFileCard(fileCard);

                    fileCount++;
                    symbolCount += symbols.length;
                }
            }
        }
    }

    await walk(rootDir);
    store.setState('last_index_at', new Date().toISOString());
    return { files: fileCount, symbols: symbolCount };
}

export function isDbEmpty(store: Store): boolean {
    return store.getFiles().length === 0;
}

export function detectProjectRoot(cwd: string): string {
    let dir = path.resolve(cwd);
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git')) ||
            fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return cwd;
}
