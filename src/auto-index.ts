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
const MAX_FILE_SIZE = 1024 * 1024; // 1MB — skip generated/vendored files
const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py',           // TS/JS/Python
    '.go', '.rs', '.java', '.cs',                   // Go/Rust/Java/C#
    '.rb', '.c', '.cpp', '.h', '.hpp',              // Ruby/C/C++
    '.php',                                          // PHP
]);

function loadIgnorePatterns(rootDir: string): Set<string> {
    const ignorePath = path.join(rootDir, '.atlasignore');
    const patterns = new Set<string>();
    if (fs.existsSync(ignorePath)) {
        let content: string;
        try { content = fs.readFileSync(ignorePath, 'utf-8'); } catch { return patterns; }
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                patterns.add(trimmed);
            }
        }
    }
    return patterns;
}

function shouldIgnore(relPath: string, ignorePatterns: Set<string>): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    for (const pattern of ignorePatterns) {
        if (normalized.startsWith(pattern + '/') || normalized === pattern) return true;
        if (pattern.startsWith('*') && normalized.endsWith(pattern.slice(1))) return true;
    }
    return false;
}

export interface AutoIndexOptions {
    onFile?: (path: string) => void;
    incremental?: boolean;
}

export async function autoIndex(
    store: Store,
    rootDir: string,
    opts?: AutoIndexOptions
): Promise<{ files: number; symbols: number; skipped: number; skippedLarge: number }> {
    // Normalize drive letter casing on Windows to prevent duplicate entries
    // e.g., "c:\Dev" vs "C:\Dev" would create separate file entries
    if (process.platform === 'win32' && /^[a-z]:/.test(rootDir)) {
        rootDir = rootDir[0].toUpperCase() + rootDir.slice(1);
    }

    const indexer = new Indexer();
    const generator = new CardGenerator();
    const flowGenerator = new FlowGenerator(store);
    const ignorePatterns = loadIgnorePatterns(rootDir);
    let fileCount = 0;
    let symbolCount = 0;
    let skipped = 0;

    // Build hash map for incremental indexing
    const incremental = opts?.incremental !== false;
    const existingHashes = new Map<string, string>();
    if (incremental) {
        for (const file of store.getFiles()) {
            existingHashes.set(file.path, file.contentHash);
        }
    }

    // Track visited real paths to prevent symlink cycles
    const visitedDirs = new Set<string>();
    let skippedLarge = 0;

    async function walk(dir: string) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e: any) {
            process.stderr.write(`[atlasmemory] Warning: cannot read directory ${dir}: ${e.code || e.message}\n`);
            return;
        }

        for (const entry of entries) {
            const fullPath = path.resolve(dir, entry.name);

            if (entry.isDirectory()) {
                if (EXCLUDED_DIRS.has(entry.name)) continue;

                // Symlink cycle protection: resolve real path and skip if already visited
                let realDir: string;
                try {
                    realDir = fs.realpathSync(fullPath);
                } catch {
                    continue; // Broken symlink — skip
                }
                if (visitedDirs.has(realDir)) continue;
                visitedDirs.add(realDir);

                const lower = fullPath.replace(/\\/g, '/').toLowerCase();
                if (lower.includes('/synth-') || lower.includes('/reports/')) continue;
                const relDir = path.relative(rootDir, fullPath);
                if (shouldIgnore(relDir, ignorePatterns)) continue;
                await walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) continue;
                if (EXCLUDED_PATTERNS.some(p => p.test(entry.name))) continue;

                // Skip .js/.jsx files when a .ts/.tsx counterpart exists (compiled output)
                if (ext === '.js' || ext === '.jsx') {
                    const tsCounterpart = ext === '.js'
                        ? fullPath.replace(/\.js$/, '.ts')
                        : fullPath.replace(/\.jsx$/, '.tsx');
                    if (fs.existsSync(tsCounterpart)) continue;
                }

                // Skip files larger than 1MB (likely generated/vendored)
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_FILE_SIZE) {
                        skippedLarge++;
                        continue;
                    }
                } catch { continue; }

                const relPath = path.relative(rootDir, fullPath);
                if (shouldIgnore(relPath, ignorePatterns)) continue;

                let content: string;
                try {
                    content = fs.readFileSync(fullPath, 'utf-8');
                } catch { skipped++; continue; }
                const contentHash = crypto.createHash('sha256').update(content).digest('hex');

                // Skip unchanged files in incremental mode
                if (incremental && existingHashes.get(fullPath) === contentHash) {
                    skipped++;
                    continue;
                }

                opts?.onFile?.(fullPath);

                const langMap: Record<string, string> = {
                    '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.jsx': 'js',
                    '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.cs': 'cs',
                    '.rb': 'rb', '.c': 'c', '.cpp': 'cpp', '.h': 'h', '.hpp': 'hpp', '.php': 'php',
                };
                const language = langMap[ext] || ext.slice(1);
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

    // Warn about files with no parser available
    const langStatus = indexer.getLanguageStatus();
    if (langStatus.missing.length > 0 && fileCount > 0) {
        const missingWithFiles = langStatus.missing.filter(ext =>
            store.getFiles().some(f => f.language === ext && store.getSymbolsForFile(f.id).length === 0)
        );
        if (missingWithFiles.length > 0) {
            process.stderr.write(`[atlasmemory] Warning: parsers not available for: ${missingWithFiles.join(', ')}. Files indexed but symbols not extracted.\n`);
        }
    }

    return { files: fileCount, symbols: symbolCount, skipped, skippedLarge };
}

export function isDbEmpty(store: Store): boolean {
    return store.getFiles().length === 0;
}

export function detectProjectRoot(cwd: string): string {
    let dir = path.resolve(cwd);
    // Normalize drive letter casing on Windows
    if (process.platform === 'win32' && /^[a-z]:/.test(dir)) {
        dir = dir[0].toUpperCase() + dir.slice(1);
    }
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git')) ||
            fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return cwd;
}
