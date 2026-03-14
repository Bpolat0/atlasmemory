// packages/intelligence/src/enrichment-prompt.ts

/**
 * Optimized prompt for AI-powered file card enrichment.
 * Designed for ~300 input tokens + ~200 output tokens per file.
 */
export function buildEnrichmentPrompt(params: {
    filePath: string;
    symbolSignatures: string[];
    importPaths: string[];
    codeSnippet: string;
}): string {
    const symbols = params.symbolSignatures.slice(0, 12).join('\n  ') || 'none';
    const imports = params.importPaths.slice(0, 10).join(', ') || 'none';

    return `Analyze this source file and return a JSON intent card.

File: ${params.filePath}
Exports:
  ${symbols}
Imports: ${imports}

Code (first 120 lines):
\`\`\`
${params.codeSnippet}
\`\`\`

Return ONLY valid JSON (no markdown, no explanation):
{
  "intent": "one-sentence: what this file does and WHY it exists",
  "solves": "what problem this code solves",
  "tags": ["10-15 semantic search terms: synonyms, concepts, use-cases"],
  "breaks_if_changed": ["file paths that would break if this file changes"],
  "security_notes": "security considerations or null",
  "complexity": "low|medium|high"
}

Example output for a database connection pool:
{
  "intent": "Manages PostgreSQL connection pooling to prevent connection exhaustion under load",
  "solves": "database connection lifecycle and reuse across concurrent requests",
  "tags": ["database", "connection pool", "postgres", "sql", "concurrency", "connection management", "db client", "query execution", "connection reuse", "database driver"],
  "breaks_if_changed": ["src/api/routes.ts", "src/services/user-service.ts"],
  "security_notes": "connection strings may contain credentials",
  "complexity": "medium"
}`;
}
