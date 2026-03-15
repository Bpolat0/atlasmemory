// packages/intelligence/src/enrichment-backend.ts

export interface EnrichmentInput {
    filePath: string;
    symbolSignatures: string[];
    importPaths: string[];
    codeSnippet: string;
}

export interface EnrichmentResult {
    intent: string;
    solves: string;
    tags: string[];
    breaks_if_changed: string[];
    security_notes: string | null;
    complexity: 'low' | 'medium' | 'high';
}

export interface EnrichmentBackend {
    /** Human-readable backend name for logging */
    name: string;

    /** Check if this backend is available (CLI installed? API key set?) */
    isAvailable(): Promise<boolean>;

    /** Send a prompt to the LLM and return the response text */
    enrich(prompt: string, maxTokens: number): Promise<string>;

    /** Optional: batch-enrich multiple files in a single call */
    enrichBatch?(files: EnrichmentInput[], maxTokens: number): Promise<EnrichmentResult[]>;
}
