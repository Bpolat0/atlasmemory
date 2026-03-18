import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { ConversationMemory } from '../conversation-memory.js';

describe('ConversationMemory', () => {
    let store: Store;
    let memory: ConversationMemory;
    const sessionId = 'test-session-1';

    beforeEach(() => {
        store = new Store(':memory:');
        memory = new ConversationMemory(store);
    });

    describe('recordSearch + getContext', () => {
        it('should record and retrieve search events', () => {
            memory.recordSearch(sessionId, 'find auth', ['file1', 'file2']);
            const ctx = memory.getContext(sessionId);
            expect(ctx.searchHistory).toHaveLength(1);
            expect(ctx.searchHistory[0].query).toBe('find auth');
            expect(ctx.searchHistory[0].resultCount).toBe(2);
        });
    });

    describe('recordContextBuild', () => {
        it('should set current objective from context_build', () => {
            memory.recordContextBuild(sessionId, 'taskpack', 'Fix login bug', ['f1'], 5000);
            const ctx = memory.getContext(sessionId);
            expect(ctx.currentObjective).toBe('Fix login bug');
        });
    });

    describe('recordFileAccess', () => {
        it('should track accessed files without duplicates', () => {
            memory.recordFileAccess(sessionId, 'f1', 'src/a.ts');
            memory.recordFileAccess(sessionId, 'f1', 'src/a.ts');
            memory.recordFileAccess(sessionId, 'f2', 'src/b.ts');
            const ctx = memory.getContext(sessionId);
            expect(ctx.filesAccessed).toHaveLength(2);
            expect(ctx.filesAccessed).toContain('src/a.ts');
            expect(ctx.filesAccessed).toContain('src/b.ts');
        });
    });

    describe('recordConstraint + getActiveConstraints', () => {
        it('should record and filter active constraints', () => {
            memory.recordConstraint(sessionId, 'Do not use mocks');
            memory.recordConstraint(sessionId, 'Use TypeScript strict mode', 'project');
            const constraints = memory.getActiveConstraints(sessionId);
            expect(constraints).toHaveLength(2);
            // Events returned in DESC order (newest first)
            const texts = constraints.map(c => c.text);
            expect(texts).toContain('Do not use mocks');
            expect(texts).toContain('Use TypeScript strict mode');
        });
    });

    describe('recordDecision', () => {
        it('should record decisions with related files', () => {
            memory.recordDecision(sessionId, 'Chose SQLite over PostgreSQL', ['f1']);
            const ctx = memory.getContext(sessionId);
            expect(ctx.recentDecisions).toHaveLength(1);
            expect(ctx.recentDecisions[0].text).toBe('Chose SQLite over PostgreSQL');
            expect(ctx.recentDecisions[0].relatedFiles).toContain('f1');
        });

        it('should handle decisions without related files', () => {
            memory.recordDecision(sessionId, 'Use ESM');
            const ctx = memory.getContext(sessionId);
            expect(ctx.recentDecisions[0].relatedFiles).toHaveLength(0);
        });
    });

    describe('recordImpactCheck', () => {
        it('should record impact check events', () => {
            memory.recordImpactCheck(sessionId, 'sym1', ['f1', 'f2'], 'high');
            // Verify event was stored (impact_check doesn't show in getContext directly)
            const events = store.getSessionEvents(sessionId);
            const impactEvent = events.find(e => e.eventType === 'impact_check');
            expect(impactEvent).toBeDefined();
            expect(impactEvent!.eventData.riskLevel).toBe('high');
        });
    });

    describe('getContext - full', () => {
        it('should aggregate all event types into context', () => {
            memory.recordSearch(sessionId, 'auth handler', ['f1']);
            memory.recordContextBuild(sessionId, 'taskpack', 'Fix auth', ['f1'], 3000);
            memory.recordFileAccess(sessionId, 'f1', 'src/auth.ts');
            memory.recordConstraint(sessionId, 'No external deps');
            memory.recordDecision(sessionId, 'Use JWT tokens', ['f1']);

            const ctx = memory.getContext(sessionId);
            expect(ctx.sessionId).toBe(sessionId);
            expect(ctx.currentObjective).toBe('Fix auth');
            expect(ctx.activeConstraints).toHaveLength(1);
            expect(ctx.recentDecisions).toHaveLength(1);
            expect(ctx.filesAccessed).toHaveLength(1);
            expect(ctx.searchHistory).toHaveLength(1);
        });
    });

    describe('findRelatedSessions', () => {
        it('should find sessions with overlapping objectives', () => {
            const s1 = 'session-a';
            const s2 = 'session-b';

            memory.recordContextBuild(s1, 'taskpack', 'Fix authentication module', ['f1'], 3000);
            memory.recordContextBuild(s2, 'taskpack', 'Add user registration', ['f2'], 3000);

            const related = memory.findRelatedSessions('authentication login module');
            // session-a should match due to word overlap ("authentication", "module")
            expect(related.length).toBeGreaterThanOrEqual(1);
            expect(related[0].sessionId).toBe(s1);
            expect(related[0].overlapScore).toBeGreaterThan(0.2);
        });

        it('should find sessions with overlapping files', () => {
            const s1 = 'session-x';
            memory.recordFileAccess(s1, 'f1', 'src/auth.ts');
            memory.recordSearch(s1, 'test', ['f1', 'f2']);

            const related = memory.findRelatedSessions('anything', ['f1']);
            expect(related.length).toBeGreaterThanOrEqual(1);
        });

        it('should return empty for unrelated sessions', () => {
            const s1 = 'session-z';
            memory.recordContextBuild(s1, 'taskpack', 'Database migration', ['f1'], 3000);

            const related = memory.findRelatedSessions('UI styling CSS');
            expect(related).toHaveLength(0);
        });
    });

    describe('formatContext', () => {
        it('should produce readable markdown', () => {
            memory.recordSearch(sessionId, 'auth', ['f1']);
            memory.recordConstraint(sessionId, 'No mocks');
            memory.recordContextBuild(sessionId, 'tp', 'Fix auth', ['f1'], 1000);

            const ctx = memory.getContext(sessionId);
            const md = memory.formatContext(ctx);
            expect(md).toContain('Conversation Context');
            expect(md).toContain('Fix auth');
            expect(md).toContain('No mocks');
            expect(md).toContain('auth');
        });
    });
});