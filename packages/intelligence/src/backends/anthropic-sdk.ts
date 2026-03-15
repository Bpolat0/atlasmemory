// packages/intelligence/src/backends/anthropic-sdk.ts
import type { EnrichmentBackend, EnrichmentInput, EnrichmentResult } from '../enrichment-backend.js';
import { buildBatchEnrichmentPrompt } from '../enrichment-prompt.js';

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

export class AnthropicSdkBackend implements EnrichmentBackend {
    name = 'anthropic-sdk';
    private model: string;
    private client: any = null;

    constructor(model?: string) {
        this.model = model || 'claude-haiku-4-5-20251001';
    }

    async isAvailable(): Promise<boolean> {
        return !!process.env.ANTHROPIC_API_KEY;
    }

    private async getClient(): Promise<any> {
        if (this.client) return this.client;
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        this.client = new Anthropic();
        return this.client;
    }

    async enrich(prompt: string, maxTokens: number): Promise<string> {
        const client = await this.getClient();
        let lastError: any;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const msg = await client.messages.create({
                    model: this.model,
                    max_tokens: maxTokens,
                    messages: [{ role: 'user', content: prompt }],
                });
                const block = msg.content[0];
                return block.type === 'text' ? block.text : '';
            } catch (error: any) {
                lastError = error;
                const status = error?.status || error?.statusCode;
                if (status === 429 || status === 529) {
                    if (attempt < MAX_RETRIES) {
                        const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
                        process.stderr.write(`[atlasmemory] API rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...\n`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                throw error;
            }
        }
        throw lastError;
    }

    async enrichBatch(files: EnrichmentInput[], maxTokens: number): Promise<EnrichmentResult[]> {
        const prompt = buildBatchEnrichmentPrompt(files);
        const response = await this.enrich(prompt, maxTokens);
        const cleaned = response.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed) || parsed.length !== files.length) {
            throw new Error(`Expected ${files.length} results, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
        }
        return parsed.map((item: any) => ({
            intent: String(item.intent || ''),
            solves: String(item.solves || ''),
            tags: (item.tags || []).map(String).slice(0, 15),
            breaks_if_changed: (item.breaks_if_changed || []).map(String),
            security_notes: item.security_notes ? String(item.security_notes) : null,
            complexity: ['low', 'medium', 'high'].includes(item.complexity) ? item.complexity : 'medium',
        }));
    }
}
