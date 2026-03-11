// packages/intelligence/src/code-health.ts
import type { Store } from '@atlasmemory/store';
import type { CodeDNA } from '@atlasmemory/core';
import { execSync } from 'child_process';

interface GitCommit {
    hash: string;
    author: string;
    date: string;
    files: string[];
    message: string;
}

interface FileHealthData {
    filePath: string;
    churnScore: number;
    breakFrequency: number;
    lastModified: string;
    contributorCount: number;
    coupledFiles: string[];
    riskLevel: 'stable' | 'volatile' | 'fragile';
}

export class CodeHealthAnalyzer {
    constructor(private store: Store, private repoPath: string) {}

    /** Parse git log --format="%H%x09%an%x09%aI" --name-only output */
    parseGitLog(output: string): GitCommit[] {
        const commits: GitCommit[] = [];
        const lines = output.split(/\r?\n/);
        let current: GitCommit | null = null;

        for (const line of lines) {
            if (line.includes('\t')) {
                const parts = line.split('\t');
                if (parts.length >= 3) {
                    if (current) commits.push(current);
                    current = { hash: parts[0], author: parts[1], date: parts[2], files: [], message: '' };
                    continue;
                }
            }
            if (current && line.trim()) {
                current.files.push(line.trim());
            }
        }
        if (current) commits.push(current);
        return commits;
    }

    /** Compute health metrics from parsed commits */
    computeHealth(commits: GitCommit[]): FileHealthData[] {
        const fileStats = new Map<string, {
            commitCount: number;
            authors: Set<string>;
            lastModified: string;
            coChanges: Map<string, number>;
        }>();

        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        for (const commit of commits) {
            const commitDate = new Date(commit.date);
            for (const file of commit.files) {
                let stats = fileStats.get(file);
                if (!stats) {
                    stats = { commitCount: 0, authors: new Set(), lastModified: commit.date, coChanges: new Map() };
                    fileStats.set(file, stats);
                }
                if (commitDate >= ninetyDaysAgo) stats.commitCount++;
                stats.authors.add(commit.author);
                if (commit.date > stats.lastModified) stats.lastModified = commit.date;

                for (const otherFile of commit.files) {
                    if (otherFile !== file) {
                        stats.coChanges.set(otherFile, (stats.coChanges.get(otherFile) || 0) + 1);
                    }
                }
            }
        }

        // Break frequency: fix commit within 24h of previous commit touching same file
        const fileBreaks = new Map<string, number>();
        const sortedCommits = [...commits].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        const fixPattern = /\b(fix|revert|hotfix)\b/i;

        for (let i = 1; i < sortedCommits.length; i++) {
            const prev = sortedCommits[i - 1];
            const curr = sortedCommits[i];
            if (!fixPattern.test(curr.message || '')) continue;
            const timeDiff = new Date(curr.date).getTime() - new Date(prev.date).getTime();
            if (timeDiff > 24 * 60 * 60 * 1000) continue;
            for (const file of curr.files) {
                if (prev.files.includes(file)) {
                    fileBreaks.set(file, (fileBreaks.get(file) || 0) + 1);
                }
            }
        }

        const maxCommits = Math.max(1, ...Array.from(fileStats.values()).map(s => s.commitCount));

        const results: FileHealthData[] = [];
        for (const [filePath, stats] of fileStats) {
            const churnScore = Math.min(100, Math.round((stats.commitCount / maxCommits) * 100));
            const breakFrequency = fileBreaks.get(filePath) || 0;
            const coupledFiles = Array.from(stats.coChanges.entries())
                .filter(([_, count]) => count >= 3)
                .sort((a, b) => b[1] - a[1])
                .map(([path]) => path);

            let riskLevel: 'stable' | 'volatile' | 'fragile' = 'stable';
            if (churnScore > 60 || breakFrequency >= 3) riskLevel = 'fragile';
            else if (churnScore >= 20) riskLevel = 'volatile';

            results.push({ filePath, churnScore, breakFrequency, lastModified: stats.lastModified, contributorCount: stats.authors.size, coupledFiles, riskLevel });
        }
        return results;
    }

