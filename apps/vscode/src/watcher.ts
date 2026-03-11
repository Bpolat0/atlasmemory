import * as vscode from 'vscode';
import { AtlasClient } from './atlas-client';

const INDEXABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py',
]);

export class FileWatcher implements vscode.Disposable {
    private client: AtlasClient;
    private disposable: vscode.Disposable;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private pendingFiles = new Set<string>();
    private onDidIndex: () => void;
    private outputChannel: vscode.OutputChannel;
    private indexing = false;

    constructor(client: AtlasClient, onDidIndex: () => void, outputChannel: vscode.OutputChannel) {
        this.client = client;
        this.onDidIndex = onDidIndex;
        this.outputChannel = outputChannel;

        this.disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
            this.onFileSaved(doc);
        });
    }

    private onFileSaved(doc: vscode.TextDocument): void {
        const config = vscode.workspace.getConfiguration('atlasmemory');
        if (!config.get<boolean>('autoIndexOnSave', true)) return;

        const ext = doc.fileName.substring(doc.fileName.lastIndexOf('.'));
        if (!INDEXABLE_EXTENSIONS.has(ext)) return;

        // Skip files in node_modules, dist, etc.
        const relPath = vscode.workspace.asRelativePath(doc.fileName);
        if (relPath.includes('node_modules') || relPath.includes('dist/') || relPath.includes('.atlas/')) return;

        this.pendingFiles.add(doc.fileName);
        this.scheduleIndex();
    }

    private scheduleIndex(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);

        const config = vscode.workspace.getConfiguration('atlasmemory');
        const debounceMs = config.get<number>('watchDebounceMs', 2000);

        this.debounceTimer = setTimeout(() => this.runIndex(), debounceMs);
    }

    private async runIndex(): Promise<void> {
        if (this.indexing || this.pendingFiles.size === 0) return;
        this.indexing = true;

        const files = Array.from(this.pendingFiles);
        this.pendingFiles.clear();

        try {
            this.outputChannel.appendLine(`[AtlasMemory] Auto-indexing ${files.length} file(s)...`);

            // Index the whole project incrementally (faster than individual files)
            await this.client.indexProject();

            this.outputChannel.appendLine(`[AtlasMemory] Index updated.`);
            this.onDidIndex();
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.outputChannel.appendLine(`[AtlasMemory] Index error: ${msg}`);
            vscode.window.showWarningMessage(`AtlasMemory: Auto-index failed — ${msg}`);
        } finally {
            this.indexing = false;

            // If more files accumulated during indexing, schedule again
            if (this.pendingFiles.size > 0) {
                this.scheduleIndex();
            }
        }
    }

    dispose(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.disposable.dispose();
    }
}
