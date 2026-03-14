// packages/intelligence/src/backends/anthropic-sdk.ts
import type { EnrichmentBackend } from '../enrichment-backend.js';

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
}
