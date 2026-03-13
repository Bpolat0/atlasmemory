import { Store } from '@atlasmemory/store';
import type { Claim } from '@atlasmemory/core';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ClaimProver, type EvidencePolicy, renderClaim } from './proof.js';

export interface PackOptions {
    budget: number;
    format?: 'capsule' | 'json';
    compress?: 'on' | 'off';
    proof?: EvidencePolicy;
}

export interface DeltaOptions {
    since: string;
    budget: number;
    format?: 'capsule' | 'json';
    sessionId?: string;
    proof?: EvidencePolicy;
}

export interface SessionBootstrapOptions {
    mode?: 'fresh' | 'resume';
    sessionId?: string;
    bootBudget?: number;
    deltaBudget?: number;
    compress?: boolean;
    format?: 'capsule' | 'json';
    maxBudget?: number;
}

interface RenderResult {
    text: string;
    tokens: number;
}

export class BootPackBuilder {
    constructor(private store: Store) {}

    buildBootPack(options: PackOptions): RenderResult {
        const budget = options.budget;
        const proof: EvidencePolicy = options.proof || 'strict';
        const prover = new ClaimProver(this.store);
        const projectCard = this.ensureProjectCard();
        const flows = this.store.getAllFlowCards().sort((a, b) => a.summary.localeCompare(b.summary)).slice(0, 10);
        const invariants = this.collectInvariants(10);
        const pathAliases = this.buildPathAliases();
        const symbolAliases = this.buildSymbolAliases();

        const sections: string[] = [];
        const push = (content: string) => {
            const candidate = sections.join('\n') + '\n' + content;
            if (this.estimateTokens(candidate) <= budget) {
                sections.push(content);
                return true;
            }
            return false;
        };

        push('# AtlasMemory BootPack v1 (<=1500 tokens)\n');
        const purposeClaim = prover.applyPolicy([{ text: projectCard.purpose, scopePath: process.cwd() }], proof, 3);
        push('## Purpose\n' + `${purposeClaim.map(c => renderClaim(c)).join('\n') || 'C:No proven purpose claim'}` + '\n');

        const mapLine = `P: ${Object.entries(pathAliases).map(([k, v]) => `${k}=${v}`).join(' | ')}`;
        // Regenerate fresh bullets so new packages (store, retrieval) always appear.
        // Don't rely on cached projectCard.architectureBullets — it was generated once and misses
        // small-but-critical packages like packages/store and packages/retrieval.
        const freshBullets = this.generateArchitectureBullets(pathAliases);
        const archClaims = prover.applyPolicy(
            freshBullets
                .map((claim, index) => {
                    const ev = this.archEvidence(index);
                    return { text: claim, evidenceIds: ev ? [ev] : [] };
                }),
            proof,
            3
        );
        const archLines = archClaims.map(claim => renderClaim(claim)).join('\n');
        push(`## Architecture Map\n${mapLine}\n\n${archLines}\n`);

        const invariantClaims = prover.applyPolicy(
            invariants.map(inv => ({ text: inv.text, evidenceIds: inv.evidenceIds, fileId: inv.fileId })),
            proof,
            3
        );
        const invariantLines = invariantClaims.map(claim => renderClaim(claim)).join('\n');
        push(`## Invariants & Contracts (max 10)\n${invariantLines || 'C:No invariants found'}\n`);

        // Dedup flows by call chain text before rendering
        const seenFlowTexts = new Set<string>();
        const uniqueFlows = flows.filter(flow => {
            const text = flow.trace.map(step => step.symbolName).join(' -> ');
            if (seenFlowTexts.has(text)) return false;
            seenFlowTexts.add(text);
            return true;
        });
        const flowClaims = prover.applyPolicy(
            uniqueFlows.slice(0, 10).map(flow => ({
                text: flow.trace.map(step => step.symbolName).join(' -> '),
                evidenceIds: flow.evidenceAnchorIds || [],
                fileId: flow.fileId
            })),
            proof,
            3
        );
        const flowLines = flowClaims.map(claim => renderClaim(claim, 'F')).join('\n');
        push(`## Top Flows (max 10)\n${flowLines || 'F:none'}\n`);

        // Use fresh symbolAliases (not cached projectCard.entrypoints which picked CLI internals).
        const symbolLine = `S: ${Object.entries(symbolAliases).map(([k, v]) => `${k}=${v}`).join(' | ')}`;
        const freshEntrypoints = Object.values(symbolAliases);
        const entryClaims = prover.applyPolicy(
            freshEntrypoints.slice(0, 8).map((item, idx) => {
                const ev = this.archEvidence(idx + 20);
                return {
                    text: item,
                    evidenceIds: ev ? [ev] : []
                };
            }),
            proof,
            2
        );
        const entryLines = entryClaims.map(claim => renderClaim(claim)).join('\n');
        push(`## Entrypoints / Public Surface (compact)\n${symbolLine}\n${entryLines}\n`);

        const protocolLines = projectCard.toolsProtocol.slice(0, 8).map((item, idx) => `T${idx + 1}: ${item}`).join('\n');
        push(`## Tool Protocol (agent rules)\n${protocolLines}\n`);

        const used = this.estimateTokens(sections.join('\n'));
        sections.push(`## Token Report\nUsed: ~${used} / ${budget}`);

        const text = sections.join('\n');
        if (options.format === 'json') {
            return {
                text: JSON.stringify({ type: 'bootpack', budget, tokens: this.estimateTokens(text), capsule: text }, null, 2),
                tokens: this.estimateTokens(text)
            };
        }

        return { text, tokens: this.estimateTokens(text) };
    }

