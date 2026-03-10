import * as vscode from 'vscode';
import { AtlasClient } from './atlas-client';
import { StatusBarProvider } from './status-bar';
import { SidebarProvider } from './sidebar';
import { DashboardPanel } from './dashboard';

export function registerCommands(
    context: vscode.ExtensionContext,
    client: AtlasClient,
    statusBar: StatusBarProvider,
    sidebar: SidebarProvider,
    outputChannel: vscode.OutputChannel,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('atlasmemory.indexProject', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'AtlasMemory: Indexing project...' },
                async () => {
                    try {
                        const result = await client.indexProject();
                        outputChannel.appendLine(result);
                        vscode.window.showInformationMessage('AtlasMemory: Project indexed successfully!');
                        await refreshAll(client, statusBar, sidebar);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`AtlasMemory index failed: ${err.message}`);
                        outputChannel.appendLine(`[Error] ${err.message}`);
                    }
                }
            );
        }),

        vscode.commands.registerCommand('atlasmemory.generateClaudeMd', async () => {
            await runGenerate(client, 'claude', outputChannel, statusBar, sidebar);
        }),

        vscode.commands.registerCommand('atlasmemory.generateAll', async () => {
            await runGenerate(client, 'all', outputChannel, statusBar, sidebar);
        }),

        vscode.commands.registerCommand('atlasmemory.showDashboard', () => {
            const status = statusBar.getLastStatus();
            DashboardPanel.show(status);
        }),

        vscode.commands.registerCommand('atlasmemory.doctor', async () => {
            try {
                const result = await client.doctor();
                outputChannel.show();
                outputChannel.appendLine('--- Health Check ---');
                outputChannel.appendLine(result);
            } catch (err: any) {
                vscode.window.showErrorMessage(`AtlasMemory doctor failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('atlasmemory.search', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search your codebase',
                placeHolder: 'e.g., authentication, database schema, error handling',
            });
            if (!query) return;

            try {
                const result = await client.search(query);
                outputChannel.show();
                outputChannel.appendLine(`--- Search: "${query}" ---`);
                outputChannel.appendLine(result);
            } catch (err: any) {
                vscode.window.showErrorMessage(`AtlasMemory search failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand('atlasmemory.refresh', async () => {
            await refreshAll(client, statusBar, sidebar);
        }),
    );
}

async function runGenerate(
    client: AtlasClient,
    format: string,
    outputChannel: vscode.OutputChannel,
    statusBar: StatusBarProvider,
    sidebar: SidebarProvider,
): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AtlasMemory: Generating ${format === 'all' ? 'all AI configs' : 'CLAUDE.md'}...` },
        async () => {
            try {
                const result = await client.generate(format);
                outputChannel.appendLine(result);
                if (result.includes('Skipped')) {
                    const choice = await vscode.window.showWarningMessage(
                        'AtlasMemory: Some files were skipped (hand-written). Use --force to overwrite.',
                        'Generate (Force)'
                    );
                    if (choice === 'Generate (Force)') {
                        const forceResult = await client.generateForce(format);
                        outputChannel.appendLine(forceResult);
                        vscode.window.showInformationMessage('AtlasMemory: Generated with --force!');
                    }
                } else {
                    const label = format === 'all' ? 'CLAUDE.md + .cursorrules + copilot-instructions.md' : 'CLAUDE.md';
                    vscode.window.showInformationMessage(`AtlasMemory: Generated ${label}!`);
                }
                await refreshAll(client, statusBar, sidebar);
            } catch (err: any) {
                vscode.window.showErrorMessage(`AtlasMemory generate failed: ${err.message}`);
                outputChannel.appendLine(`[Error] ${err.message}`);
            }
        }
    );
}

async function refreshAll(
    client: AtlasClient,
    statusBar: StatusBarProvider,
    sidebar: SidebarProvider,
): Promise<void> {
    const status = await client.getStatus();
    sidebar.update(status);
    await statusBar.refresh();
}
