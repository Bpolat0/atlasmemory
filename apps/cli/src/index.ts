import { Command } from 'commander';
import { Store } from '@atlasmemory/store';
import { Indexer } from '@atlasmemory/indexer';
import { CardGenerator, FlowGenerator, LLMService } from '@atlasmemory/summarizer';
import { SearchService } from '@atlasmemory/retrieval';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const program = new Command();

/** Parse integer from CLI option, returning fallback if NaN */
const safeParseInt = (value: string, fallback: number): number => {
    const n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
};

// Global store instance (lazy initialized)
let store: Store;

function getStore() {
    if (!store) {
        const dbPath = path.resolve(process.env.ATLAS_DB_PATH || '.atlas/atlas.db');
        // console.log('[CLI] Using DB at:', dbPath); // Lower noise
        if (!fs.existsSync(path.dirname(dbPath))) {
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        }
        store = new Store(dbPath);
    }
    return store;
}

program
    .name('atlas')
    .description('AtlasMemory CLI')
    .version('0.1.0');

program.command('init')
    .description('Initialize AtlasMemory in the current directory')
    .action(() => {
        getStore(); // Creates DB
        console.log('Initialized .atlas directory');
    });

program.command('index')
    .description('Index the current directory')
    .option('--llm', 'Enable LLM-based summarization')
    .option('--api-key <key>', 'OpenAI API Key')
    .option('--no-incremental', 'Force full re-indexing')
    .action(async (options) => {
        const store = getStore();
        const indexer = new Indexer();

        let llmService;
        if (options.llm) {
            const apiKey = options.apiKey || process.env.ATLAS_LLM_API_KEY;
            if (!apiKey) {
                console.error('Error: --api-key or ATLAS_LLM_API_KEY env var required for LLM summarization');
                process.exit(1);
            }
            llmService = new LLMService({ apiKey });
            console.log('LLM Summarization Enabled');
        }

        const generator = new CardGenerator(llmService);
        const flowGenerator = new FlowGenerator(store);
        const incremental = options.incremental !== false;

        // 1. Load existing files state
        const existingFiles = new Map<string, { id: string, contentHash: string }>();
        if (incremental) {
            const files = store.getFiles();
            for (const f of files) {
                // Normalize path for consistent lookup
                const normPath = path.resolve(f.path).toLowerCase();
                existingFiles.set(normPath, { id: f.id, contentHash: f.contentHash });
            }
        }

        const visitedPaths = new Set<string>();
        let processed = 0;
        let skipped = 0;
        let deleted = 0;

        // Naive recursive walk
        async function walk(dir: string) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.resolve(dir, entry.name); // Ensure absolute

                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const normalizedDir = fullPath.replace(/\\/g, '/').toLowerCase();
                    if (['node_modules', '.git', '.atlas', 'dist', 'build', '.gemini', 'coverage', 'out', '.cache', '.turbo'].includes(entry.name)
                        || normalizedDir.includes('/apps/eval/reports/')
                        || normalizedDir.includes('/apps/eval/synth-')
                        || normalizedDir.includes('/synth-')) {
                        continue;
                    }
                    await walk(fullPath);
                } else if (stat.isFile()) {
                    const lowerName = entry.name.toLowerCase();
                    const isCode = lowerName.endsWith('.ts') || lowerName.endsWith('.js') || lowerName.endsWith('.py');
                    const isExcluded = lowerName.endsWith('.d.ts') || lowerName.endsWith('.map') || /\.min\.[^./]+$/.test(lowerName);

                    if (isCode && !isExcluded) {
                        // console.log(`Found candidate: ${fullPath}`);
                        const normPath = fullPath.toLowerCase();
                        visitedPaths.add(normPath);
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

                        // Incremental Check
                        if (incremental && existingFiles.has(normPath)) {
                            const existing = existingFiles.get(normPath)!;
                            if (existing.contentHash === contentHash) {
                                skipped++;
                                continue; // UNCHANGED
                            }
                            // CHANGED: Delete first
                            store.deleteFile(existing.id);
                        }

                        processed++;
                        console.log(`Indexing ${fullPath}...`);

                        // 1. Index symbols & anchors & imports
                        const { symbols, anchors, imports, refs } = indexer.parse(fullPath, content);

                        // Determine language
                        const ext = path.extname(fullPath).slice(1);
                        const language = ext.startsWith('ts') ? 'ts' : ext.startsWith('js') ? 'js' : 'py';

                        // 2. Add file to DB
                        const fileId = store.addFile(fullPath, language, contentHash, content.split('\n').length, content);

                        if (fileId) {
                            // 3a. Add symbols to DB
                            for (const sym of symbols) {
                                sym.fileId = fileId;
                                store.addSymbol(sym);
                            }

                            // 3b. Add anchors to DB
                            for (const anchor of anchors) {
                                anchor.fileId = fileId;
                                store.upsertAnchor(anchor);
                            }

                            // 3c. Add imports to DB
                            for (const imp of imports) {
                                imp.fileId = fileId;
                                store.addImport(imp);
                            }

                            // 3d. Add refs to DB
                            for (const ref of refs) {
                                store.addRef(ref);
                            }

                            // 4. Generate Cards
                            const flowCards = flowGenerator.rebuildAndStoreForFile(fileId);
                            const fileCard = await generator.generateFileCard(fileId, fullPath, symbols, content, anchors, flowCards);
                            store.addFileCard(fileCard);
                        }
                    }
                }
            }
        }

        await walk(process.cwd());

        // Cleanup: Delete files in DB that were not visited
        if (incremental) {
            for (const [normPath, info] of existingFiles) {
                if (!visitedPaths.has(normPath)) {
                    console.log(`Removing deleted file (ID: ${info.id})`);
                    store.deleteFile(info.id);
                    deleted++;
                }
            }
        }

        console.log('Linking imports...');
        await linkImports(store);

        // Rebuild flow + level2 after import linking for better 1-2 hop coverage
        for (const file of store.getFiles()) {
            try {
                if (!fs.existsSync(file.path)) continue;
                const content = fs.readFileSync(file.path, 'utf-8');
                const symbols = store.getSymbolsForFile(file.id);
                const anchors = store.getAnchorsForFile(file.id);
                const flowCards = flowGenerator.rebuildAndStoreForFile(file.id);
                const fileCard = await generator.generateFileCard(file.id, file.path, symbols, content, anchors, flowCards);
                store.addFileCard(fileCard);
            } catch {
                // skip unreadable files
            }
        }

        console.log(`Indexing complete. Processed: ${processed}, Skipped: ${skipped}, Deleted: ${deleted}`);
    });

