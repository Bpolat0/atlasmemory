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
            const result = await autoIndex(store, rootDir, {
                onFile: () => {
                    progressCount++;
                    if (process.stderr.isTTY) {
                        process.stderr.write(`\r  Indexing: ${progressCount} files...`);
                    }
                },
                incremental: options.incremental,
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
            const results = service.search(query, parseInt(options.limit));

            if (results.length === 0) {
                const fileCount = store.getFiles().length;
                if (fileCount === 0) {
                    console.log('No files indexed. Run `atlasmemory index` first.');
                } else {
                    console.log(`No results found for "${query}".`);
                }
                return;
            }
            const cwd = process.cwd();
            for (const r of results) {
                const relPath = path.relative(cwd, r.file.path).replace(/\\/g, '/');
                console.log(`  ${r.score.toFixed(1).padStart(5)}  ${relPath}`);
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

            const scoredResults = service.search(objective, parseInt(options.limit));
            const fileIds = scoredResults.map(r => r.file.id);
            const pack = builder.build(objective, fileIds, parseInt(options.budget), {
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
                budget: parseInt(options.budget),
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
                budget: parseInt(options.budget),
                format: options.format,
                proof: options.proof,
            });
            console.log(result.text);
        });

    program.command('handshake')
        .description('Generate short operating instructions for agents')
        .option('--budget <number>', 'Token budget', '400')
        .action((options) => {
            const store = getStore();
            const builder = new BootPackBuilder(store);
            const result = builder.buildHandshake(parseInt(options.budget));
            console.log(result.text);
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
                const stats = await refresher.refreshAll(parseInt(options.limit));
                console.log(`Refreshed ${stats.generated} cards. Failed: ${stats.failed}`);
            } else {
                const refresher = new AutoRefresher(store, new LLMService({ apiKey: 'dummy' }));
                const stale = await refresher.findStaleFiles(parseInt(options.limit));
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
                const dir = path.dirname(outputPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const existed = fs.existsSync(outputPath);
                fs.writeFileSync(outputPath, file.content, 'utf-8');
                console.log(`  [OK] ${existed ? 'Updated' : 'Created'}: ${outputPath}`);
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
                    const relPath = path.relative(cwd, r.file.path).replace(/\\/g, '/');
                    console.log(`  ${relPath} (score: ${r.score.toFixed(1)})`);
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
                    const relAnchorPath = path.relative(cwd, a.file_path).replace(/\\/g, '/');
                    console.log(`  ${relAnchorPath}:${a.start_line}-${a.end_line} [hash:${a.snippet_hash?.slice(0, 8)}]`);
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
}
