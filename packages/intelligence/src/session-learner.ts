import { Store } from '@atlasmemory/store';
import type { SessionPattern } from '@atlasmemory/core';

export class SessionLearner {
    constructor(private store: Store) {}

    learnFromSession(sessionId: string): { patternsUpdated: number } {
        const events = this.store.getSessionEvents(sessionId);

        if (events.length < 5) {
            return { patternsUpdated: 0 };
        }

        let patternsUpdated = 0;

        // Extract file co-occurrence patterns (sliding window of 3)
        const fileAccessEvents = events
            .filter((e) => e.eventType === 'file_access')
            .reverse(); // chronological order

        for (let i = 0; i < fileAccessEvents.length; i++) {
            const window = fileAccessEvents.slice(i, i + 3);
            if (window.length < 2) break;

            const fileIds = window.map((e) => e.eventData.fileId as string).sort();
            const key = fileIds.join('::');

            this.store.upsertPattern('file_cooccurrence', key, {
                fileIds,
                filePaths: window.map((e) => e.eventData.filePath as string),
            });
            patternsUpdated++;
        }

        // Extract query-to-file mappings from search events
        const searchEvents = events.filter((e) => e.eventType === 'search');

        for (const event of searchEvents) {
            const query = event.eventData.query as string;
            const resultFileIds = event.eventData.resultFileIds as string[];

            if (resultFileIds && resultFileIds.length > 0) {
                const key = `q:${query.toLowerCase().trim()}`;
                this.store.upsertPattern('query_to_files', key, {
                    query,
                    fileIds: resultFileIds,
                });
                patternsUpdated++;
            }
        }

        // Extract hot paths from context_build events
        const contextEvents = events.filter((e) => e.eventType === 'context_build');

        for (const event of contextEvents) {
            const fileIds = event.eventData.fileIds as string[] | undefined;
            const objective = event.eventData.objective as string | undefined;

            if (fileIds && fileIds.length > 0) {
                const sortedIds = [...fileIds].sort();
                const key = `hp:${sortedIds.join('::')}`;
                this.store.upsertPattern('hot_path', key, {
                    fileIds: sortedIds,
                    objective: objective ?? '',
                    mode: event.eventData.mode as string,
                });
                patternsUpdated++;
            }
        }

        // Decay old patterns + prune old events to prevent unbounded growth
        this.store.decayPatterns(0.8);
        this.store.pruneOldEvents(30);

        return { patternsUpdated };
    }

    getSearchBoosts(query: string): Map<string, number> {
        const boosts = new Map<string, number>();
        const normalizedQuery = query.toLowerCase().trim();

        // Look for exact query match
        const patterns = this.store.getPatterns('query_to_files', { minFreq: 1 });

        for (const pattern of patterns) {
            const patternQuery = (pattern.patternData.query as string).toLowerCase().trim();

            // Exact match or significant word overlap
            let relevance = 0;
            if (patternQuery === normalizedQuery) {
                relevance = 1.0;
            } else {
                const queryWords = new Set(normalizedQuery.split(/\s+/));
                const patternWords = patternQuery.split(/\s+/);
                const matchCount = patternWords.filter((w) => queryWords.has(w)).length;
                const totalWords = Math.max(queryWords.size, patternWords.length);
                if (totalWords > 0) {
                    relevance = matchCount / totalWords;
                }
            }

            if (relevance > 0.3) {
                const fileIds = pattern.patternData.fileIds as string[];
                const boost = relevance * pattern.confidence;
                for (const fileId of fileIds) {
                    const existing = boosts.get(fileId) ?? 0;
                    boosts.set(fileId, Math.max(existing, boost));
                }
            }
        }

        return boosts;
    }

    getHotPaths(limit: number = 10): SessionPattern[] {
        return this.store.getPatterns('hot_path', { minFreq: 2 }).slice(0, limit);
    }

    formatHotPaths(): string {
        const hotPaths = this.getHotPaths();

        if (hotPaths.length === 0) {
            return 'No hot paths detected yet.';
        }

        const lines: string[] = [];
        lines.push('### Hot Paths');
        lines.push('');

        for (const pattern of hotPaths) {
            const objective = pattern.patternData.objective as string;
            const fileIds = pattern.patternData.fileIds as string[];
            const label = objective || fileIds.join(' + ');
            lines.push(`- **${label}** (seen ${pattern.frequency}x, confidence: ${pattern.confidence.toFixed(2)})`);
        }

        return lines.join('\n');
    }
}
