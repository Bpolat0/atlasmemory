import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { ContextContractService } from '../contract.js';
import crypto from 'crypto';

describe('ContextContractService', () => {
    let store: Store;
    let service: ContextContractService;

    beforeEach(() => {
        store = new Store(':memory:');
        // Use current dir as repoRoot (needed for getRepoId)
        service = new ContextContractService(store, process.cwd());
    });

    describe('createContractHash', () => {
        it('should produce deterministic hash for same input', () => {
            const snapshot = makeSnapshot();
            const h1 = service.createContractHash(snapshot);
            const h2 = service.createContractHash(snapshot);
            expect(h1).toBe(h2);
            expect(h1.length).toBe(64); // sha256 hex
        });

        it('should produce different hash for different input', () => {
            const s1 = makeSnapshot({ gitHead: 'aaa' });
            const s2 = makeSnapshot({ gitHead: 'bbb' });
            expect(service.createContractHash(s1)).not.toBe(service.createContractHash(s2));
        });
    });

    describe('createSnapshot + evaluateContract', () => {
        it('should create snapshot and evaluate as not-stale immediately', () => {
            const dbSig = store.getDbSignature();
            const gitHead = service.getGitHead();

            const { contractHash } = service.createSnapshot({
                bootpackHash: 'bp1',
                deltapackHash: undefined,
                taskpackHash: undefined,
                objective: 'test',
                budgets: { task: 10000 },
                proofMode: 'strict',
                minDbCoverage: undefined,
                dbSig,
                gitHead,
            });

            expect(contractHash).toBeDefined();
            expect(contractHash.length).toBe(64);

            // Evaluate — should not be stale since nothing changed
            const contract = service.evaluateContract();
            expect(contract.isStale).toBe(false);
            expect(contract.shouldBlock).toBe(false);
            expect(contract.reasons).toHaveLength(0);
        });

        it('should detect DB_CHANGED when DB state changes after snapshot', () => {
            const dbSig = store.getDbSignature();
            const gitHead = service.getGitHead();

            service.createSnapshot({
                bootpackHash: 'bp1',
                deltapackHash: undefined,
                taskpackHash: undefined,
                objective: 'test',
                budgets: { task: 10000 },
                proofMode: 'strict',
                minDbCoverage: undefined,
                dbSig,
                gitHead,
            });

            // Change DB state by adding a file
            store.addFile('src/new.ts', 'typescript', 'newhash', 50, '');

            const contract = service.evaluateContract();
            expect(contract.isStale).toBe(true);
            expect(contract.reasons).toContain('DB_CHANGED');
        });

        it('should detect CONTRACT_MISMATCH when wrong hash provided', () => {
            const dbSig = store.getDbSignature();
            const gitHead = service.getGitHead();

            service.createSnapshot({
                bootpackHash: 'bp1',
                deltapackHash: undefined,
                taskpackHash: undefined,
                objective: 'test',
                budgets: { task: 10000 },
                proofMode: 'strict',
                minDbCoverage: undefined,
                dbSig,
                gitHead,
            });

            const contract = service.evaluateContract({
                providedContractHash: 'wrong-hash',
            });
            expect(contract.isStale).toBe(true);
            expect(contract.reasons).toContain('CONTRACT_MISMATCH');
        });

        it('should block in strict mode when stale', () => {
            const dbSig = store.getDbSignature();
            const gitHead = service.getGitHead();

            service.createSnapshot({
                bootpackHash: 'bp1',
                deltapackHash: undefined,
                taskpackHash: undefined,
                objective: 'test',
                budgets: { task: 10000 },
                proofMode: 'strict',
                minDbCoverage: undefined,
                dbSig,
                gitHead,
            });

            // Make stale
            store.addFile('src/x.ts', 'typescript', 'xh', 10, '');

            const contract = service.evaluateContract({ enforce: 'strict' });
            expect(contract.shouldBlock).toBe(true);
            expect(contract.requiredBootstrap).toBe(true);
        });

        it('should not block in warn mode when stale', () => {
            const dbSig = store.getDbSignature();
            const gitHead = service.getGitHead();

            service.createSnapshot({
                bootpackHash: 'bp1',
                deltapackHash: undefined,
                taskpackHash: undefined,
                objective: 'test',
                budgets: { task: 10000 },
                proofMode: 'strict',
                minDbCoverage: undefined,
                dbSig,
                gitHead,
            });

            store.addFile('src/x.ts', 'typescript', 'xh', 10, '');

            const contract = service.evaluateContract({ enforce: 'warn' });
            expect(contract.isStale).toBe(true);
            expect(contract.shouldBlock).toBe(false);
        });
    });

    describe('evaluateContract - no snapshot', () => {
        it('should return NO_SNAPSHOT when no snapshot exists', () => {
            const contract = service.evaluateContract();
            expect(contract.isStale).toBe(true);
            expect(contract.shouldBlock).toBe(true);
            expect(contract.requiredBootstrap).toBe(true);
            expect(contract.reasons).toContain('NO_SNAPSHOT');
        });
    });

    describe('acknowledgeContext', () => {
        it('should acknowledge valid contract hash', () => {
            const dbSig = store.getDbSignature();
            const { contractHash } = service.createSnapshot({
                bootpackHash: 'bp1',
                deltapackHash: undefined,
                taskpackHash: undefined,
                objective: 'test',
                budgets: { task: 10000 },
                proofMode: 'strict',
                minDbCoverage: undefined,
                dbSig,
                gitHead: service.getGitHead(),
            });

            const result = service.acknowledgeContext(contractHash);
            expect(result).toBe(true);
        });

        it('should return false for unknown contract hash', () => {
            const result = service.acknowledgeContext('nonexistent-hash');
            expect(result).toBe(false);
        });
    });

    describe('getRepoId', () => {
        it('should return consistent hash for same path', () => {
            const id1 = service.getRepoId();
            const id2 = service.getRepoId();
            expect(id1).toBe(id2);
            expect(id1.length).toBe(64);
        });
    });

    describe('getGitHead', () => {
        it('should return a git commit hash or undefined', () => {
            const head = service.getGitHead();
            // In a git repo, should return a 40-char hex string
            if (head) {
                expect(head).toMatch(/^[0-9a-f]{40}$/);
            }
        });
    });
});

function makeSnapshot(overrides: Partial<any> = {}): any {
    return {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        repoId: 'test-repo',
        gitHead: 'abc123',
        dbSig: { fileCount: 5, symbolCount: 20, hash: 'dbhash' },
        bootpackHash: 'bp1',
        deltapackHash: undefined,
        taskpackHash: undefined,
        objective: 'test',
        budgets: { task: 10000 },
        proofMode: 'strict',
        minDbCoverage: 0.8,
        ...overrides,
    };
}
