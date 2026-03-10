// packages/intelligence/src/proactive-response.ts
import type { Store } from '@atlasmemory/store';
import type { ProactiveIntelligence } from '@atlasmemory/core';
import type { CodeHealthAnalyzer } from './code-health.js';
import type { EnrichmentCoordinator } from './enrichment-coordinator.js';
import type { ImpactAnalyzer } from './impact-analyzer.js';
import type { PrefetchEngine } from './prefetch-engine.js';

export interface IntelligenceServices {
    store: Store;
    codeHealth: CodeHealthAnalyzer;
    enrichmentCoordinator: EnrichmentCoordinator;
    impactAnalyzer: ImpactAnalyzer;
    prefetchEngine: PrefetchEngine;
}

export class ProactiveResponseBuilder {
    private store: Store;
    private codeHealth: CodeHealthAnalyzer;
    private enrichment: EnrichmentCoordinator;
    private impactAnalyzer: ImpactAnalyzer;
    private prefetchEngine: PrefetchEngine;

    constructor(services: IntelligenceServices) {
        this.store = services.store;
        this.codeHealth = services.codeHealth;
        this.enrichment = services.enrichmentCoordinator;
        this.impactAnalyzer = services.impactAnalyzer;
        this.prefetchEngine = services.prefetchEngine;
    }

    gather(fileIds: string[]): ProactiveIntelligence {
        const intel: ProactiveIntelligence = {};

        // Code health warnings
        const warnings: string[] = [];
        const suggestions: string[] = [];
        let healthCount = 0;

        for (const fileId of fileIds) {
            const health = this.codeHealth.getHealth(fileId);
            if (!health) continue;

            if (health.riskLevel === 'fragile') {
                const file = this.store.getFileById(fileId);
                const name = file?.path || fileId;
                warnings.push(`${name} is FRAGILE (${health.churnScore} churn, ${health.breakFrequency} fix-after-change)`);
                healthCount++;
            } else if (health.riskLevel === 'volatile') {
                healthCount++;
            }

            if (health.coupledFiles.length > 0) {
                const file = this.store.getFileById(fileId);
                const name = file?.path || fileId;
                suggestions.push(`Files that co-change with ${name}: ${health.coupledFiles.slice(0, 3).join(', ')}`);
            }
        }

        if (warnings.length > 0) intel.warnings = warnings;
        if (suggestions.length > 0) intel.suggestions = suggestions;
        if (healthCount > 0) intel.code_health = `${healthCount} file(s) with health concerns`;

        // Enrichment coverage for result files
        let pending = 0;
        for (const fileId of fileIds) {
            const card = this.store.getFileCard(fileId);
            if (!card?.level3) pending++;
        }
        if (pending > 0) intel.enrichment_pending = pending;

        return intel;
    }

    format(fileIds: string[]): string {
        const intel = this.gather(fileIds);

        const lines: string[] = [];

        if (intel.warnings && intel.warnings.length > 0) {
            for (const w of intel.warnings) lines.push(`⚠ ${w}`);
        }
        if (intel.suggestions && intel.suggestions.length > 0) {
            for (const s of intel.suggestions) lines.push(`💡 ${s}`);
        }
        if (intel.impact) lines.push(`📊 ${intel.impact}`);
        if (intel.code_health) lines.push(`🧬 ${intel.code_health}`);

        const coverage = this.enrichment.getEnrichmentCoverage();
        if (intel.enrichment_pending && intel.enrichment_pending > 0 && coverage.total > 0) {
            lines.push(`📊 ${coverage.enriched}/${coverage.total} files have semantic tags (${coverage.percentage}% enrichment coverage)`);
        }

        if (lines.length === 0) return '';
        return '\n\n--- Intelligence ---\n' + lines.join('\n');
    }
}
