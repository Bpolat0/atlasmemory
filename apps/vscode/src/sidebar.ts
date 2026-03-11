import * as vscode from 'vscode';
import { AtlasStatus } from './atlas-client';

type TreeItemData = {
    label: string;
    icon?: string;
    description?: string;
    children?: TreeItemData[];
    command?: string;
    contextValue?: string;
};

export class SidebarProvider implements vscode.TreeDataProvider<TreeItemData>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItemData | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private status: AtlasStatus | null = null;

    update(status: AtlasStatus | null): void {
        this.status = status;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        const item = new vscode.TreeItem(
            element.label,
            element.children
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None
        );

        if (element.description) item.description = element.description;
        if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
        if (element.command) {
            item.command = { command: element.command, title: element.label };
        }
        if (element.contextValue) item.contextValue = element.contextValue;

        return item;
    }

    getChildren(element?: TreeItemData): TreeItemData[] {
        if (element?.children) return element.children;
        if (element) return [];

        if (!this.status) {
            return [{
                label: 'Not Indexed',
                icon: 'warning',
                description: 'Click to index project',
                command: 'atlasmemory.indexProject',
            }];
        }

        const s = this.status;
        const scoreIcon = s.readiness.overall >= 80 ? 'pass' : s.readiness.overall >= 40 ? 'warning' : 'error';

        return [
            {
                label: 'AI Readiness',
                icon: 'shield',
                description: `${s.readiness.overall}/100`,
                children: [
                    { label: 'Code Coverage', icon: 'file-code', description: `${s.readiness.codeCoverage}%` },
                    { label: 'Descriptions', icon: 'note', description: `${s.readiness.descriptionCoverage}%` },
                    { label: 'Flow Analysis', icon: 'git-merge', description: `${s.readiness.flowCoverage}%` },
                    { label: 'Evidence', icon: 'verified', description: `${s.readiness.evidenceCoverage}%` },
                ],
            },
            {
                label: 'Project Stats',
                icon: 'graph',
                children: [
                    { label: 'Files', icon: 'file', description: `${s.stats.files}` },
                    { label: 'Symbols', icon: 'symbol-method', description: `${s.stats.symbols}` },
                    { label: 'Anchors', icon: 'pin', description: `${s.stats.anchors}` },
                    { label: 'Flow Cards', icon: 'git-merge', description: `${s.stats.flowCards}` },
                    { label: 'File Cards', icon: 'note', description: `${s.stats.fileCards}` },
                    { label: 'Imports', icon: 'link', description: `${s.stats.imports}` },
                ],
            },
            {
                label: 'Health',
                icon: s.health.status === 'HEALTHY' ? 'pass' : 'warning',
                description: s.health.status === 'HEALTHY' ? 'Healthy' : 'Issues Found',
                children: [
                    { label: 'Status', icon: scoreIcon, description: s.health.status },
                    { label: 'Last Index', icon: 'clock', description: s.lastIndex ? formatTimeAgo(s.lastIndex) : 'Never' },
                    { label: 'FTS Stemmer', icon: s.health.hasFtsStemmer ? 'pass' : 'warning', description: s.health.hasFtsStemmer ? 'Porter' : 'Missing' },
                    ...s.health.issues.map(issue => ({ label: issue, icon: 'error' as string })),
                ],
            },
            {
                label: 'Quick Actions',
                icon: 'rocket',
                children: [
                    { label: 'Re-index Project', icon: 'database', command: 'atlasmemory.indexProject' },
                    { label: 'Generate CLAUDE.md', icon: 'file-text', command: 'atlasmemory.generateClaudeMd' },
                    { label: 'Generate All AI Configs', icon: 'sparkle', command: 'atlasmemory.generateAll' },
                    { label: 'Show Dashboard', icon: 'pulse', command: 'atlasmemory.showDashboard' },
                    { label: 'Health Check', icon: 'heart', command: 'atlasmemory.doctor' },
                    { label: 'Search Codebase', icon: 'search', command: 'atlasmemory.search' },
                ],
            },
        ];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function formatTimeAgo(isoDate: string): string {
    const time = new Date(isoDate).getTime();
    if (isNaN(time)) return 'Unknown';
    const diff = Date.now() - time;
    if (diff < 0) return 'Just now';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
