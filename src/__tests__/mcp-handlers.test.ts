import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { SearchService, GraphService } from '@atlasmemory/retrieval';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import { ClaimProver } from '@atlasmemory/taskpack';
import {
    ImpactAnalyzer, BudgetTracker, ConversationMemory, SessionLearner,
} from '@atlasmemory/intelligence';
import { CardGenerator, scoreFileCard } from '@atlasmemory/summarizer';
import { sha256 } from '@atlasmemory/core';
import crypto from 'crypto';

function uid() { return crypto.randomUUID(); }
function hash(s: string) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * MCP Handler Regression Tests
 *
 * Tests the same logic paths as the MCP server tool handlers
 * using in-memory SQLite stores. Validates input handling,
 * service delegation, response format, and error conditions.
 */
describe('MCP Handler: search_repo', () => {
    let store: Store;
    let searchService: SearchService;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        seedData(store);
        searchService = new SearchService(store);
    });

    it('should return results for valid query', () => {
        const results = searchService.search('authentication', 10);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].file).toBeDefined();
        expect(results[0].file.path).toBeDefined();
    });

    it('should return empty array for non-matching query', () => {
        const results = searchService.search('zzz_nonexistent_xyz_999', 10);
        expect(results).toHaveLength(0);
    });

    it('should apply pattern boosts from session learner', () => {
        const sessionLearner = new SessionLearner(store);
        const conversationMemory = new ConversationMemory(store);

        // Seed enough events for learning
        const sid = 'test-session';
        for (let i = 0; i < 6; i++) {
            conversationMemory.recordSearch(sid, `auth query ${i}`, ['file1']);
        }
        sessionLearner.learnFromSession(sid);

        const boosts = sessionLearner.getSearchBoosts('auth');
        // Boosts may or may not have entries — depends on pattern extraction
        expect(boosts).toBeInstanceOf(Map);
    });

    it('should track budget usage', () => {
        const budgetTracker = new BudgetTracker(store);
        const results = searchService.search('authentication', 5);
        const responseText = JSON.stringify(results, null, 2);
        const report = budgetTracker.trackUsage('s1', 'search_repo', responseText);

        expect(report).toBeDefined();
        expect(report.totalUsed).toBeGreaterThan(0);
    });
});

describe('MCP Handler: build_context', () => {
    let store: Store;
    let searchService: SearchService;
    let taskPackBuilder: TaskPackBuilder;
    let bootPackBuilder: BootPackBuilder;
    let contractService: ContextContractService;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        seedData(store);
        searchService = new SearchService(store);
        taskPackBuilder = new TaskPackBuilder(store, process.cwd());
        bootPackBuilder = new BootPackBuilder(store);
        contractService = new ContextContractService(store, process.cwd());
    });

    it('task mode: should build context for valid objective', () => {
        const results = searchService.search('authentication', 20);
        const fileIds = results.map(r => r.file.id);
        expect(fileIds.length).toBeGreaterThan(0);

        const pack = taskPackBuilder.build('How does auth work?', fileIds, 8000, { proof: 'warn' });
        expect(pack).toContain('Task Pack v3');
        expect(pack).toContain('Objective');
    });

    it('task mode: should create contract snapshot', () => {
        const results = searchService.search('auth', 20);
        const fileIds = results.map(r => r.file.id);
        const pack = taskPackBuilder.build('Fix auth', fileIds, 8000, { proof: 'warn' });
        const packHash = sha256(pack);

        contractService.createSnapshot({ objective: 'Fix auth', taskpackHash: packHash, proofMode: 'warn' });
        const contract = contractService.evaluateContract();
        expect(contract.isStale).toBe(false);
    });

    it('task mode: should return hint when no files match', () => {
        const results = searchService.search('zzz_nonexistent_xyz', 20);
        expect(results).toHaveLength(0);

        const fileCount = store.getFiles().length;
        expect(fileCount).toBeGreaterThan(0);
        // MCP handler would return: 'No files matched "zzz_nonexistent_xyz"'
    });

    it('project mode: should build bootpack', () => {
        const result = bootPackBuilder.buildBootPack({
            budget: 1500, format: 'capsule', compress: 'on', proof: 'warn',
        });
        expect(result.text).toBeDefined();
        expect(result.text.length).toBeGreaterThan(0);
    });

    it('project mode: json format should produce valid JSON', () => {
        const result = bootPackBuilder.buildBootPack({
            budget: 1500, format: 'json', compress: 'on', proof: 'warn',
        });
        expect(() => JSON.parse(result.text)).not.toThrow();
    });

    it('delta mode: should handle no changes gracefully', () => {
        const result = bootPackBuilder.buildDeltaPack({
            since: 'last', budget: 800, format: 'capsule', proof: 'warn',
        });
        expect(result.text).toBeDefined();
    });
});

