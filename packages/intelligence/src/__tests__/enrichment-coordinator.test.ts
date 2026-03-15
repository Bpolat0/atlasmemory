import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { EnrichmentCoordinator } from '../enrichment-coordinator.js';

describe('EnrichmentCoordinator', () => {
    let store: Store;
    let coordinator: EnrichmentCoordinator;

    beforeEach(() => {
        store = new Store(':memory:');
        store.addFile('src/main.ts', 'typescript', 'h1', 50, '');
        store.addFileCard({
            fileId: store.getFileId('src/main.ts')!,
            path: 'src/main.ts', cardHash: 'c1',
            level0: { purpose: 'Main', exports: [], sideEffects: [] },
        });
        // Pass empty backends array — no AI available
        coordinator = new EnrichmentCoordinator(store, []);
    });

    it('should report coverage correctly', () => {
        const coverage = coordinator.getEnrichmentCoverage();
        expect(coverage.total).toBe(1);
        expect(coverage.enriched).toBe(0);
        expect(coverage.percentage).toBe(0);
    });

    it('should enrich deterministically when no backend', async () => {
        const report = await coordinator.enrichBatch(10);
        expect(report.enriched).toBe(1);
        expect(report.backend).toBe('deterministic');
    });

    it('should report 100% after enrichment', async () => {
        await coordinator.enrichBatch(10);
        const coverage = coordinator.getEnrichmentCoverage();
        expect(coverage.percentage).toBe(100);
    });

    it('should generate enrichment invitation when not enriched', () => {
        const invitation = coordinator.getEnrichmentInvitation();
        expect(invitation).toContain('enriched');
    });

    it('should return empty invitation when fully enriched', async () => {
        await coordinator.enrichBatch(10);
        expect(coordinator.getEnrichmentInvitation()).toBe('');
    });
});
