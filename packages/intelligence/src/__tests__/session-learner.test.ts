import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { SessionLearner } from '../session-learner.js';
import { ConversationMemory } from '../conversation-memory.js';

describe('SessionLearner', () => {
    let store: Store;
    let learner: SessionLearner;
    let memory: ConversationMemory;
    const sessionId = 'learn-session-1';

    beforeEach(() => {
        store = new Store(':memory:');
        learner = new SessionLearner(store);
        memory = new ConversationMemory(store);
    });

    describe('learnFromSession', () => {
        it('should skip sessions with fewer than 5 events', () => {
            memory.recordSearch(sessionId, 'test', ['f1']);
            memory.recordFileAccess(sessionId, 'f1', 'src/a.ts');
            const result = learner.learnFromSession(sessionId);
            expect(result.patternsUpdated).toBe(0);
        });

        it('should extract file cooccurrence patterns', () => {
            // Need 5+ events to trigger learning
            memory.recordFileAccess(sessionId, 'f1', 'src/a.ts');
            memory.recordFileAccess(sessionId, 'f2', 'src/b.ts');
            memory.recordFileAccess(sessionId, 'f3', 'src/c.ts');
            memory.recordSearch(sessionId, 'test query', ['f1']);
            memory.recordConstraint(sessionId, 'test constraint');

            const result = learner.learnFromSession(sessionId);
            expect(result.patternsUpdated).toBeGreaterThan(0);

            // Check patterns were stored
            const patterns = store.getPatterns('file_cooccurrence');
            expect(patterns.length).toBeGreaterThan(0);
        });

        it('should extract query-to-file patterns from search events', () => {
            memory.recordSearch(sessionId, 'authentication handler', ['f1', 'f2']);
            memory.recordFileAccess(sessionId, 'f1', 'src/a.ts');
            memory.recordFileAccess(sessionId, 'f2', 'src/b.ts');
            memory.recordConstraint(sessionId, 'c1');
            memory.recordDecision(sessionId, 'd1');

            const result = learner.learnFromSession(sessionId);
            expect(result.patternsUpdated).toBeGreaterThan(0);

            const patterns = store.getPatterns('query_to_files');
            expect(patterns.length).toBeGreaterThan(0);
            expect(patterns[0].patternData.query).toBe('authentication handler');
        });

        it('should extract hot_path patterns from context_build events', () => {
            memory.recordContextBuild(sessionId, 'taskpack', 'Fix auth', ['f1', 'f2'], 5000);
            memory.recordFileAccess(sessionId, 'f1', 'src/a.ts');
            memory.recordFileAccess(sessionId, 'f2', 'src/b.ts');
            memory.recordSearch(sessionId, 'q1', ['f1']);
            memory.recordConstraint(sessionId, 'c1');

            const result = learner.learnFromSession(sessionId);
            expect(result.patternsUpdated).toBeGreaterThan(0);

            const patterns = store.getPatterns('hot_path');
            expect(patterns.length).toBeGreaterThan(0);
        });
    });

    describe('getSearchBoosts', () => {
        it('should return empty map when no patterns exist', () => {
            const boosts = learner.getSearchBoosts('random query');
            expect(boosts.size).toBe(0);
        });

        it('should boost files for matching queries', () => {
            // Manually insert a pattern
            store.upsertPattern('query_to_files', 'q:auth handler', {
                query: 'auth handler',
                fileIds: ['f1', 'f2'],
            });

            const boosts = learner.getSearchBoosts('auth handler');
            expect(boosts.size).toBe(2);
            expect(boosts.get('f1')).toBeGreaterThan(0);
        });

        it('should boost for partial word overlap', () => {
            store.upsertPattern('query_to_files', 'q:authentication middleware', {
                query: 'authentication middleware',
                fileIds: ['f1'],
            });

            // "authentication" overlaps
            const boosts = learner.getSearchBoosts('authentication handler');
            expect(boosts.size).toBeGreaterThan(0);
        });

        it('should not boost for unrelated queries', () => {
            store.upsertPattern('query_to_files', 'q:database migration', {
                query: 'database migration',
                fileIds: ['f1'],
            });

            const boosts = learner.getSearchBoosts('ui styling css');
            expect(boosts.size).toBe(0);
        });
    });

    describe('getHotPaths', () => {
        it('should return empty when no hot paths with freq >= 2', () => {
            const paths = learner.getHotPaths();
            expect(paths).toHaveLength(0);
        });

        it('should return hot paths with sufficient frequency', () => {
            // Upsert same pattern twice to get freq=2
            store.upsertPattern('hot_path', 'hp:f1::f2', {
                fileIds: ['f1', 'f2'], objective: 'Fix auth', mode: 'taskpack',
            });
            store.upsertPattern('hot_path', 'hp:f1::f2', {
                fileIds: ['f1', 'f2'], objective: 'Fix auth', mode: 'taskpack',
            });

            const paths = learner.getHotPaths();
            expect(paths).toHaveLength(1);
            expect(paths[0].frequency).toBeGreaterThanOrEqual(2);
        });
    });

    describe('formatHotPaths', () => {
        it('should return no-data message when empty', () => {
            const output = learner.formatHotPaths();
            expect(output).toContain('No hot paths');
        });
    });
});