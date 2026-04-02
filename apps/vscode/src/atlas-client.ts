import * as vscode from 'vscode';
import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

function findNodeBinary(): string {
    // process.execPath in VS Code returns Electron, not Node.js
    // We need to find the real system Node.js
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';
    try {
        const result = execFileSync(cmd, ['node'], { encoding: 'utf-8', timeout: 5000 });
        const nodePath = result.trim().split('\n')[0].trim();
        if (nodePath && fs.existsSync(nodePath)) return nodePath;
    } catch { }
    // Fallback: common paths
    const candidates = isWindows
        ? ['C:\\Program Files\\nodejs\\node.exe', path.join(process.env.LOCALAPPDATA || '', 'fnm_multishells', 'node.exe')]
        : ['/usr/local/bin/node', '/usr/bin/node'];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return 'node'; // hope it's on PATH
}

const NODE_BINARY = findNodeBinary();

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

        // Fall back to npx — always works if npm is installed
        this.binaryPath = 'npx:atlasmemory';
        return 'npx:atlasmemory';
    }

    private run(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const binary = this.findBinary();
            let cmd: string;
            let cmdArgs: string[];

            const isWindows = process.platform === 'win32';
            if (binary === 'npx:atlasmemory') {
                cmd = isWindows ? 'npx.cmd' : 'npx';
                cmdArgs = ['-y', 'atlasmemory', ...args];
            } else if (binary.endsWith('.js')) {
                // Quote paths with spaces for Windows shell execution
                cmd = isWindows ? `"${NODE_BINARY}"` : NODE_BINARY;
                cmdArgs = [isWindows ? `"${binary}"` : binary, ...args];
            } else {
                cmd = isWindows ? `"${binary}"` : binary;
                cmdArgs = args;
            }

            execFile(cmd, cmdArgs, {
                cwd: this.workspaceRoot,
                timeout: 60000,
                env: { ...process.env, FORCE_COLOR: '0' },
                shell: isWindows,
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

    async generateForce(format: string = 'all'): Promise<string> {
        return this.run(['generate', '--format', format, '--force']);
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