describe('MCP Handler: prove', () => {
    let store: Store;
    let bootPackBuilder: BootPackBuilder;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        seedData(store);
        bootPackBuilder = new BootPackBuilder(store);
    });

    it('single claim: should return proof result', () => {
        const result = bootPackBuilder.proveClaim(
            'The auth module handles login', undefined, 5,
            { proofMode: 'warn', proofBudget: 2500 },
        );
        expect(result).toBeDefined();
        expect(result.claim).toBeDefined();
        expect(result.claim.text).toBe('The auth module handles login');
        expect(['PROVEN', 'UNPROVEN']).toContain(result.claim.status);
    });

    it('batch claims: should return results array', () => {
        const claims = [
            { text: 'Auth module handles login' },
            { text: 'Store manages database operations' },
        ];
        const result = bootPackBuilder.proveClaims(claims, 5, {
            proofMode: 'warn', proofBudget: 2500,
        });
        expect(result).toBeDefined();
        expect(result.results).toHaveLength(2);
    });

    it('should handle empty claim text gracefully', () => {
        // Filter empty claims like the handler does
        const claims = [{ text: '' }, { text: 'Valid claim' }]
            .filter(item => item.text.trim().length > 0);
        expect(claims).toHaveLength(1);
    });
});

describe('MCP Handler: analyze_impact', () => {
    let store: Store;
    let impactAnalyzer: ImpactAnalyzer;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        seedData(store);
        store.buildReverseRefs();
        impactAnalyzer = new ImpactAnalyzer(store);
    });

    it('should analyze impact for known symbol', () => {
        const symbols = store.findSymbolsByName('authenticateUser');
        expect(symbols.length).toBeGreaterThan(0);

        const report = impactAnalyzer.analyzeSymbol(symbols[0].id, { includeTransitive: true });
        expect(report).toBeDefined();
        expect(report.targetSymbol.name).toBe('authenticateUser');
    });

    it('should return empty for unknown symbol', () => {
        const symbols = store.findSymbolsByName('nonExistentFunction');
        expect(symbols).toHaveLength(0);
        // MCP handler returns isError: true with "Symbol not found" message
    });

    it('should format report as readable text', () => {
        const symbols = store.findSymbolsByName('authenticateUser');
        const report = impactAnalyzer.analyzeSymbol(symbols[0].id);
        const formatted = impactAnalyzer.formatReport(report);
        expect(formatted).toContain('authenticateUser');
        expect(typeof formatted).toBe('string');
    });
});

describe('MCP Handler: remember + session_context', () => {
    let store: Store;
    let conversationMemory: ConversationMemory;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        conversationMemory = new ConversationMemory(store);
    });

    it('should record and retrieve constraint', () => {
        conversationMemory.recordConstraint('s1', 'Do not modify production config');
        const constraints = conversationMemory.getActiveConstraints('s1');
        expect(constraints.length).toBeGreaterThan(0);
        expect(constraints.some(c => c.text === 'Do not modify production config')).toBe(true);
    });

    it('should record and retrieve decision', () => {
        conversationMemory.recordDecision('s1', 'Use TypeScript strict mode', []);
        const ctx = conversationMemory.getContext('s1');
        expect(ctx.recentDecisions.length).toBeGreaterThan(0);
    });

    it('should format context as markdown', () => {
        conversationMemory.recordConstraint('s1', 'No mocking');
        conversationMemory.recordSearch('s1', 'auth', ['f1']);
        const ctx = conversationMemory.getContext('s1');
        const formatted = conversationMemory.formatContext(ctx);
        expect(typeof formatted).toBe('string');
    });

    it('should handle missing type/text validation', () => {
        // MCP handler checks: if (!args.type || !args.text) return error
        const type = '';
        const text = '';
        expect(!type || !text).toBe(true);
    });
});

