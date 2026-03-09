import type { FileCard, CodeSymbol, Anchor } from '@atlasmemory/core';

export interface QualityResult {
    score: number;
    flags: string[];
}

export function scoreFileCard(card: FileCard, symbols: CodeSymbol[], anchors: Anchor[]): QualityResult {
    let score = 0;
    const flags: string[] = [];

    // 1. Evidence Count Score (Ideal: 1-6)
    // Range 1-6 is sweet spot. 0 is bad. >8 is too noisy.
    const anchorCount = card.level1?.evidenceAnchorIds?.length || 0;

    if (anchorCount === 0) {
        // Penalty unless it's a very small file? 
        // We don't know file size here easily, but let's assume valid cards need evidence.
        score -= 20;
        flags.push('no_evidence');
    } else if (anchorCount >= 1 && anchorCount <= 6) {
        score += 30; // Base score for having good evidence
    } else if (anchorCount > 8) {
        score += 10; // Still positive but less due to noise? Or penalize?
        flags.push('high_evidence_count');
    } else {
        score += 20; // 7-8 range
    }

    // 2. API Match Score
    // Check if listed publicApi items actually exist in symbols
    const claimedApi = card.level1?.publicApi || [];
    if (claimedApi.length > 0) {
        let matchCount = 0;
        for (const item of claimedApi) {
            // Fuzzy match or exact?
            // Symbols have name and qualifiedName.
            // Items in publicApi might be just names.
            const match = symbols.find(s => s.name === item || s.qualifiedName === item);
            if (match) matchCount++;
        }

        const matchRatio = matchCount / claimedApi.length;
        const apiScore = Math.floor(matchRatio * 30); // Max 30 points
        score += apiScore;

        if (matchRatio < 0.5) {
            flags.push('low_api_match');
        }
    } else {
        // If no API claimed, but symbols exist?
        const publicSymbols = symbols.filter(s => s.visibility === 'public');
        if (publicSymbols.length > 0) {
            // Missed opportunity
            score -= 10;
            flags.push('missed_public_api');
        } else {
            // No API and no public symbols - clean.
            score += 10;
        }
    }

    // 3. Verbosity Penalty
    const purpose = card.level1?.purpose || card.level0.purpose || '';
    if (purpose.length > 400) {
        score -= 10;
        flags.push('verbose_purpose');
    } else if (purpose.length < 10) {
        score -= 10;
        flags.push('too_short_purpose');
    } else {
        score += 20; // Good length
    }

    // 4. Claim without Evidence Penalty
    // If we have API claims or Side Effects but 0 anchors
    if ((claimedApi.length > 0 || (card.level1?.sideEffects?.length || 0) > 0) && anchorCount === 0) {
        score -= 30;
        flags.push('claims_without_evidence');
    }

    // 5. Codebase Hygiene (Side Effects)
    const sideEffects = card.level1?.sideEffects || [];
    if (sideEffects.length > 5) {
        score -= 10; // Suspiciously many side effects
        flags.push('many_side_effects');
    }

    // Normalize Score (0 - 100)
    // Current Max possible: 30 (evidence) + 30 (api) + 20 (length) + 10 (clean) = 90
    // Start with base 10?
    score += 10;

    return {
        score: Math.max(0, Math.min(100, score)),
        flags
    };
}
