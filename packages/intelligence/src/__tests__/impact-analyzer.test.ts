import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '@atlasmemory/store';
import { ImpactAnalyzer } from '../impact-analyzer.js';
import crypto from 'crypto';

function uid() { return crypto.randomUUID(); }
function hash(s: string) { return crypto.createHash('sha256').update(s).digest('hex'); }

describe('ImpactAnalyzer', () => {
    let store: Store;
    let analyzer: ImpactAnalyzer;

    beforeEach(() => {
        store = new Store(':memory:');
        analyzer = new ImpactAnalyzer(store);
    });

    describe('analyzeSymbol', () => {
        it('should return empty report for nonexistent symbol', () => {
            const report = analyzer.analyzeSymbol('nonexistent');
            expect(report.riskLevel).toBe('low');
            expect(report.directDependents).toHaveLength(0);
            expect(report.totalAffectedFiles).toBe(0);
            expect(report.recommendation).toContain('not found');
        });

        it('should detect direct dependents via reverse refs', () => {
            // File A has symbol X, File B references X
            const fileAId = store.addFile('src/a.ts', 'typescript', 'h1', 10, '');
            const fileBId = store.addFile('src/b.ts', 'typescript', 'h2', 10, '');

            const symXId = uid();
            store.addSymbol({
                id: symXId, fileId: fileAId, name: 'doWork',
                qualifiedName: 'doWork', kind: 'function', signature: 'function doWork()',
                startLine: 1, endLine: 5, visibility: 'public',
                signatureHash: hash('function doWork()'),
            });
            const symBId = uid();
            store.addSymbol({
                id: symBId, fileId: fileBId, name: 'caller',
                qualifiedName: 'caller', kind: 'function', signature: 'function caller()',
                startLine: 1, endLine: 5, visibility: 'public',
                signatureHash: hash('function caller()'),
            });

            // B references X via resolved ref
            store.addRef({
                id: uid(), fromSymbolId: symBId, toSymbolId: symXId,
                toName: 'doWork', kind: 'call',
            });
            store.buildReverseRefs();

            const report = analyzer.analyzeSymbol(symXId);
            expect(report.directDependents).toHaveLength(1);
            expect(report.directDependents[0].fileId).toBe(fileBId);
            expect(report.directDependents[0].filePath).toBe('src/b.ts');
            expect(report.riskLevel).toBe('low');
            expect(report.totalAffectedFiles).toBe(1);
        });

        it('should compute risk levels correctly', () => {
            // Create source file with a symbol
            const srcId = store.addFile('src/core.ts', 'typescript', 'h0', 10, '');
            const symId = uid();
            store.addSymbol({
                id: symId, fileId: srcId, name: 'CoreFn',
                qualifiedName: 'CoreFn', kind: 'function', signature: 'function CoreFn()',
                startLine: 1, endLine: 5, visibility: 'public',
                signatureHash: hash('function CoreFn()'),
            });

            // Create many dependent files (>10 for critical)
            for (let i = 0; i < 12; i++) {
                const fId = store.addFile(`src/dep${i}.ts`, 'typescript', `dep${i}`, 10, '');
                const sId = uid();
                store.addSymbol({
                    id: sId, fileId: fId, name: `dep${i}`,
                    qualifiedName: `dep${i}`, kind: 'function', signature: `function dep${i}()`,
                    startLine: 1, endLine: 5, visibility: 'public',
                    signatureHash: hash(`function dep${i}()`),
                });
                store.addRef({
                    id: uid(), fromSymbolId: sId, toSymbolId: symId,
                    toName: 'CoreFn', kind: 'call',
                });
            }
            store.buildReverseRefs();

            const report = analyzer.analyzeSymbol(symId);
            expect(report.riskLevel).toBe('critical');
            expect(report.totalAffectedFiles).toBe(12);
        });

        it('should detect test files among dependents', () => {
            const srcId = store.addFile('src/utils.ts', 'typescript', 'h1', 10, '');
            const testId = store.addFile('src/__tests__/utils.test.ts', 'typescript', 'h2', 10, '');

            const symId = uid();
            store.addSymbol({
                id: symId, fileId: srcId, name: 'helper',
                qualifiedName: 'helper', kind: 'function', signature: 'function helper()',
                startLine: 1, endLine: 5, visibility: 'public',
                signatureHash: hash('function helper()'),
            });
            const testSymId = uid();
            store.addSymbol({
                id: testSymId, fileId: testId, name: 'testHelper',
                qualifiedName: 'testHelper', kind: 'function', signature: 'function testHelper()',
                startLine: 1, endLine: 5, visibility: 'public',
                signatureHash: hash('function testHelper()'),
            });
            store.addRef({
                id: uid(), fromSymbolId: testSymId, toSymbolId: symId,
                toName: 'helper', kind: 'call',
            });
            store.buildReverseRefs();

            const report = analyzer.analyzeSymbol(symId);
            expect(report.affectedTests).toContain('src/__tests__/utils.test.ts');
        });

        it('should exclude self-references', () => {
            const fileId = store.addFile('src/a.ts', 'typescript', 'h1', 10, '');
            const sym1Id = uid();
            const sym2Id = uid();
            store.addSymbol({
                id: sym1Id, fileId, name: 'fnA',
                qualifiedName: 'fnA', kind: 'function', signature: 'function fnA()',
                startLine: 1, endLine: 5, visibility: 'public',
                signatureHash: hash('function fnA()'),
            });
            store.addSymbol({
                id: sym2Id, fileId, name: 'fnB',
                qualifiedName: 'fnB', kind: 'function', signature: 'function fnB()',
                startLine: 6, endLine: 10, visibility: 'public',
                signatureHash: hash('function fnB()'),
            });
            // Self-file reference
            store.addRef({
                id: uid(), fromSymbolId: sym2Id, toSymbolId: sym1Id,
                toName: 'fnA', kind: 'call',
            });
            store.buildReverseRefs();

            const report = analyzer.analyzeSymbol(sym1Id);
            expect(report.directDependents).toHaveLength(0);
        });

        it('should handle transitive dependents', () => {
            const fileA = store.addFile('src/a.ts', 'typescript', 'h1', 10, '');
            const fileB = store.addFile('src/b.ts', 'typescript', 'h2', 10, '');
            const fileC = store.addFile('src/c.ts', 'typescript', 'h3', 10, '');

            const symA = uid(), symB = uid(), symC = uid();
            store.addSymbol({
                id: symA, fileId: fileA, name: 'fnA', qualifiedName: 'fnA',
                kind: 'function', signature: 'function fnA()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('function fnA()'),
            });
            store.addSymbol({
                id: symB, fileId: fileB, name: 'fnB', qualifiedName: 'fnB',
                kind: 'function', signature: 'function fnB()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('function fnB()'),
            });
            store.addSymbol({
                id: symC, fileId: fileC, name: 'fnC', qualifiedName: 'fnC',
                kind: 'function', signature: 'function fnC()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('function fnC()'),
            });

            // B -> A, C -> B (chain: A <- B <- C)
            store.addRef({ id: uid(), fromSymbolId: symB, toSymbolId: symA, toName: 'fnA', kind: 'call' });
            store.addRef({ id: uid(), fromSymbolId: symC, toSymbolId: symB, toName: 'fnB', kind: 'call' });
            store.buildReverseRefs();

            const report = analyzer.analyzeSymbol(symA, { transitive: true });
            expect(report.directDependents).toHaveLength(1);
            expect(report.transitiveDependents).toHaveLength(1);
            expect(report.transitiveDependents[0].fileId).toBe(fileC);
        });
    });

    describe('analyzeFile', () => {
        it('should return low risk for file with no symbols', () => {
            const fileId = store.addFile('src/empty.ts', 'typescript', 'h1', 10, '');
            const report = analyzer.analyzeFile(fileId);
            expect(report.riskLevel).toBe('low');
            expect(report.recommendation).toContain('No symbols found');
        });

        it('should merge reports from multiple symbols', () => {
            const fileA = store.addFile('src/a.ts', 'typescript', 'h1', 20, '');
            const fileB = store.addFile('src/b.ts', 'typescript', 'h2', 10, '');

            const sym1 = uid(), sym2 = uid(), symB = uid();
            store.addSymbol({
                id: sym1, fileId: fileA, name: 'fn1', qualifiedName: 'fn1',
                kind: 'function', signature: 'function fn1()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('fn1'),
            });
            store.addSymbol({
                id: sym2, fileId: fileA, name: 'fn2', qualifiedName: 'fn2',
                kind: 'function', signature: 'function fn2()', startLine: 6, endLine: 10,
                visibility: 'public', signatureHash: hash('fn2'),
            });
            store.addSymbol({
                id: symB, fileId: fileB, name: 'caller', qualifiedName: 'caller',
                kind: 'function', signature: 'function caller()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('caller'),
            });
            // B -> fn1, B -> fn2
            store.addRef({ id: uid(), fromSymbolId: symB, toSymbolId: sym1, toName: 'fn1', kind: 'call' });
            store.addRef({ id: uid(), fromSymbolId: symB, toSymbolId: sym2, toName: 'fn2', kind: 'call' });
            store.buildReverseRefs();

            const report = analyzer.analyzeFile(fileA);
            expect(report.directDependents).toHaveLength(1);
            // Merged ref count
            expect(report.directDependents[0].refCount).toBe(2);
        });
    });

    describe('quickImpact', () => {
        it('should return low for unknown symbol name', () => {
            const result = analyzer.quickImpact('nonexistent');
            expect(result.level).toBe('low');
            expect(result.count).toBe(0);
        });

        it('should count referencing files', () => {
            const fileA = store.addFile('src/a.ts', 'typescript', 'h1', 10, '');
            const fileB = store.addFile('src/b.ts', 'typescript', 'h2', 10, '');
            const symA = uid(), symB = uid();

            store.addSymbol({
                id: symA, fileId: fileA, name: 'target', qualifiedName: 'target',
                kind: 'function', signature: 'function target()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('target'),
            });
            store.addSymbol({
                id: symB, fileId: fileB, name: 'user', qualifiedName: 'user',
                kind: 'function', signature: 'function user()', startLine: 1, endLine: 5,
                visibility: 'public', signatureHash: hash('user'),
            });
            store.addRef({ id: uid(), fromSymbolId: symB, toSymbolId: symA, toName: 'target', kind: 'call' });
            store.buildReverseRefs();

            const result = analyzer.quickImpact('target');
            expect(result.count).toBe(1);
            expect(result.summary).toContain('1 file(s)');
        });
    });

    describe('formatReport', () => {
        it('should produce markdown with all sections', () => {
            const report = {
                targetSymbol: { id: '1', name: 'doStuff', filePath: 'src/core.ts', startLine: 10, endLine: 20 },
                directDependents: [{
                    fileId: '2', filePath: 'src/b.ts', symbolCount: 1, refCount: 3, riskLevel: 'medium' as const,
                }],
                transitiveDependents: [],
                affectedFlows: [{ flowId: 'flow1', summary: 'Main flow' }],
                affectedTests: ['src/__tests__/core.test.ts'],
                riskLevel: 'medium' as const,
                totalAffectedFiles: 1,
                totalAffectedSymbols: 1,
                recommendation: 'Review dependents.',
            };
            const md = analyzer.formatReport(report);
            expect(md).toContain('# Impact Report: doStuff');
            expect(md).toContain('MEDIUM');
            expect(md).toContain('src/b.ts');
            expect(md).toContain('Main flow');
            expect(md).toContain('core.test.ts');
        });
    });
});