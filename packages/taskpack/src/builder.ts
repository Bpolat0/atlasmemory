import { Store } from '@atlasmemory/store';
import type { FileCard } from '@atlasmemory/core';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ClaimProver, type EvidencePolicy, renderClaim } from './proof.js';

export class TaskPackBuilder {
    constructor(private store: Store) { }

    build(objective: string, initialFileIds: string[], tokenBudget: number = 12000, options: any = {}): string {
        const { includeDts = false, snippetMaxLines = 120, proof = 'strict', allowUnproven = false } = options;
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
        const objectiveClaim = prover.applyPolicy([{ text: objective, scopePath: process.cwd() }], proofPolicy, 3);
        const objectiveLine = objectiveClaim.map(claim => renderClaim(claim)).join('\n') || 'C:Objective omitted due to proof policy';
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
        const fileCards: FileCard[] = [];
        const fileSectionParts: string[] = ['## Relevant Files\n'];

        for (const fileId of candidates) {
            const card = this.store.getFileCard(fileId);
            if (!card) continue;
            fileCards.push(card);

            const cardText = this.formatFileCard(card, prover, proofPolicy);
            const tokens = this.estimateTokens(cardText);

            if (usedTokens + tokens < tokenBudget) {
                usedTokens += tokens;
                fileSectionParts.push(cardText);
            } else {
                fileSectionParts.push(`- ${card.path} (Omitted due to budget)\n`);
            }
        }
        sections.push(fileSectionParts.join('\n'));

        // --- P2.5: Flow Overview (v3) ---
        const flowSectionParts: string[] = ['\n## Flow Overview\n'];
        let flowEntries = 0;

        for (const card of fileCards) {
            const flows = this.store.getFlowCardsForFile(card.fileId);
            if (flows.length === 0) continue;

            for (const flow of flows.slice(0, 3)) {
                if (!flow.evidenceAnchorIds || flow.evidenceAnchorIds.length === 0) continue;
                const flowClaim = prover.applyPolicy([
                    {
                        text: flow.trace.map(step => step.symbolName).join(' -> '),
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

        // --- P2.6: Invariants & Contracts (v3) ---
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

        // --- P3: Relevant Symbols ---
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
        sections.push(symbolSectionParts.join('\n'));

        // --- P3.5: Call Chain Summary ---
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

        // --- P4: Evidence Snippets (Real Content) ---
        const snippetSectionParts: string[] = ['\n## Evidence Snippets\n'];

        for (const card of fileCards) {
            try {
                if (fs.existsSync(card.path)) {
                    const content = fs.readFileSync(card.path, 'utf-8');
                    const ext = path.extname(card.path).slice(1);

                    let snippets: string[] = [];

                    if (card.level1?.evidenceAnchorIds && card.level1.evidenceAnchorIds.length > 0) {
                        // Use Evidence Anchors
                        for (const anchorId of card.level1.evidenceAnchorIds) {
                            const anchor = this.store.getAnchor(anchorId);
                            if (!anchor) continue;

                            const start = Math.max(1, anchor.startLine - 1); // Context
                            const end = anchor.endLine + 1;
                            // Clamp size
                            const actualEnd = Math.min(start + snippetMaxLines, end);

                            const text = this.getSnippet(content, start, actualEnd);

                            // Check Staleness (Exact match on original range)
                            // Note: anchor.snippetHash was computed on lines [startLine, endLine] (1-indexed)
                            // We need to re-compute hash on strict range
                            const currentHash = this.hashRange(content, anchor.startLine, anchor.endLine);
                            const staleWarning = currentHash !== anchor.snippetHash ? ' // [WARNING: STALE - CONTENT CHANGED]' : '';

                            snippets.push(`// Lines ${start}-${actualEnd}${staleWarning}\n${text}`);
                        }
                    } else {
                        // Fallback: First N lines but mark as fallback
                        const fallbackLimit = 60;
                        const text = this.getSnippet(content, 1, Math.min(fallbackLimit, snippetMaxLines));
                        snippets.push(`// [Review Required] No Evidence Anchors (Fallback: File start)\n${text}`);
                    }

                    if (snippets.length > 0) {
                        const snippetBlock = `\n### ${path.basename(card.path)}\n\`\`\`${ext}\n${snippets.join('\n\n...\n\n')}\n\`\`\`\n`;
                        const tokens = this.estimateTokens(snippetBlock);

                        // Lower priority for snippets? Or strictly check budget
                        if (usedTokens + tokens < tokenBudget) {
                            usedTokens += tokens;
                            snippetSectionParts.push(snippetBlock);
                        }
                    }
                }
            } catch (e) {
                // ignore missing files
            }
        }
        sections.push(snippetSectionParts.join('\n'));

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
            text += `- Public API: ${card.level1.publicApi.join(', ')}\n`;
        }
        if (card.level2?.envDependencies?.length) {
            const envList = card.level2.envDependencies.slice(0, 4).map(dep => `${dep.source}:${dep.name}`);
            text += `- Env Dependencies: ${envList.join(', ')}\n`;
        }
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

        // Find common prefix
        const parts = paths.map(p => p.replace(/\\/g, '/').split('/'));
        let prefix = '';
        if (parts.length > 1) {
            const first = parts[0];
            let i = 0;
            while (i < first.length && parts.every(p => p[i] === first[i])) i++;
            prefix = first.slice(0, i).join('/');
        } else {
            prefix = parts[0].slice(0, -1).join('/');
        }

        // Build tree relative to prefix
        const relPaths = paths.map(p => {
            const rel = p.replace(/\\/g, '/').slice(prefix.length).replace(/^\//, '');
            return rel || path.basename(p);
        }).sort();

        // Group by directory
        const dirs = new Map<string, string[]>();
        for (const rel of relPaths) {
            const dir = path.dirname(rel) === '.' ? '.' : path.dirname(rel);
            if (!dirs.has(dir)) dirs.set(dir, []);
            dirs.get(dir)!.push(path.basename(rel));
        }

        const lines: string[] = [];
        const root = prefix ? path.basename(prefix) + '/' : './';
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
        return Math.ceil(text.length / 4);
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
