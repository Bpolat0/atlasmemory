import { Store } from '@atlasmemory/store';
import type { ConversationContext, ConversationEvent } from '@atlasmemory/core';

export class ConversationMemory {
    constructor(private store: Store) {}

    recordSearch(sessionId: string, query: string, resultFileIds: string[]): void {
        this.store.logEvent(sessionId, 'search', {
            query,
            resultFileIds,
            resultCount: resultFileIds.length,
        });
    }

    recordContextBuild(
        sessionId: string,
        mode: string,
        objective: string,
        fileIds: string[],
        tokens: number,
    ): void {
        this.store.logEvent(sessionId, 'context_build', {
            mode,
            objective,
            fileIds,
            tokens,
        });
    }

    recordFileAccess(sessionId: string, fileId: string, filePath: string): void {
        this.store.logEvent(sessionId, 'file_access', {
            fileId,
            filePath,
        });
    }

    recordConstraint(sessionId: string, constraintText: string, scope?: string): void {
        this.store.logEvent(sessionId, 'constraint', {
            text: constraintText,
            scope: scope ?? 'session',
            active: true,
        });
    }

    recordDecision(sessionId: string, decisionText: string, relatedFileIds?: string[]): void {
        this.store.logEvent(sessionId, 'decision', {
            text: decisionText,
            relatedFileIds: relatedFileIds ?? [],
        });
    }

    recordImpactCheck(
        sessionId: string,
        symbolId: string,
        affectedFiles: string[],
        riskLevel: string,
    ): void {
        this.store.logEvent(sessionId, 'impact_check', {
            symbolId,
            affectedFiles,
            riskLevel,
        });
    }

    getContext(sessionId: string): ConversationContext {
        const events = this.store.getSessionEvents(sessionId);

        const activeConstraints: Array<{ text: string; createdAt: string }> = [];
        const recentDecisions: Array<{ text: string; relatedFiles: string[] }> = [];
        const filesAccessed: string[] = [];
        const searchHistory: Array<{ query: string; resultCount: number }> = [];
        let currentObjective: string | undefined;

        for (const event of events) {
            const data = event.eventData;
            switch (event.eventType) {
                case 'constraint':
                    if (data.active) {
                        activeConstraints.push({
                            text: data.text as string,
                            createdAt: event.createdAt,
                        });
                    }
                    break;
                case 'decision':
                    recentDecisions.push({
                        text: data.text as string,
                        relatedFiles: (data.relatedFileIds as string[]) ?? [],
                    });
                    break;
                case 'file_access': {
                    const filePath = data.filePath as string;
                    if (!filesAccessed.includes(filePath)) {
                        filesAccessed.push(filePath);
                    }
                    break;
                }
                case 'search':
                    searchHistory.push({
                        query: data.query as string,
                        resultCount: data.resultCount as number,
                    });
                    break;
                case 'context_build':
                    if (data.objective) {
                        currentObjective = data.objective as string;
                    }
                    break;
            }
        }

        return {
            sessionId,
            activeConstraints,
            recentDecisions,
            currentObjective,
            filesAccessed,
            searchHistory,
        };
    }

    getActiveConstraints(sessionId: string): Array<{ text: string; createdAt: string }> {
        const events = this.store.getSessionEvents(sessionId, { type: 'constraint' });
        const constraints: Array<{ text: string; createdAt: string }> = [];

        for (const event of events) {
            if (event.eventData.active) {
                constraints.push({
                    text: event.eventData.text as string,
                    createdAt: event.createdAt,
                });
            }
        }

        return constraints;
    }

    findRelatedSessions(
        objective: string,
        fileIds?: string[],
    ): Array<{ sessionId: string; overlapScore: number; objective?: string }> {
        const recentEvents = this.store.getRecentEvents(500);

        // Group events by session
        const sessionMap = new Map<
            string,
            { objectives: string[]; fileIds: Set<string> }
        >();

        for (const event of recentEvents) {
            if (!sessionMap.has(event.sessionId)) {
                sessionMap.set(event.sessionId, { objectives: [], fileIds: new Set() });
            }
            const session = sessionMap.get(event.sessionId)!;

            if (event.eventType === 'context_build' && event.eventData.objective) {
                session.objectives.push(event.eventData.objective as string);
            }
            if (event.eventType === 'file_access' && event.eventData.fileId) {
                session.fileIds.add(event.eventData.fileId as string);
            }
            if (event.eventType === 'search' && event.eventData.resultFileIds) {
                for (const fid of event.eventData.resultFileIds as string[]) {
                    session.fileIds.add(fid);
                }
            }
        }

        const objectiveWords = new Set(objective.toLowerCase().split(/\s+/));
        const inputFileSet = new Set(fileIds ?? []);

        const results: Array<{ sessionId: string; overlapScore: number; objective?: string }> = [];

        for (const [sid, session] of sessionMap) {
            let score = 0;

            // Objective similarity: word overlap ratio
            for (const obj of session.objectives) {
                const words = obj.toLowerCase().split(/\s+/);
                const matchCount = words.filter((w) => objectiveWords.has(w)).length;
                const totalWords = Math.max(objectiveWords.size, words.length);
                if (totalWords > 0) {
                    score = Math.max(score, matchCount / totalWords);
                }
            }

            // File overlap
            if (inputFileSet.size > 0 && session.fileIds.size > 0) {
                let fileOverlap = 0;
                for (const fid of inputFileSet) {
                    if (session.fileIds.has(fid)) fileOverlap++;
                }
                const fileScore = fileOverlap / Math.max(inputFileSet.size, session.fileIds.size);
                score = Math.max(score, fileScore);
            }

            if (score > 0.2) {
                results.push({
                    sessionId: sid,
                    overlapScore: score,
                    objective: session.objectives[0],
                });
            }
        }

        results.sort((a, b) => b.overlapScore - a.overlapScore);
        return results.slice(0, 3);
    }

    formatContext(ctx: ConversationContext): string {
        const lines: string[] = [];
        lines.push(`## Conversation Context: ${ctx.sessionId}`);
        lines.push('');

        if (ctx.currentObjective) {
            lines.push(`**Objective:** ${ctx.currentObjective}`);
            lines.push('');
        }

        if (ctx.activeConstraints.length > 0) {
            lines.push('### Active Constraints');
            for (const c of ctx.activeConstraints) {
                lines.push(`- ${c.text} _(${c.createdAt})_`);
            }
            lines.push('');
        }

        if (ctx.recentDecisions.length > 0) {
            lines.push('### Recent Decisions');
            for (const d of ctx.recentDecisions) {
                const files = d.relatedFiles.length > 0 ? ` [${d.relatedFiles.join(', ')}]` : '';
                lines.push(`- ${d.text}${files}`);
            }
            lines.push('');
        }

        if (ctx.filesAccessed.length > 0) {
            lines.push('### Files Accessed');
            for (const f of ctx.filesAccessed) {
                lines.push(`- ${f}`);
            }
            lines.push('');
        }

        if (ctx.searchHistory.length > 0) {
            lines.push('### Search History');
            for (const s of ctx.searchHistory) {
                lines.push(`- "${s.query}" (${s.resultCount} results)`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }
}
