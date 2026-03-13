import { Store } from '@atlasmemory/store';
import type { Claim, CodeRef } from '@atlasmemory/core';
import fs from 'fs';
import path from 'path';

export type EvidencePolicy = 'strict' | 'warn' | 'off';

export interface ClaimInput {
    text: string;
    evidenceIds?: string[];
    status?: 'PROVEN' | 'UNPROVEN';
    score?: number;
    fileId?: string;
    scopePath?: string;
}

export interface ProveClaimResult {
    claim: Claim;
    candidates: Array<{ evidenceId: string; score: number; snippet: string }>;
    omitted?: boolean;
    proofWorkUnitsUsed?: number;
}

export interface ProveClaimOptions {
    diversity?: boolean;
    proofMode?: 'strict' | 'warn' | 'off';
    proofBudget?: number;
}

export interface ProveClaimsBatchInput {
    text: string;
    scopePath?: string;
    fileIdHint?: string;
}

export interface ProveClaimsBatchResult {
    results: ProveClaimResult[];
    proofWorkUnitsUsed: number;
}

type ProofStage = 'same_file' | 'one_hop' | 'folder';

interface Candidate {
    evidenceId: string;
    score: number;
    snippet: string;
    stage: ProofStage;
}

class ProofBudgeter {
    used = 0;

    constructor(public readonly limit: number = 2500) {}

    tryConsume(units: number): boolean {
        if (this.used + units > this.limit) return false;
        this.used += units;
        return true;
    }
}

const STAGE_COST: Record<ProofStage, number> = {
    same_file: 5,
    one_hop: 8,
    folder: 3
};

// Common words that carry no information for proof matching.
// Aligned with retrieval/search.ts stopwords.
const PROOF_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'what', 'how',
    'why', 'when', 'where', 'are', 'was', 'were', 'has', 'have', 'had', 'not',
    'but', 'all', 'can', 'will', 'its', 'than', 'use', 'uses', 'used', 'using',
    'new', 'via', 'also', 'each', 'any', 'some', 'does', 'like',
]);

// Minimum overlap score for folder-stage candidates.
// same_file/one_hop have structural code relationships so they don't need this.
// Folder-stage scans broadly — require at least some term match to count as evidence.
const MIN_FOLDER_OVERLAP = 0.15;

export class ClaimProver {
    constructor(private store: Store) {}

    applyPolicy(claims: ClaimInput[], policy: EvidencePolicy, maxEvidence: number = 3): Claim[] {
        const output: Claim[] = [];
        for (const item of claims) {
            const proven = this.proveClaim(item.text, item.scopePath, maxEvidence, item.fileId);
            const initialIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.filter(Boolean) : [];
            const evidenceIds = initialIds.length > 0 ? initialIds : proven.claim.evidenceIds;
            const hasEvidence = evidenceIds.length > 0;

            if (policy === 'off') {
                output.push({
                    text: item.text,
                    evidenceIds,
                    status: hasEvidence ? 'PROVEN' : (item.status || 'UNPROVEN'),
                    score: item.score
                });
                continue;
            }

            if (!hasEvidence && policy === 'strict') {
                continue;
            }

            const status = hasEvidence ? 'PROVEN' : 'UNPROVEN';
            const score = status === 'UNPROVEN' ? Math.max(0, (item.score ?? 1) - 0.35) : item.score;
            output.push({ text: item.text, evidenceIds, status, score });
        }
        return output;
    }

    proveClaim(
        claimText: string,
        scopePath?: string,
        maxEvidence: number = 5,
        fileIdHint?: string,
        options: ProveClaimOptions = {}
    ): ProveClaimResult {
        const proofMode = options.proofMode || 'strict';
        const budgeter = new ProofBudgeter(options.proofBudget ?? 2500);

        const sorted = this.collectCandidates(claimText, scopePath, fileIdHint, budgeter, proofMode)
            .sort((a, b) => b.score - a.score);

        const candidates = options.diversity
            ? this.selectDiverseCandidates(sorted, Math.max(1, maxEvidence))
            : sorted.slice(0, Math.max(1, maxEvidence));

        const evidenceIds = candidates.map(c => c.evidenceId);
        const claim: Claim = {
            text: claimText,
            evidenceIds,
            status: evidenceIds.length > 0 ? 'PROVEN' : 'UNPROVEN',
            score: candidates.length > 0 ? candidates[0].score : 0
        };

        const omitted = proofMode === 'strict' && evidenceIds.length === 0;

        return {
            claim,
            candidates,
            omitted,
            proofWorkUnitsUsed: budgeter.used
        };
    }

