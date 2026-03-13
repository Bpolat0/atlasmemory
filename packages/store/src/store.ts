import Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';
import type { CodeSymbol, FileCard, Import, SymbolCard, Anchor, CodeRef, FlowCard, ProjectCard, ContextSnapshot, DbSignature } from '@atlasmemory/core';
import crypto from 'crypto';

/** Safely parse JSON strings from DB — returns fallback on null/undefined/corrupt data */
const safeJsonParse = (json: string | null | undefined, fallback: any = null) => {
    if (!json) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
};

export class Store {
    public db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        // WAL mode: allows concurrent reads + single writer without blocking
        this.db.pragma('journal_mode = WAL');
        // Wait up to 30s if DB is locked by another process (CLI + MCP simultaneously)
        this.db.pragma('busy_timeout = 30000');
        this.init();
    }

    /** Split camelCase/PascalCase/snake_case identifiers into space-separated terms for FTS indexing */
    private expandIdentifiers(text: string): string {
        return text
            .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → camel Case
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // XMLParser → XML Parser
            .replace(/_/g, ' ')                       // snake_case → snake case
            .replace(/-/g, ' ');                      // kebab-case → kebab case
    }

    // Current schema version — increment when schema changes
    private static readonly SCHEMA_VERSION = 5;

    private init() {
        const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) || 0;

        // Migrate old FTS tables to Porter stemmer (drop and let SCHEMA recreate)
        if (currentVersion < 2) {
            try {
                const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_files'").get() as { sql: string } | undefined;
                if (row && !row.sql.includes('porter')) {
                    this.db.exec('DROP TABLE IF EXISTS fts_files');
                    this.db.exec('DROP TABLE IF EXISTS fts_symbols');
                }
            } catch (e) { /* fresh DB, no migration needed */ }
        }

        this.db.exec(SCHEMA);

        // Run all migrations in a transaction for safety
        this.db.transaction(() => {
            // Migration v1→v2: Phase 7A columns
            if (currentVersion < 2) {
                try { this.db.prepare("ALTER TABLE file_cards ADD COLUMN quality_score REAL DEFAULT 0").run(); } catch { }
                try { this.db.prepare("ALTER TABLE file_cards ADD COLUMN quality_flags_json TEXT").run(); } catch { }
            }
            // Migration v2→v3: Level2/Level3 cards
            if (currentVersion < 3) {
                try { this.db.prepare("ALTER TABLE file_cards ADD COLUMN card_level2 TEXT").run(); } catch { }
                try { this.db.prepare("ALTER TABLE file_cards ADD COLUMN card_level3 TEXT").run(); } catch { }
            }
            // v4, v5: new tables handled by SCHEMA (CREATE IF NOT EXISTS)

            // Stamp current version
            this.db.pragma(`user_version = ${Store.SCHEMA_VERSION}`);
        })();
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS flow_cards (
                id TEXT PRIMARY KEY,
                file_id TEXT NOT NULL,
                root_symbol_id TEXT,
                flow_kind TEXT NOT NULL,
                hop_count INTEGER NOT NULL,
                summary TEXT NOT NULL,
                trace_json TEXT NOT NULL,
                evidence_anchors_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(file_id) REFERENCES files(id),
                FOREIGN KEY(root_symbol_id) REFERENCES symbols(id)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS project_card (
                id TEXT PRIMARY KEY,
                purpose TEXT NOT NULL,
                architecture_bullets_json TEXT NOT NULL,
                invariants_json TEXT NOT NULL,
                entrypoints_json TEXT NOT NULL,
                key_flows_json TEXT NOT NULL,
                tools_protocol_json TEXT NOT NULL,
                glossary_json TEXT NOT NULL,
                card_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_state (
                state_key TEXT PRIMARY KEY,
                state_value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS context_snapshots (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                created_at TEXT NOT NULL,
                repo_id TEXT NOT NULL,
                git_head TEXT,
                db_sig_json TEXT NOT NULL,
                bootpack_hash TEXT,
                deltapack_hash TEXT,
                taskpack_hash TEXT,
                objective TEXT,
                budgets_json TEXT,
                proof_mode TEXT,
                min_db_coverage REAL,
                contract_hash TEXT NOT NULL
            )
        `);
    }

    // --- Files ---
    addFile(path: string, language: string, contentHash: string, loc: number, content: string) {
        const stmt = this.db.prepare(`
      INSERT INTO files (id, path, language, content_hash, loc, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        loc = excluded.loc,
        updated_at = datetime('now')
    `);
        const id = crypto.randomUUID();
        // Check if file exists to get ID? Or rely on conflict update?
        // If conflict update, ID doesn't change.
        // We really should UPSERT properly.
        // If it exists, we need the ID.

        // Simpler: Check existing
        const existing = this.getFileId(path);
        const fileId = existing || id;

        if (existing) {
            this.db.prepare(`
                UPDATE files SET 
                    language = ?, content_hash = ?, loc = ?, updated_at = datetime('now')
                WHERE id = ?
             `).run(language, contentHash, loc, fileId);
        } else {
            this.db.prepare(`
                INSERT INTO files (id, path, language, content_hash, loc, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
             `).run(fileId, path, language, contentHash, loc);
        }

        // Update FTS
        // Delete old (if any)
        this.db.prepare('DELETE FROM fts_files WHERE file_id = ?').run(fileId);
        this.db.prepare('DELETE FROM fts_symbols WHERE file_id = ?').run(fileId); // Clear symbols too if file updated

        // Insert new — append expanded identifiers so FTS matches individual terms
        const expandedContent = content + '\n' + this.expandIdentifiers(content);
        this.db.prepare('INSERT INTO fts_files (path, content, file_id) VALUES (?, ?, ?)').run(path, expandedContent, fileId);

        return fileId;
    }

    getFileId(path: string): string | undefined {
        const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as { id: string } | undefined;
        return row?.id;
    }

    getFiles(): { id: string, path: string, contentHash: string }[] {
        return this.db.prepare('SELECT id, path, content_hash as contentHash FROM files').all() as any[];
    }

    getFilesWithMeta(): { id: string, path: string, contentHash: string, updatedAt: string }[] {
        return this.db.prepare('SELECT id, path, content_hash as contentHash, updated_at as updatedAt FROM files').all() as any[];
    }

    deleteFile(id: string) {
        const deleteTransaction = this.db.transaction(() => {
            // 0. Delete Flow Cards first (root_symbol_id FK -> symbols.id)
            this.db.prepare('DELETE FROM flow_cards WHERE file_id = ?').run(id);

            // 1. Get Symbols to clean up refs
            const symbols = this.db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(id) as { id: string }[];
            const symbolIds = symbols.map(s => s.id);

            if (symbolIds.length > 0) {
                const placeholders = symbolIds.map(() => '?').join(',');
                this.db.prepare(`DELETE FROM refs WHERE from_symbol_id IN (${placeholders})`).run(...symbolIds);
                this.db.prepare(`DELETE FROM refs WHERE to_symbol_id IN (${placeholders})`).run(...symbolIds);
            }

            // 2. Delete Symbols
            this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(id);

            // 3. Delete Imports
            this.db.prepare('DELETE FROM imports WHERE file_id = ?').run(id);

            // 4. Delete Anchors
            this.db.prepare('DELETE FROM anchors WHERE file_id = ?').run(id);

            // 5. Delete File Card
            this.db.prepare('DELETE FROM file_cards WHERE file_id = ?').run(id);

            // 6. Delete File
            this.db.prepare('DELETE FROM files WHERE id = ?').run(id);

            // 7. Delete FTS
            this.db.prepare('DELETE FROM fts_files WHERE file_id = ?').run(id);
            this.db.prepare('DELETE FROM fts_symbols WHERE file_id = ?').run(id);
            this.db.prepare('DELETE FROM fts_semantic_tags WHERE file_id = ?').run(id);
            this.db.prepare('DELETE FROM code_health WHERE file_id = ?').run(id);
        });

        deleteTransaction();
    }

    // --- Cards ---
    addFileCard(card: FileCard) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO file_cards (file_id, card_level0, card_level1, card_level2, card_level3, evidence_anchors_json, card_hash, quality_score, quality_flags_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        stmt.run(
            card.fileId,
            JSON.stringify(card.level0),
            card.level1 ? JSON.stringify(card.level1) : null,
            card.level2 ? JSON.stringify(card.level2) : null,
            card.level3 ? JSON.stringify(card.level3) : null,
            card.level1?.evidenceAnchorIds ? JSON.stringify(card.level1.evidenceAnchorIds) : null,
            card.cardHash,
            card.qualityScore || 0,
            card.qualityFlags ? JSON.stringify(card.qualityFlags) : null
        );

        // Enrich FTS with card purpose — enables semantic search
        // e.g., "database schema" finds schema.ts even if code doesn't contain "database"
        const purpose = card.level1?.purpose || card.level0?.purpose || '';
        const publicApi = card.level1?.publicApi?.join(' ') || card.level0?.exports?.join(' ') || '';
        if (purpose || publicApi) {
            const enrichment = [purpose, publicApi].filter(Boolean).join(' ');
            try {
                // Append card semantics to existing FTS content
                const existing = this.db.prepare('SELECT content FROM fts_files WHERE file_id = ?').get(card.fileId) as { content: string } | undefined;
                if (existing) {
                    this.db.prepare('DELETE FROM fts_files WHERE file_id = ?').run(card.fileId);
                    const file = this.db.prepare('SELECT path FROM files WHERE id = ?').get(card.fileId) as any;
                    this.db.prepare('INSERT INTO fts_files (path, content, file_id) VALUES (?, ?, ?)').run(
                        file?.path || '', existing.content + '\n' + enrichment, card.fileId
                    );
                }
            } catch { /* FTS update failure is non-critical */ }
        }
    }

    getFileCard(fileId: string): FileCard | undefined {
        const row = this.db.prepare('SELECT * FROM file_cards WHERE file_id = ?').get(fileId) as any;
        if (!row) return undefined;

        const file = this.db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as any;

        const level1 = safeJsonParse(row.card_level1);
        if (level1 && row.evidence_anchors_json) {
            level1.evidenceAnchorIds = safeJsonParse(row.evidence_anchors_json, []);
        }

        return {
            fileId,
            path: file?.path || '',
            level0: safeJsonParse(row.card_level0, { purpose: '', exports: [], imports: [] }),
            level1,
            level2: safeJsonParse(row.card_level2),
            level3: safeJsonParse(row.card_level3),
            cardHash: row.card_hash,
            qualityScore: row.quality_score || 0,
            qualityFlags: safeJsonParse(row.quality_flags_json, [])
        };
    }

    addFolderCard(card: import('@atlasmemory/core').FolderCard) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO folder_cards (folder_path, card_level0, card_level1, updated_at)
            VALUES (?, ?, ?, datetime('now'))
        `);
        stmt.run(
            card.folderPath,
            JSON.stringify(card.level0),
            card.level1 ? JSON.stringify(card.level1) : null
        );
    }

    getFolderCard(folderPath: string): import('@atlasmemory/core').FolderCard | undefined {
        const row = this.db.prepare('SELECT * FROM folder_cards WHERE folder_path = ?').get(folderPath) as any;
        if (!row) return undefined;

        return {
            folderPath,
            level0: safeJsonParse(row.card_level0, { purpose: '' }),
            level1: row.card_level1 ? safeJsonParse(row.card_level1) : undefined,
            updatedAt: row.updated_at
        };
    }

    // --- Symbols ---
    addSymbol(symbol: CodeSymbol) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO symbols (id, file_id, kind, name, qualified_name, signature, visibility, start_line, end_line, signature_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(
            symbol.id, symbol.fileId, symbol.kind, symbol.name, symbol.qualifiedName,
            symbol.signature, symbol.visibility, symbol.startLine, symbol.endLine, symbol.signatureHash
        );

        // Update FTS Symbol — include expanded names for camelCase matching
        const expandedName = `${symbol.name} ${this.expandIdentifiers(symbol.name)}`;
        const expandedQualified = `${symbol.qualifiedName} ${this.expandIdentifiers(symbol.qualifiedName)}`;
        const expandedSig = `${symbol.signature} ${this.expandIdentifiers(symbol.signature)}`;
        this.db.prepare('INSERT INTO fts_symbols (name, qualified_name, signature, file_id) VALUES (?, ?, ?, ?)').run(expandedName, expandedQualified, expandedSig, symbol.fileId);
    }

    getSymbolsForFile(fileId: string): CodeSymbol[] {
        return this.db.prepare('SELECT * FROM symbols WHERE file_id = ?').all(fileId).map((row: any) => ({
            id: row.id,
            fileId: row.file_id,
            kind: row.kind,
            name: row.name,
            qualifiedName: row.qualified_name,
            signature: row.signature,
            visibility: row.visibility,
            startLine: row.start_line,
            endLine: row.end_line,
            signatureHash: row.signature_hash
        }));
    }

    // --- Symbol Cards ---
    addSymbolCard(card: SymbolCard) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO symbol_cards (symbol_id, card_level0, card_level1, evidence_anchors_json, quality_score, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `);
        stmt.run(
            card.symbolId,
            JSON.stringify(card.level0),
            card.level1 ? JSON.stringify(card.level1) : null,
            card.level1?.evidenceAnchorIds ? JSON.stringify(card.level1.evidenceAnchorIds) : null,
            0
        );
    }

    getSymbolCard(symbolId: string): SymbolCard | undefined {
        const row = this.db.prepare('SELECT * FROM symbol_cards WHERE symbol_id = ?').get(symbolId) as any;
        if (!row) return undefined;

        const level1 = row.card_level1 ? safeJsonParse(row.card_level1) : undefined;
        if (level1 && row.evidence_anchors_json) {
            level1.evidenceAnchorIds = safeJsonParse(row.evidence_anchors_json, []);
        }

        return {
            symbolId,
            level0: safeJsonParse(row.card_level0, { purpose: '' }),
            level1
        };
    }

    // --- Refs ---
    addRef(ref: import('@atlasmemory/core').CodeRef) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO refs (id, from_symbol_id, to_symbol_id, to_name, ref_kind, anchor_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(ref.id, ref.fromSymbolId, ref.toSymbolId || null, ref.toName, ref.kind, ref.anchorId || null);
    }

    getRefsFrom(symbolId: string): import('@atlasmemory/core').CodeRef[] {
        return this.db.prepare('SELECT * FROM refs WHERE from_symbol_id = ?').all(symbolId).map((row: any) => ({
            id: row.id,
            fromSymbolId: row.from_symbol_id,
            toSymbolId: row.to_symbol_id,
            toName: row.to_name,
            kind: row.ref_kind as any,
            anchorId: row.anchor_id
        }));
    }

    getRefsForFile(fileId: string, kind?: 'call' | 'import' | 'usage'): CodeRef[] {
        const rows = kind
            ? this.db.prepare(`
                SELECT r.*
                FROM refs r
                JOIN symbols s ON r.from_symbol_id = s.id
                WHERE s.file_id = ? AND r.ref_kind = ?
            `).all(fileId, kind)
            : this.db.prepare(`
                SELECT r.*
                FROM refs r
                JOIN symbols s ON r.from_symbol_id = s.id
                WHERE s.file_id = ?
            `).all(fileId);

        return (rows as any[]).map((row: any) => ({
            id: row.id,
            fromSymbolId: row.from_symbol_id,
            toSymbolId: row.to_symbol_id,
            toName: row.to_name,
            kind: row.ref_kind,
            anchorId: row.anchor_id
        }));
    }

    getSymbol(symbolId: string): CodeSymbol | undefined {
        const row = this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(symbolId) as any;
        if (!row) return undefined;
        return {
            id: row.id,
            fileId: row.file_id,
            kind: row.kind,
            name: row.name,
            qualifiedName: row.qualified_name,
            signature: row.signature,
            visibility: row.visibility,
            startLine: row.start_line,
            endLine: row.end_line,
            signatureHash: row.signature_hash
        };
    }

    findSymbolsByName(name: string, fileId?: string): CodeSymbol[] {
        const rows = fileId
            ? this.db.prepare('SELECT * FROM symbols WHERE file_id = ? AND (name = ? OR qualified_name = ?)').all(fileId, name, name)
            : this.db.prepare('SELECT * FROM symbols WHERE name = ? OR qualified_name = ?').all(name, name);

        return (rows as any[]).map((row: any) => ({
            id: row.id,
            fileId: row.file_id,
            kind: row.kind,
            name: row.name,
            qualifiedName: row.qualified_name,
            signature: row.signature,
            visibility: row.visibility,
            startLine: row.start_line,
            endLine: row.end_line,
            signatureHash: row.signature_hash
        }));
    }

    // --- Imports ---
    addImport(imp: Import) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO imports (id, file_id, imported_module, imported_symbol, resolved_file_id, is_external)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(imp.id, imp.fileId, imp.importedModule, imp.importedSymbol, imp.resolvedFileId, imp.isExternal ? 1 : 0);
    }

    getImportsForFile(fileId: string): Import[] {
        return this.db.prepare('SELECT * FROM imports WHERE file_id = ?').all(fileId).map((row: any) => ({
            id: row.id,
            fileId: row.file_id,
            importedModule: row.imported_module,
            importedSymbol: row.imported_symbol || undefined,
            resolvedFileId: row.resolved_file_id || undefined,
            isExternal: row.is_external === 1
        }));
    }

    // --- Flow Cards ---
    upsertFlowCard(card: FlowCard) {
        this.db.prepare(`
            INSERT OR REPLACE INTO flow_cards
            (id, file_id, root_symbol_id, flow_kind, hop_count, summary, trace_json, evidence_anchors_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            card.id,
            card.fileId,
            card.rootSymbolId || null,
            card.flowKind,
            card.hopCount,
            card.summary,
            JSON.stringify(card.trace),
            JSON.stringify(card.evidenceAnchorIds)
        );
    }

    getFlowCardsForFile(fileId: string): FlowCard[] {
        return this.db.prepare('SELECT * FROM flow_cards WHERE file_id = ? ORDER BY updated_at DESC').all(fileId).map((row: any) => ({
            id: row.id,
            fileId: row.file_id,
            rootSymbolId: row.root_symbol_id || undefined,
            flowKind: row.flow_kind,
            hopCount: row.hop_count,
            summary: row.summary,
            trace: safeJsonParse(row.trace_json, []),
            evidenceAnchorIds: safeJsonParse(row.evidence_anchors_json, []),
            updatedAt: row.updated_at
        }));
    }

    deleteFlowCardsForFile(fileId: string) {
        this.db.prepare('DELETE FROM flow_cards WHERE file_id = ?').run(fileId);
    }

    getAllFlowCards(): FlowCard[] {
        return this.db.prepare('SELECT * FROM flow_cards ORDER BY updated_at DESC').all().map((row: any) => ({
            id: row.id,
            fileId: row.file_id,
            rootSymbolId: row.root_symbol_id || undefined,
            flowKind: row.flow_kind,
            hopCount: row.hop_count,
            summary: row.summary,
            trace: safeJsonParse(row.trace_json, []),
            evidenceAnchorIds: safeJsonParse(row.evidence_anchors_json, []),
            updatedAt: row.updated_at
        }));
    }

    // --- Project Card ---
    upsertProjectCard(card: ProjectCard) {
        this.db.prepare(`
            INSERT OR REPLACE INTO project_card
            (id, purpose, architecture_bullets_json, invariants_json, entrypoints_json, key_flows_json, tools_protocol_json, glossary_json, card_hash, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            card.id,
            card.purpose,
            JSON.stringify(card.architectureBullets),
            JSON.stringify(card.invariants),
            JSON.stringify(card.entrypoints),
            JSON.stringify(card.keyFlowIds),
            JSON.stringify(card.toolsProtocol),
            JSON.stringify(card.glossary),
            card.cardHash
        );
    }

    getProjectCard(id: string = 'singleton'): ProjectCard | undefined {
        const row = this.db.prepare('SELECT * FROM project_card WHERE id = ?').get(id) as any;
        if (!row) return undefined;
        return {
            id: row.id,
            purpose: row.purpose,
            architectureBullets: safeJsonParse(row.architecture_bullets_json, []),
            invariants: safeJsonParse(row.invariants_json, []),
            entrypoints: safeJsonParse(row.entrypoints_json, []),
            keyFlowIds: safeJsonParse(row.key_flows_json, []),
            toolsProtocol: safeJsonParse(row.tools_protocol_json, []),
            glossary: safeJsonParse(row.glossary_json, {}),
            cardHash: row.card_hash,
            updatedAt: row.updated_at
        };
    }

    // --- Session State ---
    setState(key: string, value: string, sessionId?: string) {
        const scopedKey = sessionId ? `${sessionId}:${key}` : key;
        this.db.prepare(`
            INSERT OR REPLACE INTO session_state (state_key, state_value, updated_at)
            VALUES (?, ?, datetime('now'))
        `).run(scopedKey, value);
    }

    getState(key: string, sessionId?: string): string | undefined {
        const scopedKey = sessionId ? `${sessionId}:${key}` : key;
        const row = this.db.prepare('SELECT state_value FROM session_state WHERE state_key = ?').get(scopedKey) as any;
        return row?.state_value;
    }

    // --- Context Snapshot & Contract ---
    createSnapshot(snapshot: ContextSnapshot, contractHash: string) {
        this.db.prepare(`
            INSERT OR REPLACE INTO context_snapshots
            (id, session_id, created_at, repo_id, git_head, db_sig_json, bootpack_hash, deltapack_hash, taskpack_hash, objective, budgets_json, proof_mode, min_db_coverage, contract_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            snapshot.id,
            snapshot.sessionId || null,
            snapshot.createdAt,
            snapshot.repoId,
            snapshot.gitHead || null,
            JSON.stringify(snapshot.dbSig || {}),
            snapshot.bootpackHash || null,
            snapshot.deltapackHash || null,
            snapshot.taskpackHash || null,
            snapshot.objective || null,
            snapshot.budgets ? JSON.stringify(snapshot.budgets) : null,
            snapshot.proofMode || null,
            snapshot.minDbCoverage ?? null,
            contractHash
        );
    }

    getLatestSnapshot(sessionId?: string): ContextSnapshot | undefined {
        const row = sessionId
            ? this.db.prepare('SELECT * FROM context_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as any
            : this.db.prepare('SELECT * FROM context_snapshots ORDER BY created_at DESC LIMIT 1').get() as any;

        if (!row) return undefined;
        return {
            id: row.id,
            sessionId: row.session_id || undefined,
            createdAt: row.created_at,
            repoId: row.repo_id,
            gitHead: row.git_head || undefined,
            dbSig: safeJsonParse(row.db_sig_json, {}),
            bootpackHash: row.bootpack_hash || undefined,
            deltapackHash: row.deltapack_hash || undefined,
            taskpackHash: row.taskpack_hash || undefined,
            objective: row.objective || undefined,
            budgets: row.budgets_json ? safeJsonParse(row.budgets_json) : undefined,
            proofMode: row.proof_mode || undefined,
            minDbCoverage: row.min_db_coverage ?? undefined,
            contractHash: row.contract_hash
        };
    }

    getSnapshotByContractHash(contractHash: string): ContextSnapshot | undefined {
        const row = this.db.prepare('SELECT * FROM context_snapshots WHERE contract_hash = ? ORDER BY created_at DESC LIMIT 1').get(contractHash) as any;
        if (!row) return undefined;
        return {
            id: row.id,
            sessionId: row.session_id || undefined,
            createdAt: row.created_at,
            repoId: row.repo_id,
            gitHead: row.git_head || undefined,
            dbSig: safeJsonParse(row.db_sig_json, {}),
            bootpackHash: row.bootpack_hash || undefined,
            deltapackHash: row.deltapack_hash || undefined,
            taskpackHash: row.taskpack_hash || undefined,
            objective: row.objective || undefined,
            budgets: row.budgets_json ? safeJsonParse(row.budgets_json) : undefined,
            proofMode: row.proof_mode || undefined,
            minDbCoverage: row.min_db_coverage ?? undefined,
            contractHash: row.contract_hash
        };
    }

    getDbSignature(_repoRoot?: string): DbSignature {
        const getCount = (tableName: string) => {
            const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get() as any;
            return Number(row?.c || 0);
        };

        const filesCount = getCount('files');
        const symbolsCount = getCount('symbols');
        const anchorsCount = getCount('anchors');
        const refsCount = getCount('refs');
        const fileCardsCount = getCount('file_cards');
        const flowCardsCount = getCount('flow_cards');

        const maxFilesUpdatedAt = (this.db.prepare('SELECT MAX(updated_at) as v FROM files').get() as any)?.v || undefined;
        const maxCardsUpdatedAt = (this.db.prepare(`
            SELECT MAX(ts) as v FROM (
                SELECT updated_at as ts FROM file_cards
                UNION ALL
                SELECT updated_at as ts FROM flow_cards
            )
        `).get() as any)?.v || undefined;

        const rollingSource = [
            filesCount,
            maxFilesUpdatedAt || '',
            symbolsCount,
            anchorsCount,
            refsCount,
            fileCardsCount,
            flowCardsCount,
            maxCardsUpdatedAt || ''
        ].join('|');

        return {
            filesCount,
            symbolsCount,
            anchorsCount,
            refsCount,
            fileCardsCount,
            flowCardsCount,
            maxFilesUpdatedAt,
            maxCardsUpdatedAt,
            rollingHash: crypto.createHash('sha256').update(rollingSource).digest('hex')
        };
    }

    // --- Files Helper ---
    getFileById(fileId: string): { id: string, path: string, contentHash: string } | undefined {
        const row = this.db.prepare('SELECT id, path, content_hash as contentHash FROM files WHERE id = ?').get(fileId) as any;
        return row || undefined;
    }

    // --- Anchors ---
    upsertAnchor(anchor: Anchor) {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO anchors (id, file_id, start_line, end_line, snippet_hash, created_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
        `);
        stmt.run(anchor.id, anchor.fileId, anchor.startLine, anchor.endLine, anchor.snippetHash);
    }

    getAnchor(id: string): Anchor | undefined {
        const row = this.db.prepare('SELECT * FROM anchors WHERE id = ?').get(id) as any;
        if (!row) return undefined;
        return {
            id: row.id,
            fileId: row.file_id,
            startLine: row.start_line,
            endLine: row.end_line,
            snippetHash: row.snippet_hash
        };
    }

    getAnchorsForFile(fileId: string): Anchor[] {
        return this.db.prepare('SELECT * FROM anchors WHERE file_id = ? ORDER BY start_line').all(fileId).map((row: any) => ({
            id: row.id,
            fileId: row.file_id,
            startLine: row.start_line,
            endLine: row.end_line,
            snippetHash: row.snippet_hash
        }));
    }

    deleteAnchorsForFile(fileId: string) {
        this.db.prepare('DELETE FROM anchors WHERE file_id = ?').run(fileId);
    }

    // ============================================================
    // Phase 19: Intelligence Layer Store Methods
    // ============================================================

    // --- Reverse Refs ---
    buildReverseRefs(): void {
        this.db.exec('DELETE FROM reverse_refs');
        this.db.exec(`
            INSERT INTO reverse_refs (id, to_symbol_id, from_symbol_id, from_file_id, ref_kind, anchor_id)
            SELECT r.id, r.to_symbol_id, r.from_symbol_id, s.file_id, r.ref_kind, r.anchor_id
            FROM refs r
            JOIN symbols s ON s.id = r.from_symbol_id
            WHERE r.to_symbol_id IS NOT NULL
        `);
    }

    getRefsTo(symbolId: string): import('@atlasmemory/core').ReverseRef[] {
        return this.db.prepare(`
            SELECT id, to_symbol_id, from_symbol_id, from_file_id, ref_kind, anchor_id
            FROM reverse_refs WHERE to_symbol_id = ?
        `).all(symbolId).map((row: any) => ({
            id: row.id,
            toSymbolId: row.to_symbol_id,
            fromSymbolId: row.from_symbol_id,
            fromFileId: row.from_file_id,
            refKind: row.ref_kind,
            anchorId: row.anchor_id || undefined,
        }));
    }

    getRefsByName(symbolName: string): import('@atlasmemory/core').ReverseRef[] {
        return this.db.prepare(`
            SELECT r.id, s2.id as to_symbol_id, r.from_symbol_id, s1.file_id as from_file_id, r.ref_kind, r.anchor_id
            FROM refs r
            JOIN symbols s1 ON s1.id = r.from_symbol_id
            JOIN symbols s2 ON s2.name = r.to_name
            WHERE r.to_symbol_id IS NULL AND r.to_name = ?
        `).all(symbolName).map((row: any) => ({
            id: row.id,
            toSymbolId: row.to_symbol_id,
            fromSymbolId: row.from_symbol_id,
            fromFileId: row.from_file_id,
            refKind: row.ref_kind,
            anchorId: row.anchor_id || undefined,
        }));
    }

    getDependentFiles(fileId: string): import('@atlasmemory/core').DependentFile[] {
        const rows = this.db.prepare(`
            SELECT rr.from_file_id, f.path, COUNT(DISTINCT rr.from_symbol_id) as symbol_count, COUNT(*) as ref_count
            FROM reverse_refs rr
            JOIN symbols s ON s.id = rr.to_symbol_id AND s.file_id = ?
            JOIN files f ON f.id = rr.from_file_id
            WHERE rr.from_file_id != ?
            GROUP BY rr.from_file_id
            ORDER BY ref_count DESC
        `).all(fileId, fileId) as any[];

        return rows.map((row: any) => ({
            fileId: row.from_file_id,
            filePath: row.path,
            symbolCount: row.symbol_count,
            refCount: row.ref_count,
            riskLevel: row.ref_count > 5 ? 'high' as const : row.ref_count > 2 ? 'medium' as const : 'low' as const,
        }));
    }

    // --- Conversation Events ---
    logEvent(sessionId: string, type: string, data: object): void {
        const id = crypto.randomUUID();
        this.db.prepare(`
            INSERT INTO conversation_events (id, session_id, event_type, event_data)
            VALUES (?, ?, ?, ?)
        `).run(id, sessionId, type, JSON.stringify(data));
    }

    getSessionEvents(sessionId: string, opts?: { type?: string; limit?: number }): import('@atlasmemory/core').ConversationEvent[] {
        const limit = opts?.limit || 100;
        const rows = opts?.type
            ? this.db.prepare('SELECT * FROM conversation_events WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, opts.type, limit)
            : this.db.prepare('SELECT * FROM conversation_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit);

        return (rows as any[]).map((row: any) => ({
            id: row.id,
            sessionId: row.session_id,
            eventType: row.event_type,
            eventData: safeJsonParse(row.event_data, {}),
            createdAt: row.created_at,
        }));
    }

    getRecentEvents(limit: number = 50): import('@atlasmemory/core').ConversationEvent[] {
        return this.db.prepare('SELECT * FROM conversation_events ORDER BY created_at DESC LIMIT ?').all(limit).map((row: any) => ({
            id: row.id,
            sessionId: row.session_id,
            eventType: row.event_type,
            eventData: safeJsonParse(row.event_data, {}),
            createdAt: row.created_at,
        }));
    }

    pruneOldEvents(daysOld: number = 30): number {
        const result = this.db.prepare(`DELETE FROM conversation_events WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysOld);
        return result.changes;
    }

    // --- Session Patterns ---
    upsertPattern(type: string, key: string, data: object): void {
        this.db.prepare(`
            INSERT INTO session_patterns (id, pattern_type, pattern_key, pattern_data, frequency, confidence, last_seen)
            VALUES (?, ?, ?, ?, 1, 0.5, datetime('now'))
            ON CONFLICT(pattern_type, pattern_key) DO UPDATE SET
                pattern_data = excluded.pattern_data,
                frequency = frequency + 1,
                confidence = MIN(1.0, (frequency + 1) * 0.1),
                last_seen = datetime('now')
        `).run(crypto.randomUUID(), type, key, JSON.stringify(data));
    }

    bumpPattern(type: string, key: string): void {
        this.db.prepare(`
            UPDATE session_patterns SET
                frequency = frequency + 1,
                confidence = MIN(1.0, (frequency + 1) * 0.1),
                last_seen = datetime('now')
            WHERE pattern_type = ? AND pattern_key = ?
        `).run(type, key);
    }

    getPatterns(type: string, opts?: { minFreq?: number; minConfidence?: number }): import('@atlasmemory/core').SessionPattern[] {
        const minFreq = opts?.minFreq || 1;
        const minConf = opts?.minConfidence || 0;
        return this.db.prepare(`
            SELECT * FROM session_patterns
            WHERE pattern_type = ? AND frequency >= ? AND confidence >= ?
            ORDER BY frequency DESC
        `).all(type, minFreq, minConf).map((row: any) => ({
            id: row.id,
            patternType: row.pattern_type,
            patternKey: row.pattern_key,
            patternData: safeJsonParse(row.pattern_data, {}),
            frequency: row.frequency,
            confidence: row.confidence,
            lastSeen: row.last_seen,
        }));
    }

    getTopPatterns(limit: number = 20): import('@atlasmemory/core').SessionPattern[] {
        return this.db.prepare('SELECT * FROM session_patterns ORDER BY frequency DESC LIMIT ?').all(limit).map((row: any) => ({
            id: row.id,
            patternType: row.pattern_type,
            patternKey: row.pattern_key,
            patternData: safeJsonParse(row.pattern_data, {}),
            frequency: row.frequency,
            confidence: row.confidence,
            lastSeen: row.last_seen,
        }));
    }

    decayPatterns(decayFactor: number = 0.8): void {
        this.db.prepare(`
            UPDATE session_patterns SET confidence = confidence * ?
            WHERE last_seen < datetime('now', '-14 days')
        `).run(decayFactor);
        this.db.prepare(`DELETE FROM session_patterns WHERE confidence < 0.1`).run();
    }

    // --- Token Usage ---
    logTokenUsage(sessionId: string, tool: string, tokens: number, budgetTotal?: number): void {
        const id = crypto.randomUUID();
        const remaining = budgetTotal ? budgetTotal - tokens : null;
        this.db.prepare(`
            INSERT INTO token_usage (id, session_id, tool_name, tokens_estimated, budget_total, budget_remaining)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, sessionId, tool, tokens, budgetTotal || null, remaining);
    }

    getSessionTokens(sessionId: string): import('@atlasmemory/core').TokenUsageSummary {
        const rows = this.db.prepare(
            'SELECT tool_name, tokens_estimated, created_at FROM token_usage WHERE session_id = ? ORDER BY created_at'
        ).all(sessionId) as any[];

        const byTool: Record<string, number> = {};
        let total = 0;
        for (const row of rows) {
            byTool[row.tool_name] = (byTool[row.tool_name] || 0) + row.tokens_estimated;
            total += row.tokens_estimated;
        }

        return {
            sessionId,
            totalTokens: total,
            byTool,
            entries: rows.map((r: any) => ({ tool: r.tool_name, tokens: r.tokens_estimated, timestamp: r.created_at })),
        };
    }

    // --- Search ---
    searchFiles(query: string) {
        return this.db.prepare('SELECT * FROM files WHERE path LIKE ?').all(`%${query}%`);
    }

    scoredSearch(query: string, limit: number = 10): { file: any, score: number }[] {
        const scores = new Map<string, number>();

        // Extract individual terms for multi-word queries
        const terms = query
            .toLowerCase()
            .replace(/[^a-z0-9\s_]/g, '')
            .split(/\s+/)
            .filter(t => t.length >= 2);

        const ALLOWED_FTS_TABLES = new Set(['fts_files', 'fts_symbols', 'fts_semantic_tags']);
        const ftsSearch = (table: string, safeQuery: string, scoreMultiplier: number) => {
            if (!ALLOWED_FTS_TABLES.has(table)) return; // Guard against injection
            try {
                const matches = this.db.prepare(`
                    SELECT file_id, rank
                    FROM ${table}
                    WHERE ${table} MATCH ?
                    ORDER BY rank
                    LIMIT ?
                `).all(safeQuery, limit * 2) as { file_id: string, rank: number }[];

                for (const match of matches) {
                    const score = -1 * match.rank * scoreMultiplier;
                    scores.set(match.file_id, (scores.get(match.file_id) || 0) + score);
                }
            } catch (e) { /* ignore FTS syntax errors */ }
        };

        // 1. FTS Search - try exact phrase first
        const phraseQuery = `"${query.replace(/"/g, '""')}"`;
        ftsSearch('fts_files', phraseQuery, 10);
        ftsSearch('fts_symbols', phraseQuery, 20);

        // 2. FTS Search - individual terms with OR (catches multi-word queries)
        if (terms.length > 1) {
            const orQuery = terms
                .filter(t => t.length >= 3)
                .map(t => `"${t.replace(/"/g, '')}"`)
                .join(' OR ');
            if (orQuery) {
                ftsSearch('fts_files', orQuery, 6);
                ftsSearch('fts_symbols', orQuery, 12);
            }
        }

        // 3. FTS Semantic Tags (concept-level search, ×8 multiplier)
        ftsSearch('fts_semantic_tags', phraseQuery, 8);
        if (terms.length > 1) {
            const semanticOrQuery = terms
                .filter(t => t.length >= 3)
                .map(t => `"${t.replace(/"/g, '')}"`)
                .join(' OR ');
            if (semanticOrQuery) {
                ftsSearch('fts_semantic_tags', semanticOrQuery, 8);
            }
        }

        // 4. Fallback: Path LIKE for each term
        const queryLower = query.toLowerCase();
        const pathMatches = this.db.prepare('SELECT id, path FROM files WHERE path LIKE ? LIMIT ?').all(`%${query}%`, limit) as { id: string, path: string }[];
        for (const file of pathMatches) {
            scores.set(file.id, (scores.get(file.id) || 0) + 10);
        }

        // Also try each term individually against paths and symbol names
        for (const term of terms) {
            if (term.length < 3) continue;
            const termPathMatches = this.db.prepare('SELECT id, path FROM files WHERE LOWER(path) LIKE ? LIMIT ?').all(`%${term}%`, limit) as { id: string, path: string }[];
            for (const file of termPathMatches) {
                scores.set(file.id, (scores.get(file.id) || 0) + 5);
            }
            // Symbol name LIKE — catches partial matches like "login" in "handleLogin"
            const symbolMatches = this.db.prepare('SELECT DISTINCT file_id FROM symbols WHERE LOWER(name) LIKE ? OR LOWER(qualified_name) LIKE ? LIMIT ?').all(`%${term}%`, `%${term}%`, limit) as { file_id: string }[];
            for (const match of symbolMatches) {
                scores.set(match.file_id, (scores.get(match.file_id) || 0) + 15);
            }
        }

        const allIds = Array.from(scores.keys());
        if (allIds.length === 0) return [];

        const placeholders = allIds.map(() => '?').join(',');
        const files = this.db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...allIds) as any[];

        // Deduplicate files with same path (different casing on Windows)
        const seenPaths = new Map<string, any>();
        const dedupedFiles: any[] = [];
        for (const file of files) {
            const key = file.path.toLowerCase();
            if (seenPaths.has(key)) {
                // Merge scores into existing entry
                const existing = seenPaths.get(key)!;
                scores.set(existing.id, (scores.get(existing.id) || 0) + (scores.get(file.id) || 0));
            } else {
                seenPaths.set(key, file);
                dedupedFiles.push(file);
            }
        }

        return dedupedFiles.map(file => {
            let score = scores.get(file.id) || 0;
            const pathLower = file.path.toLowerCase();
            const fileName = pathLower.split(/[/\\]/).pop() || '';

            // Exact filename match (Huge boost)
            if (fileName === queryLower || fileName === queryLower + '.ts') score += 100;
            if (fileName.includes(queryLower)) score += 20;

            // Per-term filename boost
            let fileNameTermHits = 0;
            for (const term of terms) {
                if (fileName.includes(term)) { score += 8; fileNameTermHits++; }
            }
            // Multi-term bonus: reward files matching ALL query terms
            if (terms.length > 1 && fileNameTermHits === terms.length) score += 30;

            // Path segment match (e.g., "schema" in path "store/src/schema.ts")
            const pathSegments = pathLower.split(/[/\\]/);
            for (const term of terms) {
                if (pathSegments.some(seg => seg.startsWith(term) || seg.includes(term))) score += 6;
            }

            // Recency boost (simple decay)
            const updated = new Date(file.updated_at).getTime();
            const now = Date.now();
            const daysDiff = (now - updated) / (1000 * 60 * 60 * 24);
            score += Math.max(0, 5 - daysDiff);

            return { file, score };
        })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    // ============================================================
    // Phase 20: Semantic Tags + Code Health + Level3
    // ============================================================

    // --- Semantic Tags ---
    upsertSemanticTags(fileId: string, tags: string[], intent: string): void {
        this.db.prepare('DELETE FROM fts_semantic_tags WHERE file_id = ?').run(fileId);
        this.db.prepare(
            'INSERT INTO fts_semantic_tags (tags, intent, file_id) VALUES (?, ?, ?)'
        ).run(tags.join(' '), intent, fileId);
    }

    searchSemanticTags(query: string): { fileId: string; rank: number }[] {
        try {
            const safeQuery = `"${query.replace(/"/g, '""')}"`;
            return this.db.prepare(`
                SELECT file_id, rank
                FROM fts_semantic_tags
                WHERE fts_semantic_tags MATCH ?
                ORDER BY rank
                LIMIT 50
            `).all(safeQuery).map((row: any) => ({
                fileId: row.file_id,
                rank: row.rank,
            }));
        } catch (e) {
            return [];
        }
    }

    getSemanticTags(fileId: string): { tags: string; intent: string } | null {
        const row = this.db.prepare(
            'SELECT tags, intent FROM fts_semantic_tags WHERE file_id = ?'
        ).get(fileId) as any;
        return row ? { tags: row.tags, intent: row.intent } : null;
    }

    deleteSemanticTags(fileId: string): void {
        this.db.prepare('DELETE FROM fts_semantic_tags WHERE file_id = ?').run(fileId);
    }

    // --- Code Health ---
    upsertCodeHealth(health: { fileId: string; churnScore: number; breakFrequency: number; lastModified: string; contributorCount: number; coupledFiles: string[]; riskLevel: string }): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO code_health
            (file_id, churn_score, break_frequency, last_modified, contributor_count, coupled_files_json, risk_level, analyzed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
            health.fileId, health.churnScore, health.breakFrequency,
            health.lastModified, health.contributorCount,
            JSON.stringify(health.coupledFiles), health.riskLevel
        );
    }

    getCodeHealth(fileId: string): import('@atlasmemory/core').CodeDNA | null {
        const row = this.db.prepare('SELECT * FROM code_health WHERE file_id = ?').get(fileId) as any;
        if (!row) return null;
        return {
            fileId: row.file_id,
            churnScore: row.churn_score,
            breakFrequency: row.break_frequency,
            lastModified: row.last_modified,
            contributorCount: row.contributor_count,
            coupledFiles: safeJsonParse(row.coupled_files_json, []),
            riskLevel: row.risk_level as any,
        };
    }

    getAllCodeHealth(): import('@atlasmemory/core').CodeDNA[] {
        return this.db.prepare('SELECT * FROM code_health ORDER BY churn_score DESC').all().map((row: any) => ({
            fileId: row.file_id,
            churnScore: row.churn_score,
            breakFrequency: row.break_frequency,
            lastModified: row.last_modified,
            contributorCount: row.contributor_count,
            coupledFiles: safeJsonParse(row.coupled_files_json, []),
            riskLevel: row.risk_level as any,
        }));
    }

    clearCodeHealth(): void {
        this.db.prepare('DELETE FROM code_health').run();
    }

    close() {
        this.db.close();
    }
}
