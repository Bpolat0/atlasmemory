import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../store.js';
import crypto from 'crypto';

describe('Store CRUD', () => {
    let store: Store;

    beforeEach(() => {
        store = new Store(':memory:');
    });

    it('should add and retrieve a file', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'abcd1234', 100, '');
        const files = store.getFiles();
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('src/main.ts');
        expect(files[0].id).toBe(fileId);
    });

    it('should get file by id', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'abcd1234', 100, '');
        const file = store.getFileById(fileId);
        expect(file).toBeDefined();
        expect(file!.path).toBe('src/main.ts');
    });

    it('should get file id by path', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'abcd1234', 100, '');
        const id = store.getFileId('src/main.ts');
        expect(id).toBe(fileId);
    });

    it('should return undefined for non-existent file', () => {
        const file = store.getFileById('nonexistent');
        expect(file).toBeUndefined();
    });

    it('should add and retrieve symbols', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'h1', 100, '');
        store.addSymbol({
            id: crypto.randomUUID(), fileId, name: 'MyClass',
            qualifiedName: 'MyClass', kind: 'class', signature: 'class MyClass',
            startLine: 1, endLine: 10, visibility: 'public',
            signatureHash: crypto.createHash('sha256').update('class MyClass').digest('hex'),
        });
        const symbols = store.getSymbolsForFile(fileId);
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe('MyClass');
    });

    it('should add and retrieve imports', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'h1', 100, '');
        store.addImport({
            id: crypto.randomUUID(), fileId,
            importedModule: 'commander', importedSymbol: 'Command',
            isExternal: true,
        });
        const imports = store.getImportsForFile(fileId);
        expect(imports).toHaveLength(1);
        expect(imports[0].importedModule).toBe('commander');
    });

    it('should upsert and retrieve anchors', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'h1', 100, '');
        store.upsertAnchor({
            id: crypto.randomUUID(), fileId,
            startLine: 5, endLine: 15, snippetHash: 'hash123',
        });
        const anchors = store.getAnchorsForFile(fileId);
        expect(anchors).toHaveLength(1);
        expect(anchors[0].startLine).toBe(5);
    });

    it('should add and retrieve file cards', () => {
        const fileId = store.addFile('src/main.ts', 'typescript', 'h1', 100, '');
        store.addFileCard({
            fileId, path: 'src/main.ts', cardHash: 'ch1',
            level0: { purpose: 'Main entry point', exports: ['main'], sideEffects: [] },
        });
        const card = store.getFileCard(fileId);
        expect(card).toBeDefined();
        expect(card!.level0.purpose).toBe('Main entry point');
    });

    it('should store and retrieve repo root', () => {
        store.setRepoRoot('/home/user/project');
        expect(store.getRepoRoot()).toBe('/home/user/project');
    });

    it('should close cleanly', () => {
        store.addFile('src/main.ts', 'typescript', 'h1', 100, '');
        store.close();
        // Accessing after close should throw
        expect(() => store.getFiles()).toThrow();
    });
});
