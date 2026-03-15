import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { DiffEnricher } from '../diff-enricher.js';
import crypto from 'crypto';

describe('DiffEnricher', () => {
    let store: Store;
    let enricher: DiffEnricher;

    beforeEach(() => {
        store = new Store(':memory:');
        const fileId = store.addFile('src/main.ts', 'typescript', 'h1', 50, '');
        store.addSymbol({
            id: crypto.randomUUID(), fileId, name: 'main',
            qualifiedName: 'main', kind: 'function',
            signature: 'function main()',
            startLine: 1, endLine: 10, visibility: 'public',
            signatureHash: crypto.createHash('sha256').update('main').digest('hex'),
        });
        enricher = new DiffEnricher(store);
    });

    it('should return empty array when git has no changes', () => {
        const diffs = enricher.enrichGitDiff('HEAD');
        expect(Array.isArray(diffs)).toBe(true);
    });

    it('should summarize empty changes', () => {
        const summary = enricher.summarizeChanges([]);
        expect(summary).toContain('0 files changed');
    });

    it('should format diffs as markdown', () => {
        const formatted = enricher.formatDiffs([]);
        expect(formatted).toContain('Smart Diff Summary');
    });

    it('should extract breaking changes from empty', () => {
        expect(enricher.getBreakingChanges([])).toHaveLength(0);
    });

    it('should handle mock diff data', () => {
        const summary = enricher.summarizeChanges([{
            filePath: 'src/test.ts',
            changeType: 'modified',
            symbolChanges: [{ symbolName: 'foo', changeKind: 'body_changed', breakingChange: true, dependentCount: 3 }],
            impactSummary: { affectedFiles: 3, breakingChanges: 1 },
            staleAnchors: [],
            affectedFlows: [],
            testCoverage: { hasTests: false, testFiles: [] },
        }]);
        expect(summary).toContain('1 files changed');
        expect(summary).toContain('1 breaking');
    });

    it('should extract breaking changes from mock data', () => {
        const breaking = enricher.getBreakingChanges([{
            filePath: 'src/test.ts',
            changeType: 'modified',
            symbolChanges: [
                { symbolName: 'foo', changeKind: 'body_changed', breakingChange: true, dependentCount: 3 },
                { symbolName: 'bar', changeKind: 'body_changed', breakingChange: false, dependentCount: 0 },
            ],
            impactSummary: { affectedFiles: 3, breakingChanges: 1 },
            staleAnchors: [],
            affectedFlows: [],
            testCoverage: { hasTests: false, testFiles: [] },
        }]);
        expect(breaking).toHaveLength(1);
        expect(breaking[0].symbolName).toBe('foo');
    });
});
