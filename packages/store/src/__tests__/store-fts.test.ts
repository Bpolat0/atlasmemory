import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../store.js';
import crypto from 'crypto';

/** Helper: add file + symbol in one call */
function addFileWithSymbol(store: Store, filePath: string, symName: string, symKind: 'function' | 'class' = 'function') {
    const fileId = store.addFile(filePath, 'typescript', crypto.randomUUID(), 80, symName);
    store.addSymbol({
        id: crypto.randomUUID(), fileId, name: symName,
        qualifiedName: symName, kind: symKind,
        signature: `${symKind} ${symName}()`,
        startLine: 1, endLine: 20, visibility: 'public',
        signatureHash: crypto.createHash('sha256').update(`${symKind} ${symName}`).digest('hex'),
    });
    return fileId;
}

describe('Store FTS5 Search', () => {
    let store: Store;

    beforeEach(() => {
        store = new Store(':memory:');
        addFileWithSymbol(store, 'src/auth/login.ts', 'authenticateUser');
        addFileWithSymbol(store, 'src/api/routes.ts', 'registerRoutes');
        addFileWithSymbol(store, 'src/db/connection-pool.ts', 'ConnectionPool', 'class');
    });

    it('should find files by path keywords via scoredSearch', () => {
        const results = store.scoredSearch('auth login', 10);
        expect(results.length).toBeGreaterThan(0);
    });

    it('should find files by symbol name via scoredSearch', () => {
        const results = store.scoredSearch('authenticateUser', 10);
        expect(results.length).toBeGreaterThan(0);
    });

    it('should handle camelCase splitting via scoredSearch', () => {
        const results = store.scoredSearch('connection pool', 10);
        expect(results.length).toBeGreaterThan(0);
    });

    it('should find files by path LIKE search', () => {
        const results = store.searchFiles('auth');
        expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for no match', () => {
        const results = store.scoredSearch('nonexistent_query_xyz_12345', 10);
        expect(results).toHaveLength(0);
    });

    it('should store and retrieve session state', () => {
        store.setState('test_key', 'test_value');
        expect(store.getState('test_key')).toBe('test_value');
    });

    it('should return undefined for missing state', () => {
        expect(store.getState('nonexistent')).toBeUndefined();
    });
});
