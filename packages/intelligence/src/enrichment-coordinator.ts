// packages/intelligence/src/enrichment-coordinator.ts
import type { Store } from '@atlasmemory/store';
import type { Level3FileCard } from '@atlasmemory/core';
import type { EnrichmentBackend, EnrichmentInput, EnrichmentResult } from './enrichment-backend.js';
import { ClaudeCliBackend } from './backends/claude-cli.js';
import { AnthropicSdkBackend } from './backends/anthropic-sdk.js';
import { buildEnrichmentPrompt } from './enrichment-prompt.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const MAX_SNIPPET_LINES = 120;
const MAX_RESPONSE_TOKENS = 300;

export type EnrichmentProgress = (done: number, total: number, filePath: string) => void;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class EnrichmentCoordinator {
    private backends: EnrichmentBackend[];
    private activeBackend: EnrichmentBackend | null = null;

    constructor(
        private store: Store,
        backends?: EnrichmentBackend[],
    ) {
        // Default backends: CLI (free) → API (paid)
        this.backends = backends || [
            new ClaudeCliBackend(),
            new AnthropicSdkBackend(),
        ];
    }

    /** Detect the best available backend. Returns null if none available. */
    async detectBackend(): Promise<EnrichmentBackend | null> {
        if (this.activeBackend) return this.activeBackend;
        for (const backend of this.backends) {
            try {
                if (await backend.isAvailable()) {
                    this.activeBackend = backend;
                    return backend;
                }
            } catch {
                // Skip unavailable backends
            }
        }
        return null;
    }

    /** Returns true if an AI backend is available (CLI or API) */
    async hasAiBackend(): Promise<boolean> {
        return (await this.detectBackend()) !== null;
    }

    async enrichIfNeeded(fileIds: string[]): Promise<void> {
        const needsEnrichment = fileIds.filter(id => {
            const card = this.store.getFileCard(id);
            return !card?.level3;
        });

        if (needsEnrichment.length === 0) return;

        const backend = await this.detectBackend();
        const batch = needsEnrichment.slice(0, 3);

        for (const fileId of batch) {
            try {
                if (backend) {
                    await this.enrichFileWithBackend(fileId, backend);
                } else {
                    this.enrichDeterministic(fileId);
                }
            } catch (e) {
                process.stderr.write(`[atlasmemory] Enrichment failed for ${fileId}: ${e}\n`);
            }
        }
    }

    async enrichBatch(limit: number = 10, forcedBackend?: string, onProgress?: EnrichmentProgress): Promise<{
        enriched: number;
        failed: number;
        skipped: number;
        mode: string;
        backend: string;
    }> {
        const files = this.store.getFiles();
        const unenriched = files.filter(f => {
            const card = this.store.getFileCard(f.id);
            return !card?.level3;
        }).slice(0, limit);

        let backend: EnrichmentBackend | null = null;

        if (forcedBackend) {
            backend = this.backends.find(b => b.name === forcedBackend) || null;
            if (backend && !(await backend.isAvailable())) {
                throw new Error(`Backend "${forcedBackend}" is not available`);
            }
        } else {
            backend = await this.detectBackend();
        }

        let enriched = 0;
        let failed = 0;

        if (backend && backend.enrichBatch) {
            // Batch mode: chunk files into groups of 5
            const BATCH_SIZE = 5;
            for (let i = 0; i < unenriched.length; i += BATCH_SIZE) {
                const chunk = unenriched.slice(i, i + BATCH_SIZE);
                const inputs: EnrichmentInput[] = chunk.map(f => this.prepareEnrichmentInput(f.id));

                try {
                    const results = await backend.enrichBatch(inputs, MAX_RESPONSE_TOKENS * BATCH_SIZE);
                    for (let j = 0; j < results.length; j++) {
                        try {
                            this.applyEnrichmentResult(chunk[j].id, results[j], backend.name);
                            enriched++;
                            onProgress?.(enriched, unenriched.length, chunk[j].path);
                        } catch (e) {
                            process.stderr.write(`[atlasmemory] Apply failed for ${chunk[j].path}: ${e}\n`);
                            failed++;
                        }
                    }
                } catch (e) {
                    // Batch failed — fallback to individual enrichment
                    process.stderr.write(`[atlasmemory] Batch enrichment failed, falling back to individual: ${e}\n`);
                    for (const file of chunk) {
                        try {
                            await this.enrichFileWithBackend(file.id, backend);
                            enriched++;
                            onProgress?.(enriched, unenriched.length, file.path);
                        } catch (e2) {
                            process.stderr.write(`[atlasmemory] Individual enrichment failed for ${file.path}: ${e2}\n`);
                            failed++;
                        }
                    }
                }
            }
        } else {
            // No batch support or no backend — per-file processing
            const delayMs = backend?.name === 'anthropic-sdk' ? 1000 : backend?.name === 'claude-cli' ? 500 : 0;
            for (let i = 0; i < unenriched.length; i++) {
                const file = unenriched[i];
                try {
                    if (backend) {
                        await this.enrichFileWithBackend(file.id, backend);
                    } else {
                        this.enrichDeterministic(file.id);
                    }
                    enriched++;
                    onProgress?.(enriched, unenriched.length, file.path);
                } catch (e) {
                    process.stderr.write(`[atlasmemory] Enrichment failed for ${file.path}: ${e}\n`);
                    failed++;
                }
                if (delayMs > 0 && i < unenriched.length - 1) {
                    await sleep(delayMs);
                }
            }
        }

        return {
            enriched,
            failed,
            skipped: files.length - unenriched.length,
            mode: backend ? 'ai' : 'deterministic',
            backend: backend?.name || 'deterministic',
        };
    }

    /** Prepare enrichment input for a file */
    private prepareEnrichmentInput(fileId: string): EnrichmentInput {
        const file = this.store.getFileById(fileId);
        const symbols = this.store.getSymbolsForFile(fileId);
        const imports = this.store.getImportsForFile(fileId);

        let codeSnippet = `(${symbols.length} symbols)`;
        try {
            const repoRoot = this.store.getRepoRoot();
            const absPath = path.resolve(repoRoot, file?.path || '');
            if (file && fs.existsSync(absPath)) {
                const content = fs.readFileSync(absPath, 'utf-8');
                codeSnippet = content.split('\n').slice(0, MAX_SNIPPET_LINES).join('\n');
            }
        } catch { /* fallback */ }

        return {
            filePath: file?.path || fileId,
            symbolSignatures: symbols.map(s => `${s.kind} ${s.name}: ${s.signature}`),
            importPaths: imports.map(i => i.importedModule),
            codeSnippet,
        };
    }

    /** Apply enrichment result to a file's card */
    private applyEnrichmentResult(fileId: string, result: EnrichmentResult, backendName: string): void {
        const level3: Level3FileCard = {
            intent: result.intent,
            solves: result.solves,
            tags: result.tags,
            breaks_if_changed: result.breaks_if_changed,
            security_notes: result.security_notes,
            complexity: result.complexity,
        };

        const existingCard = this.store.getFileCard(fileId);
        if (existingCard) {
            existingCard.level3 = level3;
            if (existingCard.level1?.notes === 'Awaiting AI enrichment') {
                existingCard.level1.notes = `Enriched by ${backendName}`;
            }
            existingCard.cardHash = crypto.createHash('sha256')
                .update(JSON.stringify(existingCard.level0) + JSON.stringify(existingCard.level1 || {}) + JSON.stringify(existingCard.level2 || {}) + JSON.stringify(level3))
                .digest('hex');
            this.store.addFileCard(existingCard);
        }

        this.store.upsertSemanticTags(fileId, level3.tags, level3.intent);
    }

    /** AI-powered enrichment using a backend */
    private async enrichFileWithBackend(fileId: string, backend: EnrichmentBackend): Promise<void> {
        const file = this.store.getFileById(fileId);
        if (!file) return;

        const symbols = this.store.getSymbolsForFile(fileId);
        const imports = this.store.getImportsForFile(fileId);

        // Read file content for snippet (resolve relative path against repo root)
        let codeSnippet = `(${symbols.length} symbols)`;
        try {
            const repoRoot = this.store.getRepoRoot();
            const absPath = path.resolve(repoRoot, file.path);
            if (fs.existsSync(absPath)) {
                const content = fs.readFileSync(absPath, 'utf-8');
                const lines = content.split('\n').slice(0, MAX_SNIPPET_LINES);
                codeSnippet = lines.join('\n');
            }
        } catch {
            // Use symbol summary as fallback
        }

        const prompt = buildEnrichmentPrompt({
            filePath: file.path,
            symbolSignatures: symbols.map(s => `${s.kind} ${s.name}: ${s.signature}`),
            importPaths: imports.map(i => i.importedModule),
            codeSnippet,
        });

        let response: string;
        try {
            response = await backend.enrich(prompt, MAX_RESPONSE_TOKENS);
        } catch (e) {
            process.stderr.write(`[atlasmemory] Backend ${backend.name} failed for ${file.path}: ${e}\n`);
            // Fallback to deterministic
            this.enrichDeterministic(fileId);
            return;
        }

        // Parse JSON response
        let parsed: any;
        try {
            // Strip markdown code fences if present
            const cleaned = response.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
            parsed = JSON.parse(cleaned);
        } catch {
            // Retry with stricter instruction
            try {
                const retryResponse = await backend.enrich(
                    prompt + '\n\nIMPORTANT: Return ONLY the raw JSON object. No markdown, no code fences, no explanation.',
                    MAX_RESPONSE_TOKENS,
                );
                const cleaned = retryResponse.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
                parsed = JSON.parse(cleaned);
            } catch {
                process.stderr.write(`[atlasmemory] Invalid JSON from ${backend.name} for ${file.path}, falling back to deterministic\n`);
                this.enrichDeterministic(fileId);
                return;
            }
        }

        if (!parsed.intent || !parsed.tags || !Array.isArray(parsed.tags)) {
            process.stderr.write(`[atlasmemory] Invalid Level3 card structure from ${backend.name} for ${file.path}\n`);
            this.enrichDeterministic(fileId);
            return;
        }

        const level3: Level3FileCard = {
            intent: String(parsed.intent),
            solves: String(parsed.solves || ''),
            tags: parsed.tags.map(String).slice(0, 15),
            breaks_if_changed: (parsed.breaks_if_changed || []).map(String),
            security_notes: parsed.security_notes ? String(parsed.security_notes) : null,
            complexity: ['low', 'medium', 'high'].includes(parsed.complexity) ? parsed.complexity : 'medium',
        };

        // Store Level3 on file card
        const existingCard = this.store.getFileCard(fileId);
        if (existingCard) {
            existingCard.level3 = level3;
            if (existingCard.level1?.notes === 'Awaiting AI enrichment') {
                existingCard.level1.notes = `Enriched by ${backend.name}`;
            }
            existingCard.cardHash = crypto.createHash('sha256')
                .update(JSON.stringify(existingCard.level0) + JSON.stringify(existingCard.level1 || {}) + JSON.stringify(existingCard.level2 || {}) + JSON.stringify(level3))
                .digest('hex');
            this.store.addFileCard(existingCard);
        }

        // Store semantic tags in FTS
        this.store.upsertSemanticTags(fileId, level3.tags, level3.intent);
    }

    /** Deterministic enrichment — no LLM needed. Extracts tags from path, symbols, imports. */
    enrichDeterministic(fileId: string): void {
        const file = this.store.getFileById(fileId);
        if (!file) return;

        const symbols = this.store.getSymbolsForFile(fileId);
        const imports = this.store.getImportsForFile(fileId);
        const card = this.store.getFileCard(fileId);

        const tags = new Set<string>();

        // 1. Path segments (last 3 dirs + filename without ext)
        const segments = file.path.replace(/\\/g, '/').split('/');
        const filename = path.basename(file.path).replace(/\.[^.]+$/, '');
        for (const seg of [...segments.slice(-4, -1), filename]) {
            this.splitIdentifier(seg).forEach(t => tags.add(t));
        }

        // 2. Symbol names (top 8)
        for (const sym of symbols.slice(0, 8)) {
            this.splitIdentifier(sym.name).forEach(t => tags.add(t));
        }

        // 3. External imports (package names only)
        for (const imp of imports) {
            if (imp.isExternal) {
                const pkg = imp.importedModule.replace(/^@[^/]+\//, '').split('/')[0];
                if (pkg.length > 2) tags.add(pkg.toLowerCase());
            }
        }

        const STOPWORDS = new Set(['src', 'lib', 'the', 'and', 'for', 'with', 'from', 'index', 'util', 'utils', 'type', 'types', 'main', 'app', 'base', 'new', 'get', 'set', 'has', 'add']);
        const cleanTags = [...tags]
            .filter(t => t.length > 2 && !STOPWORDS.has(t))
            .slice(0, 15);

        const intent = card?.level1?.purpose || card?.level0?.purpose || `${filename} module`;

        const level3: Level3FileCard = {
            intent: typeof intent === 'string' ? intent : `${filename} module`,
            solves: '',
            tags: cleanTags,
            breaks_if_changed: [],
            security_notes: null,
            complexity: 'medium',
        };

        if (card) {
            card.level3 = level3;
            if (card.level1?.notes === 'Awaiting AI enrichment') {
                card.level1.notes = 'Deterministically enriched';
            }
            this.store.addFileCard(card);
        }

        this.store.upsertSemanticTags(fileId, cleanTags, level3.intent);
    }

    private splitIdentifier(text: string): string[] {
        return text
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/[-_.]/g, ' ')
            .split(/\s+/)
            .map(t => t.toLowerCase())
            .filter(t => t.length > 2);
    }

    getEnrichmentCoverage(): { enriched: number; total: number; percentage: number } {
        const files = this.store.getFiles();
        const total = files.length;
        let enriched = 0;
        for (const file of files) {
            const card = this.store.getFileCard(file.id);
            if (card?.level3) enriched++;
        }
        return {
            enriched,
            total,
            percentage: total > 0 ? Math.round((enriched / total) * 100) : 0,
        };
    }

    getEnrichmentInvitation(): string {
        const coverage = this.getEnrichmentCoverage();
        if (coverage.percentage >= 100) return '';
        const remaining = coverage.total - coverage.enriched;
        return `\u{1F4A1} ${remaining} files can be enriched with semantic tags for better search. ` +
            `Use the \`enrich_files\` tool or run \`atlas enrich\` to add AI-generated concept tags.`;
    }
}
