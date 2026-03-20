import { Store } from '@atlasmemory/store';
import { Indexer } from '@atlasmemory/indexer';
import { CardGenerator, FlowGenerator } from '@atlasmemory/summarizer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

export function getGitHead(cwd: string): string | null {
    try {
        return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    } catch {
        return null;
    }
}

export function getGitChangedFiles(cwd: string, sinceHead: string): { added: string[]; modified: string[]; deleted: string[] } {
    try {
        const output = execSync(`git diff --name-status ${sinceHead} HEAD`, {
            cwd, encoding: 'utf-8', timeout: 10000, stdio: 'pipe', maxBuffer: 5 * 1024 * 1024,
        });
        const added: string[] = [];
        const modified: string[] = [];
        const deleted: string[] = [];
        for (const line of output.trim().split('\n')) {
            if (!line) continue;
            const [status, ...fileParts] = line.split('\t');
            const filePath = fileParts.join('\t');
            if (status === 'A') added.push(filePath);
            else if (status === 'M') modified.push(filePath);
            else if (status === 'D') deleted.push(filePath);
            else if (status?.startsWith('R')) {
                // Rename: delete old, add new
                const [oldPath, newPath] = fileParts;
                if (oldPath) deleted.push(oldPath);
                if (newPath) added.push(newPath);
            }
        }
        return { added, modified, deleted };
    } catch {
        return { added: [], modified: [], deleted: [] };
    }
}

const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.atlas', 'dist', 'build',
    'coverage', 'out', '.cache', '.turbo', '.gemini',
    'vendor', '.vendor', 'bower_components',            // PHP/Ruby/JS deps
    'public/build', 'public/assets', 'public/dist',    // Compiled frontend assets
    '.next', '.nuxt', '.svelte-kit', '.output',         // Framework build outputs
    '__pycache__', '.pytest_cache', 'venv', '.venv',    // Python
    'target', 'bin', 'obj',                              // Rust/C#/Java build outputs
]);

const EXCLUDED_PATTERNS = [/\.d\.ts$/, /\.map$/, /\.min\.[^./]+$/, /\.bundle\.[^./]+$/, /\.chunk\.[^./]+$/];
const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip generated/vendored/minified files
const MAX_LINE_LENGTH = 2000; // Lines > 2000 chars = likely minified, skip file
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
    /** Max files to index (0 = unlimited, default unlimited) */
    maxFiles?: number;
    /** Batch size for processing (default 100) */
    batchSize?: number;
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
    // Persist repo root for portable paths
    const normalizedRoot = rootDir.replace(/\\/g, '/');
    store.setRepoRoot(normalizedRoot);
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
    const maxFiles = opts?.maxFiles || 0;
    const batchSize = opts?.batchSize || 100;

    // Phase 1: Collect file paths (lightweight walk — no parsing, no reading)
    const filePaths: { abs: string; rel: string }[] = [];

    function collectFiles(dir: string): void {
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

                let realDir: string;
                try {
                    realDir = fs.realpathSync(fullPath);
                } catch {
                    continue;
                }
                if (visitedDirs.has(realDir)) continue;
                visitedDirs.add(realDir);

                const lower = fullPath.replace(/\\/g, '/').toLowerCase();
                if (lower.includes('/synth-') || lower.includes('/reports/')) continue;
                const relDir = path.relative(rootDir, fullPath);
                if (shouldIgnore(relDir, ignorePatterns)) continue;
                collectFiles(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) continue;
                if (EXCLUDED_PATTERNS.some(p => p.test(entry.name))) continue;

                if (ext === '.js' || ext === '.jsx') {
                    const tsCounterpart = ext === '.js'
                        ? fullPath.replace(/\.js$/, '.ts')
                        : fullPath.replace(/\.jsx$/, '.tsx');
                    if (fs.existsSync(tsCounterpart)) continue;
                }

                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > MAX_FILE_SIZE) {
                        skippedLarge++;
                        continue;
                    }
                } catch { continue; }

                const relPath = path.relative(rootDir, fullPath);
                if (shouldIgnore(relPath, ignorePatterns)) continue;

                const relPath2 = path.relative(rootDir, fullPath).replace(/\\/g, '/');
                filePaths.push({ abs: fullPath, rel: relPath2 });
                if (maxFiles > 0 && filePaths.length >= maxFiles) return;
            }
        }
    }

    collectFiles(rootDir);

    // Phase 2: Process files in batches (parse + index)
    for (let batchStart = 0; batchStart < filePaths.length; batchStart += batchSize) {
        const batch = filePaths.slice(batchStart, batchStart + batchSize);

        for (const { abs: fullPath, rel: relativePath } of batch) {
            let content: string;
            try {
                content = fs.readFileSync(fullPath, 'utf-8');
            } catch { skipped++; continue; }

            // Skip minified files: if any of the first 3 lines exceeds MAX_LINE_LENGTH
            const firstLines = content.slice(0, 10000).split('\n', 3);
            if (firstLines.some(line => line.length > MAX_LINE_LENGTH)) {
                skippedLarge++;
                continue;
            }

            const contentHash = crypto.createHash('sha256').update(content).digest('hex');

            if (incremental && existingHashes.get(relativePath) === contentHash) {
                skipped++;
                continue;
            }

            opts?.onFile?.(fullPath);

            const ext = path.extname(fullPath).toLowerCase();
            const langMap: Record<string, string> = {
                '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.jsx': 'js',
                '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.cs': 'cs',
                '.rb': 'rb', '.c': 'c', '.cpp': 'cpp', '.h': 'h', '.hpp': 'hpp', '.php': 'php',
            };
            const language = langMap[ext] || ext.slice(1);
            const loc = content.split('\n').length;

            const { symbols, anchors, imports, refs } = indexer.parse(fullPath, content);
            const fileId = store.addFile(relativePath, language, contentHash, loc, content);

            if (fileId) {
                for (const sym of symbols) { sym.fileId = fileId; store.addSymbol(sym); }
                for (const anchor of anchors) { anchor.fileId = fileId; store.upsertAnchor(anchor); }
                for (const imp of imports) { imp.fileId = fileId; store.addImport(imp); }
                for (const ref of refs) { store.addRef(ref); }

                const flowCards = flowGenerator.rebuildAndStoreForFile(fileId);
                const fileCard = await generator.generateFileCard(
                    fileId, relativePath, symbols, content, anchors, flowCards
                );
                store.addFileCard(fileCard);

                fileCount++;
                symbolCount += symbols.length;
            }
        }

        // GC hint between batches for large repos
        if (batchStart + batchSize < filePaths.length) {
            (global as any).gc?.();
        }
    }
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

