import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { TaskPackBuilder } from '../builder.js';
import { ClaimProver } from '../proof.js';
import { ContextContractService } from '../contract.js';
import { SearchService } from '@atlasmemory/retrieval';
import crypto from 'crypto';

function uid() { return crypto.randomUUID(); }
function hash(s: string) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * Integration test: seeds realistic data, then runs
 * Search → TaskPack → Proof → Contract end-to-end
 */
describe('Integration: Search → TaskPack → Proof → Contract', () => {
    let store: Store;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        seedRealisticData(store);
    });

    it('should search, build taskpack, and prove claims', () => {
        // 1. Search
        const search = new SearchService(store);
        const results = search.search('authentication', 5);
        expect(results.length).toBeGreaterThan(0);

        const fileIds = results.map((r: any) => r.file.id);

        // 2. Build TaskPack
        const builder = new TaskPackBuilder(store, process.cwd());
        const pack = builder.build('How does authentication work?', fileIds, 8000);

        expect(pack).toContain('Task Pack v3');
        expect(pack).toContain('Objective');
        expect(pack).toContain('Relevant Files');

        // 3. Prove claims (evidence system)
        const prover = new ClaimProver(store);
        const claims = prover.applyPolicy(
            [{ text: 'The auth module handles login', scopePath: 'src/auth/' }],
            'warn',
            3,
        );
        expect(claims).toHaveLength(1);
        // In warn mode, claims always pass (even without evidence)
        expect(claims[0].status).toBeDefined();
        expect(['PROVEN', 'UNPROVEN']).toContain(claims[0].status);
    });

    it('should create and evaluate contract after building context', () => {
        const contractService = new ContextContractService(store, process.cwd());
        const dbSig = store.getDbSignature();
        const gitHead = contractService.getGitHead();

        // Create snapshot
        const { contractHash } = contractService.createSnapshot({
            bootpackHash: 'bp1',
            deltapackHash: undefined,
            taskpackHash: hash('taskpack-content'),
            objective: 'Fix auth',
            budgets: { task: 8000 },
            proofMode: 'strict',
            minDbCoverage: undefined,
            dbSig,
            gitHead,
        });

        // Contract should be fresh
        const contract = contractService.evaluateContract();
        expect(contract.isStale).toBe(false);
        expect(contract.contractHash).toBe(contractHash);

        // Acknowledge
        expect(contractService.acknowledgeContext(contractHash)).toBe(true);

        // Modify DB → contract goes stale
        store.addFile('src/new-feature.ts', 'typescript', 'newhash', 30, '');
        const staleContract = contractService.evaluateContract();
        expect(staleContract.isStale).toBe(true);
        expect(staleContract.reasons).toContain('DB_CHANGED');
    });

    it('should handle empty search gracefully in pipeline', () => {
        const search = new SearchService(store);
        const results = search.search('zzz_nonexistent_module_xyz', 5);

        const builder = new TaskPackBuilder(store, process.cwd());
        const pack = builder.build(
            'Find zzz_nonexistent_module_xyz',
            results.map((r: any) => r.file.id),
            4000,
        );
        // Should still produce valid output even with no files
        expect(pack).toContain('Task Pack v3');
    });

    it('should respect token budget in end-to-end flow', () => {
        const search = new SearchService(store);
        const results = search.search('authentication', 10);
        const fileIds = results.map((r: any) => r.file.id);

        const builder = new TaskPackBuilder(store, process.cwd());

        // Very small budget
        const smallPack = builder.build('Auth overview', fileIds, 500);
        // Large budget
        const largePack = builder.build('Auth overview', fileIds, 20000);

        // Large pack should contain more content
        expect(largePack.length).toBeGreaterThan(smallPack.length);
    });
});

function seedRealisticData(store: Store) {
    // Create realistic file structure
    const files = [
        { path: 'src/auth/login.ts', lang: 'typescript', loc: 80 },
        { path: 'src/auth/middleware.ts', lang: 'typescript', loc: 60 },
        { path: 'src/db/store.ts', lang: 'typescript', loc: 200 },
        { path: 'src/api/routes.ts', lang: 'typescript', loc: 120 },
        { path: 'src/utils/hash.ts', lang: 'typescript', loc: 30 },
    ];

    const fileIds: string[] = [];
    for (const f of files) {
        const fid = store.addFile(f.path, f.lang, hash(f.path), f.loc, '');
        fileIds.push(fid);
    }

    // Add symbols
    const symbols = [
        { fileIdx: 0, name: 'authenticateUser', kind: 'function' as const, start: 1, end: 25 },
        { fileIdx: 0, name: 'validateToken', kind: 'function' as const, start: 27, end: 50 },
        { fileIdx: 1, name: 'authMiddleware', kind: 'function' as const, start: 1, end: 30 },
        { fileIdx: 2, name: 'Store', kind: 'class' as const, start: 1, end: 200 },
        { fileIdx: 3, name: 'registerRoutes', kind: 'function' as const, start: 1, end: 50 },
        { fileIdx: 4, name: 'sha256', kind: 'function' as const, start: 1, end: 15 },
    ];

    const symIds: string[] = [];
    for (const s of symbols) {
        const sid = uid();
        symIds.push(sid);
        const sig = `${s.kind} ${s.name}()`;
        store.addSymbol({
            id: sid, fileId: fileIds[s.fileIdx], name: s.name,
            qualifiedName: s.name, kind: s.kind, signature: sig,
            startLine: s.start, endLine: s.end, visibility: 'public',
            signatureHash: hash(sig),
        });
    }

    // Add anchors
    for (let i = 0; i < symbols.length; i++) {
        store.upsertAnchor({
            id: uid(), fileId: fileIds[symbols[i].fileIdx],
            startLine: symbols[i].start, endLine: symbols[i].end,
            snippetHash: hash(`snippet-${i}`),
        });
    }

    // Add file cards
    for (let i = 0; i < files.length; i++) {
        store.addFileCard({
            fileId: fileIds[i],
            path: files[i].path,
            cardHash: hash(`card-${i}`),
            level0: {
                purpose: `${files[i].path.split('/').pop()} — handles ${files[i].path.includes('auth') ? 'authentication' : 'core'} logic`,
                exports: symbols.filter(s => s.fileIdx === i).map(s => s.name),
                sideEffects: [],
            },
            level1: {
                purpose: `Detailed: ${files[i].path}`,
                publicApi: symbols.filter(s => s.fileIdx === i).map(s => s.name),
                sideEffects: [],
                dependencies: [],
                evidenceAnchorIds: [],
                notes: '',
            },
        });
    }

    // Add refs (middleware -> login, routes -> middleware)
    store.addRef({ id: uid(), fromSymbolId: symIds[2], toSymbolId: symIds[0], toName: 'authenticateUser', kind: 'call' });
    store.addRef({ id: uid(), fromSymbolId: symIds[4], toSymbolId: symIds[2], toName: 'authMiddleware', kind: 'call' });
    store.buildReverseRefs();
}
