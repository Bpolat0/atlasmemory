
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Store } from '@atlasmemory/store';
import { Indexer } from '@atlasmemory/indexer';
import { SearchService } from '@atlasmemory/retrieval';
import { TaskPackBuilder, BootPackBuilder, ContextContractService } from '@atlasmemory/taskpack';
import { CardGenerator, FlowGenerator } from '@atlasmemory/summarizer';

export interface EvalConfig {
    repoPath: string;
    outDir: string;
    description: string;
    budgets: number[];
    smoke?: boolean;
    objectiveCount?: number;
    skipIndex?: boolean;
    incremental?: boolean;
    dbPath?: string;
    batchSize?: number;
    minDbCoverage?: number;
    coverageMode?: 'files' | 'cards';
    autoHealOnLowCoverage?: boolean;
    allowFullIndexFallback?: boolean;
    allowUnprovenTaskpack?: boolean;
    maxDeltaUnprovenRate?: number;
}

interface LatencySample {
    op: string;
    ms: number;
}

interface BootpackCheckResult {
    bootpackTokens: number;
    handshakeTokens: number;
    hasRequiredSections: boolean;
    cliParity: boolean;
    deltapackHasChangedFile: boolean;
    deltapackHasAffectedFlows: boolean;
    bootpackUnprovenCount: number;
    deltaUnprovenRate: number;
    contractDeterministic: boolean;
    strictBlocksOnDrift: boolean;
    strictBlocksOnCoverageLow: boolean;
    warnDoesNotBlock: boolean;
    proveClaimsBatchWorks: boolean;
    failed: boolean;
    reasons: string[];
}

interface CoverageStats {
    mode: 'files' | 'cards';
    discoverableSourceFiles: number;
    indexedSourceFiles: number;
    coverage: number;
    topMissingDirectories: Array<{ dir: string; count: number }>;
    topMissingExtensions: Array<{ ext: string; count: number }>;
}

export class EvalRunner {
    private store!: Store;
    private indexer: Indexer;
    private latencies: LatencySample[] = [];
    private dbPath!: string;

    constructor(private config: EvalConfig) {
        this.indexer = new Indexer();
    }

    async run() {
        this.initStore();

        console.log(`\n--- Starting Suite: ${this.config.description} ---`);
        console.log(`Repo: ${this.config.repoPath}`);
        console.log(`Out: ${this.config.outDir}`);

        // 1. Indexing
        const files = this.getAllFiles(this.config.repoPath);
        const minCoverage = this.config.minDbCoverage ?? 0.8;
        const guard = await this.ensureCoverage(files, minCoverage);
        const baseIndexStats = guard.indexStats;
        const flowRefreshStats = await this.refreshFlowCardsFromExisting();
        const indexStats = {
            ...baseIndexStats,
            flowRefreshMs: flowRefreshStats.ms,
            flowRefreshedFiles: flowRefreshStats.updatedFiles,
            coverageBefore: guard.before,
            coverageAfter: this.computeCoverage(files),
            coverageActions: guard.actions
        };

        // 2. Retrieval & Miss Analysis
        const retrievalStats = await this.runRetrieval();

        // 3. TaskPack Richness & Budget Curves
        const budgetStats = await this.runBudgets();

        // 3.5 BootPack / DeltaPack checks
        const bootpackChecks = await this.runBootpackChecks(files);

        // 4. Performance Stats
        const perfStats = this.calcPerfStats();

        // 5. Generate Report
        this.generateReport(indexStats, retrievalStats, budgetStats, perfStats, bootpackChecks);
    }

    private initStore() {
        if (!fs.existsSync(this.config.outDir)) {
            fs.mkdirSync(this.config.outDir, { recursive: true });
        }

        this.dbPath = this.config.dbPath
            ? path.resolve(this.config.dbPath)
            : path.join(this.config.outDir, 'atlas.db');

        if (!this.config.dbPath && !this.config.incremental && !this.config.skipIndex) {
            fs.rmSync(this.dbPath, { force: true });
        }

        if (!fs.existsSync(path.dirname(this.dbPath))) {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        }

        this.store = new Store(this.dbPath);
    }

    private getAllFiles(dir: string): string[] {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        for (const file of list) {
            const full = path.join(dir, file);
            const stat = fs.statSync(full);
            if (stat && stat.isDirectory()) {
                if (!this.shouldSkipDirectory(full, file)) {
                    results = results.concat(this.getAllFiles(full));
                }
            } else {
                if (this.shouldIndexFile(full)) {
                    results.push(full);
                }
            }
        }
        return results;
    }

