import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { TaskPackBuilder } from '../builder.js';
import crypto from 'crypto';

/** Seed store with N test files that have cards and symbols */
function seedStore(store: Store, count: number = 5) {
    store.setRepoRoot(process.cwd());
    const fileIds: string[] = [];
    for (let i = 1; i <= count; i++) {
        const filePath = `src/module${i}.ts`;
        const fileId = store.addFile(filePath, 'typescript', `hash${i}`, 50, `function func${i}() {}`);
        fileIds.push(fileId);

        store.addSymbol({
            id: crypto.randomUUID(), fileId, name: `func${i}`,
            qualifiedName: `func${i}`, kind: 'function',
            signature: `function func${i}()`,
            startLine: 1, endLine: 10, visibility: 'public',
            signatureHash: crypto.createHash('sha256').update(`func${i}`).digest('hex'),
        });

        store.addFileCard({
            fileId, path: filePath, cardHash: `ch${i}`,
            level0: { purpose: `Module ${i} functionality`, exports: [`func${i}`], sideEffects: [] },
            level1: {
                purpose: `Module ${i} provides core functionality`,
                publicApi: [`func${i}`], sideEffects: [], dependencies: [],
                evidenceAnchorIds: [], notes: '',
            },
        });
    }
    return fileIds;
}

describe('TaskPack Builder Budget', () => {
    let store: Store;
    let builder: TaskPackBuilder;
    let fileIds: string[];

    beforeEach(() => {
        store = new Store(':memory:');
        fileIds = seedStore(store);
        builder = new TaskPackBuilder(store);
    });

    it('should produce output within budget', () => {
        const pack = builder.build('test objective', [fileIds[0], fileIds[1]], 4000);
        const estimatedTokens = Math.ceil(pack.length / 3 * 1.15);
        expect(estimatedTokens).toBeLessThanOrEqual(4000 + 200);
    });

    it('should include header and file cards', () => {
        const pack = builder.build('test objective', [fileIds[0], fileIds[1]], 4000);
        expect(pack).toContain('Task Pack v3');
        expect(pack).toContain('Objective');
        expect(pack).toContain('module1.ts');
    });

    it('should include token report', () => {
        const pack = builder.build('test objective', [fileIds[0]], 4000);
        expect(pack).toContain('Token Report');
        expect(pack).toMatch(/\/ 4000/);
    });

    it('should handle minimum budget', () => {
        const pack = builder.build('test', [fileIds[0]], 200);
        expect(pack).toContain('Task Pack v3');
    });

    it('should handle empty objective gracefully', () => {
        const pack = builder.build('', [fileIds[0]], 4000);
        expect(pack).toContain('No objective provided');
    });

    it('should handle no file IDs', () => {
        const pack = builder.build('test', [], 4000);
        expect(pack).toContain('Task Pack v3');
    });

    it('should produce larger output at higher budgets', () => {
        const ids = [fileIds[0], fileIds[1], fileIds[2]];
        const small = builder.build('test', ids, 2000);
        const large = builder.build('test', ids, 8000);
        expect(large.length).toBeGreaterThanOrEqual(small.length);
    });
});

describe('Snippet Budget Guarantee', () => {
    let store: Store;
    let builder: TaskPackBuilder;
    let fileIds: string[];

    beforeEach(() => {
        store = new Store(':memory:');
        fileIds = seedStore(store);
        builder = new TaskPackBuilder(store);
    });

    it('should include Evidence Snippets section at budget=6000', () => {
        const pack = builder.build('test module functionality', fileIds.slice(0, 3), 6000);
        expect(pack).toContain('Evidence Snippets');
    });

    it('should include Evidence Snippets section at budget=4000', () => {
        const pack = builder.build('test module functionality', fileIds.slice(0, 2), 4000);
        expect(pack).toContain('Evidence Snippets');
    });
});
