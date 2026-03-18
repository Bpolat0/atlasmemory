import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../store.js';
import { SearchService } from '@atlasmemory/retrieval';
import crypto from 'crypto';

function uid() { return crypto.randomUUID(); }
function hash(s: string) { return crypto.createHash('sha256').update(s).digest('hex'); }

describe('Edge Cases', () => {
    let store: Store;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
    });

    // ── 1. Empty repo ──────────────────────────────────────────────

    it('should return empty arrays for a store with no files', () => {
        const files = store.getFiles();
        expect(files).toHaveLength(0);

        const search = new SearchService(store);
        const results = search.search('anything', 10);
        expect(results).toHaveLength(0);
    });

    it('should handle search on empty store without throwing', () => {
        const results = store.scoredSearch('test query', 10);
        expect(results).toHaveLength(0);

        const pathResults = store.searchFiles('src');
        expect(pathResults).toHaveLength(0);
    });

    // ── 2. Single file ─────────────────────────────────────────────

    it('should work with a minimal single-file index', () => {
        const fileId = store.addFile('src/index.ts', 'typescript', hash('content'), 10, 'const x = 1;');
        const symId = uid();
        store.addSymbol({
            id: symId, fileId, name: 'x',
            qualifiedName: 'x', kind: 'const',
            signature: 'const x', startLine: 1, endLine: 1,
            visibility: 'public', signatureHash: hash('const x'),
        });
        store.upsertAnchor({
            id: uid(), fileId, startLine: 1, endLine: 1,
            snippetHash: hash('const x = 1;'),
        });

        expect(store.getFiles()).toHaveLength(1);
        expect(store.getSymbolsForFile(fileId)).toHaveLength(1);
        expect(store.getAnchorsForFile(fileId)).toHaveLength(1);
        expect(store.getFileById(fileId)).toBeDefined();
        expect(store.getFileById(fileId)!.path).toBe('src/index.ts');
    });

    // ── 3. Large symbol count ──────────────────────────────────────

    it('should handle a file with 50+ symbols without issues', () => {
        const fileId = store.addFile('src/huge-module.ts', 'typescript', hash('huge'), 2000, '');
        const symbolCount = 60;

        for (let i = 0; i < symbolCount; i++) {
            const name = `helperFunction${i}`;
            store.addSymbol({
                id: uid(), fileId, name,
                qualifiedName: name, kind: 'function',
                signature: `function ${name}()`,
                startLine: i * 30 + 1, endLine: i * 30 + 25,
                visibility: 'public',
                signatureHash: hash(`function ${name}()`),
            });
        }

        const symbols = store.getSymbolsForFile(fileId);
        expect(symbols).toHaveLength(symbolCount);

        // Verify retrieval by file id still works correctly
        const file = store.getFileById(fileId);
        expect(file).toBeDefined();
        expect(file!.path).toBe('src/huge-module.ts');
    });

    // ── 4. Broken UTF-8 / binary content ───────────────────────────

    it('should store and retrieve files with non-UTF8 / binary-like content', () => {
        const binaryLike = 'ELF\x00\x01\x02\xFF\xFE\x00binary\x80\x81content';
        const fileId = store.addFile('lib/data.bin', 'unknown', hash(binaryLike), 1, binaryLike);

        expect(fileId).toBeDefined();
        const file = store.getFileById(fileId);
        expect(file).toBeDefined();
        expect(file!.path).toBe('lib/data.bin');
    });

    it('should handle emoji and multi-byte unicode in file content', () => {
        const content = 'const greeting = "Merhaba Dünya! 🌍🚀";\nconst jp = "日本語テスト";';
        const fileId = store.addFile('src/i18n.ts', 'typescript', hash(content), 2, content);

        const symId = uid();
        store.addSymbol({
            id: symId, fileId, name: 'greeting',
            qualifiedName: 'greeting', kind: 'const',
            signature: 'const greeting', startLine: 1, endLine: 1,
            visibility: 'public', signatureHash: hash('const greeting'),
        });

        const symbols = store.getSymbolsForFile(fileId);
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe('greeting');
    });

    // ── 5. Duplicate file paths ────────────────────────────────────

    it('should upsert (not duplicate) when adding same path twice', () => {
        const id1 = store.addFile('src/app.ts', 'typescript', hash('v1'), 50, 'v1');
        const id2 = store.addFile('src/app.ts', 'typescript', hash('v2'), 80, 'v2');

        // Should reuse same ID (upsert)
        expect(id2).toBe(id1);

        // Only one file in store
        const files = store.getFiles();
        expect(files).toHaveLength(1);

        // Updated fields should reflect latest values
        const file = store.getFileById(id1);
        expect(file!.contentHash).toBe(hash('v2'));
    });

    it('should preserve symbols when file is upserted', () => {
        const fileId = store.addFile('src/app.ts', 'typescript', hash('v1'), 50, '');
        store.addSymbol({
            id: uid(), fileId, name: 'originalFn',
            qualifiedName: 'originalFn', kind: 'function',
            signature: 'function originalFn()',
            startLine: 1, endLine: 10, visibility: 'public',
            signatureHash: hash('function originalFn()'),
        });

        // Re-add same file (upsert)
        const fileId2 = store.addFile('src/app.ts', 'typescript', hash('v2'), 60, '');
        expect(fileId2).toBe(fileId);

        // Original symbols should still be associated
        const symbols = store.getSymbolsForFile(fileId);
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe('originalFn');
    });

    // ── 6. Empty file content ──────────────────────────────────────

    it('should handle a file with zero LOC and empty content', () => {
        const fileId = store.addFile('src/empty.ts', 'typescript', hash(''), 0, '');

        expect(fileId).toBeDefined();
        const file = store.getFileById(fileId);
        expect(file).toBeDefined();
        expect(file!.path).toBe('src/empty.ts');

        // Symbols and anchors should be empty but not error
        expect(store.getSymbolsForFile(fileId)).toHaveLength(0);
        expect(store.getAnchorsForFile(fileId)).toHaveLength(0);
    });

    // ── 7. Very long file paths ────────────────────────────────────

    it('should handle paths longer than 256 characters', () => {
        // Build a path with deeply nested directories
        const segments = Array.from({ length: 30 }, (_, i) => `deeply_nested_dir_${i}`);
        const longPath = segments.join('/') + '/extremely_long_filename_that_pushes_total_length_beyond_256_chars.ts';
        expect(longPath.length).toBeGreaterThan(256);

        const fileId = store.addFile(longPath, 'typescript', hash(longPath), 10, '');

        expect(fileId).toBeDefined();
        const file = store.getFileById(fileId);
        expect(file).toBeDefined();
        expect(file!.path).toBe(longPath);

        // Should be findable by getFileId
        const retrieved = store.getFileId(longPath);
        expect(retrieved).toBe(fileId);
    });

    // ── 8. Special characters in symbol names ──────────────────────

    it('should handle unicode and special characters in symbol names', () => {
        const fileId = store.addFile('src/special.ts', 'typescript', hash('special'), 50, '');

        const specialNames = [
            { name: 'café_au_lait', kind: 'function' as const },
            { name: 'über_handler', kind: 'function' as const },
            { name: 'データ処理', kind: 'function' as const },
            { name: '$_price_calc', kind: 'function' as const },
            { name: '__dunder__', kind: 'function' as const },
        ];

        for (const s of specialNames) {
            store.addSymbol({
                id: uid(), fileId, name: s.name,
                qualifiedName: s.name, kind: s.kind,
                signature: `function ${s.name}()`,
                startLine: 1, endLine: 10, visibility: 'public',
                signatureHash: hash(`function ${s.name}()`),
            });
        }

        const symbols = store.getSymbolsForFile(fileId);
        expect(symbols).toHaveLength(specialNames.length);

        const names = symbols.map((s: any) => s.name);
        for (const s of specialNames) {
            expect(names).toContain(s.name);
        }
    });

    it('should handle symbol names with spaces and punctuation', () => {
        const fileId = store.addFile('src/weird.ts', 'typescript', hash('weird'), 20, '');

        // Some parsers may produce symbol names with unusual characters
        const name = 'operator==';
        store.addSymbol({
            id: uid(), fileId, name,
            qualifiedName: name, kind: 'method',
            signature: `method ${name}()`,
            startLine: 1, endLine: 5, visibility: 'public',
            signatureHash: hash(`method ${name}()`),
        });

        const symbols = store.getSymbolsForFile(fileId);
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe(name);
    });

    // ── Bonus: getFileId for non-existent path ─────────────────────

    it('should return undefined for getFileId with non-existent path', () => {
        const result = store.getFileId('this/path/does/not/exist.ts');
        expect(result).toBeUndefined();
    });
});
