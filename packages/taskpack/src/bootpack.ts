import { Store } from '@atlasmemory/store';
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
        const archClaims = prover.applyPolicy(
            projectCard.architectureBullets
                .slice(0, 8)
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

        const flowClaims = prover.applyPolicy(
            flows.slice(0, 10).map(flow => ({
                text: flow.trace.map(step => step.symbolName).join(' -> '),
                evidenceIds: flow.evidenceAnchorIds || [],
                fileId: flow.fileId
            })),
            proof,
            3
        );
        const flowLines = flowClaims.map(claim => renderClaim(claim, 'F')).join('\n');
        push(`## Top Flows (max 10)\n${flowLines || 'F:none'}\n`);

        const symbolLine = `S: ${Object.entries(symbolAliases).map(([k, v]) => `${k}=${v}`).join(' | ')}`;
        const entryClaims = prover.applyPolicy(
            projectCard.entrypoints.slice(0, 8).map((item, idx) => {
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

        const changedClaims = prover.applyPolicy(
            changedFiles
                .sort((a, b) => a.localeCompare(b))
                .slice(0, 30)
                .map(file => ({ text: file, scopePath: path.dirname(file) })),
            proof,
            2
        );
        const changedLines = changedClaims.map(claim => `- ${renderClaim(claim)}`).join('\n');
        push(`## Changed Files\n${changedLines || '- none'}\n`);

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

        const coverageClaim = prover.applyPolicy([
            {
                text: `indexed=${coverage.indexed}, discoverable=${coverage.discoverable}, ratio=${coverage.ratio.toFixed(3)}`,
                scopePath: process.cwd()
            }
        ], proof, 2);
        push(`## Coverage Summary\n${coverageClaim.map(claim => renderClaim(claim)).join('\n') || 'C:No coverage claim'}\n`);

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
        const lines = [
            '# AtlasMemory Session Handshake',
            '',
            '1) Always load bootpack first: atlas bootpack --budget 1500',
            '2) For each task: atlas taskpack "<objective>" --budget <n>',
            '3) If unsure, fetch evidence via anchorId/flowCardId before claiming details',
            '4) Do not hallucinate; cite evidence IDs in every non-trivial claim',
            '5) For updates, generate delta: atlas deltapack --since last --budget 800'
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
            const payload = `# Session Bootstrap (fresh)\n\n${boot.text}`;
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
        const entrypoints = ['CLI.index', 'CLI.taskpack', 'Indexer.parse', 'Store.scoredSearch', 'TaskPackBuilder.build'];
        const architectureBullets = [
            'P1 (@atlasmemory/core) defines shared cards, refs, anchors, and flow types',
            'P2 (@atlasmemory/indexer) parses TS/Python and extracts symbols, anchors, imports, and calls',
            'P3 (@atlasmemory/store) persists files/symbols/cards/flows in SQLite with FTS',
            'P4 (@atlasmemory/retrieval) runs search with FTS and fallback ranking',
            'P5 (@atlasmemory/taskpack) builds budgeted context packs for objectives',
            'P6/P7 expose CLI and MCP operational surfaces',
            'P8 (@atlasmemory/eval) measures recall, latency, and pack quality'
        ];

        const card = {
            id: 'singleton',
            purpose: 'AtlasMemory provides local-first repository memory with evidence-backed retrieval and task-focused context packs.',
            architectureBullets,
            invariants: [
                'Every non-trivial claim should map to evidence anchor IDs',
                'TaskPack assembly remains budget-aware and deterministic',
                'Coverage guard enforces indexed/discoverable threshold before smoke passes'
            ],
            entrypoints,
            keyFlowIds: flows.slice(0, 10).map(flow => flow.id),
            toolsProtocol: [
                'bootpack first, then taskpack for task execution',
                'use allowed evidence calls before asserting details',
                'validate and upsert cards through MCP when persisting memory'
            ],
            glossary: this.buildPathAliases(),
            cardHash: ''
        };

        const cardHash = crypto.createHash('sha256').update(JSON.stringify(card)).digest('hex');
        const finalCard = { ...card, cardHash };
        this.store.upsertProjectCard(finalCard);
        return finalCard;
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
                if (text.length < 4) continue;
                claims.push({ text, evidenceIds: invariant.evidenceAnchorIds, fileId: file.id });
                if (claims.length >= limit) return claims;
            }
        }
        return claims;
    }

    private buildPathAliases(): Record<string, string> {
        const preferred = [
            'packages/core/src',
            'packages/indexer/src',
            'packages/store/src',
            'packages/retrieval/src',
            'packages/taskpack/src',
            'apps/cli/src',
            'apps/mcp-server/src',
            'apps/eval/src'
        ];
        const aliases: Record<string, string> = {};
        preferred.forEach((item, index) => {
            aliases[`P${index + 1}`] = item;
        });
        return aliases;
    }

    private buildSymbolAliases(): Record<string, string> {
        const symbols = ['CLI.index', 'CLI.taskpack', 'Indexer.parse', 'Store.scoredSearch', 'TaskPackBuilder.build'];
        const aliases: Record<string, string> = {};
        symbols.forEach((item, index) => {
            aliases[`S${index + 1}`] = item;
        });
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
                    const isCode = lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.py');
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

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}
