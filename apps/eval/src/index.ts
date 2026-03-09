
import { Command } from 'commander';
import { SyntheticRepoGenerator } from './generate-synthetic-repo.js';
import { EvalRunner } from './runner.js';
import path from 'path';
import fs from 'fs';

// Helper for clean output
const log = (msg: string) => console.log(`[EVAL] ${msg}`);

const program = new Command();

program
    .name('atlas-eval')
    .description('AtlasMemory Evaluation Harness')
    .version('0.1.0');

program.command('generate')
    .description('Generate synthetic repo')
    .option('--out <dir>', 'Output directory', './synth-repo')
    .option('--files <number>', 'Number of files', '100')
    .action(async (options) => {
        const gen = new SyntheticRepoGenerator({
            rootPath: path.resolve(options.out),
            fileCount: parseInt(options.files),
            depth: 3,
            symbolDensity: 5
        });
        gen.generate();
        log(`Generated ${options.files} files in ${options.out}`);
    });

program.command('run')
    .description('Run evaluation suite on a single repo')
    .requiredOption('--repo <path>', 'Path to repo locally')
    .option('--out <dir>', 'Report output dir', './apps/eval/reports')
    .option('--desc <text>', 'Description', 'Manual Run')
    .option('--smoke', 'Run smoke mode with broader objective set', false)
    .option('--objective-count <number>', 'Number of objectives to evaluate', '10')
    .option('--skipIndex', 'Skip indexing and use existing DB when available', false)
    .option('--incremental', 'Incremental indexing (hash-based changes only)', false)
    .option('--db-path <path>', 'DB path to reuse for skip/incremental runs')
    .option('--minDbCoverage <number>', 'Minimum required DB coverage ratio', '0.8')
    .option('--coverageMode <mode>', 'Coverage mode: files or cards', 'files')
    .option('--autoHealOnLowCoverage', 'Auto-heal low coverage by indexing incrementally', false)
    .option('--allowFullIndexFallback', 'Allow full index fallback if incremental auto-heal cannot recover', false)
    .option('--allowUnprovenTaskpack', 'Allow UNPROVEN claims in taskpack checks', false)
    .option('--maxDeltaUnprovenRate <number>', 'Max allowed DeltaPack UNPROVEN rate', '0.35')
    .action(async (options) => {
        const coverageMode = options.coverageMode === 'cards' ? 'cards' : 'files';
        const runner = new EvalRunner({
            repoPath: path.resolve(options.repo),
            outDir: path.resolve(options.out, new Date().toISOString().replace(/[:.]/g, '-')),
            description: options.desc,
            budgets: options.smoke ? [1500, 6000] : [500, 1500, 3000, 6000, 12000],
            smoke: options.smoke,
            objectiveCount: parseInt(options.objectiveCount),
            skipIndex: options.skipIndex,
            incremental: options.incremental,
            dbPath: options.dbPath ? path.resolve(options.dbPath) : undefined,
            minDbCoverage: parseFloat(options.minDbCoverage),
            coverageMode,
            autoHealOnLowCoverage: options.autoHealOnLowCoverage,
            allowFullIndexFallback: options.allowFullIndexFallback,
            allowUnprovenTaskpack: options.allowUnprovenTaskpack,
            maxDeltaUnprovenRate: parseFloat(options.maxDeltaUnprovenRate)
        });
        await runner.run();
    });

program.command('run-all')
    .description('Run standard metrics suite (Synth-100, Synth-500, Real-Repo)')
    .action(async () => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseReportDir = path.resolve('apps', 'eval', 'reports', timestamp);

        // 1. Synth-100
        log('Generating Synth-100...');
        const s100Path = path.resolve('apps', 'eval', 'synth-100');
        new SyntheticRepoGenerator({
            rootPath: s100Path,
            fileCount: 100, depth: 3, symbolDensity: 5
        }).generate();

        log('Running Synth-100 Eval...');
        await new EvalRunner({
            repoPath: s100Path,
            outDir: path.join(baseReportDir, 'synth-100'),
            description: 'Synth-100 Scale Test',
            budgets: [500, 1500, 3000, 6000, 12000]
        }).run();

        // 2. Synth-500
        log('Generating Synth-500...');
        const s500Path = path.resolve('apps', 'eval', 'synth-500');
        new SyntheticRepoGenerator({
            rootPath: s500Path,
            fileCount: 500, depth: 5, symbolDensity: 5
        }).generate();

        log('Running Synth-500 Eval...');
        await new EvalRunner({
            repoPath: s500Path,
            outDir: path.join(baseReportDir, 'synth-500'),
            description: 'Synth-500 Scale Test',
            budgets: [500, 1500, 3000, 6000, 12000]
        }).run();

        // 3. Real Repo Smoke (Self)
        log('Running Real-Repo Smoke Eval...');
        await new EvalRunner({
            repoPath: process.cwd(), // evaluate self
            outDir: path.join(baseReportDir, 'real-repo'),
            description: 'AtlasMemory Real-Repo Smoke',
            budgets: [1500, 6000],
            smoke: true,
            objectiveCount: 10,
            skipIndex: true,
            incremental: true,
            dbPath: path.resolve('.atlas', 'atlas.db'),
            minDbCoverage: 0.8,
            coverageMode: 'files',
            autoHealOnLowCoverage: false,
            allowFullIndexFallback: false,
            allowUnprovenTaskpack: false,
            maxDeltaUnprovenRate: 0.35
        }).run();

        const readSuite = (suite: string) => {
            const reportJsonPath = path.join(baseReportDir, suite, 'report.json');
            if (!fs.existsSync(reportJsonPath)) return undefined;
            return JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8'));
        };

        const synth100 = readSuite('synth-100');
        const synth500 = readSuite('synth-500');
        const real = readSuite('real-repo');

        const renderSection = (title: string, data: any) => {
            if (!data) return `## ${title}\nNo data\n\n`;
            const failures = (data.budgetStats || []).filter((b: any) => b.failed).length;
            const p95Search = data.perfStats?.search?.p95;
            const recall5 = data.retrievalStats?.recallAt5;
            return [
                `## ${title}`,
                `- Files Indexed: ${data.indexStats?.count ?? 0}`,
                `- Recall@5: ${typeof recall5 === 'number' ? recall5.toFixed(3) : 'N/A'}`,
                `- Flow Recall: ${(data.retrievalStats?.flowRecall ?? 0).toFixed(3)}`,
                `- p95 Search: ${p95Search !== undefined ? `${p95Search}ms` : 'n/a'}`,
                `- Budget Failures: ${failures}`,
                ''
            ].join('\n');
        };

        const summaryMd = [
            '# Eval Run-All Summary',
            '',
            `Timestamp: ${timestamp}`,
            '',
            renderSection('Synth-100', synth100),
            renderSection('Synth-500', synth500),
            renderSection('Real-Repo Smoke', real)
        ].join('\n');

        fs.writeFileSync(path.join(baseReportDir, 'REPORT.md'), summaryMd);

        log(`All suites completed. Reports in ${baseReportDir}`);
    });

program.parse();