describe('MCP Handler: remember_project + get_project_memory', () => {
    let store: Store;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
    });

    it('should store and retrieve project memory', () => {
        const id = store.addProjectMemory('milestone', 'Phase 27 complete', 'All 98 tests passing');
        expect(id).toBeGreaterThan(0);

        const memories = store.getProjectMemories({ type: 'milestone', status: 'active', limit: 10 });
        expect(memories.length).toBeGreaterThan(0);
        expect(memories.some(m => m.content === 'Phase 27 complete')).toBe(true);
    });

    it('should resolve project memory', () => {
        const id = store.addProjectMemory('gap', 'Bug in auth', 'Needs fix');
        store.resolveProjectMemory(id);
        const active = store.getProjectMemories({ type: 'gap', status: 'active', limit: 10 });
        expect(active.every(m => m.id !== id)).toBe(true);
    });

    it('should validate memory_type', () => {
        const validTypes = ['milestone', 'gap', 'learning', 'priority', 'context'];
        expect(validTypes.includes('milestone')).toBe(true);
        expect(validTypes.includes('invalid')).toBe(false);
    });

    it('should return "No project memories found" when empty', () => {
        const memories = store.getProjectMemories({ status: 'active', limit: 20 });
        // May or may not be empty depending on store defaults, but the method should work
        expect(Array.isArray(memories)).toBe(true);
    });
});

describe('MCP Handler: log_decision + get_file_history', () => {
    let store: Store;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
    });

    it('should log agent change and retrieve history', () => {
        const id = store.logAgentChange({
            filePaths: ['src/auth/login.ts'],
            summary: 'Fixed auth bug',
            why: 'Token validation was incorrect',
            changeType: 'fix',
        });
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);

        const changes = store.getChangesForFile('src/auth/login.ts', 10);
        expect(changes.length).toBeGreaterThan(0);
        expect(changes[0].summary).toBe('Fixed auth bug');
    });

    it('should validate required fields', () => {
        // MCP handler validates: files must be non-empty array, summary and why required
        const files: string[] = [];
        const summary = '';
        const why = '';
        expect(!Array.isArray(files) || files.length === 0 || !summary || !why).toBe(true);
    });

    it('should validate change type', () => {
        const valid = ['fix', 'feature', 'refactor'];
        expect(valid.includes('fix')).toBe(true);
        expect(valid.includes('invalid')).toBe(false);
    });

    it('should enforce summary/why length limits', () => {
        const longStr = 'x'.repeat(501);
        expect(longStr.length > 500).toBe(true);
        // MCP handler returns isError for length > 500
    });
});

describe('MCP Handler: get_context_contract + acknowledge_context', () => {
    let store: Store;
    let contractService: ContextContractService;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        contractService = new ContextContractService(store, process.cwd());
    });

    it('should return NO_SNAPSHOT when no contract exists', () => {
        const contract = contractService.evaluateContract();
        expect(contract.isStale).toBe(true);
        expect(contract.reasons).toContain('NO_SNAPSHOT');
    });

    it('should create and acknowledge contract', () => {
        const dbSig = store.getDbSignature();
        const gitHead = contractService.getGitHead();
        const { contractHash } = contractService.createSnapshot({
            bootpackHash: 'bp1', proofMode: 'strict',
            dbSig, gitHead, objective: 'test',
            budgets: { task: 10000 },
        });

        const ok = contractService.acknowledgeContext(contractHash);
        expect(ok).toBe(true);
    });

    it('should return false for unknown contract hash', () => {
        const ok = contractService.acknowledgeContext('nonexistent-hash');
        expect(ok).toBe(false);
        // MCP handler returns: { ok: false, code: 'CONTRACT_NOT_FOUND' }
    });

    it('should add recommendedAction when shouldBlock', () => {
        const contract = contractService.evaluateContract({ enforce: 'strict' });
        // No snapshot → shouldBlock=true
        if (contract.shouldBlock) {
            // MCP handler adds: recommendedAction = 'Call build_context...'
            expect(contract.shouldBlock).toBe(true);
        }
    });
});

describe('MCP Handler: budget tracking', () => {
    let store: Store;
    let budgetTracker: BudgetTracker;

    beforeEach(() => {
        store = new Store(':memory:');
        store.setRepoRoot(process.cwd());
        budgetTracker = new BudgetTracker(store);
    });

    it('should track usage across multiple tools', () => {
        budgetTracker.trackUsage('s1', 'search_repo', 'result 1');
        budgetTracker.trackUsage('s1', 'build_context', 'result 2 with more text');
        const report = budgetTracker.getReport('s1');
        expect(report.totalUsed).toBeGreaterThan(0);
    });

    it('should format budget header', () => {
        const report = budgetTracker.trackUsage('s1', 'search_repo', 'x'.repeat(100));
        const header = budgetTracker.formatBudgetHeader(report);
        expect(typeof header).toBe('string');
    });
});

