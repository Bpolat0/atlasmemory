import { Command } from 'commander';
import { Store } from '@atlasmemory/store';
import { Indexer } from '@atlasmemory/indexer';
import { CardGenerator, FlowGenerator, LLMService, FolderSummarizer } from '@atlasmemory/summarizer';
import { SearchService } from '@atlasmemory/retrieval';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import { autoIndex, detectProjectRoot } from './auto-index.js';
import { generateAll, computeAiReadiness, renderReadinessBar } from './generate-claude-md.js';
import type { GenerateFormat } from './generate-claude-md.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

/** Parse integer from CLI option, returning fallback if NaN */
const safeParseInt = (value: string, fallback: number): number => {
    const n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
};

let store: Store;

function getStore(dbPath?: string): Store {
    if (!store) {
        const resolved = path.resolve(dbPath || process.env.ATLAS_DB_PATH || '.atlas/atlas.db');
        if (!fs.existsSync(path.dirname(resolved))) {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
        }
        try {
            store = new Store(resolved);
        } catch (e: any) {
            if (e.code === 'SQLITE_NOTADB') {
                console.error(`Error: Database file is corrupted: ${resolved}`);
                console.error('Fix: Delete the file and re-index:');
                console.error(`  rm "${resolved}"`);
                console.error('  atlasmemory index');
                process.exit(1);
            }
            throw e;
        }
    }
    return store;
}

