import * as vscode from 'vscode';
import { AtlasClient } from './atlas-client';
import { StatusBarProvider } from './status-bar';
import { SidebarProvider } from './sidebar';
import { FileWatcher } from './watcher';
import { registerCommands } from './commands';

let statusBar: StatusBarProvider;
let sidebar: SidebarProvider;
let watcher: FileWatcher;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    const outputChannel = vscode.window.createOutputChannel('AtlasMemory');
    const client = new AtlasClient(workspaceRoot);

    // Status bar
    statusBar = new StatusBarProvider(client);
    context.subscriptions.push(statusBar);

    // Sidebar
    sidebar = new SidebarProvider();
    const treeView = vscode.window.createTreeView('atlasmemory.explorer', {
        treeDataProvider: sidebar,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView, sidebar);

    // Commands
    registerCommands(context, client, statusBar, sidebar, outputChannel);

    // File watcher
    watcher = new FileWatcher(client, async () => {
        const status = await client.getStatus();
        sidebar.update(status);
        await statusBar.refresh();
    }, outputChannel);
    context.subscriptions.push(watcher);

    // Initial load
    await statusBar.start();
    const status = await client.getStatus();
    sidebar.update(status);

    // Welcome message if no database
    if (!client.hasDatabase()) {
        const action = await vscode.window.showInformationMessage(
            'AtlasMemory: No index found in this workspace. Index now to make your project AI-ready!',
            'Index Project',
            'Later'
        );
        if (action === 'Index Project') {
            vscode.commands.executeCommand('atlasmemory.indexProject');
        }
    }

    outputChannel.appendLine(`[AtlasMemory] Extension activated for ${workspaceRoot}`);
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