async function linkImports(store: Store) {
    // Naive linking: Iterate all internal imports with null resolved_file_id
    // This is slow for large repos but fine for now.
    // Better: Fetch all files path map first.

    const files = store.getFiles();
    const fileMap = new Map<string, string>(); // path.toLowerCase() -> id
    for (const f of files) {
        fileMap.set(f.path.toLowerCase(), f.id);
    }

    // We need a method to get all imports or just iterate files...
    // Store doesn't have getImports.
    // Let's add getUnresolvedImports to Store? Or just raw query.

    const imports = store.db.prepare('SELECT * FROM imports WHERE is_external = 0 AND resolved_file_id IS NULL').all() as any[];

    const updateStmt = store.db.prepare('UPDATE imports SET resolved_file_id = ? WHERE id = ?');

    // We also need the source file path to resolve relative imports
    // Join files table?
    const importsWithSource = store.db.prepare(`
        SELECT i.id, i.imported_module, f.path as source_path 
        FROM imports i
        JOIN files f ON i.file_id = f.id
        WHERE i.is_external = 0 AND i.resolved_file_id IS NULL
    `).all() as { id: string, imported_module: string, source_path: string }[];

    let linked = 0;
    for (const imp of importsWithSource) {
        const sourceDir = path.dirname(imp.source_path);
        // Resolve path
        let resolvedPath = path.resolve(sourceDir, imp.imported_module);

        // Try extensions
        const candidates = [
            resolvedPath,
            resolvedPath + '.ts',
            resolvedPath + '.js',
            resolvedPath + '.d.ts',
            resolvedPath + '/index.ts',
            resolvedPath + '/index.js',
            resolvedPath + '/index.d.ts'
        ];

        for (const cand of candidates) {
            const lower = cand.toLowerCase();
            if (fileMap.has(lower)) {
                updateStmt.run(fileMap.get(lower), imp.id);
                linked++;
                break;
            }
        }
    }
    console.log(`Linked ${linked} imports.`);
}

