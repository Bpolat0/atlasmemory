import { Store } from '@atlasmemory/store';
import type { ImpactReport, DependentFile, CodeSymbol, ReverseRef } from '@atlasmemory/core';

export interface AnalyzeSymbolOpts {
    transitive?: boolean;
}

export class ImpactAnalyzer {
    constructor(private store: Store) {}

    analyzeSymbol(symbolId: string, opts?: AnalyzeSymbolOpts): ImpactReport {
        const symbol = this.store.getSymbol(symbolId);
        if (!symbol) return this.emptyReport(symbolId);

        const file = this.store.getFileById(symbol.fileId);
        if (!file) return this.emptyReport(symbolId);

        // Gather direct refs: resolved + by-name
        const directRefs = [
            ...this.store.getRefsTo(symbolId),
            ...this.store.getRefsByName(symbol.name),
        ];

        // Deduplicate refs by id
        const seenRefIds = new Set<string>();
        const uniqueRefs: ReverseRef[] = [];
        for (const ref of directRefs) {
            if (!seenRefIds.has(ref.id)) {
                seenRefIds.add(ref.id);
                uniqueRefs.push(ref);
            }
        }

        // Group by file, skip self-references
        const directDependents = this.groupRefsByFile(uniqueRefs, symbol.fileId);

        // Transitive (1-hop): for each direct dependent file, find its dependents
        let transitiveDependents: DependentFile[] = [];
        if (opts?.transitive) {
            const directFileIds = new Set(directDependents.map(d => d.fileId));
            directFileIds.add(symbol.fileId); // exclude source file
            const transitiveMap = new Map<string, DependentFile>();

            for (const dep of directDependents) {
                const secondHop = this.store.getDependentFiles(dep.fileId);
                for (const td of secondHop) {
                    if (!directFileIds.has(td.fileId) && !transitiveMap.has(td.fileId)) {
                        transitiveMap.set(td.fileId, td);
                    }
                }
            }
            transitiveDependents = Array.from(transitiveMap.values());
        }

        // Affected flows: find flows that mention this symbol
        const allFlows = this.store.getAllFlowCards();
        const affectedFlows = allFlows
            .filter(f =>
                f.rootSymbolId === symbolId ||
                f.trace.some(step => step.symbolId === symbolId || step.symbolName === symbol.name)
            )
            .map(f => ({ flowId: f.id, summary: f.summary }));

        // Find test files among dependents
        const affectedTests = directDependents
            .filter(d => this.isTestFile(d.filePath))
            .map(d => d.filePath);

        // Risk level based on total affected files
        const totalAffectedFiles = directDependents.length + transitiveDependents.length;
        const riskLevel = this.computeRiskLevel(totalAffectedFiles);

        // Count total affected symbols
        const totalAffectedSymbols = directDependents.reduce((sum, d) => sum + d.symbolCount, 0)
            + transitiveDependents.reduce((sum, d) => sum + d.symbolCount, 0);

        const recommendation = this.generateRecommendation(riskLevel, totalAffectedFiles, affectedTests.length, affectedFlows.length);

        return {
            targetSymbol: {
                id: symbol.id,
                name: symbol.name,
                filePath: file.path,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
            },
            directDependents,
            transitiveDependents,
            affectedFlows,
            affectedTests,
            riskLevel,
            totalAffectedFiles,
            totalAffectedSymbols,
            recommendation,
        };
    }

