export interface Anchor {
    id: string;
    fileId: string;
    startLine: number;
    endLine: number;
    snippetHash: string;
}

export type SymbolKind = 'function' | 'class' | 'method' | 'const' | 'type' | 'module' | 'endpoint';

export interface CodeSymbol {
    id: string;
    fileId: string;
    kind: SymbolKind;
    name: string;
    qualifiedName: string;
    signature: string;
    visibility: 'public' | 'internal' | 'protected' | 'private';
    startLine: number;
    endLine: number;
    signatureHash: string;
}

export interface Level1FileCard {
    purpose: string;
    publicApi: string[];
    sideEffects: string[];
    dependencies: string[];
    notes: string;
    evidenceAnchorIds: string[];
}

export interface Level1SymbolCard {
    summary: string;
    inputs: string[];
    outputs: string[];
    sideEffects: string[];
    evidenceAnchorIds: string[];
}

export interface Claim {
    text: string;
    evidenceIds: string[];
    status: 'PROVEN' | 'UNPROVEN';
    score?: number;
}

export type ContractReason =
    | 'DB_CHANGED'
    | 'GIT_HEAD_CHANGED'
    | 'NO_SNAPSHOT'
    | 'CONTRACT_MISMATCH'
    | 'COVERAGE_LOW';

export interface DbSignature {
    filesCount: number;
    symbolsCount: number;
    anchorsCount: number;
    refsCount: number;
    fileCardsCount: number;
    flowCardsCount: number;
    maxFilesUpdatedAt?: string;
    maxCardsUpdatedAt?: string;
    rollingHash?: string;
}

export interface ContextSnapshot {
    id: string;
    sessionId?: string;
    createdAt: string;
    repoId: string;
    gitHead?: string;
    dbSig: DbSignature;
    bootpackHash?: string;
    deltapackHash?: string;
    taskpackHash?: string;
    objective?: string;
    budgets?: { boot?: number; delta?: number; task?: number };
    proofMode?: 'strict' | 'warn' | 'off';
    minDbCoverage?: number;
    contractHash?: string;
}

export interface ContextContract {
    contractHash: string;
    isStale: boolean;
    shouldBlock: boolean;
    requiredBootstrap: boolean;
    reasons: ContractReason[];
    snapshot?: ContextSnapshot;
}

export interface EvidenceClaim {
    text: string;
    evidenceAnchorIds: string[];
}

export interface EnvDependencyClaim {
    name: string;
    source: 'process.env' | 'os.environ';
    evidenceAnchorIds: string[];
}

export interface Level2FileCard {
    flows: EvidenceClaim[];
    invariants: EvidenceClaim[];
    envDependencies: EnvDependencyClaim[];
}

export interface FlowTraceStep {
    symbolId?: string;
    symbolName: string;
    fileId: string;
    filePath: string;
    anchorId?: string;
}

export interface FlowCard {
    id: string;
    fileId: string;
    rootSymbolId?: string;
    flowKind: 'call_chain';
    hopCount: 1 | 2;
    summary: string;
    trace: FlowTraceStep[];
    evidenceAnchorIds: string[];
    updatedAt?: string;
}

export interface ProjectCard {
    id: string;
    purpose: string;
    architectureBullets: string[];
    invariants: string[];
    entrypoints: string[];
    keyFlowIds: string[];
    toolsProtocol: string[];
    glossary: Record<string, string>;
    cardHash: string;
    updatedAt?: string;
}

export interface FileCard {
    fileId: string;
    path: string;
    level0: {
        purpose: string;
        exports: string[];
        sideEffects: string[];
    };
    level1?: Level1FileCard;
    level2?: Level2FileCard;
    cardHash: string;
    qualityScore?: number;
    qualityFlags?: string[];
}

export interface SymbolCard {
    symbolId: string;
    level0: {
        signature: string;
        summary: string;
    };
    level1?: Level1SymbolCard;
}

export interface FolderCard {
    folderPath: string;
    level0: {
        purpose: string; // One line
        description: string; // 3-5 lines
    };
    level1?: {
        importantFiles: { path: string, purpose: string }[];
        exports: string[];
    };
    updatedAt: string;
}

export interface Import {
    id: string;
    fileId: string;
    importedModule: string;
    importedSymbol?: string;
    resolvedFileId?: string;
    isExternal: boolean;
}

export type RefKind = 'call' | 'import' | 'usage';

export interface CodeRef {
    id: string;
    fromSymbolId: string;
    toSymbolId?: string;
    toName: string;
    kind: RefKind;
    anchorId?: string;
}