    private shouldSkipDirectory(fullPath: string, dirName: string): boolean {
        if (['node_modules', '.git', '.atlas', 'dist', 'build', 'coverage', 'out', '.cache', '.turbo'].includes(dirName)) {
            return true;
        }

        const normalized = fullPath.replace(/\\/g, '/').toLowerCase();
        if (normalized.includes('/apps/eval/reports/')) return true;
        if (this.config.smoke && (normalized.includes('/apps/eval/synth-') || normalized.includes('/synth-'))) return true;

        return false;
    }

    private shouldIndexFile(filePath: string): boolean {
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();

        if (!(normalized.endsWith('.ts') || normalized.endsWith('.js') || normalized.endsWith('.py'))) {
            return false;
        }

        if (normalized.endsWith('.d.ts')) return false;
        if (normalized.endsWith('.map')) return false;
        if (/\.min\.[^./]+$/.test(normalized)) return false;
        if (normalized.includes('/apps/eval/reports/')) return false;
        if (this.config.smoke && (normalized.includes('/apps/eval/synth-') || normalized.includes('/synth-'))) return false;

        return true;
    }

    private isExcludedByPolicy(filePath: string): boolean {
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();

        if (/\/(node_modules|\.git|\.atlas|dist|build|coverage|out|\.cache|\.turbo)\//.test(normalized)) return true;
        if (normalized.includes('/apps/eval/reports/')) return true;
        if (normalized.endsWith('.d.ts')) return true;
        if (normalized.endsWith('.map')) return true;
        if (/\.min\.[^./]+$/.test(normalized)) return true;
        if (this.config.smoke && (normalized.includes('/apps/eval/synth-') || normalized.includes('/synth-'))) return true;

        return false;
    }

    private normalizePath(filePath: string): string {
        return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
    }

    private computeCoverage(discoverableFiles: string[]): CoverageStats {
        const mode = this.config.coverageMode || 'files';
        const discoverableMap = new Map<string, string>();
        for (const full of discoverableFiles) {
            discoverableMap.set(this.normalizePath(full), full);
        }

        const indexed = new Set<string>();
        for (const file of this.store.getFiles()) {
            const normalized = this.normalizePath(file.path);
            if (!discoverableMap.has(normalized)) continue;

            if (mode === 'cards') {
                const card = this.store.getFileCard(file.id);
                if (!card) continue;
            }

            indexed.add(normalized);
        }

        const missing: string[] = [];
        for (const [normalized, original] of discoverableMap.entries()) {
            if (!indexed.has(normalized)) missing.push(original);
        }

        const dirCounts = new Map<string, number>();
        const extCounts = new Map<string, number>();
        for (const filePath of missing) {
            const relDir = path.relative(this.config.repoPath, path.dirname(filePath)).replace(/\\/g, '/');
            const dirKey = relDir || '.';
            dirCounts.set(dirKey, (dirCounts.get(dirKey) || 0) + 1);

            const ext = path.extname(filePath).toLowerCase() || '(none)';
            extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        }

        const discoverableCount = discoverableMap.size;
        const indexedCount = indexed.size;

        return {
            mode,
            discoverableSourceFiles: discoverableCount,
            indexedSourceFiles: indexedCount,
            coverage: discoverableCount === 0 ? 1 : indexedCount / discoverableCount,
            topMissingDirectories: Array.from(dirCounts.entries())
                .map(([dir, count]) => ({ dir, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 8),
            topMissingExtensions: Array.from(extCounts.entries())
                .map(([ext, count]) => ({ ext, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 8)
        };
    }

    private async ensureCoverage(discoverableFiles: string[], minCoverage: number): Promise<{ indexStats: any; before: CoverageStats; actions: string[] }> {
        const actions: string[] = [];
        const before = this.computeCoverage(discoverableFiles);

        const autoHeal = this.config.autoHealOnLowCoverage === true;
        const allowFull = this.config.allowFullIndexFallback === true;

        const pass = (stats: any) => ({ indexStats: stats, before, actions });

        if (this.config.skipIndex) {
            if (before.coverage >= minCoverage) {
                actions.push('coverage_guard_pass_skip');
                return pass(await this.runIndexing(discoverableFiles, { skipIndex: true }));
            }

            if (!autoHeal) {
                throw new Error(
                    `DB coverage below threshold (${(before.coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(1)}%). ` +
                    `Enable --autoHealOnLowCoverage to recover.`
                );
            }

            actions.push('auto_heal_incremental');
            const incrementalStats = await this.runIndexing(discoverableFiles, { skipIndex: false, incremental: true });
            const afterIncremental = this.computeCoverage(discoverableFiles);
            if (afterIncremental.coverage >= minCoverage) {
                return pass(incrementalStats);
            }

            if (allowFull) {
                actions.push('auto_heal_full_fallback');
                const fullStats = await this.runIndexing(discoverableFiles, { skipIndex: false, incremental: false });
                const afterFull = this.computeCoverage(discoverableFiles);
                if (afterFull.coverage >= minCoverage) {
                    return pass(fullStats);
                }
            }

            throw new Error(
                `Coverage still below threshold after auto-heal (${(this.computeCoverage(discoverableFiles).coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(1)}%).`
            );
        }

        const baseStats = await this.runIndexing(discoverableFiles);
        const afterBase = this.computeCoverage(discoverableFiles);
        if (afterBase.coverage >= minCoverage) {
            actions.push('coverage_guard_pass_after_index');
            return pass(baseStats);
        }

        if (!autoHeal) {
            throw new Error(
                `Coverage below threshold after index (${(afterBase.coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(1)}%).`
            );
        }

        actions.push('auto_heal_incremental_after_index');
        const incrementalStats = await this.runIndexing(discoverableFiles, { skipIndex: false, incremental: true });
        const afterIncremental = this.computeCoverage(discoverableFiles);
        if (afterIncremental.coverage >= minCoverage) {
            return pass(incrementalStats);
        }

        if (allowFull) {
            actions.push('auto_heal_full_fallback_after_index');
            const fullStats = await this.runIndexing(discoverableFiles, { skipIndex: false, incremental: false });
            const afterFull = this.computeCoverage(discoverableFiles);
            if (afterFull.coverage >= minCoverage) {
                return pass(fullStats);
            }
        }

        throw new Error(
            `Coverage still below threshold after auto-heal (${(this.computeCoverage(discoverableFiles).coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(1)}%).`
        );
    }

    private async runIndexing(files: string[], options?: { skipIndex?: boolean; incremental?: boolean }) {
        const start = Date.now();
        const skipIndex = options?.skipIndex ?? this.config.skipIndex === true;
        if (skipIndex) {
            return { count: 0, time: Date.now() - start, skipped: files.length, mode: 'skip' };
        }

        let count = 0;
        let skipped = 0;
        let deleted = 0;
        const crypto = await import('crypto');
        const cardGen = new CardGenerator(); // No LLM
        const flowGen = new FlowGenerator(this.store);
        const batchSize = this.config.batchSize || 200;

        const incremental = options?.incremental ?? this.config.incremental === true;
        const existingFiles = new Map<string, { id: string, contentHash: string }>();
        const visited = new Set<string>();

        if (incremental) {
            for (const file of this.store.getFiles()) {
                existingFiles.set(path.resolve(file.path).toLowerCase(), {
                    id: file.id,
                    contentHash: file.contentHash
                });
            }
        }

        const pendingWrites: Array<{ full: string; content: string; hash: string }> = [];

        const flushBatch = async () => {
            if (pendingWrites.length === 0) return;

            this.store.db.exec('BEGIN');
            try {
                for (const item of pendingWrites) {
                    const istart = Date.now();
                    const { symbols, anchors, refs } = this.indexer.parse(item.full, item.content);
                    const ext = path.extname(item.full).slice(1).toLowerCase();
                    const language = ext.startsWith('ts') ? 'ts' : ext.startsWith('js') ? 'js' : 'py';
                    const fid = this.store.addFile(item.full, language, item.hash, item.content.split('\n').length, item.content);
                    symbols.forEach(s => { s.fileId = fid; this.store.addSymbol(s); });
                    anchors.forEach(a => { a.fileId = fid; this.store.upsertAnchor(a); });
                    if (refs) refs.forEach(r => this.store.addRef(r));

                    const flowCards = flowGen.rebuildAndStoreForFile(fid);
                    const card = await cardGen.generateFileCard(fid, item.full, symbols, item.content, anchors, flowCards);
                    this.store.addFileCard(card);

                    this.latencies.push({ op: 'index_file', ms: Date.now() - istart });
                    count++;
                }
                this.store.db.exec('COMMIT');
            } catch (e) {
                this.store.db.exec('ROLLBACK');
                throw e;
            } finally {
                pendingWrites.length = 0;
            }
        };

        for (const full of files) {
            const norm = path.resolve(full).toLowerCase();
            visited.add(norm);
            const content = fs.readFileSync(full, 'utf-8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');

            if (incremental) {
                const existing = existingFiles.get(norm);
                if (existing && existing.contentHash === hash) {
                    skipped++;
                    continue;
                }
                if (existing) {
                    this.store.deleteFile(existing.id);
                }
            }

            pendingWrites.push({ full, content, hash });
            if (pendingWrites.length >= batchSize) {
                await flushBatch();
            }
        }

        await flushBatch();

        if (incremental) {
            for (const [norm, info] of existingFiles) {
                if (!visited.has(norm)) {
                    this.store.deleteFile(info.id);
                    deleted++;
                }
            }
        }

        return {
            count,
            time: Date.now() - start,
            skipped,
            deleted,
            mode: incremental ? 'incremental' : 'full',
            dbFiles: this.store.getFiles().length
        };
    }

    private async refreshFlowCardsFromExisting(): Promise<{ updatedFiles: number; ms: number }> {
        const start = Date.now();
        const flowGen = new FlowGenerator(this.store);
        let updatedFiles = 0;

        const files = this.store.getFiles();
        for (const file of files) {
            const existingFlows = this.store.getFlowCardsForFile(file.id);
            if (existingFlows.length > 0) continue;
            const rebuilt = flowGen.rebuildAndStoreForFile(file.id);
            if (rebuilt.length > 0) updatedFiles++;
        }

        return { updatedFiles, ms: Date.now() - start };
    }

    private async runRetrieval() {
        let needles = [];
        let purposes: { purpose: string }[] = [];
        let flowNeedles: { file: string, from: string, to: string }[] = [];
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(this.config.repoPath, 'metadata.json'), 'utf-8'));
            needles = meta.needles || [];
            purposes = meta.purposes || [];
            flowNeedles = meta.flowNeedles || [];
        } catch (e) { }

        if (needles.length === 0) {
            return {
                score: null,
                recallAt5: null,
                zeroResultRate: null,
                misses: [],
                flowRecall: flowNeedles.length === 0 ? 1 : 0,
                hasGroundTruth: false
            };
        }

        const service = new SearchService(this.store);
        let found = 0;
        let foundTop5 = 0;
        let zeroResults = 0;
        const misses = [];

        for (const needle of needles) {
            if (needle.type === 'content_keyword') {
                const start = Date.now();
                const res = service.search(needle.value, 10);
                this.latencies.push({ op: 'search', ms: Date.now() - start });

                if (res.length === 0) zeroResults++;

                const hitIndex = res.findIndex(r => r.file.path.endsWith(needle.file));
                if (hitIndex !== -1) {
                    found++;
                    if (hitIndex < 5) foundTop5++;
                } else {
                    // Miss Analysis
                    const isIndexed = this.store.searchFiles(needle.file).length > 0; // Naive check
                    const ftsCheck = this.store.db.prepare('SELECT rowid FROM fts_files WHERE content MATCH ?').get(`"${needle.value}"`);

                    misses.push({
                        objective: needle.value,
                        expected: needle.file,
                        topResults: res.map(r => `${path.basename(r.file.path)} (${r.score.toFixed(1)} ${r.confidence || ''})`),
                        reason: !isIndexed ? 'Not Indexed' : (!ftsCheck ? 'FTS Missing' : 'Ranking/Budget')
                    });
                }
            }
        }

        let flowHits = 0;
        for (const flowNeedle of flowNeedles) {
            const fileMatches = this.store.searchFiles(flowNeedle.file) as any[];
            const file = fileMatches.find(f => String(f.path).endsWith(flowNeedle.file));
            if (!file) continue;

            const flows = this.store.getFlowCardsForFile(file.id);
            const hit = flows.some(flow => {
                const names = flow.trace.map(step => step.symbolName);
                return names.includes(flowNeedle.from) && names.includes(flowNeedle.to);
            });
            if (hit) flowHits++;
        }

        return {
            score: found / needles.length,
            recallAt5: foundTop5 / needles.length,
            zeroResultRate: zeroResults / needles.length,
            flowRecall: flowNeedles.length > 0 ? flowHits / flowNeedles.length : 1,
            misses,
            hasGroundTruth: true
        };
    }

    private async runBudgets() {
        const builder = new TaskPackBuilder(this.store);
        const objectives = this.config.smoke
            ? this.getSmokeObjectives(this.config.objectiveCount || 10)
            : ["Investigate system architecture", "Find memory leaks"];

        // Add needle-based objectives for realism
        let needles = [];
        let purposes: { purpose: string }[] = [];
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(this.config.repoPath, 'metadata.json'), 'utf-8'));
            needles = meta.needles || [];
            purposes = meta.purposes || [];
        } catch (e) { }

