import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { ClaimProver, renderClaim } from '../proof.js';
import crypto from 'crypto';

describe('ClaimProver', () => {
    let store: Store;
    let prover: ClaimProver;
    let fileId: string;
    let anchorId: string;

    beforeEach(() => {
        store = new Store(':memory:');
        fileId = store.addFile('src/main.ts', 'typescript', 'h1', 50, '');
        anchorId = crypto.randomUUID();
        store.upsertAnchor({ id: anchorId, fileId, startLine: 1, endLine: 10, snippetHash: 'hash1' });
        prover = new ClaimProver(store);
    });

    it('should prove a claim with valid evidence', () => {
        const claims = prover.applyPolicy([
            { text: 'Main entry point', evidenceIds: [anchorId], fileId }
        ], 'strict', 2);
        expect(claims).toHaveLength(1);
        expect(claims[0].status).toBe('PROVEN');
    });

    it('should filter unproven claims in strict mode', () => {
        const claims = prover.applyPolicy([
            { text: 'No evidence claim' }
        ], 'strict', 2);
        expect(claims).toHaveLength(0);
    });

    it('should include unproven claims in off mode', () => {
        const claims = prover.applyPolicy([
            { text: 'Some claim', evidenceIds: [], fileId }
        ], 'off', 2);
        expect(claims.length).toBeGreaterThanOrEqual(1);
    });

    it('should render claims as text', () => {
        const claims = prover.applyPolicy([
            { text: 'Entry point', evidenceIds: [anchorId], fileId }
        ], 'strict', 2);
        if (claims.length > 0) {
            const rendered = renderClaim(claims[0]);
            expect(rendered).toContain('Entry point');
        }
    });

    it('should prove a single claim via proveClaim', () => {
        const result = prover.proveClaim('main', undefined, 5, fileId);
        expect(result.claim).toBeDefined();
        expect(result.claim.text).toBe('main');
    });
});