    analyzeFile(fileId: string): ImpactReport {
        const symbols = this.store.getSymbolsForFile(fileId);
        if (symbols.length === 0) {
            const file = this.store.getFileById(fileId);
            return {
                targetSymbol: { id: fileId, name: file?.path || fileId, filePath: file?.path || '', startLine: 0, endLine: 0 },
                directDependents: [],
                transitiveDependents: [],
                affectedFlows: [],
                affectedTests: [],
                riskLevel: 'low',
                totalAffectedFiles: 0,
                totalAffectedSymbols: 0,
                recommendation: 'No symbols found in this file.',
            };
        }

        // Analyze each symbol and merge
        const reports = symbols.map(s => this.analyzeSymbol(s.id));

        // Merge dependents (deduplicate by fileId)
        const directMap = new Map<string, DependentFile>();
        const transitiveMap = new Map<string, DependentFile>();
        const flowSet = new Map<string, { flowId: string; summary: string }>();
        const testSet = new Set<string>();

        for (const report of reports) {
            for (const dep of report.directDependents) {
                const existing = directMap.get(dep.fileId);
                if (existing) {
                    existing.refCount += dep.refCount;
                    existing.symbolCount = Math.max(existing.symbolCount, dep.symbolCount);
                    existing.riskLevel = this.fileDependentRisk(existing.refCount);
                } else {
                    directMap.set(dep.fileId, { ...dep });
                }
            }
            for (const dep of report.transitiveDependents) {
                if (!transitiveMap.has(dep.fileId)) {
                    transitiveMap.set(dep.fileId, dep);
                }
            }
            for (const flow of report.affectedFlows) {
                flowSet.set(flow.flowId, flow);
            }
            for (const test of report.affectedTests) {
                testSet.add(test);
            }
        }

        const directDependents = Array.from(directMap.values());
        const transitiveDependents = Array.from(transitiveMap.values());
        const affectedFlows = Array.from(flowSet.values());
        const affectedTests = Array.from(testSet);
        const totalAffectedFiles = directDependents.length + transitiveDependents.length;
        const riskLevel = this.computeRiskLevel(totalAffectedFiles);
        const totalAffectedSymbols = directDependents.reduce((sum, d) => sum + d.symbolCount, 0)
            + transitiveDependents.reduce((sum, d) => sum + d.symbolCount, 0);

        const file = this.store.getFileById(fileId);
        const recommendation = this.generateRecommendation(riskLevel, totalAffectedFiles, affectedTests.length, affectedFlows.length);

        return {
            targetSymbol: {
                id: fileId,
                name: file?.path || fileId,
                filePath: file?.path || '',
                startLine: 0,
                endLine: 0,
            },
            directDependents,
            transitiveDependents,
            affectedFlows,
            affectedTests,
            riskLevel,
            totalAffectedFiles,
            totalAffectedSymbols,
            recommendation,
        };
    }

    quickImpact(symbolName: string): { level: string; count: number; summary: string } {
        const symbols = this.store.findSymbolsByName(symbolName);
        if (symbols.length === 0) {
            return { level: 'low', count: 0, summary: `No symbol found named "${symbolName}"` };
        }

        // Aggregate refs across all matching symbols
        let totalFiles = 0;
        const fileIds = new Set<string>();

        for (const sym of symbols) {
            const refs = [
                ...this.store.getRefsTo(sym.id),
                ...this.store.getRefsByName(sym.name),
            ];
            for (const ref of refs) {
                if (ref.fromFileId !== sym.fileId) {
                    fileIds.add(ref.fromFileId);
                }
            }
        }

        totalFiles = fileIds.size;
        const level = this.computeRiskLevel(totalFiles);

        return {
            level,
            count: totalFiles,
            summary: `"${symbolName}" is referenced in ${totalFiles} file(s) — risk: ${level}`,
        };
    }

    formatReport(report: ImpactReport): string {
        const lines: string[] = [];

        lines.push(`# Impact Report: ${report.targetSymbol.name}`);
        lines.push('');
        lines.push(`**File:** \`${report.targetSymbol.filePath}\` (lines ${report.targetSymbol.startLine}-${report.targetSymbol.endLine})`);
        lines.push(`**Risk Level:** ${report.riskLevel.toUpperCase()}`);
        lines.push(`**Total Affected Files:** ${report.totalAffectedFiles}`);
        lines.push(`**Total Affected Symbols:** ${report.totalAffectedSymbols}`);
        lines.push('');

        if (report.directDependents.length > 0) {
            lines.push('## Direct Dependents');
            lines.push('');
            lines.push('| File | Refs | Symbols | Risk |');
            lines.push('|------|------|---------|------|');
            for (const dep of report.directDependents) {
                lines.push(`| \`${dep.filePath}\` | ${dep.refCount} | ${dep.symbolCount} | ${dep.riskLevel} |`);
            }
            lines.push('');
        }

        if (report.transitiveDependents.length > 0) {
            lines.push('## Transitive Dependents (1-hop)');
            lines.push('');
            lines.push('| File | Refs | Symbols | Risk |');
            lines.push('|------|------|---------|------|');
            for (const dep of report.transitiveDependents) {
                lines.push(`| \`${dep.filePath}\` | ${dep.refCount} | ${dep.symbolCount} | ${dep.riskLevel} |`);
            }
            lines.push('');
        }

        if (report.affectedFlows.length > 0) {
            lines.push('## Affected Flows');
            lines.push('');
            for (const flow of report.affectedFlows) {
                lines.push(`- **${flow.flowId}**: ${flow.summary}`);
            }
            lines.push('');
        }

        if (report.affectedTests.length > 0) {
            lines.push('## Affected Tests');
            lines.push('');
            for (const test of report.affectedTests) {
                lines.push(`- \`${test}\``);
            }
            lines.push('');
        }

        lines.push(`## Recommendation`);
        lines.push('');
        lines.push(report.recommendation);

        return lines.join('\n');
    }

