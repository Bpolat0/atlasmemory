// packages/intelligence/src/backends/anthropic-sdk.ts
import type { EnrichmentBackend } from '../enrichment-backend.js';

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
        // Dynamic import — only loaded when actually used
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        this.client = new Anthropic();
        return this.client;
    }

    async enrich(prompt: string, maxTokens: number): Promise<string> {
        const client = await this.getClient();
        const msg = await client.messages.create({
            model: this.model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
        });
        const block = msg.content[0];
        return block.type === 'text' ? block.text : '';
    }
}
