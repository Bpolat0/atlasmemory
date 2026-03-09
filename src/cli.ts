import { Command } from 'commander';
import { Store } from '@atlasmemory/store';
import { Indexer } from '@atlasmemory/indexer';
import { CardGenerator, FlowGenerator, LLMService, FolderSummarizer } from '@atlasmemory/summarizer';
import { SearchService } from '@atlasmemory/retrieval';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import { autoIndex, detectProjectRoot } from './auto-index.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let store: Store;

function getStore(dbPath?: string): Store {
    if (!store) {
        const resolved = path.resolve(dbPath || process.env.ATLAS_DB_PATH || '.atlas/atlas.db');
        if (!fs.existsSync(path.dirname(resolved))) {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
        }
        store = new Store(resolved);
    }
    return store;
}

export function registerCliCommands(program: Command): void {
    program.command('init')
        .description('Initialize AtlasMemory in the current directory')
        .action(() => {
            getStore();
            console.log('Initialized .atlas directory');
        });

    program.command('index [dir]')
        .description('Index a directory (default: current directory)')
        .option('--llm', 'Enable LLM-based summarization')
        .option('--api-key <key>', 'LLM API Key')
        .option('--no-incremental', 'Force full re-indexing')
        .action(async (dir, options) => {
            const rootDir = dir ? path.resolve(dir) : detectProjectRoot(process.cwd());
            const store = getStore();

            if (options.llm) {
                const apiKey = options.apiKey || process.env.ATLAS_LLM_API_KEY;
                if (!apiKey) {
                    console.error('Error: --api-key or ATLAS_LLM_API_KEY required for LLM mode');
                    process.exit(1);
                }
                console.log('LLM summarization enabled');
            }

            console.log(`Indexing ${rootDir}...`);
            const result = await autoIndex(store, rootDir, {
                onFile: (p) => console.log(`  ${path.relative(rootDir, p)}`),
            });
            console.log(`Done. ${result.files} files, ${result.symbols} symbols indexed.`);
        });

    program.command('search <query>')
        .description('Search the indexed repository')
        .option('--limit <number>', 'Max results', '10')
        .action((query, options) => {
            const store = getStore();
            const service = new SearchService(store);
            const results = service.search(query, parseInt(options.limit));

            if (results.length === 0) {
                console.log('No results. Run `atlasmemory index` first.');
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

            const scoredResults = service.search(objective, parseInt(options.limit));
            const fileIds = scoredResults.map(r => r.file.id);
            const pack = builder.build(objective, fileIds, parseInt(options.budget), {
                proof: options.proof,
            });
            console.log(pack);
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
        .requiredOption('--since <value>', 'Since (git sha | timestamp | last)')
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
}