    buildDeltaPack(options: DeltaOptions): RenderResult {
        const proof: EvidencePolicy = options.proof || 'warn';
        const prover = new ClaimProver(this.store);
        const since = this.resolveSince(options.since, options.sessionId);
        const gitChanged = this.getGitChangedFiles(options.since);
        let changedFiles = Array.from(new Set([...this.findChangedFiles(since), ...gitChanged]));
        if (changedFiles.length === 0) {
            const latest = this.store.getFilesWithMeta()
                .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
            if (latest) changedFiles = [latest.path];
        }
        const changedById = changedFiles
            .map(file => ({ file, fileId: this.store.getFileId(file) }))
            .filter(item => !!item.fileId) as { file: string; fileId: string }[];

        const affectedFlows = new Set<string>();
        for (const item of changedById) {
            const flows = this.store.getFlowCardsForFile(item.fileId);
            flows.forEach(flow => affectedFlows.add(flow.id));
        }
        if (affectedFlows.size === 0) {
            const firstFlow = this.store.getAllFlowCards().sort((a, b) => a.summary.localeCompare(b.summary))[0];
            if (firstFlow) affectedFlows.add(firstFlow.id);
        }

        const staleWarnings = this.getStaleWarnings();
        const coverage = this.computeCoverageSummary();

        const sections: string[] = [];
        const budget = options.budget;
        const push = (content: string) => {
            const candidate = sections.join('\n') + '\n' + content;
            if (this.estimateTokens(candidate) <= budget) {
                sections.push(content);
                return true;
            }
            return false;
        };

        push('# AtlasMemory DeltaPack v1\n');
        push(`## Since\nC:${options.since} resolved to ${since.toISOString()} | E:session_state:last_deltapack_at\n`);

        // Changed file paths are structural facts (the file IS changed),
        // not semantic claims. Pre-link to their own anchors as evidence.
        const changedClaims = changedFiles
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 30)
            .map(file => {
                const fileId = this.store.getFileId(file);
                const anchors = fileId ? this.store.getAnchorsForFile(fileId).slice(0, 2) : [];
                const evidenceIds = anchors.map(a => a.id);
                return {
                    text: file,
                    evidenceIds,
                    status: (evidenceIds.length > 0 ? 'PROVEN' : 'UNPROVEN') as 'PROVEN' | 'UNPROVEN',
                } satisfies Claim;
            });
        const changedLines = changedClaims.map(claim => `- ${renderClaim(claim)}`).join('\n');
        push(`## Changed Files\n${changedLines || '- none'}\n`);

