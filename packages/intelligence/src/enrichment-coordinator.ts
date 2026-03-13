// packages/intelligence/src/enrichment-coordinator.ts
import type { Store } from '@atlasmemory/store';
import type { SamplingClient, Level3FileCard } from '@atlasmemory/core';
import path from 'path';

const SAMPLING_PROMPT = `Analyze this source file and generate a structured intent card.

File: {path}
Exports: {symbolNames}
Imports: {importPaths}
Code (first 100 lines):
\`\`\`
{snippet}
\`\`\`

Return ONLY valid JSON:
{
  "intent": "one-sentence description of what this file does and WHY",
  "solves": "what problem this code solves",
  "tags": ["5-15 semantic search terms, synonyms, concepts"],
  "breaks_if_changed": ["file paths that would break if this file changes"],
  "security_notes": "security considerations or null",
  "complexity": "low|medium|high"
}`;

const MAX_BATCH_SIZE = 3;

export class EnrichmentCoordinator {
    constructor(
        private store: Store,
        private samplingClient: SamplingClient,
    ) {}

    canSample(): boolean {
        return this.samplingClient.canSample();
    }

    async enrichIfNeeded(fileIds: string[]): Promise<void> {
        const needsEnrichment = fileIds.filter(id => {
            const card = this.store.getFileCard(id);
            return !card?.level3;
        });

        if (needsEnrichment.length === 0) return;

        const batch = needsEnrichment.slice(0, MAX_BATCH_SIZE);

        for (const fileId of batch) {
            try {
                if (this.canSample()) {
                    await this.enrichFile(fileId);
                } else {
                    this.enrichDeterministic(fileId);
                }
            } catch (e) {
                process.stderr.write(`[atlasmemory] Enrichment failed for ${fileId}: ${e}\n`);
            }
        }
    }

    async enrichBatch(limit: number = 10): Promise<{ enriched: number; failed: number; skipped: number; mode: string }> {
        const files = this.store.getFiles();
        const unenriched = files.filter(f => {
            const card = this.store.getFileCard(f.id);
            return !card?.level3;
        }).slice(0, limit);

        let enriched = 0;
        let failed = 0;
        const useSampling = this.canSample();

        for (const file of unenriched) {
            try {
                if (useSampling) {
                    await this.enrichFile(file.id);
                } else {
                    this.enrichDeterministic(file.id);
                }
                enriched++;
            } catch (e) {
                failed++;
            }
        }

        return { enriched, failed, skipped: files.length - unenriched.length, mode: useSampling ? 'sampling' : 'deterministic' };
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

        // Store minimal level3 so this file is marked enriched
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
            // Clear the 'Awaiting AI enrichment' placeholder so AI Readiness Descriptions metric counts this file
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

    private async enrichFile(fileId: string): Promise<void> {
        const file = this.store.getFileById(fileId);
        if (!file) return;

        const symbols = this.store.getSymbolsForFile(fileId);
        const imports = this.store.getImportsForFile(fileId);

        const symbolNames = symbols.map(s => s.name).join(', ') || 'none';
        const importPaths = imports.map(i => i.importedModule).join(', ') || 'none';
        const snippet = `(${symbols.length} symbols: ${symbolNames})`;

        const prompt = SAMPLING_PROMPT
            .replace('{path}', file.path)
            .replace('{symbolNames}', symbolNames)
            .replace('{importPaths}', importPaths)
            .replace('{snippet}', snippet);

        const response = await this.samplingClient.requestCompletion(prompt, 500);

        let parsed: Level3FileCard;
        try {
            parsed = JSON.parse(response);
        } catch (e) {
            // Retry once with stricter instruction
            try {
                const retryResponse = await this.samplingClient.requestCompletion(
                    prompt + '\n\nIMPORTANT: Return ONLY the JSON object, no explanation or markdown.',
                    500,
                );
                parsed = JSON.parse(retryResponse);
            } catch {
                process.stderr.write(`[atlasmemory] Invalid JSON from sampling for ${file.path}\n`);
                return;
            }
        }

        if (!parsed.intent || !parsed.tags || !Array.isArray(parsed.tags)) {
            process.stderr.write(`[atlasmemory] Invalid Level3 card structure for ${file.path}\n`);
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
            const { createHash } = await import('crypto');
            existingCard.cardHash = createHash('sha256')
                .update(JSON.stringify(existingCard.level0) + JSON.stringify(existingCard.level1 || {}) + JSON.stringify(existingCard.level2 || {}) + JSON.stringify(level3))
                .digest('hex');
            this.store.addFileCard(existingCard);
        }

        // Store semantic tags in FTS
        this.store.upsertSemanticTags(fileId, level3.tags, level3.intent);
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
        return `💡 ${remaining} files can be enriched with semantic tags for better search. ` +
            `Use the \`enrich_files\` tool to add AI-generated intent cards and concept-level search tags.`;
    }
}
