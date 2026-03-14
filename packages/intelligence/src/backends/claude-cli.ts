// packages/intelligence/src/backends/claude-cli.ts
import { execSync, spawn } from 'child_process';
import type { EnrichmentBackend } from '../enrichment-backend.js';

export class ClaudeCliBackend implements EnrichmentBackend {
    name = 'claude-cli';

    async isAvailable(): Promise<boolean> {
        try {
            execSync('claude --version', { timeout: 5000, stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    }

    async enrich(prompt: string, maxTokens: number): Promise<string> {
        // Pass prompt via stdin (-p - reads from stdin) to avoid
        // shell escaping issues and OS argument length limits
        return new Promise<string>((resolve, reject) => {
            const args = ['-p', '-', '--output-format', 'text', '--max-tokens', String(maxTokens)];
            const child = spawn('claude', args, {
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
                    reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
                } else if (!stdout.trim()) {
                    reject(new Error('claude CLI returned empty output'));
                } else {
                    resolve(stdout.trim());
                }
            });

            child.on('error', (err) => {
                reject(new Error(`claude CLI spawn error: ${err.message}`));
            });

            // Write prompt to stdin and close
            child.stdin.write(prompt);
            child.stdin.end();
        });
    }
}
