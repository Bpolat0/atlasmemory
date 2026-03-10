import { Store } from '@atlasmemory/store';
import { ImpactAnalyzer } from './impact-analyzer.js';
import type { SmartDiff, SymbolChange } from '@atlasmemory/core';
import { execSync } from 'child_process';
import path from 'path';

export class DiffEnricher {
    private analyzer: ImpactAnalyzer;

    constructor(private store: Store) {
        this.analyzer = new ImpactAnalyzer(store);
    }

    enrichGitDiff(sinceRef?: string): SmartDiff[] {
        const ref = sinceRef || 'HEAD';

        let output: string;
        try {
            output = execSync(`git diff --name-status ${ref}`, {
                encoding: 'utf-8',
                timeout: 10000,
            }).trim();

            // If ref is HEAD and no output, try staged changes
            if (ref === 'HEAD' && !output) {
                output = execSync('git diff --name-status --cached', {
                    encoding: 'utf-8',
                    timeout: 10000,
                }).trim();
            }
        } catch {
            return [];
        }

        if (!output) return [];

        const lines = output.split('\n').filter(l => l.trim());
        const diffs: SmartDiff[] = [];

        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length < 2) continue;

            const statusChar = parts[0].trim().charAt(0);
            const filePath = parts[parts.length - 1].trim();
            const absolutePath = path.resolve(filePath);

            let changeType: 'added' | 'modified' | 'deleted';
            switch (statusChar) {
                case 'A': changeType = 'added'; break;
                case 'D': changeType = 'deleted'; break;
                case 'M': changeType = 'modified'; break;
                default: changeType = 'modified'; break;
            }

            // For added files or unknown status, return basic SmartDiff
            if (changeType === 'added') {
                diffs.push({
                    filePath: absolutePath,
                    changeType,
                    symbolChanges: [],
                    impactSummary: { affectedFiles: 0, breakingChanges: 0 },
                    staleAnchors: [],
                    affectedFlows: [],
                    testCoverage: { hasTests: false, testFiles: [] },
                });
                continue;
            }

            // For modified/deleted: enrich with store data
            const fileId = this.store.getFileId(absolutePath);
            if (!fileId) {
                diffs.push({
                    filePath: absolutePath,
                    changeType,
                    symbolChanges: [],
                    impactSummary: { affectedFiles: 0, breakingChanges: 0 },
                    staleAnchors: [],
                    affectedFlows: [],
                    testCoverage: { hasTests: false, testFiles: [] },
                });
                continue;
            }

            // Get symbols and run quick impact for each
            const symbols = this.store.getSymbolsForFile(fileId);
            const symbolChanges: SymbolChange[] = [];
            let totalAffectedFiles = 0;
            let breakingCount = 0;

            for (const sym of symbols) {
                const impact = this.analyzer.quickImpact(sym.name);
                const isBreaking = changeType === 'deleted' || impact.level === 'critical' || impact.level === 'high';

                symbolChanges.push({
                    symbolName: sym.name,
                    changeKind: changeType === 'deleted' ? 'removed' : 'body_changed',
                    breakingChange: isBreaking,
                    dependentCount: impact.count,
                });

                totalAffectedFiles += impact.count;
                if (isBreaking) breakingCount++;
            }

            // Collect stale anchors
            const anchors = this.store.getAnchorsForFile(fileId);
            const staleAnchors = anchors.map(a => ({
                anchorId: a.id,
                oldHash: a.snippetHash,
            }));

            // Affected flows
            const flowCards = this.store.getFlowCardsForFile(fileId);
            const affectedFlows = flowCards.map(f => ({
                flowId: f.id,
                summary: f.summary,
            }));

            // Test coverage from dependent files
            const dependents = this.store.getDependentFiles(fileId);
            const testFiles = dependents
                .filter(d => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(d.filePath) ||
                    /\/__tests__\//.test(d.filePath) ||
                    /\/test\//.test(d.filePath))
                .map(d => d.filePath);

            diffs.push({
                filePath: absolutePath,
                changeType,
                symbolChanges,
                impactSummary: { affectedFiles: totalAffectedFiles, breakingChanges: breakingCount },
                staleAnchors,
                affectedFlows,
                testCoverage: { hasTests: testFiles.length > 0, testFiles },
            });
        }

        return diffs;
    }

    summarizeChanges(diffs: SmartDiff[]): string {
        const fileCount = diffs.length;
        const breakingCount = diffs.reduce((sum, d) => sum + d.impactSummary.breakingChanges, 0);
        const dependentCount = diffs.reduce((sum, d) => sum + d.impactSummary.affectedFiles, 0);
        const testCount = diffs.reduce((sum, d) => sum + d.testCoverage.testFiles.length, 0);

        return `**${fileCount} files changed | ${breakingCount} breaking changes | ${dependentCount} dependent files | ${testCount} tests to review**`;
    }

    formatDiffs(diffs: SmartDiff[]): string {
        const lines: string[] = [];

        lines.push('## Smart Diff Summary');
        lines.push('');
        lines.push(this.summarizeChanges(diffs));
        lines.push('');

        for (const diff of diffs) {
            const emoji = diff.changeType === 'added' ? '\u{1F7E2}' :
                diff.changeType === 'modified' ? '\u{1F7E1}' : '\u{1F534}';

            lines.push(`### ${emoji} \`${diff.filePath}\` (${diff.changeType})`);
            lines.push('');

            if (diff.symbolChanges.length > 0) {
                lines.push('| Symbol | Change | Breaking | Dependents |');
                lines.push('|--------|--------|----------|------------|');
                for (const sc of diff.symbolChanges) {
                    const breakingMark = sc.breakingChange ? 'YES' : 'no';
                    lines.push(`| \`${sc.symbolName}\` | ${sc.changeKind} | ${breakingMark} | ${sc.dependentCount} |`);
                }
                lines.push('');
            }

            if (diff.affectedFlows.length > 0) {
                lines.push('**Affected Flows:**');
                for (const flow of diff.affectedFlows) {
                    lines.push(`- ${flow.flowId}: ${flow.summary}`);
                }
                lines.push('');
            }

            if (diff.testCoverage.hasTests) {
                lines.push('**Test Coverage:**');
                for (const t of diff.testCoverage.testFiles) {
                    lines.push(`- \`${t}\``);
                }
                lines.push('');
            } else if (diff.changeType !== 'added') {
                lines.push('**Test Coverage:** None');
                lines.push('');
            }
        }

        return lines.join('\n');
    }

    getBreakingChanges(diffs: SmartDiff[]): SymbolChange[] {
        const breaking: SymbolChange[] = [];
        for (const diff of diffs) {
            for (const sc of diff.symbolChanges) {
                if (sc.breakingChange) {
                    breaking.push(sc);
                }
            }
        }
        return breaking;
    }
}
