// packages/intelligence/src/project-brief.ts
import type { Store } from '@atlasmemory/store';
import type { CodeHealthAnalyzer } from './code-health.js';
import type { SessionLearner } from './session-learner.js';
import type { EnrichmentCoordinator } from './enrichment-coordinator.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

/** Token-budgeted project brief for AI agent context */
export interface ProjectBrief {
    identity: string;
    architecture: string;
    recentChanges: string;
    riskMap: string;
    patterns: string;
    health: string;
}

export interface ProjectBriefOptions {
    rootDir: string;
    /** Max total tokens for the brief (default 900) */
    maxTokens?: number;
}

/** Estimate tokens from text length (same heuristic as BudgetTracker) */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/** Truncate text to fit within a token budget */
function truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 3) + '...';
}

function readPackageJson(rootDir: string): any {
    try {
        const pkgPath = path.join(rootDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        }
    } catch { /* ignore */ }
    return {};
}

function getRecentCommits(rootDir: string, count: number = 10): string[] {
    try {
        const output = execSync(`git log --oneline -${count}`, {
            cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
        });
        return output.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

export class ProjectBriefBuilder {
    constructor(
        private store: Store,
        private codeHealth: CodeHealthAnalyzer,
        private sessionLearner: SessionLearner,
        private enrichmentCoordinator: EnrichmentCoordinator,
    ) {}

    /** Build a complete project brief within token budget */
    buildBrief(options: ProjectBriefOptions): { brief: ProjectBrief; markdown: string; tokens: number } {
        const maxTokens = options.maxTokens || 900;
        const rootDir = options.rootDir;

        // Budget allocation per section
        const budgets = {
            identity: Math.round(maxTokens * 0.11),     // ~100
            architecture: Math.round(maxTokens * 0.28),  // ~250
            recentChanges: Math.round(maxTokens * 0.33), // ~300
            riskMap: Math.round(maxTokens * 0.11),       // ~100
            patterns: Math.round(maxTokens * 0.11),      // ~100
            health: Math.round(maxTokens * 0.06),        // ~50
        };

        const brief: ProjectBrief = {
            identity: truncateToTokens(this.buildIdentity(rootDir), budgets.identity),
            architecture: truncateToTokens(this.buildArchitecture(rootDir), budgets.architecture),
            recentChanges: truncateToTokens(this.buildRecentChanges(rootDir), budgets.recentChanges),
            riskMap: truncateToTokens(this.buildRiskMap(), budgets.riskMap),
            patterns: truncateToTokens(this.buildPatterns(), budgets.patterns),
            health: truncateToTokens(this.buildHealth(rootDir), budgets.health),
        };

        const markdown = this.renderMarkdown(brief);
        return { brief, markdown, tokens: estimateTokens(markdown) };
    }

    /** Build brief as JSON (for atlas brief --json) */
    buildBriefJson(options: ProjectBriefOptions): object {
        const { brief, tokens } = this.buildBrief(options);
        return { ...brief, tokens };
    }

    private buildIdentity(rootDir: string): string {
        const pkg = readPackageJson(rootDir);
        const files = this.store.getFiles();
        const totalSymbols = files.reduce((sum, f) => sum + this.store.getSymbolsForFile(f.id).length, 0);

        // Primary language
        const langCounts = new Map<string, number>();
        for (const file of files) {
            const ext = path.extname(file.path).toLowerCase();
            const lang = ext === '.ts' || ext === '.tsx' ? 'TypeScript'
                : ext === '.js' || ext === '.jsx' ? 'JavaScript'
                : ext === '.py' ? 'Python' : ext === '.go' ? 'Go'
                : ext === '.rs' ? 'Rust' : ext === '.java' ? 'Java'
                : ext === '.cs' ? 'C#' : '';
            if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
        }
        const primaryLang = Array.from(langCounts.entries())
            .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';

        const name = pkg.name || path.basename(rootDir);
        const desc = pkg.description || '';
        return `**${name}** — ${desc || 'No description'}\n${primaryLang} | ${files.length} files | ${totalSymbols} symbols`;
    }

    private buildArchitecture(rootDir: string): string {
        const files = this.store.getFiles();
        const dirCounts = new Map<string, number>();
        const dirFileIds = new Map<string, string[]>();

        for (const file of files) {
            const rel = path.relative(rootDir, file.path).replace(/\\/g, '/');
            if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
            const parts = rel.split('/');
            const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : (parts.length > 1 ? parts[0] : '.');
            dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
            if (!dirFileIds.has(dir)) dirFileIds.set(dir, []);
            dirFileIds.get(dir)!.push(file.id);
        }

        const topDirs = Array.from(dirCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [];
        for (const [dir, count] of topDirs) {
            const purpose = this.getDirPurpose(rootDir, dir, dirFileIds.get(dir) || []);
            lines.push(purpose ? `- \`${dir}/\` (${count}) — ${purpose}` : `- \`${dir}/\` (${count} files)`);
        }

        // Entry points — prefer src/main.ts or root-level entry files
        const entryFiles = files.filter(f => {
            const rel = path.relative(rootDir, f.path).replace(/\\/g, '/');
            const base = path.basename(f.path);
            const isEntry = base === 'main.ts' || base === 'main.js' || base === 'app.ts' || base === 'server.ts';
            const isShallow = rel.split('/').length <= 3;
            return isEntry && isShallow;
        }).slice(0, 3);

        if (entryFiles.length > 0) {
            lines.push('Entry: ' + entryFiles.map(f => `\`${path.relative(rootDir, f.path).replace(/\\/g, '/')}\``).join(', '));
        }

        return lines.join('\n');
    }

    /** Get a meaningful purpose for a directory. Priority: package.json desc > folder card > index file purpose */
    private getDirPurpose(rootDir: string, dir: string, fileIds: string[]): string {
        // 1. Check package.json in the directory
        const dirPkg = readPackageJson(path.join(rootDir, dir));
        if (dirPkg.description) {
            const desc = dirPkg.description;
            return desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
        }

        // 2. Check folder card
        const absDir = path.join(rootDir, dir);
        const folderCard = this.store.getFolderCard(absDir);
        if (folderCard?.level0?.purpose) {
            const purpose = folderCard.level0.purpose;
            return purpose.length > 80 ? purpose.slice(0, 77) + '...' : purpose;
        }

        // 3. Find most informative file's purpose
        // Skip barrel export files (index.ts with "Index module" descriptions)
        const GENERIC_PATTERNS = ['Index module', 'Main module', 'Re-export', 'Barrel export'];
        let bestPurpose = '';

        for (const fid of fileIds) {
            const card = this.store.getFileCard(fid);
            const purpose = card?.level1?.purpose || '';
            if (!purpose || purpose.includes('Auto-generated') || purpose.includes('Managed by')) continue;
            if (GENERIC_PATTERNS.some(p => purpose.startsWith(p))) continue;
            // Prefer longer, more descriptive purposes
            if (purpose.length > bestPurpose.length) {
                bestPurpose = purpose;
            }
        }

        if (bestPurpose) {
            return bestPurpose.length > 80 ? bestPurpose.slice(0, 77) + '...' : bestPurpose;
        }
        return '';
    }

    private buildRecentChanges(rootDir: string): string {
        const lines: string[] = [];

        // Git commits
        const commits = this.getRecentCommitsCached(rootDir, 10);
        if (commits.length > 0) {
            lines.push('**Git:**');
            for (const commit of commits) {
                lines.push(`- ${commit}`);
            }
        }

        // Agent decisions
        const since = new Date();
        since.setDate(since.getDate() - 14); // Last 14 days
        const decisions = this.store.getRecentChanges(since, 5);
        if (decisions.length > 0) {
            lines.push('**AI Decisions:**');
            for (const d of decisions) {
                const typeIcon = d.changeType === 'fix' ? '[FIX]' : d.changeType === 'feature' ? '[FEAT]' : '[REFACTOR]';
                lines.push(`- ${typeIcon} ${d.summary}${d.why ? ' — ' + d.why : ''}`);
            }
        }

        return lines.join('\n');
    }

    private buildRiskMap(): string {
        const allHealth = this.store.getAllCodeHealth();
        const fragile = allHealth.filter(h => h.riskLevel === 'fragile');
        const volatile = allHealth.filter(h => h.riskLevel === 'volatile');

        if (fragile.length === 0 && volatile.length === 0) {
            return 'No fragile or volatile files detected.';
        }

        const lines: string[] = [];
        if (fragile.length > 0) {
            lines.push(`**Fragile** (${fragile.length}):`);
            for (const f of fragile.slice(0, 3)) {
                const file = this.store.getFileById(f.fileId);
                if (file) {
                    const name = path.basename(file.path);
                    lines.push(`- ${name} (churn: ${f.churnScore}, breaks: ${f.breakFrequency})`);
                }
            }
        }
        if (volatile.length > 0) {
            lines.push(`**Volatile** (${volatile.length}):`);
            for (const v of volatile.slice(0, 3)) {
                const file = this.store.getFileById(v.fileId);
                if (file) {
                    const name = path.basename(file.path);
                    lines.push(`- ${name} (churn: ${v.churnScore})`);
                }
            }
        }

        return lines.join('\n');
    }

    private buildPatterns(): string {
        const hotPaths = this.sessionLearner.getHotPaths(5);
        if (hotPaths.length === 0) return 'No learned patterns yet.';

        const lines: string[] = [];
        for (const p of hotPaths) {
            const objective = p.patternData.objective as string;
            const fileIds = p.patternData.fileIds as string[];
            const label = objective || fileIds.join(' + ');
            lines.push(`- ${label} (${p.frequency}x)`);
        }
        return lines.join('\n');
    }

    private buildHealth(rootDir: string): string {
        const coverage = this.enrichmentCoordinator.getEnrichmentCoverage();
        const files = this.store.getFiles();

        // Count cards with descriptions
        let describedCards = 0;
        for (const f of files) {
            const card = this.store.getFileCard(f.id);
            if (card?.level1?.purpose && !card.level1.purpose.includes('Auto-generated')) {
                describedCards++;
            }
        }

        const parts: string[] = [];
        parts.push(`Files: ${files.length}`);
        parts.push(`Enriched: ${coverage.enriched}/${coverage.total} (${coverage.percentage}%)`);
        parts.push(`Described: ${describedCards}/${files.length}`);

        return parts.join(' | ');
    }

    /** Cache git log in session_state with 5-minute TTL */
    private getRecentCommitsCached(rootDir: string, count: number): string[] {
        try {
            const cached = this.store.getState('cached_recent_commits');
            const cachedAt = this.store.getState('cached_recent_commits_at');

            if (cached && cachedAt) {
                const age = Date.now() - new Date(cachedAt).getTime();
                if (age < 5 * 60 * 1000) return JSON.parse(cached);
            }
        } catch { /* cache miss, regenerate */ }

        const commits = getRecentCommits(rootDir, count);
        try {
            this.store.setState('cached_recent_commits', JSON.stringify(commits));
            this.store.setState('cached_recent_commits_at', new Date().toISOString());
        } catch { /* best-effort cache write */ }
        return commits;
    }

    private renderMarkdown(brief: ProjectBrief): string {
        const sections: string[] = [
            '## Project Brief',
            '',
            brief.identity,
            '',
            '### Architecture',
            brief.architecture,
            '',
            '### Recent Changes',
            brief.recentChanges,
            '',
            '### Risk Map',
            brief.riskMap,
            '',
            '### Patterns',
            brief.patterns,
            '',
            '### Health',
            brief.health,
        ];

        return sections.join('\n');
    }
}
