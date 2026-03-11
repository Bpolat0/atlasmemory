import * as vscode from 'vscode';
import { AtlasStatus } from './atlas-client';

export class DashboardPanel {
    private static currentPanel: DashboardPanel | undefined;
    private panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    static show(status: AtlasStatus | null): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel.panel.reveal(column);
            DashboardPanel.currentPanel.update(status);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'atlasmemoryDashboard',
            'AtlasMemory Dashboard',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        DashboardPanel.currentPanel = new DashboardPanel(panel);
        DashboardPanel.currentPanel.update(status);
    }

    update(status: AtlasStatus | null): void {
        this.panel.webview.html = generateDashboardHtml(status);
    }

    private dispose(): void {
        DashboardPanel.currentPanel = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}

function generateDashboardHtml(status: AtlasStatus | null): string {
    if (!status) {
        return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);">
            <div style="text-align:center">
                <h1>AtlasMemory</h1>
                <p>No index found. Run <code>AtlasMemory: Index Project</code> to get started.</p>
            </div>
        </body></html>`;
    }

    const s = status;
    const score = s.readiness.overall;
    const scoreColor = score >= 80 ? '#4ec9b0' : score >= 60 ? '#dcdcaa' : score >= 40 ? '#ce9178' : '#f14c4c';
    const scoreLabel = score >= 80 ? 'EXCELLENT' : score >= 60 ? 'GOOD' : score >= 40 ? 'FAIR' : 'NEEDS WORK';
    const healthColor = s.health.status === 'HEALTHY' ? '#4ec9b0' : '#ce9178';

    // SVG gauge: semicircle arc
    const angle = (score / 100) * 180;
    const rad = (angle - 90) * Math.PI / 180;
    const x = 50 + 40 * Math.cos(rad);
    const y = 50 + 40 * Math.sin(rad);
    const largeArc = angle > 90 ? 1 : 0;

    return `<!DOCTYPE html>
<html>
<head>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 24px;
    }
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
    }
    .header h1 {
        font-size: 24px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .header .version {
        opacity: 0.5;
        font-size: 14px;
    }
    .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        max-width: 900px;
    }
    .card {
        background: var(--vscode-editorWidget-background, rgba(255,255,255,0.05));
        border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
        border-radius: 8px;
        padding: 20px;
    }
    .card h2 {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 1px;
        opacity: 0.6;
        margin-bottom: 16px;
    }
    .card.wide { grid-column: 1 / -1; }

    /* Gauge */
    .gauge-container {
        display: flex;
        flex-direction: column;
        align-items: center;
    }
    .gauge svg { width: 180px; height: 100px; }
    .gauge-score {
        font-size: 48px;
        font-weight: 700;
        color: ${scoreColor};
        margin-top: -10px;
    }
    .gauge-label {
        font-size: 14px;
        font-weight: 600;
        color: ${scoreColor};
        letter-spacing: 2px;
    }

    /* Metrics */
    .metrics { margin-top: 16px; }
    .metric {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
    }
    .metric-name {
        width: 120px;
        font-size: 13px;
        opacity: 0.8;
    }
    .metric-bar {
        flex: 1;
        height: 6px;
        background: var(--vscode-progressBar-background, rgba(255,255,255,0.1));
        border-radius: 3px;
        overflow: hidden;
    }
    .metric-bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.5s ease;
    }
    .metric-value {
        width: 45px;
        text-align: right;
        font-size: 13px;
        font-weight: 600;
    }

    /* Stats */
    .stat-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
    }
    .stat {
        text-align: center;
        padding: 12px;
        background: var(--vscode-editor-background);
        border-radius: 6px;
    }
    .stat-number {
        font-size: 28px;
        font-weight: 700;
        color: var(--vscode-textLink-foreground, #3794ff);
    }
    .stat-label {
        font-size: 12px;
        opacity: 0.6;
        margin-top: 4px;
    }

    /* Health */
    .health-badge {
        display: inline-block;
        padding: 6px 16px;
        border-radius: 20px;
        font-weight: 600;
        font-size: 14px;
        color: ${healthColor};
        border: 1px solid ${healthColor};
        margin-bottom: 12px;
    }
    .health-detail {
        font-size: 13px;
        opacity: 0.7;
        margin-bottom: 4px;
    }
    .issue {
        color: #ce9178;
        font-size: 13px;
        margin-top: 8px;
    }

    /* Footer */
    .footer {
        margin-top: 24px;
        text-align: center;
        opacity: 0.4;
        font-size: 12px;
    }
</style>
</head>
<body>
    <div class="header">
        <h1>AtlasMemory Dashboard</h1>
        <span class="version">v${esc(s.version)}</span>
    </div>

    <div class="grid">
        <!-- AI Readiness Gauge -->
        <div class="card">
            <h2>AI Readiness</h2>
            <div class="gauge-container">
                <div class="gauge">
                    <svg viewBox="0 0 100 55">
                        <path d="M 10 50 A 40 40 0 0 1 90 50"
                              fill="none" stroke="var(--vscode-widget-border, rgba(255,255,255,0.1))" stroke-width="6" stroke-linecap="round"/>
                        <path d="M 10 50 A 40 40 0 ${largeArc} 1 ${x.toFixed(1)} ${y.toFixed(1)}"
                              fill="none" stroke="${scoreColor}" stroke-width="6" stroke-linecap="round"/>
                    </svg>
                </div>
                <div class="gauge-score">${score}</div>
                <div class="gauge-label">${scoreLabel}</div>
            </div>
            <div class="metrics">
                ${renderMetric('Code Coverage', s.readiness.codeCoverage, '#4ec9b0')}
                ${renderMetric('Descriptions', s.readiness.descriptionCoverage, '#569cd6')}
                ${renderMetric('Flow Analysis', s.readiness.flowCoverage, '#dcdcaa')}
                ${renderMetric('Evidence', s.readiness.evidenceCoverage, '#c586c0')}
            </div>
        </div>

        <!-- Project Stats -->
        <div class="card">
            <h2>Project Stats</h2>
            <div class="stat-grid">
                ${renderStat(s.stats.files, 'Files')}
                ${renderStat(s.stats.symbols, 'Symbols')}
                ${renderStat(s.stats.anchors, 'Anchors')}
                ${renderStat(s.stats.flowCards, 'Flows')}
                ${renderStat(s.stats.fileCards, 'Cards')}
                ${renderStat(s.stats.imports, 'Imports')}
            </div>
        </div>

        <!-- Health -->
        <div class="card wide">
            <h2>Health</h2>
            <div class="health-badge">${s.health.status === 'HEALTHY' ? 'HEALTHY' : 'ISSUES FOUND'}</div>
            <div class="health-detail">Database: ${esc(s.database)}</div>
            <div class="health-detail">Last Index: ${s.lastIndex ? new Date(s.lastIndex).toLocaleString() : 'Never'}</div>
            <div class="health-detail">FTS Stemmer: ${s.health.hasFtsStemmer ? 'Porter (Active)' : 'Missing — re-index recommended'}</div>
            ${(s.health.issues || []).map(i => `<div class="issue">&#9888; ${esc(i)}</div>`).join('')}
        </div>
    </div>

    <div class="footer">
        AtlasMemory — Proof-backed, drift-resistant AI memory for your codebase
    </div>
</body>
</html>`;
}

function renderMetric(name: string, value: number, color: string): string {
    const safe = isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
    return `<div class="metric">
        <span class="metric-name">${esc(name)}</span>
        <div class="metric-bar"><div class="metric-bar-fill" style="width:${safe}%;background:${color}"></div></div>
        <span class="metric-value">${safe}%</span>
    </div>`;
}

function renderStat(value: number, label: string): string {
    const safe = isFinite(value) ? value : 0;
    return `<div class="stat">
        <div class="stat-number">${safe.toLocaleString()}</div>
        <div class="stat-label">${esc(label)}</div>
    </div>`;
}

function esc(text: string): string {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
