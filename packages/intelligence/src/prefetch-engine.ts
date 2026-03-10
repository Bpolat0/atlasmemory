import { Store } from '@atlasmemory/store';
import { GraphService } from '@atlasmemory/retrieval';
import type { PrefetchSuggestion } from '@atlasmemory/core';

interface PrefetchContext {
    searchQuery?: string;
    accessedFileIds?: string[];
    objective?: string;
}

interface Candidate {
    score: number;
    reasons: Set<string>;
}

export class PrefetchEngine {
    constructor(
        private store: Store,
        private graph: GraphService,
    ) {}

    predictNextFiles(context: PrefetchContext, limit: number = 5): PrefetchSuggestion[] {
        const candidates = new Map<string, Candidate>();
        const accessedSet = new Set(context.accessedFileIds ?? []);

        // Signal 1: Graph neighbors (weight 0.4)
        if (accessedSet.size > 0) {
            this.graph.buildGraph();
            const graphScores = this.graph.expand([...accessedSet], 1, 0.5);
            for (const [fileId, score] of graphScores) {
                this.addCandidate(candidates, fileId, score * 0.4, 'graph_neighbor');
            }
        }

        // Signal 2: Co-occurrence patterns (weight 0.35)
        if (accessedSet.size > 0) {
            const coPatterns = this.store.getPatterns('file_cooccurrence', {
                minFreq: 2,
                minConfidence: 0.3,
            });

            // Build a set of accessed file paths for matching
            const accessedPaths = new Set<string>();
            for (const fid of accessedSet) {
                const file = this.store.getFileById(fid);
                if (file) accessedPaths.add(file.path);
            }

            for (const pattern of coPatterns) {
                const filePaths = pattern.patternData.filePaths as string[] | undefined;
                const fileIds = pattern.patternData.fileIds as string[] | undefined;
                if (!filePaths || !fileIds) continue;

                // Check if any accessed file is in this pattern
                let hasAccessed = false;
                for (const fp of filePaths) {
                    if (accessedPaths.has(fp)) {
                        hasAccessed = true;
                        break;
                    }
                }

                if (hasAccessed) {
                    // Add the other files from the pattern
                    for (let i = 0; i < filePaths.length; i++) {
                        if (!accessedPaths.has(filePaths[i])) {
                            const otherId = fileIds[i] ?? this.store.getFileId(filePaths[i]);
                            if (otherId) {
                                this.addCandidate(
                                    candidates,
                                    otherId,
                                    pattern.confidence * 0.35,
                                    'cooccurrence_pattern',
                                );
                            }
                        }
                    }
                }
            }
        }

        // Signal 3: Query patterns (weight 0.25)
        if (context.searchQuery) {
            const queryPatterns = this.store.getPatterns('query_to_files', {
                minFreq: 2,
                minConfidence: 0.3,
            });

            const normalizedQuery = context.searchQuery.toLowerCase().trim();

            for (const pattern of queryPatterns) {
                const patternKey = pattern.patternKey.toLowerCase();

                // Substring match in either direction
                if (patternKey.includes(normalizedQuery) || normalizedQuery.includes(patternKey)) {
                    const fileIds = pattern.patternData.fileIds as string[] | undefined;
                    if (fileIds) {
                        for (const fileId of fileIds) {
                            this.addCandidate(
                                candidates,
                                fileId,
                                pattern.confidence * 0.25,
                                'query_pattern',
                            );
                        }
                    }
                }
            }
        }

        // Filter out already-accessed files
        for (const fid of accessedSet) {
            candidates.delete(fid);
        }

        // Sort by score descending and take top `limit`
        const sorted = [...candidates.entries()]
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, limit);

        // Build suggestions
        const reasonPriority: PrefetchSuggestion['reason'][] = [
            'cooccurrence_pattern',
            'query_pattern',
            'hot_path',
            'graph_neighbor',
        ];

        const suggestions: PrefetchSuggestion[] = [];
        for (const [fileId, candidate] of sorted) {
            const file = this.store.getFileById(fileId);
            if (!file) continue;

            // Pick best reason by priority
            let bestReason: PrefetchSuggestion['reason'] = 'graph_neighbor';
            for (const r of reasonPriority) {
                if (candidate.reasons.has(r)) {
                    bestReason = r;
                    break;
                }
            }

            // Get L0 card summary
            const card = this.store.getFileCard(fileId);
            const previewSummary = card?.level0?.purpose;

            suggestions.push({
                fileId,
                filePath: file.path,
                reason: bestReason,
                confidence: Math.round(candidate.score * 100) / 100,
                previewSummary,
            });
        }

        return suggestions;
    }

    formatSuggestions(suggestions: PrefetchSuggestion[]): string {
        if (suggestions.length === 0) {
            return 'No related file suggestions available.';
        }

        const reasonLabels: Record<PrefetchSuggestion['reason'], string> = {
            cooccurrence_pattern: 'Often used together',
            query_pattern: 'Related to query',
            hot_path: 'Hot path',
            graph_neighbor: 'Import neighbor',
        };

        const lines: string[] = [];
        lines.push('### \uD83D\uDD2E Suggested Related Files:');
        lines.push('');

        for (const s of suggestions) {
            const label = reasonLabels[s.reason];
            const pct = Math.round(s.confidence * 100);
            const preview = s.previewSummary ? ` — ${s.previewSummary}` : '';
            lines.push(`- **${s.filePath}** [${label}, ${pct}%]${preview}`);
        }

        return lines.join('\n');
    }

    private addCandidate(
        map: Map<string, Candidate>,
        fileId: string,
        score: number,
        reason: string,
    ): void {
        const existing = map.get(fileId);
        if (existing) {
            existing.score += score;
            existing.reasons.add(reason);
        } else {
            map.set(fileId, { score, reasons: new Set([reason]) });
        }
    }
}