    // --- Private helpers ---

    private emptyReport(symbolId: string): ImpactReport {
        return {
            targetSymbol: { id: symbolId, name: 'unknown', filePath: '', startLine: 0, endLine: 0 },
            directDependents: [],
            transitiveDependents: [],
            affectedFlows: [],
            affectedTests: [],
            riskLevel: 'low',
            totalAffectedFiles: 0,
            totalAffectedSymbols: 0,
            recommendation: `Symbol "${symbolId}" not found in the index.`,
        };
    }

    private groupRefsByFile(refs: ReverseRef[], excludeFileId: string): DependentFile[] {
        const fileMap = new Map<string, { refCount: number; symbolIds: Set<string> }>();

        for (const ref of refs) {
            if (ref.fromFileId === excludeFileId) continue;

            const entry = fileMap.get(ref.fromFileId);
            if (entry) {
                entry.refCount++;
                entry.symbolIds.add(ref.fromSymbolId);
            } else {
                fileMap.set(ref.fromFileId, { refCount: 1, symbolIds: new Set([ref.fromSymbolId]) });
            }
        }

        const result: DependentFile[] = [];
        for (const [fileId, data] of fileMap) {
            const file = this.store.getFileById(fileId);
            result.push({
                fileId,
                filePath: file?.path || fileId,
                symbolCount: data.symbolIds.size,
                refCount: data.refCount,
                riskLevel: this.fileDependentRisk(data.refCount),
            });
        }

        return result.sort((a, b) => b.refCount - a.refCount);
    }

    private fileDependentRisk(refCount: number): 'high' | 'medium' | 'low' {
        if (refCount > 5) return 'high';
        if (refCount > 2) return 'medium';
        return 'low';
    }

    private computeRiskLevel(totalFiles: number): 'critical' | 'high' | 'medium' | 'low' {
        if (totalFiles > 10) return 'critical';
        if (totalFiles > 5) return 'high';
        if (totalFiles > 2) return 'medium';
        return 'low';
    }

    private isTestFile(filePath: string): boolean {
        return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath)
            || /\/__tests__\//.test(filePath)
            || /\/test\//.test(filePath);
    }

    private generateRecommendation(
        riskLevel: string,
        totalFiles: number,
        testCount: number,
        flowCount: number,
    ): string {
        const parts: string[] = [];

        switch (riskLevel) {
            case 'critical':
                parts.push(`CRITICAL: This symbol affects ${totalFiles} files. Changes require careful review and staged rollout.`);
                break;
            case 'high':
                parts.push(`HIGH RISK: ${totalFiles} files depend on this symbol. Ensure thorough testing before changes.`);
                break;
            case 'medium':
                parts.push(`MEDIUM RISK: ${totalFiles} files reference this symbol. Review dependents before modifying.`);
                break;
            default:
                parts.push(`LOW RISK: Only ${totalFiles} file(s) affected. Safe to modify with basic testing.`);
        }

        if (testCount > 0) {
            parts.push(`${testCount} test file(s) cover this symbol.`);
        } else if (totalFiles > 0) {
            parts.push('No test files found for this symbol — consider adding tests before changes.');
        }

        if (flowCount > 0) {
            parts.push(`${flowCount} flow(s) involve this symbol — verify end-to-end behavior.`);
        }

        return parts.join(' ');
    }
}
