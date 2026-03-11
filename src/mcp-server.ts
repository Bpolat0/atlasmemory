import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Store } from '@atlasmemory/store';
import { SearchService, GraphService } from '@atlasmemory/retrieval';
import { ImpactAnalyzer, PrefetchEngine, DiffEnricher, BudgetTracker, ConversationMemory, SessionLearner, CodeHealthAnalyzer, EnrichmentCoordinator, ProactiveResponseBuilder } from '@atlasmemory/intelligence';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import { CardGenerator, FlowGenerator, scoreFileCard } from '@atlasmemory/summarizer';
import { sha256 } from '@atlasmemory/core';
import { autoIndex, isDbEmpty, detectProjectRoot } from './auto-index.js';
import { VERSION, NAME } from './version.js';
import path from 'path';
import fs from 'fs';

export interface McpServerOptions {
    dbPath?: string;
}

function initStore(dbPath?: string): Store {
    const resolved = path.resolve(dbPath || process.env.ATLAS_DB_PATH || '.atlas/atlas.db');
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return new Store(resolved);
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
    const store = initStore(options.dbPath);
    const searchService = new SearchService(store);
    const taskPackBuilder = new TaskPackBuilder(store);
    const bootPackBuilder = new BootPackBuilder(store);
    const contractService = new ContextContractService(store, process.cwd());
    const flowGenerator = new FlowGenerator(store);
    const deterministicCardGenerator = new CardGenerator();

    // Phase 19: Intelligence Layer
    const graphService = new GraphService(store);
    const impactAnalyzer = new ImpactAnalyzer(store);
    const prefetchEngine = new PrefetchEngine(store, graphService);
    const diffEnricher = new DiffEnricher(store);
    const budgetTracker = new BudgetTracker(store);
    const conversationMemory = new ConversationMemory(store);
    const sessionLearner = new SessionLearner(store);

    // Phase 20: Code Health
    const codeHealthAnalyzer = new CodeHealthAnalyzer(store, process.cwd());
    let codeHealthAnalyzed = false;

    let reverseRefsBuilt = false;
    async function ensureReverseRefs(): Promise<void> {
        if (reverseRefsBuilt) return;
        store.buildReverseRefs();
        reverseRefsBuilt = true;
    }

    // Auto-index guard: ensure DB has data before queries
    let indexPromise: Promise<void> | null = null;
    async function ensureIndexed(): Promise<void> {
        if (!isDbEmpty(store)) return;
        if (indexPromise) { await indexPromise; return; }
        indexPromise = (async () => {
            try {
                const rootDir = detectProjectRoot(process.cwd());
                const result = await autoIndex(store, rootDir);
                process.stderr.write(
                    `[atlasmemory] Auto-indexed ${result.files} files, ${result.symbols} symbols\n`
                );
            } catch (error: any) {
                indexPromise = null; // Reset so future calls can retry
                throw error;
            }
        })();
        await indexPromise;
    }

    const server = new Server(
        { name: NAME, version: VERSION },
        { capabilities: { tools: {}, sampling: {} } }
    );

    // Phase 20: SamplingClient adapter — lazy, checks client capabilities at call time
    const lazySamplingClient: import('@atlasmemory/core').SamplingClient = {
        canSample: () => {
            try {
                return !!(server as any)._clientCapabilities?.sampling;
            } catch { return false; }
        },
        requestCompletion: async (prompt: string, maxTokens: number) => {
            const { CreateMessageRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
            const result = await server.request(CreateMessageRequestSchema, {
                messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
                maxTokens,
            });
            if (result.content.type === 'text') return result.content.text;
            return '';
        },
    };

    const enrichmentCoordinator = new EnrichmentCoordinator(store, lazySamplingClient);
    const proactiveBuilder = new ProactiveResponseBuilder({
        store, codeHealth: codeHealthAnalyzer, enrichmentCoordinator,
        impactAnalyzer, prefetchEngine,
    });

    async function ensureCodeHealth(): Promise<void> {
        if (codeHealthAnalyzed) return;
        try {
            await codeHealthAnalyzer.analyzeRepo();
            codeHealthAnalyzed = true;
        } catch (e) {
            process.stderr.write(`[atlasmemory] Code health analysis skipped: ${e}\n`);
            codeHealthAnalyzed = true;
        }
    }

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'search_repo',
                description: 'Search the indexed repository for relevant files. Auto-indexes on first use.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'index_file',
                description: 'Parse a single file, extract symbols/anchors, store them.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to the file' },
                    },
                    required: ['path'],
                },
            },
            {
                name: 'index_repo',
                description: 'Index the repository at the given path.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to the repository root' },
                        incremental: { type: 'boolean', description: 'Incremental indexing (default: true)' },
                    },
                    required: ['path'],
                },
            },
            {
                name: 'get_allowed_evidence',
                description: 'Get valid anchor candidates for a file.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        max: { type: 'number' },
                    },
                    required: ['path'],
                },
            },
            {
                name: 'validate_file_card',
                description: 'Validate a FileCard JSON against schema and allowed anchors.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        card: { type: 'object' },
                        strict: { type: 'boolean' },
                    },
                    required: ['card'],
                },
            },
            {
                name: 'upsert_file_card',
                description: 'Store a validated FileCard.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        card: { type: 'object' },
                    },
                    required: ['path', 'card'],
                },
            },
            {
                name: 'refresh_cards_for_changed_files',
                description: 'Get files that need card updates (missing or stale).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: { type: 'number', description: 'Max files to return (default 10)' },
                    },
                },
            },
            {
                name: 'build_context',
                description: 'Build context pack for AI. Modes: "task" (proof-backed context for objective), "project" (compact bootstrap), "delta" (changes since last), "session" (full session bootstrap). Primary tool for getting codebase context.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        mode: { type: 'string', enum: ['task', 'project', 'delta', 'session'], description: 'task=objective-driven, project=overview, delta=changes, session=full bootstrap' },
                        objective: { type: 'string', description: 'What you are trying to accomplish (required for task mode)' },
                        budget: { type: 'number', description: 'Token budget (default: 8000 for task, 1500 for project, 800 for delta)' },
                        since: { type: 'string', description: 'For delta: "last", git SHA, or timestamp' },
                        sessionId: { type: 'string', description: 'Session ID for continuity' },
                        proof: { type: 'string', enum: ['strict', 'warn', 'off'], description: 'Proof enforcement (default: strict)' },
                        format: { type: 'string', enum: ['capsule', 'json'], description: 'Output format (default: capsule)' },
                    },
                    required: ['mode'],
                },
            },
            {
                name: 'prove',
                description: 'Prove one or more claims with evidence from the codebase. Every claim is linked to specific code locations with line ranges and snippet hashes.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        claims: { description: 'Single claim string or array of {text, scope} objects' },
                        scope: { type: 'string', description: 'File path to scope search (single claim)' },
                        maxEvidence: { type: 'number', description: 'Max evidence items per claim (default: 5)' },
                        proofMode: { type: 'string', enum: ['strict', 'warn', 'off'] },
                    },
                    required: ['claims'],
                },
            },
            {
                name: 'build_task_pack',
                description: '[Deprecated: use build_context] Build a proof-backed context pack for a given objective.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objective: { type: 'string', description: 'User objective' },
                        token_budget: { type: 'number', description: 'Max tokens (default 8000)' },
                        proof: { type: 'string', enum: ['strict', 'warn', 'off'] },
                        sessionId: { type: 'string' },
                        contractHash: { type: 'string' },
                    },
                    required: ['objective'],
                },
            },
            {
                name: 'auto_refresh',
                description: 'Auto-refresh stale cards using LLM.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        maxFiles: { type: 'number', description: 'Max files (default 5)' },
                    },
                },
            },
            {
                name: 'bootpack',
                description: '[Deprecated: use build_context] Generate compact project bootstrap capsule.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        budget: { type: 'number', description: 'Token budget (default 1500)' },
                        format: { type: 'string', enum: ['capsule', 'json'] },
                        compress: { type: 'boolean' },
                        proof: { type: 'string', enum: ['strict', 'warn', 'off'] },
                    },
                },
            },
            {
                name: 'deltapack',
                description: '[Deprecated: use build_context] Generate change-only capsule since a point in time.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        since: { type: 'string', description: 'last | git sha | timestamp' },
                        budget: { type: 'number' },
                        format: { type: 'string', enum: ['capsule', 'json'] },
                        sessionId: { type: 'string' },
                        proof: { type: 'string', enum: ['strict', 'warn', 'off'] },
                    },
                },
            },
            {
                name: 'prove_claim',
                description: '[Deprecated: use prove] Find evidence anchors for a claim.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        claimText: { type: 'string' },
                        scopePath: { type: 'string' },
                        maxEvidence: { type: 'number' },
                        sessionId: { type: 'string' },
                        proofMode: { type: 'string', enum: ['strict', 'warn', 'off'] },
                        proofBudget: { type: 'number' },
                    },
                    required: ['claimText'],
                },
            },
            {
                name: 'prove_claims',
                description: '[Deprecated: use prove] Batch prove multiple claims with dedup and budgeting.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        claims: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string' },
                                    scopePath: { type: 'string' },
                                },
                                required: ['text'],
                            },
                        },
                        maxEvidence: { type: 'number' },
                        sessionId: { type: 'string' },
                        proofMode: { type: 'string', enum: ['strict', 'warn', 'off'] },
                        proofBudget: { type: 'number' },
                    },
                    required: ['claims'],
                },
            },
            {
                name: 'handshake',
                description: 'Generate compact agent operating protocol.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        budget: { type: 'number', description: 'Token budget (default 400)' },
                    },
                },
            },
            {
                name: 'session_bootstrap',
                description: '[Deprecated: use build_context] Bootstrap session context (fresh or resume mode).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', enum: ['fresh', 'resume'] },
                        sessionId: { type: 'string' },
                        bootBudget: { type: 'number' },
                        deltaBudget: { type: 'number' },
                        maxBudget: { type: 'number' },
                        compress: { type: 'boolean' },
                        format: { type: 'string', enum: ['capsule', 'json'] },
                    },
                },
            },
            {
                name: 'generate_claude_md',
                description: 'Auto-generate AI instruction files from indexed codebase. Supports CLAUDE.md, .cursorrules, copilot-instructions.md, or all at once.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        format: { type: 'string', enum: ['claude', 'cursor', 'copilot', 'all'], description: 'Output format (default: claude)' },
                        stdout: { type: 'boolean', description: 'Return content instead of writing files (default: true)' },
                        output: { type: 'string', description: 'File path to write (single format only)' },
                        force: { type: 'boolean', description: 'Overwrite existing files even if hand-written (default: false)' },
                    },
                },
            },
            {
                name: 'ai_readiness',
                description: 'Compute AI Readiness Score for the indexed project. Returns coverage metrics and improvement suggestions.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'get_context_contract',
                description: 'Get latest context contract and drift status.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sessionId: { type: 'string' },
                        providedContractHash: { type: 'string' },
                    },
                },
            },
            {
                name: 'acknowledge_context',
                description: 'Acknowledge a context contract hash.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sessionId: { type: 'string' },
                        contractHash: { type: 'string' },
                    },
                    required: ['contractHash'],
                },
            },
            {
                name: 'analyze_impact',
                description: 'Analyze impact of changing a symbol or file. Shows dependent files, affected flows, test coverage, and risk level.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        symbol_name: { type: 'string', description: 'Symbol name (e.g. "handleLogin")' },
                        file_path: { type: 'string', description: 'Narrow scope to specific file' },
                        include_transitive: { type: 'boolean', description: 'Include 2-hop dependents (default: true)' },
                        session_id: { type: 'string', description: 'Session ID for budget tracking' },
                    },
                    required: ['symbol_name'],
                },
            },
            {
                name: 'smart_diff',
                description: 'Semantically-enriched diff: symbol changes, breaking changes, affected flows, test coverage. Much richer than raw git diff.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        since: { type: 'string', description: 'Git ref (default: HEAD for unstaged changes)' },
                        file_path: { type: 'string', description: 'Specific file path' },
                        session_id: { type: 'string', description: 'Session ID for budget tracking' },
                    },
                },
            },
            {
                name: 'remember',
                description: 'Record a constraint or decision for the current session. Constraints are surfaced in future context builds to prevent conflicting actions.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        type: { type: 'string', enum: ['constraint', 'decision'], description: 'constraint = must not do, decision = was decided' },
                        text: { type: 'string', description: 'What to remember' },
                        related_files: { type: 'array', items: { type: 'string' }, description: 'Related file paths' },
                        session_id: { type: 'string', description: 'Session ID' },
                    },
                    required: ['type', 'text'],
                },
            },
            {
                name: 'session_context',
                description: 'Get full conversation context: active constraints, decisions, files accessed, token budget, and relevant past sessions.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        session_id: { type: 'string', description: 'Session ID' },
                        include_past_sessions: { type: 'boolean', description: 'Include related past sessions (default: true)' },
                        budget_limit: { type: 'number', description: 'Context window size for budget tracking' },
                    },
                },
            },
            {
                name: 'enrich_files',
                description: 'Enrich files with AI-generated semantic tags and intent cards (Level3). Improves concept-level search. Requires MCP sampling support.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        file_paths: { type: 'array', items: { type: 'string' }, description: 'File paths to enrich (default: auto-select unenriched files)' },
                        limit: { type: 'number', description: 'Max files to enrich (default: 10)' },
                    },
                },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments || {};

        try { switch (request.params.name) {
            case 'search_repo': {
                await ensureIndexed();
                await ensureCodeHealth();
                const query = String(args.query);
                const results = searchService.search(query);

                // Log search event
                const sessionId = args.session_id ? String(args.session_id) : 'default';
                const resultFileIds = results.map((r: any) => r.file?.id || '').filter(Boolean);
                conversationMemory.recordSearch(sessionId, query, resultFileIds);

                // Apply learned pattern boosts
                const boosts = sessionLearner.getSearchBoosts(query);
                if (boosts.size > 0) {
                    for (const result of results as any[]) {
                        const fileId = result.file?.id;
                        if (fileId && boosts.has(fileId)) {
                            result.score = (result.score || 0) + boosts.get(fileId)!;
                            result.patternBoosted = true;
                        }
                    }
                    results.sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
                }

                const responseText = JSON.stringify(results, null, 2);
                budgetTracker.trackUsage(sessionId, 'search_repo', responseText);

                // Phase 20: Proactive intelligence
                const intelligenceText = proactiveBuilder.format(resultFileIds);

                // Fire-and-forget: async enrichment for unenriched result files
                if (enrichmentCoordinator.canSample()) {
                    enrichmentCoordinator.enrichIfNeeded(resultFileIds).catch(() => {});
                }

                return { content: [{ type: 'text', text: responseText + intelligenceText }] };
            }

            case 'index_repo': {
                const repoPath = String(args.path);
                const result = await autoIndex(store, repoPath);
                reverseRefsBuilt = false;
                codeHealthAnalyzed = false;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, files: result.files, symbols: result.symbols }),
                    }],
                };
            }

            case 'index_file': {
                const filePath = path.resolve(String(args.path));
                if (!fs.existsSync(filePath)) {
                    return { content: [{ type: 'text', text: `File not found: ${filePath}. Provide an absolute path to an existing file.` }], isError: true };
                }

                let content: string;
                try {
                    content = fs.readFileSync(filePath, 'utf-8');
                } catch (e: any) {
                    return { content: [{ type: 'text', text: `Cannot read file: ${e.message}` }], isError: true };
                }
                const { Indexer } = await import('@atlasmemory/indexer');
                const indexer = new Indexer();
                const { symbols, anchors, imports, refs } = indexer.parse(filePath, content);

                const language = path.extname(filePath).slice(1);
                const { createHash } = await import('crypto');
                const contentHash = createHash('sha256').update(content).digest('hex');
                const loc = content.split('\n').length;

                const fileId = store.addFile(filePath, language, contentHash, loc, content);

                // Clear stale data
                const oldSyms = store.db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(fileId) as { id: string }[];
                if (oldSyms.length > 0) {
                    const ph = oldSyms.map(() => '?').join(',');
                    store.db.prepare(`DELETE FROM refs WHERE from_symbol_id IN (${ph}) OR to_symbol_id IN (${ph})`).run(
                        ...oldSyms.map(s => s.id), ...oldSyms.map(s => s.id)
                    );
                }
                store.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
                store.db.prepare('DELETE FROM anchors WHERE file_id = ?').run(fileId);
                store.db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
                store.deleteFlowCardsForFile(fileId);

                for (const sym of symbols) { sym.fileId = fileId; store.addSymbol(sym); }
                for (const anchor of anchors) { anchor.fileId = fileId; store.upsertAnchor(anchor); }
                for (const imp of imports) { imp.fileId = fileId; store.addImport(imp); }
                for (const ref of refs) { store.addRef(ref); }

                const flowCards = flowGenerator.rebuildAndStoreForFile(fileId);
                const fileCard = await deterministicCardGenerator.generateFileCard(fileId, filePath, symbols, content, anchors, flowCards);
                const quality = scoreFileCard(fileCard, symbols, anchors);
                fileCard.qualityScore = quality.score;
                fileCard.qualityFlags = quality.flags;
                store.addFileCard(fileCard);
                store.setState('last_index_at', new Date().toISOString());
                reverseRefsBuilt = false;

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ file: { fileId, path: filePath, language, loc }, symbols, anchors, imports, refs, flowCards }, null, 2),
                    }],
                };
            }

            case 'get_allowed_evidence': {
                const filePath = String(args.path);
                const max = Number(args.max || 200);
                const file = store.getFiles().find(f => f.path === filePath);
                if (!file) return { content: [{ type: 'text', text: `File not indexed: ${filePath}. Run index_file or index_repo first.` }], isError: true };

                const anchors = store.getAnchorsForFile(file.id);
                const symbols = store.getSymbolsForFile(file.id);
                const candidates = anchors.map(a => {
                    const sym = symbols.find(s => s.startLine === a.startLine && s.endLine === a.endLine);
                    return { anchorId: a.id, symbolName: sym?.name, signature: sym?.signature, startLine: a.startLine, endLine: a.endLine, len: a.endLine - a.startLine };
                }).sort((a, b) => b.len - a.len).slice(0, max);

                return { content: [{ type: 'text', text: JSON.stringify({ fileId: file.id, candidates }, null, 2) }] };
            }

            case 'validate_file_card': {
                const card = args.card as any;
                const errors: string[] = [];
                if (!card) { errors.push('No card provided'); }
                else if (!card.level1) { errors.push('Missing level1'); }
                else {
                    if (card.level1.purpose?.length > 300) errors.push('Purpose too long (>300 chars)');
                    if (card.level1.evidenceAnchorIds) {
                        for (const id of card.level1.evidenceAnchorIds) {
                            if (!store.getAnchor(id)) errors.push(`Invalid evidenceAnchorId: ${id}`);
                        }
                    }
                }
                return { content: [{ type: 'text', text: JSON.stringify({ ok: errors.length === 0, errors }, null, 2) }] };
            }

            case 'upsert_file_card': {
                const filePath = String(args.path);
                const cardData = args.card as any;
                const file = store.getFiles().find(f => f.path === filePath);
                if (!file) return { content: [{ type: 'text', text: `File not indexed: ${filePath}. Run index_file or index_repo first.` }], isError: true };
                if (!cardData?.level1) return { content: [{ type: 'text', text: 'Invalid card (missing level1)' }], isError: true };

                const fullCard: any = {
                    fileId: file.id, path: filePath,
                    level0: cardData.level0 || { purpose: 'Updated via MCP', exports: [], sideEffects: [] },
                    level1: cardData.level1, level2: cardData.level2, cardHash: '',
                };
                const symbols = store.getSymbolsForFile(file.id);
                const anchors = store.getAnchorsForFile(file.id);
                const quality = scoreFileCard(fullCard, symbols, anchors);
                fullCard.qualityScore = quality.score;
                fullCard.qualityFlags = quality.flags;

                const { createHash } = await import('crypto');
                fullCard.cardHash = createHash('sha256')
                    .update(JSON.stringify(fullCard.level0) + JSON.stringify(fullCard.level1) + JSON.stringify(fullCard.level2 || {}))
                    .digest('hex');
                store.addFileCard(fullCard);

                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, fileId: file.id, cardHash: fullCard.cardHash, qualityScore: fullCard.qualityScore }, null, 2) }] };
            }

            case 'refresh_cards_for_changed_files': {
                const limit = Number(args.limit || 10);
                const files = store.db.prepare('SELECT id, path, updated_at FROM files').all() as any[];
                const cards = store.db.prepare('SELECT file_id, updated_at FROM file_cards').all() as any[];
                const cardMap = new Map(cards.map((c: any) => [c.file_id, c.updated_at]));
                const staleFiles: string[] = [];

                for (const f of files) {
                    const cardTime = cardMap.get(f.id);
                    if (!cardTime || new Date(f.updated_at) > new Date(cardTime as string)) {
                        staleFiles.push(f.path);
                    }
                    if (staleFiles.length >= limit) break;
                }
                return { content: [{ type: 'text', text: JSON.stringify({ staleFiles }, null, 2) }] };
            }

            case 'auto_refresh': {
                const apiKey = process.env.ATLAS_LLM_API_KEY;
                if (!apiKey) return { content: [{ type: 'text', text: 'Error: ATLAS_LLM_API_KEY required' }], isError: true };
                const { AutoRefresher, LLMService } = await import('@atlasmemory/summarizer');
                const refresher = new AutoRefresher(store, new LLMService({ apiKey }));
                const stats = await refresher.refreshAll(Number(args.maxFiles || 5));
                store.setState('last_refresh_at', new Date().toISOString());
                return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
            }

            case 'build_context': {
                await ensureIndexed();
                const bcMode = args.mode as string;
                switch (bcMode) {
                    case 'task': {
                        if (!args.objective) return { content: [{ type: 'text', text: 'Error: "objective" required for task mode' }] };
                        const bcObjective = String(args.objective);
                        const bcBudget = Number(args.budget || 8000);
                        const bcProof = (['strict', 'warn', 'off'].includes(String(args.proof)) ? args.proof : 'strict') as string;
                        const bcScoredResults = searchService.search(bcObjective, 20);
                        const bcFileIds = bcScoredResults.map(r => r.file.id);
                        const bcPack = taskPackBuilder.build(bcObjective, bcFileIds, bcBudget, { proof: bcProof });
                        const bcPackHash = sha256(bcPack);
                        contractService.createSnapshot({ sessionId: args.sessionId ? String(args.sessionId) : undefined, objective: bcObjective, taskpackHash: bcPackHash, proofMode: bcProof });

                        // Log event & enhance response
                        const bcSessionId = args.sessionId ? String(args.sessionId) : 'default';
                        conversationMemory.recordContextBuild(bcSessionId, 'task', bcObjective, bcFileIds, bcPack.length / 4);

                        const prefetchSuggestions = prefetchEngine.predictNextFiles({
                            searchQuery: bcObjective, accessedFileIds: bcFileIds, objective: bcObjective,
                        }, 3);
                        const prefetchText = prefetchEngine.formatSuggestions(prefetchSuggestions);

                        const bcConstraints = conversationMemory.getActiveConstraints(bcSessionId);
                        let constraintText = '';
                        if (bcConstraints.length > 0) {
                            constraintText = '\n\n⚠️ Active Constraints:\n' + bcConstraints.map(c => `  - ${c.text}`).join('\n');
                        }

                        const bcBudgetReport = budgetTracker.trackUsage(bcSessionId, 'build_context', bcPack);

                        return { content: [{ type: 'text', text: bcPack + constraintText + prefetchText + '\n\n' + budgetTracker.formatBudgetHeader(bcBudgetReport) }] };
                    }
                    case 'project': {
                        const bpResult = bootPackBuilder.buildBootPack({
                            budget: Number(args.budget || 1500),
                            format: (args.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json',
                            compress: 'on',
                            proof: (['strict', 'warn', 'off'].includes(String(args.proof)) ? args.proof : 'strict') as string,
                        });
                        return { content: [{ type: 'text', text: bpResult.text }] };
                    }
                    case 'delta': {
                        const dpResult = bootPackBuilder.buildDeltaPack({
                            since: String(args.since || 'last'),
                            budget: Number(args.budget || 800),
                            format: (args.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json',
                            sessionId: args.sessionId ? String(args.sessionId) : undefined,
                            proof: (['strict', 'warn', 'off'].includes(String(args.proof)) ? args.proof : 'warn') as string,
                        });
                        return { content: [{ type: 'text', text: dpResult.text }] };
                    }
                    case 'session': {
                        const sbMode = (args.sessionId ? 'resume' : 'fresh') as 'fresh' | 'resume';
                        const sbSessionId = args.sessionId ? String(args.sessionId) : undefined;
                        const sbBootBudget = Number(args.budget || 1500);
                        const sbFormat = (args.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json';

                        const sbMerged = bootPackBuilder.buildSessionBootstrap({
                            mode: sbMode, sessionId: sbSessionId, bootBudget: sbBootBudget, deltaBudget: 800,
                            format: sbFormat, compress: true,
                        });

                        const sbBootResult = bootPackBuilder.buildBootPack({ budget: sbBootBudget, format: 'capsule', compress: 'on', proof: 'strict' });
                        const sbBootpackHash = sha256(sbBootResult.text);
                        const sbDbSig = store.getDbSignature(process.cwd());
                        const sbGitHead = contractService.getGitHead();

                        const { contractHash: sbContractHash } = contractService.createSnapshot({
                            sessionId: sbSessionId, bootpackHash: sbBootpackHash, proofMode: 'strict', minDbCoverage: 0.8, dbSig: sbDbSig, gitHead: sbGitHead,
                        });

                        if (sbSessionId) store.setState('last_bootstrap_at', new Date().toISOString(), sbSessionId);
                        else store.setState('last_bootstrap_at', new Date().toISOString());

                        const sbEnrichableCards = bootPackBuilder.countEnrichableCards();
                        return {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({ mode: sbMode, merged: sbMerged.text, contractHash: sbContractHash, dbSig: sbDbSig, gitHead: sbGitHead, enrichableCards: sbEnrichableCards }, null, 2),
                            }],
                        };
                    }
                    default:
                        return { content: [{ type: 'text', text: `Unknown mode: ${bcMode}. Use: task, project, delta, session` }] };
                }
            }

            case 'prove': {
                await ensureIndexed();
                const proveClaims = args.claims;
                if (typeof proveClaims === 'string') {
                    const proveResult = bootPackBuilder.proveClaim(proveClaims, args.scope ? String(args.scope) : undefined, Number(args.maxEvidence || 5), {
                        proofMode: (['strict', 'warn', 'off'].includes(String(args.proofMode)) ? args.proofMode : 'strict') as string,
                        proofBudget: 2500,
                    });
                    return { content: [{ type: 'text', text: JSON.stringify(proveResult, null, 2) }] };
                } else if (Array.isArray(proveClaims)) {
                    const mappedClaims = proveClaims
                        .map((item: any) => ({ text: String(item?.text || item), scopePath: item?.scope ? String(item.scope) : undefined }))
                        .filter((item: any) => item.text.trim().length > 0);
                    const proveResults = bootPackBuilder.proveClaims(mappedClaims, Number(args.maxEvidence || 5), {
                        proofMode: (['strict', 'warn', 'off'].includes(String(args.proofMode)) ? args.proofMode : 'strict') as string,
                        proofBudget: 2500,
                    });
                    return { content: [{ type: 'text', text: JSON.stringify(proveResults, null, 2) }] };
                }
                return { content: [{ type: 'text', text: 'Error: claims must be a string or array' }] };
            }

            case 'build_task_pack': {
                await ensureIndexed();
                const objective = String(args.objective || '');
                const tokenBudget = Number(args.token_budget || 8000);
                const sessionId = args.sessionId ? String(args.sessionId) : undefined;
                const proof = (['strict', 'warn', 'off'].includes(String(args.proof)) ? args.proof : 'strict') as string;
                const enforce = (['strict', 'off'].includes(String(process.env.ATLAS_CONTRACT_ENFORCE))
                    ? process.env.ATLAS_CONTRACT_ENFORCE : 'warn') as string;

                const contract = contractService.evaluateContract({
                    sessionId,
                    providedContractHash: args.contractHash ? String(args.contractHash) : undefined,
                    enforce,
                });

                if (enforce === 'strict' && contract.shouldBlock) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: JSON.stringify({ code: 'BOOTSTRAP_REQUIRED', reasons: contract.reasons }, null, 2) }],
                    };
                }

                const scoredResults = searchService.search(objective, 20);
                const fileIds = scoredResults.map(r => r.file.id);
                const pack = taskPackBuilder.build(objective, fileIds, tokenBudget, { proof });
                const packHash = sha256(pack);
                contractService.createSnapshot({ sessionId, objective, taskpackHash: packHash, proofMode: proof });

                return { content: [{ type: 'text', text: pack }] };
            }

            case 'bootpack': {
                await ensureIndexed();
                const result = bootPackBuilder.buildBootPack({
                    budget: Number(args.budget || 1500),
                    format: (args.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json',
                    compress: args.compress === false ? 'off' : 'on',
                    proof: (['strict', 'warn', 'off'].includes(String(args.proof)) ? args.proof : 'strict') as string,
                });
                return { content: [{ type: 'text', text: result.text }] };
            }

            case 'deltapack': {
                const result = bootPackBuilder.buildDeltaPack({
                    since: String(args.since || 'last'),
                    budget: Number(args.budget || 800),
                    format: (args.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json',
                    sessionId: args.sessionId ? String(args.sessionId) : undefined,
                    proof: (['strict', 'warn', 'off'].includes(String(args.proof)) ? args.proof : 'warn') as string,
                });
                return { content: [{ type: 'text', text: result.text }] };
            }

            case 'prove_claim': {
                await ensureIndexed();
                const result = bootPackBuilder.proveClaim(String(args.claimText || ''), args.scopePath ? String(args.scopePath) : undefined, Number(args.maxEvidence || 5), {
                    sessionId: args.sessionId ? String(args.sessionId) : undefined,
                    proofMode: (['strict', 'warn', 'off'].includes(String(args.proofMode)) ? args.proofMode : 'strict') as string,
                    proofBudget: Number(args.proofBudget || 2500),
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'prove_claims': {
                await ensureIndexed();
                const claims = (Array.isArray(args.claims) ? args.claims : [])
                    .map((item: any) => ({ text: String(item?.text || ''), scopePath: item?.scopePath ? String(item.scopePath) : undefined }))
                    .filter((item: any) => item.text.trim().length > 0);
                const result = bootPackBuilder.proveClaims(claims, Number(args.maxEvidence || 5), {
                    sessionId: args.sessionId ? String(args.sessionId) : undefined,
                    proofMode: (['strict', 'warn', 'off'].includes(String(args.proofMode)) ? args.proofMode : 'strict') as string,
                    proofBudget: Number(args.proofBudget || 2500),
                });
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'handshake': {
                await ensureIndexed();
                await ensureReverseRefs();

                const lastSessionId = store.getState('last_active_session');
                const currentSessionId = args.session_id ? String(args.session_id) : undefined;
                if (lastSessionId && currentSessionId && lastSessionId !== currentSessionId) {
                    sessionLearner.learnFromSession(lastSessionId);
                }
                if (currentSessionId) {
                    store.setState('last_active_session', currentSessionId);
                }

                const result = bootPackBuilder.buildHandshake(Number(args.budget || 400));
                const hotPaths = sessionLearner.formatHotPaths();
                const enhanced = hotPaths ? result.text + '\n\n' + hotPaths : result.text;

                await ensureCodeHealth();
                const riskySummary = codeHealthAnalyzer.getRiskySummary();
                const enrichmentInvite = enrichmentCoordinator.getEnrichmentInvitation();
                const fullEnhanced = enhanced + (riskySummary ? '\n\n' + riskySummary : '') + (enrichmentInvite ? '\n\n' + enrichmentInvite : '');
                return { content: [{ type: 'text', text: fullEnhanced }] };
            }

            case 'session_bootstrap': {
                await ensureIndexed();
                const mode = args.mode === 'resume' ? 'resume' : 'fresh';
                const sessionId = args.sessionId ? String(args.sessionId) : undefined;
                const bootBudget = Number(args.bootBudget || 1500);
                const deltaBudget = Number(args.deltaBudget || 800);
                const format = (args.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json';

                const merged = bootPackBuilder.buildSessionBootstrap({
                    mode, sessionId, bootBudget, deltaBudget,
                    maxBudget: args.maxBudget ? Number(args.maxBudget) : undefined,
                    format, compress: args.compress !== false,
                });

                const bootResult = bootPackBuilder.buildBootPack({ budget: bootBudget, format: 'capsule', compress: 'on', proof: 'strict' });
                const bootpackHash = sha256(bootResult.text);
                const dbSig = store.getDbSignature(process.cwd());
                const gitHead = contractService.getGitHead();

                const { contractHash, snapshot } = contractService.createSnapshot({
                    sessionId, bootpackHash, proofMode: 'strict', minDbCoverage: 0.8, dbSig, gitHead,
                });

                if (sessionId) store.setState('last_bootstrap_at', new Date().toISOString(), sessionId);
                else store.setState('last_bootstrap_at', new Date().toISOString());

                const enrichableCards = bootPackBuilder.countEnrichableCards();
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ mode, merged: merged.text, contractHash, dbSig, gitHead, enrichableCards }, null, 2),
                    }],
                };
            }

            case 'generate_claude_md': {
                await ensureIndexed();
                const { generateAll } = await import('./generate-claude-md.js');
                const rootDir = (await import('./auto-index.js')).detectProjectRoot(process.cwd());
                const format = (['claude', 'cursor', 'copilot', 'all'].includes(String(args.format)) ? args.format : 'claude') as string;
                const force = args.force === true;
                const result = generateAll(store, { rootDir, format: format as any, force });

                if (args.output && result.files.length === 1) {
                    const outputPath = path.resolve(String(args.output));
                    fs.writeFileSync(outputPath, result.files[0].content, 'utf-8');
                    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, path: outputPath, format, readiness: result.readiness.overall }) }] };
                }

                if (args.stdout === false) {
                    const written: string[] = [];
                    for (const file of result.files) {
                        const dir = path.dirname(file.path);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(file.path, file.content, 'utf-8');
                        written.push(file.path);
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, files: written, format, readiness: result.readiness.overall }) }] };
                }

                // Return content (default)
                if (result.files.length === 1) {
                    return { content: [{ type: 'text', text: result.files[0].content }] };
                }
                const combined = result.files.map(f => `--- ${path.basename(f.path)} ---\n${f.content}`).join('\n\n');
                return { content: [{ type: 'text', text: combined }] };
            }

            case 'ai_readiness': {
                await ensureIndexed();
                const { computeAiReadiness } = await import('./generate-claude-md.js');
                const readiness = computeAiReadiness(store);
                return { content: [{ type: 'text', text: JSON.stringify(readiness, null, 2) }] };
            }

            case 'get_context_contract': {
                const enforce = (['strict', 'off'].includes(String(process.env.ATLAS_CONTRACT_ENFORCE))
                    ? process.env.ATLAS_CONTRACT_ENFORCE : 'warn') as string;
                const contract = contractService.evaluateContract({
                    sessionId: args.sessionId ? String(args.sessionId) : undefined,
                    providedContractHash: args.providedContractHash ? String(args.providedContractHash) : undefined,
                    enforce,
                });
                // Add recommended action to help AI agents
                if (contract && typeof contract === 'object') {
                    const contractAny = contract as any;
                    if (contractAny.shouldBlock || contractAny.needsBootstrap) {
                        contractAny.recommendedAction = 'Call build_context({ mode: "session" }) to resync state';
                    }
                }
                return { content: [{ type: 'text', text: JSON.stringify(contract, null, 2) }] };
            }

            case 'acknowledge_context': {
                const ok = contractService.acknowledgeContext(
                    String(args.contractHash || ''),
                    args.sessionId ? String(args.sessionId) : undefined
                );
                if (!ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'CONTRACT_NOT_FOUND' }) }] };
                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, contractHash: args.contractHash }) }] };
            }

            case 'analyze_impact': {
                await ensureIndexed();
                await ensureReverseRefs();
                const symbolName = String(args.symbol_name);
                const symbols = args.file_path
                    ? store.findSymbolsByName(symbolName, store.getFileId(path.resolve(String(args.file_path))))
                    : store.findSymbolsByName(symbolName);

                if (symbols.length === 0) {
                    return { content: [{ type: 'text', text: `Symbol "${symbolName}" not found in index. Run index_repo first.` }], isError: true };
                }

                const report = impactAnalyzer.analyzeSymbol(symbols[0].id, { includeTransitive: args.include_transitive !== false });
                const formatted = impactAnalyzer.formatReport(report);

                const sessionId = args.session_id ? String(args.session_id) : 'default';
                const budgetReport = budgetTracker.trackUsage(sessionId, 'analyze_impact', formatted);

                return { content: [{ type: 'text', text: formatted + '\n\n' + budgetTracker.formatBudgetHeader(budgetReport) }] };
            }

            case 'smart_diff': {
                await ensureIndexed();
                await ensureReverseRefs();
                const diffs = diffEnricher.enrichGitDiff(args.since ? String(args.since) : undefined);

                if (diffs.length === 0) {
                    return { content: [{ type: 'text', text: 'No changes detected.' }] };
                }

                const formatted = diffEnricher.formatDiffs(diffs);
                const sessionId = args.session_id ? String(args.session_id) : 'default';
                const budgetReport = budgetTracker.trackUsage(sessionId, 'smart_diff', formatted);

                return { content: [{ type: 'text', text: formatted + '\n\n' + budgetTracker.formatBudgetHeader(budgetReport) }] };
            }

            case 'remember': {
                const sessionId = args.session_id ? String(args.session_id) : 'default';
                const memType = String(args.type);
                const text = String(args.text);
                const relatedFiles = Array.isArray(args.related_files) ? args.related_files.map(String) : [];

                if (memType === 'constraint') {
                    conversationMemory.recordConstraint(sessionId, text);
                } else {
                    conversationMemory.recordDecision(sessionId, text, relatedFiles.map(f => store.getFileId(path.resolve(f)) || f));
                }

                const constraints = conversationMemory.getActiveConstraints(sessionId);
                const response = `✅ Recorded ${memType}: "${text}"\n\n` +
                    (constraints.length > 0 ? '⚠️ Active Constraints:\n' + constraints.map(c => `  - ${c.text}`).join('\n') : 'No active constraints.');

                return { content: [{ type: 'text', text: response }] };
            }

            case 'session_context': {
                const sessionId = args.session_id ? String(args.session_id) : 'default';
                const ctx = conversationMemory.getContext(sessionId);

                let response = conversationMemory.formatContext(ctx);

                const budgetLimit = args.budget_limit ? Number(args.budget_limit) : undefined;
                const budgetReport = budgetTracker.getReport(sessionId, budgetLimit);
                response += '\n\n' + budgetTracker.formatBudgetHeader(budgetReport);

                const hotPaths = sessionLearner.formatHotPaths();
                if (hotPaths) response += '\n\n' + hotPaths;

                if (args.include_past_sessions !== false && ctx.currentObjective) {
                    const related = conversationMemory.findRelatedSessions(ctx.currentObjective);
                    if (related.length > 0) {
                        response += '\n\n📝 Related Previous Sessions:';
                        for (const r of related) {
                            response += `\n  - Session ${r.sessionId.slice(0, 8)}... (${(r.overlap * 100).toFixed(0)}% overlap)`;
                            if (r.relevantConstraints.length > 0) {
                                response += `\n    Constraints: ${r.relevantConstraints.join(', ')}`;
                            }
                        }
                    }
                }

                return { content: [{ type: 'text', text: response }] };
            }

            case 'enrich_files': {
                await ensureIndexed();
                const limit = Number(args.limit || 10);

                if (!enrichmentCoordinator.canSample()) {
                    return { content: [{ type: 'text', text: 'Sampling not available. This tool requires an MCP client that supports sampling (e.g., Claude Desktop with sampling enabled).' }], isError: true };
                }

                if (args.file_paths && Array.isArray(args.file_paths)) {
                    const fileIds = (args.file_paths as string[])
                        .map(p => store.getFileId(path.resolve(String(p))))
                        .filter(Boolean) as string[];
                    await enrichmentCoordinator.enrichIfNeeded(fileIds);
                    const coverage = enrichmentCoordinator.getEnrichmentCoverage();
                    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, enriched: fileIds.length, coverage }, null, 2) }] };
                }

                const report = await enrichmentCoordinator.enrichBatch(limit);
                const coverage = enrichmentCoordinator.getEnrichmentCoverage();
                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...report, coverage }, null, 2) }] };
            }

            default:
                return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}. Use tools/list to see available tools.` }], isError: true };
        }
        } catch (error: any) {
            const toolName = request.params.name || 'unknown';
            const message = error?.message || String(error);
            process.stderr.write(`[atlasmemory] Error in ${toolName}: ${message}\n`);
            return {
                content: [{ type: 'text', text: `Internal error in ${toolName}: ${message}\n\nTry running 'index_repo' to rebuild the index, or check 'atlasmemory doctor' for diagnostics.` }],
                isError: true,
            };
        }
    });

    // Global error handlers — prevent silent crashes
    process.on('uncaughtException', (error) => {
        process.stderr.write(`[atlasmemory] Uncaught exception: ${error.message}\n`);
    });
    process.on('unhandledRejection', (reason) => {
        process.stderr.write(`[atlasmemory] Unhandled rejection: ${reason}\n`);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