    proveClaims(
        claims: ProveClaimsBatchInput[],
        maxEvidence: number = 5,
        options: ProveClaimOptions = {}
    ): ProveClaimsBatchResult {
        const budgeter = new ProofBudgeter(options.proofBudget ?? 2500);
        const results: ProveClaimResult[] = [];
        const mode = options.proofMode || 'strict';

        for (const item of claims) {
            const sorted = this.collectCandidates(item.text, item.scopePath, item.fileIdHint, budgeter, mode)
                .sort((a, b) => b.score - a.score);

            const picked = options.diversity
                ? this.selectDiverseCandidates(sorted, Math.max(1, maxEvidence))
                : sorted.slice(0, Math.max(1, maxEvidence));

            const evidenceIds = picked.map(candidate => candidate.evidenceId);
            const claim: Claim = {
                text: item.text,
                evidenceIds,
                status: evidenceIds.length > 0 ? 'PROVEN' : 'UNPROVEN',
                score: picked.length > 0 ? picked[0].score : 0
            };

            results.push({
                claim,
                candidates: picked,
                omitted: mode === 'strict' && evidenceIds.length === 0,
                proofWorkUnitsUsed: budgeter.used
            });

            if (budgeter.used >= budgeter.limit) {
                // Remaining claims become omitted in strict mode, UNPROVEN in warn/off
                for (let index = results.length; index < claims.length; index++) {
                    const pending = claims[index];
                    const pendingClaim: Claim = {
                        text: pending.text,
                        evidenceIds: [],
                        status: mode === 'strict' ? 'UNPROVEN' : 'UNPROVEN'
                    };
                    results.push({
                        claim: pendingClaim,
                        candidates: [],
                        omitted: mode === 'strict',
                        proofWorkUnitsUsed: budgeter.used
                    });
                }
                break;
            }
        }

        return {
            results,
            proofWorkUnitsUsed: budgeter.used
        };
    }

    private selectDiverseCandidates(sorted: Candidate[], limit: number): Candidate[] {
        const selected: Candidate[] = [];
        const seenFiles = new Set<string>();

        for (const candidate of sorted) {
            if (selected.length >= limit) break;
            const anchor = this.store.getAnchor(candidate.evidenceId);
            const fileKey = anchor?.fileId || candidate.evidenceId;
            if (seenFiles.has(fileKey)) continue;
            seenFiles.add(fileKey);
            selected.push(candidate);
        }

        if (selected.length < limit) {
            for (const candidate of sorted) {
                if (selected.length >= limit) break;
                if (selected.some(item => item.evidenceId === candidate.evidenceId)) continue;
                selected.push(candidate);
            }
        }

        return selected;
    }