export function registerCliCommands(program: Command): void {
    program.command('init')
        .description('Initialize AtlasMemory in the current directory')
        .action(async () => {
            const cwd = process.cwd();
            const atlasDir = path.join(cwd, '.atlas');

            if (fs.existsSync(path.join(atlasDir, 'atlas.db'))) {
                console.log('AtlasMemory is already initialized in this directory.');
                const s = getStore();
                const readiness = computeAiReadiness(s);
                console.log(`AI Readiness: ${renderReadinessBar(readiness.overall)}`);
                return;
            }

            console.log('Initializing AtlasMemory...\n');
            getStore();
            console.log('Created .atlas/atlas.db\n');

            console.log('Indexing project...');
            const s = getStore();
            const result = await autoIndex(s, cwd, { incremental: true });
            console.log(`Indexed ${result.files} files, ${result.symbols} symbols\n`);

            const readiness = computeAiReadiness(s);
            console.log(`AI Readiness: ${renderReadinessBar(readiness.overall)}\n`);

            const cwdUnix = cwd.replace(/\\/g, '/');
            console.log('Setup for your AI tool:\n');
            console.log('  Claude Desktop / Claude Code:');
            console.log('  Add to claude_desktop_config.json:');
            console.log(`  { "mcpServers": { "atlasmemory": { "command": "npx", "args": ["-y", "atlasmemory"], "cwd": "${cwdUnix}" } } }\n`);
            console.log('  Cursor:');
            console.log('  Add to .cursor/mcp.json:');
            console.log(`  { "mcpServers": { "atlasmemory": { "command": "npx", "args": ["-y", "atlasmemory"], "cwd": "${cwdUnix}" } } }\n`);
            console.log('  Generate CLAUDE.md:  atlasmemory generate');
            console.log('  Add to .gitignore:   .atlas/\n');

            const gitignorePath = path.join(cwd, '.gitignore');
            if (fs.existsSync(gitignorePath)) {
                const content = fs.readFileSync(gitignorePath, 'utf-8');
                if (!content.includes('.atlas')) {
                    console.log('Tip: Add ".atlas/" to your .gitignore');
                }
            }
        });

    program.command('index [dir]')
        .description('Index a directory (default: current directory)')
        .option('--llm', 'Enable LLM-based summarization')
        .option('--api-key <key>', 'LLM API Key')
        .option('--no-incremental', 'Force full re-indexing')
        .option('--max-files <number>', 'Maximum number of files to index (for testing)')
        .action(async (dir, options) => {
            const rootDir = dir ? path.resolve(dir) : detectProjectRoot(process.cwd());

            if (!fs.existsSync(rootDir)) {
                console.error(`Error: Directory does not exist: ${rootDir}`);
                process.exit(1);
            }

            const store = getStore();

            if (options.llm) {
                const apiKey = options.apiKey || process.env.ATLAS_LLM_API_KEY;
                if (!apiKey) {
                    console.error('Error: --api-key or ATLAS_LLM_API_KEY required for LLM mode');
                    process.exit(1);
                }
                console.log('LLM summarization enabled');
            }

            console.log(`\nAtlasMemory - Indexing ${rootDir}\n`);
            let progressCount = 0;
            const startTime = Date.now();
            const maxFiles = options.maxFiles ? safeParseInt(options.maxFiles, 0) : 0;
            const result = await autoIndex(store, rootDir, {
                onFile: () => {
                    progressCount++;
                    if (process.stderr.isTTY) {
                        process.stderr.write(`\r  Indexing: ${progressCount} files...`);
                    }
                },
                incremental: options.incremental,
                maxFiles,
            });
            if (process.stderr.isTTY) {
                process.stderr.write('\r' + ' '.repeat(40) + '\r');
            }
            const elapsed = Date.now() - startTime;

            // Language breakdown
            const langCounts = new Map<string, number>();
            for (const file of store.getFiles()) {
                const ext = path.extname(file.path).toLowerCase();
                const lang = ext === '.ts' || ext === '.tsx' ? 'TS' : ext === '.js' || ext === '.jsx' ? 'JS' : ext === '.py' ? 'PY' : ext.slice(1).toUpperCase();
                if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
            }
            const langStr = Array.from(langCounts.entries()).map(([l, c]) => `${c} ${l}`).join(', ');
            const flowCount = (store.db.prepare('SELECT COUNT(*) as n FROM flow_cards').get() as { n: number }).n;
            const symbolCount = (store.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number }).n;
            const exportCount = (store.db.prepare("SELECT COUNT(*) as n FROM symbols WHERE visibility = 'public'").get() as { n: number }).n;

            process.stdout.write('\r');
            console.log(`  [OK] ${result.files} files indexed (${langStr}) in ${elapsed}ms`);
            console.log(`  [OK] ${symbolCount} symbols extracted, ${exportCount} public exports`);
            console.log(`  [OK] ${flowCount} call flows traced`);
            if (result.skipped > 0) console.log(`  [--] ${result.skipped} unchanged files skipped`);
            if (result.skippedLarge > 0) console.log(`  [--] ${result.skippedLarge} files skipped (>1MB, likely generated)`);
            console.log(`  [DB] ${path.resolve(process.env.ATLAS_DB_PATH || '.atlas/atlas.db')}`);

            if (result.files === 0 && result.skipped === 0) {
                console.log('\n  Warning: No source files found.');
                console.log('  Check that the directory contains supported files (.ts, .js, .py, .go, .rs, .java, etc.)');
                console.log('  Or check your .atlasignore for overly broad patterns.');
            }

            // AI Readiness Score
            const readiness = computeAiReadiness(store);
            console.log(`\n  AI Readiness: ${renderReadinessBar(readiness.overall)}`);
            console.log(`    Code:         ${readiness.codeCoverage}%`);
            console.log(`    Descriptions: ${readiness.descriptionCoverage}%`);
            console.log(`    Flows:        ${readiness.flowCoverage}%`);
            console.log(`    Evidence:     ${readiness.evidenceCoverage}%`);

            // Next steps
            console.log('\n  Next steps:');
            console.log('    atlasmemory generate     Generate CLAUDE.md for this project');
            console.log('    atlasmemory search "X"   Search your codebase');
            console.log('    atlasmemory doctor       Check database health');
            console.log('');
        });

    program.command('search <query>')
        .description('Search the indexed repository')
        .option('--limit <number>', 'Max results', '10')
        .action((query, options) => {
            if (!query.trim()) {
                console.log('Please provide a search query. Example: atlasmemory search "authentication"');
                return;
            }
            const store = getStore();
            const service = new SearchService(store);
            const results = service.search(query, safeParseInt(options.limit, 10));

            if (results.length === 0) {
                const fileCount = store.getFiles().length;
                if (fileCount === 0) {
                    console.log('No files indexed. Run `atlasmemory index` first.');
                } else {
                    console.log(`No results found for "${query}".`);
                }
                return;
            }
            for (const r of results) {
                console.log(`  ${r.score.toFixed(1).padStart(5)}  ${r.file.path}`);
            }
        });

    program.command('taskpack <objective>')
        .description('Generate a proof-backed context pack')
        .option('--budget <number>', 'Token budget', '12000')
        .option('--limit <number>', 'Max files', '20')
        .option('--proof <mode>', 'Proof mode (strict|warn|off)', 'strict')
        .action((objective, options) => {
            const store = getStore();
            const service = new SearchService(store);
            const builder = new TaskPackBuilder(store);

            const scoredResults = service.search(objective, safeParseInt(options.limit, 20));
            const fileIds = scoredResults.map(r => r.file.id);
            const pack = builder.build(objective, fileIds, safeParseInt(options.budget, 12000), {
                proof: options.proof,
            });
            // Strip evidence UUIDs from CLI output (human-readable mode)
            // Keep claim text but remove "| E:uuid,uuid,..." notation
            const cleanPack = pack.replace(/ \| E:[a-f0-9,-]+/g, '');
            console.log(cleanPack);
        });

    program.command('bootpack')
        .description('Generate a compact project bootstrap capsule')
        .option('--budget <number>', 'Token budget', '1500')
        .option('--format <type>', 'Output format (capsule|json)', 'capsule')
        .option('--proof <mode>', 'Proof mode', 'strict')
        .action((options) => {
            const store = getStore();
            const builder = new BootPackBuilder(store);
            const result = builder.buildBootPack({
                budget: safeParseInt(options.budget, 1500),
                format: options.format,
                compress: 'on',
                proof: options.proof,
            });
            console.log(result.text);
        });

    program.command('deltapack')
        .description('Generate change-only capsule')
        .option('--since <value>', 'Since (git sha | timestamp | last)', 'last')
        .option('--budget <number>', 'Token budget', '800')
        .option('--format <type>', 'Output format', 'capsule')
        .option('--proof <mode>', 'Proof mode', 'warn')
        .action((options) => {
            const store = getStore();
            const builder = new BootPackBuilder(store);
            const result = builder.buildDeltaPack({
                since: options.since,
                budget: safeParseInt(options.budget, 800),
                format: options.format,
                proof: options.proof,
            });
            console.log(result.text);
        });

    program.command('handshake')
        .description('Generate 3-layer agent context: Perception + Memory + Protocol')
        .option('--no-brief', 'Omit project brief')
        .option('--no-memory', 'Omit project memories')
        .action(async (options) => {
            const store = getStore();
            const rootDir = detectProjectRoot(process.cwd());

            // Dynamic budget based on project size
            const fileCount = store.getFileCount() || 64;
            const total = Math.min(Math.max(fileCount * 12, 800), 2500);
            const budgets = {
                perception: Math.round(total * 0.45),
                memory: Math.round(total * 0.40),
                protocol: Math.round(total * 0.15),
            };

            const sections: string[] = [];

            // 1. PERCEPTION
            if (options.brief !== false) {
                const { CodeHealthAnalyzer, SessionLearner, EnrichmentCoordinator, ProjectBriefBuilder } = await import('@atlasmemory/intelligence');
                const codeHealth = new CodeHealthAnalyzer(store, rootDir);
                const sessionLearner = new SessionLearner(store);
                const enrichmentCoordinator = new EnrichmentCoordinator(store);
                const briefBuilder = new ProjectBriefBuilder(store, codeHealth, sessionLearner, enrichmentCoordinator);
                try { await codeHealth.analyzeRepo(); } catch { }
                const { markdown } = briefBuilder.buildBrief({ rootDir, maxTokens: budgets.perception });
                sections.push(markdown);
            }

            // 2. LONG-TERM MEMORY
            if (options.memory !== false) {
                const memories = store.getProjectMemories({ status: 'active', limit: 50 });
                if (memories.length > 0) {
                    const memLines: string[] = ['## Project Memory'];
                    const context = memories.filter((m: any) => m.memoryType === 'context');
                    const gaps = memories.filter((m: any) => m.memoryType === 'gap');
                    const priorities = memories.filter((m: any) => m.memoryType === 'priority');
                    const milestones = memories.filter((m: any) => m.memoryType === 'milestone');
                    const learnings = memories.filter((m: any) => m.memoryType === 'learning');
                    if (context.length > 0) memLines.push('**Active:** ' + context.map((c: any) => c.content).join(' | '));
                    if (gaps.length > 0) memLines.push('**Gaps:**\n' + gaps.map((g: any) => `- [GAP-${g.id}] ${g.content}`).join('\n'));
                    if (priorities.length > 0) memLines.push('**Priorities:** ' + priorities.map((p: any) => p.content).join(' > '));
                    if (milestones.length > 0) memLines.push('**Milestones:** ' + milestones.slice(0, 5).map((m: any) => m.content).join(' | '));
                    if (learnings.length > 0) memLines.push('**Learnings:**\n' + learnings.map((l: any) => `- ${l.content}`).join('\n'));
                    let memText = memLines.join('\n\n');
                    const maxChars = Math.floor(budgets.memory / 1.15 * 3);
                    if (memText.length > maxChars) memText = memText.slice(0, maxChars - 3) + '...';
                    sections.push(memText);
                }
            }

            // 3. PROTOCOL
            const builder = new BootPackBuilder(store);
            const protocol = builder.buildHandshake(budgets.protocol);
            sections.push(protocol.text);

            console.log('\n' + sections.join('\n\n'));
            console.log(`\n--- Budget: ${total} tokens (perception: ${budgets.perception}, memory: ${budgets.memory}, protocol: ${budgets.protocol}) ---\n`);
        });

    program.command('refresh')
        .description('Refresh stale cards')
        .option('--auto', 'Auto-regenerate using LLM')
        .option('--limit <number>', 'Max files', '10')
        .option('--api-key <key>', 'LLM API Key')
        .action(async (options) => {
            const store = getStore();
            const { AutoRefresher, LLMService } = await import('@atlasmemory/summarizer');
            const apiKey = options.apiKey || process.env.ATLAS_LLM_API_KEY;

            if (options.auto) {
                if (!apiKey) { console.error('Error: --api-key required for auto refresh'); process.exit(1); }
                const refresher = new AutoRefresher(store, new LLMService({ apiKey }));
                const stats = await refresher.refreshAll(safeParseInt(options.limit, 10));
                console.log(`Refreshed ${stats.generated} cards. Failed: ${stats.failed}`);
            } else {
                const refresher = new AutoRefresher(store, new LLMService({ apiKey: 'dummy' }));
                const stale = await refresher.findStaleFiles(safeParseInt(options.limit, 10));
                if (stale.length === 0) console.log('No stale files.');
                else {
                    console.log(`${stale.length} stale files:`);
                    stale.forEach(f => console.log(`  ${f}`));
                    console.log('\nRun with --auto to refresh.');
                }
            }
        });

    const contract = program.command('contract').description('Context contract utilities');

    contract.command('show')
        .option('--session <id>', 'Session id')
        .action((options) => {
            const store = getStore();
            const service = new ContextContractService(store, process.cwd());
            const result = service.evaluateContract({ sessionId: options.session, enforce: 'off' });
            console.log(JSON.stringify(result, null, 2));
        });

    contract.command('check')
        .requiredOption('--contract <hash>', 'Contract hash')
        .option('--session <id>', 'Session id')
        .action((options) => {
            const store = getStore();
            const service = new ContextContractService(store, process.cwd());
            const result = service.evaluateContract({
                sessionId: options.session,
                providedContractHash: options.contract,
                enforce: 'strict',
            });
            if (result.requiredBootstrap) {
                console.log(JSON.stringify({ status: 'BOOTSTRAP_REQUIRED', reasons: result.reasons }, null, 2));
                process.exitCode = 2;
            } else {
                console.log(JSON.stringify({ status: 'OK', contractHash: result.contractHash }, null, 2));
            }
        });

    contract.command('ack')
        .requiredOption('--contract <hash>', 'Contract hash')
        .option('--session <id>', 'Session id')
        .action((options) => {
            const store = getStore();
            const service = new ContextContractService(store, process.cwd());
            const ok = service.acknowledgeContext(options.contract, options.session);
            if (!ok) { console.error(JSON.stringify({ ok: false, code: 'CONTRACT_NOT_FOUND' })); process.exitCode = 1; }
            else console.log(JSON.stringify({ ok: true, contractHash: options.contract }));
        });

    program.command('generate')
        .description('Auto-generate AI instruction files from indexed codebase')
        .option('-o, --output <path>', 'Output file path (overrides default for single format)')
        .option('--format <type>', 'Output format: claude | cursor | copilot | all (default: claude)', 'claude')
        .option('--stdout', 'Print to stdout instead of writing file')
        .option('--force', 'Overwrite existing files even if hand-written')
        .action((options) => {
            const store = getStore();
            const rootDir = detectProjectRoot(process.cwd());

            if (store.getFiles().length === 0) {
                console.error('No files indexed. Run `atlasmemory index .` first.');
                process.exit(1);
            }

            const format = options.format as GenerateFormat;
            const result = generateAll(store, { rootDir, format, force: options.force });

            if (options.stdout) {
                for (const file of result.files) {
                    if (result.files.length > 1) console.log(`--- ${path.basename(file.path)} ---`);
                    console.log(file.content);
                }
                return;
            }

            // Write files
            const formatLabel = format === 'all' ? 'All Formats' : format === 'claude' ? 'CLAUDE.md' : format === 'cursor' ? '.cursorrules' : 'copilot-instructions.md';
            console.log(`\nAtlasMemory - ${formatLabel} Generator\n`);

            for (const file of result.files) {
                const outputPath = (result.files.length === 1 && options.output) ? options.output : file.path;
                try {
                    const dir = path.dirname(outputPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const existed = fs.existsSync(outputPath);
                    fs.writeFileSync(outputPath, file.content, 'utf-8');
                    console.log(`  [OK] ${existed ? 'Updated' : 'Created'}: ${outputPath}`);
                } catch (err: any) {
                    console.error(`  [FAIL] Could not write ${outputPath}: ${err?.message || err}`);
                }
            }

            console.log(`  [OK] ${store.getFiles().length} files analyzed`);
            console.log(`  [OK] AI Readiness: ${result.readiness.overall}/100`);
            console.log('\n  Your project is now AI-ready.');
            if (result.skipped && result.skipped.length > 0) {
                console.log('\nSkipped (hand-written, use --force to overwrite):');
                for (const s of result.skipped) console.log(`  ${s.path}`);
            }

            if (format === 'all') {
                console.log('  Claude, Cursor, and Copilot will all understand your codebase.\n');
            } else {
                console.log('  Run with --format all to generate for Claude, Cursor, and Copilot.\n');
            }
        });

    program.command('status')
        .description('Output project status as JSON (for tooling/extensions)')
        .option('--json', 'JSON output (default)', true)
        .action(() => {
            const store = getStore();
            const readiness = computeAiReadiness(store);
            const files = store.db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number };
            const symbols = store.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number };
            const anchors = store.db.prepare('SELECT COUNT(*) as n FROM anchors').get() as { n: number };
            const fileCards = store.db.prepare('SELECT COUNT(*) as n FROM file_cards').get() as { n: number };
            const flowCards = store.db.prepare('SELECT COUNT(*) as n FROM flow_cards').get() as { n: number };
            const imports = store.db.prepare('SELECT COUNT(*) as n FROM imports').get() as { n: number };
            const refs = store.db.prepare('SELECT COUNT(*) as n FROM refs').get() as { n: number };
            const lastIndex = store.getState('last_index_at');

            let hasFtsStemmer = false;
            try {
                const ftsInfo = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_files'").get() as { sql: string } | undefined;
                hasFtsStemmer = !!ftsInfo?.sql?.includes('porter');
            } catch { }

            const issues: string[] = [];
            if (files.n === 0) issues.push('No files indexed. Run: atlasmemory index .');
            if (files.n > 0 && fileCards.n === 0) issues.push('Files indexed but no cards generated.');
            if (!hasFtsStemmer) issues.push('FTS missing Porter stemmer. Re-index recommended.');

            console.log(JSON.stringify({
                version: '1.0.0',
                database: path.resolve(process.env.ATLAS_DB_PATH || '.atlas/atlas.db'),
                lastIndex: lastIndex || null,
                readiness: {
                    overall: readiness.overall,
                    codeCoverage: readiness.codeCoverage,
                    descriptionCoverage: readiness.descriptionCoverage,
                    flowCoverage: readiness.flowCoverage,
                    evidenceCoverage: readiness.evidenceCoverage,
                },
                stats: {
                    files: files.n,
                    symbols: symbols.n,
                    anchors: anchors.n,
                    fileCards: fileCards.n,
                    flowCards: flowCards.n,
                    imports: imports.n,
                    refs: refs.n,
                },
                health: {
                    status: issues.length === 0 ? 'HEALTHY' : 'ISSUES_FOUND',
                    hasFtsStemmer,
                    issues,
                },
            }));
        });

    program.command('demo')
        .description('Quick demo: index + search + show proof system')
        .action(async () => {
            const cwd = detectProjectRoot(process.cwd()) || process.cwd();
            const s = getStore();
            console.log('AtlasMemory Demo\n');
            console.log('Step 1: Indexing current directory...');
            const result = await autoIndex(s, cwd, { incremental: true });
            // Show total counts from DB (not just newly indexed, which is 0 on re-index)
            const totalFiles = (s.db.prepare('SELECT COUNT(*) as n FROM files').get() as any).n;
            const totalSymbols = (s.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as any).n;
            if (result.files > 0) {
                console.log(`  Indexed ${result.files} new files (${totalFiles} total, ${totalSymbols} symbols)\n`);
            } else {
                console.log(`  Already indexed: ${totalFiles} files, ${totalSymbols} symbols\n`);
            }
            console.log('Step 2: Searching for "main entry"...');
            const search = new SearchService(s);
            const searchResults = search.search('main entry', 3);
            if (searchResults.length > 0) {
                for (const r of searchResults) {
                    console.log(`  ${r.file.path} (score: ${r.score.toFixed(1)})`);
                }
            } else {
                console.log('  (no results for this query)');
            }
            console.log('\nStep 3: AI Readiness Score...');
            const readiness = computeAiReadiness(s);
            console.log(`  ${renderReadinessBar(readiness.overall)}`);
            console.log('\nStep 4: Proof System (evidence anchors)...');
            // Pick anchors from diverse files for a better demo
            const anchors = s.db.prepare(`
                SELECT a.*, f.path as file_path FROM anchors a
                JOIN files f ON a.file_id = f.id
                GROUP BY a.file_id
                ORDER BY RANDOM() LIMIT 5
            `).all() as any[];
            if (anchors.length > 0) {
                for (const a of anchors) {
                    console.log(`  ${a.file_path}:${a.start_line}-${a.end_line} [hash:${a.snippet_hash?.slice(0, 8)}]`);
                }
            }
            console.log('\nAtlasMemory is ready! Try: atlasmemory search "authentication"');
        });

    program.command('doctor')
        .description('Diagnose AtlasMemory setup and database health')
        .action(() => {
            const store = getStore();
            const files = store.db.prepare('SELECT COUNT(*) as n FROM files').get() as { n: number };
            const symbols = store.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number };
            const anchors = store.db.prepare('SELECT COUNT(*) as n FROM anchors').get() as { n: number };
            const fileCards = store.db.prepare('SELECT COUNT(*) as n FROM file_cards').get() as { n: number };
            const flowCards = store.db.prepare('SELECT COUNT(*) as n FROM flow_cards').get() as { n: number };
            const ftsFiles = store.db.prepare('SELECT COUNT(*) as n FROM fts_files').get() as { n: number };
            const ftsSymbols = store.db.prepare('SELECT COUNT(*) as n FROM fts_symbols').get() as { n: number };
            const imports = store.db.prepare('SELECT COUNT(*) as n FROM imports').get() as { n: number };
            const refs = store.db.prepare('SELECT COUNT(*) as n FROM refs').get() as { n: number };

            let hasFtsStemmer = false;
            try {
                const ftsInfo = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_files'").get() as { sql: string } | undefined;
                hasFtsStemmer = !!ftsInfo?.sql?.includes('porter');
            } catch (e) { }

            const lastIndex = store.getState('last_index_at');

            console.log('AtlasMemory Doctor');
            console.log('==================');
            console.log(`  Database:      ${path.resolve(process.env.ATLAS_DB_PATH || '.atlas/atlas.db')}`);
            console.log(`  Last Index:    ${lastIndex || 'never'}`);
            console.log(`  Porter FTS:    ${hasFtsStemmer ? 'YES' : 'NO (re-index recommended)'}`);
            console.log('');
            console.log('  Table Counts:');
            console.log(`    Files:       ${files.n}`);
            console.log(`    Symbols:     ${symbols.n}`);
            console.log(`    Anchors:     ${anchors.n}`);
            console.log(`    File Cards:  ${fileCards.n}`);
            console.log(`    Flow Cards:  ${flowCards.n}`);
            console.log(`    Imports:     ${imports.n}`);
            console.log(`    Refs:        ${refs.n}`);
            console.log(`    FTS Files:   ${ftsFiles.n}`);
            console.log(`    FTS Symbols: ${ftsSymbols.n}`);
            console.log('');

            // Language grammars
            const indexer = new Indexer();
            const langStatus = indexer.getLanguageStatus();
            console.log(`  Grammars:      ${langStatus.loaded.join(', ')}`);
            if (langStatus.missing.length > 0) {
                console.log(`  Missing:       ${langStatus.missing.join(', ')} (install tree-sitter-* packages)`);
            }
            console.log('');

            // Git availability
            let gitAvailable = false;
            try {
                execSync('git --version', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
                gitAvailable = true;
            } catch {}
            console.log(`  Git:           ${gitAvailable ? 'YES' : 'NO (smart_diff, code_health unavailable)'}`);

            const issues: string[] = [];
            if (files.n === 0) issues.push('No files indexed. Run: atlasmemory index .');
            if (files.n > 0 && fileCards.n === 0) issues.push('Files indexed but no cards generated.');
            if (files.n > 0 && ftsFiles.n === 0) issues.push('FTS index empty. Re-index: atlasmemory index .');
            if (!hasFtsStemmer) issues.push('FTS missing Porter stemmer. Delete .atlas/atlas.db and re-index.');
            if (files.n > 0 && symbols.n === 0) issues.push('No symbols found. Check if files have supported extensions (.ts/.js/.py).');
            if (!gitAvailable) issues.push('Git not found. Install git for smart_diff and code health analysis.');
            if (langStatus.missing.length > 0) issues.push(`Missing grammars: ${langStatus.missing.join(', ')}. Install npm packages to index those languages.`);
            const coverage = files.n > 0 ? (fileCards.n / files.n * 100).toFixed(0) : '0';
            console.log(`  Card Coverage: ${coverage}%`);

            if (issues.length === 0) {
                console.log('  Status:        HEALTHY');
            } else {
                console.log('  Status:        ISSUES FOUND');
                for (const issue of issues) {
                    console.log(`    - ${issue}`);
                }
            }
        });

    program.command('enrich')
        .description('Enrich file cards with AI-generated semantic tags')
        .option('--batch <number>', 'Number of files to enrich', '10')
        .option('--backend <type>', 'Force backend: cli | api', '')
        .option('--all', 'Enrich all unenriched files')
        .option('--dry-run', 'Show what would be enriched without doing it')
        .action(async (options) => {
            const store = getStore();
            const { EnrichmentCoordinator } = await import('@atlasmemory/intelligence');
            const coordinator = new EnrichmentCoordinator(store);

            const coverage = coordinator.getEnrichmentCoverage();
            const backend = await coordinator.detectBackend();

            if (options.dryRun) {
                console.log('\nAtlasMemory Enrichment \u2014 Dry Run\n');
                console.log(`  Backend:     ${backend?.name || 'deterministic (no AI backend available)'}`);
                console.log(`  Coverage:    ${coverage.enriched}/${coverage.total} files enriched (${coverage.percentage}%)`);
                const remaining = coverage.total - coverage.enriched;
                const batch = options.all ? remaining : Math.min(safeParseInt(options.batch, 10), remaining);
                console.log(`  Would enrich: ${batch} files`);
                if (!backend) {
                    console.log('\n  No AI backend available:');
                    console.log('    - Install Claude CLI (free): https://docs.anthropic.com/claude-code');
                    console.log('    - Or set ANTHROPIC_API_KEY for API access');
                }
                return;
            }

            const limit = options.all ? coverage.total : safeParseInt(options.batch, 10);
            const forcedBackend = options.backend === 'cli' ? 'claude-cli'
                : options.backend === 'api' ? 'anthropic-sdk'
                : undefined;

            console.log(`\nAtlasMemory \u2014 Enriching with ${backend?.name || 'deterministic'} backend...\n`);

            const startTime = Date.now();
            const report = await coordinator.enrichBatch(limit, forcedBackend);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            const newCoverage = coordinator.getEnrichmentCoverage();
            console.log(`  [OK] Enriched ${report.enriched} files (${elapsed}s)`);
            if (report.failed > 0) console.log(`  [!!] Failed: ${report.failed}`);
            console.log(`  [OK] Skipped ${report.skipped} already-enriched files`);
            console.log(`  [OK] Backend: ${report.backend}`);
            console.log(`  [OK] Coverage: ${newCoverage.enriched}/${newCoverage.total} (${newCoverage.percentage}%)`);

            if (newCoverage.percentage < 100) {
                const remaining = newCoverage.total - newCoverage.enriched;
                console.log(`\n  ${remaining} files remaining. Run \`atlas enrich --all\` to enrich all.`);
            } else {
                console.log('\n  All files enriched! Search quality is at maximum.');
            }
            console.log('');
        });

    program.command('decisions')
        .description('View AI agent decisions for this project')
        .option('--file <path>', 'Show decisions for a specific file')
        .option('--search <query>', 'Full-text search in decisions')
        .option('--recent [days]', 'Show recent decisions (default: 7 days)')
        .option('--limit <number>', 'Maximum results', '20')
        .action(async (options) => {
            const store = getStore();
            const limit = Math.min(Math.max(safeParseInt(options.limit, 20), 1), 100);

            let changes: any[] = [];
            let mode = '';

            if (options.file) {
                changes = store.getChangesForFile(options.file, limit);
                mode = `File: ${options.file}`;
            } else if (options.search) {
                changes = store.searchAgentChanges(options.search, limit);
                mode = `Search: "${options.search}"`;
            } else {
                const days = typeof options.recent === 'string'
                    ? safeParseInt(options.recent, 7)
                    : 7;
                const since = new Date();
                since.setDate(since.getDate() - days);
                changes = store.getRecentChanges(since, limit);
                mode = `Recent ${days} days`;
            }

            console.log(`\nAtlasMemory \u2014 Agent Decisions (${mode})\n`);

            if (changes.length === 0) {
                console.log('  No decisions found.');
                console.log('  AI agents record decisions via the log_decision MCP tool.');
                console.log('');
                return;
            }

            for (const change of changes) {
                const date = change.createdAt
                    ? new Date(change.createdAt + ' UTC').toLocaleString()
                    : 'unknown';
                const typeIcon = change.changeType === 'fix' ? '[FIX]'
                    : change.changeType === 'feature' ? '[FEAT]'
                    : '[REFACTOR]';
                console.log(`  ${typeIcon} ${date}`);
                console.log(`    Summary: ${change.summary}`);
                console.log(`    Why:     ${change.why}`);
                if (change.filePaths?.length > 0) {
                    const displayPaths = change.filePaths.slice(0, 5);
                    console.log(`    Files:   ${displayPaths.join(', ')}${change.filePaths.length > 5 ? ` (+${change.filePaths.length - 5} more)` : ''}`);
                }
                console.log('');
            }

            console.log(`  Total: ${changes.length} decision(s)\n`);
        });

    program.command('brief')
        .description('Show Living Project Brief — a comprehensive project summary')
        .option('--json', 'Output as JSON')
        .option('--tokens <number>', 'Max token budget for brief', '900')
        .action(async (options) => {
            const store = getStore();
            const rootDir = detectProjectRoot(process.cwd());

            // Lazy imports to keep CLI fast
            const { CodeHealthAnalyzer, SessionLearner, EnrichmentCoordinator, ProjectBriefBuilder } = await import('@atlasmemory/intelligence');

            const codeHealth = new CodeHealthAnalyzer(store, rootDir);
            const sessionLearner = new SessionLearner(store);
            const enrichmentCoordinator = new EnrichmentCoordinator(store);
            const briefBuilder = new ProjectBriefBuilder(store, codeHealth, sessionLearner, enrichmentCoordinator);

            // Analyze code health before building brief
            try { await codeHealth.analyzeRepo(); } catch { /* skip if git not available */ }

            const maxTokens = safeParseInt(options.tokens, 900);

            if (options.json) {
                const json = briefBuilder.buildBriefJson({ rootDir, maxTokens });
                console.log(JSON.stringify(json, null, 2));
            } else {
                const { markdown, tokens } = briefBuilder.buildBrief({ rootDir, maxTokens });
                console.log('\n' + markdown);
                console.log(`\n--- ${tokens} tokens ---\n`);
            }
        });

    const memoryCmd = program.command('memory')
        .description('View and manage project memories (persistent across sessions)')
        .option('--type <type>', 'Filter by type: milestone, gap, learning, priority, context')
        .option('--all', 'Include resolved and archived memories')
        .option('--json', 'Machine-readable JSON output')
        .action(async (options) => {
            const store = getStore();
            const memories = store.getProjectMemories({
                type: options.type || undefined,
                status: options.all ? 'all' : 'active',
                limit: 50,
            });

            if (options.json) {
                console.log(JSON.stringify(memories, null, 2));
                return;
            }

            console.log('\nAtlasMemory \u2014 Project Memory\n');

            if (memories.length === 0) {
                console.log('  No memories found.');
                console.log('  AI agents store memories via the remember_project MCP tool.');
                console.log('  Or use: atlas memory add <type> "<content>"\n');
                return;
            }

            // Group by type
            const grouped = new Map<string, typeof memories>();
            for (const m of memories) {
                if (!grouped.has(m.memoryType)) grouped.set(m.memoryType, []);
                grouped.get(m.memoryType)!.push(m);
            }

            const typeOrder = ['context', 'gap', 'priority', 'milestone', 'learning'];
            const typeIcons: Record<string, string> = {
                milestone: '[MILE]', gap: '[GAP]', learning: '[LEARN]',
                priority: '[PRIO]', context: '[CTX]',
            };

            for (const type of typeOrder) {
                const items = grouped.get(type);
                if (!items) continue;
                console.log(`  ${typeIcons[type] || type.toUpperCase()}:`);
                for (const m of items) {
                    const statusTag = m.status !== 'active' ? ` (${m.status})` : '';
                    console.log(`    #${m.id}${statusTag} ${m.content}`);
                    if (m.why) console.log(`       Why: ${m.why}`);
                }
                console.log('');
            }

            console.log(`  Total: ${memories.length} memory/memories\n`);
        });

    memoryCmd.command('add <type> <content>')
        .description('Add a project memory (type: milestone, gap, learning, priority, context)')
        .option('--why <reason>', 'Why this matters')
        .action(async (type: string, content: string, options: any) => {
            const validTypes = ['milestone', 'gap', 'learning', 'priority', 'context'];
            if (!validTypes.includes(type)) {
                console.error(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`);
                process.exit(1);
            }
            const store = getStore();
            const id = store.addProjectMemory(type, content, options.why);
            console.log(`Added ${type.toUpperCase()}-${id}: "${content}"`);
        });

    memoryCmd.command('resolve <id>')
        .description('Mark a memory as resolved (e.g., a gap that was fixed)')
        .action(async (id: string) => {
            const numId = parseInt(id, 10);
            if (isNaN(numId)) {
                console.error('ID must be a number');
                process.exit(1);
            }
            const store = getStore();
            store.resolveProjectMemory(numId);
            console.log(`Resolved memory #${numId}`);
        });
}