export async function incrementalReindex(
    store: Store,
    rootDir: string,
    changedFiles: { added: string[]; modified: string[]; deleted: string[] },
    opts?: AutoIndexOptions,
): Promise<{ files: number; symbols: number; deleted: number }> {
    // Normalize drive letter casing on Windows
    if (process.platform === 'win32' && /^[a-z]:/.test(rootDir)) {
        rootDir = rootDir[0].toUpperCase() + rootDir.slice(1);
    }

    const indexer = new Indexer();
    const generator = new CardGenerator();
    const flowGenerator = new FlowGenerator(store);
    let fileCount = 0;
    let symbolCount = 0;
    let deletedCount = 0;

    // Delete removed files from DB (git outputs relative paths, DB now stores relative)
    for (const relPath of changedFiles.deleted) {
        const normalizedRel = relPath.replace(/\\/g, '/');
        const fileId = store.getFileId(normalizedRel);
        if (fileId) {
            store.deleteFile(fileId);
            deletedCount++;
        }
    }

    // Re-index added and modified files
    const toProcess = [...new Set([...changedFiles.added, ...changedFiles.modified])];
    for (const relPath of toProcess) {
        const absPath = path.resolve(rootDir, relPath);
        const ext = path.extname(absPath).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        if (EXCLUDED_PATTERNS.some(p => p.test(path.basename(absPath)))) continue;

        try {
            const stat = fs.statSync(absPath);
            if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }

        let content: string;
        try { content = fs.readFileSync(absPath, 'utf-8'); } catch { continue; }

        // Skip minified files
        const firstLines = content.slice(0, 10000).split('\n', 3);
        if (firstLines.some(line => line.length > MAX_LINE_LENGTH)) continue;

        const contentHash = crypto.createHash('sha256').update(content).digest('hex');
        const langMap: Record<string, string> = {
            '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.jsx': 'js',
            '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.cs': 'cs',
            '.rb': 'rb', '.c': 'c', '.cpp': 'cpp', '.h': 'h', '.hpp': 'hpp', '.php': 'php',
        };
        const language = langMap[ext] || ext.slice(1);
        const loc = content.split('\n').length;

        opts?.onFile?.(absPath);

        const relativePath = relPath.replace(/\\/g, '/');
        const { symbols, anchors, imports, refs } = indexer.parse(absPath, content);
        const fileId = store.addFile(relativePath, language, contentHash, loc, content);

        if (fileId) {
            for (const sym of symbols) { sym.fileId = fileId; store.addSymbol(sym); }
            for (const anchor of anchors) { anchor.fileId = fileId; store.upsertAnchor(anchor); }
            for (const imp of imports) { imp.fileId = fileId; store.addImport(imp); }
            for (const ref of refs) { store.addRef(ref); }

            const flowCards = flowGenerator.rebuildAndStoreForFile(fileId);
            const fileCard = await generator.generateFileCard(
                fileId, relativePath, symbols, content, anchors, flowCards
            );
            store.addFileCard(fileCard);

            fileCount++;
            symbolCount += symbols.length;
        }
    }

    store.setState('last_index_at', new Date().toISOString());
    return { files: fileCount, symbols: symbolCount, deleted: deletedCount };
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
