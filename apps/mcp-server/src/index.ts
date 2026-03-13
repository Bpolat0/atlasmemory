import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Store } from '@atlasmemory/store';
import { SearchService } from '@atlasmemory/retrieval';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import { CardGenerator, FlowGenerator, scoreFileCard } from '@atlasmemory/summarizer';
import { sha256 } from '@atlasmemory/core';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Store
const dbPath = path.resolve(process.env.ATLAS_DB_PATH || '.atlas/atlas.db');
// Ensure directory exists if not
if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
const store = new Store(dbPath);
const searchService = new SearchService(store);
const taskPackBuilder = new TaskPackBuilder(store);
const bootPackBuilder = new BootPackBuilder(store);
const contractService = new ContextContractService(store, process.cwd());
const flowGenerator = new FlowGenerator(store);
const deterministicCardGenerator = new CardGenerator();

const server = new Server(
    {
        name: "atlas-memory-server",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);


server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "search_repo",
                description: "Search the indexed repository for relevant files",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Search query" },
                    },
                    required: ["query"],
                },
            },
            {
                name: "index_file",
                description: "Parse a single file, extract symbols/anchors, store them, and return extracted data.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Absolute path to the file" },
                    },
                    required: ["path"],
                },
            },
            {
                name: "get_allowed_evidence",
                description: "Get valid anchor candidates for a file.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        max: { type: "number" }
                    },
                    required: ["path"]
                }
            },
            {
                name: "validate_file_card",
                description: "Validate a FileCard JSON against schema and allowed anchors.",
                inputSchema: {
                    type: "object",
                    properties: {
                        card: { type: "object" },
                        strict: { type: "boolean" }
                    },
                    required: ["card"]
                }
            },
            {
                name: "upsert_file_card",
                description: "Store a validated FileCard.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        card: { type: "object" }
                    },
                    required: ["path", "card"]
                }
            },
            {
                name: "refresh_cards_for_changed_files",
                description: "Get a list of files that need card updates (missing or stale).",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "Max files to return (default 10)" }
                    }
                }
            },
            {
                name: "index_repo",
                description: "Index the repository at the given path",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Absolute path to the repository root" },
                        incremental: { type: "boolean", description: "Use incremental indexing (default: true)" },
                    },
                    required: ["path"],
                },
            },
            {
                name: "build_task_pack",
                description: "Build a context pack for a given objective",
                inputSchema: {
                    type: "object",
                    properties: {
                        objective: { type: "string", description: "User objective" },
                        token_budget: { type: "number", description: "Max tokens (default 8000)" },
                        proof: { type: "string", enum: ["strict", "warn", "off"], description: "Proof mode" },
                        allowUnproven: { type: "boolean", description: "Allow UNPROVEN claims" },
                        sessionId: { type: "string", description: "Session scope for contract checks" },
                        contractHash: { type: "string", description: "Provided context contract hash" }
                    },
                    required: ["objective"],
                },
            },
            {
                name: "auto_refresh",
                description: "Automatically refresh stale cards using LLM generation.",
                inputSchema: {
                    type: "object",
                    properties: {
                        maxFiles: { type: "number", description: "Max files to process (default 5)" }
                    }
                }
            },
            {
                name: "bootpack",
                description: "Generate compact project bootstrap capsule.",
                inputSchema: {
                    type: "object",
                    properties: {
                        budget: { type: "number", description: "Token budget (default 1500)" },
                        format: { type: "string", enum: ["capsule", "json"] },
                        compress: { type: "boolean", description: "Compression enabled" },
                        proof: { type: "string", enum: ["strict", "warn", "off"] }
                    }
                }
            },
            {
                name: "deltapack",
                description: "Generate change-only capsule since last/git sha/timestamp.",
                inputSchema: {
                    type: "object",
                    properties: {
                        since: { type: "string", description: "last | git sha | timestamp" },
                        budget: { type: "number", description: "Token budget (default 800)" },
                        format: { type: "string", enum: ["capsule", "json"] },
                        sessionId: { type: "string", description: "Optional session scope" },
                        proof: { type: "string", enum: ["strict", "warn", "off"] }
                    }
                }
            },
            {
                name: "prove_claim",
                description: "Find evidence anchors/snippets for a claim.",
                inputSchema: {
                    type: "object",
                    properties: {
                        claimText: { type: "string" },
                        scopePath: { type: "string" },
                        maxEvidence: { type: "number" },
                        sessionId: { type: "string" },
                        diversity: { type: "boolean" },
                        proofMode: { type: "string", enum: ["strict", "warn", "off"] },
                        proofBudget: { type: "number" },
                        contractHash: { type: "string" }
                    },
                    required: ["claimText"]
                }
            },
            {
                name: "prove_claims",
                description: "Batch prove multiple claims with dedup, registry cache, and proof budgeting.",
                inputSchema: {
                    type: "object",
                    properties: {
                        claims: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    text: { type: "string" },
                                    scopePath: { type: "string" }
                                },
                                required: ["text"]
                            }
                        },
                        maxEvidence: { type: "number" },
                        sessionId: { type: "string" },
                        diversity: { type: "boolean" },
                        proofMode: { type: "string", enum: ["strict", "warn", "off"] },
                        proofBudget: { type: "number" },
                        contractHash: { type: "string" }
                    },
                    required: ["claims"]
                }
            },
            {
                name: "handshake",
                description: "Generate compact agent operating protocol.",
                inputSchema: {
                    type: "object",
                    properties: {
                        budget: { type: "number", description: "Token budget (default 400)" }
                    }
                }
            },
            {
                name: "session_bootstrap",
                description: "Bootstrap session context in fresh or resume mode.",
                inputSchema: {
                    type: "object",
                    properties: {
                        mode: { type: "string", enum: ["fresh", "resume"] },
                        sessionId: { type: "string" },
                        bootBudget: { type: "number" },
                        deltaBudget: { type: "number" },
                        maxBudget: { type: "number" },
                        compress: { type: "boolean" },
                        format: { type: "string", enum: ["capsule", "json"] }
                    }
                }
            },
            {
                name: "get_context_contract",
                description: "Get latest context contract and drift status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        sessionId: { type: "string" },
                        providedContractHash: { type: "string" }
                    }
                }
            },
            {
                name: "acknowledge_context",
                description: "Acknowledge a context contract hash for session continuity.",
                inputSchema: {
                    type: "object",
                    properties: {
                        sessionId: { type: "string" },
                        contractHash: { type: "string" }
                    },
                    required: ["contractHash"]
                }
            },
            {
                name: "log_decision",
                description: "Record an AI agent's decision after making file changes. Creates institutional memory for future agents.",
                inputSchema: {
                    type: "object",
                    properties: {
                        files: {
                            type: "array",
                            items: { type: "string" },
                            description: "File paths that were changed (relative to repo root)"
                        },
                        summary: { type: "string", description: "One sentence: what changed" },
                        why: { type: "string", description: "One sentence: root cause / motivation" },
                        type: {
                            type: "string",
                            enum: ["fix", "feature", "refactor"],
                            description: "Type of change"
                        }
                    },
                    required: ["files", "summary", "why", "type"]
                }
            },
            {
                name: "get_file_history",
                description: "Get AI change decision history for a specific file, newest first.",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: { type: "string", description: "File path (relative to repo root)" },
                        limit: { type: "number", description: "Max records to return (default 10)" }
                    },
                    required: ["file_path"]
                }
            }
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
        case "search_repo": {
            const query = String(request.params.arguments?.query);
            const results = searchService.search(query);
            return {
                content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            };
        }
        case "index_repo": {
            const repoPath = String(request.params.arguments?.path);
            const incremental = request.params.arguments?.incremental !== false; // Default true (undefined or true)

            const cliPath = path.resolve(__dirname, '../../../apps/cli/dist/src/index.js');
            const args = ['index', `"${repoPath}"`];
            if (!incremental) args.push('--no-incremental');

            // We need to run this command.
            const { exec } = await import('child_process');

            return new Promise((resolve) => {
                exec(`node "${cliPath}" ${args.join(' ')}`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                    if (error) {
                        resolve({
                            content: [{ type: "text", text: `Indexing failed: ${error.message}\n${stderr}` }],
                            isError: true
                        });
                    } else {
                        store.setState('last_index_at', new Date().toISOString());
                        resolve({
                            content: [{ type: "text", text: `Indexing completed.\n${stdout}` }]
                        });
                    }
                });
            });
        }
        case "index_file": {
            const filePath = String(request.params.arguments?.path);
            if (!fs.existsSync(filePath)) {
                return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const { Indexer } = await import('@atlasmemory/indexer');
            const indexer = new Indexer();

            // Parse
            const { symbols, anchors, imports, refs } = indexer.parse(filePath, content);

            // Store Basics (File, Symbols, Anchors)
            // Note: We duplicate logic from CLI/Index here. Should unify later.
            const language = path.extname(filePath).slice(1);
            const { createHash } = await import('crypto');
            const contentHash = createHash('sha256').update(content).digest('hex');
            const loc = content.split('\n').length;

            const fileId = store.addFile(filePath, language, contentHash, loc, content);

            // Clear stale graph data for this file
            const oldSymbolIds = store.db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(fileId) as { id: string }[];
            if (oldSymbolIds.length > 0) {
                const placeholders = oldSymbolIds.map(() => '?').join(',');
                store.db.prepare(`DELETE FROM refs WHERE from_symbol_id IN (${placeholders}) OR to_symbol_id IN (${placeholders})`).run(...oldSymbolIds.map(s => s.id), ...oldSymbolIds.map(s => s.id));
            }
            store.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
            store.db.prepare('DELETE FROM anchors WHERE file_id = ?').run(fileId);
            store.db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
            store.deleteFlowCardsForFile(fileId);

            for (const sym of symbols) {
                sym.fileId = fileId;
                store.addSymbol(sym);
            }

            for (const anchor of anchors) {
                anchor.fileId = fileId;
                store.upsertAnchor(anchor);
            }

            for (const imp of imports) {
                imp.fileId = fileId;
                store.addImport(imp);
            }

            for (const ref of refs) {
                store.addRef(ref);
            }

            const flowCards = flowGenerator.rebuildAndStoreForFile(fileId);
            const fileCard = await deterministicCardGenerator.generateFileCard(fileId, filePath, symbols, content, anchors, flowCards);
            const quality = scoreFileCard(fileCard, symbols, anchors);
            fileCard.qualityScore = quality.score;
            fileCard.qualityFlags = quality.flags;
            store.addFileCard(fileCard);
            store.setState('last_index_at', new Date().toISOString());

            // Return data so LLM can use it to build card
            return {
                content: [{
                    type: "text", text: JSON.stringify({
                        file: { fileId, path: filePath, language, contentHash, loc },
                        symbols,
                        anchors,
                        imports,
                        refs,
                        flowCards
                    }, null, 2)
                }]
            };
        }

        case "get_allowed_evidence": {
            const filePath = String(request.params.arguments?.path);
            const max = Number(request.params.arguments?.max || 200);

            const file = store.getFiles().find(f => f.path === filePath);
            if (!file) {
                return { content: [{ type: "text", text: `File not indexed yet: ${filePath}` }], isError: true };
            }

            const anchors = store.getAnchorsForFile(file.id);
            const symbols = store.getSymbolsForFile(file.id);

            // Map anchors to symbols for better context
            const candidates = anchors.map(a => {
                const sym = symbols.find(s => s.startLine === a.startLine && s.endLine === a.endLine);
                return {
                    anchorId: a.id,
                    symbolName: sym?.name,
                    signature: sym?.signature,
                    startLine: a.startLine,
                    endLine: a.endLine,
                    len: a.endLine - a.startLine
                };
            })
                .sort((a, b) => b.len - a.len) // Largest first
                .slice(0, max);

            return {
                content: [{ type: "text", text: JSON.stringify({ fileId: file.id, candidates }, null, 2) }]
            };
        }

        case "validate_file_card": {
            const card = request.params.arguments?.card as any;
            const errors: string[] = [];

            if (!card) errors.push("No card provided");
            else {
                if (!card.level1) errors.push("Missing level1");
                else {
                    const l1 = card.level1;
                    if (l1.purpose && l1.purpose.length > 300) errors.push("Purpose too long (>300 chars)");

                    // Validate Anchors
                    if (l1.evidenceAnchorIds) {
                        for (const id of l1.evidenceAnchorIds) {
                            const anchor = store.getAnchor(id);
                            if (!anchor) errors.push(`Invalid evidenceAnchorId: ${id}`);
                        }
                    }
                }

                if (card.level2) {
                    const validateEvidenceClaims = (claims: any[], label: string) => {
                        if (!Array.isArray(claims)) {
                            errors.push(`level2.${label} must be an array`);
                            return;
                        }
                        for (const claim of claims) {
                            if (!claim || typeof claim !== 'object') {
                                errors.push(`Invalid level2.${label} claim object`);
                                continue;
                            }
                            if (typeof claim.text !== 'string' || claim.text.trim().length === 0) {
                                errors.push(`level2.${label}.text is required`);
                            }
                            if (!Array.isArray(claim.evidenceAnchorIds) || claim.evidenceAnchorIds.length === 0) {
                                errors.push(`level2.${label} requires non-empty evidenceAnchorIds`);
                            } else {
                                for (const id of claim.evidenceAnchorIds) {
                                    if (!store.getAnchor(id)) errors.push(`Invalid level2.${label} evidenceAnchorId: ${id}`);
                                }
                            }
                        }
                    };

                    validateEvidenceClaims(card.level2.flows || [], 'flows');
                    validateEvidenceClaims(card.level2.invariants || [], 'invariants');

                    const envDeps = card.level2.envDependencies;
                    if (!Array.isArray(envDeps)) {
                        errors.push('level2.envDependencies must be an array');
                    } else {
                        for (const dep of envDeps) {
                            if (!dep || typeof dep !== 'object') {
                                errors.push('Invalid level2.envDependencies item');
                                continue;
                            }
                            if (typeof dep.name !== 'string' || dep.name.trim().length === 0) {
                                errors.push('level2.envDependencies.name is required');
                            }
                            if (dep.source !== 'process.env' && dep.source !== 'os.environ') {
                                errors.push('level2.envDependencies.source must be process.env or os.environ');
                            }
                            if (!Array.isArray(dep.evidenceAnchorIds) || dep.evidenceAnchorIds.length === 0) {
                                errors.push('level2.envDependencies requires non-empty evidenceAnchorIds');
                            } else {
                                for (const id of dep.evidenceAnchorIds) {
                                    if (!store.getAnchor(id)) errors.push(`Invalid level2.envDependencies evidenceAnchorId: ${id}`);
                                }
                            }
                        }
                    }
                }
            }

            return {
                content: [{ type: "text", text: JSON.stringify({ ok: errors.length === 0, errors }, null, 2) }]
            };
        }

        case "upsert_file_card": {
            const filePath = String(request.params.arguments?.path);
            const cardData = request.params.arguments?.card as any; // Partial Card (Level 1) usually

            const file = store.getFiles().find(f => f.path === filePath);
            if (!file) {
                return { content: [{ type: "text", text: `File not indexed: ${filePath}` }], isError: true };
            }

            // Validate basic structure
            if (!cardData || !cardData.level1) {
                return { content: [{ type: "text", text: `Invalid card data (missing level1)` }], isError: true };
            }

            const validationErrors: string[] = [];
            const checkLevel2Claims = (claims: any[], label: string) => {
                if (!claims) return;
                if (!Array.isArray(claims)) {
                    validationErrors.push(`level2.${label} must be an array`);
                    return;
                }
                for (const claim of claims) {
                    if (!claim || typeof claim !== 'object') {
                        validationErrors.push(`Invalid level2.${label} claim object`);
                        continue;
                    }
                    if (!Array.isArray(claim.evidenceAnchorIds) || claim.evidenceAnchorIds.length === 0) {
                        validationErrors.push(`level2.${label} requires non-empty evidenceAnchorIds`);
                        continue;
                    }
                    for (const id of claim.evidenceAnchorIds) {
                        if (!store.getAnchor(id)) validationErrors.push(`Invalid level2.${label} evidenceAnchorId: ${id}`);
                    }
                }
            };

            if (cardData.level2) {
                checkLevel2Claims(cardData.level2.flows, 'flows');
                checkLevel2Claims(cardData.level2.invariants, 'invariants');

                if (cardData.level2.envDependencies) {
                    if (!Array.isArray(cardData.level2.envDependencies)) {
                        validationErrors.push('level2.envDependencies must be an array');
                    } else {
                        for (const dep of cardData.level2.envDependencies) {
                            if (!Array.isArray(dep?.evidenceAnchorIds) || dep.evidenceAnchorIds.length === 0) {
                                validationErrors.push('level2.envDependencies requires non-empty evidenceAnchorIds');
                                continue;
                            }
                            for (const id of dep.evidenceAnchorIds) {
                                if (!store.getAnchor(id)) validationErrors.push(`Invalid level2.envDependencies evidenceAnchorId: ${id}`);
                            }
                        }
                    }
                }
            }

            if (validationErrors.length > 0) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: false, errors: validationErrors }, null, 2) }],
                    isError: true
                };
            }

            // Construct full FileCard
            const fullCard: any = {
                fileId: file.id,
                path: filePath,
                level0: cardData.level0 || { purpose: "Updated via MCP", exports: [], sideEffects: [] },
                level1: cardData.level1,
                level2: cardData.level2,
                cardHash: ""
            };

            // Get symbols and anchors for scoring
            const symbols = store.getSymbolsForFile(file.id);
            const anchors = store.getAnchorsForFile(file.id);

            // Compute Score
            const quality = scoreFileCard(fullCard, symbols, anchors);
            fullCard.qualityScore = quality.score;
            fullCard.qualityFlags = quality.flags;

            // Compute Hash
            const { createHash } = await import('crypto');
            fullCard.cardHash = createHash('sha256')
                .update(JSON.stringify(fullCard.level0) + JSON.stringify(fullCard.level1) + JSON.stringify(fullCard.level2 || {}))
                .digest('hex');

            store.addFileCard(fullCard);

            return {
                content: [{
                    type: "text", text: JSON.stringify({
                        ok: true,
                        fileId: file.id,
                        cardHash: fullCard.cardHash,
                        qualityScore: fullCard.qualityScore,
                        qualityFlags: fullCard.qualityFlags
                    }, null, 2)
                }]
            };
        }

        case "refresh_cards_for_changed_files": {
            // Find files where:
            // 1. No card exists
            // 2. Card exists but file.updated_at > card.updated_at (if we tracked card timestamps separately? store.addFileCard updates updated_at)
            // Actually file_cards table has updated_at.
            // But files table has updated_at too.

            // Simple logic for now: Find files without cards.
            // Advanced: Find stale cards.

            const limit = Number(request.params.arguments?.limit || 10);

            // Get all files
            const files = store.db.prepare('SELECT id, path, updated_at FROM files').all() as any[];
            const cards = store.db.prepare('SELECT file_id, updated_at FROM file_cards').all() as any[];

            const cardMap = new Map<string, string>();
            for (const c of cards) cardMap.set(c.file_id, c.updated_at);

            const staleFiles: string[] = [];

            for (const f of files) {
                const cardTime = cardMap.get(f.id);
                if (!cardTime) {
                    staleFiles.push(f.path);
                } else {
                    // Compare timestamps if needed. For now just missing cards.
                    // SQLite dates are strings.
                    if (new Date(f.updated_at) > new Date(cardTime)) {
                        staleFiles.push(f.path);
                    }
                }
                if (staleFiles.length >= limit) break;
            }

            return {
                content: [{ type: "text", text: JSON.stringify({ staleFiles }, null, 2) }]
            };
            return {
                content: [{ type: "text", text: JSON.stringify({ staleFiles }, null, 2) }]
            };
        }

        case "auto_refresh": {
            // Check API Key
            const apiKey = process.env.ATLAS_LLM_API_KEY;
            if (!apiKey) {
                return { content: [{ type: "text", text: "Error: ATLAS_LLM_API_KEY env var required for auto refresh" }], isError: true };
            }

            const limit = Number(request.params.arguments?.maxFiles || 5);

            // Import services
            const { AutoRefresher, LLMService } = await import('@atlasmemory/summarizer');
            const llmService = new LLMService({ apiKey });
            const refresher = new AutoRefresher(store, llmService);

            try {
                const stats = await refresher.refreshAll(limit);
                store.setState('last_refresh_at', new Date().toISOString());
                return {
                    content: [{ type: "text", text: JSON.stringify(stats, null, 2) }]
                };
            } catch (e: any) {
                return {
                    content: [{ type: "text", text: `Auto refresh failed: ${e.message}` }],
                    isError: true
                };
            }
        }
        case "build_task_pack": {
            const objective = String(request.params.arguments?.objective || '');
            const tokenBudget = Number(request.params.arguments?.token_budget || 8000);
            const limit = Number(request.params.arguments?.limit || 20);
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const providedContractHash = request.params.arguments?.contractHash ? String(request.params.arguments?.contractHash) : undefined;
            const proof = (request.params.arguments?.proof === 'warn' || request.params.arguments?.proof === 'off')
                ? request.params.arguments?.proof
                : 'strict';
            const allowUnproven = request.params.arguments?.allowUnproven === true;
            const enforce = (process.env.ATLAS_CONTRACT_ENFORCE === 'strict' || process.env.ATLAS_CONTRACT_ENFORCE === 'off')
                ? process.env.ATLAS_CONTRACT_ENFORCE
                : 'warn';

            const contract = contractService.evaluateContract({
                sessionId,
                providedContractHash,
                enforce
            });

            if (enforce === 'strict' && contract.shouldBlock) {
                return {
                    isError: true,
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            code: 'BOOTSTRAP_REQUIRED',
                            reasons: contract.reasons,
                            contractHash: contract.contractHash,
                            recommendedNextCall: {
                                tool: 'session_bootstrap',
                                args: { mode: 'resume', sessionId }
                            }
                        }, null, 2)
                    }]
                };
            }

            const scoredResults = searchService.search(objective, limit);
            const fileIds = scoredResults.map(r => r.file.id);
            const pack = taskPackBuilder.build(objective, fileIds, tokenBudget, { proof, allowUnproven });
            const packHash = sha256(pack);
            contractService.createSnapshot({
                sessionId,
                objective,
                taskpackHash: packHash,
                proofMode: proof,
                minDbCoverage: contract.snapshot?.minDbCoverage
            });

            const payload = enforce === 'warn'
                ? {
                    pack,
                    contract: {
                        contractHash: contract.contractHash,
                        reasons: contract.reasons,
                        isStale: contract.isStale,
                        shouldBlock: contract.shouldBlock,
                        requiredBootstrap: contract.requiredBootstrap
                    }
                }
                : { pack };
            return {
                content: [{ type: "text", text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
            };
        }
        case "bootpack": {
            const budget = Number(request.params.arguments?.budget || 1500);
            const format = (request.params.arguments?.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json';
            const compress = request.params.arguments?.compress === false ? 'off' : 'on';
            const proof = (request.params.arguments?.proof === 'warn' || request.params.arguments?.proof === 'off')
                ? request.params.arguments?.proof
                : 'strict';
            const result = bootPackBuilder.buildBootPack({ budget, format, compress, proof });
            return {
                content: [{ type: "text", text: result.text }]
            };
        }
        case "deltapack": {
            const since = String(request.params.arguments?.since || 'last');
            const budget = Number(request.params.arguments?.budget || 800);
            const format = (request.params.arguments?.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json';
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const proof = (request.params.arguments?.proof === 'strict' || request.params.arguments?.proof === 'off')
                ? request.params.arguments?.proof
                : 'warn';
            const result = bootPackBuilder.buildDeltaPack({ since, budget, format, sessionId, proof });
            return {
                content: [{ type: "text", text: result.text }]
            };
        }
        case "prove_claim": {
            const claimText = String(request.params.arguments?.claimText || '');
            const scopePath = request.params.arguments?.scopePath ? String(request.params.arguments?.scopePath) : undefined;
            const maxEvidence = Number(request.params.arguments?.maxEvidence || 5);
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const diversity = request.params.arguments?.diversity === true;
            const proofMode = (request.params.arguments?.proofMode === 'warn' || request.params.arguments?.proofMode === 'off')
                ? request.params.arguments?.proofMode
                : 'strict';
            const proofBudget = Number(request.params.arguments?.proofBudget || 2500);
            const contractHash = request.params.arguments?.contractHash ? String(request.params.arguments?.contractHash) : undefined;
            const result = bootPackBuilder.proveClaim(claimText, scopePath, maxEvidence, {
                sessionId,
                diversity,
                proofMode,
                proofBudget,
                contractHash
            });
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
        case "prove_claims": {
            const inputClaims = Array.isArray(request.params.arguments?.claims)
                ? request.params.arguments?.claims
                : [];
            const claims = inputClaims
                .map((item: any) => ({ text: String(item?.text || ''), scopePath: item?.scopePath ? String(item.scopePath) : undefined }))
                .filter((item: any) => item.text.trim().length > 0);
            const maxEvidence = Number(request.params.arguments?.maxEvidence || 5);
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const diversity = request.params.arguments?.diversity === true;
            const proofMode = (request.params.arguments?.proofMode === 'warn' || request.params.arguments?.proofMode === 'off')
                ? request.params.arguments?.proofMode
                : 'strict';
            const proofBudget = Number(request.params.arguments?.proofBudget || 2500);
            const contractHash = request.params.arguments?.contractHash ? String(request.params.arguments?.contractHash) : undefined;

            const result = bootPackBuilder.proveClaims(claims, maxEvidence, {
                sessionId,
                diversity,
                proofMode,
                proofBudget,
                contractHash
            });

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
        case "handshake": {
            const budget = Number(request.params.arguments?.budget || 400);
            const result = bootPackBuilder.buildHandshake(budget);
            return {
                content: [{ type: "text", text: result.text }]
            };
        }
        case "session_bootstrap": {
            const mode = request.params.arguments?.mode === 'resume' ? 'resume' : 'fresh';
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const bootBudget = Number(request.params.arguments?.bootBudget || 1500);
            const deltaBudget = Number(request.params.arguments?.deltaBudget || 800);
            const maxBudget = request.params.arguments?.maxBudget ? Number(request.params.arguments?.maxBudget) : undefined;
            const format = (request.params.arguments?.format === 'json' ? 'json' : 'capsule') as 'capsule' | 'json';
            const compress = request.params.arguments?.compress === false ? false : true;
            const proof = 'strict';

            const bootResult = bootPackBuilder.buildBootPack({
                budget: bootBudget,
                format: 'capsule',
                compress: compress ? 'on' : 'off',
                proof
            });

            const deltaResult = mode === 'resume'
                ? bootPackBuilder.buildDeltaPack({
                    since: 'last',
                    budget: deltaBudget,
                    format: 'capsule',
                    sessionId,
                    proof: 'strict'
                })
                : undefined;

            const merged = bootPackBuilder.buildSessionBootstrap({
                mode,
                sessionId,
                bootBudget,
                deltaBudget,
                maxBudget,
                format,
                compress
            });

            const dbSig = store.getDbSignature(process.cwd());
            const gitHead = contractService.getGitHead();
            const bootpackHash = sha256(bootResult.text);
            const deltapackHash = deltaResult ? sha256(deltaResult.text) : undefined;

            const { contractHash, snapshot } = contractService.createSnapshot({
                sessionId,
                bootpackHash,
                deltapackHash,
                budgets: { boot: bootBudget, delta: deltaBudget },
                proofMode: 'strict',
                minDbCoverage: 0.8,
                dbSig,
                gitHead
            });

            if (sessionId) {
                store.setState('last_bootstrap_at', new Date().toISOString(), sessionId);
            } else {
                store.setState('last_bootstrap_at', new Date().toISOString());
            }
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        mode,
                        bootpack: bootResult.text,
                        deltapack: deltaResult?.text,
                        merged: merged.text,
                        contractHash,
                        dbSig,
                        gitHead,
                        snapshot: {
                            id: snapshot.id,
                            createdAt: snapshot.createdAt,
                            repoId: snapshot.repoId,
                            proofMode: snapshot.proofMode
                        }
                    }, null, 2)
                }]
            };
        }
        case "get_context_contract": {
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const providedContractHash = request.params.arguments?.providedContractHash
                ? String(request.params.arguments?.providedContractHash)
                : undefined;
            const enforce = (process.env.ATLAS_CONTRACT_ENFORCE === 'strict' || process.env.ATLAS_CONTRACT_ENFORCE === 'off')
                ? process.env.ATLAS_CONTRACT_ENFORCE
                : 'warn';
            const contract = contractService.evaluateContract({ sessionId, providedContractHash, enforce });
            return {
                content: [{ type: "text", text: JSON.stringify(contract, null, 2) }]
            };
        }
        case "acknowledge_context": {
            const sessionId = request.params.arguments?.sessionId ? String(request.params.arguments?.sessionId) : undefined;
            const contractHash = String(request.params.arguments?.contractHash || '');
            const ok = contractService.acknowledgeContext(contractHash, sessionId);
            if (!ok) {
                return {
                    isError: true,
                    content: [{ type: "text", text: JSON.stringify({ ok: false, code: 'CONTRACT_NOT_FOUND' }, null, 2) }]
                };
            }
            return {
                content: [{ type: "text", text: JSON.stringify({ ok: true, sessionId, contractHash }, null, 2) }]
            };
        }
        case "log_decision": {
            const files = request.params.arguments?.files as string[] | undefined;
            const summary = String(request.params.arguments?.summary || '');
            const why = String(request.params.arguments?.why || '');
            const type = String(request.params.arguments?.type || '') as 'fix' | 'feature' | 'refactor';

            if (!files || files.length === 0) {
                return { isError: true, content: [{ type: "text", text: "files array is required" }] };
            }
            if (!summary || !why) {
                return { isError: true, content: [{ type: "text", text: "summary and why are required" }] };
            }
            if (!['fix', 'feature', 'refactor'].includes(type)) {
                return { isError: true, content: [{ type: "text", text: "type must be 'fix', 'feature', or 'refactor'" }] };
            }

            const id = store.logAgentChange({
                filePaths: files,
                summary,
                why,
                changeType: type,
            });

            return {
                content: [{ type: "text", text: JSON.stringify({ ok: true, id }) }]
            };
        }
        case "get_file_history": {
            const filePath = String(request.params.arguments?.file_path || '');
            const limit = Number(request.params.arguments?.limit) || 10;

            if (!filePath) {
                return { isError: true, content: [{ type: "text", text: "file_path is required" }] };
            }

            const changes = store.getChangesForFile(filePath, limit);
            const result = changes.map(c => ({
                id: c.id,
                summary: c.summary,
                why: c.why,
                changeType: c.changeType,
                createdAt: c.createdAt,
            }));

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }
        default:
            throw new Error("Unknown tool");
    }
});


async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