program.command('search <query>')
    .description('Search the index')
    .action((query) => {
        const store = getStore();
        const service = new SearchService(store);
        const results = service.search(query);
        console.log(JSON.stringify(results, null, 2));
    });

program.command('taskpack <objective>')
    .description('Generate a task pack for an objective')
    .option('--limit <number>', 'Max number of files to consider', '20')
    .option('--budget <number>', 'Token budget', '12000')
    .option('--includeDts', 'Include definition files', false)
    .option('--snippetMaxLines <number>', 'Max lines per snippet', '120')
    .option('--proof <mode>', 'Proof mode (strict|warn|off)', 'strict')
    .option('--allowUnproven', 'Allow unproven claims (maps to warn mode)', false)
    .action(async (objective, options) => {
        const store = getStore();
        const service = new SearchService(store);
        const builder = new TaskPackBuilder(store);
        const { FolderSummarizer } = await import('@atlasmemory/summarizer');
        const folderSummarizer = new FolderSummarizer();

        // Use scored search (with Graph Proximity) for better relevance
        console.log('Searching with Graph Proximity...');
        const scoredResults = service.search(objective, safeParseInt(options.limit, 20));
        console.log(`Found ${scoredResults.length} relevant files for objective: "${objective}"`);

        scoredResults.forEach(r => console.log(` - ${r.file.path} (score: ${r.score.toFixed(1)})`));

        const fileIds = scoredResults.map(r => r.file.id);

        // Generate Folder Cards
        const folderCards = [];
        const relevantCards: any[] = [];
        for (const fid of fileIds) {
            const c = store.getFileCard(fid);
            if (c) relevantCards.push(c);
        }

        const folders = new Set(relevantCards.map(c => path.dirname(c.path)));

        for (const folder of folders) {
            const folderCard = folderSummarizer.summarizeFolder(folder, relevantCards);
            folderCards.push(folderCard);
        }

        const pack = builder.build(objective, fileIds, safeParseInt(options.budget, 12000), {
            includeDts: options.includeDts,
            snippetMaxLines: safeParseInt(options.snippetMaxLines, 30),
            folderCards,
            proof: options.proof,
            allowUnproven: options.allowUnproven
        });
        console.log(pack);
    });

program.command('bootpack')
    .description('Generate a compact bootstrap capsule for new sessions')
    .option('--budget <number>', 'Token budget', '1500')
    .option('--format <type>', 'Output format (capsule|json)', 'capsule')
    .option('--compress <mode>', 'Compression mode (on|off)', 'on')
    .option('--proof <mode>', 'Proof mode (strict|warn|off)', 'strict')
    .action((options) => {
        const store = getStore();
        const builder = new BootPackBuilder(store);
        const result = builder.buildBootPack({
            budget: safeParseInt(options.budget, 1500),
            format: options.format,
            compress: options.compress,
            proof: options.proof
        });
        console.log(result.text);
    });

program.command('deltapack')
    .description('Generate delta-only capsule since a point in time')
    .requiredOption('--since <value>', 'Since marker (git sha|timestamp|last)')
    .option('--budget <number>', 'Token budget', '800')
    .option('--format <type>', 'Output format (capsule|json)', 'capsule')
    .option('--proof <mode>', 'Proof mode (strict|warn|off)', 'warn')
    .action((options) => {
        const store = getStore();
        const builder = new BootPackBuilder(store);
        const result = builder.buildDeltaPack({
            since: options.since,
            budget: safeParseInt(options.budget, 800),
            format: options.format,
            proof: options.proof
        });
        console.log(result.text);
    });

