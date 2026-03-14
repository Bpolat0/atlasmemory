// packages/intelligence/src/enrichment-backend.ts

export interface EnrichmentBackend {
    /** Human-readable backend name for logging */
    name: string;

    /** Check if this backend is available (CLI installed? API key set?) */
    isAvailable(): Promise<boolean>;

    /** Send a prompt to the LLM and return the response text */
    enrich(prompt: string, maxTokens: number): Promise<string>;
}