    private collectCandidates(
        claimText: string,
        scopePath?: string,
        fileIdHint?: string,
        budgeter?: ProofBudgeter,
        mode: 'strict' | 'warn' | 'off' = 'strict'
    ): Candidate[] {
        const candidates: Candidate[] = [];
        const seen = new Set<string>();
        const normalizedScope = scopePath ? path.resolve(scopePath).toLowerCase() : undefined;

        const pushCandidate = (candidate: Candidate) => {
            if (seen.has(candidate.evidenceId)) return;
            seen.add(candidate.evidenceId);
            candidates.push(candidate);
        };

        const claimTerms = this.tokenize(claimText);

        const canRunStage = (stage: ProofStage) => {
            if (!budgeter) return true;
            const ok = budgeter.tryConsume(STAGE_COST[stage]);
            if (ok) return true;
            return mode !== 'strict';
        };

        const anchorFromFile = (targetFileId: string, baseScore: number, stage: ProofStage) => {
            if (!canRunStage(stage)) return;
            const anchors = this.store.getAnchorsForFile(targetFileId).slice(0, 50);
            for (const anchor of anchors) {
                const snippet = this.getAnchorSnippet(anchor.id);
                if (!snippet) continue;
                const score = baseScore + this.overlapScore(claimTerms, this.tokenize(snippet));
                pushCandidate({ evidenceId: anchor.id, score, snippet, stage });
            }
        };

        if (fileIdHint) {
            anchorFromFile(fileIdHint, 1.0, 'same_file');

            const symbols = this.store.getSymbolsForFile(fileIdHint);
            const refs: CodeRef[] = [];
            if (canRunStage('one_hop')) {
                for (const symbol of symbols) {
                    refs.push(...this.store.getRefsFrom(symbol.id));
                }
                for (const ref of refs) {
                    if (!ref.anchorId) continue;
                    const snippet = this.getAnchorSnippet(ref.anchorId);
                    if (!snippet) continue;
                    const score = 0.85 + this.overlapScore(claimTerms, this.tokenize(`${ref.toName} ${snippet}`));
                    pushCandidate({ evidenceId: ref.anchorId, score, snippet, stage: 'one_hop' });
                }
            }
        }

        const allFiles = this.store.getFiles().filter(file => {
            if (!normalizedScope) return true;
            return path.resolve(file.path).toLowerCase().startsWith(normalizedScope);
        });

        if (allFiles.length > 0 && canRunStage('folder')) {
            // Use FTS-scored results instead of arbitrary DB order
            const ftsResults = claimTerms.length > 0
                ? this.store.scoredSearch(claimTerms.join(' '), 40)
                : [];
            const ftsFileIds = new Set(ftsResults.map(r => r.file.id));
            // Merge: FTS results first, then remaining files (capped at 40 total)
            const orderedFiles = [
                ...allFiles.filter(f => ftsFileIds.has(f.id)),
                ...allFiles.filter(f => !ftsFileIds.has(f.id)),
            ].slice(0, 40);
            for (const file of orderedFiles) {
                const anchors = this.store.getAnchorsForFile(file.id);
                if (anchors.length === 0) continue;
                const best = anchors[0];
                const snippet = this.getAnchorSnippet(best.id);
                if (!snippet) continue;
                const inSameFolder = fileIdHint
                    ? this.inSameFolder(fileIdHint, file.id)
                    : false;
                const base = inSameFolder ? 0.7 : 0.45;
                const overlap = this.overlapScore(claimTerms, this.tokenize(snippet));
                if (overlap < MIN_FOLDER_OVERLAP) continue; // No term match → not evidence
                const score = base + overlap;
                pushCandidate({ evidenceId: best.id, score, snippet, stage: 'folder' });
            }
        }

        return candidates;
    }

    private inSameFolder(fileA: string, fileB: string): boolean {
        const a = this.store.getFileById(fileA);
        const b = this.store.getFileById(fileB);
        if (!a || !b) return false;
        return path.dirname(path.resolve(a.path)).toLowerCase() === path.dirname(path.resolve(b.path)).toLowerCase();
    }

    private getAnchorSnippet(anchorId: string): string {
        const anchor = this.store.getAnchor(anchorId);
        if (!anchor) return '';
        const file = this.store.getFileById(anchor.fileId);
        if (!file || !fs.existsSync(file.path)) return '';
        const content = fs.readFileSync(file.path, 'utf-8');
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, anchor.startLine - 1);
        const end = Math.min(lines.length, anchor.endLine + 1, start + 9);
        const excerpt = lines.slice(start - 1, end).join('\n').trim();
        if (!excerpt) return '';
        return `${path.basename(file.path)}:${start}-${end}\n${excerpt}`;
    }

    private tokenize(text: string): string[] {
        return (text || '')
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .filter(token => token.length >= 3 && !PROOF_STOPWORDS.has(token))
            .slice(0, 64);
    }

    private overlapScore(a: string[], b: string[]): number {
        if (a.length === 0 || b.length === 0) return 0;
        const bSet = new Set(b);
        let hits = 0;
        for (const token of a) {
            if (bSet.has(token)) hits++;
        }
        return hits / Math.max(1, Math.min(8, a.length));
    }
}

export function renderClaim(claim: Claim, label: 'C' | 'F' = 'C'): string {
    const evidence = claim.evidenceIds.length > 0 ? claim.evidenceIds.join(',') : 'none';
    if (claim.status === 'UNPROVEN') {
        return `${label}:${claim.text} | S:UNPROVEN | E:${evidence}`;
    }
    return `${label}:${claim.text} | E:${evidence}`;
}
