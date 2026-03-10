import * as vscode from 'vscode';
import { AtlasClient, AtlasStatus } from './atlas-client';

export class StatusBarProvider implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private client: AtlasClient;
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastStatus: AtlasStatus | null = null;

    constructor(client: AtlasClient) {
        this.client = client;
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            50
        );
        this.statusBarItem.command = 'atlasmemory.showDashboard';
        this.statusBarItem.tooltip = 'AtlasMemory — Click for Dashboard';
    }

    async start(): Promise<void> {
        const config = vscode.workspace.getConfiguration('atlasmemory');
        if (!config.get<boolean>('statusBarEnabled', true)) return;

        await this.refresh();
        this.statusBarItem.show();

        // Refresh every 30 seconds
        this.timer = setInterval(() => this.refresh(), 30000);
    }

    async refresh(): Promise<void> {
        const status = await this.client.getStatus();
        this.lastStatus = status;

        if (!status) {
            this.statusBarItem.text = '$(brain) AtlasMemory: Not Indexed';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Click to index project';
            this.statusBarItem.command = 'atlasmemory.indexProject';
            this.statusBarItem.show();
            return;
        }

        const score = status.readiness.overall;
        const icon = score >= 80 ? '$(check)' : score >= 40 ? '$(warning)' : '$(error)';
        const label = score >= 80 ? 'EXCELLENT' : score >= 60 ? 'GOOD' : score >= 40 ? 'FAIR' : 'NEEDS WORK';

        this.statusBarItem.text = `$(brain) Atlas: ${score}/100 ${label}`;
        this.statusBarItem.tooltip = [
            `AtlasMemory — AI Readiness: ${score}/100`,
            `Code: ${status.readiness.codeCoverage}% | Descriptions: ${status.readiness.descriptionCoverage}%`,
            `Flows: ${status.readiness.flowCoverage}% | Evidence: ${status.readiness.evidenceCoverage}%`,
            `${status.stats.files} files | ${status.stats.symbols} symbols | ${status.stats.flowCards} flows`,
            `Health: ${status.health.status}`,
            '',
            'Click for Dashboard',
        ].join('\n');

        if (score < 40) {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (score < 60) {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }

        this.statusBarItem.command = 'atlasmemory.showDashboard';
        this.statusBarItem.show();
    }

    getLastStatus(): AtlasStatus | null {
        return this.lastStatus;
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.statusBarItem.dispose();
    }
}
