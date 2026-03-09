import type { FlowCard, CodeRef, CodeSymbol } from '@atlasmemory/core';
import { Store } from '@atlasmemory/store';
import crypto from 'crypto';

interface BuildOptions {
    maxFlows?: number;
}

export class FlowGenerator {
    constructor(private store: Store) {}

    buildFlowCardsForFile(fileId: string, options: BuildOptions = {}): FlowCard[] {
        const maxFlows = options.maxFlows ?? 8;
        const file = this.store.getFileById(fileId);
        if (!file) return [];

        const symbols = this.store.getSymbolsForFile(fileId);
        if (symbols.length === 0) return [];

        const importedFileIds = new Set(
            this.store
                .getImportsForFile(fileId)
                .filter(i => !!i.resolvedFileId)
                .map(i => i.resolvedFileId!)
        );

        const flows: FlowCard[] = [];
        const dedup = new Set<string>();

        const orderedSymbols = [...symbols].sort((a, b) => {
            if (a.visibility !== b.visibility) return a.visibility === 'public' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        for (const source of orderedSymbols) {
            const callRefs = this.store.getRefsFrom(source.id).filter(r => r.kind === 'call');
            for (const callRef of callRefs) {
                if (!callRef.anchorId || !this.store.getAnchor(callRef.anchorId)) continue;

                const target = this.resolveTarget(callRef, fileId, importedFileIds);
                if (!target) continue;

                const targetFile = this.store.getFileById(target.fileId);
                if (!targetFile) continue;

                const hop1Trace = [
                    {
                        symbolId: source.id,
                        symbolName: source.name,
                        fileId,
                        filePath: file.path
                    },
                    {
                        symbolId: target.id,
                        symbolName: target.name,
                        fileId: target.fileId,
                        filePath: targetFile.path,
                        anchorId: callRef.anchorId
                    }
                ];
                const hop1Summary = `${source.name} -> ${target.name}`;
                const hop1Key = `${fileId}:${source.id}:${target.id}`;

                if (!dedup.has(hop1Key)) {
                    flows.push({
                        id: crypto.randomUUID(),
                        fileId,
                        rootSymbolId: source.id,
                        flowKind: 'call_chain',
                        hopCount: 1,
                        summary: hop1Summary,
                        trace: hop1Trace,
                        evidenceAnchorIds: [callRef.anchorId]
                    });
                    dedup.add(hop1Key);
                    if (flows.length >= maxFlows) return flows;
                }

                const targetRefs = this.store.getRefsFrom(target.id).filter(r => r.kind === 'call');
                for (const secondRef of targetRefs) {
                    if (!secondRef.anchorId || !this.store.getAnchor(secondRef.anchorId)) continue;

                    const secondTarget = this.resolveTarget(secondRef, target.fileId, importedFileIds);
                    if (!secondTarget) continue;

                    // Prevent circular flows (A → B → A)
                    if (secondTarget.id === source.id) continue;

                    const secondFile = this.store.getFileById(secondTarget.fileId);
                    if (!secondFile) continue;

                    const hop2Summary = `${source.name} -> ${target.name} -> ${secondTarget.name}`;
                    const hop2Key = `${fileId}:${source.id}:${target.id}:${secondTarget.id}`;
                    if (dedup.has(hop2Key)) continue;

                    flows.push({
                        id: crypto.randomUUID(),
                        fileId,
                        rootSymbolId: source.id,
                        flowKind: 'call_chain',
                        hopCount: 2,
                        summary: hop2Summary,
                        trace: [
                            hop1Trace[0],
                            hop1Trace[1],
                            {
                                symbolId: secondTarget.id,
                                symbolName: secondTarget.name,
                                fileId: secondTarget.fileId,
                                filePath: secondFile.path,
                                anchorId: secondRef.anchorId
                            }
                        ],
                        evidenceAnchorIds: [callRef.anchorId, secondRef.anchorId]
                    });
                    dedup.add(hop2Key);

                    if (flows.length >= maxFlows) return flows;
                }
            }
        }

        return flows;
    }

    rebuildAndStoreForFile(fileId: string, options: BuildOptions = {}): FlowCard[] {
        const flowCards = this.buildFlowCardsForFile(fileId, options);
        this.store.deleteFlowCardsForFile(fileId);
        for (const flow of flowCards) {
            this.store.upsertFlowCard(flow);
        }
        return flowCards;
    }

    private resolveTarget(ref: CodeRef, currentFileId: string, importedFileIds: Set<string>): CodeSymbol | undefined {
        if (ref.toSymbolId) {
            const byId = this.store.getSymbol(ref.toSymbolId);
            if (byId) return byId;
        }

        if (!ref.toName) return undefined;

        const local = this.store.findSymbolsByName(ref.toName, currentFileId);
        if (local.length > 0) return local[0];

        for (const importedFileId of importedFileIds) {
            const importedMatch = this.store.findSymbolsByName(ref.toName, importedFileId);
            if (importedMatch.length > 0) return importedMatch[0];
        }

        const global = this.store.findSymbolsByName(ref.toName);
        if (global.length > 0) return global[0];

        return undefined;
    }
}
