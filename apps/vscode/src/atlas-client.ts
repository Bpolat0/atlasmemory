import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface AtlasStatus {
    version: string;
    database: string;
    lastIndex: string | null;
    readiness: {
        overall: number;
        codeCoverage: number;
        descriptionCoverage: number;
        flowCoverage: number;
        evidenceCoverage: number;
    };
    stats: {
        files: number;
        symbols: number;
        anchors: number;
        fileCards: number;
        flowCards: number;
        imports: number;
        refs: number;
    };
    health: {
        status: string;
        hasFtsStemmer: boolean;
        issues: string[];
    };
}

export class AtlasClient {
    private workspaceRoot: string;
    private binaryPath: string | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    private findBinary(): string {
        if (this.binaryPath) return this.binaryPath;

        const config = vscode.workspace.getConfiguration('atlasmemory');
        const customPath = config.get<string>('binaryPath');
        if (customPath && fs.existsSync(customPath)) {
            this.binaryPath = customPath;
            return customPath;
        }

        // Try local dist (development)
        const distBin = path.join(this.workspaceRoot, 'dist', 'atlasmemory.js');
        if (fs.existsSync(distBin)) {
            this.binaryPath = distBin;
            return distBin;
        }

        // Try node_modules/.bin
        const localBin = path.join(this.workspaceRoot, 'node_modules', '.bin', 'atlasmemory');
        if (fs.existsSync(localBin)) {
            this.binaryPath = localBin;
            return localBin;
        }

        // Fall back to global
        this.binaryPath = 'atlasmemory';
        return 'atlasmemory';
    }

    private run(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const binary = this.findBinary();
            let cmd: string;
            let cmdArgs: string[];

            if (binary.endsWith('.js')) {
                cmd = process.execPath; // node
                cmdArgs = [binary, ...args];
            } else {
                cmd = binary;
                cmdArgs = args;
            }

            execFile(cmd, cmdArgs, {
                cwd: this.workspaceRoot,
                timeout: 60000,
                env: { ...process.env, FORCE_COLOR: '0' },
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    async getStatus(): Promise<AtlasStatus | null> {
        try {
            const output = await this.run(['status', '--json']);
            return JSON.parse(output);
        } catch {
            return null;
        }
    }

    async indexProject(): Promise<string> {
        return this.run(['index', '.']);
    }

    async indexFile(filePath: string): Promise<string> {
        // Use relative path for cleaner output
        const rel = path.relative(this.workspaceRoot, filePath);
        return this.run(['index', rel]);
    }

    async generate(format: string = 'all'): Promise<string> {
        return this.run(['generate', '--format', format]);
    }

    async doctor(): Promise<string> {
        return this.run(['doctor']);
    }

    async search(query: string): Promise<string> {
        return this.run(['search', query]);
    }

    hasDatabase(): boolean {
        return fs.existsSync(path.join(this.workspaceRoot, '.atlas', 'atlas.db'));
    }
}
