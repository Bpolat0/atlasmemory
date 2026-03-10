import { Store } from '@atlasmemory/store';
import type { TokenBudgetReport } from '@atlasmemory/core';

const CHARS_PER_TOKEN = 4;

export class BudgetTracker {
    private budgetLimits = new Map<string, number>();

    constructor(private store: Store) {}

    setBudgetLimit(sessionId: string, limit: number): void {
        this.budgetLimits.set(sessionId, limit);
    }

    trackUsage(sessionId: string, toolName: string, responseText: string, budgetLimit?: number): TokenBudgetReport {
        const tokens = Math.ceil(responseText.length / CHARS_PER_TOKEN);
        const limit = budgetLimit ?? this.budgetLimits.get(sessionId) ?? 128_000;

        this.store.logTokenUsage(sessionId, toolName, tokens, limit);

        return this.getReport(sessionId, limit);
    }

    getReport(sessionId: string, budgetLimit?: number): TokenBudgetReport {
        const usage = this.store.getSessionTokens(sessionId);
        const limit = budgetLimit ?? this.budgetLimits.get(sessionId) ?? 128_000;
        const percentUsed = limit > 0 ? Math.round((usage.totalTokens / limit) * 100) : 0;

        // Calculate trend from last 5 entries
        const trend = this.computeTrend(usage.entries);

        const recommendation = this.generateRecommendation(percentUsed, limit - usage.totalTokens);

        return {
            sessionId,
            totalUsed: usage.totalTokens,
            budgetLimit: limit,
            percentUsed,
            byTool: usage.byTool,
            recommendation,
            trend,
        };
    }

    formatBudgetHeader(report: TokenBudgetReport): string {
        const remaining = report.budgetLimit - report.totalUsed;
        const formattedUsed = report.totalUsed.toLocaleString();
        const formattedLimit = report.budgetLimit.toLocaleString();
        const formattedRemaining = remaining.toLocaleString();

        // Estimate remaining capacity
        const avgFileRead = 2_000;
        const avgContextBuild = 8_000;
        const avgSearch = 500;
        const fileReads = Math.floor(remaining / avgFileRead);
        const contextBuilds = Math.floor(remaining / avgContextBuild);
        const searches = Math.floor(remaining / avgSearch);

        const trendEmoji = report.trend === 'increasing' ? '\u{1F4C8}' : report.trend === 'decreasing' ? '\u{1F4C9}' : '\u{1F4CA}';
        const trendLabel = report.trend;

        return [
            '---',
            `\u{1F4CA} Token Budget: ${formattedUsed} / ${formattedLimit} used (${report.percentUsed}%) | ~${formattedRemaining} remaining`,
            `\u{1F4A1} Capacity: ~${fileReads} file reads, ~${contextBuilds} context builds, or ~${searches} searches remaining`,
            `${trendEmoji} Trend: ${trendLabel}`,
        ].join('\n');
    }

    // --- Private helpers ---

    private computeTrend(entries: Array<{ tool: string; tokens: number; timestamp: string }>): 'increasing' | 'stable' | 'decreasing' {
        const last5 = entries.slice(-5);
        if (last5.length < 2) return 'stable';

        const mid = Math.floor(last5.length / 2);
        const firstHalf = last5.slice(0, mid);
        const secondHalf = last5.slice(mid);

        const avgFirst = firstHalf.reduce((sum, e) => sum + e.tokens, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((sum, e) => sum + e.tokens, 0) / secondHalf.length;

        if (avgFirst === 0) return 'stable';
        if (avgSecond > avgFirst * 1.3) return 'increasing';
        if (avgSecond < avgFirst * 0.7) return 'decreasing';
        return 'stable';
    }

    private generateRecommendation(percentUsed: number, remaining: number): string {
        if (percentUsed >= 90) {
            return 'Budget nearly exhausted. Use targeted searches only. Avoid full context builds.';
        }
        if (percentUsed >= 70) {
            return 'Budget running low. Prefer focused queries over broad exploration.';
        }
        if (percentUsed >= 40) {
            return 'Budget healthy. Normal usage patterns are fine.';
        }
        return 'Ample budget remaining. Full exploration and context building are available.';
    }
}
