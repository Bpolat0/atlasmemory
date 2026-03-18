import { Store } from '@atlasmemory/store';
import type { FileCard } from '@atlasmemory/core';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ClaimProver, type EvidencePolicy, renderClaim } from './proof.js';

export class TaskPackBuilder {
    private repoRoot: string;
    constructor(private store: Store, repoRoot?: string) {
        this.repoRoot = repoRoot || store.getRepoRoot();
    }

    build(objective: string, initialFileIds: string[], tokenBudget: number = 12000, options: any = {}): string {
        if (!objective || !objective.trim()) {
            return '# Task Pack v3\n\n(No objective provided. Please specify what you need.)';
        }
        if (tokenBudget < 200) tokenBudget = 200; // Minimum viable budget
        const { includeDts = false, snippetMaxLines = 40, proof = 'strict', allowUnproven = false } = options;
        const proofPolicy: EvidencePolicy = proof === 'warn' || proof === 'off' ? proof : (allowUnproven ? 'warn' : 'strict');
        const prover = new ClaimProver(this.store);

        // 1. Fetch & Deduplicate Candidates
        const candidates = this.resolveCandidates(initialFileIds, includeDts);

        // 2. Token Budgeting Strategy
        // Priority:
        // P1: Objective + Header
        // P2: Relevant Files (FileCard L1/L0)
        // P3: Relevant Symbols (Signatures)
        // P4: Evidence Snippets (Anchors)
        // P5: Extra Snippets (if budget allows)

        let usedTokens = 0;
        const sections: string[] = [];

        // --- P1: Header & Objective ---
        const objectiveLine = `C:${objective}`;
        const projectMap = this.buildProjectMap(candidates);
        const header = `# Task Pack v3\n\n## Objective\n${objectiveLine}\n\n## Project Map\n${projectMap}\n\n`;
        const headerTokens = this.estimateTokens(header);

        if (headerTokens > tokenBudget) {
            return `# Task Pack v3\n\nObjective: ${objective}\n\n(Budget exceeded immediately)`;
        }
        usedTokens += headerTokens;
        sections.push(header);

        // --- P1.5: Folder Summaries ---
        const { folderCards = [] } = options;
        if (folderCards.length > 0) {
            const folderSectionParts: string[] = ['## Relevant Context (Folders)\n'];
            for (const card of folderCards) {
                // @ts-ignore
                const folderName = path.basename(card.folderPath);
                // @ts-ignore
                const purpose = card.level0.purpose;
                // @ts-ignore
                const exports = card.level1?.exports?.slice(0, 5).join(', ') || '';

                const folderClaim = prover.applyPolicy([{ text: `${folderName}/: ${purpose}`, scopePath: (card as any).folderPath }], proofPolicy, 2);
                const folderLine = folderClaim.map(claim => renderClaim(claim)).join(' ') || 'C:folder summary omitted';
                const text = `- ${folderLine}\n  Key Exports: ${exports}\n`;
                const tokens = this.estimateTokens(text);
                if (usedTokens + tokens < tokenBudget) {
                    usedTokens += tokens;
                    folderSectionParts.push(text);
                }
            }
            if (folderSectionParts.length > 1) {
                sections.push(folderSectionParts.join('\n') + '\n');
            }
        }

        // --- P2: Relevant Files (Cards) ---
        // File cards capped at 45% to guarantee snippet budget (was 60% — caused starvation)
        const FILE_CARDS_BUDGET_CAP = Math.floor(tokenBudget * 0.45);
        const fileCards: FileCard[] = [];
        const fileSectionParts: string[] = ['## Relevant Files\n'];

        for (const fileId of candidates) {
            const card = this.store.getFileCard(fileId);
            if (!card) continue;
            fileCards.push(card);

            const cardText = this.formatFileCard(card, prover, proofPolicy);
            const tokens = this.estimateTokens(cardText);

            if (usedTokens + tokens < FILE_CARDS_BUDGET_CAP) {
                usedTokens += tokens;
                fileSectionParts.push(cardText);
            } else {
                fileSectionParts.push(`- ${card.path} (Omitted due to budget)\n`);
            }
        }
        sections.push(fileSectionParts.join('\n'));

        // --- Snippet Budget Reservation ---
        // Guarantee at least 15% of total budget for snippets (prevents starvation at low budgets)
        const SNIPPET_MIN_BUDGET = Math.floor(tokenBudget * 0.15);
        const remainingAfterCards = tokenBudget - usedTokens;
        const snippetBudget = Math.max(SNIPPET_MIN_BUDGET, Math.floor(remainingAfterCards * 0.30));
        const snippetCeiling = usedTokens + snippetBudget;

        // --- P2.5: Evidence Snippets (Real Content — highest value, goes early) ---
        // Moved before Flow/Invariant/Symbol sections so actual code always gets budget.
        const snippetSectionParts: string[] = ['\n## Evidence Snippets\n'];

        for (const card of fileCards) {
            try {
                const absPath = path.resolve(this.repoRoot, card.path);
                if (fs.existsSync(absPath)) {
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const ext = path.extname(card.path).slice(1);

                    let snippets: string[] = [];

                    const fileHeader = `\n### ${path.basename(card.path)}\n\`\`\`${ext}\n`;
                    const fileFooter = `\`\`\`\n`;
                    const headerTokens = this.estimateTokens(fileHeader + fileFooter);

                    // Check if we have any budget for this file at all
                    if (usedTokens + headerTokens >= snippetCeiling) continue;

                    if (card.level1?.evidenceAnchorIds && card.level1.evidenceAnchorIds.length > 0) {
                        // Use Evidence Anchors — emit each snippet individually for better budget use
                        let fileHasSnippets = false;
                        const MAX_ANCHORS_PER_FILE = 3;
                        let anchorCount = 0;
                        // Track shown ranges to skip overlapping anchors (prevents duplicate code blocks)
                        const shownRanges: Array<{ start: number; end: number }> = [];

                        // Rank anchors by query relevance. Use evidenceAnchorIds first,
                        // then sample from all file anchors (capped at 20 to avoid O(n*m) on large files).
                        const QUERY_STOPWORDS = new Set([
                            'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'what', 'how',
                            'why', 'when', 'where', 'does', 'are', 'was', 'were', 'has', 'have', 'had',
                            'can', 'will', 'its', 'not', 'but', 'all', 'any', 'get', 'set', 'use',
                        ]);
                        const queryTerms = objective.toLowerCase().split(/\W+/)
                            .filter(t => t.length > 2 && !QUERY_STOPWORDS.has(t));

                        // Start with evidence anchors (curated, fast)
                        const evidenceAnchors = card.level1.evidenceAnchorIds
                            .map(id => this.store.getAnchor(id))
                            .filter(Boolean) as import('@atlasmemory/core').Anchor[];

                        // Supplement with file anchors if needed, but cap at 20 total candidates
                        const MAX_CANDIDATE_ANCHORS = 20;
                        let candidateAnchors = evidenceAnchors;
                        if (candidateAnchors.length < MAX_CANDIDATE_ANCHORS) {
                            const allFileAnchors = this.store.getAnchorsForFile(card.fileId);
                            const evidenceIds = new Set(card.level1.evidenceAnchorIds);
                            for (const a of allFileAnchors) {
                                if (candidateAnchors.length >= MAX_CANDIDATE_ANCHORS) break;
                                if (!evidenceIds.has(a.id)) candidateAnchors.push(a);
                            }
                        }
                        const rankedAnchorIds = candidateAnchors
                            .map(anchor => {
                                const snip = this.getSnippet(content, anchor.startLine, anchor.endLine).toLowerCase();
                                const score = queryTerms.reduce((n, t) => n + (snip.includes(t) ? 1 : 0), 0);
                                return { id: anchor.id, score };
                            })
                            .sort((a, b) => b.score - a.score)
                            .map(s => s.id);

                        for (const anchorId of rankedAnchorIds) {
                            if (anchorCount >= MAX_ANCHORS_PER_FILE) break;
                            const anchor = this.store.getAnchor(anchorId);
                            if (!anchor) continue;

                            const start = Math.max(1, anchor.startLine - 1);
                            const end = anchor.endLine + 1;
                            const actualEnd = Math.min(start + snippetMaxLines, end);

                            // Skip if this range is already substantially covered by a shown range
                            const rangeLen = actualEnd - start;
                            const alreadyCovered = shownRanges.some(r => {
                                const overlapStart = Math.max(start, r.start);
                                const overlapEnd = Math.min(actualEnd, r.end);
                                const overlap = Math.max(0, overlapEnd - overlapStart);
                                return overlap > rangeLen * 0.5; // >50% overlap → skip
                            });
                            if (alreadyCovered) continue;

                            const text = this.getSnippet(content, start, actualEnd);

                            // Skip stale snippets — outdated code misleads AI
                            const currentHash = this.hashRange(content, anchor.startLine, anchor.endLine);
                            if (currentHash !== anchor.snippetHash) continue;

                            const snippet = `// Lines ${start}-${actualEnd}\n${text}`;
                            const snippetTokens = this.estimateTokens(snippet);
                            if (usedTokens + (fileHasSnippets ? 0 : headerTokens) + snippetTokens >= snippetCeiling) break;

                            if (!fileHasSnippets) {
                                snippetSectionParts.push(fileHeader);
                                usedTokens += headerTokens;
                                fileHasSnippets = true;
                            } else {
                                snippetSectionParts.push('\n...\n\n');
                            }
                            snippetSectionParts.push(snippet + '\n');
                            usedTokens += snippetTokens;
                            anchorCount++;
                            shownRanges.push({ start, end: actualEnd });
                        }

                        if (fileHasSnippets) {
                            snippetSectionParts.push(fileFooter);
                        } else {
                            // All anchors stale — fallback to file start
                            snippets.push(this.getSnippet(content, 1, Math.min(40, snippetMaxLines)));
                        }
                    } else {
                        // No evidence anchors — fallback to file start
                        snippets.push(this.getSnippet(content, 1, Math.min(40, snippetMaxLines)));
                    }

                    // Emit fallback block if we gathered any fallback content
                    if (snippets.length > 0) {
                        const fallbackBlock = `${fileHeader}${snippets[0]}\n${fileFooter}`;
                        const tokens = this.estimateTokens(fallbackBlock);
                        if (usedTokens + tokens < snippetCeiling) {
                            usedTokens += tokens;
                            snippetSectionParts.push(fallbackBlock);
                        }
                    }
                }
            } catch (e) {
                // ignore missing files
            }
        }
        // Use join('') since each part already contains correct newlines — join('\n') creates double-newlines
        // which break the eval regex /```[a-z]+\n\/\/ Lines/ for snippet counting
        sections.push(snippetSectionParts.join(''));

        // --- P3: Flow Overview (v3) ---
        const flowSectionParts: string[] = ['\n## Flow Overview\n'];
        let flowEntries = 0;
        const seenFlowTexts = new Set<string>(); // dedup flows with identical call chains

        for (const card of fileCards) {
            const flows = this.store.getFlowCardsForFile(card.fileId);
            if (flows.length === 0) continue;

            for (const flow of flows.slice(0, 3)) {
                if (!flow.evidenceAnchorIds || flow.evidenceAnchorIds.length === 0) continue;
                const flowText = flow.trace.map(step => step.symbolName).join(' -> ');
                if (seenFlowTexts.has(flowText)) continue; // skip duplicate call chains
                seenFlowTexts.add(flowText);

                const flowClaim = prover.applyPolicy([
                    {
                        text: flowText,
                        evidenceIds: flow.evidenceAnchorIds.slice(0, 3),
                        fileId: card.fileId
                    }
                ], proofPolicy, 3);
                if (flowClaim.length === 0) continue;
                const text = `- ${renderClaim(flowClaim[0], 'F')}\n`;
                const tokens = this.estimateTokens(text);

                if (usedTokens + tokens < tokenBudget) {
                    usedTokens += tokens;
                    flowSectionParts.push(text);
                    flowEntries++;
                }
            }
        }

        if (flowEntries === 0 && tokenBudget >= 6000) {
            for (const card of fileCards) {
                const fallbackTrace = this.buildFallbackFlowTrace(card.fileId);
                if (!fallbackTrace) continue;

                const fallbackTokens = this.estimateTokens(fallbackTrace);
                if (usedTokens + fallbackTokens < tokenBudget) {
                    usedTokens += fallbackTokens;
                    flowSectionParts.push(fallbackTrace);
                    flowEntries++;
                }
                break;
            }
        }

        if (flowEntries > 0) {
            sections.push(flowSectionParts.join(''));
        }

        // --- P3.5: Invariants & Contracts (v3) ---
        const invariantSectionParts: string[] = ['\n## Invariants & Contracts\n'];
        let invariantEntries = 0;
        for (const card of fileCards) {
            const claims = card.level2?.invariants || [];
            if (claims.length === 0) continue;

            for (const claim of claims.slice(0, 4)) {
                if (!claim.evidenceAnchorIds || claim.evidenceAnchorIds.length === 0) continue;
                const proven = prover.applyPolicy([
                    { text: claim.text, evidenceIds: claim.evidenceAnchorIds.slice(0, 2), fileId: card.fileId }
                ], proofPolicy, 2);
                if (proven.length === 0) continue;
                const text = `- ${renderClaim(proven[0])}\n`;
                const tokens = this.estimateTokens(text);
                if (usedTokens + tokens < tokenBudget) {
                    usedTokens += tokens;
                    invariantSectionParts.push(text);
                    invariantEntries++;
                }
            }
        }
        if (invariantEntries > 0) {
            sections.push(invariantSectionParts.join(''));
        }

        // --- P4: Relevant Symbols ---
        const symbolSectionParts: string[] = ['\n## Relevant Symbols\n'];
        const seenSymbols = new Set<string>();

        for (const card of fileCards) {
            const symbols = this.store.getSymbolsForFile(card.fileId);
            if (symbols.length === 0) continue;

            // Sort: Public first, then by name
            symbols.sort((a, b) => {
                if (a.visibility !== b.visibility) return a.visibility === 'public' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            // Dedup & Limit
            const uniqueSymbols = [];
            for (const sym of symbols) {
                const key = `${sym.name}:${sym.signature}`;
                if (!seenSymbols.has(key)) {
                    seenSymbols.add(key);
                    uniqueSymbols.push(sym);
                }
            }

            // Cap symbols per file to save tokens
            const MAX_SYMBOLS_PER_FILE = 20;
            const finalSymbols = uniqueSymbols.slice(0, MAX_SYMBOLS_PER_FILE);

            if (finalSymbols.length === 0) continue;

            const symbolText = finalSymbols.map(s => `- ${s.name} (${s.kind}): ${s.signature}`).join('\n') + '\n';
            const tokens = this.estimateTokens(symbolText);

            if (usedTokens + tokens < tokenBudget) {
                usedTokens += tokens;
                symbolSectionParts.push(symbolText);
            }
        }
        if (symbolSectionParts.length > 1) {
            sections.push(symbolSectionParts.join('\n'));
        }

        // --- P4.5: Call Chain Summary ---
        const callChainParts: string[] = ['\n## Call Chain Summary\n'];

        // We only care about calls originating from the selected files/symbols
        for (const card of fileCards) {
            const symbols = this.store.getSymbolsForFile(card.fileId);
            for (const sym of symbols) {
                const refs = this.store.getRefsFrom(sym.id).filter((r: any) => r.kind === 'call');
                if (refs.length > 0) {
                    // Dedup targets
                    const targets = Array.from(new Set(refs.map((r: any) => r.toName))).slice(0, 5); // Limit 5 calls per symbol
                    const evidenceIds = refs.map((r: any) => r.anchorId).filter(Boolean).slice(0, 3);
                    const proven = prover.applyPolicy([{ text: `${sym.name} calls: ${targets.join(', ')}`, evidenceIds, fileId: card.fileId }], proofPolicy, 2);
                    if (proven.length === 0) continue;
                    const text = `- ${renderClaim(proven[0])}\n`;

                    const tokens = this.estimateTokens(text);
                    if (usedTokens + tokens < tokenBudget) {
                        usedTokens += tokens;
                        callChainParts.push(text);
                    }
                }
            }
        }
        if (callChainParts.length > 1) {
            sections.push(callChainParts.join(''));
        }

        // --- Footer ---
        const footer = `\n## Token Report\nUsed: ~${usedTokens} / ${tokenBudget}\n`;
        sections.push(footer);

        return sections.join('');
    }

    private resolveCandidates(fileIds: string[], includeDts: boolean): string[] {
        // Fetch paths to check extensions
        const fileMap = new Map<string, { id: string, path: string }>();

        for (const id of fileIds) {
            const card = this.store.getFileCard(id);
            if (card) {
                fileMap.set(card.path, { id, path: card.path });
            }
        }

        const resolved = new Set<string>();
        const paths = Array.from(fileMap.values());

        // Preference: .ts > .tsx > .js > .jsx > .d.ts
        const basenames = new Set(paths.map(p => path.basename(p.path, path.extname(p.path))));

        for (const base of basenames) {
            // Find all variants (same name, different extension)
            const variants = paths.filter(p => path.basename(p.path, path.extname(p.path)) === base);

            variants.sort((a, b) => this.getExtScore(a.path) - this.getExtScore(b.path));

            const top = variants[0];
            if (top) {
                // Exclude d.ts if not requested and if meaningful alternative exists? 
                // Logic: only exclude d.ts if includeDts is false AND it is a d.ts file.
                // But wait, if .ts exists, .d.ts won't be top because of score.
                // So we just check if top is allowed.
                if (includeDts || !top.path.endsWith('.d.ts')) {
                    resolved.add(top.id);
                }
            }
        }

        return Array.from(resolved);
    }

    private getExtScore(p: string): number {
        if (p.endsWith('.ts')) return 1;
        if (p.endsWith('.tsx')) return 2;
        if (p.endsWith('.js')) return 3;
        if (p.endsWith('.jsx')) return 4;
        if (p.endsWith('.d.ts')) return 99;
        return 10;
    }

    private formatFileCard(card: FileCard, prover: ClaimProver, policy: EvidencePolicy): string {
        let text = `\n### [File] ${path.basename(card.path)}\n`;
        text += `- Path: ${card.path}\n`;
        const purposeClaim = prover.applyPolicy([
            {
                text: card.level1?.purpose || card.level0.purpose,
                evidenceIds: card.level1?.evidenceAnchorIds || [],
                fileId: card.fileId
            }
        ], policy, 2);
        if (purposeClaim.length > 0) {
            text += `- Purpose: ${renderClaim(purposeClaim[0])}\n`;
        }
        if (card.level1?.publicApi?.length) {
            const api = card.level1.publicApi;
            const shown = api.slice(0, 8);
            const more = api.length > 8 ? ` +${api.length - 8} more` : '';
            text += `- Public API: ${shown.join(', ')}${more}\n`;
        }
        if (card.level2?.envDependencies?.length) {
            const envList = card.level2.envDependencies.slice(0, 4).map(dep => `${dep.source}:${dep.name}`);
            text += `- Env Dependencies: ${envList.join(', ')}\n`;
        }
        // Phase 21: AI Change trail (best-effort, inside FILE_CARDS_BUDGET_CAP)
        try {
            const changes = this.store.getChangesForFile(card.path, 1);
            if (changes.length > 0) {
                const change = changes[0];
                if (change.createdAt) {
                    // Append ' UTC' for timezone-safe parsing (SQLite stores UTC without marker)
                    const createdMs = new Date(change.createdAt + ' UTC').getTime();
                    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
                    if (!isNaN(createdMs) && createdMs >= Date.now() - ninetyDaysMs) {
                        const dateStr = change.createdAt.slice(0, 10);
                        text += `- AI Change: ${change.summary} [${change.changeType} \u00b7 ${dateStr}]\n`;
                        text += `  Why: ${change.why}\n`;
                    }
                }
            }
        } catch { /* no agent_changes table yet — safe to skip */ }
        return text;
    }

    private getSnippet(content: string, start: number, end: number): string {
        const lines = content.split('\n');
        return lines.slice(start - 1, end).join('\n');
    }

    // Helper to calculate hash
    private hashRange(content: string, startLine: number, endLine: number): string {
        const lines = content.split('\n');
        // slice is end-exclusive, but we want inclusive endLine for snippet
        // startLine is 1-indexed
        const snippet = lines.slice(startLine - 1, endLine).join('\n');
        return crypto.createHash('sha256').update(snippet).digest('hex');
    }

    private buildProjectMap(candidateIds: string[]): string {
        // Build a compact tree view from candidate file paths
        const paths: string[] = [];
        for (const id of candidateIds) {
            const card = this.store.getFileCard(id);
            if (card) paths.push(card.path);
        }
        if (paths.length === 0) return '(no files)';

        // Paths are already relative — just normalize and sort
        const relPaths = paths.map(p => p.replace(/\\/g, '/')).sort();

        // Group by directory
        const dirs = new Map<string, string[]>();
        for (const rel of relPaths) {
            const dir = path.dirname(rel) === '.' ? '.' : path.dirname(rel);
            if (!dirs.has(dir)) dirs.set(dir, []);
            dirs.get(dir)!.push(path.basename(rel));
        }

        const lines: string[] = [];
        const root = './';
        lines.push('```');
        lines.push(root);
        const dirEntries = Array.from(dirs.entries()).sort();
        for (let i = 0; i < dirEntries.length; i++) {
            const [dir, files] = dirEntries[i];
            const isLast = i === dirEntries.length - 1;
            if (dir !== '.') {
                lines.push(`${isLast ? '└── ' : '├── '}${dir}/`);
            }
            const indent = dir === '.' ? '' : (isLast ? '    ' : '│   ');
            for (let j = 0; j < files.length; j++) {
                const fileIsLast = j === files.length - 1 && (isLast || dir === '.');
                const connector = dir === '.' ? (j === files.length - 1 && isLast ? '└── ' : '├── ') : (j === files.length - 1 ? '└── ' : '├── ');
                lines.push(`${indent}${connector}${files[j]}`);
            }
        }
        lines.push('```');
        return lines.join('\n');
    }

    private estimateTokens(text: string): number {
        // Code averages ~1 token per 3 chars; add 15% safety margin
        return Math.ceil(text.length / 3 * 1.15);
    }

    private buildFallbackFlowTrace(fileId: string): string | undefined {
        const symbols = this.store.getSymbolsForFile(fileId);
        for (const symbol of symbols) {
            const callRef = this.store
                .getRefsFrom(symbol.id)
                .find((r: any) => r.kind === 'call' && !!r.anchorId);

            if (!callRef || !callRef.anchorId) continue;
            if (!this.store.getAnchor(callRef.anchorId)) continue;

            return `- ${renderClaim({ text: `${symbol.name} -> ${callRef.toName}`, evidenceIds: [callRef.anchorId], status: 'PROVEN' }, 'F')}\n`;
        }
        return undefined;
    }
}