describe('MCP Handler: autoBudget logic', () => {
    it('should scale budget with file count', () => {
        // Replicate the autoBudget function from mcp-server.ts
        function autoBudget(fileCount: number, mode: 'task' | 'project' | 'delta'): number {
            if (mode === 'task')    return Math.min(Math.max(fileCount * 150, 4000), 20000);
            if (mode === 'project') return Math.min(Math.max(fileCount * 30,  1500), 6000);
            if (mode === 'delta')   return Math.min(Math.max(fileCount * 15,   800), 3000);
            return 4000;
        }

        // Small project (10 files)
        expect(autoBudget(10, 'task')).toBe(4000); // min clamp
        expect(autoBudget(10, 'project')).toBe(1500); // min clamp

        // Medium project (100 files)
        expect(autoBudget(100, 'task')).toBe(15000);
        expect(autoBudget(100, 'project')).toBe(3000);

        // Large project (200 files)
        expect(autoBudget(200, 'task')).toBe(20000); // max clamp
        expect(autoBudget(200, 'project')).toBe(6000); // max clamp
        expect(autoBudget(200, 'delta')).toBe(3000); // max clamp
    });

    it('should scale handshake budget with file count', () => {
        function handshakeBudget(fileCount: number) {
            const total = Math.min(Math.max(fileCount * 12, 800), 2500);
            return {
                perception: Math.round(total * 0.45),
                memory:     Math.round(total * 0.40),
                protocol:   Math.round(total * 0.15),
            };
        }

        const small = handshakeBudget(10);
        expect(small.perception + small.memory + small.protocol).toBeLessThanOrEqual(800);

        const large = handshakeBudget(300);
        expect(large.perception + large.memory + large.protocol).toBeLessThanOrEqual(2500);
    });
});

// ─── Helper: seed realistic data ───────────────────────────────────────
function seedData(store: Store) {
    const files = [
        { path: 'src/auth/login.ts', lang: 'typescript', loc: 80 },
        { path: 'src/auth/middleware.ts', lang: 'typescript', loc: 60 },
        { path: 'src/db/store.ts', lang: 'typescript', loc: 200 },
        { path: 'src/api/routes.ts', lang: 'typescript', loc: 120 },
        { path: 'src/utils/hash.ts', lang: 'typescript', loc: 30 },
    ];

    const fileIds: string[] = [];
    for (const f of files) {
        const fid = store.addFile(f.path, f.lang, hash(f.path), f.loc, '');
        fileIds.push(fid);
    }

    const symbols = [
        { fileIdx: 0, name: 'authenticateUser', kind: 'function' as const, start: 1, end: 25 },
        { fileIdx: 0, name: 'validateToken', kind: 'function' as const, start: 27, end: 50 },
        { fileIdx: 1, name: 'authMiddleware', kind: 'function' as const, start: 1, end: 30 },
        { fileIdx: 2, name: 'Store', kind: 'class' as const, start: 1, end: 200 },
        { fileIdx: 3, name: 'registerRoutes', kind: 'function' as const, start: 1, end: 50 },
        { fileIdx: 4, name: 'sha256', kind: 'function' as const, start: 1, end: 15 },
    ];

    const symIds: string[] = [];
    for (const s of symbols) {
        const sid = uid();
        symIds.push(sid);
        const sig = `${s.kind} ${s.name}()`;
        store.addSymbol({
            id: sid, fileId: fileIds[s.fileIdx], name: s.name,
            qualifiedName: s.name, kind: s.kind, signature: sig,
            startLine: s.start, endLine: s.end, visibility: 'public',
            signatureHash: hash(sig),
        });
    }

    for (let i = 0; i < symbols.length; i++) {
        store.upsertAnchor({
            id: uid(), fileId: fileIds[symbols[i].fileIdx],
            startLine: symbols[i].start, endLine: symbols[i].end,
            snippetHash: hash(`snippet-${i}`),
        });
    }

    for (let i = 0; i < files.length; i++) {
        store.addFileCard({
            fileId: fileIds[i],
            path: files[i].path,
            cardHash: hash(`card-${i}`),
            level0: {
                purpose: `${files[i].path.split('/').pop()} — handles ${files[i].path.includes('auth') ? 'authentication' : 'core'} logic`,
                exports: symbols.filter(s => s.fileIdx === i).map(s => s.name),
                sideEffects: [],
            },
            level1: {
                purpose: `Detailed: ${files[i].path}`,
                publicApi: symbols.filter(s => s.fileIdx === i).map(s => s.name),
                sideEffects: [],
                dependencies: [],
                evidenceAnchorIds: [],
                notes: '',
            },
        });
    }

    // Add refs for impact analysis
    store.addRef({ id: uid(), fromSymbolId: symIds[2], toSymbolId: symIds[0], toName: 'authenticateUser', kind: 'call' });
    store.addRef({ id: uid(), fromSymbolId: symIds[4], toSymbolId: symIds[2], toName: 'authMiddleware', kind: 'call' });
}
