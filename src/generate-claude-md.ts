import { Store } from '@atlasmemory/store';
import fs from 'fs';
import path from 'path';

export interface GenerateOptions {
    rootDir: string;
    output?: string; // default: CLAUDE.md in rootDir
}

export interface AiReadinessScore {
    overall: number; // 0-100
    codeCoverage: number;
    descriptionCoverage: number;
    flowCoverage: number;
    evidenceCoverage: number;
    details: {
        totalFiles: number;
        indexedFiles: number;
        enrichedCards: number;
        totalCards: number;
        flowCount: number;
        anchorCount: number;
        symbolCount: number;
    };
}

export function computeAiReadiness(store: Store): AiReadinessScore {
    const files = store.getFiles();
    const totalFiles = files.length;

    const totalCards = (store.db.prepare('SELECT COUNT(*) as n FROM file_cards').get() as { n: number }).n;
    const enrichedCards = totalCards - (store.db.prepare(
        "SELECT COUNT(*) as n FROM file_cards WHERE card_level1 LIKE '%Awaiting AI enrichment%'"
    ).get() as { n: number }).n;

    const flowCount = (store.db.prepare('SELECT COUNT(*) as n FROM flow_cards').get() as { n: number }).n;
    const anchorCount = (store.db.prepare('SELECT COUNT(*) as n FROM anchors').get() as { n: number }).n;
    const symbolCount = (store.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number }).n;

    // Code Coverage: are all discoverable files indexed?
    const codeCoverage = totalFiles > 0 ? 100 : 0;

    // Description Coverage: how many cards have AI-enriched descriptions?
    const descriptionCoverage = totalCards > 0
        ? Math.round((enrichedCards / totalCards) * 100)
        : 0;

    // Flow Coverage: are there meaningful call flows?
    const filesWithFlows = new Set(
        (store.db.prepare('SELECT DISTINCT file_id FROM flow_cards').all() as { file_id: string }[])
            .map(r => r.file_id)
    ).size;
    const flowCoverage = totalFiles > 0
        ? Math.min(100, Math.round((filesWithFlows / totalFiles) * 100))
        : 0;

    // Evidence Coverage: how many symbols have anchors?
    const symbolsWithAnchors = (store.db.prepare(
        'SELECT COUNT(DISTINCT s.id) as n FROM symbols s INNER JOIN anchors a ON s.file_id = a.file_id AND s.start_line = a.start_line AND s.end_line = a.end_line'
    ).get() as { n: number }).n;
    const evidenceCoverage = symbolCount > 0
        ? Math.round((symbolsWithAnchors / symbolCount) * 100)
        : 0;

    // Weighted overall
    const overall = Math.round(
        codeCoverage * 0.25 +
        descriptionCoverage * 0.30 +
        flowCoverage * 0.20 +
        evidenceCoverage * 0.25
    );

    return {
        overall,
        codeCoverage,
        descriptionCoverage,
        flowCoverage,
        evidenceCoverage,
        details: {
            totalFiles,
            indexedFiles: totalFiles,
            enrichedCards,
            totalCards,
            flowCount,
            anchorCount,
            symbolCount,
        }
    };
}

