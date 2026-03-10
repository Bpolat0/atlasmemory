import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Store } from '@atlasmemory/store';
import { SearchService } from '@atlasmemory/retrieval';
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

    // Auto-index guard: ensure DB has data before queries
    let indexPromise: Promise<void> | null = null;
    async function ensureIndexed(): Promise<void> {
        if (!isDbEmpty(store)) return;
        if (indexPromise) { await indexPromise; return; }
        indexPromise = (async () => {
            const rootDir = detectProjectRoot(process.cwd());
            const result = await autoIndex(store, rootDir);
            process.stderr.write(
                `[atlasmemory] Auto-indexed ${result.files} files, ${result.symbols} symbols\n`
            );
        })();
        await indexPromise;
    }

    const server = new Server(
        { name: NAME, version: VERSION },
        { capabilities: { tools: {} } }
    );

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
                name: 'build_task_pack',
                description: 'Build a proof-backed context pack for a given objective.',
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
                description: 'Generate compact project bootstrap capsule.',
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
                description: 'Generate change-only capsule since a point in time.',
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
                description: 'Find evidence anchors for a claim.',
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
                description: 'Batch prove multiple claims with dedup and budgeting.',
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
                description: 'Bootstrap session context (fresh or resume mode).',
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
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments || {};

        switch (request.params.name) {
            case 'search_repo': {
                await ensureIndexed();
                const results = searchService.search(String(args.query));
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            }

            case 'index_repo': {
                const repoPath = String(args.path);
                const result = await autoIndex(store, repoPath);
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
                const result = bootPackBuilder.buildHandshake(Number(args.budget || 400));
                return { content: [{ type: 'text', text: result.text }] };
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

            case 'get_context_contract': {
                const enforce = (['strict', 'off'].includes(String(process.env.ATLAS_CONTRACT_ENFORCE))
                    ? process.env.ATLAS_CONTRACT_ENFORCE : 'warn') as string;
                const contract = contractService.evaluateContract({
                    sessionId: args.sessionId ? String(args.sessionId) : undefined,
                    providedContractHash: args.providedContractHash ? String(args.providedContractHash) : undefined,
                    enforce,
                });
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

            default:
                throw new Error(`Unknown tool: ${request.params.name}`);
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}