program.command('handshake')
    .description('Generate short operating instructions for agents')
    .option('--budget <number>', 'Token budget', '400')
    .action((options) => {
        const store = getStore();
        const builder = new BootPackBuilder(store);
        const result = builder.buildHandshake(safeParseInt(options.budget, 400));
        console.log(result.text);
    });

program.command('refresh')
    .description('Refresh stale cards')
    .option('--auto', 'Automatically regenerate cards using LLM')
    .option('--limit <number>', 'Max files to process', '10')
    .option('--api-key <key>', 'OpenAI API Key')
    .action(async (options) => {
        const store = getStore();
        // Dynamic import to avoid loading summarizer if not needed? No, standard import is fine.
        const { AutoRefresher, LLMService } = await import('@atlasmemory/summarizer');

        let llmService;
        const apiKey = options.apiKey || process.env.ATLAS_LLM_API_KEY;

        if (options.auto) {
            if (!apiKey) {
                console.error('Error: --api-key required for auto refresh');
                process.exit(1);
            }
            llmService = new LLMService({ apiKey });
        } else {
            // Dummy for read-only check
            llmService = new LLMService({ apiKey: 'dummy' });
        }

        const refresher = new AutoRefresher(store, llmService);

        if (options.auto) {
            console.log('Auto-refreshing stale cards...');
            const stats = await refresher.refreshAll(safeParseInt(options.limit, 10));
            console.log(`Refreshed ${stats.generated} cards. Failed: ${stats.failed}`);
            if (stats.errors.length > 0) {
                console.log('Errors:', stats.errors);
            }
        } else {
            console.log('Checking for stale files...');
            const stale = await refresher.findStaleFiles(safeParseInt(options.limit, 10));
            if (stale.length === 0) {
                console.log('No stale files found.');
            } else {
                console.log(`Found ${stale.length} stale files:`);
                stale.forEach(f => console.log(` - ${f}`));
                console.log('\nRun with --auto to refresh them.');
            }
        }
    });

const contract = program.command('contract')
    .description('Context contract utilities');

contract.command('show')
    .description('Show latest context snapshot and evaluated contract')
    .option('--session <id>', 'Session id')
    .action((options) => {
        const store = getStore();
        const service = new ContextContractService(store, process.cwd());
        const enforce = (process.env.ATLAS_CONTRACT_ENFORCE === 'warn' || process.env.ATLAS_CONTRACT_ENFORCE === 'strict')
            ? process.env.ATLAS_CONTRACT_ENFORCE
            : 'off';
        const result = service.evaluateContract({ sessionId: options.session, enforce });
        console.log(JSON.stringify(result, null, 2));
    });

contract.command('check')
    .description('Validate provided contract hash against latest snapshot')
    .requiredOption('--contract <hash>', 'Contract hash')
    .option('--session <id>', 'Session id')
    .action((options) => {
        const store = getStore();
        const service = new ContextContractService(store, process.cwd());
        const result = service.evaluateContract({
            sessionId: options.session,
            providedContractHash: options.contract,
            enforce: 'strict'
        });
        if (result.requiredBootstrap) {
            console.log(JSON.stringify({ status: 'BOOTSTRAP_REQUIRED', reasons: result.reasons, contractHash: result.contractHash }, null, 2));
            process.exitCode = 2;
            return;
        }
        console.log(JSON.stringify({ status: 'OK', contractHash: result.contractHash }, null, 2));
    });

contract.command('ack')
    .description('Acknowledge contract hash for session')
    .requiredOption('--contract <hash>', 'Contract hash')
    .option('--session <id>', 'Session id')
    .action((options) => {
        const store = getStore();
        const service = new ContextContractService(store, process.cwd());
        const ok = service.acknowledgeContext(options.contract, options.session);
        if (!ok) {
            console.error(JSON.stringify({ ok: false, code: 'CONTRACT_NOT_FOUND' }, null, 2));
            process.exitCode = 1;
            return;
        }
        console.log(JSON.stringify({ ok: true, contractHash: options.contract, sessionId: options.session }, null, 2));
    });

program.parse();