export function generateClaudeMd(store: Store, options: GenerateOptions): string {
    const { rootDir } = options;
    const files = store.getFiles();

    // --- Project metadata from package.json ---
    const pkgPath = path.join(rootDir, 'package.json');
    let pkg: any = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch { }

    const projectName = pkg.name || path.basename(rootDir);
    const projectDesc = pkg.description || '';

    // --- Filter files to project root only ---
    const projectFiles = files.filter(f => {
        const rel = path.relative(rootDir, f.path).replace(/\\/g, '/');
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    });

    // --- Detect languages ---
    const langCounts = new Map<string, number>();
    for (const file of projectFiles) {
        const ext = path.extname(file.path).toLowerCase();
        const lang = ext === '.ts' || ext === '.tsx' ? 'TypeScript'
            : ext === '.js' || ext === '.jsx' ? 'JavaScript'
            : ext === '.py' ? 'Python' : ext.slice(1);
        if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
    }
    const languages = Array.from(langCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => `${lang} (${count})`)
        .join(', ');

    // --- Architecture: directory structure ---
    const dirCounts = new Map<string, number>();
    const dirSymbols = new Map<string, string[]>();
    for (const file of projectFiles) {
        const rel = path.relative(rootDir, file.path).replace(/\\/g, '/');
        const parts = rel.split('/');
        const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : (parts.length > 1 ? parts[0] : '.');
        dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);

        // Collect top symbols per directory
        if (!dirSymbols.has(dir)) dirSymbols.set(dir, []);
        const syms = store.getSymbolsForFile(file.id);
        for (const sym of syms) {
            if (sym.visibility === 'public' && dirSymbols.get(dir)!.length < 3) {
                dirSymbols.get(dir)!.push(sym.name);
            }
        }
    }
    const topDirs = Array.from(dirCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);

    // --- Key files: highest symbol count ---
    const fileSymbolCounts: { path: string; relPath: string; symbolCount: number; purpose: string }[] = [];
    for (const file of projectFiles) {
        const syms = store.getSymbolsForFile(file.id);
        const card = store.getFileCard(file.id);
        const rawPurpose = card?.level1?.purpose || card?.level0?.purpose || '';
        const purpose = rawPurpose.includes('Auto-generated') || rawPurpose.includes('Managed by AtlasMemory')
            ? '' : rawPurpose;
        const relPath = path.relative(rootDir, file.path).replace(/\\/g, '/');
        fileSymbolCounts.push({
            path: file.path,
            relPath,
            symbolCount: syms.length,
            purpose: purpose.length > 80 ? purpose.slice(0, 77) + '...' : purpose,
        });
    }
    const keyFiles = fileSymbolCounts
        .sort((a, b) => b.symbolCount - a.symbolCount)
        .slice(0, 15);

    // --- Commands from package.json scripts ---
    const scripts = pkg.scripts || {};
    const importantScripts = ['build', 'test', 'dev', 'start', 'lint', 'format', 'serve', 'deploy',
        'build:all', 'build:bundle', 'eval', 'eval:synth100', 'eval:real'];
    const commandLines: string[] = [];
    for (const key of importantScripts) {
        if (scripts[key]) {
            commandLines.push(`${key.padEnd(20)} # ${scripts[key]}`);
        }
    }
    // Add any remaining scripts not in the important list
    for (const [key, val] of Object.entries(scripts)) {
        if (!importantScripts.includes(key) && commandLines.length < 20) {
            commandLines.push(`${key.padEnd(20)} # ${val}`);
        }
    }

    // --- Tech stack from dependencies ---
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const techStack: string[] = [languages];
    const techMap: Record<string, string> = {
        'react': 'React', 'next': 'Next.js', 'express': 'Express',
        'fastify': 'Fastify', 'vue': 'Vue', 'angular': 'Angular', 'svelte': 'Svelte',
        'better-sqlite3': 'SQLite (better-sqlite3)', 'prisma': 'Prisma', 'drizzle-orm': 'Drizzle',
        'tree-sitter': 'Tree-sitter', 'commander': 'Commander.js', 'esbuild': 'esbuild',
        'webpack': 'Webpack', 'vite': 'Vite', 'jest': 'Jest', 'vitest': 'Vitest',
        'mocha': 'Mocha', 'tailwindcss': 'Tailwind CSS', 'eslint': 'ESLint', 'prettier': 'Prettier',
        '@modelcontextprotocol/sdk': 'MCP SDK',
    };
    const seenTech = new Set<string>();
    for (const [dep] of Object.entries(deps)) {
        const baseName = dep.replace(/^@[^/]+\//, '');
        const tech = techMap[dep] || techMap[baseName];
        if (tech && !seenTech.has(tech)) { techStack.push(tech); seenTech.add(tech); }
    }

    // --- Conventions detection ---
    const conventions: string[] = [];
    if (pkg.type === 'module') conventions.push('ESM modules (`"type": "module"`)');
    if (pkg.workspaces) conventions.push('Monorepo (npm workspaces)');
    if (fs.existsSync(path.join(rootDir, 'tsconfig.json'))) conventions.push('TypeScript with tsconfig.json');
    if (fs.existsSync(path.join(rootDir, '.eslintrc.js')) || fs.existsSync(path.join(rootDir, '.eslintrc.json')) || fs.existsSync(path.join(rootDir, 'eslint.config.js'))) conventions.push('ESLint configured');
    if (fs.existsSync(path.join(rootDir, '.prettierrc')) || fs.existsSync(path.join(rootDir, '.prettierrc.json'))) conventions.push('Prettier configured');
    if (fs.existsSync(path.join(rootDir, 'Dockerfile'))) conventions.push('Docker containerized');
    if (fs.existsSync(path.join(rootDir, '.github/workflows'))) conventions.push('GitHub Actions CI/CD');

    // Detect DB path convention
    if (fs.existsSync(path.join(rootDir, '.atlas'))) conventions.push('AtlasMemory DB at `.atlas/atlas.db`');

    // --- Flow summaries ---
    const flows = store.getAllFlowCards().slice(0, 8);
    const flowLines = flows.map(f => `${f.summary} (${f.hopCount}-hop)`);

    // --- AI Readiness ---
    const readiness = computeAiReadiness(store);

    // --- Build the CLAUDE.md ---
    const sections: string[] = [];

    // Header
    sections.push(`# ${projectName}`);
    if (projectDesc) sections.push(`\n${projectDesc}`);

    // Architecture
    sections.push('\n## Architecture');
    if (pkg.workspaces) {
        sections.push(`Monorepo with ${topDirs.length} main directories:\n`);
    }
    sections.push('```');
    for (const [dir, count] of topDirs) {
        const syms = dirSymbols.get(dir) || [];
        const symStr = syms.length > 0 ? ` → ${syms.join(', ')}` : '';
        sections.push(`${dir.padEnd(30)} ${String(count).padStart(3)} files${symStr}`);
    }
    sections.push('```');

    // Key Files
    sections.push('\n## Key Files');
    for (const kf of keyFiles) {
        const purposeStr = kf.purpose ? ` — ${kf.purpose}` : '';
        sections.push(`- **\`${kf.relPath}\`**${purposeStr}`);
    }

    // Commands
    if (commandLines.length > 0) {
        sections.push('\n## Commands');
        sections.push('```bash');
        for (const line of commandLines) {
            sections.push(line);
        }
        sections.push('```');
    }

    // Tech Stack
    if (techStack.length > 0) {
        sections.push('\n## Tech Stack');
        sections.push(techStack.join(', '));
    }

    // Conventions
    if (conventions.length > 0) {
        sections.push('\n## Conventions');
        for (const conv of conventions) {
            sections.push(`- ${conv}`);
        }
    }

    // Data Flows
    if (flowLines.length > 0) {
        sections.push('\n## Key Data Flows');
        for (const fl of flowLines) {
            sections.push(`- ${fl}`);
        }
    }

    // AI Readiness Score
    sections.push('\n## AI Readiness Score');
    sections.push(`**${readiness.overall}/100**\n`);
    sections.push(`| Metric | Score | Details |`);
    sections.push(`|--------|-------|---------|`);
    sections.push(`| Code Coverage | ${readiness.codeCoverage}% | ${readiness.details.indexedFiles}/${readiness.details.totalFiles} files indexed |`);
    sections.push(`| Description Quality | ${readiness.descriptionCoverage}% | ${readiness.details.enrichedCards}/${readiness.details.totalCards} cards enriched |`);
    sections.push(`| Flow Analysis | ${readiness.flowCoverage}% | ${readiness.details.flowCount} call flows traced |`);
    sections.push(`| Evidence Anchors | ${readiness.evidenceCoverage}% | ${readiness.details.anchorCount} anchors linked |`);

    if (readiness.descriptionCoverage < 100) {
        sections.push(`\nTo improve: connect an AI agent (Claude/Codex) and let it enrich file descriptions via \`upsert_file_card\`.`);
    }

    // Footer
    sections.push('\n---');
    sections.push('*Auto-generated by [AtlasMemory](https://github.com/Bpolat0/atlasmemory). Re-run `atlasmemory generate` to update.*');

    return sections.join('\n');
}

export function renderReadinessBar(score: number): string {
    const filled = Math.round(score / 5);
    const empty = 20 - filled;
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
    const label = score >= 80 ? 'EXCELLENT' : score >= 60 ? 'GOOD' : score >= 40 ? 'FAIR' : 'NEEDS WORK';
    return `${bar} ${score}/100 ${label}`;
}