    /** Full repo analysis: parse git log, compute health, store in DB */
    async analyzeRepo(): Promise<CodeDNA[]> {
        // Check git availability
        try {
            execSync('git --version', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        } catch {
            process.stderr.write('[atlasmemory] Warning: git not found — code health analysis skipped\n');
            return [];
        }

        let logOutput: string;
        try {
            logOutput = execSync(
                'git log --max-count=1000 --format="%H%x09%an%x09%aI" --name-only',
                { cwd: this.repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
            );
        } catch (e) {
            process.stderr.write('[atlasmemory] Warning: git log failed — not a git repository?\n');
            return [];
        }

        let messageOutput: string;
        try {
            messageOutput = execSync(
                'git log --max-count=1000 --format="%H%x09%s"',
                { cwd: this.repoPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
            );
        } catch (e) { messageOutput = ''; }

        const messageMap = new Map<string, string>();
        for (const line of messageOutput.split(/\r?\n/)) {
            const idx = line.indexOf('\t');
            if (idx > 0) messageMap.set(line.slice(0, idx), line.slice(idx + 1));
        }

        const commits = this.parseGitLog(logOutput);
        for (const commit of commits) commit.message = messageMap.get(commit.hash) || '';

        const healthData = this.computeHealth(commits);

        const files = this.store.getFiles();
        const pathToId = new Map(files.map(f => [f.path, f.id]));

        this.store.clearCodeHealth();

        const results: CodeDNA[] = [];
        for (const data of healthData) {
            const fileId = pathToId.get(data.filePath);
            if (!fileId) continue;
            const dna: CodeDNA = {
                fileId, churnScore: data.churnScore, breakFrequency: data.breakFrequency,
                lastModified: data.lastModified, contributorCount: data.contributorCount,
                coupledFiles: data.coupledFiles, riskLevel: data.riskLevel,
            };
            this.store.upsertCodeHealth({
                fileId, churnScore: data.churnScore, breakFrequency: data.breakFrequency,
                lastModified: data.lastModified, contributorCount: data.contributorCount,
                coupledFiles: data.coupledFiles, riskLevel: data.riskLevel,
            });
            results.push(dna);
        }
        return results;
    }

    getHealth(fileId: string): CodeDNA | null {
        return this.store.getCodeHealth(fileId);
    }

    getRiskySummary(): string {
        const allHealth = this.store.getAllCodeHealth();
        const risky = allHealth.filter(h => h.riskLevel === 'fragile' || h.riskLevel === 'volatile');
        if (risky.length === 0) return '';

        const fragile = risky.filter(h => h.riskLevel === 'fragile');
        const volatile = risky.filter(h => h.riskLevel === 'volatile');

        const lines: string[] = ['🧬 Code DNA Summary:'];
        if (fragile.length > 0) {
            lines.push(`  ⚠ ${fragile.length} FRAGILE files (high churn + frequent breaks)`);
            for (const f of fragile.slice(0, 3)) {
                const file = this.store.getFileById(f.fileId);
                if (file) lines.push(`    - ${file.path} (churn: ${f.churnScore}, breaks: ${f.breakFrequency})`);
            }
        }
        if (volatile.length > 0) {
            lines.push(`  📊 ${volatile.length} volatile files (high churn)`);
        }
        return lines.join('\n');
    }

    formatForResponse(fileId: string): string {
        const health = this.store.getCodeHealth(fileId);
        if (!health) return '';
        const file = this.store.getFileById(fileId);
        const name = file?.path || fileId;
        const risk = health.riskLevel.toUpperCase();
        const lines = [`🧬 ${name}: ${risk} (churn: ${health.churnScore}, breaks: ${health.breakFrequency}, contributors: ${health.contributorCount})`];
        if (health.coupledFiles.length > 0) {
            lines.push(`  Co-changes with: ${health.coupledFiles.slice(0, 5).join(', ')}`);
        }
        return lines.join('\n');
    }
}
