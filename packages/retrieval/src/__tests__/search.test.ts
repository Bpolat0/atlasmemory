import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { SearchService } from '../search.js';
import crypto from 'crypto';

function seedSearchStore(store: Store) {
    const f1 = store.addFile('src/auth/login-handler.ts', 'typescript', 'h1', 80, 'authenticateUser');
    const f2 = store.addFile('src/api/user-routes.ts', 'typescript', 'h2', 120, 'getUserById');
    const f3 = store.addFile('src/db/postgres-pool.ts', 'typescript', 'h3', 60, 'createPool');

    const addSym = (fileId: string, name: string, kind: 'function' | 'class' = 'function') => {
        store.addSymbol({
            id: crypto.randomUUID(), fileId, name,
            qualifiedName: name, kind,
            signature: `${kind} ${name}()`,
            startLine: 1, endLine: 20, visibility: 'public',
            signatureHash: crypto.createHash('sha256').update(name).digest('hex'),
        });
    };

    addSym(f1, 'authenticateUser');
    addSym(f2, 'getUserById');
    addSym(f3, 'createPool');

    store.addFileCard({
        fileId: f1, path: 'src/auth/login-handler.ts', cardHash: 'c1',
        level0: { purpose: 'Handles user authentication and login', exports: ['authenticateUser'], sideEffects: [] },
    });
    store.addFileCard({
        fileId: f2, path: 'src/api/user-routes.ts', cardHash: 'c2',
        level0: { purpose: 'REST API routes for user management', exports: ['getUserById'], sideEffects: [] },
    });
    store.addFileCard({
        fileId: f3, path: 'src/db/postgres-pool.ts', cardHash: 'c3',
        level0: { purpose: 'PostgreSQL connection pooling', exports: ['createPool'], sideEffects: [] },
    });

    return { f1, f2, f3 };
}

describe('SearchService', () => {
    let store: Store;
    let search: SearchService;

    beforeEach(() => {
        store = new Store(':memory:');
        seedSearchStore(store);
        search = new SearchService(store);
    });

    it('should find files by keyword', () => {
        const results = search.search('authentication', 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it('should find files by symbol name', () => {
        const results = search.search('authenticateUser', 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it('should find files by path component', () => {
        const results = search.search('postgres pool', 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for nonsense query', () => {
        const results = search.search('zzzzxqwerty_nomatch', 5);
        expect(results).toHaveLength(0);
    });

    it('should respect limit parameter', () => {
        const results = search.search('user', 1);
        expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should return results with scores', () => {
        const results = search.search('user', 5);
        for (const r of results) {
            expect(r.score).toBeGreaterThan(0);
            expect(r.file).toBeDefined();
            expect(r.file.path).toBeTruthy();
        }
    });
});
