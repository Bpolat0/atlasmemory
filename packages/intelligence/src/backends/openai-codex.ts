// packages/intelligence/src/backends/openai-codex.ts
import { execSync, spawn } from 'child_process';
import type { EnrichmentBackend, EnrichmentInput, EnrichmentResult } from '../enrichment-backend.js';
import { buildBatchEnrichmentPrompt } from '../enrichment-prompt.js';

export class OpenAICodexBackend implements EnrichmentBackend {
    name = 'openai-codex';

    async isAvailable(): Promise<boolean> {
        try {
            execSync('codex --version', { timeout: 5000, stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    }

    async enrich(prompt: string, maxTokens: number): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            // codex -q runs in quiet/non-interactive mode, reads from stdin
            const child = spawn('codex', ['-q'], {
                timeout: 90000,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
            child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`codex CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
                } else if (!stdout.trim()) {
                    reject(new Error('codex CLI returned empty output'));
                } else {
                    resolve(stdout.trim());
                }
            });

            child.on('error', (err) => {
                reject(new Error(`codex CLI spawn error: ${err.message}`));
            });

            child.stdin.write(prompt);
            child.stdin.end();
        });
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