        if (needles.length > 0 && objectives.length < (this.config.objectiveCount || Number.MAX_SAFE_INTEGER)) {
            objectives.push(`Explain logic for ${needles[0].value}`);
        }

        // Use random purposes from metadata
        if (purposes.length > 0) {
            // Pick 2 random purposes
            const p1 = purposes[Math.floor(Math.random() * purposes.length)];
            const p2 = purposes[Math.floor(Math.random() * purposes.length)];
            if (objectives.length < (this.config.objectiveCount || Number.MAX_SAFE_INTEGER)) {
                objectives.push(`Explain: ${p1.purpose}`);
            }
            if (objectives.length < (this.config.objectiveCount || Number.MAX_SAFE_INTEGER)) {
                objectives.push(`Explain: ${p2.purpose}`);
            }
        }

        const results = [];
        const service = new SearchService(this.store);

        const finalObjectives = this.config.objectiveCount && objectives.length > this.config.objectiveCount
            ? objectives.slice(0, this.config.objectiveCount)
            : objectives;

        for (const obj of finalObjectives) {
            // Search first
            const searchRes = service.search(obj, 20);
            const scopeIds = searchRes.map(r => r.file.id);

            for (const b of this.config.budgets) {
                const start = Date.now();
                const pack = builder.build(obj, scopeIds, b, {
                    proof: this.config.allowUnprovenTaskpack ? 'warn' : 'strict',
                    allowUnproven: this.config.allowUnprovenTaskpack === true
                });
                this.latencies.push({ op: 'taskpack', ms: Date.now() - start });

                // Richness Metrics
                const estTokens = Math.ceil(pack.length / 4);

                // Parse pack to count items (Roughly)
                const fileCount = (pack.match(/### \[File\]/g) || []).length;
                const snippetCount = (pack.match(/```[a-z]+\n\/\/ Lines/g) || []).length; // Heuristic
                const folderCount = (pack.match(/- \*\*.+\/\*\*: /g) || []).length;
                const flowCount = (pack.match(/(^|\n)\s*-\s*F:/g) || []).length;
                const unprovenCount = (pack.match(/S:UNPROVEN/g) || []).length;

                // Assertions
                let failed = false;
                let failReason = '';

                if (b >= 1500 && fileCount < 1) {
                    failed = true; failReason = 'No files selected >= 1500';
                }
                if (b >= 3000 && (fileCount < 1 || (snippetCount < 1 && flowCount < 1))) {
                    failed = true; failReason = 'No evidence >= 3000';
                }
                if (b >= 6000 && flowCount < 1) {
                    failed = true; failReason = 'No flow trace >= 6000';
                }
                if (b >= 6000 && unprovenCount > 0 && !this.config.allowUnprovenTaskpack) {
                    failed = true; failReason = `UNPROVEN claims in strict taskpack: ${unprovenCount}`;
                }

                results.push({
                    objective: obj,
                    budget: b,
                    tokens: estTokens,
                    files: fileCount,
                    snippets: snippetCount,
                    flows: flowCount,
                    unproven: unprovenCount,
                    folders: folderCount,
                    failed,
                    failReason
                });
            }
        }
        return results;
    }

    private getSmokeObjectives(count: number): string[] {
        const base = [
            'Investigate system architecture',
            'Find memory leaks',
            'Trace call graph for indexing pipeline',
            'Explain retrieval fallback strategy',
            'Find environment variable usage',
            'Locate SQLite schema initialization',
            'Review TaskPack flow generation',
            'Find stale card refresh logic',
            'Trace CLI index command execution',
            'Explain MCP tool validation path',
            'Find import linking logic',
            'Analyze flow-card evidence anchors'
        ];
        return base.slice(0, Math.max(1, count));
    }

    private calcPerfStats() {
        const ops = ['index_file', 'search', 'taskpack'];
        const stats: any = {};
        for (const op of ops) {
            const measurements = this.latencies.filter(x => x.op === op).map(x => x.ms).sort((a, b) => a - b);
            if (measurements.length === 0) continue;
            const p50 = measurements[Math.floor(measurements.length * 0.5)];
            const p95 = measurements[Math.floor(measurements.length * 0.95)];
            stats[op] = { p50, p95, count: measurements.length };
        }
        return stats;
    }

    private async runBootpackChecks(discoverableFiles: string[]): Promise<BootpackCheckResult> {
        const reasons: string[] = [];
        const builder = new BootPackBuilder(this.store);
        const contracts = new ContextContractService(this.store, this.config.repoPath);

        const bootpack = builder.buildBootPack({ budget: 1500, format: 'capsule', compress: 'on' });
        if (bootpack.tokens > 1500) reasons.push(`bootpack_over_budget:${bootpack.tokens}`);
        const bootpackUnprovenCount = (bootpack.text.match(/S:UNPROVEN/g) || []).length;
        if (bootpackUnprovenCount > 0) reasons.push(`bootpack_unproven_claims:${bootpackUnprovenCount}`);

        const handshake = builder.buildHandshake(400);
        if (handshake.tokens > 400) reasons.push(`handshake_over_budget:${handshake.tokens}`);

        const requiredSections = ['## Purpose', '## Architecture Map', '## Invariants & Contracts', '## Top Flows', '## Tool Protocol'];
        const hasRequiredSections = requiredSections.every(section => bootpack.text.includes(section));
        if (!hasRequiredSections) reasons.push('bootpack_missing_sections');

        let cliParity = false;
        try {
            const cliOutput = execSync('node apps/cli/dist/src/index.js bootpack --budget 1500 --format capsule', {
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    ATLAS_DB_PATH: this.dbPath
                }
            }).trim();
            cliParity = cliOutput === bootpack.text.trim();
        } catch {
            cliParity = false;
        }
        if (!cliParity) reasons.push('bootpack_cli_parity_failed');

        let deltapackHasChangedFile = false;
        let deltapackHasAffectedFlows = false;
        let deltaUnprovenRate = 0;
        let contractDeterministic = false;
        let strictBlocksOnDrift = false;
        let strictBlocksOnCoverageLow = false;
        let warnDoesNotBlock = false;
        let proveClaimsBatchWorks = false;
        const isSyntheticRepo = fs.existsSync(path.join(this.config.repoPath, 'metadata.json'));

        const targetFile = discoverableFiles.find(file => {
            if (!(file.endsWith('.ts') || file.endsWith('.js'))) return false;
            const fileId = this.store.getFileId(file);
            if (!fileId) return false;
            return this.store.getFlowCardsForFile(fileId).length > 0;
        }) || discoverableFiles.find(file => file.endsWith('.ts') || file.endsWith('.js'));
        if (isSyntheticRepo && targetFile) {
            this.store.setState('last_deltapack_at', new Date().toISOString());
            await new Promise(resolve => setTimeout(resolve, 1200));
            fs.appendFileSync(targetFile, `\n// eval-delta-${Date.now()}`);

            await this.runIndexing([targetFile], { skipIndex: false, incremental: true });
            const delta = builder.buildDeltaPack({ since: 'last', budget: 2000, format: 'json' });
            const deltaJson = JSON.parse(delta.text);
            const deltaCapsule = String(deltaJson.capsule || '');
            const deltaClaims = this.countClaims(deltaCapsule);
            const deltaUnproven = (deltaCapsule.match(/S:UNPROVEN/g) || []).length;
            deltaUnprovenRate = deltaClaims > 0 ? deltaUnproven / deltaClaims : 0;
            const maxRate = this.config.maxDeltaUnprovenRate ?? 0.35;
            if (deltaUnprovenRate > maxRate) reasons.push(`deltapack_unproven_rate:${deltaUnprovenRate.toFixed(3)}>${maxRate}`);

            deltapackHasChangedFile = Array.isArray(deltaJson.changedFiles) && deltaJson.changedFiles.length > 0;
            deltapackHasAffectedFlows = Array.isArray(deltaJson.affectedFlowIds) && deltaJson.affectedFlowIds.length > 0;

            if (!deltapackHasChangedFile) reasons.push('deltapack_missing_changed_file');
            if (!deltapackHasAffectedFlows) reasons.push('deltapack_missing_affected_flows');
        } else if (!isSyntheticRepo) {
            deltapackHasChangedFile = true;
            deltapackHasAffectedFlows = true;
        } else {
            reasons.push('deltapack_no_target_file');
        }

        const base = contracts.createSnapshot({
            sessionId: 'eval-contract',
            proofMode: 'strict',
            minDbCoverage: 0
        });
        const hashA = contracts.createContractHash(base.snapshot);
        const hashB = contracts.createContractHash(base.snapshot);
        contractDeterministic = hashA === hashB;
        if (!contractDeterministic) reasons.push('contract_non_deterministic');

        const fileId = this.store.addFile(
            path.join(this.config.repoPath, '.atlas_contract_eval_temp.ts'),
            'ts',
            `temp-${Date.now()}`,
            1,
            'export const __atlas_contract_eval = 1;'
        );
        const driftEval = contracts.evaluateContract({
            sessionId: 'eval-contract',
            providedContractHash: base.contractHash,
            enforce: 'strict'
        });
        strictBlocksOnDrift = driftEval.requiredBootstrap && driftEval.reasons.includes('DB_CHANGED');
        if (!strictBlocksOnDrift) reasons.push('contract_drift_not_blocked');
        this.store.deleteFile(fileId);

        const lowCoverage = contracts.createSnapshot({
            sessionId: 'eval-contract-low',
            minDbCoverage: 2,
            proofMode: 'strict'
        });
        const lowCoverageEval = contracts.evaluateContract({
            sessionId: 'eval-contract-low',
            providedContractHash: lowCoverage.contractHash,
            enforce: 'strict'
        });
        strictBlocksOnCoverageLow = lowCoverageEval.requiredBootstrap && lowCoverageEval.reasons.includes('COVERAGE_LOW');
        if (!strictBlocksOnCoverageLow) reasons.push('contract_coverage_low_not_blocked');

        const warnEval = contracts.evaluateContract({
            sessionId: 'eval-contract-low',
            providedContractHash: lowCoverage.contractHash,
            enforce: 'warn'
        });
        warnDoesNotBlock = warnEval.requiredBootstrap === false;
        if (!warnDoesNotBlock) reasons.push('contract_warn_blocked');

        const batch = builder.proveClaims([
            { text: 'TaskPackBuilder builds context packs', scopePath: this.config.repoPath },
            { text: 'TaskPackBuilder builds context packs', scopePath: this.config.repoPath }
        ], 3, { sessionId: 'eval-proof-batch', proofMode: 'strict', proofBudget: 2500, diversity: true });
        proveClaimsBatchWorks = Array.isArray(batch.results)
            && batch.results.length === 2
            && batch.metadata
            && typeof batch.metadata.executed === 'number'
            && batch.metadata.executed <= 1;
        if (!proveClaimsBatchWorks) reasons.push('prove_claims_batch_not_working');

        return {
            bootpackTokens: bootpack.tokens,
            handshakeTokens: handshake.tokens,
            hasRequiredSections,
            cliParity,
            deltapackHasChangedFile,
            deltapackHasAffectedFlows,
            bootpackUnprovenCount,
            deltaUnprovenRate,
            contractDeterministic,
            strictBlocksOnDrift,
            strictBlocksOnCoverageLow,
            warnDoesNotBlock,
            proveClaimsBatchWorks,
            failed: reasons.length > 0,
            reasons
        };
    }

    private countClaims(text: string): number {
        return (text.match(/(^|\n)\s*[- ]?(C|F):/g) || []).length;
    }

    private generateReport(indexStats: any, retrievalStats: any, budgetStats: any, perfStats: any, bootpackChecks: BootpackCheckResult) {
        const reportPath = path.join(this.config.outDir, 'REPORT.md');
        const jsonPath = path.join(this.config.outDir, 'report.json');

        const overallPass = !budgetStats.some((b: any) => b.failed) && !bootpackChecks.failed;

        let md = `# Eval Report: ${this.config.description}\n\n`;
        md += `## Executive Summary\n`;
        md += `**Result**: ${overallPass ? 'PASS' : 'FAIL'}\n`;
        md += `- Indexing: ${indexStats.time}ms (${indexStats.count} files, mode: ${indexStats.mode || 'full'}, skipped: ${indexStats.skipped || 0})\n`;
        md += `- Flow Refresh: ${indexStats.flowRefreshMs || 0}ms (${indexStats.flowRefreshedFiles || 0} files)\n`;
        md += `- Coverage (${indexStats.coverageAfter.mode}): ${indexStats.coverageAfter.indexedSourceFiles}/${indexStats.coverageAfter.discoverableSourceFiles} (${(indexStats.coverageAfter.coverage * 100).toFixed(1)}%)\n`;
        md += `- Retrieval Recall (Recall@10): ${retrievalStats.score === null ? 'N/A' : retrievalStats.score.toFixed(3)}\n`;
        md += `- Recall@5: ${retrievalStats.recallAt5 === null ? 'N/A' : retrievalStats.recallAt5.toFixed(3)}\n`;
        md += `- Zero Result Rate: ${retrievalStats.zeroResultRate === null ? 'N/A' : `${(retrievalStats.zeroResultRate * 100).toFixed(1)}%`}\n`;
        md += `- Flow Recall: ${retrievalStats.flowRecall.toFixed(3)}\n`;
        md += `- p95 Search Latency: ${perfStats.search?.p95 !== undefined ? `${perfStats.search.p95}ms` : 'n/a'}\n\n`;

        const dirCounts = this.getTopDirectoriesByFileCount();
        md += `## Top Directories by File Count\n`;
        dirCounts.forEach((entry) => {
            md += `- ${entry.dir}: ${entry.count}\n`;
        });
        md += `\n`;

        md += `## BootPack Checks\n`;
        md += `- BootPack Tokens: ${bootpackChecks.bootpackTokens}\n`;
        md += `- Handshake Tokens: ${bootpackChecks.handshakeTokens}\n`;
        md += `- Required Sections: ${bootpackChecks.hasRequiredSections ? 'OK' : 'FAIL'}\n`;
        md += `- CLI Parity: ${bootpackChecks.cliParity ? 'OK' : 'FAIL'}\n`;
        md += `- Delta Changed File: ${bootpackChecks.deltapackHasChangedFile ? 'OK' : 'FAIL'}\n`;
        md += `- Delta Affected Flows: ${bootpackChecks.deltapackHasAffectedFlows ? 'OK' : 'FAIL'}\n`;
        md += `- BootPack UNPROVEN Claims: ${bootpackChecks.bootpackUnprovenCount}\n`;
        md += `- Delta UNPROVEN Rate: ${bootpackChecks.deltaUnprovenRate.toFixed(3)}\n`;
        md += `- Contract Determinism: ${bootpackChecks.contractDeterministic ? 'OK' : 'FAIL'}\n`;
        md += `- Strict Drift Block: ${bootpackChecks.strictBlocksOnDrift ? 'OK' : 'FAIL'}\n`;
        md += `- Strict Coverage Block: ${bootpackChecks.strictBlocksOnCoverageLow ? 'OK' : 'FAIL'}\n`;
        md += `- Warn Mode Non-Blocking: ${bootpackChecks.warnDoesNotBlock ? 'OK' : 'FAIL'}\n`;
        md += `- prove_claims Batch: ${bootpackChecks.proveClaimsBatchWorks ? 'OK' : 'FAIL'}\n`;
        if (bootpackChecks.reasons.length > 0) {
            md += `- Fail Reasons: ${bootpackChecks.reasons.join(', ')}\n`;
        }
        md += `\n`;

        md += `## Coverage\n`;
        md += `- Mode: ${indexStats.coverageAfter.mode}\n`;
        md += `- Before: ${indexStats.coverageBefore.indexedSourceFiles}/${indexStats.coverageBefore.discoverableSourceFiles} (${(indexStats.coverageBefore.coverage * 100).toFixed(1)}%)\n`;
        md += `- After: ${indexStats.coverageAfter.indexedSourceFiles}/${indexStats.coverageAfter.discoverableSourceFiles} (${(indexStats.coverageAfter.coverage * 100).toFixed(1)}%)\n`;
        md += `- Actions: ${(indexStats.coverageActions || []).join(', ') || 'none'}\n`;
        md += `\n### Top Missing Directories\n`;
        if ((indexStats.coverageAfter.topMissingDirectories || []).length === 0) {
            md += `- none\n`;
        } else {
            (indexStats.coverageAfter.topMissingDirectories || []).forEach((entry: any) => {
                md += `- ${entry.dir}: ${entry.count}\n`;
            });
        }
        md += `\n### Top Missing Extensions\n`;
        if ((indexStats.coverageAfter.topMissingExtensions || []).length === 0) {
            md += `- none\n`;
        } else {
            (indexStats.coverageAfter.topMissingExtensions || []).forEach((entry: any) => {
                md += `- ${entry.ext}: ${entry.count}\n`;
            });
        }
        md += `\n`;

        if (!overallPass) {
            md += `### Failures\n`;
            budgetStats.filter((b: any) => b.failed).forEach((b: any) => {
                md += `- ${b.objective} (Budget ${b.budget}): ${b.failReason}\n`;
            });
            md += `\n`;
        }

        md += `## Pack Richness & Budgets\n`;
        md += `| Objective | Budget | Tokens | Files | Snippets | Flows | UNPROVEN | Status |\n`;
        md += `|---|---|---|---|---|---|---|---|\n`;
        budgetStats.forEach((b: any) => {
            md += `| ${b.objective.slice(0, 30)}... | ${b.budget} | ${b.tokens} | ${b.files} | ${b.snippets} | ${b.flows} | ${b.unproven || 0} | ${b.failed ? 'FAIL' : 'OK'} |\n`;
        });

        if (retrievalStats.misses.length > 0) {
            md += `\n## Retrieval Miss Analysis\n`;
            retrievalStats.misses.forEach((m: any) => {
                md += `- **Needle**: ${m.objective}\n`;
                md += `  - Expected: ${m.expected}\n`;
                md += `  - Reason: ${m.reason}\n`;
                md += `  - Top Results: ${m.topResults.join(', ')}\n`;
            });
        }

        md += `\n## Performance (p50 / p95)\n`;
        for (const op in perfStats) {
            md += `- **${op}**: ${perfStats[op].p50}ms / ${perfStats[op].p95}ms (${perfStats[op].count} samples)\n`;
        }

        fs.writeFileSync(reportPath, md);
        fs.writeFileSync(jsonPath, JSON.stringify({
            config: this.config,
            indexStats,
            retrievalStats,
            budgetStats,
            perfStats,
            bootpackChecks,
            topDirectories: dirCounts,
            coverage: {
                before: indexStats.coverageBefore,
                after: indexStats.coverageAfter,
                actions: indexStats.coverageActions || [],
                minDbCoverage: this.config.minDbCoverage ?? 0.8,
                coverageMode: this.config.coverageMode || 'files'
            }
        }, null, 2));

        console.log(`Report generated at ${reportPath}`);
    }

    private getTopDirectoriesByFileCount(limit: number = 8): Array<{ dir: string, count: number }> {
        const files = this.store.getFiles();
        const counts = new Map<string, number>();

        for (const file of files) {
            const rel = path.relative(this.config.repoPath, path.dirname(file.path)).replace(/\\/g, '/');
            const key = rel || '.';
            counts.set(key, (counts.get(key) || 0) + 1);
        }

        return Array.from(counts.entries())
            .map(([dir, count]) => ({ dir, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }
}
