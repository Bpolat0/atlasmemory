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
    level3?: Level3FileCard;  // NEW
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

// ============================================================
// Phase 19: Intelligence Layer Types
// ============================================================

export interface ReverseRef {
    id: string;
    toSymbolId: string;
    fromSymbolId: string;
    fromFileId: string;
    refKind: string;
    anchorId?: string;
}

export interface DependentFile {
    fileId: string;
    filePath: string;
    symbolCount: number;
    refCount: number;
    riskLevel: 'high' | 'medium' | 'low';
}

export type EventType = 'search' | 'context_build' | 'file_access' | 'constraint' | 'decision' | 'impact_check';

export interface ConversationEvent {
    id: string;
    sessionId: string;
    eventType: EventType;
    eventData: Record<string, unknown>;
    createdAt: string;
}

export type PatternType = 'file_cooccurrence' | 'query_to_files' | 'hot_path' | 'search_refinement';

export interface SessionPattern {
    id: string;
    patternType: PatternType;
    patternKey: string;
    patternData: Record<string, unknown>;
    frequency: number;
    confidence: number;
    lastSeen: string;
}

export interface TokenUsageSummary {
    sessionId: string;
    totalTokens: number;
    byTool: Record<string, number>;
    entries: Array<{ tool: string; tokens: number; timestamp: string }>;
}

export interface ImpactReport {
    targetSymbol: { id: string; name: string; filePath: string; startLine: number; endLine: number };
    directDependents: DependentFile[];
    transitiveDependents: DependentFile[];
    affectedFlows: Array<{ flowId: string; summary: string }>;
    affectedTests: string[];
    riskLevel: 'critical' | 'high' | 'medium' | 'low';
    totalAffectedFiles: number;
    totalAffectedSymbols: number;
    recommendation: string;
}

export interface PrefetchSuggestion {
    fileId: string;
    filePath: string;
    reason: 'graph_neighbor' | 'cooccurrence_pattern' | 'query_pattern' | 'hot_path';
    confidence: number;
    previewSummary?: string;
}

export interface SymbolChange {
    symbolName: string;
    changeKind: 'added' | 'removed' | 'signature_changed' | 'body_changed';
    oldSignature?: string;
    newSignature?: string;
    breakingChange: boolean;
    dependentCount: number;
}

export interface SmartDiff {
    filePath: string;
    changeType: 'added' | 'modified' | 'deleted';
    symbolChanges: SymbolChange[];
    impactSummary: { affectedFiles: number; breakingChanges: number };
    staleAnchors: Array<{ anchorId: string; oldHash: string }>;
    affectedFlows: Array<{ flowId: string; summary: string }>;
    testCoverage: { hasTests: boolean; testFiles: string[] };
}

export interface TokenBudgetReport {
    sessionId: string;
    totalUsed: number;
    budgetLimit: number;
    percentUsed: number;
    byTool: Record<string, number>;
    recommendation: string;
    trend: 'increasing' | 'stable' | 'decreasing';
}

export interface ConversationContext {
    sessionId: string;
    activeConstraints: Array<{ text: string; createdAt: string }>;
    recentDecisions: Array<{ text: string; relatedFiles: string[] }>;
    currentObjective?: string;
    filesAccessed: string[];
    searchHistory: Array<{ query: string; resultCount: number }>;
    tokenBudget?: TokenBudgetReport;
}

// ============================================================
// Phase 20: Collaborative Intelligence Types
// ============================================================

export interface SamplingClient {
    canSample(): boolean;
    requestCompletion(prompt: string, maxTokens: number): Promise<string>;
}

export interface Level3FileCard {
    intent: string;
    solves: string;
    tags: string[];
    breaks_if_changed: string[];
    security_notes: string | null;
    complexity: 'low' | 'medium' | 'high';
}

export interface CodeDNA {
    fileId: string;
    churnScore: number;
    breakFrequency: number;
    lastModified: string;
    contributorCount: number;
    coupledFiles: string[];
    riskLevel: 'stable' | 'volatile' | 'fragile';
}

export interface ProactiveIntelligence {
    warnings?: string[];
    suggestions?: string[];
    impact?: string;
    enrichment_pending?: number;
    code_health?: string;
}

// ============================================================
// Phase 21: Agent Change Memory Types
// ============================================================

export interface AgentChange {
    id: string;
    filePaths: string[];
    summary: string;
    why: string;
    changeType: 'fix' | 'feature' | 'refactor';
    agentId?: string;
    createdAt: string;
}