        // Phase 21: Recent AI Decisions — placed RIGHT AFTER Changed Files
        // because for an AI agent, "why did this change" is more valuable than coverage stats
        try {
            const recentChanges = this.store.getRecentChanges(since, 20);
            if (recentChanges.length > 0) {
                const grouped = new Map<string, { id: string; summary: string; why: string; changeType: string }[]>();
                for (const change of recentChanges) {
                    for (const fp of change.filePaths) {
                        if (!grouped.has(fp)) grouped.set(fp, []);
                        const list = grouped.get(fp)!;
                        // Dedup: same change touching multiple files shouldn't repeat per-file
                        if (!list.some(c => c.id === change.id)) {
                            list.push(change);
                        }
                    }
                }
                const decisionLines: string[] = [];
                for (const [fp, changes] of grouped) {
                    decisionLines.push(`### ${fp}`);
                    for (const c of changes) {
                        decisionLines.push(`- ${c.summary} [${c.changeType}]`);
                        decisionLines.push(`  Why: ${c.why}`);
                    }
                }
                push(`## Recent AI Decisions\n${decisionLines.join('\n')}\n`);
            }
        } catch (e: any) {
            // Expected: no agent_changes table yet. Unexpected errors: log for debugging.
            if (e?.message && !e.message.includes('no such table')) {
                process.stderr.write(`[atlasmemory] agent_changes error: ${e.message}\n`);
            }
        }

        const flowClaims = prover.applyPolicy(
            Array.from(affectedFlows)
                .sort()
                .slice(0, 30)
                .map(id => {
                    const flow = this.store.getAllFlowCards().find(item => item.id === id);
                    return {
                        text: flow?.summary || id,
                        evidenceIds: flow?.evidenceAnchorIds || [],
                        fileId: flow?.fileId
                    };
                }),
            proof,
            2
        );
        const flowLines = flowClaims.map(claim => `- ${renderClaim(claim, 'F')}`).join('\n');
        push(`## Affected Flows\n${flowLines || '- none'}\n`);

        const staleLines = staleWarnings.slice(0, 20).map(w => `- ${w}`).join('\n');
        push(`## Stale Warnings\n${staleLines || '- none'}\n`);

        // Coverage is a computed metric, not a semantic claim that needs proof.
        const coverageText = `indexed=${coverage.indexed}, discoverable=${coverage.discoverable}, ratio=${coverage.ratio.toFixed(3)}`;
        push(`## Coverage Summary\nC:${coverageText} | E:coverage_computed\n`);

        const missingDirLines = coverage.topMissingDirs.map(item => `- ${item.dir}: ${item.count}`).join('\n');
        push(`## Top Missing Directories\n${missingDirLines || '- none'}\n`);

        const missingExtLines = coverage.topMissingExts.map(item => `- ${item.ext}: ${item.count}`).join('\n');
        push(`## Top Missing Extensions\n${missingExtLines || '- none'}\n`);

        this.store.setState('last_deltapack_at', new Date().toISOString(), options.sessionId);

        const used = this.estimateTokens(sections.join('\n'));
        sections.push(`## Token Report\nUsed: ~${used} / ${budget}`);

        const text = sections.join('\n');
        if (options.format === 'json') {
            return {
                text: JSON.stringify({
                    type: 'deltapack',
                    budget,
                    tokens: this.estimateTokens(text),
                    since: since.toISOString(),
                    changedFiles,
                    affectedFlowIds: Array.from(affectedFlows),
                    capsule: text
                }, null, 2),
                tokens: this.estimateTokens(text)
            };
        }

        return { text, tokens: this.estimateTokens(text) };
    }

    buildHandshake(budget: number): RenderResult {
        const enrichableCount = this.countEnrichableCards();

        const lines = [
            '# AtlasMemory Session Handshake',
            '',
            '1) Call build_context(mode="project") first for project overview',
            '2) For each task: build_context(mode="task", objective="...") with appropriate budget',
            '3) If unsure, call get_allowed_evidence before asserting file details',
            '4) Do not hallucinate; cite evidence IDs in every non-trivial claim',
            '5) For updates: build_context(mode="delta", since="last") to see what changed',
            '6) After making file changes: call log_decision(files, summary, why, type)',
            ...(enrichableCount > 0 ? [
                '',
                `## Memory Enrichment Available`,
                `${enrichableCount} file(s) have auto-generated descriptions waiting for AI enrichment.`,
                `To enrich: call refresh_cards_for_changed_files, then for each file:`,
                `  1. Read the file and understand its purpose`,
                `  2. Call upsert_file_card with a rich level1 (purpose, publicApi, sideEffects, dependencies)`,
                `This makes the project memory smarter for all future sessions.`
            ] : [])
        ];

        let text = lines.join('\n');
        while (this.estimateTokens(text) > budget && lines.length > 3) {
            lines.pop();
            text = lines.join('\n');
        }

        return { text, tokens: this.estimateTokens(text) };
    }

    buildSessionBootstrap(options: SessionBootstrapOptions = {}): RenderResult {
        const mode = options.mode || 'fresh';
        const bootBudget = options.bootBudget ?? 1500;
        const deltaBudget = options.deltaBudget ?? 800;
        const maxBudget = options.maxBudget ?? (bootBudget + deltaBudget);
        const format = options.format || 'capsule';

        const boot = this.buildBootPack({
            budget: bootBudget,
            format: 'capsule',
            compress: options.compress === false ? 'off' : 'on',
            proof: 'strict'
        });

        if (mode === 'fresh') {
            const enrichable = this.countEnrichableCards();
            const enrichSection = enrichable > 0
                ? `\n\n## Action: Enrich Memory\n${enrichable} file(s) have auto-generated descriptions. Improve them:\n1. Call \`refresh_cards_for_changed_files\` to get the list\n2. For each file, read it and call \`upsert_file_card\` with rich descriptions\nThis is optional but makes future sessions much smarter.`
                : '';
            const payload = `# Session Bootstrap (fresh)\n\n${boot.text}${enrichSection}`;
            if (format === 'json') {
                return {
                    text: JSON.stringify({
                        type: 'session_bootstrap',
                        mode,
                        tokens: this.estimateTokens(payload),
                        capsule: payload
                    }, null, 2),
                    tokens: this.estimateTokens(payload)
                };
            }
            return { text: payload, tokens: this.estimateTokens(payload) };
        }

        const delta = this.buildDeltaPack({
            since: 'last',
            budget: deltaBudget,
            format: 'capsule',
            sessionId: options.sessionId,
            proof: 'strict'
        });

        const sections = ['# Session Bootstrap (resume)', '', '## Delta (priority)', delta.text, '', '## BootPack', boot.text];
        let merged = sections.join('\n');

        while (this.estimateTokens(merged) > maxBudget && sections.length > 4) {
            sections.pop();
            merged = sections.join('\n');
        }

        if (format === 'json') {
            return {
                text: JSON.stringify({
                    type: 'session_bootstrap',
                    mode,
                    tokens: this.estimateTokens(merged),
                    maxBudget,
                    capsule: merged
                }, null, 2),
                tokens: this.estimateTokens(merged)
            };
        }

        return { text: merged, tokens: this.estimateTokens(merged) };
    }

    proveClaim(
        claimText: string,
        scopePath?: string,
        maxEvidence: number = 5,
        options: {
            sessionId?: string;
            diversity?: boolean;
            proofMode?: 'strict' | 'warn' | 'off';
            proofBudget?: number;
            contractHash?: string;
        } = {}
    ) {
        const single = this.proveClaims(
            [{ text: claimText, scopePath }],
            maxEvidence,
            {
                sessionId: options.sessionId,
                diversity: options.diversity,
                proofMode: options.proofMode,
                proofBudget: options.proofBudget,
                contractHash: options.contractHash
            }
        );
        return {
            ...single.results[0],
            metadata: single.metadata
        };
    }

    proveClaims(
        claims: Array<{ text: string; scopePath?: string }>,
        maxEvidence: number = 5,
        options: {
            sessionId?: string;
            diversity?: boolean;
            proofMode?: 'strict' | 'warn' | 'off';
            proofBudget?: number;
            contractHash?: string;
        } = {}
    ) {
        const prover = new ClaimProver(this.store);
        const proofMode = options.proofMode || 'strict';
        const proofBudget = options.proofBudget ?? 2500;

        const normalize = (text: string) => (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const getScope = (scopePath?: string) => scopePath ? path.resolve(scopePath).toLowerCase() : '';
        const registryKeyFor = (text: string, scopePath?: string) => {
            const payload = `${normalize(text)}|${getScope(scopePath)}|${proofMode}`;
            const digest = crypto.createHash('sha256').update(payload).digest('hex');
            return { digest, key: `claim_registry:${digest}` };
        };

        const dedupKeyToProofInput = new Map<string, { text: string; scopePath?: string; fileIdHint?: string }>();
        const cachedByKey = new Map<string, any>();
        let cacheHits = 0;

        for (const claim of claims) {
            const { digest, key } = registryKeyFor(claim.text, claim.scopePath);
            const cached = this.store.getState(key, options.sessionId);
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    if (parsed && Array.isArray(parsed.evidenceIds)) {
                        cachedByKey.set(digest, parsed);
                        cacheHits++;
                        continue;
                    }
                } catch {
                    // ignore invalid cache
                }
            }

            if (!dedupKeyToProofInput.has(digest)) {
                const fileIdHint = claim.scopePath ? this.store.getFileId(path.resolve(claim.scopePath)) : undefined;
                dedupKeyToProofInput.set(digest, {
                    text: claim.text,
                    scopePath: claim.scopePath,
                    fileIdHint
                });
            }
        }

        const proofInputs = Array.from(dedupKeyToProofInput.values());
        const proved = prover.proveClaims(proofInputs, maxEvidence, {
            diversity: options.diversity === true,
            proofMode,
            proofBudget
        });

        const provenByKey = new Map<string, any>();
        proofInputs.forEach((input, index) => {
            const { digest, key } = registryKeyFor(input.text, input.scopePath);
            const proof = proved.results[index];
            const registryValue = {
                status: proof.claim.status,
                evidenceIds: proof.claim.evidenceIds,
                bestEvidenceId: proof.claim.evidenceIds[0],
                provenAt: new Date().toISOString(),
                contractHash: options.contractHash
            };
            this.store.setState(key, JSON.stringify(registryValue), options.sessionId);
            provenByKey.set(digest, {
                claim: proof.claim,
                candidates: proof.candidates,
                omitted: proof.omitted === true,
                proofWorkUnitsUsed: proof.proofWorkUnitsUsed || 0,
                cacheHit: false,
                registryKey: digest
            });
        });

        const orderedResults = claims.map((claim) => {
            const { digest } = registryKeyFor(claim.text, claim.scopePath);
            if (cachedByKey.has(digest)) {
                const cached = cachedByKey.get(digest);
                return {
                    claim: {
                        text: claim.text,
                        evidenceIds: cached.evidenceIds || [],
                        status: cached.status || ((cached.evidenceIds || []).length > 0 ? 'PROVEN' : 'UNPROVEN')
                    },
                    candidates: [],
                    omitted: proofMode === 'strict' && (cached.evidenceIds || []).length === 0,
                    proofWorkUnitsUsed: proved.proofWorkUnitsUsed,
                    cacheHit: true,
                    registryKey: digest
                };
            }
            return provenByKey.get(digest);
        });

        return {
            results: orderedResults,
            metadata: {
                requested: claims.length,
                executed: proofInputs.length,
                cacheHits,
                proofWorkUnitsUsed: proved.proofWorkUnitsUsed,
                proofBudget
            }
        };
    }

    private ensureProjectCard() {
        const existing = this.store.getProjectCard('singleton');
        if (existing) return existing;

        const flows = this.store.getAllFlowCards().sort((a, b) => a.summary.localeCompare(b.summary));
        const pathAliases = this.buildPathAliases();
        const symbolAliases = this.buildSymbolAliases();

        // Generate architecture bullets dynamically from actual indexed data
        const architectureBullets = this.generateArchitectureBullets(pathAliases);
        const entrypoints = Object.values(symbolAliases);

        // Generate purpose from folder cards or file cards
        const purpose = this.generateProjectPurpose();

        const card = {
            id: 'singleton',
            purpose,
            architectureBullets,
            invariants: this.collectInvariants(3).map(inv => inv.text),
            entrypoints,
            keyFlowIds: flows.slice(0, 10).map(flow => flow.id),
            toolsProtocol: [
                'bootpack first, then taskpack for task execution',
                'use allowed evidence calls before asserting details',
                'validate and upsert cards through MCP when persisting memory'
            ],
            glossary: pathAliases,
            cardHash: ''
        };

        const cardHash = crypto.createHash('sha256').update(JSON.stringify(card)).digest('hex');
        const finalCard = { ...card, cardHash };
        this.store.upsertProjectCard(finalCard);
        return finalCard;
    }

    private generateArchitectureBullets(pathAliases: Record<string, string>): string[] {
        const bullets: string[] = [];
        const files = this.store.getFiles();

        for (const [alias, dir] of Object.entries(pathAliases)) {
            const dirFiles = files.filter(f => {
                const rel = path.relative(process.cwd(), f.path).replace(/\\/g, '/');
                return rel.startsWith(dir);
            });

            if (dirFiles.length === 0) continue;

            // Get top symbols for this directory (dedup by name)
            const topSymbols: string[] = [];
            const seenNames = new Set<string>();
            for (const file of dirFiles.slice(0, 5)) {
                const symbols = this.store.getSymbolsForFile(file.id);
                for (const sym of symbols) {
                    if (sym.visibility === 'public' && !seenNames.has(sym.name) && topSymbols.length < 3) {
                        seenNames.add(sym.name);
                        topSymbols.push(sym.name);
                    }
                }
            }

            const desc = topSymbols.length > 0
                ? `${alias} (${dir}) contains ${dirFiles.length} files: ${topSymbols.join(', ')}`
                : `${alias} (${dir}) contains ${dirFiles.length} files`;
            bullets.push(desc);
        }

        return bullets;
    }

    private generateProjectPurpose(): string {
        // Try folder cards first
        try {
            const folderCards = this.store.db.prepare('SELECT folder_path, card_level0 FROM folder_cards LIMIT 3').all() as any[];
            if (folderCards.length > 0) {
                const purposes = folderCards
                    .map(fc => { try { return JSON.parse(fc.card_level0).purpose; } catch { return ''; } })
                    .filter(Boolean);
                if (purposes.length > 0) return purposes[0];
            }
        } catch { }

        // Fallback: count stats
        const files = this.store.getFiles();
        const symbols = this.store.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number };
        const langs = new Set(files.map(f => path.extname(f.path).slice(1)).filter(Boolean));
        return `Project with ${files.length} files, ${symbols.n} symbols (${Array.from(langs).join(', ')})`;
    }

    private collectInvariants(limit: number): Array<{ text: string; evidenceIds: string[]; fileId: string }> {
        const claims: Array<{ text: string; evidenceIds: string[]; fileId: string }> = [];
        const files = this.store.getFiles().sort((a, b) => a.path.localeCompare(b.path));
        for (const file of files) {
            const card = this.store.getFileCard(file.id);
            if (!card?.level2?.invariants) continue;
            for (const invariant of card.level2.invariants) {
                if (!invariant.evidenceAnchorIds || invariant.evidenceAnchorIds.length === 0) continue;
                const text = (invariant.text || '').trim();
                if (text.length < 10) continue;
                // Only keep real function/class contracts — skip variable declarations.
                // "Contract: const foo = []" is not a meaningful invariant for an AI agent.
                // A real contract has parameters: "Contract: function foo(x: T): R {"
                const signature = text.replace(/^Contract:\s*/, '');
                const isRealContract = /\(/.test(signature) && // has parameter list
                    !(/^const\s+\w+\s*=\s*[[\]{]/.test(signature)); // not a bare const array/obj
                if (!isRealContract) continue;
                claims.push({ text, evidenceIds: invariant.evidenceAnchorIds, fileId: file.id });
                if (claims.length >= limit) return claims;
            }
        }
        return claims;
    }

    private buildPathAliases(): Record<string, string> {
        // Dynamically discover top directories from indexed files
        const files = this.store.getFiles();
        const dirCounts = new Map<string, number>();
        for (const file of files) {
            const rel = path.relative(process.cwd(), file.path).replace(/\\/g, '/');
            const parts = rel.split('/');
            // Use top 2 levels as directory key (e.g., "src/components" or "packages/store/src")
            const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : (parts.length > 1 ? parts[0] : '.');
            dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
        }
        const sortedDirs = Array.from(dirCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12);

        const aliases: Record<string, string> = {};
        sortedDirs.forEach(([dir], index) => {
            aliases[`P${index + 1}`] = dir;
        });
        return aliases;
    }

    private buildSymbolAliases(): Record<string, string> {
        // Pick the most meaningful public classes as entry points.
        // Classes before functions; skip CLI/eval/test internals (they're not public API).
        const files = this.store.getFiles();
        const SKIP_DIRS = ['apps/cli', 'apps/eval', 'apps/vscode', '__tests__', 'test', 'spec'];
        const classes: string[] = [];
        const fns: string[] = [];
        const seenNames = new Set<string>();
        for (const file of files) {
            const rel = path.relative(process.cwd(), file.path).replace(/\\/g, '/');
            if (SKIP_DIRS.some(d => rel.startsWith(d))) continue;
            const symbols = this.store.getSymbolsForFile(file.id);
            for (const sym of symbols) {
                if (sym.visibility !== 'public' || seenNames.has(sym.name)) continue;
                if (sym.kind === 'class') { seenNames.add(sym.name); classes.push(sym.name); }
                else if (sym.kind === 'function') { seenNames.add(sym.name); fns.push(sym.name); }
            }
            if (classes.length + fns.length >= 10) break;
        }
        const top = [...classes, ...fns].slice(0, 5);
        const aliases: Record<string, string> = {};
        top.forEach((name, index) => { aliases[`S${index + 1}`] = name; });
        return aliases;
    }

    private archEvidence(seed: number): string {
        const files = this.store.getFiles().sort((a, b) => a.path.localeCompare(b.path));
        if (files.length === 0) return '';
        const file = files[seed % files.length];
        const anchor = this.store.getAnchorsForFile(file.id)[0];
        return anchor?.id || '';
    }

    private resolveSince(input: string, sessionId?: string): Date {
        if (input === 'last') {
            const state = this.store.getState('last_deltapack_at', sessionId);
            if (state) return new Date(state);
            return new Date(0);
        }

        const date = new Date(input);
        if (!Number.isNaN(date.getTime())) return date;

        return new Date(0);
    }

    private getGitChangedFiles(input: string): string[] {
        if (!input || input === 'last') return [];
        const parsed = new Date(input);
        if (!Number.isNaN(parsed.getTime())) return [];

        try {
            const output = execSync(`git diff --name-only ${input}..HEAD`, { encoding: 'utf-8' });
            return output
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map(rel => path.resolve(process.cwd(), rel));
        } catch {
            return [];
        }
    }

    private findChangedFiles(since: Date): string[] {
        const files = this.store.getFilesWithMeta();
        return files
            .filter(file => new Date(file.updatedAt).getTime() >= since.getTime())
            .map(file => file.path);
    }

    private getStaleWarnings(): string[] {
        const rows = this.store.db.prepare(`
            SELECT f.path as path, f.updated_at as file_updated, fc.updated_at as card_updated
            FROM files f
            LEFT JOIN file_cards fc ON fc.file_id = f.id
        `).all() as any[];

        const warnings: string[] = [];
        for (const row of rows) {
            if (!row.card_updated) {
                warnings.push(`${row.path}:missing_card`);
                continue;
            }
            if (new Date(row.file_updated).getTime() > new Date(row.card_updated).getTime()) {
                warnings.push(`${row.path}:stale_card`);
            }
        }
        return warnings.sort((a, b) => a.localeCompare(b));
    }

    private computeCoverageSummary(): {
        discoverable: number;
        indexed: number;
        ratio: number;
        topMissingDirs: Array<{ dir: string; count: number }>;
        topMissingExts: Array<{ ext: string; count: number }>;
    } {
        const indexed = this.store.getFilesWithMeta();
        const indexedSet = new Set(indexed.map(file => path.resolve(file.path).toLowerCase()));

        const discoverable: string[] = [];
        const walk = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.resolve(dir, entry.name);
                const normalized = full.replace(/\\/g, '/').toLowerCase();
                if (entry.isDirectory()) {
                    if (['node_modules', '.git', '.atlas', 'dist', 'build', 'coverage', 'out', '.cache', '.turbo'].includes(entry.name)) continue;
                    if (normalized.includes('/apps/eval/reports/')) continue;
                    walk(full);
                } else {
                    const lower = entry.name.toLowerCase();
                    const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.c', '.cpp', '.h', '.hpp', '.php'];
                    const isCode = codeExts.some(ext => lower.endsWith(ext));
                    const excluded = lower.endsWith('.d.ts') || lower.endsWith('.map') || /\.min\.[^./]+$/.test(lower);
                    if (isCode && !excluded) discoverable.push(full);
                }
            }
        };
        walk(process.cwd());

        const missing = discoverable.filter(file => !indexedSet.has(path.resolve(file).toLowerCase()));
        const dirCounts = new Map<string, number>();
        const extCounts = new Map<string, number>();
        missing.forEach(file => {
            const relDir = path.relative(process.cwd(), path.dirname(file)).replace(/\\/g, '/');
            const key = relDir || '.';
            dirCounts.set(key, (dirCounts.get(key) || 0) + 1);

            const ext = path.extname(file).toLowerCase() || '(none)';
            extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        });

        const discoverableCount = discoverable.length;
        const indexedCount = indexed.filter(file => discoverable.some(src => path.resolve(src).toLowerCase() === path.resolve(file.path).toLowerCase())).length;

        return {
            discoverable: discoverableCount,
            indexed: indexedCount,
            ratio: discoverableCount === 0 ? 1 : indexedCount / discoverableCount,
            topMissingDirs: Array.from(dirCounts.entries()).map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count).slice(0, 8),
            topMissingExts: Array.from(extCounts.entries()).map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count).slice(0, 8)
        };
    }

    countEnrichableCards(): number {
        try {
            // A card is enriched if it has level3 (deterministic/semantic) OR level1 without the placeholder
            const result = this.store.db.prepare(
                "SELECT COUNT(*) as n FROM file_cards WHERE card_level1 LIKE '%Awaiting AI enrichment%' AND (card_level3 IS NULL OR card_level3 = 'null')"
            ).get() as { n: number };
            return result.n;
        } catch {
            return 0;
        }
    }

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}
